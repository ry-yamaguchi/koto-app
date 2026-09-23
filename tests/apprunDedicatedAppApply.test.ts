import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import type { Server } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { publishAppFlow, refreshLbAddresses, probeMarkerOverHttps, type PublishAppInput } from '../src/main/cloud/apprunDedicatedAppApply'
import { writeApprunDedicatedRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'
import type { ApprunDedicatedAppSpec } from '../src/shared/apprunDedicatedApp'
// D-7: verify 段（公開のあと、アプリが応答しているか）。確認の処理は opts.probeMarker で差し替える。
import { verifyDelaysMs, type DedicatedProbe } from '../src/shared/publishVerify'

// roadmap #23 段階③⑤（D-2b-1）。tests/apprunDedicatedApply.test.ts と同じ方針で、ローカルに
// 本物の http サーバを立てて実物のクライアントに対して確かめる（fetch はモックしない・実APIへは出ない）。

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
 * `METHOD /path` をキーにしたルーティング表から応答するテスト用サーバ（apprunDedicatedApply.test.ts と同じ形）。
 * 呼ばれた順に `calls` へ積む。表に無いキーは404。204は本文なしで返す。
 */
function routedServer(routes: Record<string, Route | Route[]>, calls: string[], onBody?: (key: string, body: any) => void): http.RequestListener {
  // 配列なら n 回目の呼び出しに n 番目の応答（最後の要素を繰り返す）。PUT の前後で GET の中身が変わる場面に使う。
  const seen = new Map<string, number>()
  return (req, res) => {
    const key = `${req.method} ${req.url}`
    calls.push(key)
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      if (onBody) { try { onBody(key, raw ? JSON.parse(raw) : null) } catch { onBody(key, raw) } }
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
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-apprundedicatedappapply-')) })
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })

const AUTH = { token: 'tok', secret: 'sec' }

/**
 * D-19: verify 段は **Node の像でも根（`/`）へ当てに行く**ようになった（仕様 A）。
 * そのため「verify を見ないテスト」でも、偽の probe を渡さないと**本物の
 * `probeMarkerOverHttps` が実ネットワークへ出てしまう**（このテスト群の大前提は「実APIへ出ない」）。
 * 既定の CONFIRMED に「応答あり」を返すだけの偽物と、待たない sleep を入れておく。
 * **verify そのものを確かめるテストは、下の 14 のように自分で probeMarker を渡す。**
 */
const quietProbe = async (): Promise<DedicatedProbe> => ({ reached: true, status: 200, body: '' })
const CONFIRMED = { confirmed: true as const, probeMarker: quietProbe, sleep: async () => {} }
const NOT_CONFIRMED = { confirmed: false as const }

/** ⑤で既に作られたクラスタ・ASG・LBの記録（publishAppFlow の前提）。 */
function recordCluster() {
  writeApprunDedicatedRecordFs(projectDir, { clusterID: 'cluster-x', asgID: 'asg-y', loadBalancerID: 'lb-z' })
}

const APP_SPEC: ApprunDedicatedAppSpec = {
  name: 'myapp2', host: 'app.example.com', port: 8080, cpu: 500, memory: 512, fixedScale: 1, env: [],
}

function makeInput(overrides: Partial<PublishAppInput> = {}): PublishAppInput {
  return {
    spec: APP_SPEC,
    imageRef: 'jp1.sakuracr.jp/example/myapp2:v1',
    registry: { username: 'reg-user', password: 'reg-pass' },
    ...overrides,
  }
}

/**
 * lets-encrypt 済み・80/http・443/https も揃ったクラスタ応答（このテストファイルの既定シナリオ）。
 * A（2026-09-17）: ⑧が公開ポートを確かめるようになったため、既定シナリオは「揃っている」クラスタに
 * する（揃っていないクラスタを個別に確かめるテストは、下の CLUSTER_LE_TRUE_NO_PORTS 等を使う）。
 */
const CLUSTER_LE_TRUE: Route = {
  status: 200,
  body: { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: true, ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }] } },
}
/** ports キーが無い（＝読めない）クラスタ応答。ポート未確認でも公開を止めないことを確かめるのに使う。 */
const CLUSTER_LE_TRUE_NO_PORTS: Route = { status: 200, body: { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: true } } }
/** 443/https しか無い（80/http が欠けた）クラスタ応答。 */
const CLUSTER_LE_TRUE_MISSING_80: Route = {
  status: 200,
  body: { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: true, ports: [{ port: 443, protocol: 'https' }] } },
}

/**
 * GET load_balancer_nodes の実測の生の形（2026-09-16・probe-dedicated-nodes ⑥・docs/apprun-dedicated-plan.md 5-13）。
 * **`address` はネットマスク付き（`IP/24`）**。A レコードに書くのは `/` より前だけ（bareIp）。
 * 1vcpu_2gb_1 の LB は 1 ノード。lb-address 段を待たせたくないテストは、空ではなくこれを返す。
 */
const LB_NODES_ONE: Route = {
  status: 200,
  body: {
    loadBalancerNodes: [{
      loadBalancerNodeID: 'lbn-1', resourceID: 'res-1', status: 'healthy',
      interfaces: [{ interfaceIndex: 0, addresses: [{ address: '59.106.222.212/24', vip: false }] }],
      archiveVersion: 'v2026.825.1', created: 1789515207,
    }],
  },
}
const LB_NODES_EMPTY: Route = { status: 200, body: { loadBalancerNodes: [] } }
const LB_NODES_KEY = 'GET /clusters/cluster-x/asg/asg-y/load_balancers/lb-z/load_balancer_nodes?maxItems=20'
/** 実際には1ミリ秒も待たない偽の sleep（呼ばれた ms を記録する）。 */
function fakeSleep(log: number[]): (ms: number) => Promise<void> {
  return async (ms) => { log.push(ms) }
}

// ── 1. confirmed が無ければ API を一切呼ばずに中止する（掟10の3点セット） ─────────────────

describe('publishAppFlow: 1. confirmed が無ければ、記録があっても API を一度も呼ばずに中止する', () => {
  it('opts.confirmed:false → stage:consent・calls は空', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), NOT_CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('consent')
    expect(calls).toEqual([])
  })

  it('opts.confirmed を省略した形（{}）でも同様に中止する', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), {} as any, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('consent')
    expect(calls).toEqual([])
  })
})

// ── 2. 記録にクラスタが無ければ止める（no-cluster） ─────────────────────────────────────

describe('publishAppFlow: 2. 記録にクラスタ・ASG・LBが揃っていなければ、API を一切呼ばずに止める', () => {
  it('記録が空 → stage:no-cluster・calls は空', async () => {
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('no-cluster')
    expect(calls).toEqual([])
  })

  it('clusterID はあるが asgID/loadBalancerID が無い → stage:no-cluster', async () => {
    writeApprunDedicatedRecordFs(projectDir, { clusterID: 'cluster-x' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('no-cluster')
    expect(calls).toEqual([])
  })
})

// ── 3. validateAppSpec 違反は stage:invalid で止める（API ゼロ） ────────────────────────

describe('publishAppFlow: 3. 入力検証（validateAppSpec）違反は API を一切呼ばずに止める', () => {
  it('ホスト名が不正（大文字を含む）→ stage:invalid・calls は空', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({}, calls))
    const badInput = makeInput({ spec: { ...APP_SPEC, host: 'App.Example.com' } })
    const r = await publishAppFlow(AUTH, projectDir, badInput, CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('invalid')
    expect(calls).toEqual([])
  })
})

// ── 4. 記録ファイルに書き込めなければ、最初のfetchより前に止まる ────────────────────────

describe('publishAppFlow: 4. 記録ファイルに書けなければ stage:record で止まり、calls は空', () => {
  it('.sakuraide.json を読み取り専用にすると書き込みに失敗し、fetch はゼロ', async () => {
    recordCluster()
    const metaPath = path.join(projectDir, '.sakuraide.json')
    fs.chmodSync(metaPath, 0o400)
    try {
      const calls: string[] = []
      const baseUrl = await listen(routedServer({}, calls))
      const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
      expect(r.ok).toBe(false)
      expect(r.stage).toBe('record')
      expect(calls).toEqual([])
    } finally {
      fs.chmodSync(metaPath, 0o600)
    }
  })
})

// ── 5. lets-encrypt: 無ければ入力を要求。あれば PATCH して確かめる ──────────────────────

describe("publishAppFlow: 5. Let's Encrypt のメールが無ければ止め、入力があれば設定して確かめる", () => {
  it('hasLetsEncryptEmail:false かつ letsEncryptEmail 未指定 → stage:lets-encrypt。PATCH は呼ばない', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: false } } },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('lets-encrypt')
    expect(calls).toEqual(['GET /clusters/cluster-x'])
    // 案内先は⑧のメール欄（⑧が出る状態では⑤の入力欄は畳まれて無い。README・usage-guide・⑤の説明文と同じ）。
    expect(r.message).toContain('⑧')
    expect(r.message).toContain('メール欄')
    expect(r.message).not.toContain('⑤')
  })

  it('hasLetsEncryptEmail:null（分からない）でも false と同じ扱いで止める', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': { status: 200, body: { cluster: { clusterID: 'cluster-x' } } },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('lets-encrypt')
    expect(r.message).toContain('⑧')
    expect(r.message).not.toContain('⑤')
  })

  it('hasLetsEncryptEmail:false だが letsEncryptEmail 指定あり → PATCH してから確かめ、先へ進む', async () => {
    recordCluster()
    const calls: string[] = []
    const patchBodies: any[] = []
    let clusterCallCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          if (status === 204) { res.writeHead(204); res.end(); return }
          res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
        }
        if (key === 'GET /clusters/cluster-x') {
          clusterCallCount++
          const hasLE = clusterCallCount >= 2 // 1回目はfalse、PATCH後の2回目はtrue
          return send(200, { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: hasLE } })
        }
        if (key === 'PATCH /clusters/cluster-x/load_balancer') {
          patchBodies.push(raw ? JSON.parse(raw) : null)
          return send(204, {})
        }
        // これ以降（app-lookupなど）は空一覧で応答し、name-takenにも掛からないようにする。
        if (key === `GET /applications?clusterID=cluster-x&maxItems=20`) return send(200, { applications: [] })
        send(404, { error: `未定義のルート ${key}` })
      })
    })
    const r = await publishAppFlow(AUTH, projectDir, makeInput({ letsEncryptEmail: 'owner@example.com' }), CONFIRMED, baseUrl)
    expect(r.stage).not.toBe('lets-encrypt')
    expect(calls).toEqual([
      'GET /clusters/cluster-x',
      'PATCH /clusters/cluster-x/load_balancer',
      'GET /clusters/cluster-x',
      'GET /applications?clusterID=cluster-x&maxItems=20',
      'POST /applications', // 一覧が空なので作成へ進む（偽サーバは 404 を返し、app-create で止まる）
    ])
    expect(patchBodies).toEqual([{ letsEncryptEmail: 'owner@example.com' }])
  })
})

// ── A（2026-09-17）: ⑧の公開の流れが、実際に載せるクラスタの公開ポートを確かめる ─────────────
// ⑤の入力検査（80/http・443/https が無ければクラスタを作れない）を通り抜けた古いクラスタ・
// あとからコントロールパネルでポートを消したクラスタ・作成が途中で失敗し名前で探して記録された
// クラスタでは、⑧が一度もポートを確かめないまま「✅ 公開しました」を出していた（専有型は
// useLetsEncrypt:true・loadBalancerPort:443 固定なので、80/http が無ければ証明書は永久に出ない）。

describe('publishAppFlow: A. クラスタの公開ポート（80/http・443/https）を確かめる（新規API呼び出しは無し）', () => {
  it('★ 80/http が欠けたクラスタでは stage:cluster-ports で止め、アプリを作る要求は1件も飛ばない', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE_MISSING_80,
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('cluster-ports')
    // getCluster の応答をそのまま読むだけなので、GET は1回のみ。POST 系は1件も飛ばない。
    expect(calls).toEqual(['GET /clusters/cluster-x'])
  })

  it('★ 止めたときの文言に「80」と「コントロールパネル」が入る（直し方が書いてある）', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE_MISSING_80,
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.message).toContain('80')
    expect(r.message).toContain('コントロールパネル')
  })

  it('★ クラスタのポートが読めない（配列でない）ときは止めない。公開は最後まで通り、warnings に1行残る', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      ...routesUntilLbAddress(LB_NODES_ONE),
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE_NO_PORTS,
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.stage).toBe('done')
    expect(r.warnings?.some(w => w.includes('待ち受けポート'))).toBe(true)
  })

  it('★ PATCH のあとにポートが欠けていたら stage:cluster-ports で止め、直前の操作のせいかもしれないと分かる文言にする', async () => {
    recordCluster()
    const calls: string[] = []
    let clusterCallCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      req.on('data', () => {})
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          if (status === 204) { res.writeHead(204); res.end(); return }
          res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
        }
        if (key === 'GET /clusters/cluster-x') {
          clusterCallCount++
          if (clusterCallCount === 1) {
            // 1回目（PATCH前）: メール未設定だがポートは揃っている。
            return send(200, { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: false, ports: [{ port: 80, protocol: 'http' }, { port: 443, protocol: 'https' }] } })
          }
          // 2回目（PATCH後）: メールは設定されたが、80/http が無くなっている。
          return send(200, { cluster: { clusterID: 'cluster-x', hasLetsEncryptEmail: true, ports: [{ port: 443, protocol: 'https' }] } })
        }
        if (key === 'PATCH /clusters/cluster-x/load_balancer') return send(204, {})
        send(404, { error: `未定義のルート ${key}` })
      })
    })
    const r = await publishAppFlow(AUTH, projectDir, makeInput({ letsEncryptEmail: 'owner@example.com' }), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('cluster-ports')
    expect(r.message).toContain('80')
    expect(r.message).toContain('メールを設定したあと')
    expect(calls).toEqual([
      'GET /clusters/cluster-x',
      'PATCH /clusters/cluster-x/load_balancer',
      'GET /clusters/cluster-x',
    ])
  })

  it('80/http・443/https が揃っていれば、これまでどおり公開が通る（ポート起因の warnings は付かない）', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.stage).toBe('done')
    expect((r.warnings ?? []).some(w => w.includes('待ち受けポート'))).toBe(false)
  })
})

// ── 6. app-lookup: 同名があれば name-taken で止め、POSTは呼ばない ────────────────────────

describe('publishAppFlow: 6. 記録にIDが無いとき、同名アプリがあれば stage:name-taken・POSTはゼロ', () => {
  it('GET /applications に同名（myapp2）がある → name-taken。POST /applications は呼ばれない', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
      'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [{ applicationID: 'other-app', name: 'myapp2', clusterID: 'cluster-x', activeVersion: null }] } },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('name-taken')
    expect(r.message).toContain('myapp2')
    expect(calls).not.toContain('POST /applications')
    expect(calls).toEqual(['GET /clusters/cluster-x', 'GET /applications?clusterID=cluster-x&maxItems=20'])
  })

  it('記録に applicationID があり実在確認できれば、一覧もPOSTも呼ばずそのIDを再利用する', async () => {
    recordCluster()
    writeApprunDedicatedRecordFs(projectDir, { applicationID: 'app-existing' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
      'GET /applications/app-existing': { status: 200, body: { application: { applicationID: 'app-existing', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 1 } } },
      'POST /applications/app-existing/versions': { status: 500, body: { status: 500, title: 'boom（この先は別テストの対象外）' } },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(calls).not.toContain('GET /applications?clusterID=cluster-x&maxItems=20')
    expect(calls).not.toContain('POST /applications')
    expect(calls).toContain('GET /applications/app-existing')
    expect(r.applicationID).toBe('app-existing')
  })

  it('記録に applicationID があるが404 → 記録から外し、一覧で同名探し→無ければ新規作成へ進む', async () => {
    recordCluster()
    writeApprunDedicatedRecordFs(projectDir, { applicationID: 'app-gone' })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
      'GET /applications/app-gone': { status: 404, body: { status: 404, title: 'not found' } },
      'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
      'POST /applications': { status: 200, body: { application: { applicationID: 'app-new' } } },
      'POST /applications/app-new/versions': { status: 500, body: { status: 500, title: 'boom（この先は別テストの対象外）' } },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(calls).toEqual([
      'GET /clusters/cluster-x',
      'GET /applications/app-gone',
      'GET /applications?clusterID=cluster-x&maxItems=20',
      'POST /applications',
      'POST /applications/app-new/versions',
    ])
    expect(r.applicationID).toBe('app-new')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBe('app-new')
  })
})

// ── 7. app-create: POST が200 → IDが記録に書かれてからversionへ進む ─────────────────────

describe('publishAppFlow: 7. POST /applications 成功 → IDが記録された直後に version 作成へ進む', () => {
  it('POST /applications 成功直後、POST versions が呼ばれる前の時点で記録に applicationID が書かれている', async () => {
    recordCluster()
    const calls: string[] = []
    let sawRecordedBeforeVersionPost = false
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          if (status === 204) { res.writeHead(204); res.end(); return }
          res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
        }
        if (key === 'GET /clusters/cluster-x') return send(200, CLUSTER_LE_TRUE.body)
        if (key === 'GET /applications?clusterID=cluster-x&maxItems=20') return send(200, { applications: [] })
        if (key === 'POST /applications') return send(200, { application: { applicationID: 'app-1' } })
        if (key === 'POST /applications/app-1/versions') {
          // ここに来た時点で、記録は既に書かれているはず（POSTの応答を待たずに記録する方針）。
          const rec = readApprunDedicatedFs(projectDir)
          sawRecordedBeforeVersionPost = rec.applicationID === 'app-1'
          return send(500, { status: 500, title: 'この先は別テストの対象外' })
        }
        send(404, { error: `未定義のルート ${key}` })
      })
    })
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(sawRecordedBeforeVersionPost).toBe(true)
    expect(r.applicationID).toBe('app-1')
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('version-create')
  })
})

// ── 8. activate: PUTが呼ばれ、再取得で一致してから記録する ──────────────────────────────

describe('publishAppFlow: 8. activate は現在値と新版が違うときだけ PUT し、再取得で一致を確かめる', () => {
  it('activeVersion(旧) !== 新版 → PUT が呼ばれ、再取得で一致すれば activeVersion/appPublishedAt を記録', async () => {
    recordCluster()
    const calls: string[] = []
    const putBodies: any[] = []
    let getAppCount = 0
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      let raw = ''
      req.on('data', c => { raw += c })
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          if (status === 204) { res.writeHead(204); res.end(); return }
          res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
        }
        if (key === 'GET /clusters/cluster-x') return send(200, CLUSTER_LE_TRUE.body)
        if (key === 'GET /applications?clusterID=cluster-x&maxItems=20') return send(200, { applications: [] })
        if (key === 'POST /applications') return send(200, { application: { applicationID: 'app-1' } })
        if (key === 'POST /applications/app-1/versions') return send(200, { applicationVersion: { version: 2 } })
        if (key === 'GET /applications/app-1') {
          getAppCount++
          const activeVersion = getAppCount === 1 ? 1 : 2 // 1回目は旧版、PUT後の2回目は新版
          return send(200, { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion } })
        }
        if (key === 'PUT /applications/app-1') {
          putBodies.push(raw ? JSON.parse(raw) : null)
          return send(204, {})
        }
        if (key === 'GET /applications/app-1/versions?maxItems=20') return send(200, { versions: [] })
        if (key === LB_NODES_KEY) return send(200, LB_NODES_ONE.body) // D-5: 空だと lb-address 段が待つので実測の形を返す
        send(404, { error: `未定義のルート ${key}` })
      })
    })
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.version).toBe(2)
    expect(putBodies).toEqual([{ activeVersion: 2 }])
    expect(getAppCount).toBe(2)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.activeVersion).toBe(2)
    expect(rec.appPublishedAt).toBeTruthy()
  })

  it('再取得しても一致しなければ stage:activate で止める（記録の activeVersion・hosts は残さない／前の値のまま）', async () => {
    recordCluster()
    // B（2026-09-17）: 前回公開済みのホスト名が既に記録にある状態を再現する。
    writeApprunDedicatedRecordFs(projectDir, { hosts: ['old.example.com'] })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
      'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
      'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
      'POST /applications/app-1/versions': { status: 200, body: { applicationVersion: { version: 2 } } },
      'GET /applications/app-1': { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 1 } } },
      'PUT /applications/app-1': { status: 204, body: {} },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('activate')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.activeVersion).toBeFalsy()
    // B: 新しいホスト名（spec.host＝app.example.com）で上書きされず、前の値のまま。
    expect(rec.hosts).toEqual(['old.example.com'])
  })

  it('取得した activeVersion が既に新版と一致していれば PUT を呼ばない（自動有効化の可能性を許容）', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      req.on('data', () => {})
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          if (status === 204) { res.writeHead(204); res.end(); return }
          res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
        }
        if (key === 'GET /clusters/cluster-x') return send(200, CLUSTER_LE_TRUE.body)
        if (key === 'GET /applications?clusterID=cluster-x&maxItems=20') return send(200, { applications: [] })
        if (key === 'POST /applications') return send(200, { application: { applicationID: 'app-1' } })
        if (key === 'POST /applications/app-1/versions') return send(200, { applicationVersion: { version: 1 } })
        if (key === 'GET /applications/app-1') return send(200, { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 1 } })
        if (key === 'GET /applications/app-1/versions?maxItems=20') return send(200, { versions: [] })
        if (key === LB_NODES_KEY) return send(200, LB_NODES_ONE.body) // D-5: 空だと lb-address 段が待つので実測の形を返す
        send(404, { error: `未定義のルート ${key}` })
      })
    })
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(calls).not.toContain('PUT /applications/app-1')
    expect(calls.filter(c => c === 'GET /applications/app-1').length).toBe(1) // 一致していたので再取得しない
  })
})

// ── 9. cleanup: active は消さない。keepを超えた古いバージョンだけ削除する ────────────────

describe('publishAppFlow: 9. cleanup は active（新版）を消さず、DEFAULT_KEEP（5）を超えた古いものだけ消す', () => {
  it('7版あるうち keep=5＋active=7 → 消えるのは version:1 のみ。DELETEの失敗は warnings に載るが ok:true のまま', async () => {
    recordCluster()
    const calls: string[] = []
    let getAppCount = 0
    const deletedVersions: number[] = []
    const versions = Array.from({ length: 7 }, (_, i) => ({ version: i + 1, image: 'x', activeNodeCount: i + 1 === 7 ? 1 : 0, created: i + 1 }))
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      req.on('data', () => {})
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          if (status === 204) { res.writeHead(204); res.end(); return }
          res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
        }
        if (key === 'GET /clusters/cluster-x') return send(200, CLUSTER_LE_TRUE.body)
        if (key === 'GET /applications?clusterID=cluster-x&maxItems=20') return send(200, { applications: [] })
        if (key === 'POST /applications') return send(200, { application: { applicationID: 'app-1' } })
        if (key === 'POST /applications/app-1/versions') return send(200, { applicationVersion: { version: 7 } })
        if (key === 'GET /applications/app-1') {
          getAppCount++
          const activeVersion = getAppCount === 1 ? 6 : 7 // 1回目は旧版、PUT 後の2回目は新版（実 API の振る舞いを模す）
          return send(200, { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion } })
        }
        if (key === 'PUT /applications/app-1') return send(204, {})
        if (key === 'GET /applications/app-1/versions?maxItems=20') return send(200, { versions })
        if (key === 'DELETE /applications/app-1/versions/1') { deletedVersions.push(1); return send(204, {}) }
        if (key === LB_NODES_KEY) return send(200, LB_NODES_ONE.body) // D-5: 空だと lb-address 段が待つので実測の形を返す
        send(404, { error: `未定義のルート ${key}` })
      })
    })
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(deletedVersions).toEqual([1]) // active(7)はもちろん、keep内の2〜6も消えない
    expect(calls).not.toContain('DELETE /applications/app-1/versions/7')
    expect(calls.filter(c => c.startsWith('DELETE /applications/app-1/versions/')).length).toBe(1)
  })

  it('世代掃除のDELETEが失敗しても、公開自体は成功扱い（ok:true）で warnings に載る', async () => {
    recordCluster()
    const calls: string[] = []
    const versions = Array.from({ length: 7 }, (_, i) => ({ version: i + 1, image: 'x', activeNodeCount: 0, created: i + 1 }))
    const baseUrl = await listen((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      req.on('data', () => {})
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          if (status === 204) { res.writeHead(204); res.end(); return }
          res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
        }
        if (key === 'GET /clusters/cluster-x') return send(200, CLUSTER_LE_TRUE.body)
        if (key === 'GET /applications?clusterID=cluster-x&maxItems=20') return send(200, { applications: [] })
        if (key === 'POST /applications') return send(200, { application: { applicationID: 'app-1' } })
        if (key === 'POST /applications/app-1/versions') return send(200, { applicationVersion: { version: 7 } })
        if (key === 'GET /applications/app-1') return send(200, { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 7 } })
        if (key === 'GET /applications/app-1/versions?maxItems=20') return send(200, { versions })
        if (key === 'DELETE /applications/app-1/versions/1') return send(500, { status: 500, title: 'boom' })
        if (key === LB_NODES_KEY) return send(200, LB_NODES_ONE.body) // D-5: 空だと lb-address 段が待つので実測の形を返す
        send(404, { error: `未定義のルート ${key}` })
      })
    })
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.warnings?.some(w => w.includes('バージョン『1』の削除に失敗しました'))).toBe(true)
  })
})

// ── 10. lb-address: LBノードのアドレスが記録される ───────────────────────────────────

describe('publishAppFlow: 10. LBノードのアドレスが lbAddresses として記録・応答に載る', () => {
  it('load_balancer_nodes の addresses が record.lbAddresses / 応答.lbAddresses に入る', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
      'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
      'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
      'POST /applications/app-1/versions': { status: 200, body: { applicationVersion: { version: 1 } } },
      'GET /applications/app-1': { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 1 } } },
      'GET /applications/app-1/versions?maxItems=20': { status: 200, body: { versions: [{ version: 1, image: 'x', activeNodeCount: 1, created: 1 }] } },
      'GET /clusters/cluster-x/asg/asg-y/load_balancers/lb-z/load_balancer_nodes?maxItems=20': {
        status: 200,
        body: { loadBalancerNodes: [{ loadBalancerNodeID: 'n1', status: 'up', interfaces: [{ interfaceIndex: 0, addresses: [{ address: '203.0.113.10', vip: false }] }] }] },
      },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.lbAddresses).toEqual(['203.0.113.10'])
    expect(r.url).toBe('https://app.example.com/')
    expect(r.message).toContain('203.0.113.10')
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.lbAddresses).toEqual(['203.0.113.10'])
  })

  it('アドレスが1件も取れなければ warnings に載るが、ok:true のまま（公開は成功している）', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
      'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
      'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
      'POST /applications/app-1/versions': { status: 200, body: { applicationVersion: { version: 1 } } },
      'GET /applications/app-1': { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 1 } } },
      'GET /applications/app-1/versions?maxItems=20': { status: 200, body: { versions: [{ version: 1, image: 'x', activeNodeCount: 1, created: 1 }] } },
      'GET /clusters/cluster-x/asg/asg-y/load_balancers/lb-z/load_balancer_nodes?maxItems=20': { status: 500, body: { status: 500, title: 'boom' } },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.lbAddresses).toBeUndefined()
    expect(r.warnings?.some(w => w.includes('ロードバランサノードのアドレスを取得できませんでした'))).toBe(true)
  })
})

// ── 11. 正常系の要求列を順番ごと固定する ─────────────────────────────────────────────
//
// GET cluster → GET applications → POST applications → POST versions → GET application →
// PUT → GET application → GET versions → GET lb nodes（cleanupで削除が0件になるようversionを
// keep内に収め、DELETEが混ざらない形にしてある）。

describe('publishAppFlow: 11. 正常系の呼び出し順を固定する（掟10「作る順番は機能の一部」）', () => {
  it('9回のfetchが、この順で1回ずつ呼ばれる', async () => {
    recordCluster()
    const calls: string[] = []
    const bodies: Record<string, any> = {}
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
      'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
      'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
      'POST /applications/app-1/versions': { status: 200, body: { applicationVersion: { version: 2 } } },
      'GET /applications/app-1': [
        { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 1 } } }, // PUT 前
        { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 2 } } }, // PUT 後
      ],
      'PUT /applications/app-1': { status: 204, body: {} },
      'GET /applications/app-1/versions?maxItems=20': { status: 200, body: { versions: [{ version: 1, image: 'x', activeNodeCount: 0, created: 1 }, { version: 2, image: 'x', activeNodeCount: 1, created: 2 }] } },
      [LB_NODES_KEY]: LB_NODES_ONE, // D-5: 空だと lb-address 段が待つ（sleep 未注入なら実時間）ので実測の形を返す
    }, calls, (key, body) => { bodies[key] = body }))

    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)

    // GET /applications/app-1 が2回（activateの前後）出るため、ユニークなキー列としてではなく
    // 実際に発生した順序そのものを固定する。
    expect(calls).toEqual([
      'GET /clusters/cluster-x',
      'GET /applications?clusterID=cluster-x&maxItems=20',
      'POST /applications',
      'POST /applications/app-1/versions',
      'GET /applications/app-1',
      'PUT /applications/app-1',
      'GET /applications/app-1',
      'GET /applications/app-1/versions?maxItems=20',
      'GET /clusters/cluster-x/asg/asg-y/load_balancers/lb-z/load_balancer_nodes?maxItems=20',
    ])
    expect(r.ok).toBe(true)
    expect(r.stage).toBe('done')
    expect(r.applicationID).toBe('app-1')
    expect(r.version).toBe(2)
    // D-5: 実測の `59.106.222.212/24` は素の IP になって応答・message に載る（`/` を含まない）
    expect(r.lbAddresses).toEqual(['59.106.222.212'])
    expect(r.message).toBe('公開しました。DNS の A レコードを次の IP に向けてください: 59.106.222.212')

    expect(bodies['POST /applications']).toEqual({ name: 'myapp2', clusterID: 'cluster-x' })
    expect(bodies['POST /applications/app-1/versions']).toMatchObject({
      image: 'jp1.sakuracr.jp/example/myapp2:v1',
      cpu: 500,
      memory: 512,
      scalingMode: 'manual',
      fixedScale: 1,
      registryUsername: 'reg-user',
      registryPassword: 'reg-pass',
      registryPasswordAction: 'new',
    })
    expect(bodies['POST /applications/app-1/versions'].exposedPorts).toEqual([
      { targetPort: 8080, loadBalancerPort: 443, useLetsEncrypt: true, healthCheck: null, host: ['app.example.com'] },
    ])
    expect(bodies['PUT /applications/app-1']).toEqual({ activeVersion: 2 })

    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.applicationID).toBe('app-1')
    expect(rec.applicationName).toBe('myapp2')
    expect(rec.activeVersion).toBe(2)
    expect(rec.imageRef).toBe('jp1.sakuracr.jp/example/myapp2:v1')
    expect(rec.hosts).toEqual(['app.example.com'])
    expect(rec.appPort).toBe(8080)
    expect(rec.appCpu).toBe(500)
    expect(rec.appMemory).toBe(512)
    expect(rec.appFixedScale).toBe(1)
    expect(rec.appPublishedAt).toBeTruthy()
  })
})

// ── B（2026-09-17）: 公開が途中で失敗しても、記録の hosts は前の値のまま ─────────────────────
// 4段目（record）が hosts/appPort 等を新しい値へ先に書いていたため、後段（version-create 等）で
// 失敗すると「未公開の新しいホスト名」だけが記録に残り、⑧が緑字で「公開中: https://（新しい・
// 未公開のホスト名）/」と誤表示していた。実際に効く（＝反映される）のは版なので、いまは
// 9段目（activate の一致確認が通ったあと）でまとめて書く。

describe('publishAppFlow: B. hosts 等は「実際に効く」9段目（activate）まで進めない', () => {
  it('★ 後段（version-create）で失敗しても、記録の hosts は前の値のまま（新しい値で上書きされない）', async () => {
    recordCluster()
    writeApprunDedicatedRecordFs(projectDir, {
      hosts: ['old.example.com'], applicationName: 'oldname',
      appPort: 3000, appCpu: 100, appMemory: 128, appFixedScale: 1,
    })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
      'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
      'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
      'POST /applications/app-1/versions': { status: 500, body: { status: 500, title: 'boom（この先は別テストの対象外）' } },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    expect(r.stage).toBe('version-create')
    const rec = readApprunDedicatedFs(projectDir)
    // spec.host（app.example.com）へは進まず、前の値のまま。
    expect(rec.hosts).toEqual(['old.example.com'])
    expect(rec.appPort).toBe(3000)
    expect(rec.appCpu).toBe(100)
    expect(rec.appMemory).toBe(128)
  })

  it('★ 初回公開でバージョン作成に失敗したとき、hosts は記録されない（一度も公開されていないものを「公開中」として出さない）', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({
      'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
      'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
      'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
      'POST /applications/app-1/versions': { status: 500, body: { status: 500, title: 'boom（この先は別テストの対象外）' } },
    }, calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(false)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.hosts).toBeUndefined()
    expect(rec.appPort).toBeUndefined()
    // applicationID は POST /applications が成功した時点で記録される（従来どおり・確認は待たない）。
    expect(rec.applicationID).toBe('app-1')
  })

  it('最後まで通ったときは、新しいホスト名が記録される（section 11 と同趣旨。4段目では書かれず、9段目で書かれることを確かめる）', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), CONFIRMED, baseUrl)
    expect(r.ok).toBe(true)
    const rec = readApprunDedicatedFs(projectDir)
    expect(rec.hosts).toEqual(['app.example.com'])
  })
})

// ── 12. D-5（2026-09-16 実測）: lb-address 段は「素の IP」にし、空なら 10 秒おき・最長 3 分まで取り直す ──
//
// 実測: クラスタ作成の約2分後の⑧では load_balancer_nodes のアドレスが空で「見つかりませんでした」、
// 数分後の probe では `59.106.222.212/24`（ネットマスク付き）が付いていた。sleep は偽物を注入し、
// 実際には1ミリ秒も待たずにループの動きを確かめる（waitUntilGone と同じ方針・#39）。

/** lb-address 段まで到達する最小の経路（version 1 が自動で有効・掃除なし）。LB ノードの応答だけ差し替える。 */
function routesUntilLbAddress(lbNodes: Route | Route[]): Record<string, Route | Route[]> {
  return {
    'GET /clusters/cluster-x': CLUSTER_LE_TRUE,
    'GET /applications?clusterID=cluster-x&maxItems=20': { status: 200, body: { applications: [] } },
    'POST /applications': { status: 200, body: { application: { applicationID: 'app-1' } } },
    'POST /applications/app-1/versions': { status: 200, body: { applicationVersion: { version: 1 } } },
    'GET /applications/app-1': { status: 200, body: { application: { applicationID: 'app-1', name: 'myapp2', clusterID: 'cluster-x', activeVersion: 1 } } },
    'GET /applications/app-1/versions?maxItems=20': { status: 200, body: { versions: [{ version: 1, image: 'x', activeNodeCount: 1, created: 1 }] } },
    [LB_NODES_KEY]: lbNodes,
  }
}

describe('publishAppFlow: 12. lb-address 段は空なら待って取り直し、取れた IP は素の IP（D-5）', () => {
  it('★(a) 1回目は空・2回目で `59.106.222.212/24` が付く → sleep(10000) が1回呼ばれ、記録・応答・message は素の IP', async () => {
    recordCluster()
    const calls: string[] = []
    const sleeps: number[] = []
    const progress: string[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress([LB_NODES_EMPTY, LB_NODES_ONE]), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), {
      confirmed: true, sleep: fakeSleep(sleeps), progress: m => progress.push(m), probeMarker: quietProbe,
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([10000]) // 既定 10 秒おき
    expect(calls.filter(c => c === LB_NODES_KEY).length).toBe(2)
    expect(r.lbAddresses).toEqual(['59.106.222.212'])
    expect(r.message).toContain('59.106.222.212')
    expect(r.message).not.toContain('/24')
    expect(readApprunDedicatedFs(projectDir).lbAddresses).toEqual(['59.106.222.212'])
    // D-19: 既定の makeInput は像の種類も目印の版も渡していないが、**確認はとばさない**
    // （根へ当てて応答があるかを見る）。直す前はここで「確認をとばしました」が1行出ていた。
    expect(r.warnings ?? []).toEqual([])
    expect(r.verify).toBe('responding')
    // 待っている間の進捗（画面向け）
    expect(progress).toContain('ロードバランサの IP が付くのを待っています（10秒経過）…')
  })

  it('★(b) 最後まで空 → 3分（10秒×18回）待ってから諦め、従来の warning。記録の lbAddresses は残さない', async () => {
    recordCluster()
    const calls: string[] = []
    const sleeps: number[] = []
    const progress: string[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_EMPTY), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), { confirmed: true, sleep: fakeSleep(sleeps), progress: m => progress.push(m) }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps.length).toBe(18) // 3分 ÷ 10秒
    expect(sleeps.every(ms => ms === 10000)).toBe(true)
    expect(calls.filter(c => c === LB_NODES_KEY).length).toBe(19) // 初回 + 18回の取り直し
    expect(r.lbAddresses).toBeUndefined()
    expect(r.warnings?.some(w => w.includes('ロードバランサノードのアドレスが見つかりませんでした'))).toBe(true)
    expect(r.message).toContain('IP を取り直す')
    // B（D-19）: 確認できなかったので記録に IP は残らない（前の値が無い場合は null が書かれる）。
    expect(readApprunDedicatedFs(projectDir).lbAddresses ?? null).toBeNull()
    expect(progress[progress.length - 2]).toBe('ロードバランサの IP が付くのを待っています（3分経過）…') // 最後は「完了しました」
  })

  it('★(c) 取れた IP に `/` が含まれない（`IP/24` を `/` ごと A レコードに案内しない）', async () => {
    recordCluster()
    const calls: string[] = []
    const two = { status: 200, body: { loadBalancerNodes: [
      { loadBalancerNodeID: 'lbn-1', status: 'healthy', interfaces: [{ interfaceIndex: 0, addresses: [{ address: '59.106.222.212/24', vip: false }] }] },
      { loadBalancerNodeID: 'lbn-2', status: 'healthy', interfaces: [{ interfaceIndex: 0, addresses: [{ address: '59.106.222.213/24', vip: false }] }] },
    ] } }
    const baseUrl = await listen(routedServer(routesUntilLbAddress(two), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), { confirmed: true, sleep: fakeSleep([]), probeMarker: quietProbe }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.lbAddresses).toEqual(['59.106.222.212', '59.106.222.213'])
    for (const ip of r.lbAddresses ?? []) expect(ip).not.toContain('/')
    for (const ip of readApprunDedicatedFs(projectDir).lbAddresses ?? []) expect(ip).not.toContain('/')
  })

  it('intervalMs / timeoutMs を渡せば、その間隔・上限で回る（1秒×2回）', async () => {
    recordCluster()
    const calls: string[] = []
    const sleeps: number[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_EMPTY), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), { confirmed: true, sleep: fakeSleep(sleeps), intervalMs: 1000, timeoutMs: 2000 }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([1000, 1000])
    expect(calls.filter(c => c === LB_NODES_KEY).length).toBe(3)
  })

  it('取得そのものが失敗（HTTP 500）なら待たずに warning（従来どおり。sleep は呼ばれない）', async () => {
    recordCluster()
    const calls: string[] = []
    const sleeps: number[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress({ status: 500, body: { status: 500, title: 'boom' } }), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), { confirmed: true, sleep: fakeSleep(sleeps) }, baseUrl)
    expect(r.ok).toBe(true)
    expect(sleeps).toEqual([])
    expect(calls.filter(c => c === LB_NODES_KEY).length).toBe(1)
    expect(r.warnings?.some(w => w.includes('ロードバランサノードのアドレスを取得できませんでした'))).toBe(true)
  })
})

// ── 12-2. B（D-19・2026-09-16）: 確かめられない IP を、現在のものとして残さない ─────────────
//
// 直す前の lb-address 段は「**取れたときだけ**記録に書く」だった。取れなかったときに前の値を
// 消していないので、**前のクラスタの IP が記録に残っていれば、それを現在の IP として画面に出す**。
// ⑧はそれを「DNS の A レコードをこの IP に向けてください」と案内するので、利用者は
// **間違った先へ DNS を向ける**ことになる。記録の `lbAddresses` は「いまのクラスタの
// ロードバランサの IP」であって、前のクラスタのものが残ってよい理由は無い。

/** 前の公開（前のクラスタ）の IP が記録に残っている状態を作る。 */
function recordStaleIp() {
  writeApprunDedicatedRecordFs(projectDir, { lbAddresses: ['203.0.113.99'] })
}

describe('publishAppFlow: 12-2. 確かめられなかった IP は記録から消す（B・D-19）', () => {
  it('★★ 前の IP がある状態で、時間切れまで取れない → 記録の lbAddresses が消える（古い IP を出し続けない）', async () => {
    recordCluster()
    recordStaleIp()
    expect(readApprunDedicatedFs(projectDir).lbAddresses).toEqual(['203.0.113.99'])
    const calls: string[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_EMPTY), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), {
      confirmed: true, sleep: fakeSleep([]), intervalMs: 1000, timeoutMs: 1000,
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.lbAddresses).toBeUndefined() // 応答にも載せない
    // ★ ここが残ると、画面は前のクラスタの IP を「DNS の A レコード」として出し続ける
    expect(readApprunDedicatedFs(projectDir).lbAddresses ?? null).toBeNull()
    expect(r.message).toContain('IP を取り直す')
  })

  it('★★ 前の IP がある状態で、取得そのものが失敗（HTTP 500）→ 記録の lbAddresses が消える', async () => {
    recordCluster()
    recordStaleIp()
    const calls: string[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress({ status: 500, body: { status: 500, title: 'boom' } }), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), { confirmed: true, sleep: fakeSleep([]) }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.lbAddresses).toBeUndefined()
    expect(readApprunDedicatedFs(projectDir).lbAddresses ?? null).toBeNull()
  })

  it('★★ 取れたときは、前の IP が新しい IP に置き換わる（消えっぱなしにはしない）', async () => {
    recordCluster()
    recordStaleIp()
    const calls: string[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), {
      confirmed: true, sleep: fakeSleep([]), probeMarker: quietProbe,
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.lbAddresses).toEqual(['59.106.222.212'])
    expect(readApprunDedicatedFs(projectDir).lbAddresses).toEqual(['59.106.222.212'])
  })

  it('★★ IP を確かめられなかったので、応答の確認もとばす（当てに行く先が無い＝行き先は古い IP ではない）', async () => {
    recordCluster()
    recordStaleIp()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_EMPTY), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput(), {
      confirmed: true, sleep: fakeSleep([]), intervalMs: 1000, timeoutMs: 1000,
      probeMarker: fakeProbe([{ reached: true, status: 200, body: 'ok' }], probes),
    }, baseUrl)
    expect(r.verify).toBeUndefined()
    expect(probes).toEqual([]) // 記録に残っていた古い IP へ当てに行かない
  })
})

// ── 13. refreshLbAddresses（⑧「🔄 IP を取り直す」・D-5）: GET 1回＋記録。何も作らない・待たない ──

describe('refreshLbAddresses: 記録の ID で LB ノードを1回引き、素の IP を記録して返す（D-5）', () => {
  it('★ 実測の形（`59.106.222.212/24`）→ ok:true・lbAddresses は素の IP・記録にも書く・GET は1回だけ', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({ [LB_NODES_KEY]: LB_NODES_ONE }, calls))
    const r = await refreshLbAddresses(AUTH, projectDir, baseUrl)
    expect(r).toEqual({ ok: true, lbAddresses: ['59.106.222.212'] })
    expect(calls).toEqual([LB_NODES_KEY]) // GET のみ・1回
    expect(readApprunDedicatedFs(projectDir).lbAddresses).toEqual(['59.106.222.212'])
  })

  it('記録にクラスタ・ASG・LB が揃っていなければ API を呼ばずに ok:false', async () => {
    const calls: string[] = []
    const baseUrl = await listen(routedServer({ [LB_NODES_KEY]: LB_NODES_ONE }, calls))
    const r = await refreshLbAddresses(AUTH, projectDir, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('⑤でクラスタを作ってから')
    expect(calls).toEqual([])
  })

  it('★ まだ空なら ok:false（「まだ付いていません」）で、前に取れていた記録の lbAddresses を空で上書きしない', async () => {
    recordCluster()
    writeApprunDedicatedRecordFs(projectDir, { lbAddresses: ['203.0.113.10'] })
    const calls: string[] = []
    const baseUrl = await listen(routedServer({ [LB_NODES_KEY]: LB_NODES_EMPTY }, calls))
    const r = await refreshLbAddresses(AUTH, projectDir, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('まだ付いていません')
    expect(calls).toEqual([LB_NODES_KEY]) // 待たずに1回で返す（待つのは publishAppFlow の役目）
    expect(readApprunDedicatedFs(projectDir).lbAddresses).toEqual(['203.0.113.10'])
  })

  it('取得に失敗（HTTP 500）→ ok:false・生の message を添える・記録は触らない', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer({ [LB_NODES_KEY]: { status: 500, body: { status: 500, title: 'boom' } } }, calls))
    const r = await refreshLbAddresses(AUTH, projectDir, baseUrl)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('ロードバランサノードのアドレスを取得できませんでした')
    expect(readApprunDedicatedFs(projectDir).lbAddresses).toBeUndefined()
  })
})

// ── 14. D-7（2026-09-16 実機・0.6.19-rc.1）: 「公開しました」と言う前に、アプリが応答しているか確かめる ──
//
// 実機では、ここまでの全段が通っても、ロードバランサが 503 `no available server` を返し続けていた
// （＝LB から見て健全なバックエンドが1つも登録されていない。コンテナ自体が起動していたかは未確認——
// 同じ日のコンパネは「稼働コンテナ 1・アクティブ」と表示していた＝docs/apprun-dedicated-plan.md 5-13）。
// それでも Koto は「✅ 公開しました」と出し、利用者は応答しないアプリのために DNS を設定しに行った。
// **確かめていないことを「大丈夫」に倒さない。**
//
// 確認の処理（`node:https` の GET・Host と SNI・自己署名でも通す）は `opts.probeMarker` で
// 差し替えられる。**ここでは偽物を渡す**ので、実ネットワークにも自己署名証明書にも依存しない。

type ProbeArgs = { ip: string; host: string; path: string; timeoutMs: number }

/** 呼ばれた引数を記録し、渡された応答を順に返す偽の probe（最後の要素を繰り返す）。 */
function fakeProbe(seq: DedicatedProbe[], log: ProbeArgs[]): (a: ProbeArgs) => Promise<DedicatedProbe> {
  return async (a) => { log.push(a); return seq[Math.min(log.length - 1, seq.length - 1)] }
}

/** 静的配信の像として公開する入力（目印 `.koto-build` の中身は VERIFY_TAG）。 */
const VERIFY_TAG = 'v20260916-083525'
function verifiableInput(): PublishAppInput {
  return makeInput({ buildTag: VERIFY_TAG, runtimeKind: 'static' })
}

describe('publishAppFlow: 14. 公開のあと、アプリが応答しているかを確かめる（D-7）', () => {
  it('★(a) 200＋目印が一致 → verify:"ok"。IP・ホスト名・目印のパス・10秒の上限で1回だけ当てる', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const progress: string[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]), progress: m => progress.push(m),
      probeMarker: fakeProbe([{ reached: true, status: 200, body: `${VERIFY_TAG}\n` }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe('ok')
    expect(probes.length).toBe(1) // 一致したらそこで止める
    expect(probes[0].ip).toBe('59.106.222.212') // lbAddresses[0]（DNS はまだ向いていない）
    expect(probes[0].host).toBe('app.example.com') // Host ヘッダと SNI に使うホスト名
    expect(probes[0].path.startsWith('/.koto-build')).toBe(true)
    expect(probes[0].timeoutMs).toBe(10000)
    expect(progress).toContain('🩺 アプリが応答するか確かめています…')
    expect(r.warnings ?? []).toEqual([])
  })

  it('★★(b) 503（no available server）→ verify:"no-backend"。**ok:true のまま**（公開の手続き自体は通っている）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const sleeps: number[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep(sleeps),
      probeMarker: fakeProbe([{ reached: true, status: 503, body: 'no available server' }], probes),
    }, baseUrl)
    expect(r.verify).toBe('no-backend') // ← ここが 'ok' に緩むと 2026-09-16 の事故が戻る
    expect(r.ok).toBe(true)
    expect(r.stage).toBe('done')
    // 短く諦めない（verifyDelaysMs の回数だけ取り直す。sleep は偽物なので実時間は使わない）
    expect(probes.length).toBe(verifyDelaysMs().length + 1)
    expect(sleeps).toEqual(verifyDelaysMs())
  })

  // F（D-7b・検分の指摘）: verify 段で probe が例外を投げると、直す前は publishAppFlow ごと throw し、
  // 呼び出し側（IPC）の catch で { ok:false, stage:'invalid' } に化けていた——
  // **公開の手続き自体はここまで全部通っているのに「失敗しました」と表示される**。
  it('★★(F) probe が例外を投げても publishAppFlow ごとは throw しない。verify:"unreachable"・warnings に1行残し、公開は成功のまま', async () => {
    recordCluster()
    const calls: string[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const throwingProbe = async (): Promise<DedicatedProbe> => { throw new Error('boom: getaddrinfo ENOTFOUND') }
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]), probeMarker: throwingProbe,
    }, baseUrl)
    expect(r.ok).toBe(true) // 例外で「失敗しました」に化けていないこと
    expect(r.stage).toBe('done')
    expect(r.verify).toBe('unreachable')
    expect(r.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('boom: getaddrinfo ENOTFOUND')]),
    )
  })

  it('★★(c) 200 だが目印が古い → verify:"stale"（応答はしているが、配られているのは前の版）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 200, body: 'v20260916-070000\n' }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe('stale')
  })

  it('★★(d) 接続できない → verify:"unreachable"（「動いていない」の証明にはしない）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: false }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe('unreachable')
  })

  // ── D-19（2026-09-16）: (e)(f) は**直す前の振る舞い**（Node なら確認をとばす）を固定していた。
  //   実機で「✅ 公開しました／・このアプリは応答の確認の対象外のため、確認をとばしました」と
  //   出たのが、まさにこの2本が守っていた形である。**守りたかった場面を守れていなかった**ので、
  //   いまは Node でも根（/）へ当てに行く（下の 14-2 が新しい振る舞いを固定する）。

  it('★★(e) Node の像（目印を配るとは限らない）でも確認をとばさない。根（/）へ当てて responding', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput({ buildTag: VERIFY_TAG, runtimeKind: 'node' }), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 200, body: '<html>ScheduleAPP</html>' }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe('responding') // ← 直す前は undefined（確認そのものをとばしていた）
    expect(probes.length).toBe(1)
    expect(probes[0].path.startsWith('/?t=')).toBe(true) // 目印ではなく根へ当てる
    // **とばしていないので、「とばしました」の1行は出ない**
    expect((r.warnings ?? []).some(w => w.includes('確認をとばしました'))).toBe(false)
  })

  it('★★(f) 静的配信でも版が分からなければ、目印と比べようが無いので根へ当てる（推測で ok にしない）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, makeInput({ runtimeKind: 'static' }), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 200, body: 'なにか\n' }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe('responding') // 応答は確かめた。**中身が新しいかは確かめていない**
    expect(r.verify).not.toBe('ok')
    expect(probes.length).toBe(1)
    expect(probes[0].path.startsWith('/?t=')).toBe(true)
  })

  it('★ IP が1つも取れていなければ、当てに行く先が無いので確認そのものをしない（probe はゼロ）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_EMPTY), calls))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]), intervalMs: 1000, timeoutMs: 1000,
      probeMarker: fakeProbe([{ reached: true, status: 200, body: `${VERIFY_TAG}\n` }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBeUndefined()
    expect(probes).toEqual([])
  })

  // ── D-14 A（2026-09-16 の検分）: **とばしたことを黙って落とさない** ────────────────
  //
  // 直す前は、IP が取れないと verify 段の `if` に入らないまま先へ進み、**warnings に
  // 何も残らなかった**。それでも画面は「✅ 公開しました」と出る——**確かめずに成功を
  // 名乗る**（D-7 でいちばん最初に直した欠陥）が、別の道から戻ってきた形である。
  // README・使い方ガイドは「確かめられないときは、確認をとばしたことをお知らせします」と
  // 約束しているので、**約束のほうを実装で固定する**（掟9・掟10）。
  it('★★(A) IP が1つも取れていないとき、verify は付かず、warnings に「とばした」旨が1行ある（D-14 A）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_EMPTY), calls))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]), intervalMs: 1000, timeoutMs: 1000,
      probeMarker: fakeProbe([{ reached: true, status: 200, body: `${VERIFY_TAG}\n` }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBeUndefined()
    expect(probes).toEqual([])
    // 「とばした」旨がちょうど1行あること（無言で通り過ぎない）
    const skipped = (r.warnings ?? []).filter(w => w.includes('確認をとばしました'))
    expect(skipped.length).toBe(1)
    // どちらの理由でとばしたのかが分かること（像の作りの話と取り違えない）
    expect(skipped[0]).toContain('ロードバランサの IP が取れなかったため')
    expect(skipped[0]).not.toContain('応答の確認の対象外')
  })

  it('★★ 途中で届いていた事実（503）を、最後の1回がつながらなかっただけで unreachable に薄めない', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const seq: DedicatedProbe[] = [
      { reached: true, status: 503, body: 'no available server' },
      { reached: false },
    ]
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]), probeMarker: fakeProbe(seq, probes),
    }, baseUrl)
    expect(r.verify).toBe('no-backend')
    expect(r.ok).toBe(true)
  })

  it('★ 最初はつながらなくても、あとで目印が一致すれば ok（コンテナが立ち上がるのを待つ）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const seq: DedicatedProbe[] = [
      { reached: false },
      { reached: true, status: 503, body: 'no available server' },
      { reached: true, status: 200, body: `${VERIFY_TAG}\n` },
    ]
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]), probeMarker: fakeProbe(seq, probes),
    }, baseUrl)
    expect(r.verify).toBe('ok')
    expect(probes.length).toBe(3) // 一致したらそこで止める
  })
})

// ── 14-2. D-19（2026-09-16）: Node アプリでも応答を確かめる ─────────────────────────
//
// 今日の一連の修理の出発点は「**アプリが動いていないのに『✅ 公開しました』と出た**」ことで、
// そのアプリは **Node アプリ**（`ScheduleAPP`＝`public/server.js`）だった。実機の画面:
//   ✅ 公開しました
//   ・このアプリは応答の確認の対象外のため、確認をとばしました（版の目印を持つのは静的配信の公開だけです）。
// **守りたかった場面を守れていなかった。** Node では目印（`.koto-build`）が配られるとは限らないので、
// 代わりに根（`/`）へ当てて「応答があるか」だけを見る。**`ok` とは呼ばない**（`responding`）。

/** Node の像として公開する入力（目印は使えない＝根へ当てる）。 */
function nodeInput(): PublishAppInput {
  return makeInput({ buildTag: VERIFY_TAG, runtimeKind: 'node' })
}

describe('publishAppFlow: 14-2. Node の像は根（/）へ当てて応答を確かめる（D-19）', () => {
  it('★★ 503（no available server）→ no-backend。**今日の失敗がそのまま画面に出る**（ok:true のまま）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const sleeps: number[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep(sleeps),
      probeMarker: fakeProbe([{ reached: true, status: 503, body: 'no available server' }], probes),
    }, baseUrl)
    expect(r.verify).toBe('no-backend') // ← ここが undefined（とばす）に戻ると、今日の事故が戻る
    expect(r.ok).toBe(true)
    expect(probes[0].path.startsWith('/?t=')).toBe(true)
    // 短く諦めない（静的配信と同じ回数だけ取り直す）
    expect(probes.length).toBe(verifyDelaysMs().length + 1)
    expect(sleeps).toEqual(verifyDelaysMs())
  })

  it('★★ 200 でも ok にしない（目印を読んでいないので「中身が新しい」とは言えない）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    // 目印と同じ中身が返ってきたとしても、根へ当てているのだから ok とは呼ばない
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 200, body: `${VERIFY_TAG}\n` }], probes),
    }, baseUrl)
    expect(r.verify).toBe('responding')
    expect(r.verify).not.toBe('ok')
    expect(probes.length).toBe(1) // 応答が確かめられたらそこで止める
  })

  it('★ 302 のような応答は「応答している」＝ responding（届いてはいる）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 302, body: '' }], probes),
    }, baseUrl)
    expect(r.verify).toBe('responding')
  })

  // ── D-19b（2026-09-16 の検分）: 失敗応答を「応答している」に倒していた ───────────────
  // 直した直後は「503 以外はすべて responding」だったため、**LB がホスト名を振り分けられずに
  // 404 を返している**ときでも「✅ アプリが応答することを確認しました」を出し、
  // しかも responding は取り直しを止めてよい結果なので**1回目で打ち切っていた**。
  // （専有型の LB がホスト名の振り分けが効かないと `404 page not found` を返すことは
  //  2026-09-16 実機で観測済み・docs/apprun-dedicated-plan.md）
  it('★★ 404（LB がホスト名を振り分けられない）は responding にせず error-status。取り直しも続ける', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const sleeps: number[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep(sleeps),
      probeMarker: fakeProbe([{ reached: true, status: 404, body: '404 page not found' }], probes),
    }, baseUrl)
    expect(r.verify).toBe('error-status')
    expect(r.verify).not.toBe('responding')
    expect(r.ok).toBe(true) // 公開の手続き自体は通っている
    // 1回で打ち切らない（静的配信・503 と同じ回数だけ取り直す）
    expect(probes.length).toBe(verifyDelaysMs().length + 1)
    expect(sleeps).toEqual(verifyDelaysMs())
  })

  it('★★ 502（再起動中の入れ替わりでもありうる）も responding にしない', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 502, body: '' }], probes),
    }, baseUrl)
    expect(r.verify).toBe('error-status')
  })

  it('★★ 504 も responding にしない', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 504, body: '' }], probes),
    }, baseUrl)
    expect(r.verify).toBe('error-status')
  })

  it('★ 最初は 404 でも、あとで応答すれば responding（取り直しをやめないからこそ拾える）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const seq: DedicatedProbe[] = [
      { reached: true, status: 404, body: '404 page not found' },
      { reached: true, status: 200, body: 'ok' },
    ]
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep([]), probeMarker: fakeProbe(seq, probes),
    }, baseUrl)
    expect(r.verify).toBe('responding')
    expect(probes.length).toBe(2)
  })

  it('★★ 接続できない → unreachable（「動いていない」の証明にはしない）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: false }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.verify).toBe('unreachable')
    expect(probes.length).toBe(verifyDelaysMs().length + 1) // つながるまで短く諦めない
  })

  it('★ 最初は 503 でも、あとで応答すれば responding（コンテナが立ち上がるのを待つ）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const seq: DedicatedProbe[] = [
      { reached: true, status: 503, body: 'no available server' },
      { reached: true, status: 200, body: 'ok' },
    ]
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep([]), probeMarker: fakeProbe(seq, probes),
    }, baseUrl)
    expect(r.verify).toBe('responding')
    expect(probes.length).toBe(2)
  })

  it('★★ とばすのは、当てに行く先が無いときだけ（IP が無い）。像の種類ではとばさない', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_EMPTY), calls))
    const r = await publishAppFlow(AUTH, projectDir, nodeInput(), {
      confirmed: true, sleep: fakeSleep([]), intervalMs: 1000, timeoutMs: 1000,
      probeMarker: fakeProbe([{ reached: true, status: 200, body: 'ok' }], probes),
    }, baseUrl)
    expect(r.verify).toBeUndefined()
    expect(probes).toEqual([])
    const skipped = (r.warnings ?? []).filter(w => w.includes('確認をとばしました'))
    expect(skipped.length).toBe(1)
    expect(skipped[0]).toContain('ロードバランサの IP が取れなかったため')
    // 直す前の理由（像の作り）では、もうとばさない
    expect(skipped[0]).not.toContain('応答の確認の対象外')
  })
})

// ── G（D-7b・検分の指摘）: 既定の経路（probeMarkerOverHttps）が選ばれること自体を固定する ──
//
// 上の 14 のテストは全ケースで opts.probeMarker に偽物を注入しているため、**本番で使われる
// 既定の経路（opts.probeMarker を渡さないときに probeMarkerOverHttps が選ばれること自体）**を
// 固定した歯止めが無かった。ソースの呼び出しの形ごと（`const probe = opts.probeMarker ??
// probeMarkerOverHttps` の exact 一致）で固定する。

describe('publishAppFlow: G. opts.probeMarker を渡さないときは、既定で probeMarkerOverHttps が選ばれる', () => {
  it('★★ ソースの呼び出しの形を固定する（`const probe = opts.probeMarker ?? probeMarkerOverHttps`）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/cloud/apprunDedicatedAppApply.ts'), 'utf-8')
    expect(src).toContain('const probe = opts.probeMarker ?? probeMarkerOverHttps')
  })
})

// ── 15. D-7: 本番が実際に当てに行く唯一の経路（probeMarkerOverHttps）の中身を固定する ──────
//
// 上の 14 は `opts.probeMarker` に偽物を渡して**判定**（200／503／接続不能）を確かめている。
// だが本番が実際に送る要求を組み立てるのは既定の `probeMarkerOverHttps` で、そこには
// 仕様が名指しした性質がある: **443 番・SNI にホスト名・ヘッダは `Host` だけ・本文なし・
// 自己署名でも通す（rejectUnauthorized:false）・上限 10 秒**。
// ここが http に落ちても・SNI が落ちても・レジストリのパスワードがヘッダに足されても、
// 14 のテストは全部緑のままなので、**組み立てた要求そのもの**をここで固定する。
//
// 実ネットワークにも自己署名証明書にも依存しないよう、`node:https` の `request` を差し替えて
// 「どんな要求が組み立てられたか」を捕まえ、応答は偽の EventEmitter で流す。

type CapturedReq = {
  options: Record<string, unknown>
  /** 本文として書かれたもの（**空であること**が仕様: 秘密も本文も送らない）。 */
  wrote: unknown[]
  /** `end()` に渡された引数（本文を末尾で流し込んでいないこと）。 */
  endedWith: unknown[]
  destroyed: number
}

type ProbeScript =
  | { kind: 'response'; status?: number; chunks: string[] }
  | { kind: 'timeout' }
  | { kind: 'error' }

/** `https.request` を偽物に差し替え、組み立てられた要求を捕まえる（応答は script のとおりに流す）。 */
function captureHttpsRequests(script: ProbeScript): CapturedReq[] {
  const captured: CapturedReq[] = []
  vi.spyOn(https, 'request').mockImplementation(((options: Record<string, unknown>, cb: (res: unknown) => void) => {
    const rec: CapturedReq = { options, wrote: [], endedWith: [], destroyed: 0 }
    captured.push(rec)
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>
    req.write = (chunk: unknown) => { rec.wrote.push(chunk); return true }
    req.destroy = () => { rec.destroyed += 1 }
    req.end = (...args: unknown[]) => {
      rec.endedWith.push(...args)
      queueMicrotask(() => {
        if (script.kind === 'timeout') { req.emit('timeout'); return }
        if (script.kind === 'error') { req.emit('error', new Error('ECONNREFUSED')); return }
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>
        res.statusCode = script.status
        res.setEncoding = () => {}
        cb(res)
        for (const c of script.chunks) res.emit('data', c)
        res.emit('end')
      })
      return req
    }
    return req
  }) as never)
  return captured
}

const PROBE_ARGS = {
  ip: '59.106.222.212',          // lbAddresses[0]（2026-09-16 実測の素の IP）
  host: 'app.example.com',
  path: '/.koto-build?t=1789515207',
  timeoutMs: 10000,              // VERIFY_TIMEOUT_MS（仕様: 10 秒）
}

describe('probeMarkerOverHttps: 本番が実際に送る要求の形（D-7・仕様が名指しした性質）', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('★★ 443 番・SNI にホスト名・GET で当てる（http に落とす／SNI を落とす変異はここで落ちる）', async () => {
    const caught = captureHttpsRequests({ kind: 'response', status: 200, chunks: ['v20260916-083525\n'] })
    const r = await probeMarkerOverHttps(PROBE_ARGS)
    expect(r).toEqual({ reached: true, status: 200, body: 'v20260916-083525\n' })
    // node:https を通っていること自体を固定する（http.request に替えるとここが 0 件になる）
    expect(caught.length).toBe(1)
    const o = caught[0].options
    expect(o.hostname).toBe('59.106.222.212') // 宛先は Koto が API から取った IP（DNS はまだ向いていない）
    expect(o.port).toBe(443)                  // 80 番には何も載っていない（2026-09-16 実測・404）
    expect(o.method).toBe('GET')
    expect(o.path).toBe('/.koto-build?t=1789515207')
    expect(o.servername).toBe('app.example.com') // SNI。これが無いと LB の振り分けに乗らない
    expect(o.rejectUnauthorized).toBe(false)     // 仮証明書（CN=TRAEFIK DEFAULT CERT）でも通す
    expect(o.timeout).toBe(10000)                // 1本あたり 10 秒
  })

  it('★★ 送るヘッダは Host だけ・本文は無し（秘密を載せる変異はここで落ちる）', async () => {
    const caught = captureHttpsRequests({ kind: 'response', status: 200, chunks: ['v1\n'] })
    await probeMarkerOverHttps(PROBE_ARGS)
    const o = caught[0].options
    // ヘッダを**書き下して**固定する（レジストリのパスワードや Authorization を足すと落ちる）
    expect(Object.keys(o.headers as Record<string, unknown>)).toEqual(['Host'])
    expect((o.headers as Record<string, unknown>).Host).toBe('app.example.com')
    // 要求の組み立てに使ってよい項目も書き下す（auth・ca・key・cert などが増えたら落ちる）
    expect(Object.keys(o).sort()).toEqual(
      ['headers', 'hostname', 'method', 'path', 'port', 'rejectUnauthorized', 'servername', 'timeout'].sort(),
    )
    expect(caught[0].wrote).toEqual([])     // 本文は一度も書かない
    expect(caught[0].endedWith).toEqual([]) // end() にも何も渡さない
  })

  it('★★ 503（no available server）は「届いた」として status ごと返す（unreachable に薄めない）', async () => {
    captureHttpsRequests({ kind: 'response', status: 503, chunks: ['no available server\n'] })
    const r = await probeMarkerOverHttps(PROBE_ARGS)
    expect(r).toEqual({ reached: true, status: 503, body: 'no available server\n' })
  })

  it('status が読めない応答は status:0（不明を 200 に倒さない）', async () => {
    captureHttpsRequests({ kind: 'response', chunks: ['x'] })
    const r = await probeMarkerOverHttps(PROBE_ARGS)
    expect(r).toEqual({ reached: true, status: 0, body: 'x' })
  })

  it('★ 10 秒で応答が無ければ接続を切って reached:false（握りっぱなしにしない）', async () => {
    const caught = captureHttpsRequests({ kind: 'timeout' })
    const r = await probeMarkerOverHttps(PROBE_ARGS)
    expect(r).toEqual({ reached: false })
    expect(caught[0].destroyed).toBe(1)
  })

  it('★ 接続できないときは reached:false（「動いていない」の証明にはしない）', async () => {
    captureHttpsRequests({ kind: 'error' })
    const r = await probeMarkerOverHttps(PROBE_ARGS)
    expect(r).toEqual({ reached: false })
  })

  it('本文は頭だけ読む（壊れた・巨大な応答で記憶を食わない）', async () => {
    const big = 'a'.repeat(4096)
    captureHttpsRequests({ kind: 'response', status: 200, chunks: [big, big, big] })
    const r = await probeMarkerOverHttps(PROBE_ARGS)
    expect(r.reached).toBe(true)
    expect((r.body ?? '').length).toBeLessThan(3 * 4096)
  })
})

// ── 16. D-8（2026-09-16 実機・ランタイムログ）: 応答していないときだけ、コンテナの様子を1回引く ──
//
// 実機のランタイムログ:
//   Error: EACCES: permission denied, mkdir '/app/data'
// アプリが `/app/data` を作れず、1分ごとに再起動を繰り返していた（docs/apprun-dedicated-plan.md 5-13）。
// verify が `no-backend`（503）のとき、Koto は「ランタイムログを見てください」としか言えなかった。
// **いまのコンテナの様子が分かれば、ログを開く前に「動いていない」と気づける。**
//
// 歯止めは3つ: ①`no-backend` のときだけ引く（`ok` のときは引かない＝余計な GET を足さない）
// ②引けなくても `ok:true` のまま続く（確認の道具であって公開の条件ではない）
// ③0件（1つも動いていない）と「引けなかった」を区別する（前者だけ containerStates が付く）。

const CONTAINERS_KEY = 'GET /applications/app-1/containers'

/** 原本 ListApplicationContainersResponse の形（nodes[].containersStats[]・desired）。 */
const CONTAINERS_ONE: Route = {
  status: 200,
  body: {
    nodes: [{
      workerNodeID: 'wn-1', desired: 1,
      containersStats: [{ state: 'CrashLoopBackOff', status: 'restarting', image: 'jp1.sakuracr.jp/example/myapp2:v1' }],
    }],
  },
}

describe('publishAppFlow: 16. コンテナの様子は no-backend のときだけ引く（D-8）', () => {
  it('★★(a) verify:"no-backend" のときだけ GET …/containers を1回引き、原本の値のまま containerStates に載せる', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(
      { ...routesUntilLbAddress(LB_NODES_ONE), [CONTAINERS_KEY]: CONTAINERS_ONE }, calls,
    ))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 503, body: 'no available server' }], probes),
    }, baseUrl)
    expect(r.verify).toBe('no-backend')
    expect(r.ok).toBe(true)
    // **原本の値のまま**（日本語へ言い換えない）
    expect(r.containerStates).toEqual([{ state: 'CrashLoopBackOff', status: 'restarting' }])
    expect(calls.filter(c => c === CONTAINERS_KEY).length).toBe(1) // 1回だけ
    expect(r.warnings ?? []).toEqual([])
  })

  it('★★(b) verify:"ok" のときは引かない（要求が1件も飛ばない・containerStates は付かない）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(
      { ...routesUntilLbAddress(LB_NODES_ONE), [CONTAINERS_KEY]: CONTAINERS_ONE }, calls,
    ))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 200, body: `${VERIFY_TAG}\n` }], probes),
    }, baseUrl)
    expect(r.verify).toBe('ok')
    expect(calls.filter(c => c === CONTAINERS_KEY)).toEqual([]) // ← ここが増えたら「ok でも引いている」
    expect(r.containerStates).toBeUndefined()
  })

  it('★★(c) 引けなくても ok:true のまま続く（warnings に1行だけ・containerStates は付かない）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    // containers のルートを置かない → 404（＝取得失敗）
    const baseUrl = await listen(routedServer(routesUntilLbAddress(LB_NODES_ONE), calls))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 503, body: 'no available server' }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.stage).toBe('done')
    expect(r.verify).toBe('no-backend')
    expect(r.containerStates).toBeUndefined() // 「引けなかった」を0件に倒さない
    expect(r.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('コンテナの様子を取得できませんでした')]),
    )
  })

  it('★★(d) コンテナが0件でも containerStates は付く（0件＝1つも動いていない、と「引けなかった」を区別する）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    const baseUrl = await listen(routedServer(
      { ...routesUntilLbAddress(LB_NODES_ONE), [CONTAINERS_KEY]: { status: 200, body: { nodes: [{ desired: 1, containersStats: [] }] } } }, calls,
    ))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 503, body: 'no available server' }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true)
    expect(r.containerStates).toEqual([])
  })

  // 検分の指摘（2026-09-16）: 歯止めが HTTP の ok/失敗の段だけで、**200 だが原本と違う形**の
  // ときに「引けなかった」側へ倒す道が無かった。readContainerStates が [] を返すため、画面は
  // 「コンテナが1つも動いていません。」と断定していた（D-7 の `unknown-read-as-ok` と同じ形）。
  it('★★(e) 200 でも応答が原本の形でなければ containerStates は付かない（0件に倒さない・warnings に1行）', async () => {
    recordCluster()
    const calls: string[] = []
    const probes: ProbeArgs[] = []
    // ノードに containersStats のキーが無い＝原本の形として読めない応答
    const baseUrl = await listen(routedServer(
      { ...routesUntilLbAddress(LB_NODES_ONE), [CONTAINERS_KEY]: { status: 200, body: { nodes: [{ workerNodeID: 'wn-1', desired: 1 }] } } }, calls,
    ))
    const r = await publishAppFlow(AUTH, projectDir, verifiableInput(), {
      confirmed: true, sleep: fakeSleep([]),
      probeMarker: fakeProbe([{ reached: true, status: 503, body: 'no available server' }], probes),
    }, baseUrl)
    expect(r.ok).toBe(true) // 公開そのものは止めない
    expect(r.stage).toBe('done')
    expect(r.containerStates).toBeUndefined() // ← ここが [] に戻ったら「未確認」を「0件」と言い切っている
    expect(r.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('コンテナの様子を取得できませんでした')]),
    )
  })
})
