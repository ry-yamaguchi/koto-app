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
  validateClusterSpec,
  type ApprunDedicatedClusterSpec,
} from '../src/main/cloud/apprunDedicatedApply'
import { writeApprunDedicatedRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'

// roadmap #23 段階②「作る」＋④「破棄」。tests/apprunDedicated.test.ts / tests/sakuraEngine.test.ts と
// 同じく、ローカルに本物の http サーバを立てて実物のクライアントに対して確かめる（実APIは叩かない・掟4）。
//
// 2026-09-10 レビューの修理（掟10「お金・破壊の歯止めは、振る舞いで固定する」）:
// createClusterFlow / teardownFlow は `opts.confirmed` を第4/第3引数に取るようになった
// （`createClusterFlow(auth, projectDir, spec, opts, baseUrl?)` / `teardownFlow(auth, projectDir, opts, baseUrl?)`）。
// このファイルの呼び出しはすべてこの新しい形で行う。

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
const CONFIRMED = { confirmed: true as const }
const NOT_CONFIRMED = { confirmed: false as const }

const SPEC: ApprunDedicatedClusterSpec = {
  name: 'myapp',
  ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }],
  servicePrincipalID: '111111111111',
  zone: 'tk1b',
  workerServiceClassPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
  minNodes: 1,
  maxNodes: 1,
  lbServiceClassPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
}

function consent(iso = '2026-09-01T00:00:00.000Z') {
  writeApprunDedicatedRecordFs(projectDir, { consentedAt: iso })
}

// ── 1. confirmed 無しでは fetch を一切呼ばない（2026-09-10 レビューの修理・A） ─────────────

describe('createClusterFlow/teardownFlow: 1. confirmed が無ければ API を一度も呼ばずに中止する（掟10の3点セット）', () => {
  it('createClusterFlow: opts.confirmed:false → stage:consent・calls は空（同意済みでも呼ばない）', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, NOT_CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('consent')
    expect(r.message).toContain('確認')
    expect(calls).toEqual([])
  })

  it('createClusterFlow: opts.confirmed を省略した形（{}）でも同様に中止し、calls は空', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, {} as any, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('consent')
    expect(calls).toEqual([])
  })

  it('teardownFlow: opts.confirmed:false → calls は空。記録は remaining にそのまま残る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await teardownFlow(AUTH, projectDir, NOT_CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
    expect(r.remaining).toEqual({ loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' })
    // 記録もいっさい書き換わっていない。
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBe('l1')
    expect(rec.asgID).toBe('a1')
    expect(rec.clusterID).toBe('c1')
  })

  it('teardownFlow: opts.confirmed を省略した形（{}）でも calls は空', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await teardownFlow(AUTH, projectDir, {} as any, baseUrl)
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })
})

// ── 2. 記録に既存があれば新規作成させない（2026-09-10 レビューの修理・B） ─────────────────

describe('createClusterFlow: 2. 記録に既に何かあれば stage:existing で止め、API を一切呼ばない', () => {
  it('clusterID だけ記録にあっても止める（fetch ゼロ）', async () => {
    consent()
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'cluster-old' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('existing')
    expect(r.message).toContain('cluster-old')
    expect(r.clusterID).toBe('cluster-old')
    expect(calls).toEqual([])
  })

  it('asgID だけ記録にあっても止める（先に作ったクラスタの上書き事故を防ぐ）', async () => {
    consent()
    writeApprunDedicatedRecordFs(projectDir, { asgID: 'asg-old' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('existing')
    expect(calls).toEqual([])
  })

  it('loadBalancerID だけ記録にあっても止める', async () => {
    consent()
    writeApprunDedicatedRecordFs(projectDir, { loadBalancerID: 'lb-old' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('existing')
    expect(calls).toEqual([])
  })

  it('記録が空なら existing では止まらず先へ進む', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.stage).not.toBe('existing')
    expect(calls).toContain('GET /limits')
  })
})

// ── 3. 記録ファイルに書き込めなければ止まる（2026-09-10 レビューの修理・C） ────────────────

describe('createClusterFlow: 3. 記録ファイルに書けなければ、最初のPOSTより前に止まる（fetchゼロ）', () => {
  it('.sakuraide.json を読み取り専用にすると stage:record で止まり、calls は空', async () => {
    // consent() が .sakuraide.json を作ってしまうため、projectDir（ディレクトリ）だけを
    // 読み取り専用にしても「既存ファイルの上書き」はブロックされない（Unixの権限は、既存
    // ファイルへの書き込みはファイル自身のモードで決まり、ディレクトリの書き込み権限は
    // 新規作成/削除/リネームにしか要らないため。実際に試して確認した——ディレクトリだけを
    // 0500 にしても書き込みは成功してしまい、stage は limits まで進んでしまった）。
    // そこで **記録ファイルそのもの** を読み取り専用にする（書き込みが本当に失敗する形）。
    consent()
    const metaPath = path.join(projectDir, '.sakuraide.json')
    fs.chmodSync(metaPath, 0o400)
    try {
      const calls: string[] = []
      const baseUrl = await listen(routedServer({}, calls))
      const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
      expect(r.ok).toBe(false)
      expect(r.stage).toBe('record')
      expect(calls).toEqual([])
    } finally {
      fs.chmodSync(metaPath, 0o600)
    }
  })
})

// ── 4. 作成応答が取れなかったとき、一覧を名前で探す（2026-09-10 レビューの修理・D） ─────────

describe('createClusterFlow: 4. POST が失敗しても、一覧に同名があれば記録して知らせる（断定しない）', () => {
  it('POST /clusters が500でも GET /clusters?maxItems=20 に同名クラスタがあれば、clusterIDを記録して返す', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 500, body: { status: 500, title: 'boom' } },
    }, calls))
    // 1回目のGET /clustersは上限チェック用に使われるため、名前探し用に別のシナリオで確認する。
    // ここでは上限チェックの一覧取得自体が失敗するため、上限確認の段階で止まることを確認する。
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('limits')
  })

  it('POST /clusters が500でも、名前探しの一覧（作成失敗直後のGET）に同名クラスタがあれば記録に書き、stageは断定的な失敗ではなく名前探しの結果を伝える', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      // 上限チェックの一覧は空（作成前）。
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [{ clusterID: 'cluster-found', name: 'myapp', created: 1 }] } },
      'POST /clusters': { status: 500, body: { status: 500, title: 'internal' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('cluster-create')
    expect(r.clusterID).toBe('cluster-found')
    expect(r.message).toContain('cluster-found')
    expect(r.message).not.toContain('無いことを確認してください')

    // 名前探しで見つかったIDが記録される（「分からない」を「未作成」に倒さない）。
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('cluster-found')

    // GET /clusters?maxItems=20 が2回（上限チェック用＋名前探し用）呼ばれている。
    expect(calls.filter(c => c === 'GET /clusters?maxItems=20').length).toBe(2)
  })

  it('POST /clusters が失敗し、名前探しの一覧にも同名が無ければ、断定しない文言で失敗を返す', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 500, body: { status: 500, title: 'internal' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('cluster-create')
    expect(r.clusterID).toBeUndefined()
    expect(r.message).toContain('確認できませんでした')
    expect(r.message).not.toContain('作られていません')

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBeFalsy()
  })
})

// ── A（2026-09-17）: POSTが2xxで返ったのにIDが読めないときも、名前で探して記録する ──────────

describe('createClusterFlow: A. POST /clusters が200で形違いの応答を返しIDが読めないとき、名前で探して記録する', () => {
  it('名前で探すGETが飛び、同名クラスタがあれば記録に clusterID が入る（⑥の節が出せる状態になる）', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [{ clusterID: 'cluster-found', name: 'myapp', created: 1 }] } },
      // 形が違う応答（cluster.clusterID が無い）。
      'POST /clusters': { status: 200, body: { clusterIdWrongKey: 'oops' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('cluster-create')
    expect(r.clusterID).toBe('cluster-found')
    // 上限チェック用＋名前探し用で GET /clusters?maxItems=20 が2回呼ばれている。
    expect(calls.filter(c => c === 'GET /clusters?maxItems=20').length).toBe(2)
    // 名前探しで見つかった時点で返る——実在確認（getCluster）は呼ばれない。
    expect(calls).not.toContain('GET /clusters/cluster-found')

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('cluster-found')
    expect(rec.name).toBe('myapp')
  })

  it('見つからなければ、文面に課金への言及とコントロールパネルへの案内が入る', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: {} },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('cluster-create')
    expect(r.clusterID).toBeUndefined()
    expect(r.message).toContain('課金')
    expect(r.message).toContain('コントロールパネル')

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBeFalsy()
  })
})

describe('createClusterFlow: A. ASG・LBの枝には名前探しを足していない（経路を増やしていないことの固定）', () => {
  it('ASG作成が200で形違いでも、名前で探すGETは飛ばず、課金の案内だけを返す', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'c1' } } },
      'GET /clusters/c1': { status: 200, body: { cluster: { clusterID: 'c1' } } },
      'POST /clusters/c1/asg': { status: 200, body: {} }, // 形が違う
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('asg-create')
    expect(r.clusterID).toBe('c1')
    expect(r.message).toContain('課金')
    expect(r.message).toContain('コントロールパネル')
    expect(calls.some(c => c.startsWith('GET /clusters/c1/asg'))).toBe(false)
  })

  it('LB作成が200で形違いでも、名前で探すGETは飛ばず、課金の案内だけを返す', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'c1' } } },
      'GET /clusters/c1': { status: 200, body: { cluster: { clusterID: 'c1' } } },
      'POST /clusters/c1/asg': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'a1' } } },
      'GET /clusters/c1/asg/a1': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'a1' } } },
      'POST /clusters/c1/asg/a1/load_balancers': { status: 200, body: {} }, // 形が違う
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('lb-create')
    expect(r.clusterID).toBe('c1')
    expect(r.asgID).toBe('a1')
    expect(r.message).toContain('課金')
    expect(r.message).toContain('コントロールパネル')
    expect(calls.some(c => c.startsWith('GET /clusters/c1/asg/a1/load_balancers'))).toBe(false)
  })
})

// ── 5. 破棄で404を一覧で確かめる（2026-09-10 レビューの修理・E） ──────────────────────────

describe('teardownFlow: 5. DELETE LB が404のとき、一覧で本当に無いか確かめてから完了扱いにする', () => {
  it('404 かつ一覧に無い → 記録からLBが消え、ASG・クラスタのDELETEへ進む（callsの順序で確認）', async () => {
    // teardownFlow は、DELETEが204（受理）で返った段でも直後に同じ一覧で確かめる（6.）ため、
    // ASG・クラスタのDELETEが204で返ったあとにも、それぞれの一覧GETが呼ばれる。
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 404, body: { status: 404, title: 'not found' } },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
      'DELETE /clusters/c1/asg/a1': { status: 204, body: {} },
      'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
      'DELETE /clusters/c1': { status: 204, body: {} },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.executed.some(e => e.includes('既に存在しませんでした'))).toBe(true)
    expect(calls).toEqual([
      'DELETE /clusters/c1/asg/a1/load_balancers/l1',
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20',
      'DELETE /clusters/c1/asg/a1',
      'GET /clusters/c1/asg?maxItems=20',
      'DELETE /clusters/c1',
      'GET /clusters?maxItems=20',
    ])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBeFalsy()
    expect(rec.asgID).toBeFalsy()
    expect(rec.clusterID).toBeFalsy()
  })

  it('404 だが一覧にIDがまだある → 止まる。記録は3つとも残る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 404, body: { status: 404, title: 'not found' } },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [{ loadBalancerID: 'l1', name: 'myapp', deleting: false, created: 1, serviceClassPath: 'x' }] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('残っています')
    expect(calls).toEqual([
      'DELETE /clusters/c1/asg/a1/load_balancers/l1',
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20',
    ])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBe('l1')
    expect(rec.asgID).toBe('a1')
    expect(rec.clusterID).toBe('c1')
  })

  it('404 だが一覧そのものが失敗 → 確かめられないので止まる。記録は残る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 404, body: { status: 404, title: 'not found' } },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 500, body: { status: 500, title: 'boom' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('確かめられませんでした')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBe('l1')
  })
})

// ── 6. #39（2026-09-10 実測・5-11）: 削除は非同期。各段は一覧から消えるまで待ってから次へ ──
//
// 旧仕様（DELETE 204/404 の直後に一覧を1回だけ見て、消えていなければ即 ok:false／deleting:true や
// 一覧失敗は「消えた扱い」で先へ進む）は、実 API で (1) ASG が409で止まる (2) LBの記録が消えて
// 押し直せない、という事故を起こした（CLAUDE.md 掟10「削除の204は『消えた』ではない」）。
// ここからは「一覧から消えるまで待つ」新仕様をテストする。`sleep` を偽物にして即時に回す
// （intervalMs/timeoutMs は既定のままでよい——実時間は待たないため既定でも高速に終わる）。

describe('teardownFlow: 6. 各段は一覧から消えるまで待つ（#39・5-11実測）', () => {
  it('1. LB 204 → 一覧 deleting:true が2回 → 3回目で消える → ASGのDELETEはその後に呼ばれる。記録は消えるまで残る（途中で確認）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    let lbListCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'DELETE /clusters/c1/asg/a1/load_balancers/l1') return send(204, {})
      if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') {
        lbListCount++
        return send(200, { loadBalancers: lbListCount <= 2 ? [{ loadBalancerID: 'l1', name: 'myapp', deleting: true, created: 1, serviceClassPath: 'x' }] : [] })
      }
      if (key === 'DELETE /clusters/c1/asg/a1') return send(204, {})
      if (key === 'GET /clusters/c1/asg?maxItems=20') return send(200, { autoScalingGroups: [] })
      if (key === 'DELETE /clusters/c1') return send(204, {})
      if (key === 'GET /clusters?maxItems=20') return send(200, { clusters: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    let sleepCalls = 0
    const sleep = async () => {
      sleepCalls++
      // waitUntilGone のループの途中（まだ消えたと確認する前）は、記録がそのまま残っていること。
      const rec = readApprunDedicatedFs(projectDir)
      expect(rec.loadBalancerID).toBe('l1')
    }
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleepCalls).toBe(2) // deleting:trueが2回続いた分だけ待つ（1回目・2回目の一覧のあと）
    expect(lbListCount).toBe(3) // 3回目の一覧で消えたと確認する
    const lbDeleteAt = calls.indexOf('DELETE /clusters/c1/asg/a1/load_balancers/l1')
    const asgDeleteAt = calls.indexOf('DELETE /clusters/c1/asg/a1')
    expect(lbDeleteAt).toBeGreaterThanOrEqual(0)
    expect(asgDeleteAt).toBeGreaterThan(lbDeleteAt) // ASGのDELETEは、LBが消えたと確認した後に呼ばれる
    expect(r.executed.some(e => e.includes('ロードバランサ『l1』を削除しました（消えたことを確認）'))).toBe(true)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBeFalsy()
    expect(rec.asgID).toBeFalsy()
    expect(rec.clusterID).toBeFalsy()
  })

  it('2. LBが消えないまま timeout → ok:false・inProgress.loadBalancerID・記録は3つとも残る・ASGのDELETEは呼ばれない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204, body: {} },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [{ loadBalancerID: 'l1', name: 'myapp', deleting: true, created: 1, serviceClassPath: 'x' }] } },
    }, calls))
    const sleep = async () => {} // 即時に解決する偽物（実際には待たない）
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, intervalMs: 1000, timeoutMs: 3000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.inProgress?.loadBalancerID).toBe('l1')
    expect(r.message).toContain('削除中です')
    expect(calls).not.toContain('DELETE /clusters/c1/asg/a1')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBe('l1')
    expect(rec.asgID).toBe('a1')
    expect(rec.clusterID).toBe('c1')
  })

  it('3. ASGが409（本文に Load Balancers: l1）→ LBのIDを記録に戻し、LB一覧の deleting:true を待ってからASGを再度DELETEする', async () => {
    // loadBalancerIDは既に記録から外れている想定（前回の破棄がLBだけ消して途中で止まった、等）。
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    let asgDeleteCount = 0
    let lbListCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'DELETE /clusters/c1/asg/a1') {
        asgDeleteCount++
        if (asgDeleteCount === 1) {
          return send(409, { status: 409, title: 'Cannot delete Auto Scaling Group because it has associated Load Balancers: l1' })
        }
        return send(204, {})
      }
      if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') {
        lbListCount++
        return send(200, { loadBalancers: lbListCount === 1 ? [{ loadBalancerID: 'l1', name: 'myapp', deleting: true, created: 1, serviceClassPath: 'x' }] : [] })
      }
      if (key === 'GET /clusters/c1/asg?maxItems=20') return send(200, { autoScalingGroups: [] })
      if (key === 'DELETE /clusters/c1') return send(204, {})
      if (key === 'GET /clusters?maxItems=20') return send(200, { clusters: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(asgDeleteCount).toBe(2) // 1回目は409、LBが消えるのを待ってから2回目で成功
    expect(r.executed.some(e => e.includes('ロードバランサ『l1』がまだ残っていたため、記録に戻しました'))).toBe(true)
    expect(r.executed.some(e => e.includes('ロードバランサ『l1』を削除しました（消えたことを確認）'))).toBe(true)
    expect(r.executed.some(e => e.includes('オートスケーリンググループ『a1』を削除しました（消えたことを確認）'))).toBe(true)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.asgID).toBeFalsy()
    expect(rec.clusterID).toBeFalsy()
  })

  it('3b. ASGが409で、LB一覧に deleting:false のLBが残っている → 止まり、LBのIDが記録に戻る（親の独立した変異試験で素通りした経路・2026-09-11）', async () => {
    // 記録からLBだけ外れている（前回の破棄で「消えた扱い」にしてしまった状態）。
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'DELETE /clusters/c1/asg/a1') {
        return send(409, { status: 409, title: 'Cannot delete Auto Scaling Group because it has associated Load Balancers: l1' })
      }
      if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') {
        return send(200, { loadBalancers: [{ loadBalancerID: 'l1', name: 'myapp', deleting: false, created: 1, serviceClassPath: 'x' }] })
      }
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('ロードバランサが残っているため')
    // **記録に戻っていること**（ここが無いと、次に⑥を押してもLBを消しにいけない）
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBe('l1')
    expect(rec.asgID).toBe('a1')
    expect(rec.clusterID).toBe('c1')
    expect(r.remaining.loadBalancerID).toBe('l1')
    // クラスタのDELETEへは進まない
    expect(calls.some(c => c === 'DELETE /clusters/c1')).toBe(false)
  })

  it('4. 削除中のLBへDELETE→404、一覧に deleting:true で残っていれば待ってから消えたら次へ（「削除しました（消えたことを確認）」。「既に存在しませんでした」ではない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    let lbListCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'DELETE /clusters/c1/asg/a1/load_balancers/l1') return send(404, { status: 404, title: 'not found' })
      if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') {
        lbListCount++
        return send(200, { loadBalancers: lbListCount === 1 ? [{ loadBalancerID: 'l1', name: 'myapp', deleting: true, created: 1, serviceClassPath: 'x' }] : [] })
      }
      if (key === 'DELETE /clusters/c1/asg/a1') return send(204, {})
      if (key === 'GET /clusters/c1/asg?maxItems=20') return send(200, { autoScalingGroups: [] })
      if (key === 'DELETE /clusters/c1') return send(204, {})
      if (key === 'GET /clusters?maxItems=20') return send(200, { clusters: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.executed.some(e => e.includes('ロードバランサ『l1』を削除しました（消えたことを確認）'))).toBe(true)
    expect(r.executed.some(e => e.includes('既に存在しませんでした'))).toBe(false)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBeFalsy()
  })
})

// ── 7. limitsの応答が読めなければ止まる（2026-09-10 レビューの修理・F） ────────────────────

describe('createClusterFlow: 7. clusterCount を応答から読み取れなければ止める（「分からない」を「大丈夫」に倒さない）', () => {
  it('{ "limit": {} }（clusterCount無し）→ stage:limits・POSTが飛ばない', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: {} } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('limits')
    expect(r.message).toContain('clusterCount')
    expect(calls).not.toContain('POST /clusters')
    expect(calls).toEqual(['GET /limits'])
  })
})

// ── 8. 最終メッセージは確かめた事実だけを言う（2026-09-10 レビューの修理・E） ───────────────

describe('teardownFlow: 8. 完了メッセージは「課金は止まっています」と断定しない', () => {
  it('全段成功時の message は「課金は止まっています」を含まない。一覧で確認した事実だけを言う', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204, body: {} },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
      'DELETE /clusters/c1/asg/a1': { status: 204, body: {} },
      'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
      'DELETE /clusters/c1': { status: 204, body: {} },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.message).not.toContain('課金は止まっています')
  })
})

// ── 9. 入力検証は「最後の砦」として本当に働く（2026-09-10 レビューの修理・L） ─────────────

describe('createClusterFlow: 9. validateClusterSpec に違反した spec は stage:invalid で止め、API を一切呼ばない', () => {
  it('予約ポート 5950 を含む spec → stage:invalid・calls が空', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const badSpec: ApprunDedicatedClusterSpec = { ...SPEC, ports: [{ port: 5950, protocol: 'http' }] }
    const r = await createClusterFlow(AUTH, projectDir, badSpec, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('maxNodes < minNodes → stage:invalid・calls が空', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const badSpec: ApprunDedicatedClusterSpec = { ...SPEC, minNodes: 5, maxNodes: 2 }
    const r = await createClusterFlow(AUTH, projectDir, badSpec, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('クラスタ名が21文字（範囲外）→ stage:invalid・calls が空', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const badSpec: ApprunDedicatedClusterSpec = { ...SPEC, name: 'a'.repeat(21) }
    const r = await createClusterFlow(AUTH, projectDir, badSpec, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('servicePrincipalID が12桁の数字でない → stage:invalid・calls が空', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const badSpec: ApprunDedicatedClusterSpec = { ...SPEC, servicePrincipalID: 'abc' }
    const r = await createClusterFlow(AUTH, projectDir, badSpec, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('invalid')
    expect(calls).toEqual([])
  })

  it('妥当な spec（SPEC）は validateClusterSpec 単体で ok:true', () => {
    expect(validateClusterSpec(SPEC)).toEqual({ ok: true })
  })
})

// ── 10. LB作成後の実在確認（2026-09-10 レビューの修理・M） ────────────────────────────────

describe('createClusterFlow: 10. LB作成後、一覧にIDが無ければ stage:lb-verify（記録は残す）', () => {
  it('POST .../load_balancers は成功するが、一覧にそのIDが無い → stage:lb-verify・記録は残る', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'POST /clusters/cluster-x/asg': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
      'GET /clusters/cluster-x/asg/asg-y': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
      'POST /clusters/cluster-x/asg/asg-y/load_balancers': { status: 200, body: { loadBalancer: { loadBalancerID: 'lb-z' } } },
      'GET /clusters/cluster-x/asg/asg-y/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('lb-verify')
    expect(r.message).toContain('lb-z')
    expect(r.loadBalancerID).toBe('lb-z')

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBe('lb-z')
    expect(rec.clusterID).toBe('cluster-x')
    expect(rec.asgID).toBe('asg-y')
  })

  it('一覧そのものが失敗しても stage:lb-verify で止まる（「分からない」を「成功」に倒さない）', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'POST /clusters/cluster-x/asg': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
      'GET /clusters/cluster-x/asg/asg-y': { status: 200, body: { autoScalingGroup: { autoScalingGroupID: 'asg-y' } } },
      'POST /clusters/cluster-x/asg/asg-y/load_balancers': { status: 200, body: { loadBalancer: { loadBalancerID: 'lb-z' } } },
      'GET /clusters/cluster-x/asg/asg-y/load_balancers?maxItems=20': { status: 500, body: { status: 500, title: 'boom' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('lb-verify')
    expect(r.loadBalancerID).toBe('lb-z')
  })
})

// ── 既存シナリオ（正常系・各段の途中失敗でも記録が残ること） ────────────────────────────

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
      'GET /clusters/cluster-x/asg/asg-y/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [{ loadBalancerID: 'lb-z', name: 'myapp' }] } },
    }, calls, (key, body) => { bodies[key] = body }))

    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
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
      'GET /clusters/cluster-x/asg/asg-y/load_balancers?maxItems=20',
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

describe('createClusterFlow: クラスタ作成は200でも getCluster で見つからなければ成功にしない', () => {
  it('POST /clusters が200でも GET /clusters/{id} が失敗したら ok:false（ASGは作らない）。ただしクラスタIDは記録される', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 404, body: { status: 404, title: 'not found' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('cluster-verify')
    expect(calls).not.toContain('POST /clusters/cluster-x/asg')

    // 掟10: 作れたところまでは必ず記録に残る（getClusterの確認が取れなくても）。
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('cluster-x')
  })
})

describe('createClusterFlow: ASG作成が失敗しても、作れたクラスタは記録されている', () => {
  it('POST .../asg が失敗し、名前探しでも見つからなければ、クラスタIDは記録に残るがASGは残らない', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'POST /clusters/cluster-x/asg': { status: 500, body: { status: 500, title: 'internal' } },
      'GET /clusters/cluster-x/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('asg-create')

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('cluster-x')
    expect(rec.asgID).toBeFalsy()
  })
})

describe('createClusterFlow: LB作成が失敗しても、クラスタとASGは記録されている', () => {
  it('POST .../load_balancers が失敗し、名前探しでも見つからなければ、クラスタIDとASG IDは記録に残る', async () => {
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
      'GET /clusters/cluster-x/asg/asg-y/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('lb-create')

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('cluster-x')
    expect(rec.asgID).toBe('asg-y')
    expect(rec.loadBalancerID).toBeFalsy()
  })
})

describe('createClusterFlow: 上限に達していれば作らない', () => {
  it('現在のクラスタ数が上限以上なら stage:limits で止め、クラスタを作らない', async () => {
    consent()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /limits': { status: 200, body: { limit: { clusterCount: 3 } } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [{ clusterID: 'a', name: 'a', created: 1 }, { clusterID: 'b', name: 'b', created: 2 }, { clusterID: 'c', name: 'c', created: 3 }] } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
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
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [{ clusterID: 'a', name: 'a', created: 1 }] } },
      'POST /clusters': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
      'GET /clusters/cluster-x': { status: 500, body: { status: 500, title: 'unreachable in this test' } },
    }, calls))
    const r = await createClusterFlow(AUTH, projectDir, SPEC, CONFIRMED, baseUrl)
    expect(r.stage).not.toBe('limits')
    expect(calls).toContain('POST /clusters')
  })
})

// ── teardownFlow: 既存の基本シナリオ ─────────────────────────────────────────

describe('teardownFlow: LB → ASG → クラスタ の順で呼ばれる', () => {
  it('呼び出し順を配列で検証する', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204, body: {} },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
      'DELETE /clusters/c1/asg/a1': { status: 204, body: {} },
      'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
      'DELETE /clusters/c1': { status: 204, body: {} },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([
      'DELETE /clusters/c1/asg/a1/load_balancers/l1',
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20',
      'DELETE /clusters/c1/asg/a1',
      'GET /clusters/c1/asg?maxItems=20',
      'DELETE /clusters/c1',
      'GET /clusters?maxItems=20',
    ])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBeFalsy()
    expect(rec.asgID).toBeFalsy()
    expect(rec.clusterID).toBeFalsy()
  })
})

// ── C（D-19・2026-09-16）: 破棄したら、記録の IP も消える ─────────────────────────────
//
// 記録の `lbAddresses` は「いまのクラスタのロードバランサの IP」であり、⑧は
// 「DNS の A レコードをこの IP に向けてください」としてそれを出す。**クラスタが無くなれば
// その IP はもう存在しない**ので、記録に残してはいけない（次に作ったクラスタの画面で、
// 前のクラスタの IP を現在のものとして見せることになる）。
// アプリの段（clearAppRecord）は前から消していたが、**アプリを公開していないプロジェクト**
// （⑤でクラスタだけ作り「🔄 IP を取り直す」を押した場合）はその段を通らない。

describe('teardownFlow: C 破棄したあと、記録に IP（lbAddresses）が残らない（D-19）', () => {
  it('★★ アプリを公開していない（記録は クラスタ・ASG・LB と IP だけ）→ 破棄後に lbAddresses が消える', async () => {
    writeApprunDedicatedRecordFs(projectDir, {
      clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', lbAddresses: ['59.106.222.212'],
    })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204, body: {} },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
      'DELETE /clusters/c1/asg/a1': { status: 204, body: {} },
      'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
      'DELETE /clusters/c1': { status: 204, body: {} },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(readApprunDedicatedFs(projectDir).lbAddresses ?? null).toBeNull()
  })

  it('★★ 記録に LB が無く、クラスタだけ消す道でも lbAddresses は消える', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', lbAddresses: ['59.106.222.212'] })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1': { status: 204, body: {} },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(readApprunDedicatedFs(projectDir).lbAddresses ?? null).toBeNull()
  })

  it('★★ 既に消えていた（404＋一覧にも無い）道でも lbAddresses は消える', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', lbAddresses: ['59.106.222.212'] })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1': { status: 404, body: { status: 404, title: 'not found' } },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(readApprunDedicatedFs(projectDir).lbAddresses ?? null).toBeNull()
  })

  it('★★ ロードバランサだけ消せた（ASG で止まった）時点でも、その IP は記録に残らない', async () => {
    writeApprunDedicatedRecordFs(projectDir, {
      clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', lbAddresses: ['59.106.222.212'],
    })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204, body: {} },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
      'DELETE /clusters/c1/asg/a1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false) // ASG は残っている＝課金は続く（そこは従来どおり）
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBeFalsy()
    expect(rec.lbAddresses ?? null).toBeNull() // LB が消えた＝その IP はもう無い
  })

  it('★★ 破棄が LB の段で失敗したときは、記録の IP を消さない（まだ生きている IP まで消さない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, {
      clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', lbAddresses: ['59.106.222.212'],
    })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(readApprunDedicatedFs(projectDir).lbAddresses).toEqual(['59.106.222.212'])
  })
})

describe('teardownFlow: LBだけ失敗（404でも500でもない通常失敗）したら「残っている」と返り、記録からLBが消えない', () => {
  it('LB削除が失敗したら ASG・クラスタの削除は試みず、3つとも記録に残る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('残っています')
    expect(calls).toEqual(['DELETE /clusters/c1/asg/a1/load_balancers/l1'])

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBe('l1')
    expect(rec.asgID).toBe('a1')
    expect(rec.clusterID).toBe('c1')
  })
})

describe('teardownFlow: 記録に無い資源は破棄で触らない', () => {
  it('clusterID しか記録が無ければ、DELETE /clusters/{id} とその後の一覧確認しか呼ばない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1': { status: 204, body: {} },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).toEqual(['DELETE /clusters/c1', 'GET /clusters?maxItems=20'])
  })

  it('記録が何も無ければ、何も呼ばずに ok:true を返す', async () => {
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([])
  })

  it('ASG削除が失敗（404でも500でもない通常失敗）したら、その下のクラスタ削除は試みない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(calls).toEqual(['DELETE /clusters/c1/asg/a1'])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('c1')
    expect(rec.asgID).toBe('a1')
  })
})

// ── H-3 C（2026-09-17）: クラスタの在否判定に readClusterIDs（名前が無い行も拾う）を使う ──────

describe('teardownFlow: H-3 C. クラスタの在否判定は、名前が無い行も「まだ残っている」に数える', () => {
  it('★ DELETE後、一覧に name の無い行として残り続ける間は「消えた」と判定しない（timeoutする）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1': { status: 204, body: {} },
      // 仕様逸脱: 行は残っているが name が無い。readClusterRows なら拾えず「消えた」誤判定になる。
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [{ clusterID: 'c1' }] } },
    }, calls))
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, intervalMs: 1000, timeoutMs: 3000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.inProgress?.clusterID).toBe('c1')
    const rec = readApprunDedicatedFs(projectDir)
    // 「消えた」と誤判定していれば記録から外れてしまう。名前が無くても残っている扱いなので記録は残る。
    expect(rec.clusterID).toBe('c1')
  })

  it('name の無い行が一覧から消えれば、正しく「消えた」と判定する', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    let listCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'DELETE /clusters/c1') return send(204, {})
      if (key === 'GET /clusters?maxItems=20') {
        listCount++
        // 1回目は name の無い行がまだ残っている。2回目で消える。
        return send(200, { clusters: listCount <= 1 ? [{ clusterID: 'c1' }] : [] })
      }
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(listCount).toBe(2)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBeFalsy()
  })

  it('404の経路でも、name の無い行が一覧に残っていれば「残っています」と判定し、記録から外さない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1': { status: 404, body: { status: 404, title: 'not found' } },
      // 仕様逸脱: name が無い行だが実在する。readClusterRows なら拾えず「既に存在しない」誤判定になる。
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [{ clusterID: 'c1' }] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('残っています')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('c1')
  })
})

// ── M-1（2026-09-17）: readClusterIDs と同じ理由をASG・ロードバランサ・アプリケーションの
// 在否判定にも広げる（H-3 C の直前のクラスタ版と同じ形）。 ─────────────────────────────

describe('teardownFlow: M-1. ロードバランサの在否判定は、名前が無い行も「まだ残っている」に数える', () => {
  it('★ DELETE後、一覧に name の無い行として残り続ける間は「消えた」と判定しない（timeoutする）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204, body: {} },
      // 仕様逸脱: 行は残っているが name が無い。readLoadBalancerRows なら拾えず「消えた」誤判定になる。
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [{ loadBalancerID: 'l1' }] } },
    }, calls))
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, intervalMs: 1000, timeoutMs: 3000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.inProgress?.loadBalancerID).toBe('l1')
    const rec = readApprunDedicatedFs(projectDir)
    // 「消えた」と誤判定していれば記録から外れてしまう。名前が無くても残っている扱いなので記録は残る。
    expect(rec.loadBalancerID).toBe('l1')
  })

  it('name の無い行が一覧から消えれば、正しく「消えた」と判定する（壊していないことの固定）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    let lbListCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'DELETE /clusters/c1/asg/a1/load_balancers/l1') return send(204, {})
      if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') {
        lbListCount++
        // 1回目は name の無い行がまだ残っている。2回目で消える。
        return send(200, { loadBalancers: lbListCount <= 1 ? [{ loadBalancerID: 'l1' }] : [] })
      }
      if (key === 'DELETE /clusters/c1/asg/a1') return send(204, {})
      if (key === 'GET /clusters/c1/asg?maxItems=20') return send(200, { autoScalingGroups: [] })
      if (key === 'DELETE /clusters/c1') return send(204, {})
      if (key === 'GET /clusters?maxItems=20') return send(200, { clusters: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(lbListCount).toBe(2)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBeFalsy()
  })
})

describe('teardownFlow: M-1. 404 の経路でも、名前が無い行を「既に存在しない」にしない', () => {
  // DELETE が 404 を返したときは一覧で確かめる。ここで名前の無い行を捨てると
  // 「既に存在しませんでした（記録から外しました）」と表示して**記録から ID を落とす**。
  // 消えていないのに記録が消えると、Koto からは破棄できなくなり課金が止まらない。
  it('★ ロードバランサ: DELETE が 404 でも、name の無い行として残っていれば記録から外さない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 404, body: { status: 404, title: 'Not Found' } },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [{ loadBalancerID: 'l1' }] } },
    }, calls))
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message ?? '').toContain('課金が続きます')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.loadBalancerID).toBe('l1')
  })

  it('ロードバランサ: 本当に一覧から消えていれば、これまでどおり記録から外す（壊していないことの固定）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 404, body: { status: 404, title: 'Not Found' } },
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': { status: 200, body: { loadBalancers: [] } },
      'DELETE /clusters/c1/asg/a1': { status: 204, body: {} },
      'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
      'DELETE /clusters/c1': { status: 204, body: {} },
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    }, calls))
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(readApprunDedicatedFs(projectDir).loadBalancerID).toBeFalsy()
  })

  it('★ ASG: DELETE が 404 でも、name の無い行として残っていれば記録から外さない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1': { status: 404, body: { status: 404, title: 'Not Found' } },
      'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [{ autoScalingGroupID: 'a1' }] } },
    }, calls))
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(readApprunDedicatedFs(projectDir).asgID).toBe('a1')
  })
})

describe('teardownFlow: M-1. ASGの在否判定は、名前が無い行も「まだ残っている」に数える', () => {
  it('★ DELETE後、一覧に name の無い行として残り続ける間は「消えた」と判定しない（timeoutする）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1/asg/a1': { status: 204, body: {} },
      // 仕様逸脱: 行は残っているが name が無い。readAsgRows なら拾えず「消えた」誤判定になる。
      'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [{ autoScalingGroupID: 'a1' }] } },
    }, calls))
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, intervalMs: 1000, timeoutMs: 3000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.inProgress?.asgID).toBe('a1')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.asgID).toBe('a1')
  })

  it('name の無い行が一覧から消えれば、正しく「消えた」と判定する（壊していないことの固定）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    let asgListCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'DELETE /clusters/c1/asg/a1') return send(204, {})
      if (key === 'GET /clusters/c1/asg?maxItems=20') {
        asgListCount++
        return send(200, { autoScalingGroups: asgListCount <= 1 ? [{ autoScalingGroupID: 'a1' }] : [] })
      }
      if (key === 'DELETE /clusters/c1') return send(204, {})
      if (key === 'GET /clusters?maxItems=20') return send(200, { clusters: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(asgListCount).toBe(2)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.asgID).toBeFalsy()
  })
})

describe('teardownFlow: M-1. アプリケーションの在否判定は、name/clusterIDが無い行も「まだ残っている」に数える', () => {
  it('★ DELETE後、一覧に name/clusterID の無い行として残り続ける間は「消えた」と判定しない（timeoutする）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'GET /applications/app1') return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } })
      if (key === 'GET /applications/app1/containers') return send(200, { nodes: [] })
      if (key === 'DELETE /applications/app1') return send(204, {})
      // 仕様逸脱: 行は残っているが name/clusterID が無い。readApplicationRows なら拾えず「消えた」誤判定になる。
      if (key === 'GET /applications?clusterID=c1&maxItems=20') return send(200, { applications: [{ applicationID: 'app1' }] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const sleep = async () => {}
    // appOnly:true にして、この段（アプリ）だけで完結させる（LB/ASG/クラスタのルートを足さずに済む）。
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, intervalMs: 1000, timeoutMs: 3000, appOnly: true }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.inProgress?.applicationID).toBe('app1')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBe('app1')
  })

  it('name/clusterID の無い行が一覧から消えれば、正しく「消えた」と判定する（壊していないことの固定）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    let appListCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'GET /applications/app1') return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } })
      if (key === 'GET /applications/app1/containers') return send(200, { nodes: [] })
      if (key === 'DELETE /applications/app1') return send(204, {})
      if (key === 'GET /applications?clusterID=c1&maxItems=20') {
        appListCount++
        return send(200, { applications: appListCount <= 1 ? [{ applicationID: 'app1' }] : [] })
      }
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, appOnly: true }, baseUrl)
    expect(r.ok).toBe(true)
    expect(appListCount).toBe(2)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBeFalsy()
  })
})

// ── 純関数（本文の組み立て・上限カウント・予約ポート） ──────────────────────────

describe('buildClusterCreateBody（5-2）', () => {
  // F-1（2026-09-16）: letsEncryptEmail は⑤フォームから外し、⑧に一本化した
  // （ApprunDedicatedClusterSpec からも消したので、ここで含める／含めないの分岐は無くなった）。
  it('name/ports/servicePrincipalID を含む', () => {
    const body = buildClusterCreateBody(SPEC)
    expect(body).toEqual({
      name: 'myapp',
      ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }],
      servicePrincipalID: '111111111111',
    })
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

// ── D-2b-2: teardownFlow 先頭のアプリ削除・appOnly ──────────────────────────
// 12-1「破棄はアプリ→LB→ASG→クラスタで組む」・12-2-7「⑥破棄の順序の先頭にアプリ」。
// attemptDeleteApplication は attemptDeleteLoadBalancer と同じ作り（204→一覧から消えるまで
// waitOrStop・404→一覧で確かめる）だが、readApplicationRows に `deleting` が無いため
// 404後の分岐は attemptDeleteCluster と同じ（一覧にまだあれば断定的に「残っています」で止める）。

describe('teardownFlow: D-2b-2 記録に applicationID があれば、LBより先にアプリを削除し、一覧から消えるまで待つ', () => {
  it('DELETE /applications/{id} → 一覧に残っている間は待ち、消えたらLBのDELETEへ進む。app系の記録欄は全部nullに戻る', async () => {
    writeApprunDedicatedRecordFs(projectDir, {
      clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1',
      applicationID: 'app1', applicationName: 'myapp', activeVersion: 3, imageRef: 'img:1',
      hosts: ['app.example.com'], lbAddresses: ['1.2.3.4'], appPublishedAt: '2026-09-01T00:00:00.000Z',
      appPort: 8080, appCpu: 500, appMemory: 512, appFixedScale: 1,
    })
    const calls: string[] = []
    let appListCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      // activeVersion: null（既に無効）を返す——このテストの主眼はDELETE後の一覧待ちなので、
      // 無効化の段（PUT）は関与させない。
      if (key === 'GET /applications/app1') return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } })
      // D-10: コンテナは既に0件（読めた形で空）→ 待たずにDELETEへ進む（このテストの主眼ではない）。
      if (key === 'GET /applications/app1/containers') return send(200, { nodes: [] })
      if (key === 'DELETE /applications/app1') return send(204, {})
      if (key === 'GET /applications?clusterID=c1&maxItems=20') {
        appListCount++
        return send(200, { applications: appListCount <= 2 ? [{ applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: 3 }] : [] })
      }
      if (key === 'DELETE /clusters/c1/asg/a1/load_balancers/l1') return send(204, {})
      if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') return send(200, { loadBalancers: [] })
      if (key === 'DELETE /clusters/c1/asg/a1') return send(204, {})
      if (key === 'GET /clusters/c1/asg?maxItems=20') return send(200, { autoScalingGroups: [] })
      if (key === 'DELETE /clusters/c1') return send(204, {})
      if (key === 'GET /clusters?maxItems=20') return send(200, { clusters: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    let sleepCalls = 0
    const sleep = async () => { sleepCalls++ }
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleepCalls).toBe(2) // 一覧にまだ残っている1回目・2回目のあとで待つ
    expect(appListCount).toBe(3) // 3回目の一覧で消えたと確認する
    // 先頭は「いまのactiveVersionを見る」GET（既にnullなのでPUTは呼ばれない）、次にコンテナの
    // 様子を見るGET（D-10）、その次にDELETE。
    expect(calls[0]).toBe('GET /applications/app1')
    expect(calls.some(c => c.startsWith('PUT '))).toBe(false)
    const appDeleteAt = calls.indexOf('DELETE /applications/app1')
    const lbDeleteAt = calls.indexOf('DELETE /clusters/c1/asg/a1/load_balancers/l1')
    expect(appDeleteAt).toBe(2) // GET→コンテナ確認GETの直後（アプリの削除は他資源より先）
    expect(lbDeleteAt).toBeGreaterThan(appDeleteAt) // LBの削除はアプリが消えたと確認した後
    expect(r.executed.some(e => e.includes('アプリケーション『app1』を削除しました（消えたことを確認）'))).toBe(true)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBeFalsy()
    expect(rec.applicationName).toBeFalsy()
    expect(rec.activeVersion).toBeFalsy()
    expect(rec.imageRef).toBeFalsy()
    expect(rec.hosts).toBeFalsy()
    expect(rec.lbAddresses).toBeFalsy()
    expect(rec.appPublishedAt).toBeFalsy()
    expect(rec.appPort).toBeFalsy()
    expect(rec.appCpu).toBeFalsy()
    expect(rec.appMemory).toBeFalsy()
    expect(rec.appFixedScale).toBeFalsy()
    expect(rec.loadBalancerID).toBeFalsy()
    expect(rec.asgID).toBeFalsy()
    expect(rec.clusterID).toBeFalsy()
  })
})

describe('teardownFlow: D-2b-2 appOnly:true はアプリケーションの段だけ行い、LB/ASG/クラスタには一切触らない', () => {
  it('記録にアプリ・クラスタ・ASG・LBが揃っていても、DELETEは /applications/{id} の1本だけ', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      // activeVersion: null（既に無効）なのでPUTは呼ばれない。
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      // D-10: コンテナは既に0件（読めた形で空）→ 待たずにDELETEへ進む。
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 204, body: {} },
      'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls.filter(c => c.startsWith('DELETE ')).length).toBe(1)
    expect(calls).toEqual([
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications?clusterID=c1&maxItems=20',
    ])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBeFalsy()
    // appOnly はLB/ASG/クラスタに触らない——記録に残ったまま。
    expect(rec.clusterID).toBe('c1')
    expect(rec.asgID).toBe('a1')
    expect(rec.loadBalancerID).toBe('l1')
  })

  it('appOnly かつ記録にアプリが無ければ、fetchを一切呼ばず ok:true（LB等の記録も変わらない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.clusterID).toBe('c1')
    expect(rec.asgID).toBe('a1')
    expect(rec.loadBalancerID).toBe('l1')
  })
})

describe('teardownFlow: D-2b-2 アプリの削除が失敗したら、LBには進まず remaining.applicationID が残る', () => {
  it('DELETE /applications/{id} が通常失敗（404でも204でもない）→ LBのDELETEは呼ばれず、remaining.applicationID が立つ。記録は全部残る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      // activeVersion: null（既に無効）なのでPUTは呼ばれず、DELETEへ直接進む。
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(calls).toEqual(['GET /applications/app1', 'GET /applications/app1/containers', 'DELETE /applications/app1'])
    expect(calls.some(c => c.includes('load_balancers'))).toBe(false)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBe('app1')
    expect(rec.loadBalancerID).toBe('l1')
    expect(rec.asgID).toBe('a1')
    expect(rec.clusterID).toBe('c1')
  })
})

// ── B（2026-09-17）: アプリの削除で止まっても、下位資源(LB/ASG/クラスタ)を remaining/inProgress に示す ──

describe('teardownFlow: B. アプリの削除で止まったとき、remaining/inProgress にLB・ASG・クラスタも載る', () => {
  it('★ アプリの削除が通常失敗すると、remaining にロードバランサ・ASG・クラスタが載る（appOnly指定なし）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(r.remaining.loadBalancerID).toBe('l1')
    expect(r.remaining.asgID).toBe('a1')
    expect(r.remaining.clusterID).toBe('c1')
    // LB/ASG/クラスタには一度も触っていない（表示だけを足した。実際のDELETEは飛ばない）。
    expect(calls.some(c => c.startsWith('DELETE /clusters'))).toBe(false)
  })

  it('★ ただし appOnly:true のときは remaining に載らない（わざと残す仕様を壊していないことの固定）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(r.remaining.loadBalancerID).toBeUndefined()
    expect(r.remaining.asgID).toBeUndefined()
    expect(r.remaining.clusterID).toBeUndefined()
  })

  it('★ 時間切れ（timeout）のときも同じ形で inProgress にLB・ASG・クラスタが載る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 204, body: {} },
      // 一覧から消えない→ timeout。
      'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [{ applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null }] } },
    }, calls))
    const sleep = async () => {}
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, intervalMs: 1000, timeoutMs: 3000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.inProgress?.applicationID).toBe('app1')
    expect(r.inProgress?.loadBalancerID).toBe('l1')
    expect(r.inProgress?.asgID).toBe('a1')
    expect(r.inProgress?.clusterID).toBe('c1')
    expect(r.remaining.loadBalancerID).toBe('l1')
    expect(r.remaining.asgID).toBe('a1')
    expect(r.remaining.clusterID).toBe('c1')
  })
})

// ── D-9（2026-09-16 実機実測）: DELETEの前に、有効なバージョンを無効化してから確かめる ──────
//
// 専有型の⑥「すべて削除する」で、アプリの削除が実際に HTTP 400
// `{"status":400,"title":"Cannot delete application because it has active version"}` で
// 失敗した（0.6.19-rc.1 実機）。有効なバージョン（activeVersion）を持ったままでは削除できない
// ため、DELETEの前に getApplication→（必要なら）updateApplication で無効化→再確認、を挟む
// （ensureApplicationDeactivated）。appOnly:true でアプリの段だけを切り出して確かめる
// （LB/ASG/クラスタは無関係）。

describe('teardownFlow: D-9 DELETEの前に有効なバージョンを無効化する（2026-09-16実機実測の400対応）', () => {
  it('(a) activeVersion:1 → PUTが呼ばれ本文が{"activeVersion":null}、再取得でnullを確かめてからDELETEが呼ばれる（順序を固定）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const bodies: Record<string, any> = {}
    let getCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        if (raw) { try { bodies[key] = JSON.parse(raw) } catch { bodies[key] = raw } }
        const send = (status: number, body: unknown) => {
          if (status === 204) { res.writeHead(204); res.end(); return }
          res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
        }
        if (key === 'GET /applications/app1') {
          getCount++
          // 1回目: activeVersion:1（無効化が要る）。2回目（PUT後の確認）: null。
          const activeVersion = getCount === 1 ? 1 : null
          return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion } })
        }
        if (key === 'PUT /applications/app1') return send(204, {})
        // D-10: コンテナは既に0件（読めた形で空）→ 待たずにDELETEへ進む。
        if (key === 'GET /applications/app1/containers') return send(200, { nodes: [] })
        if (key === 'DELETE /applications/app1') return send(204, {})
        if (key === 'GET /applications?clusterID=c1&maxItems=20') return send(200, { applications: [] })
        send(404, { error: `test router: 未定義のルート ${key}` })
      })
    })
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(true)
    // 要求の順序を並びごと固定する。
    expect(calls).toEqual([
      'GET /applications/app1',
      'PUT /applications/app1',
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications?clusterID=c1&maxItems=20',
    ])
    expect(bodies['PUT /applications/app1']).toEqual({ activeVersion: null })
    expect(r.executed.some(e => e.includes('アプリケーション『app1』のバージョンを無効にしました'))).toBe(true)
  })

  it('(b) activeVersion:null → PUTを呼ばずにDELETEへ進む', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 204, body: {} },
      'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications?clusterID=c1&maxItems=20',
    ])
    expect(calls.some(c => c.startsWith('PUT '))).toBe(false)
    expect(r.executed.some(e => e.includes('のバージョンを無効にしました'))).toBe(false)
  })

  it('(c) DELETEが400「Cannot delete application because it has active version」→ 無効化からやり直し、2回目のDELETEで成功する', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    let getCount = 0
    let deleteCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'GET /applications/app1') {
        getCount++
        // 1回目: null（1回目のDELETEが400になるまでは無効化不要に見える）。
        // 2回目（やり直しの確認）: 5（実は残っていた）。3回目（PUT後の確認）: null。
        const activeVersion = getCount === 2 ? 5 : null
        return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion } })
      }
      if (key === 'PUT /applications/app1') return send(204, {})
      // D-10: コンテナは既に0件（読めた形で空）→ 待たずにDELETEへ進む（このテストの主眼ではない）。
      if (key === 'GET /applications/app1/containers') return send(200, { nodes: [] })
      if (key === 'DELETE /applications/app1') {
        deleteCount++
        if (deleteCount === 1) {
          return send(400, { status: 400, title: 'Cannot delete application because it has active version' })
        }
        return send(204, {})
      }
      if (key === 'GET /applications?clusterID=c1&maxItems=20') return send(200, { applications: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(true)
    expect(deleteCount).toBe(2)
    expect(calls).toEqual([
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications/app1',
      'PUT /applications/app1',
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications?clusterID=c1&maxItems=20',
    ])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBeFalsy()
  })

  it('(d) 3回やり直しても400のまま→止まり、remaining.applicationIDが残り、messageに生の応答が載る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const rawTitle = 'Cannot delete application because it has active version'
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'DELETE /applications/app1': { status: 400, body: { status: 400, title: rawTitle } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(r.message).toContain(rawTitle) // 生の応答（title）がmessageに載る
    expect(calls.filter(c => c === 'DELETE /applications/app1').length).toBe(3)
    expect(calls.filter(c => c === 'GET /applications/app1').length).toBe(3)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBe('app1')
  })

  it('(e) getApplicationが失敗しても、無効化を試みてからDELETEに進む（黙って成功に倒さない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    let getCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'GET /applications/app1') {
        getCount++
        if (getCount === 1) return send(500, { status: 500, title: 'boom' }) // 1回目は取れない（分からない）
        return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } }) // 無効化後の確認
      }
      if (key === 'PUT /applications/app1') return send(204, {})
      // D-10: コンテナは既に0件（読めた形で空）→ 待たずにDELETEへ進む（このテストの主眼ではない）。
      if (key === 'GET /applications/app1/containers') return send(200, { nodes: [] })
      if (key === 'DELETE /applications/app1') return send(204, {})
      if (key === 'GET /applications?clusterID=c1&maxItems=20') return send(200, { applications: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(true)
    // 取れなかった（1回目のGETが500）のに「無効化不要」に倒さず、PUTを試みている。
    expect(calls).toEqual([
      'GET /applications/app1',
      'PUT /applications/app1',
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications?clusterID=c1&maxItems=20',
    ])
  })
})

// ── D-10（2026-09-16 実機実測・課金が止まらない穴）: 無効化しても、動いているコンテナは
// 即座には消えない。DELETEの400には「active version」以外に「currently running」もある ────
//
// 実機で⑥「すべて削除する」が「アプリケーションの削除に失敗しました。残っています＝
// 課金が続きます: Cannot delete application because it is currently running（HTTP 400）」で
// 止まった。無効化（バージョンを無効にする）自体は成功していたが、コンテナの停止と撤去は
// 非同期（1分ごとの周期）で、直後にDELETEを撃つとまだ動いているコンテナに当たる。
// 判定は appDeleteRetryable（src/shared/apprunDedicatedApp.ts）1か所に集約し、DELETEの前に
// コンテナが0件になるまで待つ段（waitUntilGoneの再利用）を足した。

describe('teardownFlow: D-10 DELETEが400「currently running」でもやり直す（2026-09-16実機実測）', () => {
  it('★ 回帰: 1回目400「currently running」→ やり直し、2回目のDELETEで成功する（破棄が最後まで進む）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    let deleteCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'GET /applications/app1') return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } })
      // コンテナは既に0件（読めた形で空）→ 待たずにDELETEへ進む（このテストの主眼はDELETEのやり直し）。
      if (key === 'GET /applications/app1/containers') return send(200, { nodes: [] })
      if (key === 'DELETE /applications/app1') {
        deleteCount++
        if (deleteCount === 1) {
          return send(400, { status: 400, title: 'Cannot delete application because it is currently running' })
        }
        return send(204, {})
      }
      if (key === 'GET /applications?clusterID=c1&maxItems=20') return send(200, { applications: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(true)
    expect(deleteCount).toBe(2)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBeFalsy()
  })

  it('★ 3回とも400「currently running」なら、課金が続くことを隠さずに止める（「有効なバージョン」とは書かない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const rawTitle = 'Cannot delete application because it is currently running'
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 400, body: { status: 400, title: rawTitle } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(r.message).toContain('課金が続きます')
    expect(r.message).not.toContain('有効なバージョン') // 理由が違うのに決め打ちの文面を出すと嘘になる
    expect(calls.filter(c => c === 'DELETE /applications/app1').length).toBe(3)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBe('app1')
  })

  it('★ やり直せない400（別の文言）は、やり直さずに1回で止まる（止めすぎ・やり直しすぎの両方を固定）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 400, body: { status: 400, title: 'Some other reason entirely' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(calls.filter(c => c === 'DELETE /applications/app1').length).toBe(1) // やり直していない
    expect(r.message).toContain('残っています')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBe('app1')
  })
})

describe('teardownFlow: D-10 DELETEの前にコンテナが0件になるまで待つ（waitUntilGoneの再利用）', () => {
  it('★ コンテナ一覧の取得自体が失敗しても、待たずに破棄は進む（読めないことを理由に止めない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    let sleepCalls = 0
    const sleep = async () => { sleepCalls++ }
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 500, body: { status: 500, title: 'boom' } },
      'DELETE /applications/app1': { status: 204, body: {} },
      'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleepCalls).toBe(0) // 待ちループには入らない（読めない＝0件と読み替えず、そのままDELETE）
    expect(calls).toEqual([
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications?clusterID=c1&maxItems=20',
    ])
    expect(r.executed.some(e => e.includes('時間切れ'))).toBe(false)
  })

  it('★ コンテナ一覧は200でも形が読めない（readContainerStatesがnull）ときも、0件と読み替えず待たずに進む', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    let sleepCalls = 0
    const sleep = async () => { sleepCalls++ }
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      // 200だが原本の形（nodes配列）ではない。
      'GET /applications/app1/containers': { status: 200, body: { foo: 'bar' } },
      'DELETE /applications/app1': { status: 204, body: {} },
      'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleepCalls).toBe(0)
    expect(calls).toEqual([
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications?clusterID=c1&maxItems=20',
    ])
  })

  it('コンテナが1件→0件になったら、待ちを抜けてDELETEする（進捗メッセージが1回出る）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    let containersCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'GET /applications/app1') return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } })
      if (key === 'GET /applications/app1/containers') {
        containersCount++
        // 1・2回目: 1件動いている。3回目: 0件（止まった）。
        const running = containersCount <= 2
        return send(200, { nodes: [{ containersStats: running ? [{ state: 'Running', status: 'running' }] : [] }] })
      }
      if (key === 'DELETE /applications/app1') return send(204, {})
      if (key === 'GET /applications?clusterID=c1&maxItems=20') return send(200, { applications: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
    let sleepCalls = 0
    const sleep = async () => { sleepCalls++ }
    const progressMsgs: string[] = []
    const r = await teardownFlow(
      AUTH, projectDir, { confirmed: true, appOnly: true, sleep, progress: m => progressMsgs.push(m) }, baseUrl,
    )
    expect(r.ok).toBe(true)
    expect(containersCount).toBe(3) // 初回の確認1回＋待ちループで2回（3回目に0件を確認）
    expect(sleepCalls).toBe(1) // 「まだ残っている」で待つのは1回だけ
    expect(progressMsgs).toContain('コンテナが止まるのを待っています…')
    const deleteAt = calls.indexOf('DELETE /applications/app1')
    const lastContainersAt = calls.lastIndexOf('GET /applications/app1/containers')
    expect(deleteAt).toBeGreaterThan(lastContainersAt) // 0件を確認したあとにDELETE
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBeFalsy()
  })
})
