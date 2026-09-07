import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createClusterFlow,
  teardownFlow,
  buildClusterCreateBody,
  buildAsgCreateBody,
  buildLbCreateBody,
  countClusters,
  isReservedPort,
  RESERVED_PORT_RANGE,
  type ApprunDedicatedClusterSpec,
} from '../src/main/cloud/apprunDedicatedApply'
import { writeApprunDedicatedRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'

// roadmap #23 段階②「作る」＋④「破棄」。tests/apprunDedicated.test.ts / tests/sakuraEngine.test.ts と
// 同じく、ローカルに本物の http サーバを立てて実物のクライアントに対して確かめる（実APIは叩かない・掟4）。

let server: Server | null = null
afterEach(() => { if (server) { server.close(); server = null } })

/** ローカルに http サーバを立てて空きポートで listen し、baseUrl（末尾スラッシュ付き）を返す。 */
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

/**
 * `METHOD /path` をキーにしたルーティング表から応答するテスト用サーバを作る。
 * 呼ばれた順に `calls` へ `METHOD /path` を積む（呼び出し順の検証・掟10「作る順番／壊す順番」用）。
 * 表に無いキーは 404 を返す（想定外の呼び出しがあれば `calls` に残り、テストで検知できる）。
 * **204 は本文なしで返す**（5-8「DELETE … (3種) → 204・本文なし」を偽サーバでも忠実に再現する）。
 */
function routedServer(routes: Record<string, Route>, calls: string[], onBody?: (key: string, body: any) => void): http.RequestListener {
  return (req, res) => {
    const key = `${req.method} ${req.url}`
    calls.push(key)
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      if (onBody) { try { onBody(key, raw ? JSON.parse(raw) : null) } catch { onBody(key, raw) } }
      const route = routes[key]
      const status = route?.status ?? 404
      if (status === 204) { res.writeHead(204); res.end(); return }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(route?.body ?? { error: `test router: 未定義のルート ${key}` }))
    })
  }
}

let projectDir = ''
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-apprundedicatedapply-')) })
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })

const AUTH = { token: 'tok', secret: 'sec' }

const SPEC: ApprunDedicatedClusterSpec = {
  name: 'myapp',
  ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }],
  servicePrincipalID: '113800956789',
  zone: 'tk1b',
  workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
  minNodes: 1,
  maxNodes: 1,
  lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
}

function consent(iso = '2026-09-01T00:00:00.000Z') {
  writeApprunDedicatedRecordFs(projectDir, { consentedAt: iso })
}

// ── createClusterFlow ─────────────────────────────────────────────────

describe('createClusterFlow: 1. 同意が無ければ API を一度も呼ばずに中止する', () => {
  it('consentedAt が記録に無いと stage:consent で中止し、fetch を一度も呼ばない', async () => {
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('consent')
    expect(r.message).toContain('同意')
    expect(calls).toEqual([])
  })
})

describe('createClusterFlow: 2. 上限に達していれば作らない', () => {
  it('現在のクラスタ数が上限以上なら stage:limits で止め、クラスタを作らない', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [{ clusterID: 'a' }, { clusterID: 'b' }, { clusterID: 'c' }] } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('limits')
    expect(r.message).toContain('3個')
    expect(calls).toEqual(['GET /limits', 'GET /clusters?maxItems=20'])
  })

  it('上限未満なら通り、クラスタ作成へ進む', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [{ clusterID: 'a' }] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 500, body: { status: 500, title: 'unreachable in this test' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, baseUrl)
    expect(r.stage).not.toBe('limits')
    expect(calls).toContain('POST /clusters')
  })
})

describe('createClusterFlow: 3. クラスタ作成は200でも getCluster で見つからなければ成功にしない', () => {
  it('POST /clusters が200でも GET /clusters/{id} が失敗したら ok:false（ASGは作らない）。ただしクラスタIDは記録される', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 404, body: { status: 404, title: 'not found' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('cluster-verify')
    expect(calls).not.toContain('POST /clusters/cluster-x/asg')

    // 掟10: 作れたところまでは必ず記録に残る（getClusterの確認が取れなくても）。
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('cluster-x')
  })
})

describe('createClusterFlow: 4. ASG作成が失敗しても、作れたクラスタは記録されている', () => {
  it('POST .../asg が失敗しても、クラスタIDは記録に残る（消せなくならない）', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'POST /clusters/cluster-x/asg': { status: 500, body: { status: 500, title: 'internal' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('asg-create')

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('cluster-x')
    expect(rec.asgID).toBeFalsy()
  })
})

describe('createClusterFlow: 5. LB作成が失敗しても、クラスタとASGは記録されている', () => {
  it('POST .../load_balancers が失敗しても、クラスタIDとASG IDは記録に残る', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'POST /clusters/cluster-x/asg': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
      'GET /clusters/cluster-x/asg/asg-y': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
      'POST /clusters/cluster-x/asg/asg-y/load_balancers': { status: 500, body: { status: 500, title: 'internal' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('lb-create')

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('cluster-x')
    expect(rec.asgID).toBe('asg-y')
    expect(rec.loadBalancerID).toBeFalsy()
  })
})

describe('createClusterFlow: 正常系（クラスタ→ASG→LBの順で作られ、都度記録される）', () => {
  it('全段成功すると ok:true。作成本文（interfaces）には upstream:shared 以外のキーが無い', async () => {
    consent()
    const calls: string[] = []
    const bodies: Record<string, any> = {}
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'POST /clusters/cluster-x/asg': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
      'GET /clusters/cluster-x/asg/asg-y': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
      'POST /clusters/cluster-x/asg/asg-y/load_balancers': { status: 200, body: { loadBalancer: { loadBalancerID: 'lb-z' } } },
    }, calls, (key, body) => { bodies[key] = body }))

    const r = await createClusterFlow(AUTH, projectDir, SPEC, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.stage).toBe('done')
    expect(r.clusterID).toBe('cluster-x')
    expect(r.asgID).toBe('asg-y')
    expect(r.loadBalancerID).toBe('lb-z')

    expect(calls).toEqual([
      'GET /limits',
      'GET /clusters?maxItems=20',
      'POST /clusters',
      'GET /clusters/cluster-x',
      'POST /clusters/cluster-x/asg',
      'GET /clusters/cluster-x/asg/asg-y',
      'POST /clusters/cluster-x/asg/asg-y/load_balancers',
    ])

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('cluster-x')
    expect(rec.asgID).toBe('asg-y')
    expect(rec.loadBalancerID).toBe('lb-z')
    expect(rec.workerServiceClassPath).toBe(SPEC.workerServiceClassPath)
    expect(rec.lbServiceClassPath).toBe(SPEC.lbServiceClassPath)

    // 9. upstream:'shared' のとき ipPool/netmaskLen/defaultGateway を送らない（実配線での確認）。
    const asgBody = bodies['POST /clusters/cluster-x/asg']
    expect(asgBody.interfaces).toEqual([{ interfaceIndex: 0, upstream: 'shared', connectsToLB: true }])
    const lbBody = bodies['POST /clusters/cluster-x/asg/asg-y/load_balancers']
    expect(lbBody.interfaces).toEqual([{ interfaceIndex: 0, upstream: 'shared' }])
  })
})

// ── teardownFlow ─────────────────────────────────────────────────────

describe('teardownFlow: 6. LB → ASG → クラスタ の順で呼ばれる', () => {
  it('呼び出し順を配列で検証する', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204, body: {} },
      'DELETE /clusters/c1/asg/a1': { status: 204, body: {} },
      'DELETE /clusters/c1': { status: 204, body: {} },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([
      'DELETE /clusters/c1/asg/a1/load_balancers/l1',
      'DELETE /clusters/c1/asg/a1',
      'DELETE /clusters/c1',
    ])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBeFalsy()
    expect(rec.asgID).toBeFalsy()
    expect(rec.clusterID).toBeFalsy()
  })
})

describe('teardownFlow: 7. LBだけ失敗したら「残っている」と返り、記録からLBが消えない', () => {
  it('LB削除が失敗したら ASG・クラスタの削除は試みず、3つとも記録に残る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('残っています')
    expect(calls).toEqual(['DELETE /clusters/c1/asg/a1/load_balancers/l1'])

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBe('l1')
    expect(rec.asgID).toBe('a1')
    expect(rec.clusterID).toBe('c1')
  })
})

describe('teardownFlow: 8. 記録に無い資源は破棄で触らない', () => {
  it('clusterID しか記録が無ければ、DELETE /clusters/{id} しか呼ばない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1': { status: 204, body: {} },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['DELETE /clusters/c1'])
  })

  it('記録が何も無ければ、何も呼ばずに ok:true を返す', async () => {
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await teardownFlow(AUTH, projectDir, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([])
  })

  it('ASG削除が失敗したら、その下のクラスタ削除は試みない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, baseUrl)
    expect(r.ok).toBe(false)
    expect(calls).toEqual(['DELETE /clusters/c1/asg/a1'])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('c1')
    expect(rec.asgID).toBe('a1')
  })
})

// ── 純関数（本文の組み立て・上限カウント・予約ポート） ──────────────────────────

describe('buildClusterCreateBody（5-2）', () => {
  it('name/ports/servicePrincipalID を含む。letsEncryptEmail は無ければ含めない', () => {
    const body = buildClusterCreateBody(SPEC)
    expect(body).toEqual({
      name: 'myapp',
      ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }],
      servicePrincipalID: '113800956789',
    })
  })

  it('letsEncryptEmail があれば含める（独自ドメイン用）', () => {
    const body = buildClusterCreateBody({ ...SPEC, letsEncryptEmail: 'owner@example.com' })
    expect((body as any).letsEncryptEmail).toBe('owner@example.com')
  })
})

describe('buildAsgCreateBody / buildLbCreateBody: upstream=shared のとき ipPool/netmaskLen/defaultGateway を含めない（5-5/5-6）', () => {
  it('ASG: interfaces は upstream:shared・connectsToLB:true の1枚だけ', () => {
    const body = buildAsgCreateBody(SPEC) as any
    expect(body.interfaces).toEqual([{ interfaceIndex: 0, upstream: 'shared', connectsToLB: true }])
    expect(body.zone).toBe('tk1b')
    expect(body.minNodes).toBe(1)
    expect(body.maxNodes).toBe(1)
  })

  it('LB: interfaces は upstream:shared の1枚だけ（connectsToLBは持たない）', () => {
    const body = buildLbCreateBody(SPEC) as any
    expect(body.interfaces).toEqual([{ interfaceIndex: 0, upstream: 'shared' }])
    expect(body.serviceClassPath).toBe(SPEC.lbServiceClassPath)
  })
})

describe('countClusters: GET /clusters の応答から件数を数える（形は5-8の表どおり。推測で拾わない）', () => {
  it('{ clusters: [...] } から数える（実物の形）', () => { expect(countClusters({ clusters: [{}, {}] })).toBe(2) })
  it('配列そのものは数えない（実物はこの形を返さない。0＝安全側）', () => { expect(countClusters([{}, {}, {}])).toBe(0) })
  it('{ data: [...] } は数えない（実物のキーではない。推測で拾わない）', () => { expect(countClusters({ data: [{}] })).toBe(0) })
  it('形が分からなければ 0（存在しない、ではなく「数えられない」の安全側）', () => { expect(countClusters({})).toBe(0) })
})

describe('isReservedPort: 5950-5959 は予約（5-5・画面の入力チェックが最後に頼る関数）', () => {
  it('範囲の値は予約', () => {
    expect(isReservedPort(5950)).toBe(true)
    expect(isReservedPort(5959)).toBe(true)
    expect(isReservedPort(5955)).toBe(true)
  })
  it('範囲外は予約ではない', () => {
    expect(isReservedPort(80)).toBe(false)
    expect(isReservedPort(443)).toBe(false)
    expect(isReservedPort(5949)).toBe(false)
    expect(isReservedPort(5960)).toBe(false)
  })
  it('RESERVED_PORT_RANGE がドキュメントの値と一致する', () => {
    expect(RESERVED_PORT_RANGE).toEqual([5950, 5959])
  })
})
