// monitoring.ts — さくらのモニタリングスイートAPI（ログを残すために使う）。
//
// ── なぜ要るか（2026-08-14 Ryosuke 指摘）────────────────────────────────
// AppRun のログは**既定では残らない**。残すには、モニタリングスイートの
// ログストレージへ「ルーティング」を作る必要がある。これをコントロールパネルで
// 設定するのは、Koto の利用者（非エンジニア）には現実的でない。
//
// ── 実測で確定した呼び順（Ryosuke の実アカウント・2026-08-14）─────────────
//   1. GET  management/provisioning/state/  … logs.user_exist を見る
//   2. POST management/provisioning/initialize/ … 領域が無ければ作る（**課金の始まり**）
//   3. GET  logs/storages/                  … 使う領域のIDを得る
//   4. POST logs/routings/                  … アプリのログを流す
//        { resource_id, publisher_code: 'apprun', variant: 'applicationlog', log_storage_id }
//
// **認証は さくらのクラウドAPIキー**（AppRun・オブジェクトストレージと同じもの）。
// 利用者に新しく登録してもらうものは無い。

import type { CloudCredentials } from './auth'

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

  constructor(opts: { credentials: CloudCredentials; dryRun?: boolean; zone?: string }) {
    this.creds = opts.credentials
    this.dryRun = opts.dryRun ?? true
    this.base = monitoringBase(opts.zone)
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

  /** ログ領域が用意されているか（判断は shared/appLog.ts）。 */
  async provisioningState(): Promise<ApiResult> {
    return this.api('GET', 'management/provisioning/state/')
  }

  /**
   * ログ領域を作る。**これが月額課金の始まり。**
   * 呼ぶ前に必ず利用者の同意を取ること（バケット・レジストリと同じ扱い）。
   */
  async initializeLogs(): Promise<ApiResult> {
    return this.api('POST', 'management/provisioning/initialize/', { logs: true })
  }

  /** ログストレージの一覧。 */
  async listStorages(): Promise<ApiResult> {
    return this.api('GET', 'logs/storages/')
  }

  /** ルーティングの一覧（既に流れているかを確かめるのに使う）。 */
  async listRoutings(): Promise<ApiResult> {
    return this.api('GET', 'logs/routings/')
  }

  /** アプリのログを、指定のログストレージへ流す。 */
  async createRouting(opts: { resourceId: string; publisherCode: string; variant: string; logStorageId: string }): Promise<ApiResult> {
    return this.api('POST', 'logs/routings/', {
      resource_id: opts.resourceId,
      publisher_code: opts.publisherCode,
      variant: opts.variant,
      log_storage_id: opts.logStorageId,
    })
  }
}
