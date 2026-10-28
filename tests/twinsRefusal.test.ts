import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'

// ── T-I4・T-I5: 複製があれば、3つの公開先のどの破棄も、外へ1本も出さず・記録も消さずに断る（0.6.24 I-2・作者の決定 K1）────────────────────────
// 状況（2026-10-25 の調査 H1〜H4）: Finder で複製したフォルダは、元と同じ公開の記録を持つ。複製から 🗑 破棄を押すと、**元が公開している動いているアプリが消える**。
// ここは本物の main（3つの IPC と骨）に、偽の client・偽の保存場所・偽の兄弟フォルダを流し、**出た要求の一覧**で固定する（掟10。ソースの文字列は読まない）。
//   断る側（T-I4）: 同じ projectId → HANAMII の削除 0 件／同じ apprun-app の id → deleteApp 0 件／同じ clusterID → 専有型の要求 0 件。
//                   保存場所・鍵・レジストリへの要求も0件（`h.calls` が空）。記録（state.json・env.json・.sakuraide.json の公開の記録）は残る。文に兄弟の名前。
//   通す側（T-I5）: 識別子が違う／同じレジストリ名だけ／兄弟が読めない → 断らない（K1。読めない兄弟でデータが消えない守りは R1-b・tests/unreadSiblingTeardown.test.ts）。
//   申し送り（0.6.24 U1〜U5 の検分）: 複製が保存場所の設定を外して、記録の鍵の ID だけを写している形（保存場所0件・記録の鍵あり・同じアプリの ID）でも、
//   共用型の破棄は断る。`twinRiskOf` を通らない「保存場所0件の鍵の無効化」（`revokeRecordedKey`）が元の現役の鍵を切らない（deletePermission が0件）。
// 骨の順序・回数は tests/teardownShellTwins.test.ts、兄弟の読み方は tests/recordTwinsFs.test.ts。
import { A, APP, OK_AUTH, CONSENTED_AT, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, stateKinds, stateMeta, envBuckets, writePublishRecord, publishTargets } from './sharedTeardownHarness'
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
import { readApprunDedicatedFs, writeApprunDedicatedRecordFs, writePublishRecordFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { deleteProjectReply } from './hanamiiTeardownFixtures'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const hanamiiTeardown = shownTeardown(h.handlers.get('hanamii:teardown')!)
const dedicatedTeardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!)

const EVENT = { sender: { send: () => {} } }
const REC = 'perm-rec'
const ROW = { publishedAt: CONSENTED_AT, url: 'https://x.example/' }
const twinsMessage = (name: string) => `フォルダ『${name}』にも同じ公開の記録があるため、何も破棄していません。要らないほうのフォルダを削除すると、残ったほうから破棄できます。`

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

const readMeta = (p: string): any => JSON.parse(fs.readFileSync(path.join(p, '.sakuraide.json'), 'utf-8'))
/** 同じ親フォルダの兄弟のフォルダ（まだ無ければ作る）。 */
const sibDir = (name: string): string => { const p = path.join(workspaceOf(dir), name); fs.mkdirSync(p, { recursive: true }); return p }
const breakFile = (p: string, ...rel: string[]) => {
  fs.mkdirSync(path.dirname(path.join(p, ...rel)), { recursive: true })
  fs.writeFileSync(path.join(p, ...rel), '{ not json')
}

describe('★★★ 共用型の破棄 cloud:teardown: 同じ apprun-app の id を持つ複製があれば、何も破棄しない', () => {
  const GO = { confirmed: true, deleteRegistry: false, registryName: null }
  const OTHER_APP = { ...APP, id: 'app-other', key: 'apprun-app:other' }

  it('★★★ 同じ apprun-app の id の兄弟 → deleteApp 0件・保存場所・鍵・レジストリへの要求も0件。ok:false・文に兄弟の名前。記録は残る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { storagePermissionId: REC } })
    writePublishRecord(dir, { 'sakura-apprun': ROW })
    const original = sibDir('myapp original')
    setup(original, { env: [A], resources: [bucketRef(A), APP] })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply).toEqual({ ok: false, message: twinsMessage('myapp original') })
    expect(h.calls, '複製から破棄を押したのに、外へ要求が出た（元の動いているアプリが消える）').toEqual([])
    expect(stateKinds(dir)).toEqual(['bucket', 'apprun-app']) // 記録は変わらない
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
    expect(envBuckets(dir)).toEqual([A])
    expect(publishTargets(dir)).toEqual({ 'sakura-apprun': ROW }) // 📡 の行も残る（押し直せる・消すのは要らないほうのフォルダ）
  })

  it('★★★ 申し送り: 複製が保存場所の設定を外して記録の鍵の ID だけを写している（保存場所0件・記録の鍵あり・同じアプリの ID）→ 断る。deletePermission も listPermissions も0件', async () => {
    // 破棄するのは複製（保存場所0件・記録の鍵 REC・元と同じアプリの ID）。元は保存場所 A を持ち、同じ鍵 REC を使っている
    setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: REC } })
    const original = sibDir('myapp original')
    setup(original, { env: [A], resources: [bucketRef(A), APP], meta: { storagePermissionId: REC } })
    h.permissions = [{ id: REC, displayName: 'koto-myapp-apprun' }]
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply).toEqual({ ok: false, message: twinsMessage('myapp original') })
    expect(h.calls.filter(c => c.startsWith('deletePermission ') || c === 'listPermissions'), '元の現役の鍵が切れる').toEqual([])
    expect(h.calls).toEqual([])
    expect(stateMeta(dir)?.storagePermissionId, '記録の鍵の ID は残る').toBe(REC)
    expect(stateMeta(dir)?.keySweepPending, '断った回に一括の無効化の印を立てない').toBeUndefined()
  })

  it('対照（申し送りの形で複製でない）: 同じ形でも、兄弟のアプリの id が違い、兄弟の鍵も別の ID なら断らない。記録の鍵を無効にする（この試験が鍵の要求を見ていることの確認。兄弟が同じ鍵の ID を持つ回は無効にしない＝tests/permissionHeldByOthers.test.ts）', async () => {
    setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: REC } })
    setup(sibDir('myapp original'), { env: [A], resources: [bucketRef(A), OTHER_APP], meta: { storagePermissionId: 'perm-original' } })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(h.calls).toContain('deleteApp app-1')
    expect(h.calls).toContain(`deletePermission ${REC}`)
  })

  it('★★ T-I5 通す側: 別の apprun-app の id の兄弟 → 断らない（deleteApp が1件出る）', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    setup(sibDir('other-project'), { env: [A], resources: [bucketRef(A), OTHER_APP] })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.message ?? '').not.toContain('何も破棄していません')
    expect(h.calls.filter(c => c.startsWith('deleteApp '))).toEqual(['deleteApp app-1'])
  })

  it('★★ T-I5 通す側: 同じレジストリ名だけを持つ兄弟（借りるのは正しい使い方）→ 断らない', async () => {
    setup(dir, { env: [], resources: [APP], meta: { registryName: 'myreg', registryAdopted: true } })
    setup(sibDir('shares-registry'), { env: [], resources: [OTHER_APP], meta: { registryName: 'myreg', registryAdopted: true } })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(h.calls.filter(c => c.startsWith('deleteApp '))).toEqual(['deleteApp app-1'])
  })

  it('★★★ T-I5 通す側: 兄弟が読めない（壊れた state.json・たどれないリンク）→ 断らない（K1）。破棄は進む', async () => {
    setup(dir, { env: [], resources: [APP] })
    breakFile(sibDir('broken'), '.sakura-cloud', 'state.json')
    fs.symlinkSync(path.join(workspaceOf(dir), 'nowhere'), path.join(workspaceOf(dir), 'dead-link'))
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(reply.message ?? '').not.toContain('何も破棄していません')
    expect(h.calls.filter(c => c.startsWith('deleteApp '))).toEqual(['deleteApp app-1'])
  })

  it('対照: 複製がいなければ、これまでどおり deleteApp が出る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(h.calls).toContain('deleteApp app-1')
  })
})

describe('★★★ HANAMII の破棄 hanamii:teardown: 同じ projectId を持つ複製があれば、何も破棄しない', () => {
  const PROJECT_ID = 'hnm-proj-1'
  const hanamiiFetch: string[] = []
  const writeHanamii = (p: string, projectId: string) => {
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId }, targets: { hanamii: ROW } } }, null, 2), 'utf-8')
  }
  const run = (projectId: string = PROJECT_ID) => {
    hanamiiFetch.length = 0
    globalThis.fetch = (async (url: string, init?: { method?: string }) => {
      hanamiiFetch.push(`${init?.method ?? 'GET'} ${url}`)
      return deleteProjectReply(200, projectId)
    }) as unknown as typeof fetch
    return hanamiiTeardown(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId })
  }

  it('★★★ 同じ projectId の兄弟 → HANAMII への要求 0件（deleteProject 0）・保存場所への要求も0件。ok:false・文に兄弟の名前。projectId と公開の記録は残る', async () => {
    setup(dir, { env: [A], resources: [] })
    writeHanamii(dir, PROJECT_ID)
    writeHanamii(sibDir('myapp copy'), PROJECT_ID)
    const result = await run()

    expect(result).toEqual({ ok: false, message: twinsMessage('myapp copy') })
    expect(hanamiiFetch, '複製から破棄を押したのに、HANAMII へ削除の要求が出た（元の動いているプロジェクトが消える）').toEqual([])
    expect(h.calls, '保存場所へ要求が出た').toEqual([])
    expect(readMeta(dir).publish.hanamii.projectId).toBe(PROJECT_ID)
    expect(readMeta(dir).publish.targets.hanamii).toEqual(ROW)
    expect(envBuckets(dir)).toEqual([A])
  })

  it('★★ T-I5 通す側: 別の projectId の兄弟 → 断らない（HANAMII へ削除の要求が1件出る）', async () => {
    setup(dir, { env: [A], resources: [] })
    writeHanamii(dir, PROJECT_ID)
    writeHanamii(sibDir('other-project'), 'hnm-proj-2')
    const result = await run()

    expect(result.ok).toBe(true)
    expect(hanamiiFetch).toEqual([`DELETE https://hanamii.jp/api/v1/projects/${PROJECT_ID}`])
  })

  it('★★ T-I5 通す側: 同じレジストリ名だけ・同じ保存場所だけを持つ兄弟 → 断らない', async () => {
    setup(dir, { env: [A], resources: [], meta: { registryName: 'myreg', registryAdopted: true } })
    writeHanamii(dir, PROJECT_ID)
    setup(sibDir('shares-things'), { env: [A], resources: [], meta: { registryName: 'myreg', registryAdopted: true } })
    writeHanamii(sibDir('shares-things'), 'hnm-proj-2')
    const result = await run()

    expect(result.ok).toBe(true)
    expect(hanamiiFetch).toHaveLength(1)
  })

  it('★★★ T-I5 通す側: 兄弟の .sakuraide.json が壊れている → 断らない（K1）。HANAMII へ削除の要求が出る', async () => {
    setup(dir, { env: [A], resources: [] })
    writeHanamii(dir, PROJECT_ID)
    breakFile(sibDir('broken'), '.sakuraide.json')
    const result = await run()

    expect(result.ok).toBe(true)
    expect(hanamiiFetch).toEqual([`DELETE https://hanamii.jp/api/v1/projects/${PROJECT_ID}`])
  })
})

describe('★★★ 専有型の破棄 apprunDedicated:teardown: 同じクラスタ・ASG・LB・アプリケーションの ID を持つ複製があれば、何も破棄しない', () => {
  const requests: string[] = []
  function listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => {
          const key = `${req.method} ${req.url}`
          requests.push(key)
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
    requests.length = 0
    d.baseUrl = await listen()
    return dedicatedTeardown(EVENT, dir, { token: 'tok', secret: 'sec' }, { confirmed: true })
  }

  it('★★★ 同じ clusterID の兄弟 → さくらへの要求 0件（DELETE 0）・保存場所への要求も0件。ok:false・文に兄弟の名前。資源の ID と公開の記録は残る', async () => {
    setup(dir, { env: [A], resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    writePublishRecordFs(dir, 'sakura-apprun-dedicated', ROW)
    writeApprunDedicatedRecordFs(sibDir('myapp copy'), { clusterID: 'c1' })
    const result = await run()

    expect(result).toEqual({ ok: false, executed: [], message: twinsMessage('myapp copy'), remaining: {} })
    expect(requests, '複製から破棄を押したのに、さくらへ要求が出た（元の動いているクラスタが消える）').toEqual([])
    expect(h.calls, '保存場所へ要求が出た').toEqual([])
    expect(readApprunDedicatedFs(dir).clusterID).toBe('c1')
    expect(readMeta(dir).publish.targets['sakura-apprun-dedicated']).toEqual(ROW)
  })

  it.each(['applicationID', 'loadBalancerID', 'asgID'] as const)('★★ %s だけが同じ兄弟でも断る（要求は0件）', async field => {
    setup(dir, { env: [], resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', [field]: 'same-id' })
    writeApprunDedicatedRecordFs(sibDir('myapp copy'), { clusterID: 'c-other', [field]: 'same-id' })
    const result = await run()

    expect(result.ok).toBe(false)
    expect(result.message).toBe(twinsMessage('myapp copy'))
    expect(requests).toEqual([])
  })

  it('★★ T-I5 通す側: 別の clusterID の兄弟 → 断らない（DELETE /clusters/c1 が出る）', async () => {
    setup(dir, { env: [A], resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    writeApprunDedicatedRecordFs(sibDir('other-project'), { clusterID: 'c2' })
    const result = await run()

    expect(result.ok).toBe(true)
    expect(requests).toContain('DELETE /clusters/c1')
  })

  it('★★★ T-I5 通す側: 兄弟の .sakuraide.json が壊れている・たどれないリンクがある → 断らない（K1）', async () => {
    setup(dir, { env: [], resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    breakFile(sibDir('broken'), '.sakuraide.json')
    fs.symlinkSync(path.join(workspaceOf(dir), 'nowhere'), path.join(workspaceOf(dir), 'dead-link'))
    const result = await run()

    expect(result.ok).toBe(true)
    expect(requests).toContain('DELETE /clusters/c1')
  })
})
