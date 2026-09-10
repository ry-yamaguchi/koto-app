import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import { MonitoringClient, monitoringBase, fetchTelemetryStatus, enableTelemetry, ensureTelemetryRouting } from '../src/main/cloud/monitoring'

// #30: さくらの開発者の助言「ログとメトリクスは有効にしてて欲しい」でメトリクスへ拡張。
// **実APIは叩かない**（掟4）。tests/apprunDedicated.test.ts と同じく、ローカルに本物の
// http サーバを立てて実物のクライアントに対して確かめる（fetchをモックしない）。
//
// 偽サーバの応答は、ロードマップ #30 の実測（GET /publishers/apprun/ ・
// GET /management/provisioning/state/ ・GET /metrics/storages/ ・GET /metrics/routings/）
// をそのまま使う。

let server: Server | null = null

afterEach(() => {
  if (server) { server.close(); server = null }
})

/**
 * ローカルに http サーバを立てて空きポートで listen し、baseUrl（末尾スラッシュ無し）を返す。
 * `monitoringBase()` の既定値も末尾スラッシュ無しなので、それに合わせる
 * （MonitoringClient は `${base}/${path}` で結合するため）。
 */
function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler)
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}`)
      else reject(new Error('サーバのポートを取得できませんでした'))
    })
  })
}

const CREDS = { token: 'my-token', secret: 'my-secret' }

function client(baseUrl: string, dryRun = false) {
  return new MonitoringClient({ credentials: CREDS, dryRun, baseUrl })
}

// 形（桁数・型）は実測（docs/roadmap.md #30・2026-09-08）どおり。'm-1'・'r-1' のような
// **形まで違う**手作りの値は使わない（掟1・#30 検分の指摘4: フィクスチャが実測値だと
// 主張しながら類推の値だった問題の直し）。
// ── 2026-09-10 検分の直し: 値（ID）は架空（実アカウントのIDは書かない。このテストは
//    公開リポジトリへそのまま同期される）。appLog.test.ts と同じ架空値に揃えてある ──
//   GET /metrics/storages/ → id "100000000002"（実際の桁数・型どおり。値は架空）
//   GET /metrics/routings/ → resource_id "100000000005"（同上）
const REAL = {
  metricsStorageId: '100000000002',
  resourceIdMetrics: '100000000005',
  // ログ側は appLog.test.ts の LOG_STORAGES/LOG_ROUTINGS と同じ値（形は実測・値は架空）を使う
  logStorageId: '100000000001',
  resourceIdLogs: '100000000003',
}

type Recorded = { method: string; path: string }

/**
 * リクエスト（メソッド・パス）を記録しながら応答する偽サーバを立てる。
 * `responder` は path から { status, body } を決めるだけの純関数（POST の本文は見ない）。
 * GET／POST どちらでも本文を最後まで読んでから応答する（読まずに応答すると、
 * まれに書き込み中のソケットで詰まるため。他の describe の listen() と同じ配慮）。
 */
function listenRecording(
  responder: (path: string, method: string) => { status: number; body: unknown },
): Promise<{ baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = []
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const method = req.method ?? ''
      const path = req.url ?? ''
      requests.push({ method, path })
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const { status, body } = responder(path, method)
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, requests })
      else reject(new Error('サーバのポートを取得できませんでした'))
    })
  })
}

describe('ベースURL（実測: 公式ライブラリの既定と同じ）', () => {
  it('ゾーンを含む monitoring/1.0 のURL', () => {
    expect(monitoringBase('is1a')).toBe('https://secure.sakura.ad.jp/cloud/zone/is1a/api/monitoring/1.0')
  })
})

describe('メトリクスのパスの組み立て（#30）', () => {
  it('listMetricsStorages は GET metrics/storages/ を叩く', async () => {
    let seenMethod = ''
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenMethod = req.method ?? ''
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // 実測: GET /metrics/storages/（docs/roadmap.md #30）
      res.end(JSON.stringify({
        count: 1, total: 1, is_ok: true,
        results: [{ id: REAL.metricsStorageId, name: 'デフォルト', description: 'ユーザーメトリクス領域', resource_id: REAL.metricsStorageId, is_system: false, usage: { metrics_routings: 1 } }],
      }))
    })
    const r = await client(baseUrl).listMetricsStorages()
    expect(seenMethod).toBe('GET')
    expect(seenUrl).toBe('/metrics/storages/')
    expect(r.ok).toBe(true)
  })

  it('listMetricsRoutings は GET metrics/routings/ を叩く', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // 実測: GET /metrics/routings/（docs/roadmap.md #30）
      res.end(JSON.stringify({
        count: 1, total: 1, is_ok: true,
        results: [{ id: 720190, resource_id: REAL.resourceIdMetrics, publisher: { code: 'apprun' }, variant: 'applicationmetrics', metrics_storage: {} }],
      }))
    })
    const r = await client(baseUrl).listMetricsRoutings()
    expect(seenUrl).toBe('/metrics/routings/')
    expect(r.ok).toBe(true)
  })

  it('createMetricsRouting は POST metrics/routings/ に metrics_storage_id を含む本文を送る', async () => {
    let seenMethod = ''
    let seenUrl = ''
    let seenBody: any = null
    const baseUrl = await listen((req, res) => {
      seenMethod = req.method ?? ''
      seenUrl = req.url ?? ''
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seenBody = JSON.parse(raw)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 99 }))
      })
    })
    const r = await client(baseUrl).createMetricsRouting({
      resourceId: REAL.resourceIdMetrics, publisherCode: 'apprun', variant: 'applicationmetrics', metricsStorageId: REAL.metricsStorageId,
    })
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toBe('/metrics/routings/')
    // 原本 monitoring-suite-api.json v1.3.0: 必須 metrics_storage_id/publisher_code/variant（掟1）
    expect(seenBody).toEqual({
      resource_id: REAL.resourceIdMetrics, publisher_code: 'apprun', variant: 'applicationmetrics', metrics_storage_id: REAL.metricsStorageId,
    })
    expect(r.ok).toBe(true)
  })

  // ★ 変異試験④が壊す想定: 本文キーを log_storage_id にすり替えると、
  //   メトリクスのAPIには通じない（キー名が違えば無視されるか 400 になる）
  it('createMetricsRouting の本文キーは metrics_storage_id であり、log_storage_id ではない', async () => {
    let seenBody: any = null
    const baseUrl = await listen((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seenBody = JSON.parse(raw)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    await client(baseUrl).createMetricsRouting({
      resourceId: REAL.resourceIdMetrics, publisherCode: 'apprun', variant: 'applicationmetrics', metricsStorageId: REAL.metricsStorageId,
    })
    expect(seenBody).toHaveProperty('metrics_storage_id', REAL.metricsStorageId)
    expect(seenBody).not.toHaveProperty('log_storage_id')
  })
})

describe('ログとメトリクスは、別のパスへ振り分けられる（対称性の確認）', () => {
  it('createRouting（ログ）は logs/routings/、createMetricsRouting は metrics/routings/', async () => {
    const seen: string[] = []
    const baseUrl = await listen((req, res) => {
      seen.push(req.url ?? '')
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
    })
    const c = client(baseUrl)
    // 同じアプリ（同じ resource_id）が、ログとメトリクスそれぞれのルーティングを持つ形（実測どおり）
    await c.createRouting({ resourceId: REAL.resourceIdLogs, publisherCode: 'apprun', variant: 'applicationlog', logStorageId: REAL.logStorageId })
    await c.createMetricsRouting({ resourceId: REAL.resourceIdLogs, publisherCode: 'apprun', variant: 'applicationmetrics', metricsStorageId: REAL.metricsStorageId })
    expect(seen).toEqual(['/logs/routings/', '/metrics/routings/'])
  })
})

describe('provisioningState は種類を問わず共通のエンドポイント', () => {
  it('GET management/provisioning/state/ を叩き、logs と metrics を同じ形で返す（実測）', async () => {
    let seenUrl = ''
    const baseUrl = await listen((req, res) => {
      seenUrl = req.url ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ logs: { system_exist: false, user_exist: false }, metrics: { system_exist: false, user_exist: true } }))
    })
    const r = await client(baseUrl).provisioningState()
    expect(seenUrl).toBe('/management/provisioning/state/')
    expect(r.data).toEqual({ logs: { system_exist: false, user_exist: false }, metrics: { system_exist: false, user_exist: true } })
  })

  it('initializeProvisioning(kind) は { [kind]: true } を本文に送る', async () => {
    let seenBody: any = null
    const baseUrl = await listen((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seenBody = JSON.parse(raw)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    await client(baseUrl).initializeProvisioning('metrics')
    expect(seenBody).toEqual({ metrics: true })
  })
})

describe('失敗時は生の応答本文をそのまま持ち帰る（既存の作法）', () => {
  it('metrics/routings/ が 400 を返したとき、status と text をそのまま返す', async () => {
    const baseUrl = await listen((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Validation Error', errors: [{ message: 'invalid variant' }] } }))
    })
    const r = await client(baseUrl).createMetricsRouting({
      resourceId: REAL.resourceIdMetrics, publisherCode: 'apprun', variant: 'applicationmetrics', metricsStorageId: REAL.metricsStorageId,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
    expect(r.text).toContain('invalid variant')
  })
})

describe('dryRun（既定 true）は mutating を実行しない', () => {
  it('createMetricsRouting は dryRun のとき実際には叩かない', async () => {
    let hit = false
    const baseUrl = await listen((_req, res) => { hit = true; res.writeHead(200); res.end('{}') })
    const r = await client(baseUrl, true).createMetricsRouting({
      resourceId: REAL.resourceIdMetrics, publisherCode: 'apprun', variant: 'applicationmetrics', metricsStorageId: REAL.metricsStorageId,
    })
    expect(hit).toBe(false)
    expect(r.ok).toBe(true) // dryRun は成功扱いで内容を返す
  })

  it('GET は dryRun でも実際に叩く（読み取りは常に実行）', async () => {
    let hit = false
    const baseUrl = await listen((_req, res) => { hit = true; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"results":[]}') })
    await client(baseUrl, true).listMetricsStorages()
    expect(hit).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// #30 検分（2026-09-08）の直し: main/cloud/monitoring.ts の fetchTelemetryStatus・
// enableTelemetry を、偽サーバへ実際にリクエストを飛ばして確かめる。
//
// 検分役が実物を読んで指摘した3点（掟1・実物で確認済み）:
//  1. cloud:enableTelemetry が decideTelemetryAction を一度も参照せず、無条件で
//     initializeProvisioning（課金の始まる操作）から始まっていた
//  3. cloud:telemetryStatus の「何も作らない」に、テストが1件も無かった（grep 0件）。
//     検分役がこのハンドラの先頭に initializeProvisioning を足しても33件全通過した
//
// ここでの直し方は「文字列一致ではなく、実際に偽サーバへ何本リクエストが飛んだかで
// 固定する」こと。ソースを読むテストと違い、判断を複製しても・分岐を1つ削っても、
// 実際に飛ぶリクエストの本数と種類が変われば必ず落ちる。
// ══════════════════════════════════════════════════════════════════════════

/**
 * provisioningState・storages・routings を、望む状態に合わせて返す偽サーバの応答を作る。
 *
 * ── 2026-09-10 検分の直し: 状態を持たせる ─────────────────────────────────
 * 直す前は状態を持たず、`hasStorage:true` なら **initialize の前から**ストレージを
 * 返していた。だが実物のAPIでは、ストレージは領域が用意されて（`user_exist:true`）
 * 初めて存在する。この不整合のせいで、「置き場なし×同意あり」のテストが
 * `enableTelemetry` の初回の並列フェッチだけでストレージを見つけてしまい、
 * **initialize を呼んだ後に本当にストレージを読み直しているか**を一度も試していなかった。
 * ここでは `initialized`（= 最初から `userExist:true`、または initialize の POST を
 * 受け取った後）を状態として持ち、それより前は `hasStorage` に関わらず空を返す。
 */
function statusResponder(opts: { userExist: boolean; hasStorage: boolean; alreadyRouted: boolean }) {
  let initialized = opts.userExist
  return (path: string, method: string): { status: number; body: unknown } => {
    if (path.startsWith('/management/provisioning/state/')) {
      return { status: 200, body: { metrics: { system_exist: false, user_exist: initialized } } }
    }
    if (path.startsWith('/management/provisioning/initialize/') && method === 'POST') {
      initialized = true
      return { status: 200, body: { ok: true } }
    }
    if (path.startsWith('/metrics/storages/')) {
      return {
        status: 200,
        body: (initialized && opts.hasStorage)
          ? { count: 1, total: 1, is_ok: true, results: [{ id: REAL.metricsStorageId, name: 'デフォルト', is_system: false }] }
          : { count: 0, total: 0, is_ok: true, results: [] },
      }
    }
    if (path.startsWith('/metrics/routings/')) {
      return {
        status: 200,
        body: opts.alreadyRouted
          ? { count: 1, results: [{ id: 720190, resource_id: REAL.resourceIdMetrics, publisher: { code: 'apprun' }, variant: 'applicationmetrics' }] }
          : { count: 0, results: [] },
      }
    }
    return { status: 404, body: {} }
  }
}

describe('fetchTelemetryStatus は何も作らない（#30 検分の指摘3）', () => {
  it('置き場が既にある状態を読んでも、飛ぶのは GET だけ（POSTは1本も無い）', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: true, hasStorage: true, alreadyRouted: false }),
    )
    const r = await fetchTelemetryStatus(client(baseUrl), 'metrics', REAL.resourceIdMetrics)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.action.kind).toBe('route')
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(x => x.method === 'GET')).toBe(true)
  })

  // ★ 変異試験③が壊す想定: このハンドラ（に相当する手順）の先頭に initializeProvisioning を足す
  it('保存場所が無い状態を読んでも、初期化のPOSTは1本も飛ばない（何も作らない）', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: false, hasStorage: false, alreadyRouted: false }),
    )
    const r = await fetchTelemetryStatus(client(baseUrl), 'metrics', REAL.resourceIdMetrics)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.action.kind).toBe('ask')
    expect(requests.every(x => x.method === 'GET')).toBe(true)
    expect(requests.some(x => x.path.includes('initialize'))).toBe(false)
  })
})

describe('enableTelemetry は decideEnableTelemetry の判断だけに従う（#30 検分の指摘1・2の直し）', () => {
  // ★ #30 検分の指摘1・変異試験①が壊す想定の核心:
  //   置き場が無い状態で consented:false のとき、課金の始まる初期化のPOSTは絶対に飛ばない
  it('置き場なし × 同意なし → 初期化のPOSTが1本も飛ばず、needsConsent を返す', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: false, hasStorage: false, alreadyRouted: false }),
    )
    const r = await enableTelemetry(client(baseUrl), 'metrics', REAL.resourceIdMetrics, { consented: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r as any).needsConsent).toBe(true)
    // GETしか飛んでいない（状態を読んだだけ）
    expect(requests.some(x => x.method === 'POST')).toBe(false)
  })

  it('置き場あり × 同意なし → 初期化のPOSTは飛ばず、ルーティングだけ作って ok', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: true, hasStorage: true, alreadyRouted: false }),
    )
    const r = await enableTelemetry(client(baseUrl), 'metrics', REAL.resourceIdMetrics, { consented: false })
    expect(r.ok).toBe(true)
    expect(requests.some(x => x.path.includes('initialize'))).toBe(false)
    expect(requests.some(x => x.method === 'POST' && x.path.startsWith('/metrics/routings/'))).toBe(true)
  })

  // ★ 変異試験②が壊す想定: 置き場があるときも初期化を呼ぶようにする（元の穴に戻す）
  it('置き場あり × 同意ありでも、初期化のPOSTは飛ばない（追加費用が無いので不要）', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: true, hasStorage: true, alreadyRouted: false }),
    )
    const r = await enableTelemetry(client(baseUrl), 'metrics', REAL.resourceIdMetrics, { consented: true })
    expect(r.ok).toBe(true)
    expect(requests.some(x => x.path.includes('initialize'))).toBe(false)
  })

  it('置き場なし × 同意あり → このときだけ初期化してからルーティングを作る', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: false, hasStorage: true, alreadyRouted: false }),
    )
    const r = await enableTelemetry(client(baseUrl), 'metrics', REAL.resourceIdMetrics, { consented: true })
    expect(r.ok).toBe(true)
    expect(requests.some(x => x.method === 'POST' && x.path.startsWith('/management/provisioning/initialize/'))).toBe(true)
    expect(requests.some(x => x.method === 'POST' && x.path.startsWith('/metrics/routings/'))).toBe(true)
    // ★ 2026-09-10 検分の直し（statusResponder が状態を持つようになったので、これで初めて
    //   本当に確かめられる）: initialize の POST の**後**に GET storages が飛んでいること。
    //   （先に読んだ storages はまだ「置き場なし」を反映しており、初期化の後で読み直さないと
    //   新しく作った領域のIDを取り損ねる）
    const initIdx = requests.findIndex(x => x.method === 'POST' && x.path.startsWith('/management/provisioning/initialize/'))
    const storagesAfterInitIdx = requests.findIndex((x, i) => i > initIdx && x.method === 'GET' && x.path.startsWith('/metrics/storages/'))
    expect(initIdx).toBeGreaterThan(-1)
    expect(storagesAfterInitIdx).toBeGreaterThan(initIdx)
  })

  it('すでに繋がっている → 何も作らず、飛ぶのは GET だけ', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: true, hasStorage: true, alreadyRouted: true }),
    )
    const r = await enableTelemetry(client(baseUrl), 'metrics', REAL.resourceIdMetrics, { consented: true })
    expect(r.ok).toBe(true)
    expect(requests.every(x => x.method === 'GET')).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// ensureTelemetryRouting（2026-09-10: main/ipc/cloud.ts から、ここ monitoring.ts へ
// 「そのまま」移した。enableTelemetry と並べる・掟10）。
//
// これは**公開の流れ（apply）**から呼ばれる薄い経路で、`cloud:enableTelemetry`
// （画面の「費用に同意する」導線）とは別物。**費用の発生する初期化は絶対に呼ばない**
// （置き場が無ければ何もしない）。
//
// 移す前は tests/appLog.test.ts が「ソースの2000文字窓に `action.kind !== 'route'` と
// 書いてあるか」という文字列一致でしか守っておらず、早期 return を外す変異
// （完了条件の変異試験(a)）が素通りしていた。ここでは偽サーバへ実際に飛んだリクエストの
// 本数・種類で固定する（掟10「お金・破壊の歯止めは、振る舞いで固定する」）。
// ══════════════════════════════════════════════════════════════════════════
describe('ensureTelemetryRouting: 公開の流れでは費用を発生させない（振る舞いで固定）', () => {
  it('(a) 置き場なし → POSTがゼロ本（initialize も routings も飛ばない）', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: false, hasStorage: false, alreadyRouted: false }),
    )
    await ensureTelemetryRouting('metrics', CREDS, REAL.resourceIdMetrics, () => {}, baseUrl)
    expect(requests.some(x => x.method === 'POST')).toBe(false)
  })

  it('(b) 置き場あり・未接続 → POST …/routings/ が1本だけ（initializeは飛ばない）', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: true, hasStorage: true, alreadyRouted: false }),
    )
    await ensureTelemetryRouting('metrics', CREDS, REAL.resourceIdMetrics, () => {}, baseUrl)
    const posts = requests.filter(x => x.method === 'POST')
    expect(posts.length).toBe(1)
    expect(posts[0].path).toBe('/metrics/routings/')
  })

  it('(c) 接続済み → POSTゼロ本（すでに流れているので何もしない）', async () => {
    const { baseUrl, requests } = await listenRecording(
      statusResponder({ userExist: true, hasStorage: true, alreadyRouted: true }),
    )
    await ensureTelemetryRouting('metrics', CREDS, REAL.resourceIdMetrics, () => {}, baseUrl)
    expect(requests.some(x => x.method === 'POST')).toBe(false)
  })

  it('状態の読み取り（GET）が1本でも失敗したら、何もしない（推測で進めない）', async () => {
    const { baseUrl, requests } = await listenRecording((path) => {
      if (path.startsWith('/management/provisioning/state/')) return { status: 500, body: {} }
      return { status: 200, body: { count: 0, results: [] } }
    })
    await ensureTelemetryRouting('metrics', CREDS, REAL.resourceIdMetrics, () => {}, baseUrl)
    expect(requests.some(x => x.method === 'POST')).toBe(false)
  })

  it('progress は route（実際に繋ぐ）ときだけ呼ぶ', async () => {
    const messages: string[] = []
    const { baseUrl: routeUrl } = await listenRecording(
      statusResponder({ userExist: true, hasStorage: true, alreadyRouted: false }),
    )
    await ensureTelemetryRouting('metrics', CREDS, REAL.resourceIdMetrics, (m) => messages.push(m), routeUrl)
    expect(messages.length).toBe(1)

    messages.length = 0
    const { baseUrl: askUrl } = await listenRecording(
      statusResponder({ userExist: false, hasStorage: false, alreadyRouted: false }),
    )
    await ensureTelemetryRouting('metrics', CREDS, REAL.resourceIdMetrics, (m) => messages.push(m), askUrl)
    expect(messages.length).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 失敗時に「どの呼び出しが・なぜ」失敗したかを伝える（2026-09-10 検分の直し）。
// 直す前は prov/storages/routings のどれかが !ok のとき固定文言だけを返しており、
// status も応答本文も分からなかった（道具が事実を隠す・掟10）。
// ══════════════════════════════════════════════════════════════════════════
describe('状態の取得に失敗したとき、status と応答本文を message/detail に含める', () => {
  it('fetchTelemetryStatus: provisioning/state が403 → message に 403、detail に本文が含まれる', async () => {
    const baseUrl = await listen((req, res) => {
      if ((req.url ?? '').startsWith('/management/provisioning/state/')) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Forbidden: invalid API key' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ count: 0, results: [] }))
    })
    const r = await fetchTelemetryStatus(client(baseUrl), 'metrics', REAL.resourceIdMetrics)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('403')
      expect(r.detail ?? '').toContain('Forbidden: invalid API key')
    }
  })

  it('enableTelemetry でも同じ（storages の取得が500）', async () => {
    const baseUrl = await listen((req, res) => {
      if ((req.url ?? '').startsWith('/metrics/storages/')) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'internal error, contact support' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ count: 0, results: [] }))
    })
    const r = await enableTelemetry(client(baseUrl), 'metrics', REAL.resourceIdMetrics, { consented: false })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('500')
      expect((r as any).detail ?? '').toContain('internal error, contact support')
    }
  })
})
