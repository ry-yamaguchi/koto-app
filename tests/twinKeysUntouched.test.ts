import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'

// ── T-R1c: 複製（または複製かもしれない）回は、鍵に触らない（0.6.24 R1-c）────────────────────────────────────────────
// 状況（0.6.24 U1〜U5 の検分で実測）: 複製は元の env.json の名前と記録の鍵 ID（`storagePermissionId`）を写す。
// データを残した（keptData）回でも、記録の鍵の無効化と、名前での鍵の一括の無効化（sweep）が走ると、**元の現役の鍵が切れる**
// （共用型・HANAMII・専有型・apply の4つの道で実測）。決まり: **この破棄で消す保存場所のうち1件でも `twinRiskOf` が非 null なら、記録の鍵にも名前での一括にも触れない。**
// 複製（同じ prefix）も、複製かもしれない（読めない兄弟 = R1-b）も同じ。記録の鍵の ID は、実際に無効にできた（`permissionRevoked`）ときだけ記録から外す。
// 本物の main に偽の保存場所・偽の兄弟フォルダを流し、**出た要求の一覧**（deletePermission・listPermissions が0件）で固定する（掟10）。
// 判断は tests/twinRiskOf.test.ts、データを残すことは tests/samePrefixTeardown.test.ts・tests/unreadSiblingTeardown.test.ts。
import { A, B, APP, OK_AUTH, PREFIX, CONSENTED_AT, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, stateMeta } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'

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
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { readApprunDedicatedFs, writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { applyPlan, type StorageClientLike, type CloudClientLike } from '../src/main/cloud/apply'
import { teardownStorage, KEY_REVOKE_FAILED_WARNING, type StorageTeardownClientLike } from '../src/main/cloud/storageTeardown'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { emptyState } from '../src/main/cloud/state'
import type { Plan } from '../src/main/cloud/planner'
import { permissionNameFor } from '../src/shared/storageKeys'
import { deleteProjectReply } from './hanamiiTeardownFixtures'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const hanamiiTeardown = shownTeardown(h.handlers.get('hanamii:teardown')!)
const dedicatedTeardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!)

const EVENT = { sender: { send: () => {} } }
const REC = 'perm-rec'
const OLD = 'perm-old'
const NAME = 'myapp'

let dir = ''
let server: Server | null = null
const realFetch = globalThis.fetch
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  d.baseUrl = ''
  dir = newProjectDir()
})
afterEach(() => {
  if (server) { server.close(); server = null }
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 鍵（パーミッション）に触れた要求。記録の鍵（deletePermission）も、名前での一括（listPermissions → deletePermission）も、ここに出る。 */
const keyCalls = () => h.calls.filter(c => c.startsWith('deletePermission ') || c === 'listPermissions')

/** 隣に置く「複製かもしれない」2種。`buckets` は、複製が同じ prefix で持つバケット（複製の形でだけ使う）。 */
const RISKS: ReadonlyArray<{ label: string; make: (ws: string, buckets: readonly string[]) => void }> = [
  {
    label: '複製（同じバケット・同じ prefix）',
    make: (ws, buckets) => {
      const p = path.join(ws, 'myapp copy')
      fs.mkdirSync(path.join(p, '.sakura-cloud'), { recursive: true })
      fs.writeFileSync(path.join(p, '.sakura-cloud', 'env.json'), JSON.stringify({
        persistence: { objectStorage: buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT })) },
      }))
    },
  },
  {
    label: '読めない兄弟（壊れた env.json）',
    make: ws => {
      fs.mkdirSync(path.join(ws, 'broken-env', '.sakura-cloud'), { recursive: true })
      fs.writeFileSync(path.join(ws, 'broken-env', '.sakura-cloud', 'env.json'), '{ not json')
    },
  },
]

const sharedPerms = () => { h.permissions = [{ id: OLD, displayName: permissionNameFor(NAME, 'apprun') }] }

describe('★★★ 共用型の破棄 cloud:teardown: 複製（かもしれない）回は、記録の鍵にも名前での一括にも触れない', () => {
  const GO = { confirmed: true, deleteRegistry: false, registryName: null }
  for (const risk of RISKS) {
    it(`★★★ ${risk.label} → deletePermission・listPermissions が0件。記録の鍵の ID は state に残る`, async () => {
      setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { storagePermissionId: REC } })
      sharedPerms()
      risk.make(workspaceOf(dir), [A])
      const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

      expect(reply.ok).toBe(true)
      expect(h.calls.some(c => c.startsWith('deleteKeys ') || c.startsWith('deleteBucket '))).toBe(false) // データも残している（R1-b・I-1）
      expect(keyCalls(), '記録の鍵か名前の鍵に触れた（元の現役の鍵が切れる）').toEqual([])
      expect(stateMeta(dir)?.storagePermissionId, '記録の鍵の ID は残す').toBe(REC)
    })
  }

  it('★★★ 部分的な複製: 見せた2件のうち2件目だけ複製 → 1件目を片づけても、記録の鍵は切れない（順序: ループの前に確かめる）', async () => {
    setup(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B), APP], meta: { storagePermissionId: REC } })
    sharedPerms()
    RISKS[0].make(workspaceOf(dir), [B]) // 複製が持つのは B だけ。A は複製なし＝普通に消せる
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(h.calls.filter(c => /^(deleteKeys|deleteBucket) /.test(c)), 'A は消し、B（複製あり）は残す').toEqual([`deleteKeys ${A}`, `deleteBucket ${A}`])
    expect(keyCalls(), '1件目（A）を回すあいだに記録の鍵が切れた').toEqual([])
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })

  it('対照: 複製がいなければ、今どおり。記録の鍵を無効にして ID を外し、名前の鍵も一括で無効にする', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { storagePermissionId: REC } })
    sharedPerms()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(keyCalls()).toEqual([`deletePermission ${REC}`, 'listPermissions', `deletePermission ${OLD}`])
    expect(stateMeta(dir)?.storagePermissionId).toBeUndefined()
  })

  it('★★ 記録の鍵を無効にできた回は、一括の無効化の一覧が引けなくても、記録から外す（外す判断は「実際に無効にできたか」だけ）', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { storagePermissionId: REC } })
    sharedPerms()
    h.fail.listPermissions = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(h.calls).toContain(`deletePermission ${REC}`)
    expect(reply.executed.join('\n')).toContain('一覧を取得できなかった') // 警告は出る
    expect(stateMeta(dir)?.storagePermissionId).toBeUndefined()
  })

  it('★★ 途中で止まった回（2件目の一覧に失敗）でも、1件目で記録の鍵を無効にできていれば、記録から外す（失敗の返り値にも permissionRevoked が載る）', async () => {
    setup(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B), APP], meta: { storagePermissionId: REC } })
    sharedPerms()
    h.fail[`listAllKeys ${B}`] = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(false)
    expect(reply.remainingBuckets).toEqual([B])
    expect(h.calls.filter(c => c === `deletePermission ${REC}`)).toHaveLength(1) // 記録の鍵は1回だけ
    expect(h.calls, '見せていない・止まった回は、名前での一括の無効化をしない').not.toContain('listPermissions')
    expect(stateMeta(dir)?.storagePermissionId, '無効にできた鍵の ID が記録に残っている').toBeUndefined()
  })

  it('★★ 記録の鍵を無効にできなかった回は、記録に ID を残す（辿れない鍵を作らない）', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { storagePermissionId: REC } })
    sharedPerms()
    h.fail[`deletePermission ${REC}`] = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(reply.executed.join('\n')).toContain(KEY_REVOKE_FAILED_WARNING)
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })
})

describe('★★★ HANAMII の破棄 hanamii:teardown: 複製（かもしれない）回は、名前での一括の無効化をしない（記録の鍵は持たない）', () => {
  const PROJECT_ID = 'hnm-proj-1'
  const run = async (buckets: string[]) => {
    setup(dir, { env: buckets, resources: [] })
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID } } }, null, 2), 'utf-8')
    h.permissions = [{ id: OLD, displayName: permissionNameFor(NAME, 'hanamii') }]
    globalThis.fetch = (async () => deleteProjectReply(200, PROJECT_ID)) as unknown as typeof fetch
    return hanamiiTeardown(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId: PROJECT_ID })
  }
  for (const risk of RISKS) {
    it(`★★★ ${risk.label} → listPermissions・deletePermission が0件`, async () => {
      risk.make(workspaceOf(dir), [A])
      const result = await run([A])

      expect(result.ok).toBe(true)
      expect(keyCalls(), '名前の鍵を一括で無効にした（元の現役の鍵が切れる）').toEqual([])
    })
  }

  it('★★★ 部分的な複製（2件目だけ複製）→ 1件目を消しても、一括の無効化は走らない', async () => {
    RISKS[0].make(workspaceOf(dir), [B])
    const result = await run([A, B])

    expect(result.ok).toBe(true)
    expect(h.calls.filter(c => /^(deleteKeys|deleteBucket) /.test(c))).toEqual([`deleteKeys ${A}`, `deleteBucket ${A}`])
    expect(keyCalls()).toEqual([])
  })

  it('対照: 複製がいなければ、今どおり。名前の鍵を一括で無効にする', async () => {
    const result = await run([A])
    expect(result.ok).toBe(true)
    expect(keyCalls()).toEqual(['listPermissions', `deletePermission ${OLD}`])
  })
})

describe('★★★ 専有型の破棄 apprunDedicated:teardown: 複製（かもしれない）回は、記録の鍵にも名前での一括にも触れない', () => {
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
  const run = async (buckets: string[]) => {
    setup(dir, { env: buckets, resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', storagePermissionId: REC })
    h.permissions = [{ id: OLD, displayName: permissionNameFor(NAME, 'apprun-dedicated') }]
    d.baseUrl = await listen()
    return dedicatedTeardown(EVENT, dir, { token: 'tok', secret: 'sec' }, { confirmed: true })
  }
  for (const risk of RISKS) {
    it(`★★★ ${risk.label} → deletePermission・listPermissions が0件。記録の鍵の ID は専有型の記録に残る`, async () => {
      risk.make(workspaceOf(dir), [A])
      const result = await run([A])

      expect(result.ok).toBe(true)
      expect(keyCalls(), '記録の鍵か名前の鍵に触れた（元の現役の鍵が切れる）').toEqual([])
      expect(readApprunDedicatedFs(dir).storagePermissionId, '記録の鍵の ID は残す').toBe(REC)
    })
  }

  it('★★★ 部分的な複製（2件目だけ複製）→ 1件目を消しても、記録の鍵は切れない（順序: ループの前に確かめる）', async () => {
    RISKS[0].make(workspaceOf(dir), [B])
    const result = await run([A, B])

    expect(result.ok).toBe(true)
    expect(h.calls.filter(c => /^(deleteKeys|deleteBucket) /.test(c))).toEqual([`deleteKeys ${A}`, `deleteBucket ${A}`])
    expect(keyCalls()).toEqual([])
    expect(readApprunDedicatedFs(dir).storagePermissionId).toBe(REC)
  })

  it('対照: 複製がいなければ、今どおり。記録の鍵を無効にして ID を外し、名前の鍵も一括で無効にする', async () => {
    const result = await run([A])

    expect(result.ok).toBe(true)
    expect(keyCalls()).toEqual([`deletePermission ${REC}`, 'listPermissions', `deletePermission ${OLD}`])
    expect(readApprunDedicatedFs(dir).storagePermissionId ?? null).toBeNull()
  })

  it('★★ 途中で止まった回（2件目の一覧に失敗）でも、1件目で記録の鍵を無効にできていれば、専有型の記録から外す（共用型と同じ）', async () => {
    h.fail[`listAllKeys ${B}`] = 'throw'
    const result = await run([A, B])

    expect(result.ok).toBe(false)
    expect(result.remainingBuckets).toEqual([B])
    expect(h.calls.filter(c => c === `deletePermission ${REC}`)).toHaveLength(1)
    expect(h.calls, '止まった回は、名前での一括の無効化をしない').not.toContain('listPermissions')
    expect(readApprunDedicatedFs(dir).storagePermissionId ?? null, '無効にできた鍵の ID が専有型の記録に残っている').toBeNull()
  })
})

describe('★★★ 公開の apply の保存場所の削除（applyPlan）: 複製（かもしれない）回は、記録の鍵に触れない', () => {
  const KEYS = [`${PREFIX}.koto-keep`, `${PREFIX}data.json`]
  const noCloud: CloudClientLike = {
    dryRun: false,
    async ensureUser() { return { ok: true } },
    async listApps() { return { ok: true, data: [] } },
    async getApp() { return { ok: true, dryRun: false, data: { min_scale: 0 } } },
    async createApp() { return { ok: true } },
    async patchApp() { return { ok: true } },
    async deleteApp() { return { ok: true } },
  }
  function fakeStorage(failPermission = false) {
    const calls = { deletedKeys: [] as string[], deletedBuckets: [] as string[], deletedPermissions: [] as string[], listedPermissions: 0 }
    const client: StorageClientLike & { dispose(): Promise<void> } = {
      async isSiteReady() { return true },
      async ensureBucket() {},
      async listAllKeys() { return [...KEYS] },
      async putMarker() {},
      async deleteKeys(_b, ks) { calls.deletedKeys.push(...ks) },
      async deleteBucket(b) { calls.deletedBuckets.push(b) },
      async issueKey() { return { accessKey: 'AKIA', secretKey: 'S3CRET', permissionId: 'perm-new' } },
      async deletePermission(id) { calls.deletedPermissions.push(id); if (failPermission) throw new Error('テスト用の失敗') },
      async listPermissions() { calls.listedPermissions++; return [] },
      siteInfo() { return { s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' } },
      async dispose() {},
    }
    return { client, calls }
  }
  const specOf = (buckets: string[]): EnvSpec => {
    const s = defaultSpec({ name: NAME, hasDockerfile: false })
    s.persistence = { objectStorage: buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT })) }
    return s
  }
  const deletePlan = (buckets: string[]): Plan => ({
    actions: buckets.map(b => ({ type: 'delete', kind: 'bucket', name: b, stateful: true, destructive: true, description: `保存場所『${b}』を削除` } as any)),
    hasDestructive: true,
    hasStatefulDelete: true,
  }) as Plan
  const stateWithKey = () => ({ ...emptyState(NAME, 'sakura-apprun'), meta: { storagePermissionId: REC } })
  const run = (buckets: string[], storage: StorageClientLike) =>
    applyPlan({ plan: deletePlan(buckets), spec: specOf(buckets), state: stateWithKey(), client: noCloud, storage, confirmed: true, projectDir: dir })

  for (const risk of RISKS) {
    it(`★★★ ${risk.label} → deletePermission が0件。記録の鍵の ID は state に残る`, async () => {
      risk.make(workspaceOf(dir), [A])
      const { client, calls } = fakeStorage()
      const r = await run([A], client)

      expect(r.ok).toBe(true)
      expect(calls.deletedKeys).toEqual([])
      expect(calls.deletedPermissions, '記録の鍵に触れた（元の現役の鍵が切れる）').toEqual([])
      expect(calls.listedPermissions).toBe(0)
      expect(r.state.meta?.storagePermissionId, '記録の鍵の ID は残す').toBe(REC)
    })
  }

  it('★★★ 部分的な複製（2件目だけ複製）→ 1件目を消しても、記録の鍵は切れない（順序: 先に確かめる）', async () => {
    RISKS[0].make(workspaceOf(dir), [B])
    const { client, calls } = fakeStorage()
    const r = await run([A, B], client)

    expect(r.ok).toBe(true)
    expect(calls.deletedBuckets, 'A は消し、B（複製あり）は残す').toEqual([A])
    expect(calls.deletedPermissions, '1件目（A）を回すあいだに記録の鍵が切れた').toEqual([])
    expect(r.state.meta?.storagePermissionId).toBe(REC)
  })

  it('対照: 複製がいなければ、今どおり。記録の鍵を無効にして ID を外す', async () => {
    const { client, calls } = fakeStorage()
    const r = await run([A], client)

    expect(r.ok).toBe(true)
    expect(calls.deletedPermissions).toEqual([REC])
    expect(r.state.meta?.storagePermissionId).toBeUndefined()
  })

  it('★★ 記録の鍵を無効にできなかった回は、記録に ID を残す', async () => {
    const { client, calls } = fakeStorage(true)
    const r = await run([A], client)

    expect(r.ok).toBe(true)
    expect(calls.deletedPermissions).toEqual([REC])
    expect(r.state.meta?.storagePermissionId).toBe(REC)
    expect(r.skipped.join('\n')).toContain(KEY_REVOKE_FAILED_WARNING)
  })
})

// ── teardownStorage 自体の歯止め（呼び手が先に鍵を渡さない形にしていても、ここが独立に守る）────────────────────────
describe('★★★ teardownStorage: データを残した（keptData）回は、permissionId を渡されても無効にしない。permissionRevoked を返す', () => {
  const workspaces: string[] = []
  afterEach(() => { for (const w of workspaces.splice(0)) fs.rmSync(w, { recursive: true, force: true }) })
  function project(risk: typeof RISKS[number] | null): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-twin-keys-'))
    workspaces.push(ws)
    const me = path.join(ws, 'myapp')
    fs.mkdirSync(me)
    risk?.make(ws, [A])
    return me
  }
  function fake(failPermission = false) {
    const calls: string[] = []
    const storage: StorageTeardownClientLike = {
      async listAllKeys() { calls.push('listAllKeys'); return [`${PREFIX}data.json`] },
      async deleteKeys() { calls.push('deleteKeys') },
      async deleteBucket() { calls.push('deleteBucket') },
      async deletePermission(id) { calls.push(`deletePermission ${id}`); if (failPermission) throw new Error('テスト用の失敗') },
    }
    return { storage, calls }
  }
  const placement = { bucket: A, prefix: PREFIX, shared: true }

  for (const risk of RISKS) {
    it(`★★★ ${risk.label} → deletePermission は呼ばれない・permissionRevoked は false・warnings は空・keptData`, async () => {
      const { storage, calls } = fake()
      const out = await teardownStorage({ storage, placement, permissionId: REC, projectDir: project(risk) })

      expect(out).toMatchObject({ ok: true, keptData: true, deletedBucket: false, permissionRevoked: false, warnings: [] })
      expect(calls, '鍵を無効にした（元の現役の鍵が切れる）').toEqual(['listAllKeys'])
    })
  }

  it('対照: 複製がいなければ、鍵を無効にして permissionRevoked は true。permissionId が無ければ呼ばず false', async () => {
    const withKey = fake()
    const out = await teardownStorage({ storage: withKey.storage, placement, permissionId: REC, projectDir: project(null) })
    expect(out).toMatchObject({ ok: true, deletedBucket: true, permissionRevoked: true, warnings: [] })
    expect(withKey.calls).toEqual(['listAllKeys', 'deleteKeys', 'deleteBucket', `deletePermission ${REC}`])

    const noKey = fake()
    expect(await teardownStorage({ storage: noKey.storage, placement, permissionId: null, projectDir: project(null) })).toMatchObject({ ok: true, permissionRevoked: false })
    expect(noKey.calls.some(c => c.startsWith('deletePermission'))).toBe(false)
  })

  it('★★ 無効にできなかった回は permissionRevoked が false（warnings に失敗の文）', async () => {
    const { storage } = fake(true)
    const out = await teardownStorage({ storage, placement, permissionId: REC, projectDir: project(null) })
    expect(out).toMatchObject({ ok: true, permissionRevoked: false, warnings: [KEY_REVOKE_FAILED_WARNING] })
  })
})
