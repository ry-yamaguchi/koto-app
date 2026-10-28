import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'

// ── T-R1b: 隣に「複製かどうか確かめられないフォルダ」があると、4つの道のどれでも、データもバケットも消さない（0.6.24 R1-b・作者の決定 K3・2026-10-25）────
// 状況: 破棄するプロジェクトの隣に、記録（env.json・state.json）が壊れている・読めないフォルダ、たどれないリンクがあると、
// それが複製かどうか（同じバケットの同じ prefix を持つか）を見分けられない。複製なら、破棄が元のデータを prefix ごと消す（元に戻せない）。
// そのときは、データ（キー）もバケットも消さず、結果の行に読めなかったフォルダの名前を出す（作者の決定）。
// 4つの道 = 共用型の破棄・HANAMII の破棄・専有型の破棄・公開の apply の保存場所の削除。本物の main に偽の保存場所・偽の兄弟フォルダを流し、**出た要求の一覧**で固定する（掟10）。
// 対照: `.sakuraide.json` だけが読めない兄弟は、複製かどうかは確かめられている（env と state が読める）ので、今どおり（自分の prefix を消し、バケットは残す）。
// 鍵（deletePermission・listPermissions）に触れないことは tests/twinKeysUntouched.test.ts。判断は tests/twinRiskOf.test.ts、読み方は tests/bucketUsersUnread.test.ts。
import { A, APP, OK_AUTH, PREFIX, CONSENTED_AT, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup } from './sharedTeardownHarness'
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
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { applyPlan, type StorageClientLike, type CloudClientLike } from '../src/main/cloud/apply'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { emptyState } from '../src/main/cloud/state'
import type { Plan } from '../src/main/cloud/planner'
import { deleteProjectReply } from './hanamiiTeardownFixtures'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const hanamiiTeardown = shownTeardown(h.handlers.get('hanamii:teardown')!)
const dedicatedTeardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!)

const EVENT = { sender: { send: () => {} } }
const S = A
const DELETED_LINE_HEAD = `保存場所『${S}』のデータを削除しました`
const keptLine = (name: string) => `保存場所『${S}』のデータは残しました — フォルダ『${name}』の記録を読めないため、同じデータを使っているか確かめられませんでした。`

let dir = ''
let server: Server | null = null
const realFetch = globalThis.fetch
const lockedFiles: string[] = []
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  d.baseUrl = ''
  dir = newProjectDir()
})
afterEach(() => {
  if (server) { server.close(); server = null }
  globalThis.fetch = realFetch
  for (const f of lockedFiles.splice(0)) { try { fs.chmodSync(f, 0o600) } catch { /* 消えていた */ } }
  fs.rmSync(dir, { recursive: true, force: true })
})

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

/** 隣に置く「確かめられない」形 4つ（仕様 R1-b）。`name` は、結果の行に出るフォルダ名。 */
const SHAPES: ReadonlyArray<{ label: string; name: string; make: (ws: string) => void; skip?: boolean }> = [
  {
    label: '壊れた env.json・state なし', name: 'broken-env',
    make: ws => { fs.mkdirSync(path.join(ws, 'broken-env', '.sakura-cloud'), { recursive: true }); fs.writeFileSync(path.join(ws, 'broken-env', '.sakura-cloud', 'env.json'), '{ not json') },
  },
  {
    label: 'env.json が chmod 000', name: 'locked-env', skip: isRoot, // root は権限を無視して読めるので、この形を作れない
    make: ws => {
      const f = path.join(ws, 'locked-env', '.sakura-cloud', 'env.json')
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, JSON.stringify({ persistence: { objectStorage: [{ bucket: S, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT }] } }))
      fs.chmodSync(f, 0o000)
      lockedFiles.push(f)
    },
  },
  {
    label: '辿れないシンボリックリンク', name: 'dangling-link',
    make: ws => { fs.symlinkSync(path.join(ws, 'no-such-place'), path.join(ws, 'dangling-link')) },
  },
  {
    label: '壊れた state.json', name: 'broken-state',
    make: ws => { fs.mkdirSync(path.join(ws, 'broken-state', '.sakura-cloud'), { recursive: true }); fs.writeFileSync(path.join(ws, 'broken-state', '.sakura-cloud', 'state.json'), '{ not json') },
  },
]

/** 対照: `.sakuraide.json` だけが壊れている兄弟（env.json は読めて、同じバケットを別の prefix で使う）。複製かどうかは確かめられている。 */
function brokenMetaOnly(ws: string): void {
  fs.mkdirSync(path.join(ws, 'broken-meta', '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'broken-meta', '.sakura-cloud', 'env.json'), JSON.stringify({
    persistence: { objectStorage: [{ bucket: S, prefix: 'projects/other/', shared: true, consentedAt: CONSENTED_AT }] },
  }))
  fs.writeFileSync(path.join(ws, 'broken-meta', '.sakuraide.json'), '{ not json')
}

/** 保存場所へ出た、消す要求（deleteKeys・deleteBucket）と、一覧の確認（listAllKeys）。 */
const deletions = () => h.calls.filter(c => /^(deleteKeys|deleteBucket) /.test(c))
const listings = () => h.calls.filter(c => c.startsWith('listAllKeys '))

describe('★★★ 共用型の破棄 cloud:teardown: 確かめられない隣がいれば、データもバケットも消さない', () => {
  const GO = { confirmed: true, deleteRegistry: false, registryName: null }
  for (const shape of SHAPES) {
    it.skipIf(shape.skip)(`★★★ ${shape.label} → 削除の要求は0件・一覧の確認だけ。行は「データは残しました — フォルダ『${shape.name}』の記録を読めないため…」`, async () => {
      setup(dir, { env: [S], resources: [bucketRef(S), APP] })
      shape.make(workspaceOf(dir))
      const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

      expect(reply.ok).toBe(true)
      expect(deletions(), 'キーかバケットを消した（隣が複製なら、元のデータが消える）').toEqual([])
      expect(listings()).toEqual([`listAllKeys ${S}`])
      expect(reply.executed.find((l: string) => l.includes(S))).toBe(keptLine(shape.name))
      expect(reply.executed.join('\n')).not.toContain(DELETED_LINE_HEAD)
      expect(reply.message, '「データを削除しました」と言わない').toBeUndefined()
      expect(reply.keptBucketNames).toEqual([S])
      expect(reply.keptBucketsUsedByOthers, '使っているとは確かめていない').toBeUndefined()
    })
  }

  it('対照: 隣が .sakuraide.json だけ壊れている → 今どおり。自分の prefix のキーは消し、バケットは残す（使っているか確かめられないので）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    brokenMetaOnly(workspaceOf(dir))
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(deletions()).toEqual([`deleteKeys ${S}`])
    expect(reply.executed.find((l: string) => l.includes(S))).toBe(`${DELETED_LINE_HEAD} — 保存場所は残します。`)
  })
})

describe('★★★ HANAMII の破棄 hanamii:teardown: 確かめられない隣がいれば、データもバケットも消さない', () => {
  const PROJECT_ID = 'hnm-proj-1'
  const run = async () => {
    setup(dir, { env: [S], resources: [] })
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID } } }, null, 2), 'utf-8')
    globalThis.fetch = (async () => deleteProjectReply(200, PROJECT_ID)) as unknown as typeof fetch
    return hanamiiTeardown(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId: PROJECT_ID })
  }
  for (const shape of SHAPES) {
    it.skipIf(shape.skip)(`★★★ ${shape.label} → 削除の要求は0件・一覧の確認だけ。行は「データは残しました — …」`, async () => {
      shape.make(workspaceOf(dir))
      const result = await run()

      expect(result.ok).toBe(true)
      expect(deletions()).toEqual([])
      expect(listings()).toEqual([`listAllKeys ${S}`])
      expect(result.executed.find((l: string) => l.includes(S))).toBe(keptLine(shape.name))
      expect(result.executed.join('\n')).not.toContain(DELETED_LINE_HEAD)
      expect(result.keptBucketsUsedByOthers).toBeUndefined()
    })
  }

  it('対照: 隣が .sakuraide.json だけ壊れている → 今どおり。自分の prefix のキーは消し、バケットは残す', async () => {
    brokenMetaOnly(workspaceOf(dir))
    const result = await run()

    expect(result.ok).toBe(true)
    expect(deletions()).toEqual([`deleteKeys ${S}`])
    expect(result.executed.find((l: string) => l.includes(S))).toBe(`${DELETED_LINE_HEAD} — 保存場所は残します。`)
  })
})

describe('★★★ 専有型の破棄 apprunDedicated:teardown: 確かめられない隣がいれば、データもバケットも消さない', () => {
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
    setup(dir, { env: [S], resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    d.baseUrl = await listen()
    return dedicatedTeardown(EVENT, dir, { token: 'tok', secret: 'sec' }, { confirmed: true })
  }
  for (const shape of SHAPES) {
    it.skipIf(shape.skip)(`★★★ ${shape.label} → 削除の要求は0件・一覧の確認だけ。行は「データは残しました — …」`, async () => {
      shape.make(workspaceOf(dir))
      const result = await run()

      expect(result.ok).toBe(true)
      expect(deletions()).toEqual([])
      expect(listings()).toEqual([`listAllKeys ${S}`])
      expect(result.executed.find((l: string) => l.includes(S))).toBe(keptLine(shape.name))
      expect(result.executed.join('\n')).not.toContain(DELETED_LINE_HEAD)
      expect(result.keptBucketsUsedByOthers).toBeUndefined()
    })
  }

  it('対照: 隣が .sakuraide.json だけ壊れている → 今どおり。自分の prefix のキーは消し、バケットは残す', async () => {
    brokenMetaOnly(workspaceOf(dir))
    const result = await run()

    expect(result.ok).toBe(true)
    expect(deletions()).toEqual([`deleteKeys ${S}`])
    expect(result.executed.find((l: string) => l.includes(S))).toBe(`${DELETED_LINE_HEAD} — 保存場所は残します。`)
  })
})

describe('★★★ 公開の apply の保存場所の削除（applyPlan）: 確かめられない隣がいれば、データもバケットも消さない', () => {
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
  function fakeStorage() {
    const calls = { deletedKeys: [] as string[], deletedBuckets: [] as string[], listed: 0 }
    const client: StorageClientLike & { dispose(): Promise<void> } = {
      async isSiteReady() { return true },
      async ensureBucket() {},
      async listAllKeys() { calls.listed++; return [...KEYS] },
      async putMarker() {},
      async deleteKeys(_b, ks) { calls.deletedKeys.push(...ks) },
      async deleteBucket(b) { calls.deletedBuckets.push(b) },
      async issueKey() { return { accessKey: 'AKIA', secretKey: 'S3CRET', permissionId: 'perm-new' } },
      async deletePermission() {},
      async listPermissions() { return [] },
      siteInfo() { return { s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' } },
      async dispose() {},
    }
    return { client, calls }
  }
  const spec = (): EnvSpec => {
    const s = defaultSpec({ name: 'myapp', hasDockerfile: false })
    s.persistence = { objectStorage: [{ bucket: S, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT }] }
    return s
  }
  const deletePlan = (): Plan => ({
    actions: [{ type: 'delete', kind: 'bucket', name: S, stateful: true, destructive: true, description: `保存場所『${S}』を削除` } as any],
    hasDestructive: true,
    hasStatefulDelete: true,
  }) as Plan
  const run = (storage: StorageClientLike) =>
    applyPlan({ plan: deletePlan(), spec: spec(), state: emptyState('myapp', 'sakura-apprun'), client: noCloud, storage, confirmed: true, projectDir: dir })

  for (const shape of SHAPES) {
    it.skipIf(shape.skip)(`★★★ ${shape.label} → 削除の要求は0件・一覧の確認だけ。行は「データは残しました — …」（「…を削除」と言わない）`, async () => {
      shape.make(workspaceOf(dir))
      const { client, calls } = fakeStorage()
      const r = await run(client)

      expect(r.ok).toBe(true)
      expect(calls.deletedKeys).toEqual([])
      expect(calls.deletedBuckets).toEqual([])
      expect(calls.listed).toBe(1)
      expect(r.executed[0]).toBe(keptLine(shape.name))
      expect(r.executed.join('\n')).not.toContain(`保存場所『${S}』を削除`)
    })
  }

  it('対照: 隣が .sakuraide.json だけ壊れている → 今どおり。自分の prefix のキーは消し、バケットは残す', async () => {
    brokenMetaOnly(workspaceOf(dir))
    const { client, calls } = fakeStorage()
    const r = await run(client)

    expect(r.ok).toBe(true)
    expect(calls.deletedKeys).toEqual(KEYS)
    expect(calls.deletedBuckets).toEqual([])
    expect(r.executed[0]).toBe(`保存場所『${S}』を削除 — 保存場所は残します。`)
  })
})
