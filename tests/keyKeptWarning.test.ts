import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'

// ── 0.6.24 R3-c: 記録の鍵を無効にしなかった回（兄弟が同じ鍵の ID を持つ・確かめられない。R2-i）を、結果に出す ────────────────────────────
// R2-i は、同じ鍵の ID を記録に持つ兄弟がいる（または確かめられない）回に、記録の鍵を無効にしない。だが結果のどこにも出ず、元の現役の鍵を守ったことも、
// 鍵が残っていることも、利用者に見えなかった。3か所（teardownStorageForProject・共用型の保存場所0件の段・公開の apply の保存場所の削除）とも、警告を1行足す。
//   持つ回      「保存場所のアクセスキーは、ほかのフォルダの記録も同じものを使っているため、無効にしていません。」
//   確かめられない回 「保存場所のアクセスキーは、ほかのフォルダの記録を確かめられないため、無効にしていません。」
// 行の出し方は keyWarningLines（⚠️ を付ける）。**案内（keyRevokeGuide。パーミッションを削除してください）は足さない**: ほかのフォルダが使っている現役の鍵を削除させてしまう。
// 本物の main（cloud:teardown・apprunDedicated:teardown・teardownStorageForProject・applyPlan）に偽の保存場所・偽の兄弟フォルダを流し、その場の結果と「呼ばれた要求の一覧」で固定する（掟10）。
// 文は書き下す（関数を通すと同語反復になる）。
// 変異: 3か所それぞれの警告を外す／持つ・確かめられないの文を入れ替える／keyWarningLines が無効にしていない警告にも案内を足す／recordedKeyRisk の 'held' と 'unknown' を入れ替える／apply で同じ行を重ねる。
import { A, B, APP, OK_AUTH, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, stateMeta } from './sharedTeardownHarness'
import { shownTeardown, shownFromEnv } from './shownFromEnv'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

// 専有型の破棄の本体は実物を動かす。偽サーバへ向けるため baseUrl だけを足し、待たない sleep を入れる。
const d = vi.hoisted(() => ({ baseUrl: '' }))
vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => {
  const real = await orig<any>()
  return { ...real, teardownFlow: (auth: any, dir: string, opts: any) => real.teardownFlow(auth, dir, { ...opts, sleep: async () => {} }, d.baseUrl) }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { writeApprunDedicatedRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { recordedKeyRisk, recordedKeyAtRisk, keyWarningLines, keyKeptWarning, KEY_REVOKE_FAILED_WARNING, KEY_KEPT_HELD_WARNING, KEY_KEPT_UNKNOWN_WARNING } from '../src/main/cloud/storageTeardown'
import { teardownStorageForProject } from '../src/main/cloud/storageForTarget'
import { applyPlan, type StorageClientLike, type CloudClientLike } from '../src/main/cloud/apply'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { emptyState } from '../src/main/cloud/state'
import type { Plan } from '../src/main/cloud/planner'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const dedicatedTeardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!)
const EVENT = { sender: { send: () => {} } }
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const REC = 'perm-rec'
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0

// 文（作者の決めたとおり。書き下す）
const HELD = '保存場所のアクセスキーは、ほかのフォルダの記録も同じものを使っているため、無効にしていません。'
const UNKNOWN = '保存場所のアクセスキーは、ほかのフォルダの記録を確かめられないため、無効にしていません。'
const SHARED_GUIDE = 'さくらのクラウドのコントロールパネルで、オブジェクトストレージのパーミッション「koto-myapp」を削除してください（アクセスキーも一緒に無効になります）。'

let dir = ''
let server: Server | null = null
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  d.baseUrl = ''
  dir = newProjectDir()
})
afterEach(() => {
  if (server) { server.close(); server = null }
  try { fs.chmodSync(workspaceOf(dir), 0o755) } catch { /* 無い */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

const sib = (name: string): string => { const p = path.join(workspaceOf(dir), name); fs.mkdirSync(p, { recursive: true }); return p }
const put = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)) }
/** 共用型の記録（state.meta.storagePermissionId）だけを持つ兄弟。 */
const holderShared = (name: string, id: string = REC) => put(path.join(sib(name), '.sakura-cloud', 'state.json'), { name: 'x', backend: 'apprun', resources: [], meta: { storagePermissionId: id } })
/** 専有型の記録（publish.apprunDedicated.storagePermissionId）だけを持つ兄弟。 */
const holderDedicated = (name: string, id: string = REC) => put(path.join(sib(name), '.sakuraide.json'), { publish: { apprunDedicated: { storagePermissionId: id } } })
/** 確かめられない兄弟（壊れた記録）。 */
const brokenSibling = (name = 'broken') => put(path.join(sib(name), '.sakuraide.json'), '{ 壊れた')
const deletedPermissions = () => h.calls.filter(c => c.startsWith('deletePermission '))
/** 「鍵を無効にしていません」の行（⚠️ 付き）だけを取り出す。 */
const keptLines = (lines: readonly string[]) => lines.filter(l => l.includes('無効にしていません'))

// ── 純関数 ─────────────────────────────────────────────────────────────────────────
describe('★★★ 文・keyWarningLines・recordedKeyRisk（純関数）', () => {
  it('★★★ 文は作者の決めたとおり（持つ回・確かめられない回）。keyKeptWarning が理由で振り分ける', () => {
    expect(KEY_KEPT_HELD_WARNING).toBe(HELD)
    expect(KEY_KEPT_UNKNOWN_WARNING).toBe(UNKNOWN)
    expect(keyKeptWarning('held')).toBe(HELD)
    expect(keyKeptWarning('unknown')).toBe(UNKNOWN)
  })

  it('★★★ keyWarningLines: 無効にしていない警告には案内を足さない。無効にできなかった警告の最後の1行にだけ足す', () => {
    const G = 'ガイド。'
    expect(keyWarningLines([HELD], G)).toEqual([`⚠️ ${HELD}`])
    expect(keyWarningLines([UNKNOWN], G)).toEqual([`⚠️ ${UNKNOWN}`])
    expect(keyWarningLines([KEY_REVOKE_FAILED_WARNING], G)).toEqual([`⚠️ ${KEY_REVOKE_FAILED_WARNING}。ガイド。`])
    // 並びによらず、案内は無効にできなかった警告の最後の1行に付く（無効にしていない警告の後ろでも前でも）
    expect(keyWarningLines([HELD, KEY_REVOKE_FAILED_WARNING], G)).toEqual([`⚠️ ${HELD}`, `⚠️ ${KEY_REVOKE_FAILED_WARNING}。ガイド。`])
    expect(keyWarningLines([KEY_REVOKE_FAILED_WARNING, HELD], G)).toEqual([`⚠️ ${KEY_REVOKE_FAILED_WARNING}。ガイド。`, `⚠️ ${HELD}`])
    expect(keyWarningLines(['a', 'b'], G)).toEqual(['⚠️ a', '⚠️ b。ガイド。'])
    expect(keyWarningLines([], G)).toEqual([])
  })

  it('★★★ recordedKeyRisk: 鍵が無い・持つ兄弟がいない → null。持つ兄弟 → held。確かめられない兄弟 → unknown。recordedKeyAtRisk はその !== null', () => {
    expect(recordedKeyRisk(dir, null)).toBeNull()
    expect(recordedKeyRisk(dir, undefined)).toBeNull()
    expect(recordedKeyRisk(dir, '')).toBeNull()
    expect(recordedKeyRisk(dir, REC)).toBeNull()
    expect(recordedKeyAtRisk(dir, REC)).toBe(false)
    brokenSibling()
    expect(recordedKeyRisk(dir, REC)).toBe('unknown')
    expect(recordedKeyAtRisk(dir, REC)).toBe(true)
    holderShared('holder')
    expect(recordedKeyRisk(dir, REC)).toBe('held') // 持つ兄弟が見つかれば、読めない兄弟がいても held（見つかった事実は動かない）
    expect(recordedKeyRisk(dir, 'perm-mine')).toBe('unknown') // 壊れた兄弟がいるので、持たないとは言えない
  })

  it.skipIf(rootIsMe)('★★ 親フォルダの一覧を読めない（0o311）→ unknown', () => {
    fs.chmodSync(workspaceOf(dir), 0o311)
    expect(recordedKeyRisk(dir, REC)).toBe('unknown')
  })
})

// ── 場所1: 破棄（teardownStorageForProject）──────────────────────────────────────────────
describe('★★★ 場所1: 共用型 cloud:teardown（保存場所あり）— 無効にしなかった回は、結果の executed に警告が1行出る。案内は付かない', () => {
  const OWN = () => setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { storagePermissionId: REC } })

  it('★★★ 持つ兄弟（共用型の記録）→ 「ほかのフォルダの記録も同じものを使っている」の行が1回。deletePermission 0件。案内なし', async () => {
    OWN(); holderShared('holder')
    h.permissions = [{ id: REC, displayName: 'koto-myapp-apprun' }]
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(deletedPermissions()).toEqual([])
    expect(keptLines(reply.executed)).toEqual([`⚠️ ${HELD}`])
    expect(reply.executed.join('\n'), '現役の鍵を削除させる案内').not.toContain(SHARED_GUIDE)
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })

  it('★★★ 持つ兄弟（専有型の記録）→ 同じ行', async () => {
    OWN(); holderDedicated('holder')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(keptLines(reply.executed)).toEqual([`⚠️ ${HELD}`])
  })

  it('★★★ 確かめられない兄弟（壊れた記録）→ 「確かめられない」の行が1回。deletePermission 0件。案内なし', async () => {
    OWN(); brokenSibling()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(deletedPermissions()).toEqual([])
    expect(keptLines(reply.executed)).toEqual([`⚠️ ${UNKNOWN}`])
    expect(reply.executed.join('\n')).not.toContain(SHARED_GUIDE)
  })

  it('★★★ 対照: 兄弟が持たなければ、行は出ない。鍵を無効にし、記録の ID を外す', async () => {
    OWN(); holderShared('other', 'perm-other'); holderDedicated('other-d', 'perm-other-d')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(keptLines(reply.executed)).toEqual([])
    expect(deletedPermissions()).toEqual([`deletePermission ${REC}`])
    expect(stateMeta(dir)?.storagePermissionId).toBeUndefined()
  })

  it('★★★ teardownStorageForProject を直に（HANAMII・専有型もここを通る）: 持つ兄弟 → warnings に持つ文だけ。確かめられない → 確かめられない文だけ。対照: 持たなければ空', async () => {
    OWN()
    const args = { creds: { token: 't', secret: 's' } as any, projectDir: dir, permissionId: REC, sweepKeysFor: null, shown: shownFromEnv(dir) }
    holderDedicated('holder')
    const held = await teardownStorageForProject(args)
    expect(held.ok && held.reason === 'done' && held.warnings).toEqual([HELD])
    expect(deletedPermissions()).toEqual([])

    fs.rmSync(path.join(workspaceOf(dir), 'holder'), { recursive: true })
    brokenSibling()
    const unknown = await teardownStorageForProject(args)
    expect(unknown.ok && unknown.reason === 'done' && unknown.warnings).toEqual([UNKNOWN])
    expect(deletedPermissions()).toEqual([])

    fs.rmSync(path.join(workspaceOf(dir), 'broken'), { recursive: true })
    const free = await teardownStorageForProject(args)
    expect(free.ok && free.reason === 'done' && free.warnings).toEqual([])
    expect(deletedPermissions()).toEqual([`deletePermission ${REC}`])
  })

  it('★★ 鍵（permissionId）が渡されない回（HANAMII・古い記録）は、持つ兄弟がいても行は出ない（無効にするものが無い）', async () => {
    OWN(); holderShared('holder')
    const r = await teardownStorageForProject({ creds: { token: 't', secret: 's' } as any, projectDir: dir, permissionId: null, sweepKeysFor: null, shown: shownFromEnv(dir) })
    expect(r.ok && r.reason === 'done' && r.warnings).toEqual([])
  })
})

describe('★★★ 場所1: 専有型 apprunDedicated:teardown — 無効にしなかった回は、結果の executed に警告が出る', () => {
  function listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => {
          const key = `${req.method} ${req.url}`
          if (key === 'DELETE /clusters/c1') { res.writeHead(204); res.end(); return }
          res.writeHead(key === 'GET /clusters?maxItems=20' ? 200 : 404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(key === 'GET /clusters?maxItems=20' ? { clusters: [] } : { error: `test router: 未定義のルート ${key}` }))
        })
      })
      server.listen(0, () => {
        const addr = server?.address()
        if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}/`)
        else reject(new Error('サーバのポートを取得できませんでした'))
      })
    })
  }
  const run = async () => {
    setup(dir, { env: [A], resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', storagePermissionId: REC })
    d.baseUrl = await listen()
    return dedicatedTeardown(EVENT, dir, { token: 'tok', secret: 'sec' }, { confirmed: true })
  }

  it('★★★ 持つ兄弟 → 持つ文の行が1回。deletePermission 0件。専有型の記録の ID は残る。案内なし', async () => {
    holderDedicated('holder')
    const result = await run()
    expect(result.ok).toBe(true)
    expect(deletedPermissions()).toEqual([])
    expect(keptLines(result.executed)).toEqual([`⚠️ ${HELD}`])
    expect(result.executed.join('\n')).not.toContain('を削除してください（アクセスキーも一緒に無効になります）')
    expect(readApprunDedicatedFs(dir).storagePermissionId).toBe(REC)
  })

  it('★★★ 確かめられない兄弟 → 確かめられない文の行', async () => {
    brokenSibling()
    const result = await run()
    expect(deletedPermissions()).toEqual([])
    expect(keptLines(result.executed)).toEqual([`⚠️ ${UNKNOWN}`])
  })

  it('★★★ 対照: 兄弟が持たなければ行は出ない。鍵を無効にして ID を外す', async () => {
    holderDedicated('other', 'perm-other')
    const result = await run()
    expect(keptLines(result.executed)).toEqual([])
    expect(deletedPermissions()).toEqual([`deletePermission ${REC}`])
    expect(readApprunDedicatedFs(dir).storagePermissionId ?? null).toBeNull()
  })
})

// ── 場所2: 共用型の保存場所0件（revokeRecordedKey の段）──────────────────────────────────────
describe('★★★ 場所2: 共用型の保存場所0件の鍵の無効化 — 無効にしなかった回は、結果の executed に警告が1行出る', () => {
  const OWN = () => setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: REC } })

  it('★★★ 持つ兄弟 → 持つ文の行が1回。deletePermission 0件・保存場所へ接続もしない。記録の ID は残る。案内なし', async () => {
    OWN(); holderShared('holder')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(deletedPermissions()).toEqual([])
    expect(h.calls).not.toContain('connect')
    expect(keptLines(reply.executed)).toEqual([`⚠️ ${HELD}`])
    expect(reply.executed.join('\n')).not.toContain(SHARED_GUIDE)
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })

  it('★★★ 確かめられない兄弟 → 確かめられない文の行', async () => {
    OWN(); brokenSibling()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(deletedPermissions()).toEqual([])
    expect(keptLines(reply.executed)).toEqual([`⚠️ ${UNKNOWN}`])
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })

  it.skipIf(rootIsMe)('★★★ 親フォルダの一覧を読めない（0o311。アプリの記録が無いので骨は断らない）→ 確かめられない文の行', async () => {
    setup(dir, { env: [], resources: [], meta: { registryName: 'myreg', storagePermissionId: REC } })
    fs.chmodSync(workspaceOf(dir), 0o311)
    let reply: any
    try { reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO) } finally { fs.chmodSync(workspaceOf(dir), 0o755) }
    expect(deletedPermissions()).toEqual([])
    expect(keptLines(reply.executed ?? [])).toEqual([`⚠️ ${UNKNOWN}`])
  })

  it('★★★ 対照: 兄弟が持たなければ行は出ない。保存場所0件でも鍵を無効にし、記録の ID を外す', async () => {
    OWN(); holderShared('other', 'perm-other')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(keptLines(reply.executed)).toEqual([])
    expect(deletedPermissions()).toEqual([`deletePermission ${REC}`])
    expect(stateMeta(dir)?.storagePermissionId).toBeUndefined()
  })
})

// ── 場所3: 公開の apply の保存場所の削除 ──────────────────────────────────────────────────
describe('★★★ 場所3: 公開の apply の保存場所の削除 — 無効にしなかった回は、skipped に警告が1行出る（保存場所が2件でも1回）', () => {
  const PREFIX = 'projects/myapp/'
  function fakeStorage(calls: string[]): StorageClientLike {
    return {
      async isSiteReady() { return true },
      async ensureBucket() {},
      async listAllKeys() { return [`${PREFIX}data.json`] },
      async putMarker() {},
      async deleteKeys(_b, ks) { calls.push(`deleteKeys:${ks.join(',')}`) },
      async deleteBucket(b) { calls.push(`deleteBucket:${b}`) },
      async issueKey() { return { accessKey: 'AKIA', secretKey: 'S', permissionId: 'perm-new' } },
      async deletePermission(id) { calls.push(`deletePermission:${id}`) },
      async listPermissions() { return [] },
      siteInfo() { return { s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' } },
    }
  }
  const noCloud: CloudClientLike = {
    dryRun: false,
    async ensureUser() { return { ok: true } },
    async listApps() { return { ok: true, data: [] } },
    async getApp() { return { ok: true, dryRun: false, data: { min_scale: 0 } } },
    async createApp() { return { ok: true } },
    async patchApp() { return { ok: true } },
    async deleteApp() { return { ok: true } },
  }
  const spec = (buckets: string[]): EnvSpec => {
    const s = defaultSpec({ name: 'myapp', hasDockerfile: false })
    s.persistence = { objectStorage: buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' })) }
    return s
  }
  const deletePlan = (buckets: string[]): Plan => ({
    actions: buckets.map(b => ({ type: 'delete', kind: 'bucket', name: b, stateful: true, destructive: true, description: `保存場所『${b}』を削除` } as any)),
    hasDestructive: true, hasStatefulDelete: true,
  }) as Plan
  const run = (calls: string[], buckets: string[] = [A]) => {
    const state = emptyState('myapp', 'sakura-apprun')
    state.meta = { storagePermissionId: REC }
    return applyPlan({ plan: deletePlan(buckets), spec: spec(buckets), state, client: noCloud, storage: fakeStorage(calls), confirmed: true, projectDir: dir })
  }

  it('★★★ 持つ兄弟 → skipped に持つ文の行が1回。deletePermission 0件。記録の ID は残る。案内なし', async () => {
    holderShared('holder')
    const calls: string[] = []
    const r = await run(calls)
    expect(r.ok).toBe(true)
    expect(calls.filter(c => c.startsWith('deletePermission:'))).toEqual([])
    expect(keptLines(r.skipped)).toEqual([`⚠️ ${HELD}`])
    expect(r.skipped.join('\n')).not.toContain('を削除してください（アクセスキーも一緒に無効になります）')
    expect(r.state.meta?.storagePermissionId).toBe(REC)
  })

  it('★★★ 確かめられない兄弟 → 確かめられない文の行', async () => {
    brokenSibling()
    const calls: string[] = []
    const r = await run(calls)
    expect(calls.filter(c => c.startsWith('deletePermission:'))).toEqual([])
    expect(keptLines(r.skipped)).toEqual([`⚠️ ${UNKNOWN}`])
  })

  it('★★★ 保存場所が2件（B も同じ prefix で削除）でも、同じ行は1回だけ', async () => {
    holderShared('holder')
    const calls: string[] = []
    const r = await run(calls, [A, B])
    expect(r.ok).toBe(true)
    expect(calls.filter(c => c.startsWith('deletePermission:'))).toEqual([])
    expect(keptLines(r.skipped)).toEqual([`⚠️ ${HELD}`])
  })

  it('★★★ 対照: 兄弟が持たなければ行は出ない。今までどおり鍵を無効にし、記録の ID を外す', async () => {
    holderShared('other', 'perm-other')
    const calls: string[] = []
    const r = await run(calls)
    expect(keptLines(r.skipped)).toEqual([])
    expect(calls.filter(c => c.startsWith('deletePermission:'))).toEqual([`deletePermission:${REC}`])
    expect(r.state.meta?.storagePermissionId).toBeUndefined()
  })
})
