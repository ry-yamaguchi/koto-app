import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'

// ── T-I3: 複製を破棄すると、4つの道（共用型・HANAMII・専有型の破棄と、公開の apply の保存場所の削除）のどれでも、データもバケットも消さない（0.6.24 I-1）────
// 状況（2026-10-25 の調査 H5・H7）: Finder でプロジェクトのフォルダを複製すると、複製は元と同じバケット・同じ prefix を記録に持つ。
// 元が「用意しただけ」で公開していない（.sakuraide.json が無い）と、使用者とも数えられず、複製の破棄が**バケットごと**消していた。
// 公開している元でも、複製の破棄は元の prefix の中身（データ）を消していた。
// ここは本物の main（3つの IPC と applyPlan）に、偽の保存場所・偽の兄弟フォルダを流し、**出た要求の一覧**で固定する（掟10。ソースの文字列は読まない）。
// 要求の一覧は、削除（deleteKeys・deleteBucket）が0件で、一覧の確認（listAllKeys）だけが出ていること。行は「データは残しました」。
// 判断そのものは tests/objectStorageSamePrefix.test.ts、samePrefix の読み方は tests/bucketUsersSamePrefix.test.ts。
import { A, APP, OK_AUTH, PREFIX, CONSENTED_AT, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, envBuckets, writePublishRecord } from './sharedTeardownHarness'
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
// 画面の代わりに、確認で見せた保存場所（記録から作る）を足して渡す（0.6.24 F。main は見せたものだけを消す）
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const hanamiiTeardown = shownTeardown(h.handlers.get('hanamii:teardown')!) // 画面の代わりに、確認で見せた保存場所（env.json の記録）を渡す
const dedicatedTeardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!) // 画面の代わりに、確認で見せた保存場所（env.json の記録）を渡す（0.6.24 F。main は見せたものだけを消す）

const EVENT = { sender: { send: () => {} } }
const S = A
const TWIN = 'myapp copy'
const KEPT_LINE = `保存場所『${S}』のデータは残しました — フォルダ『${TWIN}』も同じデータを使っています。`
const DELETED_LINE_HEAD = `保存場所『${S}』のデータを削除しました`

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

/**
 * 複製（`myapp copy`）を、元（`myapp`）と同じ親フォルダに置く。元と同じバケット・同じ prefix を env.json に同意済みで持つ。
 * `published` を渡すと、公開の記録（.sakuraide.json）にその公開先の行も置く（既定は無し＝元が「用意しただけ」の H7）。
 */
function twin(opts: { published?: string } = {}): string {
  const p = path.join(workspaceOf(dir), TWIN)
  fs.mkdirSync(path.join(p, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(p, '.sakura-cloud', 'env.json'), JSON.stringify({
    persistence: { objectStorage: [{ bucket: S, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT }] },
  }))
  if (opts.published) writePublishRecord(p, { [opts.published]: { publishedAt: CONSENTED_AT, url: 'https://x.example/' } })
  return p
}

/** 保存場所へ出た、消す要求（deleteKeys・deleteBucket）と、一覧の確認（listAllKeys）。 */
const deletions = () => h.calls.filter(c => /^(deleteKeys|deleteBucket) /.test(c))
const listings = () => h.calls.filter(c => c.startsWith('listAllKeys '))

describe('★★★ 共用型の破棄 cloud:teardown: 複製を破棄しても、データもバケットも消えない', () => {
  const GO = { confirmed: true, deleteRegistry: false, registryName: null }

  it('★★★ 元が「用意しただけ」（公開の記録が無い・H7）→ 削除の要求は0件・一覧の確認だけ。行は「データは残しました」。記録の保存場所は残る', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    twin()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(deletions(), 'キーかバケットを消した（複製から元のデータが消える）').toEqual([])
    expect(listings()).toEqual([`listAllKeys ${S}`])
    expect(reply.executed.find((l: string) => l.includes(S))).toBe(KEPT_LINE)
    expect(reply.executed.join('\n')).not.toContain(DELETED_LINE_HEAD)
    expect(reply.message, '「データを削除しました」と言わない').toBeUndefined()
    expect(reply.keptBucketNames).toEqual([S])
    expect(reply.keptBucketsUsedByOthers).toEqual([S])
    expect(envBuckets(dir)).toEqual([S]) // バケットを消していないので、記録に残す
  })

  it('★★ 元が公開している（共用型の行がある）でも同じ。複製を使用者に数える既存の守りと両立する', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    twin({ published: 'sakura-apprun' })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(deletions()).toEqual([]) // 以前は「ほかが使う」で、自分の prefix のキー（＝複製と同じ元のデータ）は消していた
    expect(reply.executed.find((l: string) => l.includes(S))).toBe(KEPT_LINE)
  })

  it('対照: 複製がいなければ、これまでどおりバケットごと消し、行は「データを削除しました」', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(deletions()).toEqual([`deleteKeys ${S}`, `deleteBucket ${S}`])
    expect(reply.executed.find((l: string) => l.includes(S))).toBe(`${DELETED_LINE_HEAD} — 保存場所ごと削除しました。月額の課金も止まります。`)
    expect(reply.message).toBe('保存場所にあった、このプロジェクトのデータを削除しました。')
  })
})

describe('★★★ HANAMII の破棄 hanamii:teardown: 複製を破棄しても、データもバケットも消えない', () => {
  const PROJECT_ID = 'hnm-proj-1'
  const run = async () => {
    setup(dir, { env: [S], resources: [] })
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID } } }, null, 2), 'utf-8')
    globalThis.fetch = (async () => deleteProjectReply(200, PROJECT_ID)) as unknown as typeof fetch
    return hanamiiTeardown(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId: PROJECT_ID })
  }

  it('★★★ 元が「用意しただけ」→ 削除の要求は0件・一覧の確認だけ。行は「データは残しました」', async () => {
    twin()
    const result = await run()

    expect(result.ok).toBe(true)
    expect(deletions()).toEqual([])
    expect(listings()).toEqual([`listAllKeys ${S}`])
    expect(result.executed.find((l: string) => l.includes(S))).toBe(KEPT_LINE)
    expect(result.executed.join('\n')).not.toContain(DELETED_LINE_HEAD)
    expect(result.keptBucketsUsedByOthers).toEqual([S])
  })

  it('対照: 複製がいなければ、これまでどおりバケットごと消す', async () => {
    const result = await run()
    expect(result.ok).toBe(true)
    expect(deletions()).toEqual([`deleteKeys ${S}`, `deleteBucket ${S}`])
    expect(result.executed.find((l: string) => l.includes(S))).toContain(DELETED_LINE_HEAD)
  })
})

describe('★★★ 専有型の破棄 apprunDedicated:teardown: 複製を破棄しても、データもバケットも消えない', () => {
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

  it('★★★ 元が「用意しただけ」→ 削除の要求は0件・一覧の確認だけ。行は「データは残しました」', async () => {
    twin()
    const result = await run()

    expect(result.ok).toBe(true)
    expect(deletions()).toEqual([])
    expect(listings()).toEqual([`listAllKeys ${S}`])
    expect(result.executed.find((l: string) => l.includes(S))).toBe(KEPT_LINE)
    expect(result.executed.join('\n')).not.toContain(DELETED_LINE_HEAD)
    expect(result.keptBucketsUsedByOthers).toEqual([S])
  })

  it('対照: 複製がいなければ、これまでどおりバケットごと消す', async () => {
    const result = await run()
    expect(result.ok).toBe(true)
    expect(deletions()).toEqual([`deleteKeys ${S}`, `deleteBucket ${S}`])
    expect(result.executed.find((l: string) => l.includes(S))).toContain(DELETED_LINE_HEAD)
  })
})

describe('★★★ 公開の apply の保存場所の削除（applyPlan）: 複製があれば、データもバケットも消えない', () => {
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

  it('★★★ 複製がいる → 削除の要求は0件・一覧の確認だけ。行は「データは残しました」（「…を削除」と言わない）', async () => {
    twin()
    const { client, calls } = fakeStorage()
    const r = await run(client)

    expect(r.ok).toBe(true)
    expect(calls.deletedKeys).toEqual([])
    expect(calls.deletedBuckets).toEqual([])
    expect(calls.listed).toBe(1)
    expect(r.executed[0]).toBe(KEPT_LINE)
    expect(r.executed.join('\n')).not.toContain(`保存場所『${S}』を削除`)
    expect(r.executed.join('\n')).toContain('ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。')
  })

  it('対照: 複製がいなければ、これまでどおりバケットごと消す。行は今までの形', async () => {
    const { client, calls } = fakeStorage()
    const r = await run(client)

    expect(r.ok).toBe(true)
    expect(calls.deletedKeys).toEqual(KEYS)
    expect(calls.deletedBuckets).toEqual([S])
    expect(r.executed).toEqual([`保存場所『${S}』を削除 — 保存場所ごと削除しました。月額の課金も止まります。`])
  })
})
