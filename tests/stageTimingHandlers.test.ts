import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 専有型 3 本のハンドラを**実際に呼んで**、段の時間が「その場の結果」「記録」「保存」「目安」に届くことを確かめる ────
// （2026-10-07・どこにどれくらい時間がかかったか）
//   apprunDedicated:create（作成）・teardown（全部削除。手順6も 📡 の 🗑 もこれ）・publishApp（公開）
// ソースの文字列は読まない（掟10）。さくらの API は偽の fetch、イメージのビルド（prepareAppImage）は偽物。
// 保存先は使い捨ての一時フォルダ（利用者の保存領域＝userData には触らない。electron の app.getPath は呼んだら落ちる）。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** 外部へ出た要求（`METHOD /path`）。 */
  calls: [] as string[],
  /** 偽の API の応答表。キーは `METHOD /path?query`。配列なら n 回目に n 番目（最後は繰り返す）。 */
  routes: {} as Record<string, { status: number; body?: unknown } | Array<{ status: number; body?: unknown }>>,
  seen: new Map<string, number>(),
  imageFailure: null as null | string,
  /** 公開の応答の確認（probeMarker）が返すもの。既定は、目印が合っている＝応答の確認が成功（ok）。 */
  probe: { reached: true, status: 200, body: 'test-tag' } as { reached: boolean; status: number; body: string },
  /** 保存場所まわり（既定は本物。差し替えたときだけ偽物を返す）。 */
  issueStorage: null as null | Record<string, unknown>,
  cleanupKeysThrows: false,
  cleanupKeysFailed: 0,
  cleanupKeysCalls: 0,
  teardownStorage: null as null | Record<string, unknown>,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: {
    getPath: () => { throw new Error('利用者の保存領域（userData）を読もうとした') },
    getAppPath: () => process.cwd(), getVersion: () => '9.9.9-test', on: () => {},
  },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/imagePublish', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    prepareAppImage: async () => {
      if (h.imageFailure) return { ok: false, message: h.imageFailure }
      return {
        ok: true, tag: 'test-tag', image: 'koto-test', ref: 'registry.example/koto-test:test-tag', runtimeKind: 'static',
        registryAuth: { server: 'registry.example', username: 'u', password: 'p' },
      }
    },
  }
})

// 保存場所まわり（鍵の発行・古い鍵の片づけ・破棄での片づけ）だけ、テストが差し替えられるようにする（既定は本物）。
vi.mock('../src/main/cloud/storageForTarget', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    issueStorageEnvFor: (...a: any[]) => (h.issueStorage ? Promise.resolve(h.issueStorage) : real.issueStorageEnvFor(...a)),
    cleanUpOldKeysFor: async () => { h.cleanupKeysCalls++; if (h.cleanupKeysThrows) throw new Error('鍵の片づけに失敗（テスト）'); return { deleted: 0, failed: h.cleanupKeysFailed } },
    teardownStorageForProject: (...a: any[]) => (h.teardownStorage ? Promise.resolve(h.teardownStorage) : real.teardownStorageForProject(...a)),
  }
})

// 公開の確認（応答する・待たない）だけ差し替える。**onStage・progress は handler が渡したものをそのまま通す**（配線を見たいので）。
vi.mock('../src/main/cloud/apprunDedicatedAppApply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    publishAppFlow: (auth: any, dir: string, input: any, opts: any, baseUrl?: string) =>
      real.publishAppFlow(auth, dir, input, {
        ...opts, sleep: async () => {}, intervalMs: 1, timeoutMs: 2,
        probeMarker: async () => h.probe,
      }, baseUrl),
  }
})

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { registerProjectOpsHandlers } from '../src/main/ipc/projectOps'
import { registerStageTimingHandlers } from '../src/main/ipc/stageTiming'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { isolatedProjectDir } from './isolatedProject'
import { initStageTimingStore, stageTimingFilePath, loadStageTimings } from '../src/main/stageTimingStore'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { defaultSpec } from '../src/main/cloud/spec'
import { estimateText, readEstimate } from '../src/shared/stageEstimate'
import { resumedPublishResult, resumedCreateResult } from '../src/renderer/apprunDedicatedActions'
import { resumedTeardownView } from '../src/shared/teardownResult'

registerApprunDedicatedHandlers({} as any)
registerProjectOpsHandlers({ getMainWindow: () => null } as any)

const AUTH = { token: 'dedicated-token-AAAA1111', secret: 'dedicated-secret-BBBB2222' }
const BASE = 'https://secure.sakura.ad.jp/cloud/api/apprun-dedicated/1.0'
const handler = (channel: string) => h.handlers.get(channel)!
const getOps = (dir: string): Promise<{ running: any; last: any; earlier: any[] }> => handler('projectOps:get')({}, dir)

let dir = ''
let store = ''
let realFetch: typeof globalThis.fetch
let sent: string[] = []
const EVENT = { sender: { send: (_c: string, m: string) => { sent.push(m) } } }

function newProject(): string {
  const d = isolatedProjectDir('koto-stagehandlers-') // 自分だけの親フォルダの中（複製の確かめが、ほかの試験の残りを兄弟として読まない。0.6.24 I-2）
  fs.mkdirSync(path.join(d, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(d, '.sakura-cloud', 'env.json'), JSON.stringify(defaultSpec({ name: 'myapp', hasDockerfile: false }), null, 2), 'utf-8')
  fs.writeFileSync(path.join(d, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  return d
}

beforeEach(() => {
  h.calls = []; h.routes = {}; h.seen = new Map(); h.imageFailure = null; sent = []
  h.probe = { reached: true, status: 200, body: 'test-tag' }
  h.issueStorage = null; h.cleanupKeysThrows = false; h.cleanupKeysFailed = 0; h.cleanupKeysCalls = 0; h.teardownStorage = null
  dir = newProject()
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-stagestore-'))
  initStageTimingStore(store)
  resetProjectOpsForTests() // 保存の口・押し出しの受け手も外れるので、つなぎ直す
  registerProjectOpsHandlers({ getMainWindow: () => null } as any)
  registerStageTimingHandlers()
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url.startsWith(BASE) ? url.slice(BASE.length) : url}`
    h.calls.push(key)
    const entry = h.routes[key]
    const n = h.seen.get(key) ?? 0
    h.seen.set(key, n + 1)
    const route = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry
    const status = route?.status ?? 404
    return { ok: status < 300, status, async text() { return status === 204 ? '' : JSON.stringify(route?.body ?? { error: `未定義のルート ${key}` }) } }
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  initStageTimingStore(null)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(store, { recursive: true, force: true })
})

const TEARDOWN_ROUTES = {
  'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
  'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
  'DELETE /applications/app1': { status: 204 },
  'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [] } },
  'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204 },
  'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
  'DELETE /clusters/c1/asg/a1': { status: 204 },
  'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
  'DELETE /clusters/c1': { status: 204 },
  'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
}
const saved = () => JSON.parse(fs.readFileSync(stageTimingFilePath(), 'utf-8')) as { v: number; stages: Record<string, Array<{ ms: number; at: string; version: string; zone: string | null }>> }

describe('★★ 手順6（apprunDedicated:teardown）: その場の結果・記録・保存・目安がつながる', () => {
  it('その場の返り値に段ごとの時間が載り、記録の extra.stageTimings と同じ値。うまくいったので保存され、目安が切り替わる', async () => {
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1', zone: 'tk1b' })
    h.routes = TEARDOWN_ROUTES
    const r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok).toBe(true)
    // その場の結果
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toEqual(['teardown.app', 'teardown.lb', 'teardown.asg', 'teardown.cluster'])
    for (const s of r.stageTimings.stages) expect(s.ms).toBeGreaterThanOrEqual(0)
    expect(r.stageTimings.totalMs).toBeGreaterThanOrEqual(0)
    // 開き直したときの記録（同じ値）。記録から読み戻した結果も同じ形（双子）
    const rec = (await getOps(dir)).last
    expect(rec.result.extra.stageTimings).toEqual(r.stageTimings)
    expect(resumedTeardownView('sakura-apprun-dedicated', rec.result).stageTimings).toEqual(r.stageTimings)
    // 保存: 終わった段だけ・{ ms, at, version, zone }・Koto の版とゾーン（記録の zone は、消える前に読んでいる）
    const file = saved()
    expect(Object.keys(file.stages).sort()).toEqual(['teardown.app', 'teardown.asg', 'teardown.cluster', 'teardown.lb'])
    const one = file.stages['teardown.lb'][0]
    expect(Object.keys(one).sort()).toEqual(['at', 'ms', 'version', 'zone'])
    expect(one.version).toBe('9.9.9-test')
    expect(one.zone).toBe('tk1b')
    expect(JSON.stringify(file)).not.toContain(dir)
    // 目安: LB の削除は、この Mac で測れたので開発時の実測（約9分）ではなく、この Mac の記録になる
    const est = await handler('stageTiming:estimates')()
    expect(readEstimate(est['teardown.lb'])).toEqual({ kind: 'local', ms: one.ms, count: 1 })
    expect(estimateText(readEstimate(est['teardown.lb'])!)).toContain('この Mac での前回の実測')
  })

  it('★ 画面に出す文は今までどおり（renderer へ送るのは文だけ。段の内部名は混ざらない）', async () => {
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    h.routes = TEARDOWN_ROUTES
    await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(sent).toEqual(['ロードバランサの削除を待っています…']) // LB の待ち始めの一文だけ（目安は文に入れない）
    for (const m of sent) expect(m).not.toMatch(/teardown\.|stage/)
  })

  it('★★ 失敗した削除（残った）は保存しない。時間は結果と記録には載る（かかった時間を見る）', async () => {
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    h.routes = { ...TEARDOWN_ROUTES, 'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 500, body: { status: 500, title: 'x' } } }
    const r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok).toBe(false)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toEqual(['teardown.lb'])
    expect(fs.existsSync(stageTimingFilePath()), '失敗した回が保存された').toBe(false)
    expect((await getOps(dir)).last.result.extra.stageTimings).toEqual(r.stageTimings)
  })

  it('確認ダイアログを通っていない（confirmed なし）は、段を作らない・時間を出さない・保存しない', async () => {
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    const r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, {})
    expect(r.ok).toBe(false)
    expect(r.stageTimings).toBeUndefined()
    expect(fs.existsSync(stageTimingFilePath())).toBe(false)
  })
})

describe('★★ 📡 一覧の「🗑 破棄」も手順6と同じ apprunDedicated:teardown（2026-10-08）: アプリ → LB → ASG → クラスタの4段。アプリだけの口は無い', () => {
  it('アプリだけを消す口（apprunDedicated:teardownApp）は登録されていない', () => {
    expect(h.handlers.has('apprunDedicated:teardownApp')).toBe(false)
  })

  it('アプリの段（teardown.app）は他の3段と同じ記録に積まれ、ゾーンも残る', async () => {
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1', zone: 'is1a' })
    h.routes = TEARDOWN_ROUTES
    const r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toEqual(['teardown.app', 'teardown.lb', 'teardown.asg', 'teardown.cluster'])
    expect(Object.keys(saved().stages).sort()).toEqual(['teardown.app', 'teardown.asg', 'teardown.cluster', 'teardown.lb'])
    expect(saved().stages['teardown.app'][0].zone).toBe('is1a')
  })
})

describe('★★ 手順5（apprunDedicated:create）: 作る資源ごと。ゾーンは入力（spec）から', () => {
  const SPEC = {
    name: 'myapp', ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }], servicePrincipalID: '111111111111',
    zone: 'tk1b', workerServiceClassPath: 'w', lbServiceClassPath: 'l', minNodes: 1, maxNodes: 1,
  }
  const CREATE_ROUTES = {
    'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
    'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
    'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
    'POST /clusters/cluster-x/asg': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
    'GET /clusters/cluster-x/asg/asg-y': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
    'POST /clusters/cluster-x/asg/asg-y/load_balancers': { status: 200, body: { loadBalancer: { loadBalancerID: 'lb-z' } } },
    'GET /clusters/cluster-x/asg/asg-y/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [{ loadBalancerID: 'lb-z', name: 'myapp' }] } },
  }

  it('3段（クラスタ → ASG → LB）の時間が返り値・記録に載り、保存される（ゾーンは spec.zone）', async () => {
    writeApprunDedicatedRecordFs(dir, { consentedAt: '2026-09-01T00:00:00.000Z' })
    h.routes = CREATE_ROUTES
    const r = await handler('apprunDedicated:create')(EVENT, dir, AUTH, SPEC, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toEqual(['create.cluster', 'create.asg', 'create.lb'])
    expect(resumedCreateResult((await getOps(dir)).last).stageTimings).toEqual(r.stageTimings)
    const file = saved()
    expect(Object.keys(file.stages).sort()).toEqual(['create.asg', 'create.cluster', 'create.lb'])
    expect(file.stages['create.cluster'][0].zone).toBe('tk1b')
  })

  it('同意が無くて断られた回は、段を作らず・保存しない', async () => {
    h.routes = CREATE_ROUTES
    const r = await handler('apprunDedicated:create')(EVENT, dir, AUTH, SPEC, { confirmed: true })
    expect(r.ok).toBe(false)
    expect(r.stageTimings).toBeUndefined()
    expect(fs.existsSync(stageTimingFilePath())).toBe(false)
  })
})

describe('★★ 手順8（apprunDedicated:publishApp）: 準備 → イメージ → … → 応答の確認', () => {
  const APP_INPUT = { host: 'app.example.test', cpu: 100, memory: 128, fixedScale: 1 }
  const PUBLISH_ROUTES = {
    'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: true, ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }] } } },
    'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
    'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
    'POST /applications/app-1/versions': { status: 200, body: { applicationVersion: { version: 1 } } },
    'GET /applications/app-1': { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp', clusterID: 'cluster-x', activeVersion: 1 } } },
    'GET /applications/app-1/versions?maxItems=20': { status: 200, body: { versions: [{ version: 1, image: 'x', activeNodeCount: 1, created: 1 }] } },
    'GET /clusters/cluster-x/asg/asg-y/load_balancers/lb-z/load_balancer_nodes?maxItems=20': { status: 200, body: { loadBalancerNodes: [{ loadBalancerNodeID: 'n', status: 'healthy', interfaces: [{ interfaceIndex: 0, addresses: [{ address: '59.106.222.212/24', vip: false }] }] }] } },
  }
  const record = () => writeApprunDedicatedRecordFs(dir, { clusterID: 'cluster-x', asgID: 'asg-y', loadBalancerID: 'lb-z', zone: 'tk1b' })

  it('★ 準備 → イメージ → 確認 → アプリ → 古いバージョンの削除 → IP 待ち → 応答の確認。記録・保存・双子も同じ', async () => {
    record()
    // IP は待ってから付く形（最初から付いていた回は IP 待ちを保存しない・下の別のテスト）
    h.routes = { ...PUBLISH_ROUTES, [LB_KEY]: [{ status: 200, body: { loadBalancerNodes: [] } }, PUBLISH_ROUTES[LB_KEY]] }
    const r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toEqual([
      'publish.prepare', 'publish.image', 'publish.check', 'publish.app', 'publish.cleanup', 'publish.lb-address', 'publish.verify',
    ])
    const rec = (await getOps(dir)).last
    expect(rec.result.extra.stageTimings).toEqual(r.stageTimings)
    expect(resumedPublishResult(rec).stageTimings).toEqual(r.stageTimings)
    expect(Object.keys(saved().stages).sort()).toEqual(r.stageTimings.stages.map((s: any) => s.stage).sort())
    expect(saved().stages['publish.verify'][0].zone).toBe('tk1b')
  })

  it('★★ 画面に出す文は今までどおり（先頭の文・最後の文・段ごとの文）。段の内部名は文に混ざらない', async () => {
    record()
    h.routes = PUBLISH_ROUTES
    await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(sent[0]).toBe('クラスタの記録を確認しています…')
    expect(sent[sent.length - 1]).toBe('完了しました')
    expect(sent).toContain('ロードバランサのアドレスを取得しています…')
    expect(sent).toContain('🩺 アプリが応答するか確かめています…')
    for (const m of sent) expect(m).not.toMatch(/publish\.|stage/)
  })

  it('★★ イメージの段で失敗した公開は保存しない。そこまでの時間（準備・イメージ）は結果に載る', async () => {
    record()
    h.routes = PUBLISH_ROUTES
    h.imageFailure = 'ビルドに失敗しました（テスト）'
    const r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('image')
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toEqual(['publish.prepare', 'publish.image'])
    expect(fs.existsSync(stageTimingFilePath())).toBe(false)
  })

  // ── ok:true でも「測れていない」段は保存しない（2026-10-07 検分の指摘）─────────────────────────────
  // 保存すると、この Mac の記録が開発時の実測を押しのけ、目安を誤らせる（IP が付かなかった回の 3 分が
  // 「ロードバランサの IP 待ちの目安」になる、など）。時間は結果の「かかった時間を見る」には出し続ける。
  const LB_KEY = 'GET /clusters/cluster-x/asg/asg-y/load_balancers/lb-z/load_balancer_nodes?maxItems=20'
  const HEALTHY = ['publish.app', 'publish.check', 'publish.cleanup', 'publish.image', 'publish.prepare']

  it('★★ A. IP が付かないまま待ち切った（ノードが空）: ok:true・警告つき。publish.lb-address は保存しない。ほかの段は保存する', async () => {
    record()
    h.routes = { ...PUBLISH_ROUTES, [LB_KEY]: { status: 200, body: { loadBalancerNodes: [] } } }
    const r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.warnings.join('\n')).toContain('見つかりませんでした')
    // 時間は結果と記録には載る（かかった時間を見る）
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toContain('publish.lb-address')
    expect((await getOps(dir)).last.result.extra.stageTimings).toEqual(r.stageTimings)
    // 保存には入らない（応答の確認はとばしたので段も無い）
    expect(Object.keys(saved().stages).sort()).toEqual(HEALTHY)
    // 目安は開発時の実測のまま（悪い1件が「約3分（前回の実測）」にしない）
    const est = await handler('stageTiming:estimates')()
    expect(readEstimate(est['publish.lb-address'])).toMatchObject({ kind: 'dev', note: '数分' })
  })

  it('★★ B. IP の取得が HTTP 500: ok:true・警告つき。publish.lb-address は保存しない', async () => {
    record()
    h.routes = { ...PUBLISH_ROUTES, [LB_KEY]: { status: 500, body: { title: 'x' } } }
    const r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(r.warnings.join('\n')).toContain('取得できませんでした')
    expect(Object.keys(saved().stages).sort()).toEqual(HEALTHY)
  })

  it('★★ 最初の問い合わせで IP が付いていた回（再公開など・待っていない）: 時間は結果に出すが、publish.lb-address は保存しない（2026-10-07 検分2巡目）', async () => {
    record()
    h.routes = PUBLISH_ROUTES
    const r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toContain('publish.lb-address')
    expect(Object.keys(saved().stages)).not.toContain('publish.lb-address')
    expect(Object.keys(saved().stages)).toContain('publish.verify')
  })

  it('★★ 途中で IP が付いた回（待ったあとに取れた）は測れている: publish.lb-address も保存する', async () => {
    record()
    const EMPTY = { status: 200, body: { loadBalancerNodes: [] } }
    h.routes = { ...PUBLISH_ROUTES, [LB_KEY]: [EMPTY, PUBLISH_ROUTES[LB_KEY]] }
    const r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(r.lbAddresses).toEqual(['59.106.222.212'])
    expect(Object.keys(saved().stages).sort()).toEqual([...HEALTHY, 'publish.lb-address', 'publish.verify'].sort())
  })

  it('★★ C. 応答していない（503）: ok:true のまま。publish.verify と publish.containers は保存しない。時間は結果に出る', async () => {
    record()
    h.probe = { reached: true, status: 503, body: 'no available server' }
    h.routes = { ...{ ...PUBLISH_ROUTES, [LB_KEY]: [{ status: 200, body: { loadBalancerNodes: [] } }, PUBLISH_ROUTES[LB_KEY]] }, 'GET /applications/app-1/containers': { status: 200, body: { nodes: [] } } }
    const r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.verify).toBe('no-backend')
    const shown = r.stageTimings.stages.map((s: any) => s.stage)
    expect(shown).toContain('publish.verify')
    expect(shown).toContain('publish.containers')
    expect(Object.keys(saved().stages).sort()).toEqual([...HEALTHY, 'publish.lb-address'].sort())
  })

  it('★ 404 などの失敗応答（error-status）・つながらない（unreachable）でも、publish.verify は保存しない', async () => {
    for (const probe of [{ reached: true, status: 404, body: 'x' }, { reached: false, status: 0, body: '' }]) {
      fs.rmSync(stageTimingFilePath(), { force: true })
      record()
      h.probe = probe
      h.seen.clear() // 回ごとに応答の順番を数え直す（2回目も「待ってから IP が付く」形にする）
      h.routes = { ...PUBLISH_ROUTES, [LB_KEY]: [{ status: 200, body: { loadBalancerNodes: [] } }, PUBLISH_ROUTES[LB_KEY]] }
      const r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
      expect(r.ok).toBe(true)
      expect(Object.keys(saved().stages), JSON.stringify(probe)).not.toContain('publish.verify')
      expect(Object.keys(saved().stages)).toContain('publish.lb-address') // IP は付いた（測れている）
    }
  })

  it('★ 古いバージョンの一覧が取れない（警告つきで続行）: publish.cleanup は保存しない', async () => {
    record()
    h.routes = { ...PUBLISH_ROUTES, 'GET /applications/app-1/versions?maxItems=20': { status: 500, body: { title: 'x' } } }
    const r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(Object.keys(saved().stages)).not.toContain('publish.cleanup')
    expect(Object.keys(saved().stages)).toContain('publish.app')
  })

  it('★★ 古いアクセスキーの片づけ: うまくいけば publish.key-cleanup を保存する。失敗した片づけ（公開は成立）は保存しない', async () => {
    const ISSUED = { ok: true, envs: [], permissionId: 'perm-1', bucket: 'b1', prefix: '', projectName: 'myapp' }
    // うまくいった片づけ
    record(); h.issueStorage = ISSUED; h.routes = PUBLISH_ROUTES
    let r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(h.cleanupKeysCalls).toBe(1)
    expect(Object.keys(saved().stages)).toContain('publish.key-cleanup')
    // 片づけが例外で失敗（公開は成立したまま）
    fs.rmSync(stageTimingFilePath(), { force: true })
    h.cleanupKeysThrows = true
    r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(h.cleanupKeysCalls).toBe(2)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toContain('publish.key-cleanup') // 時間は出る
    expect(Object.keys(saved().stages)).not.toContain('publish.key-cleanup')
    expect(Object.keys(saved().stages)).toContain('publish.verify')
    // 例外は出ないが、1件でも消せなかった（中で飲み込まれた）回も保存しない（2026-10-07 検分2巡目）
    fs.rmSync(stageTimingFilePath(), { force: true })
    h.cleanupKeysThrows = false
    h.cleanupKeysFailed = 1
    r = await handler('apprunDedicated:publishApp')(EVENT, dir, AUTH, APP_INPUT, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(h.cleanupKeysCalls).toBe(3)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toContain('publish.key-cleanup')
    expect(Object.keys(saved().stages)).not.toContain('publish.key-cleanup')
  })
})

// ── 削除（手順6）: 前回の続き・既に消えていた段は保存しない ─────────────────────────────────────────
describe('★★ 手順6（apprunDedicated:teardown）: ok:true でも測れていない段は保存しない（2026-10-07 検分の指摘）', () => {
  const lbRow = (deleting: boolean) => ({ status: 200, body: { loadBalancers: [{ loadBalancerID: 'l1', name: 'x', deleting, created: 1, serviceClassPath: 'x' }] } })
  const LB_DELETE = 'DELETE /clusters/c1/asg/a1/load_balancers/l1'
  const LB_LIST = 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20'

  it('★★ C. 前回の続き（LB の DELETE が 404・一覧に deleting:true・やがて消える）: ok:true。teardown.lb は保存しない。ASG・クラスタは保存する', async () => {
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', zone: 'tk1b' })
    h.routes = { ...TEARDOWN_ROUTES, [LB_DELETE]: { status: 404, body: { title: 'not found' } }, [LB_LIST]: [lbRow(true), { status: 200, body: { loadBalancers: [] } }] }
    const r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toEqual(['teardown.lb', 'teardown.asg', 'teardown.cluster']) // 時間は出る
    expect(Object.keys(saved().stages).sort()).toEqual(['teardown.asg', 'teardown.cluster'])
    // 目安は開発時の実測（約9分）のまま。残りの待ちだけの数秒が「前回の実測」にならない
    const est = await handler('stageTiming:estimates')()
    expect(readEstimate(est['teardown.lb'])).toMatchObject({ kind: 'dev', ms: 9 * 60_000, date: '2026-09-10' })
    expect(estimateText(readEstimate(est['teardown.lb'])!)).toBe('目安 約9分（開発時の実測・2026-09-10）')
  })

  it('★★ D. 既に消えていた（LB の DELETE が 404・一覧にも無い）: ok:true。teardown.lb（ほぼ 0 ミリ秒）は保存しない', async () => {
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    h.routes = { ...TEARDOWN_ROUTES, [LB_DELETE]: { status: 404, body: { title: 'not found' } }, [LB_LIST]: { status: 200, body: { loadBalancers: [] } } }
    const r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(r.executed.join('\n')).toContain('既に存在しませんでした')
    expect(Object.keys(saved().stages)).not.toContain('teardown.lb')
    expect(Object.keys(saved().stages).sort()).toEqual(['teardown.asg', 'teardown.cluster'])
    const est = await handler('stageTiming:estimates')()
    expect(readEstimate(est['teardown.lb'])).toMatchObject({ kind: 'dev' })
  })

  it('★ アプリが既に消えていた（DELETE が 404・一覧にも無い）: ok:true。teardown.app（ほぼ 0 ミリ秒）は保存しない。残りの段は保存する', async () => {
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', applicationID: 'app1' })
    h.routes = { ...TEARDOWN_ROUTES, 'DELETE /applications/app1': { status: 404, body: { title: 'not found' } } }
    const r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toEqual(['teardown.app', 'teardown.cluster'])
    expect(Object.keys(saved().stages)).not.toContain('teardown.app')
    expect(Object.keys(saved().stages)).toEqual(['teardown.cluster'])
  })

  it('★ 保存場所の片づけ: ふつうに片づけば teardown.storage を保存する。鍵の片づけで警告が出た回は保存しない（時間は出る）', async () => {
    // バケットを消した回は記録（env.json）からも外れるので、回のたびに保存場所を用意し直す。
    const useBucket = () => {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, '.sakura-cloud', 'env.json'), 'utf-8'))
      spec.persistence = { objectStorage: [{ bucket: 'myapp-data', consentedAt: '2026-09-01T00:00:00.000Z' }] }
      fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec), 'utf-8')
    }
    const done = (warnings: string[]) => ({ ok: true, reason: 'done', done: [{ bucket: 'myapp-data', deletedBucket: true, note: '空にして消しました' }], warnings })
    // ふつうに片づいた
    useBucket()
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    h.routes = TEARDOWN_ROUTES
    h.teardownStorage = done([])
    let r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toContain('teardown.storage')
    expect(Object.keys(saved().stages)).toContain('teardown.storage')
    // 警告つき（鍵を無効にできなかった等）
    fs.rmSync(stageTimingFilePath(), { force: true })
    useBucket()
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    h.teardownStorage = done(['鍵『k1』を無効にできませんでした'])
    r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.stageTimings.stages.map((s: any) => s.stage)).toContain('teardown.storage')
    expect(Object.keys(saved().stages)).not.toContain('teardown.storage')
    expect(Object.keys(saved().stages)).toContain('teardown.cluster')
  })
})

describe('保存の失敗・壊れた記録で、操作の結果は変わらない', () => {
  it('保存先に書けなくても（同名のフォルダがある）、操作は成功のまま。記録が壊れていても落ちない', async () => {
    fs.mkdirSync(stageTimingFilePath()) // ファイルの場所をフォルダで塞ぐ → 読めない・書けない
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    h.routes = TEARDOWN_ROUTES
    const r = await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(r.ok).toBe(true)
    expect(r.stageTimings.stages.length).toBeGreaterThan(0)
    const est = await handler('stageTiming:estimates')() // 読めなくても目安は出る（開発時の実測）
    expect(readEstimate(est['teardown.lb'])).toMatchObject({ kind: 'dev' })
  })

  it('壊れた JSON があっても、次の成功で上書きされて直り、目安はこの Mac の記録になる', async () => {
    fs.writeFileSync(stageTimingFilePath(), '{ 壊れている', 'utf-8')
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    h.routes = TEARDOWN_ROUTES
    await handler('apprunDedicated:teardown')(EVENT, dir, AUTH, { confirmed: true })
    expect(Object.keys(loadStageTimings().stages)).toContain('teardown.lb')
    expect(() => saved()).not.toThrow()
  })
})
