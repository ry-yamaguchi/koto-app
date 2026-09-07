// apprunDedicated.ts — さくらのAppRun 専有型 API クライアント（roadmap #23 段階①「下調べ画面」専用）。
//
// **この段階ではクラスタもアプリも作らない。** このファイルに POST/PUT/PATCH/DELETE を
// 1つも書かないこと（tests/apprunDedicated.test.ts が「破壊系メソッドが無いこと」を固定している）。
// GET のみの4関数だけを持つ（getLimits / getWorkerClasses / getLbClasses / listClusters）。
//
// 認証: 既存の さくらのクラウドAPIキー（アクセストークン＝ユーザ名／トークンシークレット＝パスワード）を
// そのまま BasicAuth で使う（docs/apprun-dedicated-plan.md 8. で実測済み。専有型専用のキーは無い）。
// 掟4（方式B）: このモジュールはキーを一切保存しない。呼び出しのたびに CloudCredentials を
// 引数で受け取るだけ（main 側の呼び出し元＝IPCハンドラも、renderer から渡された値をそのまま
// 使うだけで、保存しない）。src/main/cloud/client.ts の basicAuthHeader と同じ作り。
//
// ベースURLはゾーンを含まない（従来のクラウドAPI v1.1 の /cloud/zone/{zone}/api/… とは作法が違う。
// docs/apprun-dedicated-plan.md 4.）。

import type { CloudCredentials } from './auth'

/** APIのベースURL（末尾スラッシュ付き）。ゾーンは URL に出ない。 */
export const APPRUN_DEDICATED_API_BASE = 'https://secure.sakura.ad.jp/cloud/api/apprun-dedicated/1.0/'

/**
 * 一覧系（GET /clusters）に必須の maxItems の既定値。
 *
 * 原本（OpenAPI v1.4.0）では一覧系エンドポイント8本すべてで maxItems が **必須**で、
 * 最小値はエンドポイントごとに 1/2/5 と違う（docs/apprun-dedicated-plan.md 5-1）。
 * `/clusters` の最小値は 5・最大30・既定20。20 ならどの一覧系エンドポイントの範囲にも
 * 収まるため、この段階（件数の把握が目的で cursor までは辿らない）ではこれを固定で使う。
 *
 * ⚠️ 付け忘れると 400 になる実測がある
 * （`operation ListClusters: … query parameter "maxItems" not set`。2026-09-07 実測）。
 * 一度「ドキュメントは任意」と誤読して さくらへ誤った指摘を書きかけた経緯があるため
 * （掟1）、ここに理由を残す。
 */
const CLUSTERS_MAX_ITEMS = 20

/** 成功時はレスポンスのJSON（型は呼び出し側で解釈する）、失敗時は生の応答本文を message に載せる。 */
export type ApprunDedicatedResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; message: string; detail?: string }

/** BasicAuth ヘッダを組み立てる（token:secret を base64）。client.ts の basicAuthHeader と同じ作り。 */
function basicAuthHeader(auth: CloudCredentials): string {
  return 'Basic ' + Buffer.from(`${auth.token}:${auth.secret}`, 'utf-8').toString('base64')
}

/** baseUrl とパスを結合する（baseUrl 省略時は APPRUN_DEDICATED_API_BASE。テスト差し替え用に公開）。 */
function buildUrl(pathname: string, baseUrl: string = APPRUN_DEDICATED_API_BASE): string {
  return baseUrl.replace(/\/$/, '') + (pathname.startsWith('/') ? pathname : '/' + pathname)
}

/**
 * 失敗応答から人間可読なメッセージを組み立てる。
 *
 * **要約せず、生の応答本文をそのまま載せる。** 2026-09-07、疎通確認の道具（probe-apprun-dedicated.mjs）
 * の初版はエラー時に本文を出しておらず、`GET /clusters` が 400 になった原因（maxItems未指定）に
 * 気づくのに2度手間がかかった（docs/apprun-dedicated-plan.md 8.・掟10）。同じ轍を踏まない。
 *
 * 401/403 だけは「キーか権限の問題」と分かる一言を前に添える（他は原因の見当がつかないため
 * 本文をそのまま出すしかない）。
 */
function formatError(status: number, bodyText: string): string {
  const body = bodyText.trim()
  if (status === 401 || status === 403) {
    return `キーまたは権限の問題です（HTTP ${status}）` + (body ? `: ${body.slice(0, 1000)}` : '')
  }
  return body || `APIエラー（HTTP ${status}）`
}

/**
 * GETのみの低レベル実装。**fetch を呼ぶのはこの関数だけ**にする
 * （破壊系メソッドを足す余地をここ1箇所に閉じ込める）。
 */
async function getJson<T>(auth: CloudCredentials, pathname: string, baseUrl?: string): Promise<ApprunDedicatedResult<T>> {
  let res: Response
  let text: string
  try {
    res = await fetch(buildUrl(pathname, baseUrl), {
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
  return { ok: true, data: data as T }
}

/** GET /limits — このプランの上限（clusterCount・workerNodeCount など）。 */
export async function getLimits(auth: CloudCredentials, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return getJson(auth, '/limits', baseUrl)
}

/** GET /service_classes/worker — ワーカのプラン一覧。 */
export async function getWorkerClasses(auth: CloudCredentials, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return getJson(auth, '/service_classes/worker', baseUrl)
}

/** GET /service_classes/lb — ロードバランサのプラン一覧。 */
export async function getLbClasses(auth: CloudCredentials, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return getJson(auth, '/service_classes/lb', baseUrl)
}

/**
 * GET /clusters — 既存クラスタの一覧。
 * **maxItems は必須。付け忘れると 400 になる**（上の CLUSTERS_MAX_ITEMS のコメント参照）。
 * この段階では件数の把握が目的で、続き（cursor）までは辿らない。
 */
export async function listClusters(auth: CloudCredentials, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return getJson(auth, `/clusters?maxItems=${CLUSTERS_MAX_ITEMS}`, baseUrl)
}
