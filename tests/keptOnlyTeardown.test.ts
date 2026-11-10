import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'

// ── T-2a・T-2b: main が「何も消さなかった」を事実（keptOnly）で返す。共用型 cloud:teardown と専有型 apprunDedicated:teardown だけ。HANAMII には付けない ─────
// 本物の main（3つの IPC）に、偽の保存場所・偽の client・偽の兄弟フォルダを流し、**出た要求の一覧**と返り値で固定する（掟10。ソースの文字列で判断を読まない）。
// 判定は shared/keptOnly.ts の keptOnlyOf の1つ（共用型・専有型が同じこれを呼ぶ。判定の全分岐は tests/keptOnly.test.ts）。
// ここで見ること:
//   ・付く回: アプリ無し・レジストリを消していない・保存場所が1件以上で全部 keptData（複製・確かめられない兄弟。理由は問わない）→ keptOnly:true、消す要求は0件
//   ・付かない回: アプリあり／保存場所の1件が複製でない／保存場所0件／ok:false／レジストリを実際に消した
//   ・専有型: 保存場所だけが残った印の押し直し＋複製 → 付く。資源の ID がある回は付かない
//   ・HANAMII は付けない
//   ・その場の返り値（toTeardownView）と main が書いた記録（summarizeResult → getOps → resumedTeardownView）が同じ keptOnly を読む（T-2b）
import { A, B, APP, OK_AUTH, PREFIX, CONSENTED_AT, REGISTRY_ROW, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, stateMeta } from './sharedTeardownHarness'
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
import { getOps, resetProjectOpsForTests } from '../src/main/projectOps'
import { toTeardownView, resumedTeardownView, resultCallOf } from '../src/shared/teardownResult'
import { deleteProjectReply, useFastHanamiiDeletionWait } from './hanamiiTeardownFixtures'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const hanamiiTeardown = shownTeardown(h.handlers.get('hanamii:teardown')!)
const dedicatedTeardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!)

const EVENT = { sender: { send: () => {} } }
const S = A
const TWIN = 'myapp copy'
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const GO_DELETE_REGISTRY = { confirmed: true, deleteRegistry: true, registryName: 'myreg' }

let dir = ''
let server: Server | null = null
const realFetch = globalThis.fetch
useFastHanamiiDeletionWait() // 202 のあとの待ちは偽の時計で回す（本物の sleep で待たない）
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

/** 複製（`myapp copy`）を、元と同じ親フォルダに置く。元と同じバケット・同じ prefix を env.json に同意済みで持つ（`buckets` で複数にできる）。 */
function twin(buckets: string[] = [S]): string {
  const p = path.join(workspaceOf(dir), TWIN)
  fs.mkdirSync(path.join(p, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(p, '.sakura-cloud', 'env.json'), JSON.stringify({
    persistence: { objectStorage: buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT })) },
  }))
  return p
}

/** 隣に、複製かどうか確かめられないフォルダ（env.json が壊れている）を置く。 */
function unreadSibling(): void {
  const p = path.join(workspaceOf(dir), 'broken-env', '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), '{ not json')
}

/** 保存場所へ出た、消す要求と鍵の無効化の要求（0件であることを確かめる）。 */
const destructive = () => h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission|listPermissions)\b/.test(c))
const hasKeptOnly = (reply: object): boolean => 'keptOnly' in reply

describe('★★★ 共用型 cloud:teardown: keptOnly を付ける回・付けない回（T-2a）', () => {
  it('★★★ アプリ無し・レジストリ無し・保存場所1件が複製と同じ prefix → keptOnly:true。削除・鍵の無効化の要求は0件（記録の鍵があっても）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)], meta: { storagePermissionId: 'perm-1' } })
    twin()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(reply.keptOnly).toBe(true)
    expect(destructive(), '消す要求・鍵の無効化が出た').toEqual([])
    expect(h.calls.filter((c: string) => c.startsWith('listAllKeys '))).toEqual([`listAllKeys ${S}`])
  })

  it('★★★ 前の回の印（keySweepPending）がある回が keptOnly で済んでも、印は残る（何も消さず、一括の無効化もしていない）。印が無い回は立てない', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)], meta: { keySweepPending: 'apprun' } })
    twin()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.keptOnly).toBe(true)
    expect(destructive()).toEqual([])
    expect(stateMeta(dir)).toEqual({ keySweepPending: 'apprun' })

    resetHarness(); resetProjectOpsForTests(); dir = newProjectDir()
    setup(dir, { env: [S], resources: [bucketRef(S)] })
    twin()
    expect((await sharedTeardown(EVENT, dir, OK_AUTH, GO)).keptOnly).toBe(true)
    expect(stateMeta(dir), '印が無い回は立てない').toBeUndefined()
  })

  it('★★★ 確かめられない兄弟（env.json が壊れている・unread）→ keptOnly:true（理由は問わない）。消す要求は0件', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)] })
    unreadSibling()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(reply.keptOnly).toBe(true)
    expect(destructive()).toEqual([])
  })

  it('★★★ 保存場所2件が両方とも複製 → keptOnly:true', async () => {
    setup(dir, { env: [S, B], resources: [bucketRef(S), bucketRef(B)] })
    twin([S, B])
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(reply.keptOnly).toBe(true)
    expect(destructive()).toEqual([])
  })

  it('★★★ 保存場所2件のうち1件だけ複製（もう1件は消した）→ 付けない', async () => {
    setup(dir, { env: [S, B], resources: [bucketRef(S), bucketRef(B)] })
    twin([S])
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(hasKeptOnly(reply), '1件はデータごと消している').toBe(false)
    expect(h.calls).toContain(`deleteBucket ${B}`)
    expect(h.calls).not.toContain(`deleteBucket ${S}`)
  })

  it('★★★ アプリがある回は、保存場所が全部複製でも付けない（アプリを消している）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    twin()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(reply.appDeleted).toBe(true)
    expect(h.calls).toContain('deleteApp app-1')
    expect(hasKeptOnly(reply)).toBe(false)
    expect(reply.keptBucketsUsedByOthers).toEqual([S]) // 保存場所は残した（月額の警告の材料は今までどおり）
  })

  it('★★ 対照: 複製がいなければ、アプリが無くてもバケットごと消す。付けない', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)] })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(h.calls).toContain(`deleteBucket ${S}`)
    expect(hasKeptOnly(reply)).toBe(false)
  })

  it('★★★ 保存場所が0件（残した保存場所が無い）→ 付けない', async () => {
    setup(dir, { env: [], resources: [] })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(hasKeptOnly(reply)).toBe(false)
  })

  it('★★★ ok:false（一覧できず止まった）→ 付けない。複製がいても、失敗の回は「何も消さなかった」と言わない', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)] })
    twin()
    h.fail[`listAllKeys ${S}`] = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(false)
    expect(hasKeptOnly(reply)).toBe(false)
    expect(destructive()).toEqual([])
  })

  it('★★★ ok:false（2件目で止まった。1件目は複製のため残した）→ 付けない。残した分だけを見て「何も消さなかった」と言わない', async () => {
    setup(dir, { env: [S, B], resources: [bucketRef(S), bucketRef(B)] })
    twin([S])
    h.fail[`listAllKeys ${B}`] = 'throw'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(false)
    expect(reply.keptBucketNames).toEqual([S]) // 1件目は残した（事実は返る）
    expect(hasKeptOnly(reply)).toBe(false)
    expect(destructive()).toEqual([])
  })

  it('★★★ レジストリを実際に消した回 → 付けない（保存場所が全部複製でも）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)], meta: { registryName: 'myreg' } })
    twin()
    h.registryRows = [REGISTRY_ROW]
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO_DELETE_REGISTRY)

    expect(reply.ok).toBe(true)
    expect(h.calls).toContain('deleteContainerRegistry reg-1')
    expect(hasKeptOnly(reply), 'コンテナレジストリを消している').toBe(false)
  })

  it('★★ レジストリを消す選択をしなかった回は、残したレジストリがあっても付く（何も消していない）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)], meta: { registryName: 'myreg' } })
    twin()
    h.registryRows = [REGISTRY_ROW]
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(h.calls.some((c: string) => c.startsWith('deleteContainerRegistry'))).toBe(false)
    expect(reply.keptOnly).toBe(true)
    expect(reply.keptRegistryName).toBe('myreg')
  })

  it('★★ レジストリを消す選択をしたが消せなかった回（一覧の取得に失敗）は、実際には何も消していないので付く', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)], meta: { registryName: 'myreg' } })
    twin()
    h.registryRows = [REGISTRY_ROW]
    h.fail.listContainerRegistries = 'http500'
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO_DELETE_REGISTRY)

    expect(reply.ok).toBe(true)
    expect(h.calls.some((c: string) => c.startsWith('deleteContainerRegistry'))).toBe(false)
    expect(reply.keptOnly).toBe(true)
  })
})

describe('★★★ 双子（T-2b）: その場の返り値と、main が書いた記録が、同じ keptOnly を読む', () => {
  it('★★★ 付く回: その場（toTeardownView）と記録（getOps → resumedTeardownView）が同じ view。keptOnly:true・state は done・ok は true のまま・月額の警告は残る', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S)] })
    twin()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    const rec = getOps(dir).last?.result
    expect(rec, '終わった操作の結果が記録に無い').toBeTruthy()

    expect(reply.keptOnly).toBe(true)
    expect((rec!.extra as Record<string, unknown>).keptOnly, 'EXTRA_KEYS に keptOnly が無いと、記録に写らない').toBe(true)
    const live = toTeardownView('sakura-apprun', reply)
    const resumed = resumedTeardownView('sakura-apprun', rec)
    expect(resumed, 'その場と開き直しが食い違う').toEqual(live)
    expect(live).toMatchObject({ ok: true, state: 'done', keptOnly: true })
    expect(live.warnings.length, '月額の警告を削らない').toBeGreaterThan(0)
    expect(resultCallOf('sakura-apprun', rec)).toBe('doneKeptOnly')
  })

  it('★★★ 付かない回（アプリがある）: その場も記録も keptOnly を持たず、呼び名は警告つきの済んだ回のまま', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    twin()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    const rec = getOps(dir).last?.result

    const live = toTeardownView('sakura-apprun', reply)
    const resumed = resumedTeardownView('sakura-apprun', rec)
    expect(resumed).toEqual(live)
    expect('keptOnly' in live).toBe(false)
    expect((rec!.extra as Record<string, unknown>).keptOnly).toBeUndefined()
    expect(resultCallOf('sakura-apprun', rec)).toBe('doneWithWarnings')
  })
})

describe('★★★ 専有型 apprunDedicated:teardown: keptOnly を付ける回・付けない回（T-2a）', () => {
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
  const AUTH = { token: 'tok', secret: 'sec' }
  /** 保存場所だけが残った印の押し直し（資源の ID は記録に無い）。 */
  const leftoverOnly = (buckets: string[]) => {
    setup(dir, { env: buckets, resources: [] })
    writeApprunDedicatedRecordFs(dir, { storageLeftoverBucket: buckets[0], storageLeftoverBuckets: buckets })
  }

  it('★★★ 保存場所だけが残った印の押し直し＋複製 → keptOnly:true。削除の要求は0件', async () => {
    leftoverOnly([S])
    twin()
    const reply = await dedicatedTeardown(EVENT, dir, AUTH, { confirmed: true })

    expect(reply.ok).toBe(true)
    expect(reply.keptOnly).toBe(true)
    expect(destructive()).toEqual([])
    expect(h.calls.filter((c: string) => c.startsWith('listAllKeys '))).toEqual([`listAllKeys ${S}`])
  })

  it('★★★ 確かめられない兄弟（unread）→ keptOnly:true', async () => {
    leftoverOnly([S])
    unreadSibling()
    const reply = await dedicatedTeardown(EVENT, dir, AUTH, { confirmed: true })

    expect(reply.ok).toBe(true)
    expect(reply.keptOnly).toBe(true)
    expect(destructive()).toEqual([])
  })

  it('★★★ 資源の ID がある回（クラスタを消した）は、保存場所が全部複製でも付けない', async () => {
    setup(dir, { env: [S], resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    twin()
    d.baseUrl = await listen()
    const reply = await dedicatedTeardown(EVENT, dir, AUTH, { confirmed: true })

    expect(reply.ok).toBe(true)
    expect(reply.executed.length, 'クラスタを消した行がある').toBeGreaterThan(0)
    expect(hasKeptOnly(reply)).toBe(false)
    expect(reply.keptBucketsUsedByOthers).toEqual([S])
    expect(destructive()).toEqual([])
  })

  it('★★★ 保存場所2件のうち1件だけ複製（もう1件は消した）→ 付けない', async () => {
    leftoverOnly([S, B])
    twin([S])
    const reply = await dedicatedTeardown(EVENT, dir, AUTH, { confirmed: true })

    expect(reply.ok).toBe(true)
    expect(hasKeptOnly(reply)).toBe(false)
    expect(h.calls).toContain(`deleteBucket ${B}`)
  })

  it('★★ 対照: 複製がいなければ、バケットごと消す。付けない', async () => {
    leftoverOnly([S])
    const reply = await dedicatedTeardown(EVENT, dir, AUTH, { confirmed: true })

    expect(reply.ok).toBe(true)
    expect(h.calls).toContain(`deleteBucket ${S}`)
    expect(hasKeptOnly(reply)).toBe(false)
  })

  it('★★★ ok:false（一覧できず止まった）→ 付けない', async () => {
    leftoverOnly([S])
    twin()
    h.fail[`listAllKeys ${S}`] = 'throw'
    const reply = await dedicatedTeardown(EVENT, dir, AUTH, { confirmed: true })

    expect(reply.ok).toBe(false)
    expect(hasKeptOnly(reply)).toBe(false)
    expect(destructive()).toEqual([])
  })

  it('★★★ ok:false（2件目で止まった。1件目は複製のため残した）→ 付けない', async () => {
    leftoverOnly([S, B])
    twin([S])
    h.fail[`listAllKeys ${B}`] = 'throw'
    const reply = await dedicatedTeardown(EVENT, dir, AUTH, { confirmed: true })

    expect(reply.ok).toBe(false)
    expect(reply.keptBucketNames).toEqual([S])
    expect(hasKeptOnly(reply)).toBe(false)
    expect(destructive()).toEqual([])
  })

  it('★★ その場の返り値と記録（開き直し）が同じ view。keptOnly:true・state は done・呼び名は doneKeptOnly', async () => {
    leftoverOnly([S])
    twin()
    const reply = await dedicatedTeardown(EVENT, dir, AUTH, { confirmed: true })
    const rec = getOps(dir).last?.result

    const live = toTeardownView('sakura-apprun-dedicated', reply)
    expect(resumedTeardownView('sakura-apprun-dedicated', rec)).toEqual(live)
    expect(live).toMatchObject({ ok: true, state: 'done', keptOnly: true })
    expect(resultCallOf('sakura-apprun-dedicated', rec)).toBe('doneKeptOnly')
  })
})

describe('★★★ HANAMII は keptOnly を付けない（見出しがプロジェクト削除の唯一の知らせ）', () => {
  const PROJECT_ID = 'hnm-proj-1'

  it('★★★ 保存場所が全部複製の回でも、返り値にも記録にも keptOnly が無い（プロジェクトは消えた）', async () => {
    setup(dir, { env: [S], resources: [] })
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId: PROJECT_ID } } }, null, 2), 'utf-8')
    globalThis.fetch = (async () => deleteProjectReply(200, PROJECT_ID)) as unknown as typeof fetch
    twin()
    const result = await hanamiiTeardown(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId: PROJECT_ID })

    expect(result.ok).toBe(true)
    expect(result.keptBucketsUsedByOthers, '保存場所は複製のため残した').toEqual([S])
    expect(destructive()).toEqual([])
    expect(hasKeptOnly(result)).toBe(false)
    const rec = getOps(dir).last?.result
    expect((rec!.extra as Record<string, unknown>).keptOnly).toBeUndefined()
    expect(resultCallOf('hanamii', rec)).toBe('doneWithWarnings')
  })

  it('★★ HANAMII の main のソースは keptOnly を参照しない（付けない判断を書き下して固定。hanamiiTeardownWiring.test.ts:52 は返り値の項目列を動かさない）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/ipc/hanamiiTeardown.ts'), 'utf-8')
    expect(src).not.toContain('keptOnly')
  })
})
