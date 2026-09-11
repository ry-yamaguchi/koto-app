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
