import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createClusterFlow, teardownFlow, type ApprunDedicatedClusterSpec } from '../src/main/cloud/apprunDedicatedApply'
import { publishAppFlow, type PublishAppInput } from '../src/main/cloud/apprunDedicatedAppApply'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { appStageOnly } from './dedicatedAppStage-harness'
import { STAGE, DEDICATED_STAGES } from '../src/shared/stageTiming'
import type { DedicatedProbe } from '../src/shared/publishVerify'

// ── 専有型 作成・公開・削除の「段の区切り」（2026-10-07・どこにどれくらい時間がかかったか）───────────────
//
// 各 flow は、段の切り替わりで `onStage(段の内部名)` を呼ぶ。**画面に出す文（progress）とは別の口**で、
// 文を直しても段の見分けが外れない。ここでは**本物の flow を偽サーバに向けて走らせ**、
//   ・どの段を・どの順で通るか（flow を通った順＝画面の並び DEDICATED_STAGES の部分列になること）
//   ・段の切り替わりが、その段の最初の文（progress）より**前**に来ること（文の途中で段が変わらない）
//   ・条件で通らない段（アプリがあれば作成は飛ぶ・応答の確認をとばすとき）は、0秒の段を作らないこと
// を確かめる。実際の時間の足し合わせは tests/stageTimingRecord.test.ts（projectOps）が固定する。

let server: Server | null = null
afterEach(() => { if (server) { server.close(); server = null } })
function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler)
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}/`)
      else reject(new Error('サーバのポートを取得できませんでした'))
    })
  })
}
type Route = { status: number; body: unknown }
function routed(routes: Record<string, Route | Route[]>): http.RequestListener {
  const seen = new Map<string, number>()
  return (req, res) => {
    const key = `${req.method} ${req.url}`
    req.on('data', () => {})
    req.on('end', () => {
      const entry = routes[key]
      const n = seen.get(key) ?? 0
      seen.set(key, n + 1)
      const route = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry
      const status = route?.status ?? 404
      if (status === 204) { res.writeHead(204); res.end(); return }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(route?.body ?? { error: `test router: 未定義のルート ${key}` }))
    })
  }
}

let projectDir = ''
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-stageflows-')) })
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })
const AUTH = { token: 'tok', secret: 'sec' }

/** 段と文を、起きた順に1本の配列へ積む（段の切り替わりが文の前に来ることを見るため）。 */
function trace() {
  const events: string[] = []
  /** 「この段の時間は保存しない」の印（`{ unmeasured: true }`）を受けた段（受けた順・重複あり）。 */
  const marks: string[] = []
  let current: string | null = null
  return {
    events, marks,
    // projectOps と同じ決まり: 同じ段のままなら切り替えない（印だけが付く）。
    onStage: (s: string, mark?: { unmeasured?: boolean }) => {
      if (mark?.unmeasured === true) marks.push(s)
      if (s !== current) { current = s; events.push(`S:${s}`) }
    },
    progress: (m: string) => { events.push(`P:${m}`) },
    /** 段の名前の並び。 */
    stages: () => events.filter(e => e.startsWith('S:')).map(e => e.slice(2)),
    /** 印を受けた段の名前（重複なし・並びは受けた順）。 */
    unmeasured: () => [...new Set(marks)],
  }
}

/** 通った段の並びが、画面の並び（定義表）の部分列か（順序を守っているか）。 */
function isSubsequenceOf(order: readonly string[], seq: readonly string[]): boolean {
  let i = 0
  for (const s of seq) { while (i < order.length && order[i] !== s) i++; if (i >= order.length) return false; i++ }
  return true
}

// ── 作成（手順5）────────────────────────────────────────────────────────────

const SPEC: ApprunDedicatedClusterSpec = {
  name: 'myapp',
  ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }],
  servicePrincipalID: '111111111111',
  zone: 'tk1b',
  workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
  minNodes: 1, maxNodes: 1,
  lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
}
const CREATE_ROUTES: Record<string, Route> = {
  'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
  'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
  'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
  'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
  'POST /clusters/cluster-x/asg': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
  'GET /clusters/cluster-x/asg/asg-y': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
  'POST /clusters/cluster-x/asg/asg-y/load_balancers': { status: 200, body: { loadBalancer: { loadBalancerID: 'lb-z' } } },
  'GET /clusters/cluster-x/asg/asg-y/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [{ loadBalancerID: 'lb-z', name: 'myapp' }] } },
}

describe('作成（手順5）の段: 作る資源ごと（クラスタ → ASG → LB）', () => {
  it('★ 全部通ると、作成の3段を定義表の順に1回ずつ通る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { consentedAt: '2026-09-01T00:00:00.000Z' })
    const t = trace()
    const baseUrl = await listen(routed(CREATE_ROUTES))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, { confirmed: true, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(t.stages()).toEqual([STAGE.createCluster, STAGE.createAsg, STAGE.createLb])
    expect(t.stages()).toEqual(DEDICATED_STAGES.create.map(s => s.id))
    expect(t.events.filter(e => e.startsWith('P:'))).toEqual([]) // 作成の flow は文を出さない（文は IPC の1つだけ・変えない）
  })

  it('★ 確認ダイアログを通っていない・同意が無い・入力が不正のときは、段を1つも作らない（時間を測らない）', async () => {
    const t = trace()
    const baseUrl = await listen(routed({}))
    expect((await createClusterFlow(AUTH, projectDir, SPEC, { confirmed: false, onStage: t.onStage }, baseUrl)).stage).toBe('consent')
    writeApprunDedicatedRecordFs(projectDir, { consentedAt: '2026-09-01T00:00:00.000Z' })
    expect((await createClusterFlow(AUTH, projectDir, { ...SPEC, name: '' }, { confirmed: true, onStage: t.onStage }, baseUrl)).stage).toBe('invalid')
    expect(t.events).toEqual([])
  })

  it('ASG の作成で止まったときは、そこまでの段（クラスタ → ASG）で終わる（LB の段は作らない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { consentedAt: '2026-09-01T00:00:00.000Z' })
    const t = trace()
    const baseUrl = await listen(routed({ ...CREATE_ROUTES, 'POST /clusters/cluster-x/asg': { status: 500, body: { title: 'x' } } }))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, { confirmed: true, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(false)
    expect(t.stages()).toEqual([STAGE.createCluster, STAGE.createAsg])
  })
})

// ── 削除（手順6・📡 アプリだけ削除）────────────────────────────────────────

function teardownRoutes(extra: Record<string, Route | Route[]> = {}): Record<string, Route | Route[]> {
  return {
    'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
    'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
    'DELETE /applications/app1': { status: 204, body: {} },
    'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [] } },
    'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204, body: {} },
    'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
    'DELETE /clusters/c1/asg/a1': { status: 204, body: {} },
    'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
    'DELETE /clusters/c1': { status: 204, body: {} },
    'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    ...extra,
  }
}

describe('削除（手順6）の段: アプリ → LB → ASG → クラスタ（各段の頭で切り替わる）', () => {
  it('★ 全部あれば、削除の4段を定義表の順に1回ずつ通る（保存場所の段は IPC が足す）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const t = trace()
    const baseUrl = await listen(routed(teardownRoutes()))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {}, progress: t.progress, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(t.stages()).toEqual([STAGE.teardownApp, STAGE.teardownLb, STAGE.teardownAsg, STAGE.teardownCluster])
    expect(isSubsequenceOf(DEDICATED_STAGES.teardown.map(s => s.id), t.stages())).toBe(true)
  })

  it('★ 記録に無い資源の段は通らない（アプリを公開していなければ「アプリケーションの削除」の段は無い）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const t = trace()
    const baseUrl = await listen(routed(teardownRoutes()))
    await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {}, onStage: t.onStage }, baseUrl)
    expect(t.stages()).toEqual([STAGE.teardownLb, STAGE.teardownAsg, STAGE.teardownCluster])
  })

  it('★ 📡 の 🗑 も手順6と同じ流れ: 旧い appOnly: true を渡されても、4段とも通る（アプリだけで止まらない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const t = trace()
    const baseUrl = await listen(routed(teardownRoutes()))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true, sleep: async () => {}, onStage: t.onStage } as any, baseUrl)
    expect(r.ok).toBe(true)
    expect(t.stages()).toEqual([STAGE.teardownApp, STAGE.teardownLb, STAGE.teardownAsg, STAGE.teardownCluster])
  })

  it('★★ 待ちの文の前に、その段へ切り替わっている（LB の待ち始めの文は teardown.lb の段のなかで出る）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const t = trace()
    // LB が一覧に1回だけ「削除中」で残っている（待ち始めの文が出る）
    const baseUrl = await listen(routed(teardownRoutes({
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': [
        { status: 200, body: { loadBalancers: [{ loadBalancerID: 'l1', name: 'x', deleting: true, created: 1, serviceClassPath: 'x' }] } },
        { status: 200, body: { loadBalancers: [] } },
      ],
    })))
    await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {}, progress: t.progress, onStage: t.onStage }, baseUrl)
    const at = t.events.indexOf('P:ロードバランサの削除を待っています…')
    expect(at).toBeGreaterThan(-1)
    expect(t.events[at - 1]).toBe(`S:${STAGE.teardownLb}`) // 直前が LB の段への切り替え
    // ASG の段はそのあと
    expect(t.events.indexOf(`S:${STAGE.teardownAsg}`)).toBeGreaterThan(at)
  })

  it('★★ ASG が409（LB がまだ残っている）で LB を待ち直すとき、待ちは LB の段に数え、終わったら ASG の段へ戻る（同じ段へ戻っても足し合わせる）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const t = trace()
    const baseUrl = await listen(routed({
      'DELETE /clusters/c1/asg/a1': [
        { status: 409, body: { status: 409, title: 'Cannot delete Auto Scaling Group because it has associated Load Balancers: l1' } },
        { status: 204, body: {} },
      ],
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': [
        { status: 200, body: { loadBalancers: [{ loadBalancerID: 'l1', name: 'x', deleting: true, created: 1, serviceClassPath: 'x' }] } },
        { status: 200, body: { loadBalancers: [] } },
      ],
      'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
      'DELETE /clusters/c1': { status: 204, body: {} },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {}, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    // ASG → （409 で残っていた LB を待つ）LB → ASG（再試行）→ クラスタ。同じ段が続けて並ぶことは無い。
    expect(t.stages()).toEqual([STAGE.teardownAsg, STAGE.teardownLb, STAGE.teardownAsg, STAGE.teardownCluster])
  })

  it('確認ダイアログを通っていないときは、段を1つも作らない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const t = trace()
    const baseUrl = await listen(routed({}))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: false, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(false)
    expect(t.events).toEqual([])
  })
})

// ── 公開（手順8）────────────────────────────────────────────────────────────

const APP_INPUT: PublishAppInput = {
  spec: { name: 'myapp2', host: 'app.example.com', port: 8080, cpu: 500, memory: 512, fixedScale: 1, env: [] },
  imageRef: 'jp1.sakuracr.jp/example/myapp2:v1',
  registry: { username: 'reg-user', password: 'reg-pass' },
}
const LB_NODES_ONE: Route = {
  status: 200,
  body: { loadBalancerNodes: [{ loadBalancerNodeID: 'lbn-1', resourceID: 'res-1', status: 'healthy', interfaces: [{ interfaceIndex: 0, addresses: [{ address: '59.106.222.212/24', vip: false }] }] }] },
}
const LB_NODES_EMPTY: Route = { status: 200, body: { loadBalancerNodes: [] } }
const LB_NODES_KEY = 'GET /clusters/cluster-x/asg/asg-y/load_balancers/lb-z/load_balancer_nodes?maxItems=20'
function publishRoutes(lbNodes: Route | Route[]): Record<string, Route | Route[]> {
  return {
    'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: true, ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }] } } },
    'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
    'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
    'POST /applications/app-1/versions': { status: 200, body: { applicationVersion: { version: 1 } } },
    'GET /applications/app-1': { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 1 } } },
    'GET /applications/app-1/versions?maxItems=20': { status: 200, body: { versions: [{ version: 1, image: 'x', activeNodeCount: 1, created: 1 }] } },
    [LB_NODES_KEY]: lbNodes,
  }
}
const respondingProbe = async (): Promise<DedicatedProbe> => ({ reached: true, status: 200, body: '' })
const noBackendProbe = async (): Promise<DedicatedProbe> => ({ reached: true, status: 503, body: 'no available server' })

describe('公開（手順8）の段: publishAppFlow が渡す区間（準備・イメージ・古いアクセスキーの段は IPC が足す）', () => {
  // 手順5で作った3つ（公開の前提）。この節だけに掛ける（作成・削除の節の記録を汚さない）。
  beforeEach(() => { writeApprunDedicatedRecordFs(projectDir, { clusterID: 'cluster-x', asgID: 'asg-y', loadBalancerID: 'lb-z' }) })

  it('★ 通ると 確認 → アプリ → 古いバージョンの削除 → IP 待ち → 応答の確認 の順に1回ずつ（定義表の部分列）', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes(LB_NODES_ONE)))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { confirmed: true, sleep: async () => {}, probeMarker: respondingProbe, progress: t.progress, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(t.stages()).toEqual([STAGE.publishCheck, STAGE.publishApp, STAGE.publishCleanup, STAGE.publishLbAddress, STAGE.publishVerify])
    expect(isSubsequenceOf(DEDICATED_STAGES.publish.map(s => s.id), t.stages())).toBe(true)
  })

  it('★★ 段の切り替わりは、その段の最初の文（画面に出す文）の直前。文は変えていない', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes(LB_NODES_ONE)))
    await publishAppFlow(AUTH, projectDir, APP_INPUT, { confirmed: true, sleep: async () => {}, probeMarker: respondingProbe, progress: t.progress, onStage: t.onStage }, baseUrl)
    const firstTextOf = (stage: string, text: string) => {
      const at = t.events.indexOf(`P:${text}`)
      expect(at, `${text} が出ていない`).toBeGreaterThan(-1)
      expect(t.events[at - 1], `${stage} の直前に切り替わっていない`).toBe(`S:${stage}`)
    }
    firstTextOf(STAGE.publishCheck, 'クラスタの記録を確認しています…')
    firstTextOf(STAGE.publishApp, 'アプリケーションを確認しています…')
    firstTextOf(STAGE.publishCleanup, '古いバージョンを削除しています…')
    firstTextOf(STAGE.publishLbAddress, 'ロードバランサのアドレスを取得しています…')
    firstTextOf(STAGE.publishVerify, '🩺 アプリが応答するか確かめています…')
    // 文は全部そろっていて、「完了しました」で終わる（段の追加で文が増減していない）
    const texts = t.events.filter(e => e.startsWith('P:')).map(e => e.slice(2))
    expect(texts[0]).toBe('クラスタの記録を確認しています…')
    expect(texts[texts.length - 1]).toBe('完了しました')
  })

  it('★ 応答していない（503）ときは、コンテナの状態の確認の段が増える', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes(LB_NODES_ONE)))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { confirmed: true, sleep: async () => {}, probeMarker: noBackendProbe, onStage: t.onStage }, baseUrl)
    expect(r.verify).toBe('no-backend')
    expect(t.stages()).toEqual([STAGE.publishCheck, STAGE.publishApp, STAGE.publishCleanup, STAGE.publishLbAddress, STAGE.publishVerify, STAGE.publishContainers])
  })

  it('★★ IP が付かず確認をとばしたときは、応答の確認の段を作らない（0秒の段が、この Mac の目安を引き下げない）', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes(LB_NODES_EMPTY)))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { confirmed: true, sleep: async () => {}, intervalMs: 1000, timeoutMs: 2000, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBeUndefined()
    expect(t.stages()).toEqual([STAGE.publishCheck, STAGE.publishApp, STAGE.publishCleanup, STAGE.publishLbAddress])
  })

  it('確認ダイアログを通っていない・クラスタの記録が無いときは、段を作らない／確認の段だけ', async () => {
    const t = trace()
    const baseUrl = await listen(routed({}))
    expect((await publishAppFlow(AUTH, projectDir, APP_INPUT, { confirmed: false, onStage: t.onStage }, baseUrl)).stage).toBe('consent')
    expect(t.events).toEqual([])
  })
})

// ── 「この段の時間は保存しない」の印（2026-10-07 検分の指摘）────────────────────────────────────
// `ok:true` は「時間を測れた」の証拠ではない。flow は、ふつうにかかる時間の測定になっていない段に
// `onStage(段, { unmeasured: true })` を付ける（保存しない・結果の「かかった時間を見る」には出る）。
// ここは**印が付く／付かない**を flow 単位で固定する（保存まで届くかは stageTimingHandlers.test.ts）。

describe('★★ 公開（手順8）: ok:true でも測れていない段に印が付く。ふつうに終わった回には付かない', () => {
  beforeEach(() => { writeApprunDedicatedRecordFs(projectDir, { clusterID: 'cluster-x', asgID: 'asg-y', loadBalancerID: 'lb-z' }) })
  const fast = { confirmed: true as const, sleep: async () => {}, intervalMs: 1000, timeoutMs: 2000 }

  it('★ ふつうに終わった回（待ってから IP が付く・応答が確かめられる）には、印は1つも付かない', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes([LB_NODES_EMPTY, LB_NODES_ONE])))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { ...fast, probeMarker: respondingProbe, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe('responding')
    expect(t.unmeasured()).toEqual([])
  })

  it('★★ 最初の問い合わせで IP が付いていた（再公開など・待っていない）→ lb-address に印（2026-10-07 検分2巡目）', async () => {
    // 数ミリ秒の値を保存すると、中央値が「IP が付くまでの待ち」ではなくなり、目安が数秒に縮む
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes(LB_NODES_ONE)))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { ...fast, probeMarker: respondingProbe, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe('responding')
    expect(t.unmeasured()).toEqual([STAGE.publishLbAddress])
  })

  it('★★ IP が付かないまま待ち切った（3分の上限）→ lb-address に印。ok:true のまま', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes(LB_NODES_EMPTY)))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { ...fast, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.warnings?.join('\n')).toContain('見つかりませんでした')
    expect(t.unmeasured()).toEqual([STAGE.publishLbAddress])
  })

  it('★★ IP の取得が HTTP エラー → lb-address に印。ok:true のまま', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes({ status: 500, body: { title: 'x' } })))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { ...fast, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.warnings?.join('\n')).toContain('取得できませんでした')
    expect(t.unmeasured()).toEqual([STAGE.publishLbAddress])
  })

  it('★★ 途中で IP が付いた（待ったあとに取れた）回は測れている＝印は付かない', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes([LB_NODES_EMPTY, LB_NODES_EMPTY, LB_NODES_ONE])))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { ...fast, probeMarker: respondingProbe, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.lbAddresses).toEqual(['59.106.222.212'])
    expect(t.unmeasured()).toEqual([])
  })

  it('★★ 応答していない（503）→ publish.verify と publish.containers に印', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes([LB_NODES_EMPTY, LB_NODES_ONE])))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { ...fast, probeMarker: noBackendProbe, onStage: t.onStage }, baseUrl)
    expect(r.verify).toBe('no-backend')
    expect(t.unmeasured()).toEqual([STAGE.publishVerify, STAGE.publishContainers])
  })

  it.each([
    ['404 などの失敗応答（error-status）', async (): Promise<DedicatedProbe> => ({ reached: true, status: 404, body: 'x' }), 'error-status'],
    ['つながらない（unreachable）', async (): Promise<DedicatedProbe> => ({ reached: false, status: 0, body: '' }), 'unreachable'],
  ] as const)('★ 応答の確認が確かめられなかった: %s → publish.verify に印（コンテナの確認の段は作らない）', async (_n, probe, outcome) => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes([LB_NODES_EMPTY, LB_NODES_ONE])))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { ...fast, probeMarker: probe, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe(outcome)
    expect(t.unmeasured()).toEqual([STAGE.publishVerify])
    expect(t.stages()).not.toContain(STAGE.publishContainers)
  })

  it('★ 確認の途中で例外（probe が投げる）→ 確かめられなかったので publish.verify に印', async () => {
    const t = trace()
    const baseUrl = await listen(routed(publishRoutes([LB_NODES_EMPTY, LB_NODES_ONE])))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { ...fast, probeMarker: async () => { throw new Error('boom') }, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe('unreachable')
    expect(t.unmeasured()).toEqual([STAGE.publishVerify])
  })

  it('★ 古いバージョンの一覧が取れない（警告つきで続行）→ publish.cleanup に印', async () => {
    const t = trace()
    const baseUrl = await listen(routed({ ...publishRoutes([LB_NODES_EMPTY, LB_NODES_ONE]), 'GET /applications/app-1/versions?maxItems=20': { status: 500, body: { title: 'x' } } }))
    const r = await publishAppFlow(AUTH, projectDir, APP_INPUT, { ...fast, probeMarker: respondingProbe, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.warnings?.join('\n')).toContain('古いバージョンの一覧を取得できませんでした')
    expect(t.unmeasured()).toEqual([STAGE.publishCleanup])
  })
})

describe('★★ 削除（手順6）: 前回の続き・既に消えていた・時間切れで進んだ段に印が付く。ふつうに消えた回には付かない', () => {
  const lbRow = (deleting: boolean) => ({ status: 200, body: { loadBalancers: [{ loadBalancerID: 'l1', name: 'x', deleting, created: 1, serviceClassPath: 'x' }] } })
  const lbGone: Route = { status: 200, body: { loadBalancers: [] } }
  const run = async (record: Parameters<typeof writeApprunDedicatedRecordFs>[1], extra: Record<string, Route | Route[]>) => {
    writeApprunDedicatedRecordFs(projectDir, record)
    const t = trace()
    const baseUrl = await listen(routed(teardownRoutes(extra)))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {}, onStage: t.onStage }, baseUrl)
    return { r, t }
  }
  const ALL = { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' }

  it('★ ふつうに（204 → 一覧から消えるまで待つ）消えた回には、印は1つも付かない', async () => {
    const { r, t } = await run(ALL, {})
    expect(r.ok).toBe(true)
    expect(t.stages()).toEqual([STAGE.teardownApp, STAGE.teardownLb, STAGE.teardownAsg, STAGE.teardownCluster])
    expect(t.unmeasured()).toEqual([])
  })

  it('★★ LB: 前回の続き（DELETE が 404・一覧に deleting:true で残っている）→ teardown.lb に印。ほかの段には付かない', async () => {
    const { r, t } = await run(ALL, {
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 404, body: { title: 'not found' } },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': [lbRow(true), lbGone],
    })
    expect(r.ok).toBe(true)
    expect(t.unmeasured()).toEqual([STAGE.teardownLb])
  })

  it('★★ LB: 既に消えていた（DELETE が 404・一覧にも無い）→ teardown.lb に印', async () => {
    const { r, t } = await run(ALL, {
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 404, body: { title: 'not found' } },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': lbGone,
    })
    expect(r.ok).toBe(true)
    expect(r.executed.join('\n')).toContain('既に存在しませんでした')
    expect(t.unmeasured()).toEqual([STAGE.teardownLb])
  })

  it('★★ ASG: 前回の続き（404・deleting:true）と、既に消えていた（404・一覧に無い）→ どちらも teardown.asg に印', async () => {
    const asgRow = (deleting: boolean) => ({ status: 200, body: { autoScalingGroups: [{ autoScalingGroupID: 'a1', name: 'x', deleting }] } })
    const gone: Route = { status: 200, body: { autoScalingGroups: [] } }
    const resumed = await run({ clusterID: 'c1', asgID: 'a1' }, {
      'DELETE /clusters/c1/asg/a1': { status: 404, body: { title: 'not found' } },
      'GET /clusters/c1/asg?maxItems=20': [asgRow(true), gone],
    })
    expect(resumed.r.ok).toBe(true)
    expect(resumed.t.unmeasured()).toEqual([STAGE.teardownAsg])
    const absent = await run({ clusterID: 'c1', asgID: 'a1' }, {
      'DELETE /clusters/c1/asg/a1': { status: 404, body: { title: 'not found' } },
      'GET /clusters/c1/asg?maxItems=20': gone,
    })
    expect(absent.r.ok).toBe(true)
    expect(absent.t.unmeasured()).toEqual([STAGE.teardownAsg])
  })

  it('★★ クラスタ: 既に消えていた（404・一覧に無い）→ teardown.cluster に印', async () => {
    const { r, t } = await run({ clusterID: 'c1' }, { 'DELETE /clusters/c1': { status: 404, body: { title: 'not found' } } })
    expect(r.ok).toBe(true)
    expect(t.unmeasured()).toEqual([STAGE.teardownCluster])
  })

  it('★★ アプリ: 既に消えていた（404・一覧に無い）→ teardown.app に印', async () => {
    const { r, t } = await run({ clusterID: 'c1', applicationID: 'app1' }, {
      'DELETE /applications/app1': { status: 404, body: { title: 'not found' } },
      'DELETE /clusters/c1': { status: 204, body: {} },
    })
    expect(r.ok).toBe(true)
    expect(t.unmeasured()).toEqual([STAGE.teardownApp])
  })

  it('★★ 409 の回復（ASG を消そうとしたら、削除中の LB が残っていた）→ 待ち直した LB（残りの待ち）に印。ASG には付かない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const t = trace()
    const baseUrl = await listen(routed(teardownRoutes({
      'DELETE /clusters/c1/asg/a1': [
        { status: 409, body: { status: 409, title: 'Cannot delete Auto Scaling Group because it has associated Load Balancers: l1' } },
        { status: 204, body: {} },
      ],
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': [lbRow(true), lbGone],
    })))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {}, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(t.unmeasured()).toEqual([STAGE.teardownLb])
  })

  it('★ 409 の回復（クラスタを消そうとしたら、削除中の ASG が残っていた）→ 待ち直した ASG に印。クラスタには付かない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const t = trace()
    const baseUrl = await listen(routed(teardownRoutes({
      'DELETE /clusters/c1': [
        { status: 409, body: { status: 409, title: 'Cannot delete Cluster because it has Auto Scaling Group: a1' } },
        { status: 204, body: {} },
      ],
      'GET /clusters/c1/asg?maxItems=20': [
        { status: 200, body: { autoScalingGroups: [{ autoScalingGroupID: 'a1', name: 'x', deleting: true }] } },
        { status: 200, body: { autoScalingGroups: [] } },
      ],
    })))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {}, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(t.unmeasured()).toEqual([STAGE.teardownAsg])
  })

  it('★ アプリ: コンテナが止まるのを待ち切れず時間切れでそのまま進んだ → teardown.app に印', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const t = trace()
    const baseUrl = await listen(routed(teardownRoutes({
      // 原本の形（containersStats は { collectedAtSec, containers } のオブジェクト）で、動いているコンテナが1件
      'GET /applications/app1/containers': { status: 200, body: { nodes: [{
        nodeID: 'n1', desired: null,
        containersStats: { collectedAtSec: 1721203200, containers: [{ id: 'c', image: 'x', state: 'running', status: 'Up', cpuUsagePercent: 1, applicationID: 'app1', applicationVersion: 1 }] },
      }] } },
    })))
    const r = await appStageOnly(AUTH, projectDir, { confirmed: true, sleep: async () => {}, intervalMs: 1000, timeoutMs: 2000, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.executed.join('\n')).toContain('時間切れ')
    expect(t.unmeasured()).toEqual([STAGE.teardownApp])
  })

  // ── 本線（0.6.20-rc.7）で足された「アプリの削除を 400 で断られたときの待ち直し」「アプリがすでに無い」との組み合わせ ──
  const RUNNING: Route = { status: 400, body: { status: 400, title: 'Cannot delete application because it is currently running' } }
  const ACTIVE: Route = { status: 400, body: { status: 400, title: 'Cannot delete application because it has active version' } }
  const appRow = (activeVersion: number | null): Route => ({ status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion } } })
  const runApp = async (extra: Record<string, Route | Route[]>, flowOpts: { timeoutMs?: number } = {}) => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const t = trace()
    const sleeps: number[] = []
    const baseUrl = await listen(routed(teardownRoutes(extra)))
    const r = await appStageOnly(AUTH, projectDir, {
      confirmed: true, sleep: async ms => { sleeps.push(ms) }, progress: t.progress, onStage: t.onStage, ...flowOpts,
    }, baseUrl)
    return { r, t, sleeps }
  }

  it('★★ アプリ: 400（まだコンテナが止まっていない）で待ち直して、あとで消えた → teardown.app に印は付かない（待つのは削除にふつうに含まれる時間）', async () => {
    const { r, t, sleeps } = await runApp({ 'DELETE /applications/app1': [RUNNING, RUNNING, { status: 204, body: {} }] })
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([15000, 15000]) // 待ち直した（間を置かずに打っていない）
    expect(t.stages()).toEqual([STAGE.teardownApp]) // 待ち直しても段は増えない・同じ段のまま
    expect(t.unmeasured()).toEqual([]) // 待ち直しだけでは印を付けない
    expect(t.events).toContain('P:アプリのコンテナが止まるのを待っています…')
  })

  it('★★ アプリ: 400（有効なバージョンが残っている）で無効化からやり直して、あとで消えた → teardown.app に印は付かない', async () => {
    const { r, t, sleeps } = await runApp({
      'GET /applications/app1': [appRow(1), appRow(null)],
      'PUT /applications/app1': { status: 204, body: {} },
      'DELETE /applications/app1': [ACTIVE, { status: 204, body: {} }],
    })
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([15000])
    expect(t.stages()).toEqual([STAGE.teardownApp])
    expect(t.unmeasured()).toEqual([])
  })

  it('★★ アプリ: 400 で待ち直したあと、さくら側ですでに消えていた（DELETE が 404・一覧にも無い）→ teardown.app に印（「既に消えていた」と同じ）', async () => {
    const { r, t, sleeps } = await runApp({
      'DELETE /applications/app1': [RUNNING, { status: 404, body: { title: 'not found' } }],
    })
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([15000])
    expect(r.executed.join('\n')).toContain('既に存在しませんでした')
    expect(t.unmeasured()).toEqual([STAGE.teardownApp])
  })

  it('★★ アプリ: 取得も 404（さくら側にすでに無い）→ 無効化は打たずに DELETE へ進み、404・一覧にも無いので teardown.app に印', async () => {
    const calls: string[] = []
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const t = trace()
    const base = routed(teardownRoutes({
      'GET /applications/app1': { status: 404, body: { title: 'not found' } },
      'DELETE /applications/app1': { status: 404, body: { title: 'not found' } },
    }))
    const baseUrl = await listen((req, res) => { calls.push(`${req.method} ${req.url}`); base(req, res) })
    const r = await appStageOnly(AUTH, projectDir, { confirmed: true, sleep: async () => {}, onStage: t.onStage }, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).not.toContain('PUT /applications/app1') // 無いものを無効にしようとしない
    expect(calls).toContain('DELETE /applications/app1')
    expect(t.stages()).toEqual([STAGE.teardownApp])
    expect(t.unmeasured()).toEqual([STAGE.teardownApp])
  })

  it('★★ アプリ: 400 が合計の上限（ここでは60秒）まで続いて止まった回は失敗（ok:false・記録は残る）。印は付けない（失敗した操作の時間は、そもそも保存されない）', async () => {
    const { r, t, sleeps } = await runApp({ 'DELETE /applications/app1': RUNNING }, { timeoutMs: 60_000 })
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(r.inProgress).toBeUndefined()
    expect(sleeps).toEqual([15000, 15000, 15000, 15000]) // 上限（60秒）まで15秒おきに待った
    expect(t.unmeasured()).toEqual([]) // 失敗なので保存されない（projectOps.ts は ok:true のときだけ保存する）
  })
})

// ── 2026-10-08 検分: J・L の待ち直しの段にも「測っていない」の印を付ける ─────────────────────────────────
// ASG・クラスタの 409 で下位の一覧が空のまま反映を待った回・アプリの削除の待ち直しの途中で 5xx／通信の切れを待った回の段の時間は、
// 「ふつうにかかる時間」ではない。印が無いと、その時間（15秒おきの待ちを含む）が目安の記録（最近5回の中央値）に入る。
describe('★★ 削除（手順6）: 反映のずれの待ち（J）・5xx の待ち直し（L）の段に印が付く。待たなかった回には付かない', () => {
  const ASG_409 = 'Cannot delete Auto Scaling Group because it has associated Load Balancers: l1'
  const CLUSTER_409 = 'Cannot delete Cluster because it has Auto Scaling Group: a1'
  const R409 = (title: string): Route => ({ status: 409, body: { status: 409, title } })
  const OK204: Route = { status: 204, body: {} }
  const runFlow = async (record: Parameters<typeof writeApprunDedicatedRecordFs>[1], extra: Record<string, Route | Route[]>) => {
    writeApprunDedicatedRecordFs(projectDir, record)
    const t = trace()
    const baseUrl = await listen(routed(teardownRoutes(extra)))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: async () => {}, onStage: t.onStage }, baseUrl)
    return { r, t }
  }

  it('★★★ J（ASG）: 409 のあと LB の一覧が空 → 待ってやり直して成功 → teardown.asg に印。ほかの段には付かない', async () => {
    const { r, t } = await runFlow({ clusterID: 'c1', asgID: 'a1' }, {
      'DELETE /clusters/c1/asg/a1': [R409(ASG_409), R409(ASG_409), OK204],
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(t.unmeasured()).toEqual([STAGE.teardownAsg])
  })

  it('★★★ J（クラスタ）: 409 のあと ASG の一覧が空 → 待ってやり直して成功 → teardown.cluster に印。ほかの段には付かない', async () => {
    const { r, t } = await runFlow({ clusterID: 'c1' }, {
      'DELETE /clusters/c1': [R409(CLUSTER_409), R409(CLUSTER_409), OK204],
      'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(t.unmeasured()).toEqual([STAGE.teardownCluster])
  })

  it('★★★ L（アプリ）: 400 で待ち直した途中で DELETE が 503 → 待ってやり直して成功 → teardown.app に印（400 の待ちだけの回には付かない）', async () => {
    const RUNNING: Route = { status: 400, body: { status: 400, title: 'Cannot delete application because it is currently running' } }
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const t = trace()
    const baseUrl = await listen(routed(teardownRoutes({
      'DELETE /applications/app1': [RUNNING, { status: 503, body: { title: 'Service Unavailable' } }, OK204],
    })))
    const r = await appStageOnly(AUTH, projectDir, { confirmed: true, sleep: async () => {}, onStage: t.onStage }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(t.unmeasured()).toEqual([STAGE.teardownApp])
  })

  it('対照: 409 を断られない（ふつうに消えた）回には、J の印は付かない', async () => {
    const { r, t } = await runFlow({ clusterID: 'c1', asgID: 'a1' }, {})
    expect(r.ok).toBe(true)
    expect(t.unmeasured()).toEqual([])
  })
})

describe('段の定義表と、flow が渡す名前', () => {
  it('flow（apprunDedicated*Apply.ts）が渡す段の名前は、すべて STAGE の定義から引いている（文字列の直書きが無い）', () => {
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const f of ['src/main/cloud/apprunDedicatedApply.ts', 'src/main/cloud/apprunDedicatedAppApply.ts', 'src/main/ipc/apprunDedicated.ts', 'src/main/ipc/apprunDedicatedTeardown.ts']) {
      const code = strip(fs.readFileSync(path.join(__dirname, '..', f), 'utf-8'))
      expect(code, `${f} に段の内部名の直書きがある`).not.toMatch(/['"`](create|publish|teardown)\.[a-z-]+['"`]/)
    }
  })
})
