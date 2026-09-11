import { useState, useEffect, useCallback, useRef } from 'react'
import { listCloudKeys, getActiveCloudKeyId, activateCloudKey, CloudKeyInfo } from './CredentialsModal'
import CopyButton from './CopyButton'
import { withApprunDedicatedRecord } from '../../shared/publishMeta'
import { readLimits, readWorkerClasses, readLbClasses, readClusters, readNextCursor, type ApprunDedicatedPlanRow, type ZoneRow } from '../../shared/apprunDedicatedShapes'
import { loadZones } from '../zonesCache'
import { runCreate, runTeardown, shouldShowCreateResult, shouldShowTeardownResult } from '../apprunDedicatedActions'
import { beginActivity, PUBLISH_CLOSE_WARNING } from '../activity'
import ConnectionChecklist from './ConnectionChecklist'

// さくらのAppRun 専有型パネル（roadmap #23）。
//
// **クラスタの作成（⑤）・破棄（⑥）は行える**（段階②④・v0.6.9 で実装済み）。
// まだ無いのは「アプリケーション/バージョン」（roadmap #23 の⑤独自ドメイン相当）の作成——
// つまり Koto からアプリを独自ドメインで公開するところまでは実装していない。
// この画面がやるのは: ①認証情報の確認（疎通結果も表示） ②サービスプリンシパルの用意（手作業）の案内
// ③制限・プラン・費用をAPIから引いて見せる ④費用の同意を取る ⑤クラスタを作る ⑥作ったものを壊す、の6つ。
//
// docs/apprun-dedicated-plan.md（調査結果と実装設計の集約）を前提にしている。数値・料金は
// そこが正。API仕様が変われば同ファイルを読み直すこと（掟1）。

interface Props {
  projectDir: string
  onOpenCredentials: () => void
}

// ── ③で表示する制限値の項目（docs/apprun-dedicated-plan.md 3. の実測値と同じキー名）。
// 応答に無い項目は null のまま「取得できませんでした」を出す（推測で埋めない）。
const LIMIT_FIELDS: { key: string; label: string }[] = [
  { key: 'clusterCount', label: 'クラスタ数' },
  { key: 'autoScalingGroupCount', label: 'オートスケーリンググループ数' },
  { key: 'workerNodeCount', label: 'ワーカノード数' },
  { key: 'loadBalancerNodeCount', label: 'ロードバランサノード数' },
  { key: 'applicationCount', label: 'アプリケーション数' },
  { key: 'applicationVersionCountPerApplication', label: 'アプリ1つあたりのバージョン数' },
]

type Limits = Record<string, number | null>

// path は ⑤ の作成本文（workerServiceClassPath / lbServiceClassPath）にそのまま使う値。
// 名前だけでなくここも取得しておかないと、選んだプランをAPIへ渡せない（段階②で追加）。
type PlanRow = ApprunDedicatedPlanRow

// 応答の形は src/shared/apprunDedicatedShapes.ts に集約してある（掟10・5-8の事故を受けて）。
// ここでは件数の把握（hasMore の判定）だけを行う。続きキーは readNextCursor（`nextCursor` だけを
// 見る。原本 v1.4.0 に無い `cursor`/`next` を推測で試さない・N・2026-09-10 レビューの修理・バッチ3）。
function extractClusterCount(data: unknown): { count: number; hasMore: boolean } {
  const list = readClusters(data)
  const hasMore = readNextCursor(data) !== null
  return { count: list.length, hasMore }
}

// リソースID（サービスプリンシパルID）の形式チェック。**長さ（12文字）だけ**を見る。
// 実在するかどうかはここでは確認できない（IAM APIが通常のAPIキーでは使えないため・実測403）。
function resourceIdFormatOk(raw: string): boolean | null {
  const v = raw.trim()
  if (!v) return null
  return v.length === 12
}

const ROLE_TEXT = 'さくらのクラウド > 作成・削除'
const CONTROL_PANEL_URL = 'https://secure.sakura.ad.jp/cloud/'
const OFFICIAL_PRICE_URL = 'https://cloud.sakura.ad.jp/products/apprun-dedicated/index.html'

// docs/apprun-dedicated-plan.md 2.「料金（公式製品ページ・税込）」の値（2026-09時点）。
// monthlyYen は⑤の見積り計算に使う数値版（表に無いプランは推測で埋めない＝下の関数群が担保する）。
const WORKER_PRICES: { plan: string; hourly: string; daily: string; monthly: string; monthlyYen: number }[] = [
  { plan: '1コア/2GB', hourly: '55円', daily: '550円', monthly: '11,000円', monthlyYen: 11000 },
  { plan: '2コア/2GB', hourly: '84円', daily: '847円', monthly: '16,940円', monthlyYen: 16940 },
  { plan: '4コア/4GB', hourly: '165円', daily: '1,650円', monthly: '33,000円', monthlyYen: 33000 },
  { plan: '8コア/8GB', hourly: '320円', daily: '3,201円', monthly: '64,020円', monthlyYen: 64020 },
]

// ── ⑤ クラスタ作成: 入力チェック・見積りの純関数（テスト対象） ─────────────────────

// クラスタ・ASG・LB 名の形式（5-2/5-5/5-6: 1〜20文字・英数字と `_` `-`）。
export function isValidResourceName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,20}$/.test(name)
}

// 予約ポート（5-5）。main側 src/main/cloud/apprunDedicatedApply.ts の RESERVED_PORT_RANGE と
// 同じ範囲（renderer からは main のモジュールを import できないため、この小さな範囲チェックだけ
// 複製している。掟10が禁じる「同じ形のマージ処理の複製」ではなく、ドキュメント由来の定数）。
export const RESERVED_PORT_RANGE: readonly [number, number] = [5950, 5959]
export function isReservedPort(port: number): boolean {
  return port >= RESERVED_PORT_RANGE[0] && port <= RESERVED_PORT_RANGE[1]
}

// ── ⑤ ゾーン選択（roadmap #28: GET /zone の一覧から選ぶ。5-9） ─────────────────────

/**
 * ⑤で選ばせるゾーンの一覧を作る（GET /zone の応答から readZones で読んだ行を渡す）。
 * **`isDummy === false`（＝本物だと分かっているもの）だけを残す。** `true`（Sandbox 等の
 * 見せかけのゾーン）はもちろん、**`null`（IsDummy が boolean でなかった＝分からない）も除く**
 * （事故の直し1・2026-09-08 検分で発見）。分からないものを選べる一覧に混ぜない――安全側に倒す。
 * `displayOrder` の昇順に並べる（null は最後）。同値・両方 null なら `name` の辞書順で安定させる
 * （並び順には依存しない――実測の並びが変わっても結果が変わらないことをテストで固定してある）。
 */
export function selectableZones(rows: readonly ZoneRow[]): ZoneRow[] {
  return rows
    .filter(r => r.isDummy === false)
    .slice()
    .sort((a, b) => {
      const ao = a.displayOrder
      const bo = b.displayOrder
      if (ao == null && bo == null) return a.name.localeCompare(b.name)
      if (ao == null) return 1
      if (bo == null) return -1
      if (ao !== bo) return ao - bo
      return a.name.localeCompare(b.name)
    })
}

/**
 * ⑤で既定に選ぶゾーン名。`selectableZones` の並べ替え後の先頭。**1つも選べなければ null**
 * （＝既定を選ばない。呼び出し側が自由入力に戻る・分からない値を焼き込まない）。
 * 特定のゾーン名を決め打ちで返さない――**一覧から決める**。
 */
export function defaultZone(rows: readonly ZoneRow[]): string | null {
  return selectableZones(rows)[0]?.name ?? null
}

/**
 * プランの `path`（例 `cloud/apprun/dedicated/worker/1vcpu_2gb` / `…/lb/1vcpu_2gb_1`）から
 * 料金表のキー（例 `1コア/2GB`）を作る。形が合わなければ null（＝料金表と突き合わせられない）。
 */
export function planKeyFromPath(path: string | null | undefined): string | null {
  if (!path) return null
  const seg = path.split('/').pop() ?? ''
  const m = seg.match(/^(\d+)vcpu_(\d+)gb(?:_\d+)?$/i)
  return m ? `${m[1]}コア/${m[2]}GB` : null
}

/** プランの path から月額（円）を引く。表に無ければ null（**推測で埋めない**）。 */
export function monthlyYenForPlanPath(path: string | null | undefined): number | null {
  const key = planKeyFromPath(path)
  if (!key) return null
  return WORKER_PRICES.find(r => r.plan === key)?.monthlyYen ?? null
}

/**
 * 既定で選ぶワーカプランを決める（roadmap #26）。
 *
 * **料金表で額を引けるものの中で最安**を返す。実 API は高い順（8vCPU/8GB → 1vCPU/2GB）で
 * 返すため、「一覧の先頭」を既定にすると最も高いプランを選んでしまう（2026-09-07 実機で発覚）。
 * 額を引けないプラン（料金表に無い path）は候補にしない——分からない額を既定にしない。
 * 1つも額を引けなければ **null**（＝既定を選ばない。呼び出し側は「プランを選んでください」を出す）。
 * 並び順には依存しない（`reduce` で全件を比較する）。
 */
export function pickCheapestWorkerPlan(plans: readonly PlanRow[] | null | undefined): PlanRow | null {
  const priced = (plans ?? []).filter(p => monthlyYenForPlanPath(p.path) != null)
  if (priced.length === 0) return null
  return priced.reduce((cheapest, p) =>
    monthlyYenForPlanPath(p.path)! < monthlyYenForPlanPath(cheapest.path)! ? p : cheapest
  )
}

/** プランの実際の月額（総額）。単価 ×（ノード数。不明なら1台と仮定）。表に無ければ null。 */
function totalMonthlyYenForPlan(p: PlanRow): number | null {
  const unit = monthlyYenForPlanPath(p.path)
  if (unit == null) return null
  return unit * (p.nodeCount ?? 1)
}

/**
 * 既定で選ぶロードバランサプランを決める（roadmap #26）。
 *
 * `nodeCount === 1`（非冗長）を優先し、その中で**総額（単価 × (nodeCount ?? 1)）が最安**のものを返す。
 * `monthlyYenForPlanPath` は path 末尾の `_1`/`_2`（ノード数の違い）を無視して**1ノードあたりの単価**を
 * 返すため、単価だけで比べると「実際に払う額」を比較したことにならない
 * （非冗長=1台なら単価=総額で一致するが、フォールバックで冗長プラン同士を比べるときにズレる）。
 * 非冗長で額を引けるプランが1つも無ければ、額を引けるプラン全体からの**総額**最安にフォールバックする。
 * ワーカ側と同じく、額を引けないプランは候補にせず、1つも引けなければ null。
 * 並び順には依存しない（`reduce` で全件を比較する）。
 */
export function pickCheapestLbPlan(plans: readonly PlanRow[] | null | undefined): PlanRow | null {
  const priced = (plans ?? []).filter(p => monthlyYenForPlanPath(p.path) != null)
  if (priced.length === 0) return null
  const nonRedundant = priced.filter(p => p.nodeCount === 1)
  const pool = nonRedundant.length > 0 ? nonRedundant : priced
  return pool.reduce((cheapest, p) =>
    totalMonthlyYenForPlan(p)! < totalMonthlyYenForPlan(cheapest)! ? p : cheapest
  )
}

/**
 * 押す前の確認ダイアログに出す見積り文を組み立てる（掟5: 破壊操作は確認ダイアログに額を出す）。
 * **表に無いプランは「月額を出せません」と正直に出し、金額を推測して埋めない**
 * （2026-08-14「既定値が、勝手に課金を生むことがある」と同じ理由——分からない額を0や代表値で
 * 埋めると、静かに間違った金額を信じさせてしまう）。
 *
 * **`maxNodes`（2026-09-10 レビューの修理・G）**: オートスケーリングで実際に払う額は
 * `minNodes` の最小構成だけではない。`maxNodes > minNodes` のときは、最小構成の額に加えて
 * 「負荷で最大N台まで増えると月額いくらになるか」も出す——最小構成の額だけを見せて、
 * 負荷時に増える分を隠さない。`maxNodes` 未指定（省略）時は `minNodes` と同じ扱いにし、
 * 既存の呼び出し元（3引数）の挙動は変えない。
 */
export function priceSummary(
  workerPlan: { path: string | null } | null,
  lbPlan: { path: string | null; nodeCount: number | null } | null,
  minNodes: number,
  maxNodes: number = minNodes,
): { text: string; totalYen: number | null } {
  const workerYen = workerPlan ? monthlyYenForPlanPath(workerPlan.path) : null
  const lbYen = lbPlan ? monthlyYenForPlanPath(lbPlan.path) : null
  const lbNodeCount = lbPlan?.nodeCount ?? 1
  const workerPart = workerYen != null ? `ワーカ ${workerYen.toLocaleString('ja-JP')}円 × ${minNodes}台` : 'ワーカ（月額を出せません）'
  const lbPart = lbYen != null ? `ロードバランサ ${lbYen.toLocaleString('ja-JP')}円 × ${lbNodeCount}台` : 'ロードバランサ（月額を出せません）'
  if (workerYen == null || lbYen == null) {
    return { text: `${workerPart} ＋ ${lbPart} ＝ 月額を出せません（料金表に無いプランが含まれています）`, totalYen: null }
  }
  const total = workerYen * minNodes + lbYen * lbNodeCount
  const base = `${workerPart} ＋ ${lbPart} ＝ 月額 ${total.toLocaleString('ja-JP')}円`
  if (maxNodes > minNodes) {
    const maxTotal = workerYen * maxNodes + lbYen * lbNodeCount
    return {
      text: `${base}（最小構成。負荷で最大 ${maxNodes}台まで増えると 月額 ${maxTotal.toLocaleString('ja-JP')}円）`,
      totalYen: total,
    }
  }
  return { text: base, totalYen: total }
}

// ── ⑤ 結果表示（createResult）: ステージの日本語化・「未作成」と「作られたか未確認」の
// 使い分け（2026-09-10 レビューの修理・D） ──────────────────────────────────────
// main側 apprunDedicatedApply.ts の CreateClusterFlowStage と同じ値（renderer からは main の
// モジュールを import できないため、文字列リテラル union だけを複製する。RESERVED_PORT_RANGE
// と同じ理由・掟10が禁じる「同じ形のマージ処理の複製」ではない）。
export type CreateClusterFlowStage =
  | 'consent' | 'invalid' | 'existing' | 'record' | 'limits'
  | 'cluster-create' | 'cluster-verify' | 'asg-create' | 'asg-verify' | 'lb-create' | 'lb-verify' | 'done'

/** ステージの英語名（cluster-verify 等）を画面に出さないための日本語対訳。 */
export const STAGE_LABEL: Record<CreateClusterFlowStage, string> = {
  consent: '確認',
  invalid: '入力の検証',
  existing: '既存の記録',
  record: '記録',
  limits: '上限の確認',
  'cluster-create': 'クラスタの作成',
  'cluster-verify': 'クラスタの実在確認',
  'asg-create': 'ASGの作成',
  'asg-verify': 'ASGの実在確認',
  'lb-create': 'ロードバランサの作成',
  'lb-verify': 'ロードバランサの実在確認',
  done: '完了',
}

// 各資源の作成を main 側が実際に試みる段（＝これ以降の stage で ID が無ければ「本当に無い」と
// 言い切れない。POST の応答が取れず、名前探しでも見つからなかった場合がこれに当たる）。
const STAGE_ORDER: CreateClusterFlowStage[] = [
  'consent', 'invalid', 'existing', 'record', 'limits',
  'cluster-create', 'cluster-verify', 'asg-create', 'asg-verify', 'lb-create', 'lb-verify', 'done',
]
const ATTEMPT_STAGE = {
  clusterID: 'cluster-create' as CreateClusterFlowStage,
  asgID: 'asg-create' as CreateClusterFlowStage,
  loadBalancerID: 'lb-create' as CreateClusterFlowStage,
}

/**
 * ⑤の結果一覧に出す1行の表示値。IDがあればそのIDを返す。
 * IDが無いとき: まだその資源の作成を一度も試みていない段（stage がその資源の作成段より前）
 * なら「（未作成）」と言い切ってよいが、試みたあと（POSTしたが応答が取れず、名前探しでも
 * 見つからなかった場合）は「本当に作られていないか」を確認できていないので、
 * 「（作られたか未確認）」と正直に言う（掟1: 分からないものを「大丈夫」側に倒さない）。
 */
export function resourceIdLabel(
  id: string | null | undefined,
  resource: keyof typeof ATTEMPT_STAGE,
  currentStage: CreateClusterFlowStage,
): string {
  if (id) return id
  const attemptedIndex = STAGE_ORDER.indexOf(ATTEMPT_STAGE[resource])
  const currentIndex = STAGE_ORDER.indexOf(currentStage)
  return currentIndex >= attemptedIndex ? '（作られたか未確認）' : '（未作成）'
}

// ── ⑤ 直前の簡易構成図（Ryosuke さん要望「クラスタを作成するボタンの上に、簡易的な構成を
// 示せないか」）。**自前の図形（箱と文字）で描く**——さくらの公式アイコンは、ガイドラインが
// 「アイコンそのものの再配布」を禁じており、非公式ツールが画面に埋め込むと公認と誤解させうる
// ため使わない（承認済みの方針）。SVGや画像は使わない・CSSの枠と文字だけで組む。
export type ClusterDiagramInput = {
  clusterName: string
  zone: string
  ports: { port: number; protocol: 'http' | 'https' }[]
  /** 選択中のワーカプランの表示名（未選択・未確定なら null）。 */
  workerPlanName: string | null
  minNodes: number
  /** 選択中のロードバランサプランの表示名（未選択・未確定なら null）。 */
  lbPlanName: string | null
  /** priceSummary(...).text をそのまま渡す（**計算を複製しない**・掟10）。
   *  料金表に無いプランのときは、この中の「月額を出せません」がそのまま出る。 */
  priceText: string
}

const DIAGRAM_UNSET = '（未入力）'

/**
 * ⑤「クラスタを作成する」ボタンのすぐ上に出す構成図の行を組み立てる（テスト対象の純関数）。
 * **入力が未確定のところは「（未入力）」と出す**（推測で埋めない・掟1）。
 * 月額は自分で計算しない——呼び出し側が渡す priceSummary の text をそのまま使う。
 */
export function buildClusterDiagram(input: ClusterDiagramInput): { lines: string[]; total: string } {
  const name = input.clusterName.trim() || DIAGRAM_UNSET
  // ⚠️ 空文字は「（未入力）」に倒す（2026-09-09 検分で発見）。`?? DIAGRAM_UNSET` は
  // null/undefined しか拾わないため、プラン名が '' のときは〈〉と出てしまっていた。
  const worker = input.workerPlanName?.trim() || DIAGRAM_UNSET
  const lb = input.lbPlanName?.trim() || DIAGRAM_UNSET
  const zone = input.zone.trim() || DIAGRAM_UNSET
  const nodes = Number.isInteger(input.minNodes) && input.minNodes >= 1 ? `${input.minNodes}台` : DIAGRAM_UNSET
  // ⚠️ 「+ ポートを追加」直後は {port:0} が積まれる（未入力の意味）。押した直後の図に
  // 「0/http」という、利用者が入れていない値を設定値として見せない（2026-09-09 検分で発見）。
  const ports = input.ports.length > 0
    ? input.ports.map(p => p.port > 0 ? `${p.port}/${p.protocol}` : DIAGRAM_UNSET).join(', ')
    : DIAGRAM_UNSET
  return {
    lines: [
      `クラスタ〈${name}〉`,
      `└ オートスケーリンググループ　ワーカ〈${worker}〉× ${nodes}`,
      `└ ロードバランサ　　　　　　　〈${lb}〉`,
      `ゾーン〈${zone}〉／ 共有セグメント ／ 公開ポート〈${ports}〉`,
    ],
    total: `合計 ${input.priceText}`,
  }
}

// ── ⑥「いまの構成と月額目安」（3b・利用者目線レビュー・判断不要） ─────────────────────
// 破棄の前に「何を消すか」を一目にする。**計算を複製しない**（掟10）——月額は既存の
// priceSummary(...) の text をそのまま使う。記録にプランの path が無い旧データのときは
// 金額行を省く（推測で埋めない）。
export type TeardownSummaryRecord = {
  name?: string | null
  zone?: string | null
  workerServiceClassPath?: string | null
  lbServiceClassPath?: string | null
  createdAt?: string | null
} | null | undefined

export type TeardownSummaryPlans = {
  worker?: readonly PlanRow[] | null
  lb?: readonly PlanRow[] | null
} | null | undefined

const TEARDOWN_SUMMARY_UNKNOWN = '不明'

/**
 * workerServiceClassPath/lbServiceClassPath から表示名を引く。プラン一覧が未取得（null・未取得）
 * のとき、または一覧の中に一致するプランが無いときは、**path をそのまま**返す（推測で名前を
 * 作らない）。path 自体が無ければ null。
 */
function planLabelForPath(path: string | null | undefined, rows: readonly PlanRow[] | null | undefined): string | null {
  if (!path) return null
  return (rows ?? []).find(p => p.path === path)?.name ?? path
}

/**
 * ⑥のリソースID一覧の上に出す「いまの構成と月額目安」の行を組み立てる（純関数・テスト対象。
 * tests/apprunDedicatedTeardownSummary.test.ts）。
 *
 * ワーカの台数（minNodes/maxNodes）は記録（ApprunDedicatedRecord）に残っていない
 * （⑤の入力欄の値であり、⑤の外へは保存していない）ため、ここでは「1台」を目安として
 * priceSummary を呼ぶ——「月額目安」という見出しでそれが概算であることを示す。
 */
export function buildTeardownSummary(record: TeardownSummaryRecord, plans: TeardownSummaryPlans): { lines: string[] } {
  const r = record ?? {}
  const lines: string[] = [
    `名前: ${r.name ?? TEARDOWN_SUMMARY_UNKNOWN}`,
    `ゾーン: ${r.zone ?? TEARDOWN_SUMMARY_UNKNOWN}`,
    `ワーカプラン: ${planLabelForPath(r.workerServiceClassPath, plans?.worker) ?? TEARDOWN_SUMMARY_UNKNOWN}`,
    `ロードバランサプラン: ${planLabelForPath(r.lbServiceClassPath, plans?.lb) ?? TEARDOWN_SUMMARY_UNKNOWN}`,
    `作成日時: ${r.createdAt ? new Date(r.createdAt).toLocaleString('ja-JP') : TEARDOWN_SUMMARY_UNKNOWN}`,
  ]
  // 記録にプランの path が無い旧データのときは金額行を省く（推測で埋めない）。
  if (r.workerServiceClassPath && r.lbServiceClassPath) {
    const lbRow = (plans?.lb ?? []).find(p => p.path === r.lbServiceClassPath) ?? null
    const price = priceSummary(
      { path: r.workerServiceClassPath },
      { path: r.lbServiceClassPath, nodeCount: lbRow?.nodeCount ?? null },
      1,
    )
    lines.push(`月額目安: ${price.text}`)
  }
  return { lines }
}

export default function AppRunDedicatedPanel({ projectDir, onOpenCredentials }: Props) {
  const metaPath = `${projectDir}/.sakuraide.json`

  const readMeta = useCallback(async (): Promise<any> => {
    try { return JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { return {} }
  }, [metaPath])

  // このプロジェクトの公開先として記録する（VpsPanel と同じ作法）。
  // ※ PublishTargetKind（公開記録の種別）には足さない——クラスタ・ASG・LBを作れるようになっても
  //   「アプリを公開する」段（roadmap #23 の⑤独自ドメイン相当）はまだ無いため
  //   （sakura-vps が同じ扱い。PublishModal.tsx 参照）。
  //
  // publish.apprunDedicated へのマージ書き込みは shared/publishMeta.ts の
  // withApprunDedicatedRecord に一元化してある（掟10・main側の apprunDedicatedApply.ts も
  // 同じ関数を通す publishMetaFs.ts 経由で同じ場所へ書く。同じ形のマージを別々に書かない）。
  const saveMeta = useCallback(async (patch: Record<string, unknown>) => {
    const m = await readMeta()
    const merged = withApprunDedicatedRecord(m, patch)
    const next = { ...merged, target: 'sakura-apprun-dedicated' }
    await window.electronAPI.fs.writeFile(metaPath, JSON.stringify(next, null, 2))
    window.dispatchEvent(new Event('sakura-meta-changed'))
    return next
  }, [metaPath, readMeta])

  // ── ① APIキー ──────────────────────────────────────────────
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [cloudKeys, setCloudKeys] = useState<CloudKeyInfo[]>([])
  const [activeKeyId, setActiveKeyId] = useState<string | null>(null)
  // 接続テスト（事故の直し1）: 未実施 / 確認中 / OK / NG の4つ。共用型 AppRunPanel の
  // conn / connMsg と同じ作法。専有型API（apprunDedicated.limits・GETのみ）へ実際に疎通する。
  const [conn, setConn] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [connMsg, setConnMsg] = useState('')
  // 🔌 接続テストの内訳（roadmap #35）。共用型 AppRunPanel の connChecks と同じ形に揃える。
  // ③「🔍 調べる」はこれとは別の4本（limits/worker/lb/clusters）を叩くので、ここは触らず
  // null のまま——投げっぱなしの古い内訳を出し続けないよう、投げ直すたびに一旦クリアする。
  type ConnCheck = { ok: boolean; status?: number; message?: string }
  const [connChecks, setConnChecks] = useState<{ api: ConnCheck; billing: ConnCheck } | null>(null)

  // 世代カウンタ（2026-09-10 レビューの修理・I・zonesCache.ts と同じ方式）。キーを切り替えた
  // あとに、切り替え前に投げていた testConnection/investigate の応答が遅れて戻ってきても、
  // その結果で画面を上書きしない（「キー切替後に古い応答が戻る競合」）。selectKey とキー切替の
  // 通知（'sakura:credentials-changed'）の両方で進める——selectKey は activateCloudKey 経由で
  // 結局この通知も発火させるが、他画面（認証情報）からの切替はこの通知だけを経由するため、
  // どちらか片方だけに置くと取りこぼす。
  const genRef = useRef(0)

  const refreshKey = useCallback(async () => {
    try { setHasKey(await window.electronAPI.cloud.hasKey()) } catch { setHasKey(false) }
  }, [])
  const refreshCloudKeys = useCallback(async () => {
    try { setCloudKeys(await listCloudKeys()) } catch { setCloudKeys([]) }
    try { setActiveKeyId(await getActiveCloudKeyId()) } catch { setActiveKeyId(null) }
  }, [])
  const selectKey = async (id: string) => {
    genRef.current++
    const r = await activateCloudKey(id)
    if (!r.ok) return
    await refreshKey(); await refreshCloudKeys()
    // 使うキーを切り替えたら、前のキーで確かめた疎通結果は無効。再度確かめてもらう。
    setConn('idle'); setConnMsg(''); setConnChecks(null)
  }

  // 🔌 接続テスト: このキーで専有型APIへ実際に疎通する（GETのみ・何も作らない・掟4の方式Bを踏襲）。
  // 共用型 AppRunPanel の testConnection と同じ「チェックリスト」の形に揃える（roadmap #35）:
  // (1) 専有型API 参照（制限・プラン） (2) 請求（コスト）参照。レジストリはまだ確認しない
  // （専有型からのアプリ公開に未対応のため。注記で案内する）。
  const testConnection = async () => {
    const myGen = genRef.current
    setConn('testing'); setConnMsg(''); setConnChecks(null)
    try {
      const auth = await window.electronAPI.cloud.loadKey()
      if (genRef.current !== myGen) return // 世代が進んでいた（キーが切り替わった）→ この応答は使わない
      if (!auth || !auth.token || !auth.secret) {
        setConn('ng'); setConnMsg('さくらのクラウドAPIキーが未登録です。①で登録してください。')
        return
      }
      const r = await window.electronAPI.apprunDedicated.testConnection(auth)
      if (genRef.current !== myGen) return // 世代が進んでいた → setConn 等をしない
      setConnChecks(r.checks)
      setConn(r.ok ? 'ok' : 'ng')
      setConnMsg('')
    } catch (e: any) {
      if (genRef.current !== myGen) return
      setConn('ng'); setConnChecks(null)
      setConnMsg(e?.message ?? String(e))
    }
  }

  // ── ② サービスプリンシパル（リソースID・手作業） ──────────────────
  const [resourceId, setResourceId] = useState('')
  const idFormat = resourceIdFormatOk(resourceId)
  const saveResourceId = async (v: string) => { await saveMeta({ servicePrincipalId: v }) }

  // ── ③ プラン・制限（API取得） ─────────────────────────────────
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [limits, setLimits] = useState<Limits | null>(null)
  const [limitsError, setLimitsError] = useState<string | null>(null)
  const [workerPlans, setWorkerPlans] = useState<PlanRow[] | null>(null)
  const [workerError, setWorkerError] = useState<string | null>(null)
  const [lbPlans, setLbPlans] = useState<PlanRow[] | null>(null)
  const [lbError, setLbError] = useState<string | null>(null)
  const [clusterInfo, setClusterInfo] = useState<{ count: number; hasMore: boolean } | null>(null)
  const [clusterError, setClusterError] = useState<string | null>(null)
  // ゾーン一覧（roadmap #28・GET /zone。⑤の選択式化に使う。他の3つと同時に並列で取る）。
  const [zones, setZones] = useState<ZoneRow[] | null>(null)
  const [zonesError, setZonesError] = useState<string | null>(null)

  // 起動時のキャッシュを使い、③「🔍 調べる」を押さなくても選べるようにする（2026-09-08
  // Ryosuke さん依頼）。App.tsx の primeZonesCache() がアプリ起動時に一度取得済み（か、
  // 取得中）のはずなので、ここでは force しない＝そのキャッシュ／進行中の Promise を使う。
  // 失敗（キー未登録・取得エラーいずれも）はここでは何もしない――「未実施」の表示のまま
  // 静かに留め、実際に失敗を伝えるのは③を押した investigate() の役目にする（キーをまだ
  // 登録していないだけの利用者に、開いた瞬間「取得できませんでした」を見せないため）。
  useEffect(() => {
    let alive = true
    loadZones().then(r => { if (alive && r.ok) setZones(r.rows) })
    return () => { alive = false }
  }, [])

  const investigate = async () => {
    const myGen = genRef.current
    setChecking(true); setCheckError(null)
    // ③はここでの conn/connMsg 判定に使う4本（limits/worker/lb/clusters）が①の請求チェックとは
    // 別物なので、①「🔌 接続テスト」の内訳（connChecks）は一旦クリアする（古い内訳を出し続けない）。
    setConnChecks(null)
    try {
      // 方式B（掟4）: main には保存しない。使う瞬間に「使用中」のクラウドキーを読み、引数で渡す。
      const auth = await window.electronAPI.cloud.loadKey()
      if (genRef.current !== myGen) return // 世代が進んでいた（キーが切り替わった）→ この応答は使わない
      if (!auth || !auth.token || !auth.secret) {
        setCheckError('さくらのクラウドAPIキーが未登録です。①で登録してください。')
        // ここでは何も試していない（＝キーが「悪い」わけではない）ので conn は 'idle' のまま。
        // 'ng' にすると「このキーでは通じませんでした」と出て、①の「⚠️ APIキーが未登録です」と
        // 合わせて「キーが無い」のか「キーが悪い」のか分からなくなる。
        return
      }
      setLimits(null); setLimitsError(null)
      setWorkerPlans(null); setWorkerError(null)
      setLbPlans(null); setLbError(null)
      setClusterInfo(null); setClusterError(null)
      setZones(null); setZonesError(null)

      // ゾーン一覧は zonesCache.ts 経由（roadmap #28: 起動時キャッシュの使い回し）。
      // force=true で取り直す（③「🔍 調べる」＝最新に更新）。loadZones は失敗しても reject
      // しない設計（事故の直し3はここで担保。tests/zonesCache.test.ts で固定）なので、
      // Promise.all の他3本（limits/plans/clusters）を巻き添えにする心配は無い。
      const [limitsRes, plansRes, clustersRes, zonesRes] = await Promise.all([
        window.electronAPI.apprunDedicated.limits(auth),
        window.electronAPI.apprunDedicated.plans(auth),
        window.electronAPI.apprunDedicated.clusters(auth),
        loadZones(true),
      ])
      if (genRef.current !== myGen) return // 世代が進んでいた → setLimits 等の反映をしない

      if (limitsRes.ok) setLimits(readLimits(limitsRes.data))
      else setLimitsError(limitsRes.message)

      if (plansRes.worker.ok) setWorkerPlans(readWorkerClasses(plansRes.worker.data))
      else setWorkerError(plansRes.worker.message)

      if (plansRes.lb.ok) setLbPlans(readLbClasses(plansRes.lb.data))
      else setLbError(plansRes.lb.message)

      if (clustersRes.ok) setClusterInfo(extractClusterCount(clustersRes.data))
      else setClusterError(clustersRes.message)

      // ゾーン一覧が取れなくても⑤は自由入力に戻るだけ（利用者を止めない）。①の疎通判定
      // （下）には含めない――ゾーンは補助情報で、専有型APIそのものの疎通とは別に扱う。
      if (zonesRes.ok) setZones(zonesRes.rows)
      else setZonesError(zonesRes.message ?? '')

      // ①へ出す疎通結果（事故の直し1）: conn/connMsg に一本化。4本のうちどれか1つでも
      // 成功すれば「通じた」。全滅なら、代表的な失敗（limits→worker→lb→clusters の順で
      // 最初に見つかった1件）の生の応答を connMsg に入れる（推測で作らない）。
      if (limitsRes.ok || plansRes.worker.ok || plansRes.lb.ok || clustersRes.ok) {
        setConn('ok'); setConnMsg('')
      } else {
        const rep = !limitsRes.ok ? limitsRes.message
          : !plansRes.worker.ok ? plansRes.worker.message
          : !plansRes.lb.ok ? plansRes.lb.message
          : clustersRes.message
        setConn('ng'); setConnMsg(rep)
      }
    } catch (e: any) {
      if (genRef.current !== myGen) return
      setCheckError(e?.message ?? String(e))
      setConn('ng'); setConnMsg(e?.message ?? String(e))
    } finally {
      // 世代が進んでいても、このスピナー（checking）を止めるのは自分の役目のまま
      // （guard しないと、切替後に "調べています…" のまま固まる）。
      setChecking(false)
    }
  }

  // ── ④ 費用の同意 ────────────────────────────────────────────
  const [agree, setAgree] = useState(false)
  const [consentedAt, setConsentedAt] = useState<string | null>(null)
  const [consentBusy, setConsentBusy] = useState(false)

  const giveConsent = async () => {
    if (!agree || consentBusy) return
    setConsentBusy(true)
    try {
      const iso = new Date().toISOString()
      await saveMeta({ consentedAt: iso })
      setConsentedAt(iso)
    } finally { setConsentBusy(false) }
  }
  const revokeConsent = async () => {
    if (consentBusy) return
    setConsentBusy(true)
    try {
      await saveMeta({ consentedAt: null })
      setConsentedAt(null)
      setAgree(false)
    } finally { setConsentBusy(false) }
  }

  // ── 記録（何が実際に作られているか。main の .sakuraide.json 読み取り。APIは呼ばない） ──────
  type ApprunDedicatedState = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['state']>>
  const [apprunState, setApprunState] = useState<ApprunDedicatedState | null>(null)
  const refreshApprunState = useCallback(async () => {
    try { setApprunState(await window.electronAPI.apprunDedicated.state(projectDir)) } catch { setApprunState(null) }
  }, [projectDir])
  // 記録に何か1つでもあるか（clusterID/asgID/loadBalancerIDのいずれか）。⑤・⑥の両方が使うため、
  // 両方より前（このあたり）で定義する（2026-09-10 レビューの修理・B: 定義位置が⑤の描画より
  // 後ろだと、⑤側で「記録があれば新規作成させない」判定に使えない）。
  const hasAnyResource = !!(apprunState?.clusterID || apprunState?.asgID || apprunState?.loadBalancerID)

  // ── ⑤ クラスタを作る ────────────────────────────────────────
  const [clusterName, setClusterName] = useState('')
  const [ports, setPorts] = useState<{ port: number; protocol: 'http' | 'https' }[]>([
    { port: 80, protocol: 'http' },
    { port: 443, protocol: 'https' },
  ])
  // ゾーン: 一覧が取れているあいだは <select>（selectedZoneName）、取れなければ従来どおりの
  // 自由入力（zone）に戻る（roadmap #28）。既定値を決め打ちしない――'tk1b' 等はどこにも書かない。
  const [zone, setZone] = useState('') // 自由入力（一覧が取れないときのフォールバック。5-5）
  const [selectedZoneName, setSelectedZoneName] = useState<string | null>(null)
  const [minNodes, setMinNodes] = useState(1)
  const [maxNodes, setMaxNodes] = useState(1)
  const [selectedWorkerPath, setSelectedWorkerPath] = useState<string | null>(null)
  const [selectedLbPath, setSelectedLbPath] = useState<string | null>(null)
  const [letsEncryptEmail, setLetsEncryptEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['create']>> | null>(null)

  // プランが取得できたら（③の「調べる」の後）既定を選んでおく。一度選んだら上書きしない。
  // **既定は「料金表で引ける中の最安」**（roadmap #26）。額を引けないプランは既定にしない
  // （選べなければ null のままにし、⑤に「プランを選んでください」を出す＝黙って高いものを選ばない）。
  useEffect(() => {
    if (selectedWorkerPath) return
    const cheapest = pickCheapestWorkerPlan(workerPlans)
    if (cheapest) setSelectedWorkerPath(cheapest.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerPlans])
  useEffect(() => {
    if (selectedLbPath) return
    const cheapest = pickCheapestLbPlan(lbPlans)
    if (cheapest) setSelectedLbPath(cheapest.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lbPlans])
  // ゾーンも同じ作法: 一覧が取れたら defaultZone() を既定にする。一度選んだら上書きしないが、
  // ③を押し直して一覧が変わり、選択中の名前が新しい一覧に無くなったら defaultZone() に戻す
  // （事故の直し4: 画面の <select> は空欄に見えるのに送信値だけ古い名前のまま、というずれを防ぐ）。
  useEffect(() => {
    const rows = selectableZones(zones ?? [])
    if (selectedZoneName && rows.some(r => r.name === selectedZoneName)) return
    setSelectedZoneName(defaultZone(zones ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones])

  const zoneRows = selectableZones(zones ?? [])
  const zoneSelectable = zoneRows.length > 0
  // 一覧が取れて選べるあいだは select の値、そうでなければ自由入力の値（いまの入力に戻す）。
  const effectiveZone = zoneSelectable ? (selectedZoneName ?? '') : zone

  const updatePort = (i: number, next: { port: number; protocol: 'http' | 'https' }) => {
    setPorts(prev => prev.map((p, idx) => (idx === i ? next : p)))
  }
  const addPort = () => setPorts(prev => [...prev, { port: 0, protocol: 'http' as const }])
  const removePort = (i: number) => setPorts(prev => prev.filter((_, idx) => idx !== i))

  const selectedWorkerPlan = (workerPlans ?? []).find(p => p.path === selectedWorkerPath) ?? null
  const selectedLbPlan = (lbPlans ?? []).find(p => p.path === selectedLbPath) ?? null
  const price = priceSummary(selectedWorkerPlan, selectedLbPlan, minNodes, maxNodes)
  // ⑤ボタンのすぐ上に出す簡易構成図（いま選んでいる内容がそのまま反映される）。
  // 表示名は他の一覧（ワーカ/LBプランの <select>）と同じフォールバック（name ?? path）に揃える。
  const diagram = buildClusterDiagram({
    clusterName,
    zone: effectiveZone,
    ports,
    workerPlanName: selectedWorkerPlan ? (selectedWorkerPlan.name ?? selectedWorkerPlan.path) : null,
    minNodes,
    lbPlanName: selectedLbPlan ? (selectedLbPlan.name ?? selectedLbPlan.path) : null,
    priceText: price.text,
  })

  // 押す前にまとめて確かめる（掟5: 破壊操作は確認ダイアログ。ここは「常時課金の開始」という
  // 意味で同じ強さの確認を挟む）。入力が揃っていない間はボタンを押せない。
  const formError: string | null = (() => {
    const name = clusterName.trim()
    if (!name) return 'クラスタ名を入力してください'
    if (!isValidResourceName(name)) return 'クラスタ名は1〜20文字の英数字・_・- で入力してください'
    if (!resourceId.trim()) return '②でサービスプリンシパルIDを入力してください'
    if (ports.length === 0) return '公開ポートを1つ以上指定してください'
    if (ports.some(p => !(p.port >= 1 && p.port <= 65535))) return 'ポート番号は1〜65535で指定してください'
    if (ports.some(p => isReservedPort(p.port))) return `ポート ${RESERVED_PORT_RANGE[0]}-${RESERVED_PORT_RANGE[1]} は予約されており使えません`
    if (!effectiveZone.trim()) return 'ゾーンを入力してください'
    if (!selectedWorkerPath) return 'ワーカプランを選んでください（③で「調べる」を押していない場合は先に押してください）'
    if (!selectedLbPath) return 'ロードバランサプランを選んでください（③で「調べる」を押していない場合は先に押してください）'
    if (!(Number.isInteger(minNodes) && minNodes >= 1 && minNodes <= 10)) return 'ノード数（min）は1〜10で指定してください'
    if (!(Number.isInteger(maxNodes) && maxNodes >= 1 && maxNodes <= 10)) return 'ノード数（max）は1〜10で指定してください'
    if (minNodes > maxNodes) return 'ノード数は min ≦ max にしてください'
    return null
  })()

  // ⑤⑥の「確認→IPC」本体は apprunDedicatedActions.ts の純関数（runCreate/runTeardown）に
  // 切り出してある（2026-09-10 レビューの修理・J・rollbackSwitch.ts と同型）。ここ（doCreate/
  // doTeardown）はそれを呼ぶ薄い皮——confirm に window.confirm を、activity に
  // beginActivity（src/renderer/activity.ts）を注入するだけで、「確認が false なら
  // create/teardown を一度も呼ばない」「実行中は必ず活動レジストリへ計上する」歯止め自体は
  // ここには無い（tests/apprunDedicatedActions.test.ts が偽 confirm/create/teardown/activity で
  // 固定する。K・2026-09-10 レビューの修理・バッチ3——共用型の公開処理と同じく、作成・破棄の
  // 実行中は main の isBusy を立て、自動更新の「いますぐ再起動」が作業中を拒否できるようにする）。
  const doCreate = async () => {
    if (formError || creating) return
    const spec = {
      name: clusterName.trim(),
      ports,
      servicePrincipalID: resourceId.trim(),
      ...(letsEncryptEmail.trim() ? { letsEncryptEmail: letsEncryptEmail.trim() } : {}),
      zone: effectiveZone.trim(),
      workerServiceClassPath: selectedWorkerPath as string,
      minNodes, maxNodes,
      lbServiceClassPath: selectedLbPath as string,
    }
    try {
      const outcome = await runCreate(
        { confirmMessage: `${price.text}\n\nこの費用が毎月かかります。よろしいですか？`, spec },
        {
          confirm: (m) => window.confirm(m),
          activity: { begin: () => beginActivity('専有型クラスタの作成', { closeWarning: PUBLISH_CLOSE_WARNING }) },
          create: async (s, opts) => {
            // B-2（2026-09-10実機）: 新しい⑤の作成を始めたら、⑥の古い結果表示は消す
            // （shouldShowTeardownResult は teardownResult の有無だけを見るため、消す責務はここ）。
            setCreating(true); setCreateResult(null); setTeardownResult(null)
            const auth = await window.electronAPI.cloud.loadKey()
            if (!auth || !auth.token || !auth.secret) {
              return { ok: false, stage: 'consent', message: 'さくらのクラウドAPIキーが未登録です。①で登録してください。' } as any
            }
            return window.electronAPI.apprunDedicated.create(projectDir, auth, s, opts)
          },
        },
      )
      if (outcome.cancelled) return
      setCreateResult(outcome.result)
      await refreshApprunState()
    } catch (e: any) {
      setCreateResult({ ok: false, stage: 'consent', message: e?.message ?? String(e) } as any)
    } finally {
      setCreating(false)
    }
  }

  // ── ⑥ 作ったものを壊す（破棄） ───────────────────────────────
  const [tearingDown, setTearingDown] = useState(false)
  const [teardownResult, setTeardownResult] = useState<Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['teardown']>> | null>(null)
  // #39: 各段が一覧から消えるまで待つ間の進捗（「〜の削除を待っています（N分経過）…」）。
  // 実行中（tearingDown）だけ表示する（doTeardown の外へ漏らさない・掟11）。
  const [teardownProgress, setTeardownProgress] = useState<string | null>(null)
  useEffect(() => {
    const unsubscribe = window.electronAPI.apprunDedicated.onTeardownProgress((msg) => setTeardownProgress(msg))
    return () => { unsubscribe() }
  }, [])

  const doTeardown = async () => {
    if (tearingDown) return
    const targets = [
      apprunState?.loadBalancerID ? `ロードバランサ『${apprunState.loadBalancerID}』` : null,
      apprunState?.asgID ? `オートスケーリンググループ『${apprunState.asgID}』` : null,
      apprunState?.clusterID ? `クラスタ『${apprunState.clusterID}』` : null,
    ].filter(Boolean).join('・')
    try {
      const outcome = await runTeardown(
        { confirmMessage: `次を削除します: ${targets}\n\nこの操作は元に戻せません。消さない限り課金が続きます。よろしいですか？` },
        {
          confirm: (m) => window.confirm(m),
          activity: { begin: () => beginActivity('専有型クラスタの破棄', { closeWarning: PUBLISH_CLOSE_WARNING }) },
          teardown: async (opts) => {
            setTearingDown(true); setTeardownResult(null); setTeardownProgress(null)
            const auth = await window.electronAPI.cloud.loadKey()
            if (!auth || !auth.token || !auth.secret) {
              return { ok: false, executed: [], message: 'さくらのクラウドAPIキーが未登録です。①で登録してください。', remaining: {} }
            }
            return window.electronAPI.apprunDedicated.teardown(projectDir, auth, opts)
          },
        },
      )
      if (outcome.cancelled) return
      setTeardownResult(outcome.result)
      await refreshApprunState()
    } catch (e: any) {
      setTeardownResult({ ok: false, executed: [], message: e?.message ?? String(e), remaining: {} })
    } finally {
      setTearingDown(false)
    }
  }

  // ── ⑦ ログ・メトリクス（#38。プロジェクト単位＝クラスタごとではない。共用型
  //    TelemetryNotice と同じ見せ方・同じ文言の作法） ──────────────────────────────
  type TelemetryVariantStatus = { variant: string; label: string; kind: 'logs' | 'metrics'; routed: boolean }
  type TelemetryActionShape = { kind: 'none'; note?: string } | { kind: 'route'; storageId: string } | { kind: 'ask'; note: string }
  type TelemetryActions = { logs: TelemetryActionShape; metrics: TelemetryActionShape }
  const [telemetryVariants, setTelemetryVariants] = useState<TelemetryVariantStatus[] | null>(null)
  const [telemetryActions, setTelemetryActions] = useState<TelemetryActions | null>(null)
  const [telemetryLoading, setTelemetryLoading] = useState(true)
  const [telemetryError, setTelemetryError] = useState('')
  const [telemetryConfirmingKind, setTelemetryConfirmingKind] = useState<'logs' | 'metrics' | null>(null)
  const [telemetryBusyKind, setTelemetryBusyKind] = useState<'logs' | 'metrics' | null>(null)
  const [telemetryDoneKind, setTelemetryDoneKind] = useState<'logs' | 'metrics' | null>(null)

  const refreshTelemetry = useCallback(async () => {
    setTelemetryLoading(true); setTelemetryError('')
    try {
      const auth = await window.electronAPI.cloud.loadKey()
      if (!auth || !auth.token || !auth.secret) {
        setTelemetryVariants(null); setTelemetryActions(null)
        return
      }
      const r = await window.electronAPI.apprunDedicated.telemetryStatus(auth)
      if (r.ok) { setTelemetryVariants(r.variants); setTelemetryActions(r.actions) } else {
        setTelemetryVariants(null); setTelemetryActions(null)
        setTelemetryError(r.message ? `${r.message}${r.detail ? `（${r.detail}）` : ''}` : '状態を確認できませんでした')
      }
    } catch (e: any) {
      setTelemetryVariants(null); setTelemetryActions(null)
      setTelemetryError(e?.message ?? String(e))
    } finally {
      setTelemetryLoading(false)
    }
  }, [])

  // consented は**必ず呼び出し側が明示的に渡す**（TelemetryNotice.tsx と同じ約束）。
  // 「置き場が既にある（route）」ボタンは追加費用が無いので false、「用意する（費用に同意）」
  // ボタン（同意カードの中）だけが true を渡す。
  const enableTelemetryKind = async (kind: 'logs' | 'metrics', consented: boolean) => {
    setTelemetryBusyKind(kind); setTelemetryError('')
    try {
      const auth = await window.electronAPI.cloud.loadKey()
      if (!auth || !auth.token || !auth.secret) {
        setTelemetryError('さくらのクラウドAPIキーが未登録です。①で登録してください。')
        return
      }
      const r = await window.electronAPI.apprunDedicated.enableTelemetry(auth, kind, { consented })
      if (!r.ok) {
        if ('needsConsent' in r && r.needsConsent) {
          // 保存場所が消えていた等で、あらためて同意が要ると main 側に判断された。
          // 状態を取り直してから同意カードへ戻す（TelemetryNotice.tsx の直しと同じ理由）。
          setTelemetryConfirmingKind(kind)
          await refreshTelemetry()
          return
        }
        setTelemetryError(r.message ? `${r.message}${r.detail ? `（${r.detail}）` : ''}` : '設定できませんでした')
        return
      }
      setTelemetryConfirmingKind(null)
      setTelemetryDoneKind(kind)
      await refreshTelemetry()
    } finally {
      setTelemetryBusyKind(null)
    }
  }

  // ── 初期化 ──────────────────────────────────────────────────
  useEffect(() => {
    refreshKey(); refreshCloudKeys(); refreshApprunState(); refreshTelemetry()
    ;(async () => {
      const m = await readMeta()
      const v = m.publish?.apprunDedicated
      setResourceId(typeof v?.servicePrincipalId === 'string' ? v.servicePrincipalId : '')
      setConsentedAt(typeof v?.consentedAt === 'string' ? v.consentedAt : null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  useEffect(() => {
    // キーが（他画面の「認証情報」経由で）切り替わったら、前のキーで確かめた疎通結果を無効にする。
    // ここで conn/connMsg をリセットしないと、①の表示は「使用中のキー」だけ新しくなり、
    // その真下に前のキーで得た「✅ 通じました」が残ったままになる（常時課金サービスへの嘘の緑チェック）。
    const h = () => {
      // 2026-09-10 レビューの修理・I: この通知はキーが切り替わった合図そのもの（selectKey が
      // activateCloudKey 経由で発火させる分も、他画面「認証情報」からの分もここを通る）。
      // 世代を進め、切替前に投げていた testConnection/investigate の応答が遅れて戻っても
      // 上書きさせない。
      genRef.current++
      refreshKey(); refreshCloudKeys(); setConn('idle'); setConnMsg(''); setConnChecks(null)
      // ゾーン一覧（GET /zone）もキーに紐づく。zonesCache.ts 自身のキャッシュは
      // primeZonesCache() の購読が同じイベントで捨てるが、**この画面が持っている
      // zones state は別物**で、キーを切り替えても残ったままになる（2026-09-08 検分で
      // 指摘）。`GET /zone` の内容がキーで変わるかは確かめていないため、**捨てる側に
      // 倒す**（CLAUDE.md 掟10: 分からないものは安全側に倒す）。
      setZones(null); setZonesError(null)
      loadZones().then(r => { if (r.ok) setZones(r.rows) })
      // ⑦ ログ・メトリクスもキーに紐づく状態なので、切り替えたら取り直す
      // （前のキーで確かめた「繋がっています」を残さない）。
      setTelemetryConfirmingKind(null); setTelemetryDoneKind(null)
      refreshTelemetry()
    }
    window.addEventListener('sakura:credentials-changed', h)
    return () => window.removeEventListener('sakura:credentials-changed', h)
  }, [refreshKey, refreshCloudKeys, refreshTelemetry])

  const selectedKeyId = activeKeyId ?? cloudKeys[0]?.id ?? null
  const selectedKeyLabel = cloudKeys.find(k => k.id === selectedKeyId)?.label ?? '（未選択）'
  const keyReady = hasKey === true

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">📦 さくらのAppRun 専有型</p>
        <p className="text-xs text-ink-muted leading-relaxed">
          仮想サーバレベルで専有するAppRun。独自ドメインが使えますが、常時課金・4階層の構成が必要な上級者向けサービスです。
          <b className="text-ink">クラスタの作成・破棄までは行えます。</b>アプリケーションの公開（独自ドメインでの利用）はこのバージョンではまだできません。
        </p>
        <p className="text-[11px] text-ink-muted">
          <a href={OFFICIAL_PRICE_URL} className="hover:underline">🌐 公式サイトを見る ↗</a>
        </p>
      </div>

      {/* ① APIキー（入力は「認証情報」に一本化。ここは状態表示と接続テストのみ。共用型 AppRunPanel と同じ形） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">① APIキー</p>
          {hasKey === null
            ? <span className="text-xs text-ink-muted">確認中…</span>
            : keyReady
              ? <span className="text-xs text-brand-green font-semibold">✅ APIキー登録済み</span>
              : <span className="text-xs text-brand-yellow font-semibold">⚠️ APIキーが未登録です</span>}
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          さくらのクラウドのAPIキー（アクセストークン／トークンシークレット）は「認証情報」で登録・切替します。AppRun 専有型に専用のAPIキーはなく、このキーで操作します。
        </p>
        {cloudKeys.length > 0 ? (
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-ink-secondary">この操作に使うキー</label>
            <select
              value={selectedKeyId ?? ''}
              onChange={e => selectKey(e.target.value)}
              className="w-full bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink outline-none focus:border-sakura"
            >
              {cloudKeys.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <p className="text-[11px] text-ink-secondary">使用中のキー: <span className="font-medium text-ink">{selectedKeyLabel}</span></p>
          </div>
        ) : (
          <p className="text-[11px] text-brand-yellow leading-relaxed">
            まだクラウドのキーが登録されていません。「認証情報」でアクセストークン／シークレットを登録してください。
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenCredentials}
            className="bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura"
          >🔑 認証情報で登録・切替</button>
          <button
            onClick={testConnection}
            disabled={conn === 'testing' || !keyReady}
            title={keyReady ? '' : '先に認証情報でAPIキーを登録してください'}
            className="bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40"
          >🔌 接続テスト</button>
          {/* 事故の直し（2026-09-09検分・指摘2）: 「通じた」と「すべて確認できた」は別の事実。
              ③「🔍 調べる」は conn だけを書き、checks（チェックリストの内訳）は null に戻す
              （投げ直すたびに一旦クリアする、上の investigate() 参照）。ここは conn 単体ではなく
              connChecks の有無も見て文言を変える——確認していないことを「確認できた」と言わない。 */}
          <span className="flex-1 text-xs text-right">
            {conn === 'ok' && (connChecks
              ? <span className="text-brand-green font-semibold">✅ すべて確認できました</span>
              : <span className="text-brand-green font-semibold">✅ 通じました</span>)}
            {/* Q（2026-09-10 レビューの修理・バッチ3）: 全項目が失敗しているのに「一部の…」は
                言い過ぎ。api/billing の両方が失敗していれば「すべての項目で」と正しく言う。 */}
            {conn === 'ng' && (connChecks
              ? <span className="text-brand-yellow font-semibold">
                  {!connChecks.api.ok && !connChecks.billing.ok
                    ? '⚠️ すべての項目で確認できませんでした'
                    : '⚠️ 一部の権限が確認できませんでした'}
                </span>
              : <span className="text-brand-yellow font-semibold">⚠️ 通じませんでした</span>)}
            {conn === 'testing' && <span className="text-ink-secondary">確認中…</span>}
          </span>
        </div>
        {!keyReady && (
          <p className="text-[11px] text-ink-muted leading-relaxed">
            先に認証情報でAPIキーを登録してください。
          </p>
        )}
        {/* 🔌 接続テストの内訳。共用型 AppRunPanel と同じ ConnectionChecklist を使う
            （同じ形に揃える・roadmap #35・掟10）。レジストリはまだ専有型からのアプリ公開に
            対応していないため、今日の時点では確認しない（注記で案内する）。 */}
        {connChecks && (
          <ConnectionChecklist
            items={[
              { key: 'api', label: '専有型API 参照（制限・プラン）', ok: connChecks.api.ok, message: connChecks.api.message },
              { key: 'billing', label: '請求（コスト）参照', ok: connChecks.billing.ok, message: connChecks.billing.message },
            ]}
            note="※ レジストリの権限は、アプリの公開に対応したときに確認します。"
          />
        )}
        {/* 疎通の結果: 🔌 接続テスト（このセクション）または③「🔍 調べる」のどちらの結果でも、
            この1つの conn/connMsg に反映される（事故の直し1: 同じ意味の状態を2つ持たない）。
            ③の4本は内訳（connChecks）を持たないので、その場合はここで簡潔に伝える。 */}
        {!connChecks && conn === 'ok' && (
          <p className="text-[11px] text-brand-green font-semibold leading-relaxed">✅ このキーで専有型APIに通じました</p>
        )}
        {!connChecks && conn === 'ng' && (
          <>
            <p className="text-[11px] text-brand-yellow font-semibold leading-relaxed">
              ⚠️ このキーでは専有型APIに通じませんでした。
            </p>
            <ErrorBlock msg={connMsg} />
          </>
        )}
      </section>

      {/* ② サービスプリンシパルの用意（最初の一度だけ・手作業） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">② サービスプリンシパルの用意（最初の一度だけ手作業）</p>
        <p className="text-xs text-ink-secondary leading-relaxed">
          専有型のクラスタを作るには「サービスプリンシパル」が要りますが、<b className="text-ink">これは Koto からは作れません</b>。
          作成に使う IAM API は、通常のAPIキーでは使えない設計のためです（実測で権限エラー）。
          サービスプリンシパルはプロジェクトの資源として使い回せるので、この手作業は最初の一度だけで済みます。
        </p>
        <a
          href={CONTROL_PANEL_URL}
          className="inline-block bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura"
        >🔧 コントロールパネルを開く</a>

        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-ink-secondary">手順A: サービスプリンシパルを作る</p>
          <ol className="list-decimal pl-4 space-y-1 text-xs text-ink-secondary leading-relaxed">
            <li>コントロールパネルの左メニュー「サービスプリンシパル」を開く</li>
            <li>「サービスプリンシパルの作成」→ 名前と説明を入れて作成</li>
            <li>作成後に表示される「リソースID」を控える（これを下に貼る）</li>
          </ol>
        </div>

        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-ink-secondary">手順B: そのサービスプリンシパルにロールを付ける</p>
          {/* 2026-09-07 Ryosuke さん指摘で削った2行:
              「リソース階層名」「リソース階層タイプ」を"確かめる"手順を入れていたが、
              この2つは**入力欄ではなく、選んだプロジェクトが表示されるだけの読み取り専用**。
              操作できないものを手順に立てるのは、ただの水増しだった。
              検分が「4欄すべてを名指ししていない」と指摘したのを、
              **その欄が操作できるものかを確かめずに**受け入れたのが原因。
              入力するのは「プリンシパル」と「ロール」の2つだけ。 */}
          <ol start={4} className="list-decimal pl-4 space-y-1 text-xs text-ink-secondary leading-relaxed">
            <li>左メニュー「IAMポリシー」を開き、画面右上で対象のプロジェクトを選ぶ</li>
            <li>右上の「アクセス権の付与」を押す</li>
            <li>「プリンシパル」欄で、手順Aで作ったサービスプリンシパルを選ぶ</li>
            <li>「ロール」欄で「{ROLE_TEXT}」を選ぶ</li>
            <li>「作成」を押す（反映まで最大3分）</li>
          </ol>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            ※「リソース階層名」「リソース階層タイプ」は、選んだプロジェクトが表示されるだけの欄です（ここでは変更しません）。
            組織やフォルダ単位でも付けられますが、<b className="text-ink-secondary">サービスプリンシパルにはプロジェクト単位で付けるのが確実</b>です
            （上位で付けた権限は、サービスプリンシパルの制約で効かないことがあると公式に明記されています）。
          </p>
        </div>

        <div className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-1">
          <p className="text-[11px] font-semibold text-brand-yellow leading-relaxed">
            ⚠️ プリンシパル欄に「ロール名」を入れないでください。
          </p>
          <p className="text-[11px] text-ink-secondary leading-relaxed">
            プリンシパル欄で選ぶのは、手順Aで作った<b className="text-ink">サービスプリンシパル</b>です。
            「{ROLE_TEXT}」は<b className="text-ink">ロールの名前</b>で、<b className="text-ink">ロール欄</b>で選びます。
          </p>
        </div>

        <div className="space-y-1">
          <p className="text-[11px] font-medium text-ink-secondary">ロール欄で選ぶもの</p>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-overlay px-3 py-2">
            <code className="flex-1 text-xs text-ink font-mono select-text">{ROLE_TEXT}</code>
            <CopyButton text={ROLE_TEXT} title="ロール名をコピー（プリンシパル欄ではなくロール欄で使います）" />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-medium text-ink-secondary">リソースID</label>
          <input
            value={resourceId}
            onChange={e => setResourceId(e.target.value)}
            onBlur={() => saveResourceId(resourceId.trim())}
            placeholder="例: 113800956789"
            className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
          />
          {idFormat === true && <p className="text-[11px] text-brand-green font-semibold">✓ 形は合っています（12文字）</p>}
          {idFormat === false && <p className="text-[11px] text-brand-yellow font-semibold">⚠️ 違うようです（12文字ではありません）</p>}
          <p className="text-[11px] text-ink-muted leading-relaxed">
            ※ 確認できるのは文字数の形式だけです。実在するかどうかはここでは確認できません（IAM APIが使えないため）。実際にクラスタを作る段になって初めて分かります。
          </p>
        </div>
      </section>

      {/* ③ 使えるプランと制限（API から取得） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">③ 使えるプランと制限</p>
          <button
            onClick={investigate}
            disabled={checking}
            className="flex-none bg-sakura text-white rounded-md px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
          >{checking ? '調べています…' : '🔍 調べる'}</button>
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">制限・プラン・既存クラスタの件数をAPIから取得します（何も作らず、何も変更しません）。</p>

        {checkError && (
          <p className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed break-all select-text">{checkError}</p>
        )}

        {(limits || limitsError) && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">制限値</p>
            {limitsError ? (
              <ErrorBlock msg={`取得できませんでした: ${limitsError}`} />
            ) : (
              <div className="rounded-lg border border-line bg-overlay px-3 py-2 space-y-1">
                {LIMIT_FIELDS.map(f => (
                  <div key={f.key} className="flex items-center justify-between text-xs">
                    <span className="text-ink-secondary">{f.label}</span>
                    <span className="text-ink font-medium">{limits && limits[f.key] != null ? limits[f.key] : '取得できませんでした'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(workerPlans || workerError) && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">ワーカプラン</p>
            {workerError ? <ErrorBlock msg={`取得できませんでした: ${workerError}`} /> : (
              <ul className="text-xs text-ink-secondary space-y-0.5 pl-1">
                {(workerPlans ?? []).length === 0 && <li>（プランがありませんでした）</li>}
                {(workerPlans ?? []).map((p, i) => (
                  <li key={i}>・{p.name ?? '（名前を取得できませんでした）'}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(lbPlans || lbError) && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">ロードバランサプラン</p>
            {lbError ? <ErrorBlock msg={`取得できませんでした: ${lbError}`} /> : (
              <ul className="text-xs text-ink-secondary space-y-0.5 pl-1">
                {(lbPlans ?? []).length === 0 && <li>（プランがありませんでした）</li>}
                {/* APIの name をそのまま出す。nodeCount 由来の「（冗長）」等は付け足さない（roadmap #27） */}
                {(lbPlans ?? []).map((p, i) => (
                  <li key={i}>・{p.name ?? '（名前を取得できませんでした）'}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(clusterInfo || clusterError) && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">既存クラスタ</p>
            {clusterError ? <ErrorBlock msg={`取得できませんでした: ${clusterError}`} /> : (
              <p className="text-xs text-ink-secondary">
                {clusterInfo!.count}件{clusterInfo!.hasMore ? '以上（正確な数は未確認）' : ''}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ④ 費用の確認と同意 */}
      <section className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">④ 費用の確認と同意</p>
        <p className="text-xs font-semibold text-brand-red leading-relaxed">
          ⚠️ 専有型は常時課金です（動いていなくても請求されます）。共用型（さくらのAppRun）は使った分だけの従量課金ですが、専有型は日額・月額の固定費です。
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-ink-secondary border-collapse">
            <thead>
              <tr className="border-b border-line text-ink-muted">
                <th className="text-left py-1 pr-2 font-medium">ワーカプラン</th>
                <th className="text-right py-1 px-2 font-medium">時間</th>
                <th className="text-right py-1 px-2 font-medium">日</th>
                <th className="text-right py-1 pl-2 font-medium">月</th>
              </tr>
            </thead>
            <tbody>
              {WORKER_PRICES.map(row => (
                <tr key={row.plan} className="border-b border-line-soft last:border-0">
                  <td className="py-1 pr-2 text-ink">{row.plan}</td>
                  <td className="py-1 px-2 text-right">{row.hourly}</td>
                  <td className="py-1 px-2 text-right">{row.daily}</td>
                  <td className="py-1 pl-2 text-right font-medium text-ink">{row.monthly}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          ロードバランサも同じ料金表が使われます（1コア/2GB・2コア/2GBの2プランのみ提供）。
          税込・2026-09時点の<a href={OFFICIAL_PRICE_URL} className="text-sakura hover:underline">公式ページ</a>の値です。価格は変わることがあります。最新は公式ページでご確認ください。
        </p>
        <p className="text-xs font-semibold text-ink leading-relaxed">
          最小構成（ワーカ 1コア/2GB + ロードバランサ 1コア/2GB相当）でも、月額 11,000円 + 11,000円 = <span className="text-brand-red">22,000円</span> で、2万円を超えます。
        </p>

        {consentedAt ? (
          <div className="rounded-lg border border-brand-green/60 bg-overlay p-3 flex items-center justify-between gap-2">
            <p className="text-xs text-brand-green font-semibold">✅ 同意済み（{new Date(consentedAt).toLocaleString('ja-JP')}）</p>
            <button
              onClick={revokeConsent}
              disabled={consentBusy}
              className="flex-none text-[11px] text-ink-muted hover:text-brand-red disabled:opacity-40"
            >同意を取り消す</button>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-xs text-ink-secondary leading-relaxed">
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} className="mt-0.5" />
              費用が発生することを理解しました
            </label>
            <button
              onClick={giveConsent}
              disabled={!agree || consentBusy}
              className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
            >{consentBusy ? '記録しています…' : '同意して次へ進む'}</button>
          </div>
        )}
      </section>

      {/* ⑤ クラスタを作る */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">⑤ クラスタを作る</p>

        {!consentedAt ? (
          <p className="text-xs text-ink-secondary leading-relaxed">
            ④で費用に同意すると、ここから作成できるようになります。
          </p>
        ) : hasAnyResource ? (
          // 2026-09-10 レビューの修理・B: 記録に既に何かある状態で⑤から新規作成させない
          // （先に作ったクラスタが記録から上書きされて消える事故を防ぐ。main側 createClusterFlow
          // の stage:'existing' と対になる画面側の入口）。
          <p className="text-xs text-ink-secondary leading-relaxed">
            作られたものの記録があります。作り直すには、まず⑥で破棄してください。
          </p>
        ) : (
          <>
            <p className="text-[11px] text-ink-muted leading-relaxed rounded-lg border border-line bg-overlay px-3 py-2">
              🔌 ネットワークは共有セグメントに繋ぎます（スイッチやIPプールの指定は要りません）。
            </p>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">クラスタ名（1〜20文字・英数字と _ -）</label>
              <input
                value={clusterName}
                onChange={e => setClusterName(e.target.value)}
                placeholder="例: myapp"
                className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">公開ポート</label>
              <div className="space-y-1">
                {ports.map((p, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="number"
                      value={p.port}
                      onChange={e => updatePort(i, { ...p, port: Number(e.target.value) })}
                      className="w-24 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                    />
                    <select
                      value={p.protocol}
                      onChange={e => updatePort(i, { ...p, protocol: e.target.value as 'http' | 'https' })}
                      className="bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                    >
                      <option value="http">http</option>
                      <option value="https">https</option>
                    </select>
                    {isReservedPort(p.port) && (
                      <span className="text-[11px] text-brand-red">⚠️ {RESERVED_PORT_RANGE[0]}-{RESERVED_PORT_RANGE[1]}は予約で使えません</span>
                    )}
                    <button onClick={() => removePort(i)} className="text-[11px] text-ink-muted hover:text-brand-red">削除</button>
                  </div>
                ))}
              </div>
              <button onClick={addPort} className="text-[11px] text-sakura hover:underline">+ ポートを追加</button>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">サービスプリンシパルID</label>
              <p className="text-xs text-ink font-mono select-text">{resourceId || '（②で入力してください）'}</p>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">ゾーン</label>
              {zoneSelectable ? (
                <select
                  value={selectedZoneName ?? ''}
                  onChange={e => setSelectedZoneName(e.target.value)}
                  className="w-full bg-elevated border border-line rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                >
                  {!selectedZoneName && <option value="">（選んでください）</option>}
                  {zoneRows.map(z => (
                    <option key={z.name} value={z.name}>{z.name}{z.description ? ` — ${z.description}` : ''}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={zone}
                  onChange={e => setZone(e.target.value)}
                  placeholder="例: tk1b"
                  className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
                />
              )}
              {/* 事故の直し2: zones===null（未実施）／取得失敗／取得できたが0件、の3つを
                  はっきり区別する。③を押した後なのに「押すと選べます」という嘘を出さない。 */}
              {zones === null && !zonesError ? (
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  自由入力です。③の「🔍 調べる」を押すと一覧から選べるようになります。
                </p>
              ) : zonesError ? (
                <p className="text-[11px] text-brand-yellow leading-relaxed">
                  ゾーン一覧を取得できませんでした。手で入力してください。
                </p>
              ) : zoneSelectable ? (
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  さくらのクラウドのゾーン一覧から選びます。専有型がすべてのゾーンに対応しているかは未確認なので、
                  作成に失敗したら別のゾーンをお試しください（失敗しても、その時点では何も作られません）。
                </p>
              ) : (
                <p className="text-[11px] text-brand-yellow leading-relaxed">
                  一覧は取得できましたが、選べるゾーンがありませんでした。手で入力してください。
                </p>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">ワーカプラン</label>
              {workerPlans && workerPlans.some(p => p.path) ? (
                <>
                  <select
                    value={selectedWorkerPath ?? ''}
                    onChange={e => setSelectedWorkerPath(e.target.value)}
                    className="w-full bg-elevated border border-line rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                  >
                    {!selectedWorkerPath && <option value="">（選んでください）</option>}
                    {workerPlans.filter(p => p.path).map(p => (
                      <option key={p.path as string} value={p.path as string}>{p.name ?? p.path}</option>
                    ))}
                  </select>
                  {!selectedWorkerPath && (
                    <p className="text-[11px] text-brand-yellow leading-relaxed">
                      ⚠️ プランを選んでください（既定は選んでいません。料金表に無いプランのため自動では選べませんでした）
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[11px] text-brand-yellow">③の「🔍 調べる」を押してプランを取得してください。</p>
              )}
              <div className="flex items-center gap-2 pt-1">
                <label className="text-[11px] text-ink-secondary">ノード数 min</label>
                <input
                  type="number" min={1} max={10} value={minNodes}
                  onChange={e => setMinNodes(Number(e.target.value))}
                  className="w-16 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                />
                <label className="text-[11px] text-ink-secondary">max</label>
                <input
                  type="number" min={1} max={10} value={maxNodes}
                  onChange={e => setMaxNodes(Number(e.target.value))}
                  className="w-16 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">ロードバランサプラン</label>
              {lbPlans && lbPlans.some(p => p.path) ? (
                <>
                  <select
                    value={selectedLbPath ?? ''}
                    onChange={e => setSelectedLbPath(e.target.value)}
                    className="w-full bg-elevated border border-line rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                  >
                    {!selectedLbPath && <option value="">（選んでください）</option>}
                    {/* APIの name をそのまま出す。nodeCount 由来の「（冗長）」等は付け足さない（roadmap #27・API側が既に含む） */}
                    {lbPlans.filter(p => p.path).map(p => (
                      <option key={p.path as string} value={p.path as string}>{p.name ?? p.path}</option>
                    ))}
                  </select>
                  {!selectedLbPath && (
                    <p className="text-[11px] text-brand-yellow leading-relaxed">
                      ⚠️ プランを選んでください（既定は選んでいません。料金表に無いプランのため自動では選べませんでした）
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[11px] text-brand-yellow">③の「🔍 調べる」を押してプランを取得してください。</p>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">Let&apos;s Encrypt 用メール（独自ドメインを使うなら）</label>
              <input
                value={letsEncryptEmail}
                onChange={e => setLetsEncryptEmail(e.target.value)}
                placeholder="任意"
                className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sakura"
              />
            </div>

            {/* 簡易構成図（いま選んでいる内容がそのまま反映される・自前の枠と文字のみ）。
                月額はここで計算し直さない——priceSummary の text をそのまま使う（掟10）。 */}
            <div className="rounded-lg border border-line bg-overlay p-3 space-y-0.5">
              <p className="font-mono text-[11px] leading-relaxed text-ink select-text whitespace-pre-wrap">{diagram.lines.join('\n')}</p>
              <p className="text-xs font-semibold text-ink select-text pt-1.5 mt-1 border-t border-line-soft">{diagram.total}</p>
            </div>

            {formError && <p className="text-xs text-brand-yellow leading-relaxed">⚠️ {formError}</p>}

            <button
              onClick={doCreate}
              disabled={!!formError || creating}
              className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
            >{creating ? 'クラスタ→ASG→LB の順で作成しています…' : 'クラスタを作成する'}</button>

            {shouldShowCreateResult(createResult, apprunState) && createResult && (
              <div className="space-y-1">
                <p className={createResult.ok ? 'text-xs font-semibold text-brand-green' : 'text-xs font-semibold text-brand-red'}>
                  {createResult.ok ? '✅ 作成できました' : `⚠️ 途中で止まりました（${STAGE_LABEL[createResult.stage as CreateClusterFlowStage] ?? createResult.stage}）`}
                </p>
                <ul className="text-xs text-ink-secondary space-y-0.5 pl-1">
                  <li>{createResult.clusterID ? '✅' : '・'} クラスタ {resourceIdLabel(createResult.clusterID, 'clusterID', createResult.stage as CreateClusterFlowStage)}</li>
                  <li>{createResult.asgID ? '✅' : '・'} オートスケーリンググループ {resourceIdLabel(createResult.asgID, 'asgID', createResult.stage as CreateClusterFlowStage)}</li>
                  <li>{createResult.loadBalancerID ? '✅' : '・'} ロードバランサ {resourceIdLabel(createResult.loadBalancerID, 'loadBalancerID', createResult.stage as CreateClusterFlowStage)}</li>
                </ul>
                <ErrorBlock msg={createResult.message} />
                {!createResult.ok && (createResult.clusterID || createResult.asgID || createResult.loadBalancerID) && (
                  <p className="text-xs text-brand-red leading-relaxed">
                    ここまで作られています。課金が続くので、⑥から破棄してください。
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ⑥ 作ったものを壊す（破棄）。
          B-2（2026-09-10実機・Ryosuke さん指摘）: 破棄が完了して記録（apprunState）が空になっても、
          結果（「✅ すべて削除しました」）は消さない——節のガードを hasAnyResource だけに
          頼らず、shouldShowTeardownResult（apprunDedicatedActions.ts・掟10）も見る。 */}
      {(hasAnyResource || shouldShowTeardownResult(teardownResult)) && (
        <section className="rounded-xl border border-brand-red/70 bg-surface p-4 space-y-3">
          <p className="text-sm font-semibold text-ink">⑥ 作ったものを壊す（破棄）</p>

          {hasAnyResource && (
            <>
              <p className="text-xs font-semibold text-brand-red leading-relaxed">
                ⚠️ 消さない限り課金が続きます。この操作は元に戻せません。
              </p>
              {/* 3b: いまの構成と月額目安（利用者目線レビュー・判断不要）。計算は複製せず
                  priceSummary の結果をそのまま使う（buildTeardownSummary・掟10）。 */}
              <div className="rounded-lg border border-line bg-overlay p-3 space-y-0.5">
                <p className="text-[11px] font-semibold text-ink-secondary">いまの構成と月額目安</p>
                {buildTeardownSummary(apprunState, { worker: workerPlans, lb: lbPlans }).lines.map((line, i) => (
                  <p key={i} className="text-xs text-ink-secondary select-text">{line}</p>
                ))}
              </div>
              <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
                {apprunState?.loadBalancerID && <li>ロードバランサ『{apprunState.loadBalancerID}』</li>}
                {apprunState?.asgID && <li>オートスケーリンググループ『{apprunState.asgID}』</li>}
                {apprunState?.clusterID && <li>クラスタ『{apprunState.clusterID}』</li>}
              </ul>
              <button
                onClick={doTeardown}
                disabled={tearingDown}
                className="bg-brand-red-fill text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >{tearingDown ? '削除しています…' : 'すべて削除する'}</button>
              {/* #39: 各段が一覧から消えるまで待つ間の進捗（30秒ごとに1回、teardown-progress で届く）。 */}
              {tearingDown && teardownProgress && (
                <p className="text-xs text-ink-secondary leading-relaxed">{teardownProgress}</p>
              )}
            </>
          )}

          {shouldShowTeardownResult(teardownResult) && teardownResult && (
            <div className="space-y-1">
              <p className={teardownResult.ok ? 'text-xs font-semibold text-brand-green' : teardownResult.inProgress ? 'text-xs font-semibold text-brand-yellow' : 'text-xs font-semibold text-brand-red'}>
                {teardownResult.ok ? '✅ すべて削除しました' : teardownResult.inProgress ? '⏳ 削除中です' : '⚠️ 削除できませんでした'}
              </p>
              {teardownResult.executed.map((e, i) => (
                <p key={i} className="text-xs text-brand-green leading-relaxed">✅ {e}</p>
              ))}
              <ErrorBlock msg={teardownResult.message} />
              {teardownResult.inProgress ? (
                // #39: 待ち切れず(timeout)止まっただけ。記録は残っている＝⑥をもう一度押せば再開できる
                // （赤い「残っています＝課金が続きます」＝失敗、とは区別する黄色い注意）。
                <div className="space-y-1 rounded-lg border border-brand-yellow/70 bg-overlay p-3">
                  <p className="text-xs font-semibold text-brand-yellow leading-relaxed">
                    削除中です。しばらくして⑥をもう一度押してください。
                  </p>
                  <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
                    {teardownResult.inProgress.loadBalancerID && <li>ロードバランサ『{teardownResult.inProgress.loadBalancerID}』</li>}
                    {teardownResult.inProgress.asgID && <li>オートスケーリンググループ『{teardownResult.inProgress.asgID}』</li>}
                    {teardownResult.inProgress.clusterID && <li>クラスタ『{teardownResult.inProgress.clusterID}』</li>}
                  </ul>
                </div>
              ) : !teardownResult.ok && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-brand-red leading-relaxed">
                    残っています＝課金が続きます。コントロールパネルから直接削除することもできます。
                  </p>
                  <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
                    {teardownResult.remaining.loadBalancerID && <li>ロードバランサ『{teardownResult.remaining.loadBalancerID}』</li>}
                    {teardownResult.remaining.asgID && <li>オートスケーリンググループ『{teardownResult.remaining.asgID}』</li>}
                    {teardownResult.remaining.clusterID && <li>クラスタ『{teardownResult.remaining.clusterID}』</li>}
                  </ul>
                  <a href={CONTROL_PANEL_URL} className="inline-block text-[11px] text-sakura hover:underline">🔧 コントロールパネルを開く</a>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ⑦ ログ・メトリクス（#38・roadmap #38。プロジェクト単位のログ・メトリクス。共用型
          TelemetryNotice と同じ見せ方・同じ文言の作法。クラスタの記録が無くても表示してよい
          （プロジェクト単位のため）。専有型は⑦まで（共用型「⑧ ログ・メトリクス」とは番号が
          違うが構わない）。 */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">⑦ ログ・メトリクス</p>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          この設定はクラスタごとではなく、このプロジェクトの専有型全体に効きます（コントロールパネルの『ログ・メトリクス設定』と同じものです）。
        </p>
        {!keyReady ? (
          <p className="text-[11px] text-brand-yellow leading-relaxed">①で登録してください。</p>
        ) : telemetryLoading ? (
          <p className="text-xs text-ink-secondary">確認しています…</p>
        ) : !telemetryVariants || !telemetryActions ? (
          <ErrorBlock msg={telemetryError || '状態を確認できませんでした。'} />
        ) : (
          <>
            <ul className="text-xs text-ink-secondary space-y-0.5 pl-1">
              {telemetryVariants.map(v => (
                <li key={v.variant}>{v.routed ? '✅ ' : '・'}{v.label}{v.routed ? ' 繋がっています' : ' 未接続'}</li>
              ))}
            </ul>
            {(['logs', 'metrics'] as const).map(kind => {
              const action = telemetryActions[kind]
              if (!action || action.kind === 'none') return null
              const label = kind === 'logs' ? 'ログ' : 'メトリクス'
              return (
                <div key={kind} className="rounded-lg border border-line p-3 space-y-2">
                  {action.kind === 'route' && (
                    <>
                      <p className="text-xs text-ink leading-relaxed">
                        {kind === 'logs' ? '📋' : '📈'} {label}の保存場所はすでにあります。このプロジェクトの{label}をつなげます（追加費用はありません）。
                      </p>
                      <button
                        onClick={() => enableTelemetryKind(kind, false)}
                        disabled={telemetryBusyKind === kind}
                        className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-40"
                      >{telemetryBusyKind === kind ? 'つないでいます…' : `${label}をつなぐ`}</button>
                    </>
                  )}
                  {action.kind === 'ask' && (
                    telemetryConfirmingKind === kind ? (
                      <div className="rounded-lg border border-brand-yellow/70 p-3 space-y-2">
                        <p className="text-xs text-ink leading-relaxed">
                          {label}の保存場所（さくらのモニタリングスイート）を新しく用意します。
                          <span className="font-semibold">月額の基本料金（日割りなし）</span>がかかります。
                          金額はさくらのクラウドのコントロールパネルでご確認ください。
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => enableTelemetryKind(kind, true)}
                            disabled={telemetryBusyKind === kind}
                            className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
                          >{telemetryBusyKind === kind ? '用意しています…' : '用意する（費用に同意）'}</button>
                          <button
                            onClick={() => setTelemetryConfirmingKind(null)}
                            disabled={telemetryBusyKind === kind}
                            className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura disabled:opacity-40"
                          >やめる</button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setTelemetryError(''); setTelemetryConfirmingKind(kind) }}
                        className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura"
                      >{kind === 'logs' ? 'ログをつなぐ' : 'メトリクスをつなぐ'}</button>
                    )
                  )}
                  {telemetryDoneKind === kind && <p className="text-[11px] text-ink-secondary leading-relaxed">✅ つながりました。</p>}
                </div>
              )
            })}
            {telemetryError && <ErrorBlock msg={telemetryError} />}
          </>
        )}
      </section>
    </div>
  )
}

// 失敗メッセージの表示ブロック（掟5: select-text＋コピーボタン）。VpsPanel/AppRunPanel と同種。
function ErrorBlock({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-1">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">{msg}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(msg).catch(() => {}) }}
          className="flex-none text-[11px] text-sakura hover:underline"
          title="メッセージをコピー"
        >コピー</button>
      </div>
    </div>
  )
}
