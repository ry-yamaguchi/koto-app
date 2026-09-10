// apprunDedicated.ts — さくらのAppRun 専有型 API クライアント。
//
// 段階①（下調べ画面）は GET のみだったが、段階②（作る）でクラスタ・ASG・ロードバランサの
// 作成/削除が要るため、この段階から POST/DELETE を持つ（tests/apprunDedicated.test.ts の
// 「破壊系メソッドが無いこと」固定は段階①専用の一時的なもので、段階②実装に伴い外した）。
// **アプリケーション/バージョン（roadmap #23 の⑤独自ドメイン相当）はこの段では実装しない**
// （docs/apprun-dedicated-plan.md 5-3/5-4 は対象外。取扱う資源はクラスタ・ASG・LBの3つのみ）。
//
// 認証: 既存の さくらのクラウドAPIキー（アクセストークン＝ユーザ名／トークンシークレット＝パスワード）を
// そのまま BasicAuth で使う（docs/apprun-dedicated-plan.md 8. で実測済み。専有型専用のキーは無い）。
// 掟4（方式B）: このモジュールはキーを一切保存しない。呼び出しのたびに CloudCredentials を
// 引数で受け取るだけ（main 側の呼び出し元＝IPCハンドラも、renderer から渡された値をそのまま
// 使うだけで、保存しない）。src/main/cloud/client.ts の basicAuthHeader と同じ作り。
//
// ベースURLはゾーンを含まない（従来のクラウドAPI v1.1 の /cloud/zone/{zone}/api/… とは作法が違う。
// docs/apprun-dedicated-plan.md 4.）。
//
// **依存の順序・実在確認・記録・破棄の判断はここには置かない。** ここは薄いHTTPクライアントで、
// 「何を・いつ・どんな順で呼ぶか」は src/main/cloud/apprunDedicatedApply.ts に集約する
// （掟10・2026-08-14「作る順番は機能の一部」「成功と読んだ応答は結果を確かめるまで成功ではない」）。

import type { CloudCredentials } from './auth'
import { readApiErrorTitle } from '../../shared/apprunDedicatedShapes'

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

/**
 * 成功時はレスポンスのJSON（型は呼び出し側で解釈する）、失敗時は生の応答本文を message に載せる。
 * **status はHTTPステータス（バッチ1・E: 404かどうかの判定に使う）。** ネットワーク例外（fetch自体が
 * 失敗した場合）は応答が無いので status を持たない（undefined＝「HTTPの応答すら受け取れなかった」）。
 */
export type ApprunDedicatedResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; message: string; detail?: string; status?: number }

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
 *
 * 失敗応答は原本どおり `{ "status": …, "title": … }` の形（5-8）。あれば title を前に添える
 * （src/shared/apprunDedicatedShapes.ts の readApiErrorTitle・形が違えば null で素通り）。
 * **本文の表示はそのまま残す**（掟10「確かめられないときは生の応答を載せる」。title は
 * 添えるだけで、生本文の代わりにはしない）。
 */
function formatError(status: number, bodyText: string): string {
  const body = bodyText.trim()
  if (status === 401 || status === 403) {
    return `キーまたは権限の問題です（HTTP ${status}）` + (body ? `: ${body.slice(0, 1000)}` : '')
  }
  let title: string | null = null
  if (body) {
    try { title = readApiErrorTitle(JSON.parse(body)) } catch { title = null }
  }
  if (title) return `${title}（HTTP ${status}）: ${body.slice(0, 1000)}`
  return body || `APIエラー（HTTP ${status}）`
}

/**
 * 低レベル実装。**fetch を呼ぶのはこの関数だけ**にする（新しいメソッドを足す余地をここ1箇所に閉じ込める）。
 * body を渡すと JSON化して送る（POST用）。渡さなければ本文無し（GET/DELETE用）。
 */
async function requestJson<T>(
  auth: CloudCredentials, method: string, pathname: string, body: unknown | undefined, baseUrl?: string,
): Promise<ApprunDedicatedResult<T>> {
  let res: Response
  let text: string
  try {
    res = await fetch(buildUrl(pathname, baseUrl), {
      method,
      headers: {
        Authorization: basicAuthHeader(auth),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    })
    text = await res.text()
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
  if (!res.ok) {
    return { ok: false, message: formatError(res.status, text), detail: text.slice(0, 2000), status: res.status }
  }
  let data: unknown = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: true, data: data as T }
}

/** GETのみの低レベル実装（既存呼び出し元互換のための薄いラッパー）。 */
async function getJson<T>(auth: CloudCredentials, pathname: string, baseUrl?: string): Promise<ApprunDedicatedResult<T>> {
  return requestJson<T>(auth, 'GET', pathname, undefined, baseUrl)
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

// ── ここから段階②（作る）で追加。クラスタ・ASG・ロードバランサの3資源のみを扱う ──────────

/**
 * 一覧系（ASG・ロードバランサ）に必須の maxItems の既定値。
 * `/clusters/{id}/asg` は min1・`…/load_balancers` は min2（5-1）だが、20 ならどちらの
 * 範囲にも収まるため CLUSTERS_MAX_ITEMS と同じ値を使う。
 */
const LIST_MAX_ITEMS = 20

/** POST /clusters — クラスタを作成する（5-2）。 */
export async function createCluster(auth: CloudCredentials, body: unknown, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return requestJson(auth, 'POST', '/clusters', body, baseUrl)
}

/** GET /clusters/{clusterID} — クラスタが実在するかを確かめる（作成直後の実在確認に使う）。 */
export async function getCluster(auth: CloudCredentials, clusterID: string, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return getJson(auth, `/clusters/${encodeURIComponent(clusterID)}`, baseUrl)
}

/** DELETE /clusters/{clusterID} — クラスタを削除する。**ASG・LBを先に消してから呼ぶこと**（5-7）。 */
export async function deleteCluster(auth: CloudCredentials, clusterID: string, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return requestJson(auth, 'DELETE', `/clusters/${encodeURIComponent(clusterID)}`, undefined, baseUrl)
}

/** POST /clusters/{clusterID}/asg — オートスケーリンググループを作成する（5-5）。 */
export async function createAsg(auth: CloudCredentials, clusterID: string, body: unknown, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return requestJson(auth, 'POST', `/clusters/${encodeURIComponent(clusterID)}/asg`, body, baseUrl)
}

/** GET /clusters/{clusterID}/asg/{asgID} — ASGが実在するかを確かめる。 */
export async function getAsg(auth: CloudCredentials, clusterID: string, asgID: string, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return getJson(auth, `/clusters/${encodeURIComponent(clusterID)}/asg/${encodeURIComponent(asgID)}`, baseUrl)
}

/** DELETE /clusters/{clusterID}/asg/{asgID} — ASGを削除する。**LBを先に消してから呼ぶこと**（5-7）。 */
export async function deleteAsg(auth: CloudCredentials, clusterID: string, asgID: string, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return requestJson(auth, 'DELETE', `/clusters/${encodeURIComponent(clusterID)}/asg/${encodeURIComponent(asgID)}`, undefined, baseUrl)
}

/**
 * GET /clusters/{clusterID}/asg?maxItems= — 既存ASGの一覧（上限チェック等で使う）。
 * maxItems は必須（5-1）。既定は LIST_MAX_ITEMS。
 */
export async function listAsg(auth: CloudCredentials, clusterID: string, maxItems: number = LIST_MAX_ITEMS, baseUrl?: string): Promise<ApprunDedicatedResult> {
  return getJson(auth, `/clusters/${encodeURIComponent(clusterID)}/asg?maxItems=${maxItems}`, baseUrl)
}

/**
 * POST /clusters/{clusterID}/asg/{asgID}/load_balancers — ロードバランサを作成する（5-6）。
 * **クラスタ作成には含まれない別資源。** ASGの下に別途POSTで作る。
 */
export async function createLoadBalancer(
  auth: CloudCredentials, clusterID: string, asgID: string, body: unknown, baseUrl?: string,
): Promise<ApprunDedicatedResult> {
  return requestJson(
    auth, 'POST', `/clusters/${encodeURIComponent(clusterID)}/asg/${encodeURIComponent(asgID)}/load_balancers`, body, baseUrl,
  )
}

/**
 * DELETE /clusters/{clusterID}/asg/{asgID}/load_balancers/{lbID} — ロードバランサを削除する。
 * **消し忘れると、それ単体で課金が続く**（5-6・5-7）。
 */
export async function deleteLoadBalancer(
  auth: CloudCredentials, clusterID: string, asgID: string, lbID: string, baseUrl?: string,
): Promise<ApprunDedicatedResult> {
  return requestJson(
    auth, 'DELETE',
    `/clusters/${encodeURIComponent(clusterID)}/asg/${encodeURIComponent(asgID)}/load_balancers/${encodeURIComponent(lbID)}`,
    undefined, baseUrl,
  )
}

/**
 * GET /clusters/{clusterID}/asg/{asgID}/load_balancers?maxItems= — 既存ロードバランサの一覧。
 * maxItems は必須（5-1）。既定は LIST_MAX_ITEMS。
 */
export async function listLoadBalancers(
  auth: CloudCredentials, clusterID: string, asgID: string, maxItems: number = LIST_MAX_ITEMS, baseUrl?: string,
): Promise<ApprunDedicatedResult> {
  return getJson(
    auth, `/clusters/${encodeURIComponent(clusterID)}/asg/${encodeURIComponent(asgID)}/load_balancers?maxItems=${maxItems}`, baseUrl,
  )
}
