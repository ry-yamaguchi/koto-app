// monitoring.ts — さくらのモニタリングスイートAPI（ログ・メトリクスを残すために使う）。
//
// ── なぜ要るか（2026-08-14 Ryosuke 指摘）────────────────────────────────
// AppRun のログは**既定では残らない**。残すには、モニタリングスイートの
// ログストレージへ「ルーティング」を作る必要がある。これをコントロールパネルで
// 設定するのは、Koto の利用者（非エンジニア）には現実的でない。
//
// ── #30 でメトリクスへ拡張（2026-09-08）────────────────────────────────
// さくらの開発者の助言「ログとメトリクスは有効にしてて欲しい」を受け、メトリクス
// にも対応した。API の形はログとメトリクスで**完全に対称**（実測で確認）なので、
// 種類（`TelemetryKind`）で分岐する内部実装1本にまとめ、ログ・メトリクスそれぞれの
// 呼び名は薄いラッパーとして残す（掟10・同じ形の処理を複製しない）。
//
// ── 実測で確定した呼び順（Ryosuke の実アカウント）────────────────────────
//   1. GET  management/provisioning/state/     … `<kind>.user_exist` を見る（2026-08-14）
//      応答は `{ logs: {...}, metrics: {...} }` と2種類を同じ形で並べて返す（2026-09-08 実測）
//   2. POST management/provisioning/initialize/ … 領域が無ければ作る（**課金の始まり**）
//   3. GET  {logs,metrics}/storages/            … 使う領域のIDを得る
//   4. POST {logs,metrics}/routings/            … アプリのログ／メトリクスを流す
//        ログ    : { resource_id, publisher_code: 'apprun', variant: 'applicationlog',     log_storage_id }
//        メトリクス: { resource_id, publisher_code: 'apprun', variant: 'applicationmetrics', metrics_storage_id }
//      （2026-09-08、`monitoring-suite-api.json` v1.3.0 の原本で本文の形を確認。掟1）
//
// **認証は さくらのクラウドAPIキー**（AppRun・オブジェクトストレージと同じもの）。
// 利用者に新しく登録してもらうものは無い。

import type { CloudCredentials } from './auth'
import {
  decideTelemetryAction, decideEnableTelemetry, parseProvisioningState, pickStorageId, hasAppRouting,
  APPRUN_PUBLISHER, APPRUN_VARIANT, type TelemetryKind, type TelemetryAction,
} from '../../shared/appLog'

/** モニタリングスイートAPI のベースURL（公式ライブラリの既定と同じ）。 */
export function monitoringBase(zone = 'is1a'): string {
  return `https://secure.sakura.ad.jp/cloud/zone/${encodeURIComponent(zone)}/api/monitoring/1.0`
}

export type ApiResult = { ok: boolean; status: number; data: unknown; text: string }

function basicAuth(c: CloudCredentials): string {
  return 'Basic ' + Buffer.from(`${c.token}:${c.secret}`).toString('base64')
}

/**
 * モニタリングスイートAPI のクライアント。
 *
 * mutating（POST）は `dryRun` のとき実行しない。既定は安全側の true
 * （オブジェクトストレージのクライアントと同じ約束）。
 */
export class MonitoringClient {
  readonly dryRun: boolean
  private readonly creds: CloudCredentials
  private readonly base: string

  constructor(opts: { credentials: CloudCredentials; dryRun?: boolean; zone?: string; baseUrl?: string }) {
    this.creds = opts.credentials
    this.dryRun = opts.dryRun ?? true
    // baseUrl は主にテスト用（ローカルの偽サーバへ向ける）。既定はさくらの実URL
    // （SakuraCloudClient の baseUrl と同じ約束・掟4「実APIは絶対に叩かない」検証用）。
    this.base = opts.baseUrl ?? monitoringBase(opts.zone)
  }

  private async api(method: string, path: string, body?: unknown): Promise<ApiResult> {
    if (this.dryRun && method !== 'GET') {
      return { ok: true, status: 0, data: { dryRun: true, method, path, body: body ?? null }, text: '' }
    }
    const res = await fetch(`${this.base}/${path.replace(/^\//, '')}`, {
      method,
      headers: {
        Authorization: basicAuth(this.creds),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    let data: unknown = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { ok: res.ok, status: res.status, data, text }
  }

  /** ログ・メトリクスの領域が用意されているか（`<kind>.user_exist`。判断は shared/appLog.ts）。 */
  async provisioningState(): Promise<ApiResult> {
    return this.api('GET', 'management/provisioning/state/')
  }

  /**
   * 指定した種類の領域を作る。**これが月額課金の始まり。**
   * 呼ぶ前に必ず利用者の同意を取ること（バケット・レジストリと同じ扱い）。
   */
  async initializeProvisioning(kind: TelemetryKind): Promise<ApiResult> {
    return this.api('POST', 'management/provisioning/initialize/', { [kind]: true })
  }

  /** 指定した種類のストレージの一覧。 */
  async listTelemetryStorages(kind: TelemetryKind): Promise<ApiResult> {
    return this.api('GET', `${kind}/storages/`)
  }

  /** 指定した種類のルーティングの一覧（既に流れているかを確かめるのに使う）。 */
  async listTelemetryRoutings(kind: TelemetryKind): Promise<ApiResult> {
    return this.api('GET', `${kind}/routings/`)
  }

  /**
   * アプリのログ／メトリクスを、指定のストレージへ流す。
   * 本文のキーはログ `log_storage_id` ／メトリクス `metrics_storage_id` だけが違う
   * （原本 `monitoring-suite-api.json` v1.3.0 で確認・掟1）。
   */
  async createTelemetryRouting(
    kind: TelemetryKind,
    opts: { resourceId: string; publisherCode: string; variant: string; storageId: string },
  ): Promise<ApiResult> {
    const storageIdKey = kind === 'logs' ? 'log_storage_id' : 'metrics_storage_id'
    return this.api('POST', `${kind}/routings/`, {
      resource_id: opts.resourceId,
      publisher_code: opts.publisherCode,
      variant: opts.variant,
      [storageIdKey]: opts.storageId,
    })
  }

  // ── 後方互換の薄い皮（ログ専用の呼び名）─────────────────────────────
  // 中身は上の一般化した実装を呼ぶだけで、判断・実装を複製しない（掟10）。

  /** @deprecated `initializeProvisioning('logs')` を使う。 */
  async initializeLogs(): Promise<ApiResult> {
    return this.initializeProvisioning('logs')
  }

  /** @deprecated `listTelemetryStorages('logs')` を使う。 */
  async listStorages(): Promise<ApiResult> {
    return this.listTelemetryStorages('logs')
  }

  /** @deprecated `listTelemetryRoutings('logs')` を使う。 */
  async listRoutings(): Promise<ApiResult> {
    return this.listTelemetryRoutings('logs')
  }

  /** @deprecated `createTelemetryRouting('logs', { ...opts, storageId: opts.logStorageId })` を使う。 */
  async createRouting(opts: { resourceId: string; publisherCode: string; variant: string; logStorageId: string }): Promise<ApiResult> {
    return this.createTelemetryRouting('logs', { ...opts, storageId: opts.logStorageId })
  }

  // ── メトリクス専用の呼び名（#30）───────────────────────────────────

  /** メトリクスストレージの一覧。 */
  async listMetricsStorages(): Promise<ApiResult> {
    return this.listTelemetryStorages('metrics')
  }

  /** メトリクスのルーティングの一覧（既に流れているかを確かめるのに使う）。 */
  async listMetricsRoutings(): Promise<ApiResult> {
    return this.listTelemetryRoutings('metrics')
  }

  /** アプリのメトリクスを、指定のメトリクスストレージへ流す。 */
  async createMetricsRouting(opts: { resourceId: string; publisherCode: string; variant: string; metricsStorageId: string }): Promise<ApiResult> {
    return this.createTelemetryRouting('metrics', { ...opts, storageId: opts.metricsStorageId })
  }
}

// ── ここから、判断（shared/appLog.ts）とAPI呼び出しを結ぶ「実際に使う手順」──────────
//
// ── なぜここに置くか（#30 検分・2026-09-08 の直し）────────────────────────
// 検分役の指摘: `cloud:enableTelemetry`（IPCハンドラ）が `decideTelemetryAction` を
// 一度も参照せず、無条件で `mon.initializeProvisioning(kind)` から始まっていた
// （＝置き場の有無・同意の有無に関わらず、同じ課金の始まる呼び出しが走る）。
//
// 直し方は「状態を読む→判断する→必要な分だけAPIを呼ぶ」という**一連の手順**を、
// IPCハンドラ（main/ipc/cloud.ts）から切り出してここに1本化すること。
// こうすると:
//   ・IPCハンドラは「呼ぶだけ」になり、判断ロジックを複製できなくなる（掟10）
//   ・ここは electron に依存しないので、tests/monitoring.test.ts と同じ
//     「偽サーバを実際に立てて、本物のクライアントで叩く」流儀でそのまま検証できる
//     （ipcMain を経由しないため、モックなしで実際のHTTPリクエストを見られる）

export type TelemetryStatusResult =
  | { ok: true; action: TelemetryAction }
  | { ok: false; message: string }

/**
 * ログ／メトリクスが、いま何をすれば残るようになるかを聞く。
 * **何も作らず、何も変えない**（GET だけ）。`cloud:telemetryStatus` はこれを呼ぶだけにする。
 * GET 以外のリクエストが飛ばないことは tests/monitoring.test.ts で固定している。
 */
export async function fetchTelemetryStatus(
  mon: MonitoringClient,
  kind: TelemetryKind,
  resourceId: string,
): Promise<TelemetryStatusResult> {
  const [prov, storages, routings] = await Promise.all([
    mon.provisioningState(), mon.listTelemetryStorages(kind), mon.listTelemetryRoutings(kind),
  ])
  if (!prov.ok || !storages.ok || !routings.ok) {
    return { ok: false, message: '状態を確認できませんでした（さくら側の応答を取得できません）' }
  }
  const action = decideTelemetryAction({
    storageReady: parseProvisioningState(prov.data, kind),
    storageId: pickStorageId(storages.data),
    alreadyRouted: hasAppRouting(routings.data, resourceId, kind),
  }, kind)
  return { ok: true, action }
}

export type EnableTelemetryResult =
  | { ok: true }
  | { ok: false; needsConsent: true; message: string }
  | { ok: false; message: string; detail?: string }

/**
 * ログ／メトリクスを有効にする、実際の手順（#30 検分の直し）。
 *
 * **先に状態を読み、`decideEnableTelemetry` の判断に従うだけ。** `opts.consented` が
 * `true` でない限り、課金の始まる `initializeProvisioning` は一度も呼ばれない
 * （呼ばれないことを tests/monitoring.test.ts が偽サーバで実際に確かめている）。
 * `cloud:enableTelemetry`（IPCハンドラ）はこの関数を呼ぶだけにする。
 */
export async function enableTelemetry(
  mon: MonitoringClient,
  kind: TelemetryKind,
  resourceId: string,
  opts: { consented: boolean },
): Promise<EnableTelemetryResult> {
  const [prov, storages0, routings] = await Promise.all([
    mon.provisioningState(), mon.listTelemetryStorages(kind), mon.listTelemetryRoutings(kind),
  ])
  if (!prov.ok || !storages0.ok || !routings.ok) {
    return { ok: false, message: '状態を確認できませんでした（さくら側の応答を取得できません）' }
  }

  const decision = decideEnableTelemetry({
    storageReady: parseProvisioningState(prov.data, kind),
    storageId: pickStorageId(storages0.data),
    alreadyRouted: hasAppRouting(routings.data, resourceId, kind),
  }, { consented: opts.consented === true })

  if (decision.do === 'nothing') return { ok: true }
  if (decision.do === 'need-consent') {
    return { ok: false, needsConsent: true, message: '費用の同意が必要です' }
  }

  let storageId = decision.do === 'route' ? decision.storageId : null

  if (decision.do === 'initialize-then-route') {
    const init = await mon.initializeProvisioning(kind)
    if (!init.ok) return { ok: false, message: `保存場所の用意に失敗しました（HTTP ${init.status}）`, detail: init.text }

    const storages = await mon.listTelemetryStorages(kind)
    if (!storages.ok) return { ok: false, message: '保存場所の取得に失敗しました', detail: storages.text }
    storageId = pickStorageId(storages.data)
  }

  if (!storageId) return { ok: false, message: '保存場所を用意しましたが、見つかりませんでした（時間をおいて再度お試しください）' }

  const routed = await mon.createTelemetryRouting(kind, {
    resourceId, publisherCode: APPRUN_PUBLISHER, variant: APPRUN_VARIANT[kind], storageId,
  })
  if (!routed.ok) return { ok: false, message: `接続に失敗しました（HTTP ${routed.status}）`, detail: routed.text }
  return { ok: true }
}
