// zones.ts — さくらのクラウド API v1.1「設備関連API」の GET /zone（ゾーン一覧）。
//
// roadmap #28。AppRun 専有型のオートスケーリンググループ作成 `POST /clusters/{id}/asg` は
// `zone` が必須なのに、専有型の OpenAPI 原本には許容値の一覧が無い
// （docs/apprun-dedicated-plan.md 5-5）。2026-09-07 の再調査で、さくらのクラウド API v1.1 の
// **GET /zone** が、Koto が既に持つクラウドAPIキーの BasicAuth でそのまま叩けることが分かり、
// **実キーで実測も済んでいる**（同 5-9）。ここはその GET 一本だけを行う薄いクライアント。
//
// **POST/PUT/DELETE を1つも書かない。** ゾーン一覧は読むだけで、作る・変えるものではない。
//
// ベースURLの組み立ては src/main/cloud/client.ts の iaasZoneBase を使う（複製しない）。
// URL に含めるゾーンは固定の 'is1a'（公式サンプルと同じ。どのゾーンのURLからでも一覧は引ける。
// 実際に選ばれる／使われるゾーンとは無関係）。
//
// 認証・失敗時の作法は src/main/cloud/apprunDedicated.ts に合わせる:
//   - BasicAuth ヘッダ（token:secret を base64）
//   - 失敗時は**生の応答本文を message に載せる**（要約しない・掟10）。401/403 だけ、
//     キーか権限の問題と分かる一言を前に添える。
//
// 掟4（方式B）: このモジュールもキーを一切保存しない。呼び出しのたびに CloudCredentials を
// 引数で受け取るだけ。

import type { CloudCredentials } from './auth'
import { iaasZoneBase } from './client'

/**
 * ゾーン一覧を引くときに URL へ含める固定ゾーン（5-9・公式サンプルと同じ is1a）。
 * どのゾーンのURLからでも同じ一覧が返るため、実際に選ばれるゾーンとは無関係。
 */
const PROBE_ZONE = 'is1a'

/** 成功時はレスポンスのJSON（形は src/shared/apprunDedicatedShapes.ts の readZones が解釈する）、
 *  失敗時は生の応答本文を message に載せる（apprunDedicated.ts の ApprunDedicatedResult と同じ形）。 */
export type ZonesResult =
  | { ok: true; data: unknown }
  | { ok: false; message: string; detail?: string }

/** BasicAuth ヘッダを組み立てる（token:secret を base64）。apprunDedicated.ts と同じ作り。 */
function basicAuthHeader(auth: CloudCredentials): string {
  return 'Basic ' + Buffer.from(`${auth.token}:${auth.secret}`, 'utf-8').toString('base64')
}

/**
 * 失敗時のメッセージを組み立てる。**要約せず、生の応答本文をそのまま載せる**
 * （掟10「確かめられないときは生の応答を載せる」・docs/apprun-dedicated-plan.md 8. の教訓）。
 * 401/403 だけは「キーか権限の問題」と分かる一言を前に添える（apprunDedicated.ts と同じ作法）。
 */
function formatError(status: number, bodyText: string): string {
  const body = bodyText.trim()
  if (status === 401 || status === 403) {
    return `キーまたは権限の問題です（HTTP ${status}）` + (body ? `: ${body.slice(0, 1000)}` : '')
  }
  return body || `APIエラー（HTTP ${status}）`
}

/**
 * GET /zone — さくらのクラウドのゾーン一覧を取得する（GETのみ・何も作らない）。
 * baseUrl を渡せばテストでローカルサーバに差し替えられる（既定は iaasZoneBase(PROBE_ZONE)）。
 */
export async function getZones(auth: CloudCredentials, baseUrl?: string): Promise<ZonesResult> {
  const base = baseUrl ?? iaasZoneBase(PROBE_ZONE)
  const url = base.replace(/\/$/, '') + '/zone'
  let res: Response
  let text: string
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: basicAuthHeader(auth), Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    })
    text = await res.text()
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
  if (!res.ok) {
    return { ok: false, message: formatError(res.status, text), detail: text.slice(0, 2000) }
  }
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: true, data }
}
