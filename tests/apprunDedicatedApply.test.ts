import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createClusterFlow,
  teardownFlow,
  appStopWaitProgressMessage,
  appDeactivateWaitProgressMessage,
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
import { appStageOnly as appStageOnlyOf } from './dedicatedAppStage-harness'
import { appDeleteTransientFailure } from '../src/shared/apprunDedicatedApp'

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

/** アプリの段だけを取り出して実行する（tests/dedicatedAppStage-harness.ts。旧 appOnly の代わり）。 */
const appStageOnly = (opts: Parameters<typeof teardownFlow>[2], baseUrl: string) => appStageOnlyOf(AUTH, projectDir, opts, baseUrl)

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
    expect(r.message).toContain('残っている間は課金が続きます')
    expect(r.message).not.toContain('＝課金が続きます') // 0.6.21（作者の決定 2026-10-01）: 「＝」のメモ書きは文にした。直す前の言い方は戻さない
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
    expect(r.message).toContain('一覧でも確認できなかったため')
    expect(r.message).toContain('残っていて課金が続いている可能性があります')
    // 確かめていないのに「残っています」と言い切らない（0.6.21）
    expect(r.message).not.toContain('残っています')
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
    expect(r.message).toContain('残っている間は課金が続きます')
    expect(r.message).not.toContain('＝課金が続きます') // 0.6.21（作者の決定 2026-10-01）: 「＝」のメモ書きは文にした。直す前の言い方は戻さない
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

  it('404の経路でも、name の無い行が一覧に残っていれば「残っている」と判定し、記録から外さない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'DELETE /clusters/c1': { status: 404, body: { status: 404, title: 'not found' } },
      // 仕様逸脱: name が無い行だが実在する。readClusterRows なら拾えず「既に存在しない」誤判定になる。
      'GET /clusters?maxItems=20': { status: 200, body: { clusters: [{ clusterID: 'c1' }] } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('残っている間は課金が続きます')
    expect(r.message).not.toContain('＝課金が続きます') // 0.6.21（作者の決定 2026-10-01）: 「＝」のメモ書きは文にした。直す前の言い方は戻さない
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
    // アプリの段だけで完結させる（appStageOnly。LB/ASG/クラスタのルートを足さずに済む）。
    const r = await appStageOnly({ confirmed: true, sleep, intervalMs: 1000, timeoutMs: 3000 }, baseUrl)
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
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
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

// ── D-2b-2: teardownFlow 先頭のアプリ削除 ──────────────────────────
// 12-1「破棄はアプリ→LB→ASG→クラスタで組む」・12-2-7「⑥破棄の順序の先頭にアプリ」。
// attemptDeleteApplication は attemptDeleteLoadBalancer と同じ作り（204→一覧から消えるまで
// waitOrStop・404→一覧で確かめる）だが、readApplicationRows に `deleting` が無いため
// 404後の分岐は attemptDeleteCluster と同じ（一覧にまだあれば断定的に「残っている間は課金が続きます」で止める）。

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

describe('teardownFlow: 2026-10-08 アプリだけを消す口（appOnly）は廃止した。古い呼び出しの名残があっても、必ず LB/ASG/クラスタまで消す', () => {
  // 手順6も 📡 の 🗑 も同じ流れ（アプリ → ロードバランサ → オートスケーリンググループ → クラスタ）。
  // 「アプリだけで止まる」分岐が黙って戻ると、クラスタ・ロードバランサ（月額およそ2万2千円）が残る。
  // 戻ったかどうかを、旧い呼び出しの形（appOnly: true を渡す）で確かめる。
  const ALL_ROUTES: Record<string, Route> = {
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
  }

  it('★ appOnly: true を渡されても、アプリ → LB → ASG → クラスタ の順に4本とも DELETE する。記録は全部空になる', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer(ALL_ROUTES, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true, sleep: async () => {} } as any, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls.filter(c => c.startsWith('DELETE '))).toEqual([
      'DELETE /applications/app1',
      'DELETE /clusters/c1/asg/a1/load_balancers/l1',
      'DELETE /clusters/c1/asg/a1',
      'DELETE /clusters/c1',
    ])
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBeFalsy()
    expect(rec.loadBalancerID).toBeFalsy()
    expect(rec.asgID).toBeFalsy()
    expect(rec.clusterID).toBeFalsy()
  })

  it('★ 記録にアプリが無くても（appOnly: true を渡されても）、LB/ASG/クラスタは消す', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer(ALL_ROUTES, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true, sleep: async () => {} } as any, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls.filter(c => c.startsWith('DELETE '))).toEqual([
      'DELETE /clusters/c1/asg/a1/load_balancers/l1',
      'DELETE /clusters/c1/asg/a1',
      'DELETE /clusters/c1',
    ])
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
  it('★ アプリの削除が通常失敗すると、remaining にロードバランサ・ASG・クラスタが載る', async () => {
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

  it('★ 旧い appOnly: true を渡されても、remaining に載る（「わざと残す」仕様は廃止した。載せないと課金が続くものが見えない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 500, body: { status: 500, title: 'fail' } },
    }, calls))
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, appOnly: true } as any, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(r.remaining.loadBalancerID).toBe('l1')
    expect(r.remaining.asgID).toBe('a1')
    expect(r.remaining.clusterID).toBe('c1')
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
// （ensureApplicationDeactivated）。appStageOnly でアプリの段だけを切り出して確かめる
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
    const r = await appStageOnly({ confirmed: true }, baseUrl)
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
    const r = await appStageOnly({ confirmed: true }, baseUrl)
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
    // 2026-10-07: やり直す前に待つ（既定15秒）。実際には待たず、sleep を偽物にして呼ばれ方だけ見る。
    const sleeps: number[] = []
    const sleep = async (ms: number) => { sleeps.push(ms) }
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(deleteCount).toBe(2)
    expect(sleeps).toEqual([15000]) // やり直す前に1回だけ待つ（間を置かずに打たない）
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

  it('(d) 待ってやり直しても（合計の上限まで）400のまま→止まり、remaining.applicationIDが残り、messageに生の応答が載る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const rawTitle = 'Cannot delete application because it has active version'
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'DELETE /applications/app1': { status: 400, body: { status: 400, title: rawTitle } },
    }, calls))
    // 2026-10-07: 回数の上限（3回）は無い。合計の待ち時間の上限（timeoutMs）で止まる。
    // 上限60秒・間隔15秒＝待ち4回・DELETE 5回（待った合計が60秒になった回で、もう一度試して止まる）。
    const sleep = async () => { /* 実際には待たない */ }
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 60_000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(r.message).toContain(rawTitle) // 生の応答（title）がmessageに載る
    expect(calls.filter(c => c === 'DELETE /applications/app1').length).toBe(5)
    // 「active version」のときは、やり直すたびに無効化の確認（GET）からやり直す。
    expect(calls.filter(c => c === 'GET /applications/app1').length).toBe(5)
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
    const r = await appStageOnly({ confirmed: true }, baseUrl)
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
    const sleep = async () => { /* 実際には待たない（待ちの中身は下の「2026-10-07」の節で固定する） */ }
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(deleteCount).toBe(2)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBeFalsy()
  })

  it('★ 待っても400「currently running」のままなら、課金が続くことを隠さずに止める（「有効なバージョン」とは書かない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const rawTitle = 'Cannot delete application because it is currently running'
    const baseUrl = await listen(routedServer({
      'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
      'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
      'DELETE /applications/app1': { status: 400, body: { status: 400, title: rawTitle } },
    }, calls))
    const sleep = async () => { /* 実際には待たない */ }
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 60_000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(r.message).toContain('クラスタなどの課金は続いています')
    expect(r.message).not.toContain('アプリが消えるまで')
    expect(r.message).not.toContain('有効なバージョン') // 理由が違うのに決め打ちの文面を出すと嘘になる
    expect(calls.filter(c => c === 'DELETE /applications/app1').length).toBe(5) // 上限（60秒）まで、15秒おきに試した
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
    const r = await appStageOnly({ confirmed: true }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.remaining.applicationID).toBe('app1')
    expect(calls.filter(c => c === 'DELETE /applications/app1').length).toBe(1) // やり直していない
    expect(r.message).toContain('残っている間は課金が続きます')
    expect(r.message).not.toContain('＝課金が続きます') // 0.6.21（作者の決定 2026-10-01）: 「＝」のメモ書きは文にした。直す前の言い方は戻さない
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
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
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
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
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
    const r = await appStageOnly(
      { confirmed: true, sleep, progress: m => progressMsgs.push(m) }, baseUrl,
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


// ── 2026-10-07（実機実測・0.6.20-rc.6）: DELETE が400「まだ動いている」で断られたら、**待ってから**やり直す ──────
//
// 📡 公開したもの一覧から専有型のアプリ（landingTEST）の 🗑 を押すと、**すぐに**
// 「破棄できませんでした: アプリケーションの削除に失敗しました。コンテナの停止が終わりません＝課金が続きます:
//  Cannot delete application because it is currently running（HTTP 400）」になった。
// 以前は、400のあと**間を置かずに**やり直して3回で止まったため、コンテナの停止が終わっていないと
// 1〜2秒で3回とも400になっていた。いまは、間隔（既定15秒）を置いて、合計の上限（既定10分）まで粘る。
// 入口は2つ（📡 の🗑・手順6のすべて削除）で、どちらも同じ apprunDedicated:teardown ＝ teardownFlow ＝ attemptDeleteApplication を通る
// （2026-10-08 まで📡の🗑は appOnly という別の口だった）。アプリの段は appStageOnly で、全部の流れは teardownFlow で固める。
// お金・破壊の歯止めなので、偽サーバに実際に流して**呼ばれた要求の一覧・sleep の呼ばれ方**で固定する（掟10）。

/** status 0 は「通信の切れ」（応答を返さずソケットを切る＝fetch が例外になる。HTTP のステータスは付かない）。 */
type StopDelete = { status: number; title?: string }
const RUNNING_TITLE = 'Cannot delete application because it is currently running'
const ACTIVE_TITLE = 'Cannot delete application because it has active version'

/** DELETE /applications/app1 の n 回目（1始まり）の応答を決める。204 を返すまで（または上限まで）続く。 */
type StopCfg = {
  deleteAt: (n: number) => StopDelete
  /** GET /applications/app1/containers の応答（既定: 読めた形で0件）。 */
  containers?: Route
  /** containers の応答を、そこまでの DELETE の回数などで切り替えたいとき用（あれば containers より優先）。 */
  containersFn?: (c: StopCounters) => Route
  /** PUT（無効化）のあと、有効なバージョンが「まだ非null」のまま見える GET の回数（無効化の確認の待ちを作る）。既定 0。 */
  lagGetsAfterPut?: number
  /** 400 を返したあと、有効なバージョンが「また付いた」状態にする（無効化がまだ効いていない状況）。PUT で null に戻る。 */
  rearmActiveVersionAfter400?: boolean
  /** ⑥の全部破棄用に、LB/ASG/クラスタの応答も足す（すべて204→一覧は空）。 */
  full?: boolean
}
type StopCounters = { deletes: number; puts: number; getApp: number }

function stopServer(calls: string[], cfg: StopCfg, c: StopCounters): http.RequestListener {
  let activeVersion: number | null = null
  // PUT のあと、あと何回の GET が「まだ非null」を返すか（無効化の確認の待ちを作る）。
  let lagLeft = 0
  return (req, res) => {
    const key = `${req.method} ${req.url}`
    calls.push(key)
    req.on('data', () => { /* 本文は読み捨てる */ })
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'GET /applications/app1') {
        c.getApp++
        if (lagLeft > 0 && activeVersion === null) { lagLeft--; return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: 4 } }) }
        return send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion } })
      }
      if (key === 'PUT /applications/app1') { c.puts++; activeVersion = null; lagLeft = cfg.lagGetsAfterPut ?? 0; return send(204, {}) }
      if (key === 'GET /applications/app1/containers') {
        const r = cfg.containersFn ? cfg.containersFn(c) : (cfg.containers ?? { status: 200, body: { nodes: [] } })
        return send(r.status, r.body)
      }
      if (key === 'DELETE /applications/app1') {
        c.deletes++
        const d = cfg.deleteAt(c.deletes)
        if (d.status === 204) return send(204, {})
        if (d.status === 0) { req.socket.destroy(); return }
        if (cfg.rearmActiveVersionAfter400) activeVersion = 4
        return send(d.status, { status: d.status, title: d.title ?? 'boom' })
      }
      if (key === 'GET /applications?clusterID=c1&maxItems=20') return send(200, { applications: [] })
      if (cfg.full) {
        if (key === 'DELETE /clusters/c1/asg/a1/load_balancers/l1') return send(204, {})
        if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') return send(200, { loadBalancers: [] })
        if (key === 'DELETE /clusters/c1/asg/a1') return send(204, {})
        if (key === 'GET /clusters/c1/asg?maxItems=20') return send(200, { autoScalingGroups: [] })
        if (key === 'DELETE /clusters/c1') return send(204, {})
        if (key === 'GET /clusters?maxItems=20') return send(200, { clusters: [] })
      }
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
  }
}

const newCounters = (): StopCounters => ({ deletes: 0, puts: 0, getApp: 0 })
/** 実際には待たず、呼ばれた間隔（ms）だけを記録する sleep。 */
function recordingSleep(): { sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = []
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms) } }
}

describe('teardownFlow: 2026-10-07 アプリの削除が400「currently running」で断られたら、待ってからやり直す', () => {
  it('★ アプリの段: 400が3回続いたあと204 → 成功。15秒おきに3回待ち、無効化は打ち直さず、進み具合が待つたびに出る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n <= 3 ? { status: 400, title: RUNNING_TITLE } : { status: 204 }),
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const progress: string[] = []
    const r = await appStageOnly({ confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok).toBe(true)
    expect(c.deletes).toBe(4) // 3回断られて、4回目で受け付けられた
    expect(sleeps).toEqual([15000, 15000, 15000]) // 待ち3回・既定の間隔（15秒）
    // 「currently running」では無効化を打ち直さない（無効化の確認の GET も最初の1回だけ・PUT は0回）。
    expect(c.getApp).toBe(1)
    expect(c.puts).toBe(0)
    // 待つたびに進み具合が出る（3回待った＝3回出る。15秒・30秒のうちは経過を書かない）。
    const waiting = progress.filter(m => m.includes('アプリのコンテナが止まるのを待っています'))
    expect(waiting).toEqual([
      'アプリのコンテナが止まるのを待っています…',
      'アプリのコンテナが止まるのを待っています…',
      'アプリのコンテナが止まるのを待っています（1分経過）…',
    ])
    // 受け付けられたあとの確認は従来どおり（一覧から消えたのを確かめて、記録を外す）。
    expect(r.executed.some(e => e.includes('アプリケーション『app1』を削除しました（消えたことを確認）'))).toBe(true)
    expect(readApprunDedicatedFs(projectDir).applicationID).toBeFalsy()
  })

  it('★ すべて削除（teardownFlow 全体）でも同じ: 400が3回続いたあと204 → アプリが消えてから LB → ASG → クラスタへ進む', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n <= 3 ? { status: 400, title: RUNNING_TITLE } : { status: 204 }),
      full: true,
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const progress: string[] = []
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok).toBe(true)
    expect(c.deletes).toBe(4)
    expect(sleeps).toEqual([15000, 15000, 15000])
    expect(c.puts).toBe(0)
    expect(progress.filter(m => m.includes('アプリのコンテナが止まるのを待っています')).length).toBe(3)
    // 順序: アプリの4回目の DELETE が先、そのあとで LB → ASG → クラスタ（アプリが消える前に下位へ進まない）。
    const lastAppDelete = calls.lastIndexOf('DELETE /applications/app1')
    const lbDelete = calls.indexOf('DELETE /clusters/c1/asg/a1/load_balancers/l1')
    const asgDelete = calls.indexOf('DELETE /clusters/c1/asg/a1')
    const clusterDelete = calls.indexOf('DELETE /clusters/c1')
    expect(lastAppDelete).toBeGreaterThanOrEqual(0)
    expect(lbDelete).toBeGreaterThan(lastAppDelete)
    expect(asgDelete).toBeGreaterThan(lbDelete)
    expect(clusterDelete).toBeGreaterThan(asgDelete)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBeFalsy()
    expect(rec.clusterID).toBeFalsy()
  })

  it('★ 待ち間隔は opts.deleteRetryIntervalMs で差し替えられる（既定は15秒）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n <= 2 ? { status: 400, title: RUNNING_TITLE } : { status: 204 }),
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, deleteRetryIntervalMs: 1000 }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([1000, 1000])
  })

  it('★ 合計の上限（timeoutMs）に達したら止まる。記録は消さず、次にすることが分かる文面＋生の応答が載り、inProgress は立てない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: () => ({ status: 400, title: RUNNING_TITLE }), full: true }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, timeoutMs: 60_000 }, baseUrl)
    expect(r.ok).toBe(false)
    // 上限60秒・間隔15秒＝待ち4回。待った合計が60秒になった回でもう一度試して、それでも断られたら止まる（DELETE 5回）。
    expect(sleeps).toEqual([15000, 15000, 15000, 15000])
    expect(c.deletes).toBe(5)
    // 「3回で即失敗」の形が残っていない。
    expect(c.deletes).not.toBe(3)
    // 記録（remaining と、ディスク上の applicationID）は消さない＝もう一度押せば続きから進む。
    expect(r.remaining.applicationID).toBe('app1')
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
    // 下位（LB/ASG/クラスタ）には触らない・記録も残す。
    expect(calls.some(x => x.startsWith('DELETE /clusters'))).toBe(false)
    expect(r.remaining.clusterID).toBe('c1')
    // 次にすることが分かる文面＋生の応答。新しい文では「＝」のメモ書きを使わない。
    expect(r.message).toContain('まだコンテナが止まっていません')
    expect(r.message).toContain('しばらくしてから、もう一度押してください')
    expect(r.message).toContain('無効化済み')
    expect(r.message).toContain(RUNNING_TITLE) // 生の応答
    expect(r.message).not.toContain('＝')
    // 受け付けられていない（DELETE は断られた）ので、「削除を受け付けました」の inProgress にはしない。
    expect(r.inProgress).toBeUndefined()
  })

  it('★ 上限で止まったあと、もう一度押せば続きから進む（記録が残っているので、受け付けられれば消える）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    let accepting = false
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => (accepting ? { status: 204 } : { status: 400, title: RUNNING_TITLE }),
    }, c))
    const { sleep } = recordingSleep()
    const first = await appStageOnly({ confirmed: true, sleep, timeoutMs: 30_000 }, baseUrl)
    expect(first.ok).toBe(false)
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
    accepting = true // コンテナが止まった
    const second = await appStageOnly({ confirmed: true, sleep, timeoutMs: 30_000 }, baseUrl)
    expect(second.ok).toBe(true)
    expect(readApprunDedicatedFs(projectDir).applicationID).toBeFalsy()
  })

  it('★ 既定の合計の上限は10分（waitUntilGone と同じ）: 15秒おき40回待って、DELETE は41回目で止まる', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: () => ({ status: 400, title: RUNNING_TITLE }) }, c))
    const { sleeps, sleep } = recordingSleep()
    const progress: string[] = []
    const r = await appStageOnly({ confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps.length).toBe(40)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(10 * 60 * 1000)
    expect(c.deletes).toBe(41)
    // 進み具合: 最初は経過なし、30秒を過ぎたら「N分経過」（実際より長く見せない）。最後は10分近い。
    const waiting = progress.filter(m => m.includes('アプリのコンテナが止まるのを待っています'))
    expect(waiting.length).toBe(40)
    expect(waiting[0]).toBe('アプリのコンテナが止まるのを待っています…')
    expect(waiting[1]).toBe('アプリのコンテナが止まるのを待っています…')
    expect(waiting[2]).toBe('アプリのコンテナが止まるのを待っています（1分経過）…')
    expect(waiting[39]).toBe('アプリのコンテナが止まるのを待っています（10分経過）…')
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
  })

  it('★ 待ちの合計には、コンテナが止まるのを待った分も数える（上限は「この段の合計」）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    // コンテナが止まらずに動き続ける（読めた形で1件）。DELETE は断られ続ける。
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 400, title: RUNNING_TITLE }),
      containers: { status: 200, body: { nodes: [{ containersStats: [{ state: 'running', status: 'Up 5 minutes' }] }] } },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 30_000 }, baseUrl)
    expect(r.ok).toBe(false)
    // コンテナの待ち（5秒おき・上限30秒＝6回）で上限を使い切っているので、DELETE は1回だけ試して止まる。
    expect(sleeps).toEqual([5000, 5000, 5000, 5000, 5000, 5000])
    expect(c.deletes).toBe(1)
    expect(r.executed.some(e => e.includes('時間切れ'))).toBe(true)
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
  })

  // 読めない形（null＝未確認）。原本の形（containersStats が { collectedAtSec, containers } のオブジェクト）は、2026-10-08 から読める
  // ＝読めない形ではない（下の「原本の形で…」のテストで固定する）。直す前は、原本の example がまさにここに入っていた
  // （本物の応答は常に「読めない」になり、コンテナの停止待ちは一度も効いていなかった）。
  const unreadableContainers: [string, Route][] = [
    ['一覧の取得が失敗（500）', { status: 500, body: { status: 500, title: 'boom' } }],
    ['200 だが形が違う', { status: 200, body: { foo: 'bar' } }],
    ['containersStats がオブジェクトだが containers が無い', { status: 200, body: { nodes: [{ containersStats: { collectedAtSec: 1 } }] } }],
    ['全ノードの containersStats が null（0件とは言い切れない）', { status: 200, body: { nodes: [{ nodeID: 'n1', containersStats: null, desired: null }] } }],
  ]
  it.each(unreadableContainers)('★ コンテナの一覧が読めなくても（%s）、待たずに DELETE へ進み、400 の待ち直しは効く', async (_label, containers) => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n <= 2 ? { status: 400, title: RUNNING_TITLE } : { status: 204 }),
      containers,
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    // 一覧を理由にした待ちは入らない（sleep は DELETE の待ち直しの2回だけ）。
    expect(sleeps).toEqual([15000, 15000])
    expect(c.deletes).toBe(3)
    expect(r.executed.some(e => e.includes('時間切れ'))).toBe(false)
  })

  // ── 合計の上限の数え方（無効化の確認の待ち・コンテナの待ちも合算し、それぞれ「合計の残り」までしか待たない）──
  it('★ 待ちの合計には、無効化の確認の待ちも数える（active version で再武装した状態で、無効化後の確認が1回遅れる）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 400, title: ACTIVE_TITLE }),
      rearmActiveVersionAfter400: true,
      lagGetsAfterPut: 1, // PUT のあと、最初の確認はまだ非null → 5秒（既定の確認間隔）待ってから引き直す
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 40_000 }, baseUrl)
    expect(r.ok).toBe(false)
    // 待ち直し15秒 → 無効化の確認5秒 → 待ち直し15秒 → 無効化の確認5秒＝合計40秒で上限。3回目の DELETE（400）で止まる。
    // （確認の待ちを合計に数えないと、ここで止まらずにもう1回待ち直す＝sleeps が6本・DELETE が4回になる）
    expect(sleeps).toEqual([15000, 5000, 15000, 5000])
    expect(c.deletes).toBe(3)
    expect(r.message).toContain('有効なバージョンが解消しません')
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
  })

  it('★ 無効化の確認の待ちは「合計の残り」までしか待たない（上限を超えて、確認だけで10分待ち続けない）。止まっても記録は残る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 400, title: ACTIVE_TITLE }),
      rearmActiveVersionAfter400: true,
      lagGetsAfterPut: 3, // 無効化のたびに、確認が3回「まだ非null」を返す
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 40_000 }, baseUrl)
    expect(r.ok).toBe(false)
    // 1回目の待ち直し15秒 → 確認を3回待つ（5秒×3）→ DELETE（400）→ 待ち直し15秒＝45秒で、合計の上限（40秒）を超える。
    // 次の無効化の確認は「残り0秒」なので、1回確かめて待たずに止まる（上限をまるごと渡すと、ここでさらに15秒待ってしまう）。
    expect(sleeps).toEqual([15000, 5000, 5000, 5000, 15000])
    expect(c.deletes).toBe(2)
    expect(r.message).toContain('無効になったことを確認できませんでした')
    expect(r.remaining.applicationID).toBe('app1')
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
  })

  it('★ コンテナが止まるのを待つ上限も「合計の残り」（待ち直しを1回したあとの回で、残り時間だけ待って打ち切る）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 400, title: RUNNING_TITLE }),
      // 1回目の DELETE のあと、動いているコンテナが読めるようになる（1件・止まらない）。
      containersFn: cc => (cc.deletes === 0
        ? { status: 200, body: { nodes: [] } }
        : { status: 200, body: { nodes: [{ containersStats: [{ state: 'running', status: 'Up 5 minutes' }] }] } }),
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 60_000 }, baseUrl)
    expect(r.ok).toBe(false)
    // 1回目の待ち直し15秒のあと、コンテナの待ちは残り45秒＝5秒×9回で打ち切る（合計の上限を使い切るので、DELETE は2回で止まる）。
    // 上限をまるごと（60秒）渡すと、ここが5秒×12回になる。
    expect(sleeps).toEqual([15000, ...Array(9).fill(5000)])
    expect(c.deletes).toBe(2)
    expect(r.executed.some(e => e.includes('時間切れ'))).toBe(true)
    expect(r.message).toContain('まだコンテナが止まっていません')
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
  })

  // ── 安全弁: 回数の上限を置かない作りなので、間隔・上限が変な値でもループが終わる ──
  it.each([
    ['0', 0],
    ['負の値', -5000],
    ['NaN', Number.NaN],
  ] as const)('★ 待ち間隔が %s でも、休みなく DELETE を打ち続けず、止まる（下限1秒・数でないときは既定の15秒）', async (_label, interval) => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: () => ({ status: 400, title: RUNNING_TITLE }) }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 30_000, deleteRetryIntervalMs: interval }, baseUrl)
    expect(r.ok).toBe(false)
    const expected = Number.isNaN(interval) ? 15000 : 1000
    expect(sleeps.length).toBeGreaterThan(0)
    expect(sleeps.every(ms => ms === expected)).toBe(true)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(30_000)
    expect(c.deletes).toBe(sleeps.length + 1)
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
  })

  it('★ 合計の上限（timeoutMs）が NaN でも、既定の10分で止まる（終わらないループにしない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: () => ({ status: 400, title: RUNNING_TITLE }) }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: Number.NaN }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps.length).toBe(40)
    expect(c.deletes).toBe(41)
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
  })

  it('やり直せない400（別の文言）は、待たずに1回で止まる（待ち直しの対象を広げすぎない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: () => ({ status: 400, title: 'Some other reason entirely' }) }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(c.deletes).toBe(1)
    expect(sleeps).toEqual([])
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
  })
})

describe('teardownFlow: 2026-10-07 アプリの削除が400「active version」で断られたら、待ってから、無効化からやり直す', () => {
  it('★ 400が2回続いたあと204 → 待つたびに無効化の確認（GET）からやり直し、有効なバージョンが付いていれば PUT で無効化する', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n <= 2 ? { status: 400, title: ACTIVE_TITLE } : { status: 204 }),
      rearmActiveVersionAfter400: true, // 400のあと、有効なバージョンが「また付いている」
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([15000, 15000]) // やり直す前に待つ（間を置かずに打たない）
    expect(c.deletes).toBe(3)
    expect(c.puts).toBe(2) // 2回のやり直しのたびに無効化し直した（最初は null だったので PUT なし）
    // 1回目の DELETE（400）→ 待つ → GET → PUT → GET（確認）→ コンテナ → DELETE（400）→ … の順。
    expect(calls.slice(0, 12)).toEqual([
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications/app1',
      'PUT /applications/app1',
      'GET /applications/app1',
      'GET /applications/app1/containers',
      'DELETE /applications/app1',
      'GET /applications/app1',
      'PUT /applications/app1',
      'GET /applications/app1',
      'GET /applications/app1/containers',
    ])
    expect(readApprunDedicatedFs(projectDir).applicationID).toBeFalsy()
  })

  it('★ 上限に達したら止まる。「有効なバージョンが解消しません」と書き、記録は消さず、生の応答が載る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: () => ({ status: 400, title: ACTIVE_TITLE }) }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 45_000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toEqual([15000, 15000, 15000])
    expect(c.deletes).toBe(4)
    expect(r.message).toContain('有効なバージョンが解消しません')
    expect(r.message).toContain('しばらくしてから、もう一度押してください')
    expect(r.message).toContain(ACTIVE_TITLE)
    expect(r.message).not.toContain('コンテナが止まっていません') // 理由が違うのに決め打ちの文面を出すと嘘になる
    expect(r.remaining.applicationID).toBe('app1')
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
    expect(r.inProgress).toBeUndefined()
  })
})

describe('appStopWaitProgressMessage: 進み具合の一文（ロードバランサの待ちの言い方に揃える）', () => {
  it('待ち始め・30秒未満は経過を書かない。30秒以上は「N分経過」（30秒→1分・3分→3分）', () => {
    expect(appStopWaitProgressMessage(0)).toBe('アプリのコンテナが止まるのを待っています…')
    expect(appStopWaitProgressMessage(15_000)).toBe('アプリのコンテナが止まるのを待っています…')
    expect(appStopWaitProgressMessage(30_000)).toBe('アプリのコンテナが止まるのを待っています（1分経過）…')
    expect(appStopWaitProgressMessage(180_000)).toBe('アプリのコンテナが止まるのを待っています（3分経過）…')
  })
})

// ── 2026-10-07 検分: アプリがさくら側ですでに無い（GET が 404）と、押し直しても先へ進めなかった ────
// 無効化の段が 404 を「分からない」として PUT を送り、PUT も 404 で止まっていた。DELETE の 404 の枝
// （一覧で確かめてから記録を外す）に届かず、クラスタなどを Koto から消せない（課金を止められない）。
// いまは 404 なら無効化を飛ばして DELETE へ進み、**最終の判断は一覧の確認**に任せる。
function goneAppServer(calls: string[], cfg: { getApp: number; put?: number; listHasApp?: boolean; full?: boolean }): http.RequestListener {
  return (req, res) => {
    const key = `${req.method} ${req.url}`
    calls.push(key)
    req.on('data', () => { /* 読み捨て */ })
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === 'GET /applications/app1') {
        return cfg.getApp === 404
          ? send(404, { status: 404, title: 'Not Found' })
          : send(200, { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: 3 } })
      }
      if (key === 'PUT /applications/app1') return send(cfg.put ?? 404, { status: cfg.put ?? 404, title: 'Not Found' })
      if (key === 'GET /applications/app1/containers') return send(404, { status: 404, title: 'Not Found' })
      if (key === 'DELETE /applications/app1') return send(404, { status: 404, title: 'Not Found' })
      if (key === 'GET /applications?clusterID=c1&maxItems=20') {
        return send(200, { applications: cfg.listHasApp ? [{ applicationID: 'app1', name: 'myapp', clusterID: 'c1' }] : [] })
      }
      if (cfg.full) {
        if (key === 'DELETE /clusters/c1/asg/a1/load_balancers/l1') return send(204, {})
        if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') return send(200, { loadBalancers: [] })
        if (key === 'DELETE /clusters/c1/asg/a1') return send(204, {})
        if (key === 'GET /clusters/c1/asg?maxItems=20') return send(200, { autoScalingGroups: [] })
        if (key === 'DELETE /clusters/c1') return send(204, {})
        if (key === 'GET /clusters?maxItems=20') return send(200, { clusters: [] })
      }
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
  }
}

describe('teardownFlow: アプリがさくら側ですでに無い（404）ときは、削除へ進み、一覧で確かめて記録を外す（2026-10-07）', () => {
  const noWait = { confirmed: true as const, sleep: async () => {}, intervalMs: 1, timeoutMs: 10 }

  it('★★ アプリの段: GET 404 → 無効化を送らずに DELETE（404）→ 一覧に無い → 成功・記録から外れる', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(goneAppServer(calls, { getApp: 404 }))
    const r = await appStageOnly({ ...noWait }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(calls).not.toContain('PUT /applications/app1') // 無いものを無効にしようとしない
    expect(calls).toContain('DELETE /applications/app1')
    expect(calls).toContain('GET /applications?clusterID=c1&maxItems=20') // 最終の判断は一覧の確認
    expect(readApprunDedicatedFs(projectDir)?.applicationID ?? null).toBeNull()
  })

  it('★★ 手順6: アプリが無くても止まらず、ロードバランサ → ASG → クラスタまで進む（課金を止められる）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(goneAppServer(calls, { getApp: 404, full: true }))
    const r = await teardownFlow(AUTH, projectDir, noWait, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(calls).toContain('DELETE /clusters/c1/asg/a1/load_balancers/l1')
    expect(calls).toContain('DELETE /clusters/c1/asg/a1')
    expect(calls).toContain('DELETE /clusters/c1')
  })

  it('★★ 「分からない」を成功に倒さない: GET 404 でも、一覧にまだアプリがあれば止まり、記録は残す', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(goneAppServer(calls, { getApp: 404, listHasApp: true }))
    const r = await appStageOnly({ ...noWait }, baseUrl)
    expect(r.ok).toBe(false)
    expect(readApprunDedicatedFs(projectDir)?.applicationID).toBe('app1')
  })

  it('★ GET と PUT のあいだに消えた（PUT が 404）ときも、DELETE へ進み一覧で確かめる', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const baseUrl = await listen(goneAppServer(calls, { getApp: 200, put: 404 }))
    const r = await appStageOnly({ ...noWait }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(calls).toContain('PUT /applications/app1')
    expect(calls).toContain('DELETE /applications/app1')
    expect(readApprunDedicatedFs(projectDir)?.applicationID ?? null).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2026-10-08 検分 I: コンテナの一覧を原本の形で読み、停止待ちが「動いているコンテナが0件」を基準に働く
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 原本（OpenAPI v1.4.0 の ListApplicationContainersResponse）の example の形で流す。containersStats は
// { collectedAtSec, containers: [...] } のオブジェクト。以前の読み方は配列だけを読んだので、本物の応答は常に「読めない」になり、
// コンテナの停止待ちは一度も効いていなかった（実際の応答は、まだ誰も見ていない）。

/** 原本 example のコンテナ1件（state は running）。 */
const ORIG_CONTAINER = (state: string, status = 'Up 5 minutes') => ({
  id: 'container-1', image: 'nginx:latest', state, status, cpuUsagePercent: 12.5,
  applicationID: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', applicationVersion: 2,
})
/** 原本 example のノード1つ（containersStats は { collectedAtSec, containers }）。 */
const ORIG_NODE = (containers: unknown[]) => ({
  nodeID: 'b7e6a1c2-3f4d-4e2a-9b1a-2c3d4e5f6a7b',
  containersStats: { collectedAtSec: 1721203200, containers },
  desired: { containers: [] },
})
const origBody = (...containers: unknown[]): Route => ({ status: 200, body: { nodes: [ORIG_NODE(containers)] } })

describe('teardownFlow: I. コンテナの停止待ちは、原本の形の一覧を読み、動いているコンテナが0件になるまで待つ', () => {
  it('★★★ 原本の形で running が1件 → 待つ（DELETE は止まったのを確かめてから）。2回目の確認で 0 件になったら DELETE へ進む', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    let containerGets = 0
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 204 }),
      containersFn: () => { containerGets++; return containerGets <= 2 ? origBody(ORIG_CONTAINER('running')) : origBody() },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const progress: string[] = []
    const r = await appStageOnly({ confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(containerGets).toBe(3) // 最初の確認1回 ＋ 待ちで2回（3回目に 0 件）
    expect(sleeps).toEqual([5000]) // 待ちは1回（waitUntilGone の既定の間隔 5 秒）
    expect(progress).toContain('コンテナが止まるのを待っています…')
    expect(calls.indexOf('DELETE /applications/app1')).toBeGreaterThan(calls.lastIndexOf('GET /applications/app1/containers'))
  })

  it('★★ exited・dead だけなら「動いているコンテナは 0 件」＝待たずに DELETE（止まったコンテナが一覧に残っていても待たされない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 204 }),
      containers: origBody(ORIG_CONTAINER('exited', 'Exited (0) 3 seconds ago'), ORIG_CONTAINER('dead', 'Dead')),
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([])
    expect(calls.filter(x => x === 'GET /applications/app1/containers')).toHaveLength(1)
    expect(calls).toContain('DELETE /applications/app1')
  })

  it('★★★ 待っている間に running → exited に変わった（一覧からは消えず、exited のまま残る）なら、そこで待ちを抜けて DELETE へ進む。時間切れまで待たない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    let containerGets = 0
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 204 }),
      // 最初の確認だけ running。以後は止まったコンテナが exited のまま一覧に残る
      containersFn: () => { containerGets++; return containerGets <= 1 ? origBody(ORIG_CONTAINER('running')) : origBody(ORIG_CONTAINER('exited', 'Exited (0) 2 seconds ago')) },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([]) // 待ちの最初の確認で「動いているのは 0 件」と分かる
    expect(containerGets).toBe(2)
    expect(r.executed.some(e => e.includes('時間切れ'))).toBe(false)
    expect(calls).toContain('DELETE /applications/app1')
  })

  it.each([
    ['running'], ['restarting'], ['paused'], ['created'], ['removing'],
    ['知らない値（zombie）', 'zombie'], ['空文字', ''],
  ] as const)('★★ state が %s のコンテナが残っていれば「動いている」側に倒して待つ（止まったと思い込まない）。上限まで動いたままなら時間切れでも DELETE へ進む', async (label, state) => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 204 }),
      containers: origBody(ORIG_CONTAINER(state ?? label)),
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 20_000 }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([5000, 5000, 5000, 5000]) // 待った（上限 20 秒＝5 秒おきに 4 回）
    expect(r.executed.some(e => e.includes('時間切れ'))).toBe(true)
    expect(c.deletes).toBe(1) // 時間切れでも関門にはしない（課金が止まらないほうへ倒さない）
  })

  it('★★ 旧い形（containersStats が配列）でも、読めるなら読んで待つ', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    let containerGets = 0
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 204 }),
      containersFn: () => {
        containerGets++
        return { status: 200, body: { nodes: [{ containersStats: containerGets <= 2 ? [{ state: 'running', status: 'Up' }] : [] }] } }
      },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([5000])
  })

  it('★★ 一部のノードの containersStats が null でも、読めたコンテナが動いていれば待つ（null のノードは、読めたぶんの事実を打ち消さない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    let containerGets = 0
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 204 }),
      containersFn: () => {
        containerGets++
        // 1・2回目: null のノード ＋ running 1件。3回目: null のノード ＋ exited（止まった）
        return { status: 200, body: { nodes: [{ nodeID: 'n0', containersStats: null, desired: null }, ORIG_NODE(containerGets <= 2 ? [ORIG_CONTAINER('running')] : [ORIG_CONTAINER('exited', 'Exited (0) 1 second ago')])] } }
      },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([5000]) // running の間は待つ（1回）。exited になったら抜ける
    expect(containerGets).toBe(3)
    expect(c.deletes).toBe(1)
  })

  // ── 2026-10-08 検分の再指摘（I・待ちすぎ）: 待ちの中で「読めない」になったら、最初の確認と同じ向き＝待ちをやめて DELETE へ ──────────
  // 直した直後の版は、最初の確認は「読めない → 待たずに DELETE」、待ちの中は「読めない → まだ残っている」と向きが逆だった。
  // すると、どれかのノードの containersStats が null（原本で許される値）で、ほかのノードに読めたコンテナが無い応答のとき、
  // コンテナが全部止まったあとも合計の上限（既定10分）まで待ち（sleep 120回）、時計を使い切って、続く DELETE が 400 でも待ち直しの余地が無かった。
  it('★★★ 待ちの中で、読めたコンテナが 0 件・別のノードが null（読めない）になったら、待ちをやめて DELETE へ進む。時間切れまで待たない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    let containerGets = 0
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 204 }),
      containersFn: () => {
        containerGets++
        // 最初の確認だけ running。以後は、null のノード ＋ コンテナの無いノード（コンテナが全部止まって消えた）
        return { status: 200, body: { nodes: [{ nodeID: 'n0', containersStats: null, desired: null }, ORIG_NODE(containerGets <= 1 ? [ORIG_CONTAINER('running')] : [])] } }
      },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(containerGets).toBe(2) // 最初の確認 ＋ 待ちの最初の確認（そこで「読めない」→ 抜ける）
    expect(sleeps).toEqual([]) // 待ちに入っても 1 回も寝ない。120 回寝て合計 10 分、には戻らない
    expect(r.executed.some(e => e.includes('時間切れ'))).toBe(false)
    expect(c.deletes).toBe(1)
  })

  it('★★★ 同じ向きの確認: ノードが 1 つで running → containersStats が null に変わっても、待ちをやめて DELETE へ進む', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    let containerGets = 0
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 204 }),
      containersFn: () => { containerGets++; return containerGets <= 1 ? origBody(ORIG_CONTAINER('running')) : { status: 200, body: { nodes: [{ nodeID: 'n0', containersStats: null, desired: null }] } } },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([])
    expect(c.deletes).toBe(1)
  })

  it('★★★ 待ちの中で一覧の取得そのものが失敗（HTTP 500）しても同じ。分からないので、待ちをやめて DELETE へ進む（最初の確認と同じ向き）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    let containerGets = 0
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: () => ({ status: 204 }),
      containersFn: () => { containerGets++; return containerGets <= 1 ? origBody(ORIG_CONTAINER('running')) : { status: 500, body: { status: 500, title: 'boom' } } },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([])
    expect(containerGets).toBe(2)
    expect(c.deletes).toBe(1)
  })

  it('★★★ 待ちを早く抜けたぶん、時計が残っている: そのあと DELETE が 400「currently running」でも、待ち直しの余地があり、押し直しにならない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    let containerGets = 0
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : { status: 204 }),
      containersFn: () => {
        containerGets++
        return { status: 200, body: { nodes: [{ nodeID: 'n0', containersStats: null, desired: null }, ORIG_NODE(containerGets === 1 ? [ORIG_CONTAINER('running')] : [])] } }
      },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true) // 直す前: 待ちで 10 分を使い切り、400 のあと待ち直しなしに止まった
    expect(c.deletes).toBe(2)
    expect(sleeps).toEqual([15000]) // 待ち直しの 1 回だけ（コンテナの待ちで時計を使っていない）
  })

  it('★★ 全ノードの containersStats が null（読めない）は、待たずに DELETE へ進む。0件と読み替えない（待ちの根拠にもしない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n <= 1 ? { status: 400, title: RUNNING_TITLE } : { status: 204 }),
      containers: { status: 200, body: { nodes: [{ nodeID: 'n0', containersStats: null, desired: null }] } },
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([15000]) // 待ったのは DELETE の 400 の待ち直しだけ（コンテナの待ちは入らない）
    expect(c.deletes).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2026-10-08 検分 J: ASG・クラスタの 409 で、下位の一覧が空のとき——間を置かずに打ち直さず、待ってからやり直す
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 直す前は、`if (!found) continue` で間を置かずに最大5回 DELETE を打ち、同じ 409 のまま「繰り返し試みましたが完了しませんでした」で止まっていた。
// いまはアプリの削除（rc.7）と同じ作法: 15 秒おきに待ち（countedSleep）、合計の上限（既定10分）まで粘る。偽サーバで「要求の列・sleep の回数」を見る。

const ASG_409 = 'Cannot delete Auto Scaling Group because it has associated Load Balancers: l1'
const CLUSTER_409 = 'Cannot delete Cluster because it has Auto Scaling Group: a1'

/**
 * 下位の一覧は（`lowerAt` を渡さなければ）常に空。ASG／クラスタの DELETE の n 回目（1始まり）の応答を決める。
 * `lowerAt(n)` を渡すと、下位の一覧（ASG の削除なら LB の一覧、クラスタの削除なら ASG の一覧）の n 回目（1始まり）の本文をそれにする。
 */
function lowerEmptyServer(
  calls: string[],
  cfg: { target: 'asg' | 'cluster'; deleteAt: (n: number) => 204 | 409 | 500; lowerAt?: (n: number) => unknown },
): http.RequestListener {
  let deletes = 0
  let lowerGets = 0
  const deleteKey = cfg.target === 'asg' ? 'DELETE /clusters/c1/asg/a1' : 'DELETE /clusters/c1'
  return (req, res) => {
    const key = `${req.method} ${req.url}`
    calls.push(key)
    req.on('data', () => { /* 読み捨て */ })
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
      }
      if (key === deleteKey) {
        deletes++
        const st = cfg.deleteAt(deletes)
        if (st === 204) return send(204, {})
        return send(st, { status: st, title: cfg.target === 'asg' ? ASG_409 : CLUSTER_409 })
      }
      // 下位の一覧は（既定では）常に空（反映のずれ）
      if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20') return send(200, cfg.lowerAt && cfg.target === 'asg' ? cfg.lowerAt(++lowerGets) : { loadBalancers: [] })
      if (key === 'GET /clusters/c1/asg?maxItems=20') return send(200, cfg.lowerAt && cfg.target === 'cluster' ? cfg.lowerAt(++lowerGets) : { autoScalingGroups: [] })
      if (key === 'DELETE /clusters/c1') return send(204, {})
      if (key === 'GET /clusters?maxItems=20') return send(200, { clusters: [] })
      send(404, { error: `test router: 未定義のルート ${key}` })
    })
  }
}

describe('teardownFlow: J. ASG の削除が409「Load Balancers」で、LB の一覧が空 → 待ってからやり直す（間を置かずに打ち直さない）', () => {
  it('★★★ 409 が7回続いたあと204 → 成功。15秒おきに7回待つ（「5回で止まる」形ではない）。待つたびに進み具合が出る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'asg', deleteAt: n => (n <= 7 ? 409 : 204) }))
    const { sleeps, sleep } = recordingSleep()
    const progress: string[] = []
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(sleeps).toEqual(Array(7).fill(15000))
    expect(calls.filter(x => x === 'DELETE /clusters/c1/asg/a1')).toHaveLength(8)
    // 要求の列: DELETE(409) → LB 一覧（空）→ 待つ → DELETE … の順（間を置かずに DELETE が続かない）
    expect(calls.slice(0, 4)).toEqual([
      'DELETE /clusters/c1/asg/a1',
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20',
      'DELETE /clusters/c1/asg/a1',
      'GET /clusters/c1/asg/a1/load_balancers?maxItems=20',
    ])
    const waiting = progress.filter(m => m.includes('ロードバランサの削除が反映されるのを待っています'))
    expect(waiting).toHaveLength(7)
    expect(waiting[0]).toBe('ロードバランサの削除が反映されるのを待っています…')
    expect(waiting[2]).toBe('ロードバランサの削除が反映されるのを待っています（1分経過）…')
    expect(readApprunDedicatedFs(projectDir).asgID).toBeFalsy()
  })

  it('★★★ 合計の上限（timeoutMs）に達したら止まる。記録（asgID）は消さず、クラスタには進まない。次にすることと生の応答が載る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'asg', deleteAt: () => 409 }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, timeoutMs: 60_000 }, baseUrl)
    expect(r.ok).toBe(false)
    // 上限 60 秒・間隔 15 秒＝待ち 4 回。待った合計が 60 秒になった回でもう一度試して、それでも 409 なら止まる（DELETE は 5 回）
    expect(sleeps).toEqual([15000, 15000, 15000, 15000])
    expect(calls.filter(x => x === 'DELETE /clusters/c1/asg/a1')).toHaveLength(5)
    expect(calls).not.toContain('DELETE /clusters/c1')
    expect(r.message).toContain('オートスケーリンググループの削除に失敗しました')
    expect(r.message).toContain('ロードバランサの削除がまだ反映されない')
    expect(r.message).toContain('しばらくしてから、もう一度押してください')
    expect(r.message).toContain(ASG_409) // 生の応答
    expect(r.message).not.toContain('繰り返し試みましたが')
    expect(r.remaining).toEqual({ asgID: 'a1', clusterID: 'c1' })
    expect(readApprunDedicatedFs(projectDir).asgID).toBe('a1')
    expect(readApprunDedicatedFs(projectDir).clusterID).toBe('c1')
  })

  it('既定の合計の上限は10分（15秒おき40回待って、DELETE は41回目で止まる）。待ち間隔は opts.deleteRetryIntervalMs で変えられる', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'asg', deleteAt: () => 409 }))
    const a = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: a.sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(a.sleeps.length).toBe(40)
    expect(a.sleeps.reduce((x, y) => x + y, 0)).toBe(10 * 60 * 1000)

    const calls2: string[] = []
    server?.close()
    const baseUrl2 = await listen(lowerEmptyServer(calls2, { target: 'asg', deleteAt: n => (n <= 2 ? 409 : 204) }))
    const b = recordingSleep()
    const r2 = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep: b.sleep, deleteRetryIntervalMs: 1000 }, baseUrl2)
    expect(r2.ok).toBe(true)
    expect(b.sleeps).toEqual([1000, 1000])
  })

  it('間隔が 0・負・NaN でも、休みなく打たず、合計の上限で止まる（下限1秒／数でないときは既定の15秒）', async () => {
    for (const interval of [0, -5000, Number.NaN]) {
      writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
      const calls: string[] = []
      server?.close()
      const baseUrl = await listen(lowerEmptyServer(calls, { target: 'asg', deleteAt: () => 409 }))
      const { sleeps, sleep } = recordingSleep()
      const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, timeoutMs: 30_000, deleteRetryIntervalMs: interval }, baseUrl)
      expect(r.ok).toBe(false)
      const expected = Number.isNaN(interval) ? 15000 : 1000
      expect(sleeps.length, String(interval)).toBeGreaterThan(0)
      expect(sleeps.every(ms => ms === expected), String(interval)).toBe(true)
      expect(sleeps.reduce((x, y) => x + y, 0), String(interval)).toBe(30_000)
    }
  })

  it('409 の title が別の理由（Load Balancers を含まない）なら待ち直さず、1回で止まる（待ち直しの対象を広げすぎない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen((req, res) => {
      calls.push(`${req.method} ${req.url}`)
      req.on('data', () => {}); req.on('end', () => {
        res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 409, title: 'Some other conflict' }))
      })
    })
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toEqual([])
    expect(calls).toEqual(['DELETE /clusters/c1/asg/a1'])
  })
})

describe('teardownFlow: J. クラスタの削除が409「Auto Scaling Group」で、ASG の一覧が空 → 待ってからやり直す', () => {
  it('★★★ 409 が7回続いたあと204 → 成功。15秒おきに7回待つ。待つたびに進み具合が出る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'cluster', deleteAt: n => (n <= 7 ? 409 : 204) }))
    const { sleeps, sleep } = recordingSleep()
    const progress: string[] = []
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(sleeps).toEqual(Array(7).fill(15000))
    expect(calls.filter(x => x === 'DELETE /clusters/c1')).toHaveLength(8)
    expect(calls.slice(0, 4)).toEqual([
      'DELETE /clusters/c1',
      'GET /clusters/c1/asg?maxItems=20',
      'DELETE /clusters/c1',
      'GET /clusters/c1/asg?maxItems=20',
    ])
    const waiting = progress.filter(m => m.includes('オートスケーリンググループの削除が反映されるのを待っています'))
    expect(waiting).toHaveLength(7)
    expect(waiting[0]).toBe('オートスケーリンググループの削除が反映されるのを待っています…')
    expect(readApprunDedicatedFs(projectDir).clusterID).toBeFalsy()
  })

  it('★★★ 合計の上限に達したら止まる。記録（clusterID）は消さない。次にすることと生の応答が載る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'cluster', deleteAt: () => 409 }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, timeoutMs: 60_000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toEqual([15000, 15000, 15000, 15000])
    expect(calls.filter(x => x === 'DELETE /clusters/c1')).toHaveLength(5)
    expect(r.message).toContain('クラスタの削除に失敗しました')
    expect(r.message).toContain('オートスケーリンググループの削除がまだ反映されない')
    expect(r.message).toContain('しばらくしてから、もう一度押してください')
    expect(r.message).toContain(CLUSTER_409)
    expect(r.message).not.toContain('繰り返し試みましたが')
    expect(r.remaining).toEqual({ clusterID: 'c1' })
    expect(readApprunDedicatedFs(projectDir).clusterID).toBe('c1')
  })
})

// ── 2026-10-08 検分の再指摘（J）: 「下位の一覧が空」は ID だけで見る。読めない一覧・name の無い行を「反映のずれ」にして 10 分待たない ──────────
// 直す前は readLoadBalancerRows／readAsgRows の先頭（name の無い行を捨て、形が読めなくても `[]`）で「空」を決めていた。すると、実際には
// 残っているロードバランサ（name が無い行）や、一覧の形が違うだけの応答まで「反映のずれ」と扱われ、10 分待って「しばらくしてから…」で止まり、
// そのロードバランサの ID は記録に戻らず、押し直しても同じ行き止まり（課金が続く）だった。

describe('teardownFlow: J（再指摘）. 下位の一覧の「空」は ID だけで判定する（ASG の削除 → ロードバランサの一覧）', () => {
  const asgTarget = 'DELETE /clusters/c1/asg/a1'
  const lbList = 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20'

  it('★★★ name の無い行が残っている（deleting も無い）→ 反映のずれにしない。待たずに止まり、その ID を記録に戻し、押し直しを案内する', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'asg', deleteAt: () => 409, lowerAt: () => ({ loadBalancers: [{ loadBalancerID: 'l9' }] }) }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toEqual([]) // 直す前: 40 回寝て合計 10 分
    expect(calls.filter(x => x === asgTarget)).toHaveLength(1)
    expect(r.message).toContain('ロードバランサが残っているため削除できません')
    expect(r.message).toContain('手順6をもう一度押すと')
    expect(r.message).not.toContain('反映されない')
    expect(r.remaining).toEqual({ loadBalancerID: 'l9', asgID: 'a1', clusterID: 'c1' })
    expect(readApprunDedicatedFs(projectDir).loadBalancerID).toBe('l9') // 記録に戻る（押し直せば消せる）
  })

  it('★★★ name の無い行が deleting:true で残っている → 見つかった場合と同じく待って、消えたら ASG の削除をやり直して成功する（寝ない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    // 1回目（409 のあとの確認）: 削除中の行。2回目（消えるのを待つ一覧）: 空
    const baseUrl = await listen(lowerEmptyServer(calls, {
      target: 'asg', deleteAt: n => (n === 1 ? 409 : 204),
      lowerAt: n => (n === 1 ? { loadBalancers: [{ loadBalancerID: 'l9', deleting: true }] } : { loadBalancers: [] }),
    }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(sleeps).toEqual([])
    expect(r.executed.join('\n')).toContain('ロードバランサ『l9』がまだ残っていたため、記録に戻しました')
    expect(calls.filter(x => x === asgTarget)).toHaveLength(2)
  })

  it.each([
    ['キーが違う（loadBalancers が無い）', { items: [] }],
    ['loadBalancers が配列でない', { loadBalancers: 'x' }],
    ['要素があるのに loadBalancerID を 1 つも読めない', { loadBalancers: [{ foo: 1 }, null] }],
  ])('★★★ 一覧の形が読めない（%s）→ 「空」にしない。待たずに止まり、コントロールパネルでの確認を案内する（「しばらくしてから」ではない）', async (_label, body) => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'asg', deleteAt: () => 409, lowerAt: () => body }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toEqual([])
    expect(calls.filter(x => x === asgTarget)).toHaveLength(1)
    expect(calls.filter(x => x === lbList)).toHaveLength(1)
    expect(r.message).toContain('ロードバランサの一覧の形が想定と違うため、残っているかどうか確かめられませんでした')
    expect(r.message).toContain('コントロールパネルで確認してください')
    expect(r.message).toContain(ASG_409) // 生の応答
    expect(r.message).not.toContain('しばらくしてから')
    expect(calls).not.toContain('DELETE /clusters/c1') // クラスタには進まない
    expect(readApprunDedicatedFs(projectDir).asgID).toBe('a1') // 記録は消さない
  })

  it('対照: 読めて空（loadBalancers: []）は、これまでどおり反映のずれ＝待ってからやり直す', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'asg', deleteAt: n => (n <= 2 ? 409 : 204) }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(sleeps).toEqual([15000, 15000])
  })
})

describe('teardownFlow: J（再指摘）. 下位の一覧の「空」は ID だけで判定する（クラスタの削除 → ASG の一覧）', () => {
  const clusterTarget = 'DELETE /clusters/c1'
  const asgList = 'GET /clusters/c1/asg?maxItems=20'

  it('★★★ name の無い行が残っている → 反映のずれにしない。待たずに止まり、その ID を記録に戻す', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'cluster', deleteAt: () => 409, lowerAt: () => ({ autoScalingGroups: [{ autoScalingGroupID: 'a9' }] }) }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toEqual([])
    expect(calls.filter(x => x === clusterTarget)).toHaveLength(1)
    expect(r.message).toContain('オートスケーリンググループが残っているため削除できません')
    expect(r.message).not.toContain('反映されない')
    expect(r.remaining).toEqual({ asgID: 'a9', clusterID: 'c1' })
    expect(readApprunDedicatedFs(projectDir).asgID).toBe('a9')
  })

  it('★★★ name の無い行が deleting:true で残っている → 待って、消えたらクラスタの削除をやり直して成功する', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, {
      target: 'cluster', deleteAt: n => (n === 1 ? 409 : 204),
      lowerAt: n => (n === 1 ? { autoScalingGroups: [{ autoScalingGroupID: 'a9', deleting: true }] } : { autoScalingGroups: [] }),
    }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(sleeps).toEqual([])
    expect(calls.filter(x => x === clusterTarget)).toHaveLength(2)
  })

  it.each([
    ['キーが違う（autoScalingGroups が無い）', { items: [] }],
    ['autoScalingGroups が配列でない', { autoScalingGroups: 'x' }],
    ['要素があるのに autoScalingGroupID を 1 つも読めない', { autoScalingGroups: [{ foo: 1 }] }],
  ])('★★★ 一覧の形が読めない（%s）→ 「空」にしない。待たずに止まり、コントロールパネルでの確認を案内する', async (_label, body) => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'cluster', deleteAt: () => 409, lowerAt: () => body }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toEqual([])
    expect(calls.filter(x => x === clusterTarget)).toHaveLength(1)
    expect(calls.filter(x => x === asgList)).toHaveLength(1)
    expect(r.message).toContain('オートスケーリンググループの一覧の形が想定と違うため、残っているかどうか確かめられませんでした')
    expect(r.message).toContain('コントロールパネルで確認してください')
    expect(r.message).toContain(CLUSTER_409)
    expect(r.message).not.toContain('しばらくしてから')
    expect(readApprunDedicatedFs(projectDir).clusterID).toBe('c1')
  })
})

// ── 2026-10-08 検分の再指摘: 「繰り返しの上限（5回）」と、待ち直しの既定の上限（10分）を、振る舞いで固定する ──────────
// 5回の上限は「見つかった LB／ASG が削除中で、消えたのに、また 409」の繰り返しだけを守る（反映待ちは数えない）。この道には試験が無く、
// `recoveries++` を消しても全件通っていた。L（アプリの削除の待ち直しの 5xx）とクラスタ J の既定の 10 分も、固定していなかった。

describe('teardownFlow: 繰り返しの上限（回復は5回まで）。消えたのにまた 409 が続く形を、無限に続けない', () => {
  /** 409 を返し続ける DELETE。下位の一覧は「奇数回: 削除中の行／偶数回: 空（消えた）」。DELETE が cap 回を超えたら 500（暴走の歯止め）。 */
  function flappingServer(calls: string[], target: 'asg' | 'cluster', cap = 30): http.RequestListener {
    let deletes = 0
    let lowerGets = 0
    const deleteKey = target === 'asg' ? 'DELETE /clusters/c1/asg/a1' : 'DELETE /clusters/c1'
    return (req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      req.on('data', () => {})
      req.on('end', () => {
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
        if (key === deleteKey) {
          deletes++
          if (deletes > cap) return send(500, { status: 500, title: '暴走の歯止め（試験）' })
          return send(409, { status: 409, title: target === 'asg' ? ASG_409 : CLUSTER_409 })
        }
        if (key === 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20' && target === 'asg') {
          lowerGets++
          return send(200, { loadBalancers: lowerGets % 2 === 1 ? [{ loadBalancerID: 'l1', name: 'x', deleting: true }] : [] })
        }
        if (key === 'GET /clusters/c1/asg?maxItems=20' && target === 'cluster') {
          lowerGets++
          return send(200, { autoScalingGroups: lowerGets % 2 === 1 ? [{ autoScalingGroupID: 'a1', name: 'x', deleting: true }] : [] })
        }
        send(404, { error: `test router: 未定義のルート ${key}` })
      })
    }
  }

  it('★★★ ASG: 「LB が削除中で見つかる → 消える → また 409」を繰り返すと、5回の回復で止まる（6回目の DELETE は打たない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1' })
    const calls: string[] = []
    const baseUrl = await listen(flappingServer(calls, 'asg'))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('オートスケーリンググループの削除を繰り返し試みましたが完了しませんでした')
    expect(r.message).toContain('コントロールパネルで確認してください')
    expect(calls.filter(x => x === 'DELETE /clusters/c1/asg/a1')).toHaveLength(5) // 回復は5回まで（上限を外すと 30 回まで打つ）
    expect(sleeps).toEqual([]) // 反映待ち（空の一覧）ではないので、15秒の待ちは入らない
    expect(calls).not.toContain('DELETE /clusters/c1')
  })

  it('★★★ クラスタ: 「ASG が削除中で見つかる → 消える → また 409」を繰り返すと、5回の回復で止まる', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(flappingServer(calls, 'cluster'))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('クラスタの削除を繰り返し試みましたが完了しませんでした')
    expect(calls.filter(x => x === 'DELETE /clusters/c1')).toHaveLength(5)
    expect(sleeps).toEqual([])
  })
})

describe('teardownFlow: 待ち直しの既定の合計の上限は10分（15秒おき40回）。クラスタ J・アプリ L も固定する', () => {
  it('★★ クラスタ J: 既定（timeoutMs を渡さない）の上限は10分。40回待って、41回目の DELETE で止まる', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1' })
    const calls: string[] = []
    const baseUrl = await listen(lowerEmptyServer(calls, { target: 'cluster', deleteAt: () => 409 }))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toHaveLength(40)
    expect(sleeps.reduce((x, y) => x + y, 0)).toBe(10 * 60 * 1000)
    expect(calls.filter(x => x === 'DELETE /clusters/c1')).toHaveLength(41)
    expect(r.message).toContain('しばらくしてから、もう一度押してください')
  })

  it('★★ アプリ L: 待ち直しの途中の 5xx が続いたとき、既定の上限は10分（固定の短い値ではない）。400 の待ち1回 ＋ 5xx の待ち39回＝40回で止まる', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : { status: 503, title: 'Service Unavailable' }) }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toHaveLength(40)
    expect(sleeps.reduce((x, y) => x + y, 0)).toBe(10 * 60 * 1000)
    expect(c.deletes).toBe(41)
    expect(r.message).toContain('しばらくしてから、もう一度押してください')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2026-10-08 検分 K・L: アプリの削除の待ち直し——進み具合の文を理由ごとに分ける／途中の 5xx・通信の切れも待ち直す
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('appDeactivateWaitProgressMessage: 400「active version」で待つときの進み具合は、コンテナではなく無効化の反映を待つ文（K）', () => {
  it('待ち始め・30秒未満は経過を書かない。30秒以上は「N分経過」。appStopWaitProgressMessage（コンテナ）とは別の文', () => {
    expect(appDeactivateWaitProgressMessage(0)).toBe('アプリの無効化が反映されるのを待っています…')
    expect(appDeactivateWaitProgressMessage(15_000)).toBe('アプリの無効化が反映されるのを待っています…')
    expect(appDeactivateWaitProgressMessage(30_000)).toBe('アプリの無効化が反映されるのを待っています（1分経過）…')
    expect(appDeactivateWaitProgressMessage(180_000)).toBe('アプリの無効化が反映されるのを待っています（3分経過）…')
    expect(appDeactivateWaitProgressMessage(0)).not.toBe(appStopWaitProgressMessage(0))
    expect(appDeactivateWaitProgressMessage(0)).not.toContain('コンテナ')
  })
})

describe('teardownFlow: K. 400で待つときの進み具合は、理由ごとに別の文（active version ＝無効化の反映／currently running ＝コンテナの停止）', () => {
  it('★★★ 「active version」で待つ間、「アプリのコンテナが止まるのを待っています」は一度も出ない。「アプリの無効化が反映されるのを待っています」が待つたびに出る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n <= 3 ? { status: 400, title: ACTIVE_TITLE } : { status: 204 }),
      rearmActiveVersionAfter400: true,
    }, c))
    const { sleep } = recordingSleep()
    const progress: string[] = []
    const r = await appStageOnly({ confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok).toBe(true)
    expect(progress.filter(m => m.includes('アプリのコンテナが止まるのを待っています'))).toEqual([])
    expect(progress.filter(m => m.includes('アプリの無効化が反映されるのを待っています'))).toEqual([
      'アプリの無効化が反映されるのを待っています…',
      'アプリの無効化が反映されるのを待っています…',
      'アプリの無効化が反映されるのを待っています（1分経過）…',
    ])
  })

  it('★★ 「currently running」で待つ間は、従来どおり「アプリのコンテナが止まるのを待っています」。無効化の文は出ない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: n => (n <= 2 ? { status: 400, title: RUNNING_TITLE } : { status: 204 }) }, c))
    const { sleep } = recordingSleep()
    const progress: string[] = []
    const r = await appStageOnly({ confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok).toBe(true)
    expect(progress.filter(m => m.includes('アプリのコンテナが止まるのを待っています'))).toHaveLength(2)
    expect(progress.filter(m => m.includes('無効化が反映されるのを待っています'))).toEqual([])
  })

  it('★ 理由が途中で変わると、文もその回の理由に合わせて変わる（running → active version）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : n === 2 ? { status: 400, title: ACTIVE_TITLE } : { status: 204 }),
      rearmActiveVersionAfter400: true,
    }, c))
    const { sleep } = recordingSleep()
    const progress: string[] = []
    const r = await appStageOnly({ confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok).toBe(true)
    const waits = progress.filter(m => m.includes('止まるのを待っています') || m.includes('無効化が反映されるのを待っています'))
    expect(waits).toEqual(['アプリのコンテナが止まるのを待っています…', 'アプリの無効化が反映されるのを待っています…'])
  })
})

describe('teardownFlow: L. 待ち直しの途中で DELETE が 5xx・通信の切れで失敗したら、止めずに待ち直す（合計の上限まで）。4xx は従来どおり止める', () => {
  it('★★★ 400 のあと 503 が2回 → 204: 止まらずに成功。15秒おきに待つ（400 の待ち1回 ＋ 5xx の待ち2回）。進み具合も出る', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : n <= 3 ? { status: 503 } : { status: 204 }),
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const progress: string[] = []
    const r = await appStageOnly({ confirmed: true, sleep, progress: m => progress.push(m) }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(c.deletes).toBe(4)
    expect(sleeps).toEqual([15000, 15000, 15000])
    expect(progress.filter(m => m.includes('アプリの削除の要求が通らなかったため、待ってからやり直しています'))).toHaveLength(2)
    expect(readApprunDedicatedFs(projectDir).applicationID).toBeFalsy()
  })

  it('★★★ 通信の切れ（応答が無い）も同じ。400 のあと接続が切れても、待ち直して成功する', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : n === 2 ? { status: 0 } : { status: 204 }),
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(c.deletes).toBe(3)
    expect(sleeps).toEqual([15000, 15000])
  })

  it('★★ 待ち直しの途中の 5xx が合計の上限まで続いたら止まる。「しばらくしてから、もう一度押してください」と生の応答を添え、記録は消さず、inProgress は立てない', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : { status: 503, title: 'Service Unavailable' }),
      full: true,
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await teardownFlow(AUTH, projectDir, { confirmed: true, sleep, timeoutMs: 45_000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(sleeps).toEqual([15000, 15000, 15000]) // 合計 45 秒で上限
    expect(c.deletes).toBe(4)
    expect(r.message).toContain('しばらくしてから、もう一度押してください')
    expect(r.message).toContain('一時的にエラーを返しました')
    expect(r.message).toContain('Service Unavailable') // 生の応答
    expect(r.message).toContain('クラスタなどの課金は続いています')
    expect(r.inProgress).toBeUndefined()
    expect(r.remaining.applicationID).toBe('app1')
    expect(readApprunDedicatedFs(projectDir).applicationID).toBe('app1')
    expect(calls.some(x => x.startsWith('DELETE /clusters'))).toBe(false) // 下位には進まない
  })

  it('通信の切れが上限まで続いたときの文は「通信できませんでした」（5xx と言い分ける）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : { status: 0 }) }, c))
    const { sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep, timeoutMs: 30_000 }, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('通信できませんでした')
    expect(r.message).toContain('しばらくしてから、もう一度押してください')
  })

  it('★★ 待ち直しの途中でも 4xx（403・別の400）は従来どおり止める（待ち直さない）。止まる文に課金が続くことを言う', async () => {
    for (const status of [403, 422]) {
      writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
      const calls: string[] = []
      const c = newCounters()
      server?.close()
      const baseUrl = await listen(stopServer(calls, {
        deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : { status, title: 'No' }),
      }, c))
      const { sleeps, sleep } = recordingSleep()
      const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
      expect(r.ok, String(status)).toBe(false)
      expect(c.deletes, String(status)).toBe(2)
      expect(sleeps, String(status)).toEqual([15000]) // 最初の 400 の待ちだけ
      expect(r.message, String(status)).toContain('残っている間は課金が続きます')
      expect(r.message, String(status)).not.toContain('しばらくしてから')
    }
    // 別の 400（既知の理由でない）も同じ
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    server?.close()
    const c2 = newCounters()
    const baseUrl2 = await listen(stopServer([], {
      deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : { status: 400, title: 'Some other reason entirely' }),
    }, c2))
    const w = recordingSleep()
    const r2 = await appStageOnly({ confirmed: true, sleep: w.sleep }, baseUrl2)
    expect(r2.ok).toBe(false)
    expect(c2.deletes).toBe(2)
  })

  it('★ 待ち直しの途中で 404 になったら、従来どおり一覧で確かめて記録から外す（既に消えていた）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: n => (n === 1 ? { status: 400, title: RUNNING_TITLE } : { status: 404, title: 'Not Found' }) }, c))
    const { sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.executed.some(e => e.includes('既に存在しませんでした'))).toBe(true)
  })

  it('★★ 最初の DELETE が 5xx のとき（待ち直しの途中ではない）は、従来どおりすぐ止まる（待たない）', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, { deleteAt: () => ({ status: 503 }) }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok).toBe(false)
    expect(c.deletes).toBe(1)
    expect(sleeps).toEqual([])
    expect(r.message).toContain('残っている間は課金が続きます')
  })

  it('★★ 「active version」で待ち直したあとの 5xx: 無効化は打ち直さず（PUT は1回だけ）、待ってから DELETE だけをやり直す', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'c1', applicationID: 'app1' })
    const calls: string[] = []
    const c = newCounters()
    const baseUrl = await listen(stopServer(calls, {
      deleteAt: n => (n === 1 ? { status: 400, title: ACTIVE_TITLE } : n === 2 ? { status: 503 } : { status: 204 }),
      rearmActiveVersionAfter400: true,
    }, c))
    const { sleeps, sleep } = recordingSleep()
    const r = await appStageOnly({ confirmed: true, sleep }, baseUrl)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(c.puts).toBe(1) // 400 のあとの無効化し直しの1回だけ。5xx のあとは打ち直さない
    expect(c.deletes).toBe(3)
    expect(sleeps).toEqual([15000, 15000])
  })
})

describe('apprunDedicatedApp: DELETE の一時的な失敗の判定（appDeleteTransientFailure）', () => {
  it('5xx と、応答が無い（status なし）は一時的。4xx・2xx・3xx は違う', () => {
    expect(appDeleteTransientFailure(undefined)).toBe(true)
    for (const st of [500, 502, 503, 504, 599]) expect(appDeleteTransientFailure(st), String(st)).toBe(true)
    for (const st of [400, 401, 403, 404, 409, 422, 429, 499, 600, 301, 200]) expect(appDeleteTransientFailure(st), String(st)).toBe(false)
  })
})
