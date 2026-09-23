import { useState, useEffect, useCallback, useRef } from 'react'
import { listCloudKeys, getActiveCloudKeyId, activateCloudKey, CloudKeyInfo } from './CredentialsModal'
import CopyButton from './CopyButton'
import { withApprunDedicatedRecord } from '../../shared/publishMeta'
import { clearPublishRecord } from '../publishRecord'
import { readLimits, readWorkerClasses, readLbClasses, readClusters, readNextCursor, type ApprunDedicatedPlanRow, type ZoneRow } from '../../shared/apprunDedicatedShapes'
import { loadZones } from '../zonesCache'
import { runCreate, runTeardown, shouldShowCreateResult, shouldShowTeardownResult } from '../apprunDedicatedActions'
// D-4（2026-09-15）: ⑧「アプリを公開する」の歯止め（runPublishApp）と表示判定（shouldShowPublishSection）。
// 上の import 行は tests/apprunDedicatedWiring.test.ts が文字列で固定しているため、別行で足す。
import { runPublishApp, shouldShowPublishSection } from '../apprunDedicatedActions'
// H-1（2026-09-17）: ⑤⑥⑦⑧ を同時に走らせないための判定（純関数）。上の import 行は
// tests/apprunDedicatedWiring.test.ts が文字列で固定しているため、別行で足す。
import { panelBusy, panelBusyReason } from '../apprunDedicatedActions'
import { publishButtonLabel, publishFailureHintText, dnsGuidanceLines } from '../../shared/publishLabels'
// D-7（2026-09-16 実機）: ⑧の公開結果の見出しは「公開したあと、アプリが本当に応答したか」で変える。
// 判断は純関数 publishHeadline（上と同じ shared/publishLabels.ts）。文言は dedicatedVerifyMessage
// （shared/publishVerify.ts）。**画面は描くだけ**（掟10）。上の import 行は wiring テストが文字列で
// 固定しているため、別行で足す。
import { publishHeadline } from '../../shared/publishLabels'
import { dedicatedVerifyMessage, dedicatedVerifyNotServing } from '../../shared/publishVerify'
// D-7b・C（検分の指摘・2026-09-16 実害「応答しないアプリのために DNS を設定しに行った」）:
// no-backend（503）のときは DNS の案内より先に応答を確かめてもらう。判断は純関数
// showDnsGuidanceExpanded（上と同じ shared/publishLabels.ts）。上の import 行は wiring テストが
// 文字列で固定しているため、別行で足す。
import { showDnsGuidanceExpanded } from '../../shared/publishLabels'
// D-8（2026-09-16 実機）: 応答していない（no-backend）ときは「いまのコンテナの様子」も出す。
// **状態の文字列は原本の値のまま**（勝手に日本語へ言い換えない）。⑧の説明には「像に書いたデータは
// 公開し直すと消える」の注意も出す。どちらも判断・文言は純関数（上と同じ shared/publishLabels.ts）に
// 置き、画面は描くだけ（掟10）。上の import 行は wiring テストが文字列で固定しているため、別行で足す。
import { containerStateSummary, ephemeralDataNote } from '../../shared/publishLabels'
import { APP_DEFAULTS, HOSTNAME_PATTERN } from '../../shared/apprunDedicatedApp'
// F-1（2026-09-16）: ⑧のメール欄の出し分け（letsEncryptEmailFieldState）と最低限の形式検査
// （isLikelyEmail）。上の import 行は tests/apprunDedicatedWiring.test.ts が文字列で固定して
// いるため、別行で足す。
import { letsEncryptEmailFieldState, isLikelyEmail } from '../../shared/apprunDedicatedApp'
// G-1（2026-09-16）: ⑤の待ち受けポートに、必ず要る80/http・443/httpsが揃っているかの判定
// （missingRequiredPorts）。上の import 行は tests/apprunDedicatedWiring.test.ts が文字列で
// 固定しているため、別行で足す。
import { missingRequiredPorts } from '../../shared/apprunDedicatedApp'
// F-1（2026-09-16）: ⑦「ログ・メトリクス」を1行に畳んでよいか（shouldCollapseTelemetrySection）。
import { shouldCollapseTelemetrySection } from '../../shared/appLog'
import { beginActivity, PUBLISH_CLOSE_WARNING } from '../activity'
import AccessKeySection from './AccessKeySection'
import { askAiAboutFailure } from '../../shared/askAi'
import { useConfirm } from '../useConfirm'

// さくらのAppRun 専有型パネル（roadmap #23）。
//
// **クラスタの作成（⑤）・破棄（⑥）は行える**（段階②④・v0.6.9 で実装済み）。
// **アプリの公開（⑧・独自ドメイン）も行える**（段階③⑤・D-4・2026-09-15。main の publishAppFlow＝
// src/main/cloud/apprunDedicatedAppApply.ts を IPC apprunDedicated:publishApp 経由で呼ぶ）。
// この画面がやるのは: ①認証情報の確認（疎通結果も表示） ②サービスプリンシパルの用意（手作業）の案内
// ③制限・プラン・費用をAPIから引いて見せる ④費用の同意を取る ⑤クラスタを作る ⑥作ったものを壊す
// ⑦ログ・メトリクス ⑧アプリを公開する（クラスタ・ASG・LB が揃っているときだけ出る）、の8つ。
// ⑧が⑦の後ろにある理由: ⑦はプロジェクト単位で記録が無くても常時出る節、⑧はクラスタが揃った
// ときだけ出る条件付きの節。⑦の見出しは wiring テスト・README・usage-guide が固定しており、
// 番号を付け直すと固定文字列と文書の参照が全部ずれるため、番号は付け直さない。
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

// ── ⑤フォームのエラー表示（判断7・利用者目線レビュー・2026-09-11）─────────────────
//
// 以前は formError という1本の文字列（早期returnの連鎖。最初に引っかかった条件だけを表示）
// だった。ワーカプラン・ロードバランサプランは欄のすぐ下にも同じ趣旨の警告を別に出しており、
// **同じ指摘が2か所に出る**うえ、**何も触っていない初期状態からいきなり赤字が出る**という
// 指摘を受けた。欄ごとに独立して判定し（1本の早期returnにしない）、「触ったか」「送信したか」
// で表示するかどうかを判断する（visibleFormErrors に一元化・掟10）。
export type DedicatedFormField = 'clusterName' | 'resourceId' | 'ports' | 'zone' | 'workerPlan' | 'lbPlan' | 'nodes'
export type DedicatedFormErrors = Partial<Record<DedicatedFormField, string>>
export type DedicatedFormTouched = Partial<Record<DedicatedFormField, boolean>>

/**
 * ⑤フォームの入力チェック（欄ごとに独立。1つの欄に複数の問題があれば、最初に見つかったものだけを返す）。
 * ワーカプラン／ロードバランサプランは、欄のすぐ下に既定選択なしの説明（「既定は選んでいません」）
 * が常時出ているため、ここでも算出はするが（doCreate を止める判定に使う）、下の全体表示側には
 * 出さない——同じ内容を2か所に出さないため（フィールド側の表示を優先する）。
 */
export function computeDedicatedFormErrors(input: {
  clusterName: string
  resourceId: string
  ports: { port: number; protocol: 'http' | 'https' }[]
  zone: string
  selectedWorkerPath: string | null
  selectedLbPath: string | null
  minNodes: number
  maxNodes: number
}): DedicatedFormErrors {
  const errors: DedicatedFormErrors = {}
  const name = input.clusterName.trim()
  if (!name) errors.clusterName = 'クラスタ名を入力してください'
  else if (!isValidResourceName(name)) errors.clusterName = 'クラスタ名は1〜20文字の英数字・_・- で入力してください'

  if (!input.resourceId.trim()) errors.resourceId = '②でサービスプリンシパルIDを入力してください'

  if (input.ports.length === 0) errors.ports = '公開ポートを1つ以上指定してください'
  else if (input.ports.some(p => !(p.port >= 1 && p.port <= 65535))) errors.ports = 'ポート番号は1〜65535で指定してください'
  else if (input.ports.some(p => isReservedPort(p.port))) errors.ports = `ポート ${RESERVED_PORT_RANGE[0]}-${RESERVED_PORT_RANGE[1]} は予約されており使えません`
  else {
    // G-1（2026-09-16）: ここだけは「警告」ではなく作成そのものを止める。専有型は必ず
    // Let's Encrypt を使う作り（apprunDedicatedApp.ts の buildVersionCreateBody）で、
    // 80/http が無ければ証明書は永久に出ず、443/https が無ければアプリを載せる先そのものが
    // 無い——どちらが欠けても**使えないクラスタ**なのに、月額およそ2万2千円の固定費だけが
    // かかり続ける。作らせてから気づかせるコストの方が、ここで止めるコストより高い。
    const missing = missingRequiredPorts(input.ports)
    if (missing.length === 2) {
      errors.ports = '公開ポートに「80（http）」と「443（https）」の両方が必要です。80は独自ドメインの証明書（https）を自動で受け取るために、443はアプリの受け口として使います。詳細設定で足してください。'
    } else if (missing.some(m => m.port === 80)) {
      errors.ports = '公開ポートに「80（http）」が必要です。独自ドメインの証明書（https）を自動で受け取るために使います。詳細設定で足してください。'
    } else if (missing.some(m => m.port === 443)) {
      errors.ports = '公開ポートに「443（https）」が必要です。アプリの受け口として使います。詳細設定で足してください。'
    }
  }

  if (!input.zone.trim()) errors.zone = 'ゾーンを入力してください'

  if (!input.selectedWorkerPath) errors.workerPlan = 'ワーカプランを選んでください（③で「調べる」を押していない場合は先に押してください）'
  if (!input.selectedLbPath) errors.lbPlan = 'ロードバランサプランを選んでください（③で「調べる」を押していない場合は先に押してください）'

  if (!(Number.isInteger(input.minNodes) && input.minNodes >= 1 && input.minNodes <= 10)) errors.nodes = 'ノード数（min）は1〜10で指定してください'
  else if (!(Number.isInteger(input.maxNodes) && input.maxNodes >= 1 && input.maxNodes <= 10)) errors.nodes = 'ノード数（max）は1〜10で指定してください'
  else if (input.minNodes > input.maxNodes) errors.nodes = 'ノード数は min ≦ max にしてください'

  return errors
}

/**
 * ⑤フォームの警告のうち、**いま画面に出してよいもの**だけを選ぶ（判断7・2026-09-11）。
 *
 * - 初期状態（touched が空・submitted===false）では何も返さない
 *   （未入力なのは当たり前で、開いた瞬間に赤字を並べても指摘にならない）。
 * - 触った欄があれば、**その欄の分だけ**返す（他の未入力欄はまだ黙っている）。
 * - 「作成する」を押した後（submitted）は、触っていない欄も含めて**全部**返す
 *   （ここで初めて「何が足りないか」を総ざらいする）。
 */
export function visibleFormErrors(
  errors: DedicatedFormErrors,
  touched: DedicatedFormTouched,
  submitted: boolean,
): DedicatedFormErrors {
  if (submitted) return errors
  const visible: DedicatedFormErrors = {}
  for (const key of Object.keys(errors) as DedicatedFormField[]) {
    if (touched[key]) visible[key] = errors[key]
  }
  return visible
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

/** 最安構成の月額が「出せる／まだ調べていない／料金表に無い」のどれか（D-13 K）。 */
export type CheapestMonthlyState =
  | { kind: 'known'; amountText: string }
  | { kind: 'not-fetched' }
  | { kind: 'not-in-table' }

/**
 * 最安構成（ワーカ1台＋ロードバランサ）の月額を、**3つの状態に分ける**純関数
 * （判断4・利用者目線レビュー・2026-09-11／D-13 K・2026-09-16）。
 *
 * 金額は**最安のワーカ1台＋ロードバランサ（非冗長なら1台）の合計を万円単位に切り下げて**
 * 示す。金額をハードコードしない（料金表の改定に追従しないため）——必ず
 * pickCheapestWorkerPlan / pickCheapestLbPlan と料金表（monthlyYenForPlanPath）から計算する。
 *
 * ── なぜ「文」ではなく「状態」を返すのか（D-13 K・2026-09-16 実機で観測）────────────
 * これ以前は、金額を出せないときに**文の断片**「月額はプランを取得すると表示されます」を
 * 返していた。呼び出し側はそれを「最小構成…でも、〈ここ〉かかります。」の**文の途中**に
 * はめ込むため、画面に
 *   「最小構成（…）でも、月額はプランを取得すると表示されますかかります。」
 * という壊れた日本語が出ていた（⑥の破棄直後に観測）。**断片を文にはめ込まない。**
 * ここは状態だけを返し、文は alwaysOnChargeText / minimumCostText が**丸ごと**切り替える。
 *
 * ── なぜ「まだ調べていない」と「料金表に無い」を分けるのか ───────────────────────
 * 利用者にとって次の一手が違う（前者は③の「🔍 調べる」を押せばよい・後者は押しても出ない）。
 * **理由が違うものを同じ文で説明しない**（掟1・金額は推測で埋めない）。
 */
export function cheapestMonthlyState(plans: {
  workerPlans: readonly PlanRow[] | null | undefined
  lbPlans: readonly PlanRow[] | null | undefined
}): CheapestMonthlyState {
  // プランそのものが手元に無い＝まだ③で調べていない（＋取得したが1件も無かった場合も同じ扱い）。
  const workerFetched = (plans.workerPlans ?? []).length > 0
  const lbFetched = (plans.lbPlans ?? []).length > 0
  if (!workerFetched || !lbFetched) return { kind: 'not-fetched' }
  const worker = pickCheapestWorkerPlan(plans.workerPlans)
  const lb = pickCheapestLbPlan(plans.lbPlans)
  if (!worker || !lb) return { kind: 'not-in-table' }
  const workerYen = monthlyYenForPlanPath(worker.path)
  const lbYen = monthlyYenForPlanPath(lb.path)
  if (workerYen == null || lbYen == null) return { kind: 'not-in-table' }
  const total = workerYen + lbYen * (lb.nodeCount ?? 1)
  const manYen = Math.floor(total / 10000)
  return { kind: 'known', amountText: manYen > 0 ? `月${manYen}万円〜` : `月額${total.toLocaleString('ja-JP')}円〜` }
}

/**
 * パネル冒頭の「常時課金」の一文（D-13 K）。**金額が出せるかどうかで文を丸ごと切り替える。**
 * 金額が無いときは数字を推測で書かず、次の一手（③の「🔍 調べる」）を示す。
 */
export function alwaysOnChargeText(plans: {
  workerPlans: readonly PlanRow[] | null | undefined
  lbPlans: readonly PlanRow[] | null | undefined
}): string {
  const s = cheapestMonthlyState(plans)
  if (s.kind === 'known') {
    return `⚠️ 最小構成でも${s.amountText}の常時課金です（動いていなくても請求されます）。`
  }
  if (s.kind === 'not-fetched') {
    return '⚠️ 動いていなくても請求される固定料金がかかります。正確な金額は、③の「🔍 調べる」を押すと出せます。'
  }
  return '⚠️ 動いていなくても請求される固定料金がかかります。ただし、取得したプランが料金表に無いため、正確な金額は出せません。'
}

/**
 * ④の料金表の下に出す「最小構成でもいくらか」の一文（D-13 K）。
 * こちらも**文を丸ごと切り替える**（断片をはめ込まない）。
 */
export function minimumCostText(plans: {
  workerPlans: readonly PlanRow[] | null | undefined
  lbPlans: readonly PlanRow[] | null | undefined
}): string {
  const s = cheapestMonthlyState(plans)
  const base = '最小構成（ワーカ・ロードバランサとも最安プラン1台ずつ）'
  if (s.kind === 'known') return `${base}でも、${s.amountText}かかります。`
  if (s.kind === 'not-fetched') return `${base}の正確な金額は、③の「🔍 調べる」を押すと出せます。`
  return `${base}の金額は出せません（取得したプランが料金表にありません）。`
}

/**
 * プランが選ばれていないときの一文を決める純関数（検分の指摘・2026-09-16）。
 *
 * ⑤の構成図の合計行（`priceSummary` の text）は、プランを**取得済みで選んでいないだけ**のときにも
 * 「③の『🔍 調べる』でプランを取得すると出せます」と言っていた。だが同じ画面のすぐ上（プラン欄）は
 * 「⚠️ プランを選んでください」と出している。**同じ画面の2か所が別の次の一手を指しており**、
 * 非エンジニアは**押しても結果の変わらない③を押し直す**ことになる。
 * `cheapestMonthlyState` が「まだ調べていない／料金表に無い」を言い分けたのと同じ取り違えが、
 * こちら側に残っていた（掟1・理由が違うものを同じ文で説明しない）。
 *
 * `plansFetched` は**呼び出し側が知っていることだけ**を渡す:
 *   ・`true`  … ワーカ・LB とも一覧が手元にある（＝選べば出る）→ 次の一手は「選ぶ」
 *   ・`false` … 少なくとも片方の一覧が無い（＝まだ③を押していない）→ 次の一手は「調べる」
 *   ・省略    … 呼び出し側が知らせていない。**どちらか断定せず**、両方を1文で示す
 *     （⑥の破棄まとめ `buildTeardownSummary` のように、プラン一覧を持たない呼び出し元がある）
 */
export function priceUnselectedText(plansFetched?: boolean): string {
  if (plansFetched === true) {
    return '月額はまだ出せません（プランが選ばれていないため）。上の「ワーカプラン」「ロードバランサプラン」を選ぶと出せます。'
  }
  if (plansFetched === false) {
    return '月額はまだ出せません（プランをまだ取得していないため）。③の「🔍 調べる」でプランを取得すると出せます。'
  }
  return '月額はまだ出せません（プランが選ばれていないため）。③の「🔍 調べる」でプランを取得し、ワーカとロードバランサのプランを選ぶと出せます。'
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
 *
 * **`opts.plansFetched`（検分の指摘・2026-09-16）**: プランが選ばれていないときの**次の一手**は、
 * プラン一覧を取得済みかどうかで変わる（取得済みなら「選ぶ」・未取得なら「③で調べる」）。
 * 文の決定は `priceUnselectedText` に置き、ここはそれを使うだけ（掟10）。
 * 省略した呼び出し元（⑥の破棄まとめなど）の文は**どちらとも断定しない形**になる。
 */
export function priceSummary(
  workerPlan: { path: string | null } | null,
  lbPlan: { path: string | null; nodeCount: number | null } | null,
  minNodes: number,
  maxNodes: number = minNodes,
  opts?: { plansFetched?: boolean },
): { text: string; totalYen: number | null } {
  // ── D-13 K: 「まだ調べていない」と「料金表に無い」を**別の文**にする ────────────────
  // 以前はどちらも「月額を出せません（料金表に無いプランが含まれています）」と言っていた。
  // プランをまだ取得していないだけのときに**違う理由**を告げることになり、利用者は
  // 「自分のプランが料金表に無い」と受け取ってしまう（次の一手も変わる——前者は③の
  // 「🔍 調べる」を押せばよく、後者は押しても出ない）。理由が違うものを同じ文にしない（掟1）。
  if (!workerPlan?.path || !lbPlan?.path) {
    return { text: priceUnselectedText(opts?.plansFetched), totalYen: null }
  }
  const workerYen = monthlyYenForPlanPath(workerPlan.path)
  const lbYen = monthlyYenForPlanPath(lbPlan.path)
  const lbNodeCount = lbPlan.nodeCount ?? 1
  const workerPart = workerYen != null ? `ワーカ ${workerYen.toLocaleString('ja-JP')}円 × ${minNodes}台` : 'ワーカ（料金表に無いプラン）'
  const lbPart = lbYen != null ? `ロードバランサ ${lbYen.toLocaleString('ja-JP')}円 × ${lbNodeCount}台` : 'ロードバランサ（料金表に無いプラン）'
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

// ── ⑧ アプリを公開する（D-4・2026-09-15）: 結果表示の段の日本語化・入力チェックの純関数 ──────
// main側 apprunDedicatedAppApply.ts の PublishAppStage（IPC 側 apprunDedicated:publishApp がイメージの
// 組み立て・push の失敗に使う 'image' を足したもの）を、global.d.ts の publishApp() の戻り値型から
// 導出する（掟10・複製しない。global.d.ts 自身は `import('../main/cloud/apprunDedicatedAppApply')` で
// main の型をそのまま使っている）。既存の STAGE_LABEL は⑤専用。
export type PublishAppStage = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['publishApp']>>['stage']

/** ⑧の段の日本語対訳（Record で全段。main 側の段が増減したら、この複製も直す）。 */
export const PUBLISH_STAGE_LABEL: Record<PublishAppStage, string> = {
  consent: '確認',
  'no-cluster': 'クラスタの記録',
  invalid: '入力の検証',
  record: '記録',
  'lets-encrypt': 'Let\'s Encrypt メールの設定',
  // J-1（2026-09-17）: ⑧でもクラスタの待ち受けポート（80/http・443/https）を確かめるようになった。
  'cluster-ports': 'クラスタの公開ポートの確認',
  'app-lookup': 'アプリケーションの検索',
  'name-taken': 'アプリケーション名の重複',
  'app-create': 'アプリケーションの作成',
  'version-create': 'バージョンの作成',
  activate: 'バージョンの有効化',
  cleanup: '古いバージョンの掃除',
  'lb-address': 'ロードバランサのIP取得',
  image: 'イメージの組み立てと反映',
  // 2026-09-23 検分の指摘12: 鍵を渡せずに止めたときを「入力の検証」と言わない
  // （原因は「APIキーが未登録」「保存場所に接続できない」で、公開フォームの入力の誤りではない）。
  storage: '保存場所の鍵の用意',
  done: '完了',
}

export type PublishFormInput = {
  host: string
  /** クラスタに Let's Encrypt のメールが未設定と分かっている（hasLetsEncryptEmail === false）ときだけ true。 */
  needsEmail: boolean
  email: string
  cpu: number
  memory: number
  fixedScale: number
  healthCheckPath: string
}

/**
 * ⑧の入力を画面側で先に見る（「押せない理由」の最小限。main の validateAppSpec が再検証して
 * 'invalid' 段で止めるので、そちらの文言をここに複製しない）。違反があれば全部返す（欄ごとに独立）。
 * ホスト名は**黙って小文字化しない**（validateAppSpec と同じ方針。大文字が混じればここで止める）。
 * 範囲は validateAppSpec と同じ（cpu 100〜64000・memory 128〜131072・fixedScale 1〜50・整数）。
 */
export function computePublishFormErrors(input: PublishFormInput): string[] {
  const errors: string[] = []
  const host = input.host.trim()
  if (!host) errors.push('ホスト名を入力してください（例: app.example.com）')
  else if (!HOSTNAME_PATTERN.test(host)) errors.push('ホスト名は小文字の英数字・ハイフン・ドットで指定してください（例: app.example.com）')
  const email = input.email.trim()
  if (input.needsEmail && !email) errors.push('Let\'s Encrypt のメールアドレスを入力してください（証明書の発行に必要です）')
  // F-1 A-3（2026-09-16）: 必須でなくても、値を入れたなら最低限の形は確かめる（isLikelyEmail・ゆるい判定）。
  else if (email && !isLikelyEmail(email)) errors.push('Let\'s Encrypt のメールアドレスの形を確認してください（例: you@example.com）')
  if (!Number.isInteger(input.cpu) || input.cpu < 100 || input.cpu > 64000) errors.push('mCPU は 100〜64000 の整数で指定してください')
  if (!Number.isInteger(input.memory) || input.memory < 128 || input.memory > 131072) errors.push('メモリは 128〜131072（MB）の整数で指定してください')
  if (!Number.isInteger(input.fixedScale) || input.fixedScale < 1 || input.fixedScale > 50) errors.push('台数は 1〜50 の整数で指定してください')
  const hc = input.healthCheckPath.trim()
  if (hc && !hc.startsWith('/')) errors.push('ヘルスチェックのパスは / から始めてください')
  return errors
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
  // D-4（2026-09-15）: ⑧で公開したアプリ。applicationID があるときだけ末尾に「先に削除」の行を足す。
  applicationID?: string | null
  applicationName?: string | null
  activeVersion?: number | null
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
  // D-4（2026-09-15）: ⑧で公開したアプリがあれば末尾に1行（main の teardownFlow はアプリ→LB→ASG→クラスタの順に消す）。
  // 無ければ行自体を足さない（既存の行数・並びを変えない）。
  if (r.applicationID) {
    lines.push(`アプリ『${r.applicationName ?? r.applicationID}』（バージョン ${r.activeVersion ?? TEARDOWN_SUMMARY_UNKNOWN}）→ 先に削除`)
  }
  return { lines }
}

export default function AppRunDedicatedPanel({ projectDir, onOpenCredentials }: Props) {
  const metaPath = `${projectDir}/.sakuraide.json`

  const readMeta = useCallback(async (): Promise<any> => {
    try { return JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { return {} }
  }, [metaPath])

  // このプロジェクトの公開先として記録する（VpsPanel と同じ作法）。
  // ※ PublishTargetKind（公開記録の種別）には 'sakura-apprun-dedicated' として登録済み
  //   （唯一の定義は src/renderer/publishStatus.ts。D-3、2026-09-11 Ryosuke 決定）。
  //   「アプリを公開する」段（⑧・D-4）の記録（applicationID 等・publish.targets の公開記録）は
  //   main（publishAppFlow・apprunDedicated:publishApp）が同じ場所へ書く。
  //   公開したものからの取り込み（publishImport）は専有型は対象外のまま。
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

  // ⑥の破棄が clearPublishRecord（publishRecord.ts）を呼ぶと 'sakura-meta-changed' が飛び、
  // この画面自身の購読（onMetaChanged）が refreshApprunState/refreshAppStatus を走らせる。
  // 破棄の側は順序を保つために同じ2つを await で取り直しているので、そのままだと
  // GET /clusters/{id} が二重に飛ぶ（2026-09-23 検分の指摘6-3）。await する側に寄せ、
  // その間だけ購読の側を黙らせる。
  const selfMetaRefreshRef = useRef(false)

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
  // 最後にディスクへ書いた（か、ディスクから読んだ）値。②の欄は onBlur で保存するので、
  // これが無いと「クリックして何も直さずに外へ出ただけ」でファイル書き込み →
  // 'sakura-meta-changed' → refreshAppStatus → GET /clusters/{id} が1本飛び、
  // ⑧「公開中: …」が触っていないのに一瞬消えて出し直される（2026-09-23 検分の指摘6）。
  const savedResourceIdRef = useRef('')
  const saveResourceId = async (v: string) => {
    if (v === savedResourceIdRef.current) return // 値が変わっていない＝書かない（クラウドGETも起こさない）
    savedResourceIdRef.current = v
    await saveMeta({ servicePrincipalId: v })
  }

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
  // alive はアンマウント判定、myGen はキー切替の判定（別物なので併用する）。マウント直後に
  // キーを切り替えると、このぶんの取得が遅れて戻って新しいキーの一覧を上書きしうる
  // （2026-09-23 検分の指摘4）。zonesCache 側の generation は自分のキャッシュしか守らない。
  useEffect(() => {
    let alive = true
    const myGen = genRef.current
    loadZones().then(r => { if (alive && genRef.current === myGen && r.ok) setZones(r.rows) })
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

  // ── ⑧ アプリの状態（D-4・2026-09-15）: Let's Encrypt メールの有無・env.json の有無・記録（アプリ系の欄を含む）。
  // main の apprunDedicated:appStatus が返す record（ApprunDedicatedRecord・src/shared/publishMeta.ts）を
  // ⑧「公開中: …」と⑥のアプリ行に使う（上の apprunState＝state の型にはアプリ系の欄が無いため）。
  // 方式B（掟4）: キーは使う瞬間に読んで引数で渡す。未登録なら null のまま（⑧は①への案内を出す）。
  // 世代カウンタ（genRef）は testConnection/investigate と同じ扱い（キー切替後の古い応答で上書きしない）。
  type AppStatusResult = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['appStatus']>>
  type AppStatusOk = Extract<AppStatusResult, { ok: true }>
  const [appStatus, setAppStatus] = useState<AppStatusOk | null>(null)
  const [appStatusError, setAppStatusError] = useState('')
  const refreshAppStatus = useCallback(async () => {
    const myGen = genRef.current
    try {
      const auth = await window.electronAPI.cloud.loadKey()
      if (genRef.current !== myGen) return
      if (!auth || !auth.token || !auth.secret) { setAppStatus(null); setAppStatusError(''); return }
      const r = await window.electronAPI.apprunDedicated.appStatus(projectDir, auth)
      if (genRef.current !== myGen) return
      if (r.ok) { setAppStatus(r); setAppStatusError('') } else { setAppStatus(null); setAppStatusError(r.message) }
    } catch (e: any) {
      if (genRef.current !== myGen) return
      setAppStatus(null); setAppStatusError(e?.message ?? String(e))
    }
  }, [projectDir])
  const appRecord = appStatus?.record ?? null
  // ⑥「いまの構成と月額目安」に渡す記録: apprunState にアプリ系の欄を appStatus.record から補う。
  const teardownSummaryRecord = {
    ...(apprunState ?? {}),
    applicationID: appRecord?.applicationID ?? null,
    applicationName: appRecord?.applicationName ?? null,
    activeVersion: appRecord?.activeVersion ?? null,
  }

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
  // F-1（2026-09-16）: letsEncryptEmail の state はここから消した（⑤フォームから削除・⑧に一本化。
  // 理由は⑧のメール欄の近くのコメント参照）。
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['create']>> | null>(null)
  // ⑤フォームの警告表示（判断7・2026-09-11）: どの欄を「触った」か、「作成」を押したか。
  // visibleFormErrors（本ファイル上部の純関数）がこの2つと errors から表示可否を決める。
  const [touched, setTouched] = useState<DedicatedFormTouched>({})
  const [submitted, setSubmitted] = useState(false)

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
  // プラン一覧が手元にあるか（＝下のプラン欄が <select> を出している状態か）。
  // ここが true なら、金額が出ない理由は「選んでいないだけ」——③を押し直しても変わらない。
  // 欄の表示条件（`workerPlans && workerPlans.some(p => p.path)`）と同じ式にそろえる（検分の指摘）。
  const plansFetched = (workerPlans ?? []).some(p => p.path) && (lbPlans ?? []).some(p => p.path)
  const price = priceSummary(selectedWorkerPlan, selectedLbPlan, minNodes, maxNodes, { plansFetched })
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
  //
  // 判断ロジック（欄ごとの判定・touched/submitted による表示可否）は
  // computeDedicatedFormErrors / visibleFormErrors に一元化してある（判断7・2026-09-11・掟10）。
  // hasErrors（doCreate を止めるかどうか）は touched/submitted に関係なく常に全欄を見る
  // ——「まだ表示していない」ことと「送信してよい」ことは別（表示を遅らせても、検証までは
  // 遅らせない）。
  const errors = computeDedicatedFormErrors({
    clusterName, resourceId, ports, zone: effectiveZone,
    selectedWorkerPath, selectedLbPath, minNodes, maxNodes,
  })
  const hasErrors = Object.keys(errors).length > 0
  const visible = visibleFormErrors(errors, touched, submitted)
  // ワーカプラン／ロードバランサプランは欄のすぐ下に既定選択なしの専用説明を常に出しているため、
  // ここ（全体側）には出さない——同じ内容を2か所に出さないため（フィールド側の表示を優先する）。
  const generalErrors = (Object.keys(visible) as DedicatedFormField[])
    .filter(k => k !== 'workerPlan' && k !== 'lbPlan')
    .map(k => visible[k] as string)
  const touch = (field: DedicatedFormField) => setTouched(t => (t[field] ? t : { ...t, [field]: true }))

  // ⑤⑥の「確認→IPC」本体は apprunDedicatedActions.ts の純関数（runCreate/runTeardown）に
  // 切り出してある（2026-09-10 レビューの修理・J・rollbackSwitch.ts と同型）。ここ（doCreate/
  // doTeardown）はそれを呼ぶ薄い皮——confirm に ConfirmModal の答えを、activity に
  // beginActivity（src/renderer/activity.ts）を注入するだけで、「確認が false なら
  // create/teardown を一度も呼ばない」「実行中は必ず活動レジストリへ計上する」歯止め自体は
  // ここには無い（tests/apprunDedicatedActions.test.ts が偽 confirm/create/teardown/activity で
  // 固定する。K・2026-09-10 レビューの修理・バッチ3——共用型の公開処理と同じく、作成・破棄の
  // 実行中は main の isBusy を立て、自動更新の「いますぐ再起動」が作業中を拒否できるようにする）。
  //
  // ── window.confirm → ConfirmModal（判断9・2026-09-11）─────────────────────
  // runCreate/runTeardown は `deps.confirm(message)` を**同期の boolean**として扱う
  // （apprunDedicatedActions.ts の歯止めロジックは変更しない・掟10）。ConfirmModal は
  // React の状態更新とクリック待ちを伴うため本質的に非同期——そこで確認そのものは
  // ここで `await confirm(...)` として**先に**済ませ、runCreate/runTeardown へは
  // 「もう確定した答え」を返すだけの同期関数（`() => ok`）を渡す。
  const { confirm, element: confirmElement } = useConfirm()

  const doCreate = async () => {
    if (hasErrors || panelBusy({ creating, tearingDown, publishing, lbRefreshing })) return
    const spec = {
      name: clusterName.trim(),
      ports,
      servicePrincipalID: resourceId.trim(),
      zone: effectiveZone.trim(),
      workerServiceClassPath: selectedWorkerPath as string,
      minNodes, maxNodes,
      lbServiceClassPath: selectedLbPath as string,
    }
    const confirmMessage = `${price.text}\n\nこの費用が毎月かかります。よろしいですか？`
    try {
      const ok = await confirm({ title: '専有型クラスタを作成します', body: confirmMessage, confirmLabel: '作成する', danger: true })
      const outcome = await runCreate(
        { confirmMessage, spec },
        {
          confirm: () => ok,
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
      await refreshAppStatus() // ⑧の表示条件（クラスタが揃ったか）と Let's Encrypt メールの有無を取り直す
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
    if (panelBusy({ creating, tearingDown, publishing, lbRefreshing })) return
    // 破棄前の記録に applicationID があったか（破棄後は消えるため、ここで先に確定させる）。
    // ⑧で公開した記録が残ったまま「すべて削除する」を通すと、main は公開記録を消さない
    // （teardownApp と同じ手。上の D-4 のコメント）ので、ここで clearPublishRecord を呼ばないと
    // 📡 一覧に存在しないアプリの幽霊が残る（tests/apprunDedicatedWiring.test.ts で固定）。
    const hadApplicationID = !!appRecord?.applicationID
    const targets = [
      // D-4: ⑧で公開したアプリがあれば先頭（main の teardownFlow はアプリ→LB→ASG→クラスタの順に消す）。
      appRecord?.applicationID ? `アプリ『${appRecord.applicationName ?? appRecord.applicationID}』` : null,
      apprunState?.loadBalancerID ? `ロードバランサ『${apprunState.loadBalancerID}』` : null,
      apprunState?.asgID ? `オートスケーリンググループ『${apprunState.asgID}』` : null,
      apprunState?.clusterID ? `クラスタ『${apprunState.clusterID}』` : null,
    ].filter(Boolean).join('・')
    const confirmMessage = `次を削除します: ${targets}\n\nこの操作は元に戻せません。消さない限り課金が続きます。よろしいですか？`
    try {
      const ok = await confirm({ title: '⚠️ 専有型クラスタを破棄します', body: confirmMessage, confirmLabel: '破棄する', danger: true })
      const outcome = await runTeardown(
        { confirmMessage },
        {
          confirm: () => ok,
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
      // 破棄できて、かつ⑧で公開したアプリの記録があったなら、公開記録（publish.targets）も消す
      // （📡 一覧が使う既存の関数。残すと存在しない公開が一覧に出続ける・AppRunPanel.doTeardown と同じ手）。
      // clearPublishRecord は 'sakura-meta-changed' を発火し、この画面の購読が同じ2つを
      // 走らせる。取り直しは下の await 側に寄せるので、その間は購読を黙らせる（指摘6-3）。
      selfMetaRefreshRef.current = true
      try {
        if (outcome.result.ok && hadApplicationID) {
          try { await clearPublishRecord(projectDir, 'sakura-apprun-dedicated') } catch { /* 記録の掃除の失敗は破棄の成否に影響させない */ }
        }
        await refreshApprunState()
        await refreshAppStatus() // アプリの記録（applicationID 等）も消えているので取り直す
      } finally {
        selfMetaRefreshRef.current = false
      }
    } catch (e: any) {
      setTeardownResult({ ok: false, executed: [], message: e?.message ?? String(e), remaining: {} })
    } finally {
      setTearingDown(false)
    }
  }

  // ── ⑧ アプリを公開する（D-4・2026-09-15。段階③⑤・docs/apprun-dedicated-plan.md 12-2） ────
  // 確認→IPC の歯止めは runPublishApp（apprunDedicatedActions.ts）。ここは⑤の doCreate と同じ薄い皮:
  // 先に ConfirmModal で答えを取り、確定した boolean を同期関数として注入する。
  const [host, setHost] = useState('')
  const [leEmail, setLeEmail] = useState('')
  const [appCpu, setAppCpu] = useState<number>(APP_DEFAULTS.cpu)
  const [appMemory, setAppMemory] = useState<number>(APP_DEFAULTS.memory)
  const [appFixedScale, setAppFixedScale] = useState<number>(APP_DEFAULTS.fixedScale)
  const [healthCheckPath, setHealthCheckPath] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['publishApp']>> | null>(null)
  // 進捗（イメージの組み立て・push・各段）。実行中（publishing）だけ表示する（⑥の teardownProgress と同型）。
  const [publishProgress, setPublishProgress] = useState<string | null>(null)
  const [scaffolding, setScaffolding] = useState(false)
  const [scaffoldError, setScaffoldError] = useState('')
  useEffect(() => {
    const unsubscribe = window.electronAPI.apprunDedicated.onPublishProgress((msg) => setPublishProgress(msg))
    return () => { unsubscribe() }
  }, [])

  // F-1 A-2（2026-09-16）: Let's Encrypt メール欄の出し分けは3状態（letsEncryptEmailFieldState・
  // shared/apprunDedicatedApp.ts）に一元化した。false＝必須で出す、null＝任意で出す（確かめられ
  // なかっただけで、実際は設定済みの人を止めないため）、true＝出さない（設定済み）。
  // 公開が 'lets-encrypt' 段で失敗したときは、実際には未設定だったと確定するので、上の3状態に
  // 関係なく「出す・必須」に倒す（失敗表示に入力の導線を添える）。
  const leEmailConfirmedMissing = !!publishResult && !publishResult.ok && publishResult.stage === 'lets-encrypt'
  const leEmailField = letsEncryptEmailFieldState(appStatus?.hasLetsEncryptEmail ?? null)
  const showLeEmailField = leEmailField.show || leEmailConfirmedMissing
  const needsLeEmail = leEmailField.required || leEmailConfirmedMissing
  const publishErrors = computePublishFormErrors({
    // 欄が出ていないときは、その値を検証にも送信にも使わない（画面に見えない値で止めない）。
    host, needsEmail: needsLeEmail, email: showLeEmailField ? leEmail : '',
    cpu: appCpu, memory: appMemory, fixedScale: appFixedScale, healthCheckPath,
  })
  const hostTrimmed = host.trim()
  const hostOk = HOSTNAME_PATTERN.test(hostTrimmed)
  const appPublished = !!appRecord?.applicationID

  // env.json（公開の設定）が無ければ、共用型 AppRunPanel と同じ scaffoldEnv で作る（複製しない）。
  const doScaffoldEnv = async () => {
    if (scaffolding) return
    setScaffolding(true); setScaffoldError('')
    try {
      const projName = projectDir.split('/').pop() ?? 'app'
      const r = await window.electronAPI.cloud.scaffoldEnv(projectDir, projName)
      if (r.ok) await refreshAppStatus()
      else setScaffoldError(r.errors.join(' / '))
    } catch (e: any) {
      setScaffoldError(e?.message ?? String(e))
    } finally { setScaffolding(false) }
  }

  const doPublish = async () => {
    if (publishErrors.length > 0 || panelBusy({ creating, tearingDown, publishing, lbRefreshing }) || !appStatus) return
    const input = {
      host: hostTrimmed,
      cpu: appCpu, memory: appMemory, fixedScale: appFixedScale,
      // 空なら送らない（main が env.json の probePath を使う）。
      ...(healthCheckPath.trim() ? { healthCheckPath: healthCheckPath.trim() } : {}),
      // F-1 A-2: 欄が出ているとき（必須・任意のどちらでも）は送る。欄が出ていないのに値が渡らない、
      // という食い違いを作らない。
      ...(showLeEmailField ? { letsEncryptEmail: leEmail.trim() } : {}),
    }
    const confirmMessage = [
      `ホスト名: ${input.host}`,
      'イメージを組み立ててレジストリへ反映してから、専有型に載せます',
      `mCPU ${appCpu}・メモリ ${appMemory}MB・台数 ${appFixedScale}`,
      // 検分の指摘（2026-09-16）: 確認画面が mCPU・メモリ・**台数**を読み上げるのに、
      // 「台数を2以上にするとコンテナごとに別のデータになる」「書いたデータは残らない」に
      // 触れていなかった。**押す前にいちばん取り返しがつかないこと**を出す（文言は一元化・掟10）。
      ephemeralDataNote(),
      '公開のあと、DNS の A レコードをロードバランサの IP に向ける必要があります',
    ].join('\n')
    try {
      const ok = await confirm({ title: '専有型にアプリを公開します', body: confirmMessage, confirmLabel: '公開する', danger: false })
      const outcome = await runPublishApp(
        { confirmMessage, input },
        {
          confirm: () => ok,
          activity: { begin: () => beginActivity('専有型アプリの公開', { closeWarning: PUBLISH_CLOSE_WARNING }) },
          publish: async (i, opts) => {
            setPublishing(true); setPublishResult(null); setPublishProgress(null)
            const auth = await window.electronAPI.cloud.loadKey()
            if (!auth || !auth.token || !auth.secret) {
              return { ok: false, stage: 'consent', message: 'さくらのクラウドAPIキーが未登録です。①で登録してください。' } as any
            }
            return window.electronAPI.apprunDedicated.publishApp(projectDir, auth, i, opts)
          },
        },
      )
      if (outcome.cancelled) return
      setPublishResult(outcome.result)
      await refreshApprunState()
      await refreshAppStatus()
    } catch (e: any) {
      setPublishResult({ ok: false, stage: 'consent', message: e?.message ?? String(e) } as any)
    } finally {
      setPublishing(false)
    }
  }

  // ── ⑧「🔄 IP を取り直す」（D-5・2026-09-16 実測）: LB ノードのアドレスは付くまで数分かかることがあり、
  //    公開直後の lb-address 段で空のまま終わることがある。main の apprunDedicated:lbAddresses（GET 1回＋記録）で
  //    取り直し、記録（appStatus.record.lbAddresses）と、出ていれば公開結果の IP 欄も更新する。
  //    方式B（掟4）: キーは使う瞬間に loadKey で読んで引数で渡す。何も作らない（GET と記録の書き込みだけ）。
  const [lbRefreshing, setLbRefreshing] = useState(false)
  const [lbRefreshError, setLbRefreshError] = useState('')
  const doRefreshLbAddresses = async () => {
    if (lbRefreshing) return
    setLbRefreshing(true); setLbRefreshError('')
    try {
      const auth = await window.electronAPI.cloud.loadKey()
      if (!auth || !auth.token || !auth.secret) {
        setLbRefreshError('さくらのクラウドAPIキーが未登録です。①で登録してください。')
        return
      }
      const r = await window.electronAPI.apprunDedicated.lbAddresses(projectDir, auth)
      if (!r.ok) { setLbRefreshError(r.message); return }
      // 公開結果の表示が残っていれば、その IP 欄も取り直した値に差し替える（「取得できませんでした」を残さない）。
      setPublishResult(prev => (prev && prev.ok ? { ...prev, lbAddresses: r.lbAddresses } : prev))
      await refreshAppStatus()
    } catch (e: any) {
      setLbRefreshError(e?.message ?? String(e))
    } finally { setLbRefreshing(false) }
  }
  // 同じボタンを「公開中: …」の下と、公開結果の「IP を取得できませんでした」の下の2か所に出す（1つの定義を使い回す）。
  const lbRefreshButton = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => { void doRefreshLbAddresses() }}
        disabled={panelBusy({ creating, tearingDown, publishing, lbRefreshing })}
        className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-40"
      >{lbRefreshing ? 'IP を取り直しています…' : '🔄 IP を取り直す'}</button>
      {lbRefreshError && <span className="text-xs text-brand-yellow leading-relaxed select-text">{lbRefreshError}</span>}
    </div>
  )

  // ── ⑧「🔎 公開先と https を確かめる」（O-1・2026-09-17）────────────────────────────
  //    2026-09-16〜17 の観測: 証明書が一度も発行されていないのに「✅ 公開しました」と出していた
  //    （Koto は証明書を一度も見ていなかった）。利用者はブラウザの警告を見て、何が悪いのか分からない。
  //    さくらの API には証明書の状態を読む手段が無いので、main が実際に繋いで確かめる。
  //    **⑧の公開直後の確認（verify）には足せない**——あれは DNS を向ける前に走るので、その時点で
  //    正式な証明書は存在し得ない（時間軸が違う）。だから押したときに1回だけ調べる別のボタンにする。
  //    「🔄 IP を取り直す」と同じ形（押した瞬間に1回だけ・何も作らない）。鍵は要らない（読むだけ）。
  const [siteChecking, setSiteChecking] = useState(false)
  const [siteCheckError, setSiteCheckError] = useState('')
  const [siteCheckResult, setSiteCheckResult] = useState<string[] | null>(null)
  const doCheckSite = async () => {
    if (siteChecking || panelBusy({ creating, tearingDown, publishing, lbRefreshing })) return
    setSiteChecking(true); setSiteCheckError(''); setSiteCheckResult(null)
    try {
      const r = await window.electronAPI.apprunDedicated.checkSite(projectDir)
      if (!r.ok) { setSiteCheckError(r.message); return }
      // 行の組み立ては純関数（siteCheckLines）が済ませている。画面は並べるだけ（掟10）。
      setSiteCheckResult(r.lines)
    } catch (e: any) {
      setSiteCheckError(e?.message ?? String(e))
    } finally { setSiteChecking(false) }
  }
  const siteCheckBlock = (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => { void doCheckSite() }}
          disabled={siteChecking || panelBusy({ creating, tearingDown, publishing, lbRefreshing })}
          className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-40"
        >{siteChecking ? '確かめています…' : '🔎 公開先と https を確かめる'}</button>
        <span className="text-[11px] text-ink-muted leading-relaxed">DNS を設定したあとに押してください。</span>
      </div>
      {siteCheckError && <p className="text-xs text-brand-yellow leading-relaxed select-text">{siteCheckError}</p>}
      {siteCheckResult && (
        <ul className="space-y-0.5">
          {siteCheckResult.map((line, i) => (
            <li key={i} className="text-xs text-ink-secondary leading-relaxed select-text">{line}</li>
          ))}
        </ul>
      )}
    </div>
  )

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

  // 世代カウンタ（genRef）は testConnection/investigate/refreshAppStatus と同じ扱い
  // （キー切替後に遅れて戻った前のキーの応答で⑦を上書きしない。2026-09-23 検分の指摘3）。
  // telemetryStatus は1回あたり GET 6本（logs/metrics × monitoring.ts）なので遅延が起きやすい。
  // finally の setTelemetryLoading(false) だけはガードしない（切替後に「確認中…」で固まらせないため）。
  const refreshTelemetry = useCallback(async () => {
    const myGen = genRef.current
    setTelemetryLoading(true); setTelemetryError('')
    try {
      const auth = await window.electronAPI.cloud.loadKey()
      if (genRef.current !== myGen) return
      if (!auth || !auth.token || !auth.secret) {
        setTelemetryVariants(null); setTelemetryActions(null)
        return
      }
      const r = await window.electronAPI.apprunDedicated.telemetryStatus(auth)
      if (genRef.current !== myGen) return
      if (r.ok) { setTelemetryVariants(r.variants); setTelemetryActions(r.actions) } else {
        setTelemetryVariants(null); setTelemetryActions(null)
        setTelemetryError(r.message ? `${r.message}${r.detail ? `（${r.detail}）` : ''}` : '状態を確認できませんでした')
      }
    } catch (e: any) {
      if (genRef.current !== myGen) return
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
    refreshKey(); refreshCloudKeys(); refreshApprunState(); refreshTelemetry(); refreshAppStatus()
    setTouched({}); setSubmitted(false)
    ;(async () => {
      const m = await readMeta()
      const v = m.publish?.apprunDedicated
      const savedId = typeof v?.servicePrincipalId === 'string' ? v.servicePrincipalId : ''
      setResourceId(savedId)
      savedResourceIdRef.current = savedId // ディスクの値＝「書いたのと同じ」として覚えておく（指摘6）
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
      // 捨てたあと入れ直す経路も世代で守る（2026-09-23 検分の指摘4）。A→B→C と続けて
      // 切り替えると、B のぶんが C のあとに戻って⑤のゾーン選択が B の一覧のままになる。
      const zonesGen = genRef.current
      loadZones().then(r => { if (genRef.current === zonesGen && r.ok) setZones(r.rows) })
      // ⑦ ログ・メトリクスもキーに紐づく状態なので、切り替えたら取り直す
      // （前のキーで確かめた「繋がっています」を残さない）。
      setTelemetryConfirmingKind(null); setTelemetryDoneKind(null)
      refreshTelemetry()
      // ⑧ アプリの状態（Let's Encrypt メールの有無等）もキーに紐づく。捨ててから取り直す。
      setAppStatus(null); setAppStatusError('')
      refreshAppStatus()
    }
    window.addEventListener('sakura:credentials-changed', h)
    return () => window.removeEventListener('sakura:credentials-changed', h)
  }, [refreshKey, refreshCloudKeys, refreshTelemetry, refreshAppStatus])

  // D-4: 📡 公開したもの一覧から専有型のアプリを破棄すると clearPublishRecord が 'sakura-meta-changed' を
  // 発火する（src/renderer/publishRecord.ts）。この画面の「公開中: …」（appStatus.record）と⑥のアプリ行を
  // 古いまま残さないよう、記録（apprunState）とアプリの状態を取り直す（この画面自身の saveMeta も
  // 同じイベントを発火するが、取り直すだけなので害は無い）。
  useEffect(() => {
    // 破棄の最中（selfMetaRefreshRef）は、破棄の側が同じ2つを await で取り直すので何もしない
    // ——そうしないと GET /clusters/{id} が二重に飛ぶ（指摘6-3）。
    const onMetaChanged = () => {
      if (selfMetaRefreshRef.current) return
      refreshApprunState(); refreshAppStatus()
    }
    window.addEventListener('sakura-meta-changed', onMetaChanged)
    return () => window.removeEventListener('sakura-meta-changed', onMetaChanged)
  }, [refreshApprunState, refreshAppStatus])

  const selectedKeyId = activeKeyId ?? cloudKeys[0]?.id ?? null
  const selectedKeyLabel = cloudKeys.find(k => k.id === selectedKeyId)?.label ?? '（未選択）'
  const keyReady = hasKey === true

  // F-1 B-1（2026-09-16）: ⑦「ログ・メトリクス」を1行に畳んでよいか（すべて繋がっていて、
  // かつ行動〔ボタン〕が要らないときだけ）。判定は shared/appLog.ts の純関数（掟10）。
  const collapseTelemetry = !!telemetryVariants && !!telemetryActions
    && shouldCollapseTelemetrySection(telemetryVariants, [telemetryActions.logs, telemetryActions.metrics])

  return (
    <div className="space-y-3">
      {/* 専有型の注意文（常時課金・提供範囲）は、以前は
          PublishModal.tsx のタブ直下・このパネルの冒頭・④の冒頭の3か所にほぼ同文で出ており、
          利用者目線レビューで重複を指摘された。ここ1か所に一本化する（判断4・2026-09-11）。 */}
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">📦 さくらのAppRun 専有型</p>
        <p className="text-xs font-semibold text-brand-red leading-relaxed">
          {/* D-13 K: 金額が出せるかどうかで**文を丸ごと**切り替える（断片を文にはめ込まない）。
              判断は純関数 alwaysOnChargeText（このファイルの上）に集約し、ここは描くだけ（掟10）。 */}
          {alwaysOnChargeText({ workerPlans, lbPlans })}
          共用型（さくらのAppRun）は使った分だけの従量課金ですが、専有型は日額・月額の固定費です。
        </p>
        <p className="text-xs text-ink-muted leading-relaxed">
          仮想サーバレベルで専有するAppRun。独自ドメインが使えますが、4階層の構成が必要な上級者向けサービスです。
          <b className="text-ink">クラスタの作成・破棄（⑤⑥）と、アプリケーションの公開（⑧・独自ドメインが必要）まで行えます。</b>
        </p>
        <p className="text-[11px] text-ink-muted">
          <a href={OFFICIAL_PRICE_URL} className="hover:underline">🌐 公式サイトを見る ↗</a>
        </p>
      </div>

      {/* ① APIキー（AccessKeySection に統一・判断8。入力は「認証情報」に一本化。
          ここは状態表示と接続テストのみ） */}
      <AccessKeySection
        stepNo="①"
        serviceTitle="さくらのクラウド"
        keyLabel="APIキー"
        registered={keyReady}
        onOpenCredentials={onOpenCredentials}
        test={{
          run: testConnection,
          state: conn,
          checks: connChecks ? [
            { key: 'api', label: '専有型API 参照（制限・プラン）', ok: connChecks.api.ok, message: connChecks.api.message },
            { key: 'billing', label: '請求（コスト）参照', ok: connChecks.billing.ok, message: connChecks.billing.message },
          ] : undefined,
          message: connMsg,
          note: '※ レジストリの権限は、アプリの公開に対応したときに確認します。',
        }}
      >
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
        {/* 専有型と共用型は「同じキー（さくらのクラウド）」を使う。接続テストの結果は
            従来どおりタブごと（このタブの conn/connMsg/connChecks は共用型とは別の状態）。 */}
        <p className="text-[11px] text-ink-muted leading-relaxed">
          共用型と同じキーです。
        </p>
      </AccessKeySection>

      {/* ② サービスプリンシパルの用意（最初の一度だけ・手作業） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">② サービスプリンシパルの用意（最初の一度だけ手作業）</p>

        {/* 既定で見えるのは入力欄と1行の説明だけ（判断7・利用者目線レビュー・2026-09-11）。
            手順A/B（5ステップ）は初心者には情報量が多いので「詳しい手順を見る」で畳む。 */}
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-ink-secondary">サービスプリンシパルのリソースID（12桁）</label>
          <input
            value={resourceId}
            onChange={e => { setResourceId(e.target.value); touch('resourceId') }}
            onBlur={() => saveResourceId(resourceId.trim())}
            placeholder="例: 111111111111"
            className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
          />
          {idFormat === true && <p className="text-[11px] text-brand-green font-semibold">✓ 形は合っています（12文字）</p>}
          {idFormat === false && <p className="text-[11px] text-brand-yellow font-semibold">⚠️ 違うようです（12文字ではありません）</p>}
          <p className="text-[11px] text-ink-muted leading-relaxed">
            コントロールパネルで一度だけ作ります。作り方は「詳しい手順を見る」。
          </p>
        </div>

        <details className="rounded-lg border border-line bg-overlay p-3 space-y-3">
          <summary className="cursor-pointer select-none text-xs font-semibold text-ink-secondary hover:text-ink">詳しい手順を見る</summary>
          <div className="mt-2 space-y-3">
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

            <p className="text-[11px] text-ink-muted leading-relaxed">
              ※ 確認できるのは文字数の形式だけです。実在するかどうかはここでは確認できません（IAM APIが使えないため）。実際にクラスタを作る段になって初めて分かります。
            </p>
          </div>
        </details>
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

      {/* ④ 費用の確認と同意（常時課金であることの注意はパネル冒頭に一本化した・判断4・
          2026-09-11。ここは同意そのものの本文だけにする） */}
      <section className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">④ 費用の確認と同意</p>

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
        {/* D-13 K: 金額を出せないときに文の断片をはめ込むと「…表示されますかかります。」という
            壊れた日本語になっていた（2026-09-16 実機で観測）。判断は純関数 minimumCostText に
            集約し、ここは描くだけ（掟10）。 */}
        <p className="text-xs font-semibold text-brand-red leading-relaxed">
          {minimumCostText({ workerPlans, lbPlans })}
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
                onChange={e => { setClusterName(e.target.value); touch('clusterName') }}
                placeholder="例: myapp"
                className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
              />
            </div>

            {/* 詳細設定（ポート・ノード数）は既定のままで作れるので畳む
                （判断7・利用者目線レビュー・2026-09-11）。既定で見えるのはクラスタ名・ゾーン・
                ワーカプラン・ロードバランサプラン・構成図・作成ボタンだけ。
                F-1（2026-09-16）: Let's Encrypt メール欄はここから消した（⑧に一本化）。 */}
            <details className="rounded-lg border border-line bg-overlay p-3 space-y-3">
              <summary className="cursor-pointer select-none text-xs font-semibold text-ink-secondary hover:text-ink">詳細設定（ふつうは変えなくてよい）</summary>
              <p className="text-[11px] text-ink-muted leading-relaxed">
                既定のままで作れます。ポートは 80/443、ノード数は最小1・最大1。
              </p>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-ink-secondary">公開ポート</label>
                <div className="space-y-1">
                  {ports.map((p, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="number"
                        value={p.port}
                        onChange={e => { updatePort(i, { ...p, port: Number(e.target.value) }); touch('ports') }}
                        className="w-24 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                      />
                      <select
                        value={p.protocol}
                        onChange={e => { updatePort(i, { ...p, protocol: e.target.value as 'http' | 'https' }); touch('ports') }}
                        className="bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                      >
                        <option value="http">http</option>
                        <option value="https">https</option>
                      </select>
                      {isReservedPort(p.port) && (
                        <span className="text-[11px] text-brand-red">⚠️ {RESERVED_PORT_RANGE[0]}-{RESERVED_PORT_RANGE[1]}は予約で使えません</span>
                      )}
                      <button onClick={() => { removePort(i); touch('ports') }} className="text-[11px] text-ink-muted hover:text-brand-red">削除</button>
                    </div>
                  ))}
                </div>
                <button onClick={() => { addPort(); touch('ports') }} className="text-[11px] text-sakura hover:underline">+ ポートを追加</button>
                {/* G-1-c（2026-09-16）: 消してよいと誤解されがちな2つのポートに、その場で理由を添える。 */}
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  「80（http）」と「443（https）」は消さないでください。80は独自ドメインの証明書を受け取るために、443はアプリの受け口として必要です。
                </p>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-[11px] text-ink-secondary">ノード数 min</label>
                <input
                  type="number" min={1} max={10} value={minNodes}
                  onChange={e => { setMinNodes(Number(e.target.value)); touch('nodes') }}
                  className="w-16 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                />
                <label className="text-[11px] text-ink-secondary">max</label>
                <input
                  type="number" min={1} max={10} value={maxNodes}
                  onChange={e => { setMaxNodes(Number(e.target.value)); touch('nodes') }}
                  className="w-16 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                />
              </div>
            </details>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">サービスプリンシパルID</label>
              <p className="text-xs text-ink font-mono select-text">{resourceId || '（②で入力してください）'}</p>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">ゾーン</label>
              {zoneSelectable ? (
                <select
                  value={selectedZoneName ?? ''}
                  onChange={e => { setSelectedZoneName(e.target.value); touch('zone') }}
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
                  onChange={e => { setZone(e.target.value); touch('zone') }}
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
                    onChange={e => { setSelectedWorkerPath(e.target.value); touch('workerPlan') }}
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
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">ロードバランサプラン</label>
              {lbPlans && lbPlans.some(p => p.path) ? (
                <>
                  <select
                    value={selectedLbPath ?? ''}
                    onChange={e => { setSelectedLbPath(e.target.value); touch('lbPlan') }}
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

            {/* 簡易構成図（いま選んでいる内容がそのまま反映される・自前の枠と文字のみ）。
                月額はここで計算し直さない——priceSummary の text をそのまま使う（掟10）。 */}
            <div className="rounded-lg border border-line bg-overlay p-3 space-y-0.5">
              <p className="font-mono text-[11px] leading-relaxed text-ink select-text whitespace-pre-wrap">{diagram.lines.join('\n')}</p>
              <p className="text-xs font-semibold text-ink select-text pt-1.5 mt-1 border-t border-line-soft">{diagram.total}</p>
            </div>

            {/* ⚠️の全体表示は、フィールド側に専用表示が無い欄だけ（ワーカ/LBプランは欄の
                すぐ下に出るため、ここには出さない・判断7・2026-09-11）。触った欄／送信後だけ
                出す（visibleFormErrors）。 */}
            {generalErrors.map((msg, i) => (
              <p key={i} className="text-xs text-brand-yellow leading-relaxed">⚠️ {msg}</p>
            ))}

            <button
              onClick={() => { setSubmitted(true); void doCreate() }}
              disabled={hasErrors || panelBusy({ creating, tearingDown, publishing, lbRefreshing })}
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
                {/* 判断2: ⑤の失敗にも「🤖 AIに相談する」を添える（成功時には出さない）。 */}
                {!createResult.ok && (
                  <button
                    onClick={() => {
                      const text = askAiAboutFailure('公開', 'さくらのAppRun（専有型）', createResult.message ?? '失敗しました')
                      window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text } }))
                    }}
                    className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
                  >🤖 AIに相談する</button>
                )}
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
                {buildTeardownSummary(teardownSummaryRecord, { worker: workerPlans, lb: lbPlans }).lines.map((line, i) => (
                  <p key={i} className="text-xs text-ink-secondary select-text">{line}</p>
                ))}
              </div>
              <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
                {appRecord?.applicationID && <li>アプリ『{appRecord.applicationName ?? appRecord.applicationID}』（バージョン {appRecord.activeVersion ?? '不明'}）</li>}
                {apprunState?.loadBalancerID && <li>ロードバランサ『{apprunState.loadBalancerID}』</li>}
                {apprunState?.asgID && <li>オートスケーリンググループ『{apprunState.asgID}』</li>}
                {apprunState?.clusterID && <li>クラスタ『{apprunState.clusterID}』</li>}
              </ul>
              <button
                onClick={doTeardown}
                disabled={panelBusy({ creating, tearingDown, publishing, lbRefreshing })}
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
              {/* 判断2: ⑥の失敗にも「🤖 AIに相談する」を添える（成功時には出さない）。 */}
              {!teardownResult.ok && (
                <button
                  onClick={() => {
                    const text = askAiAboutFailure('破棄', 'さくらのAppRun（専有型）', teardownResult.message ?? '失敗しました')
                    window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text } }))
                  }}
                  className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
                >🤖 AIに相談する</button>
              )}
              {teardownResult.inProgress ? (
                // #39: 待ち切れず(timeout)止まっただけ。記録は残っている＝⑥をもう一度押せば再開できる
                // （赤い「残っています＝課金が続きます」＝失敗、とは区別する黄色い注意）。
                <div className="space-y-1 rounded-lg border border-brand-yellow/70 bg-overlay p-3">
                  <p className="text-xs font-semibold text-brand-yellow leading-relaxed">
                    削除中です。しばらくして⑥をもう一度押してください。
                  </p>
                  <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
                    {/* B（2026-09-17）: 削除順（アプリ→ロードバランサ→ASG→クラスタ）に揃える。 */}
                    {teardownResult.inProgress.applicationID && <li>アプリケーション『{teardownResult.inProgress.applicationID}』</li>}
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
                    {/* B（2026-09-17）: 削除順（アプリ→ロードバランサ→ASG→クラスタ）に揃える。 */}
                    {teardownResult.remaining.applicationID && <li>アプリケーション『{teardownResult.remaining.applicationID}』</li>}
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
          （プロジェクト単位のため）。この後ろに⑧「アプリを公開する」が続く（D-4・クラスタが
          揃っているときだけ出る条件付きの節）。専有型の⑧（アプリを公開する）と共用型の⑧
          （ログ・メトリクス）は番号が同じで指す機能が違うが、それで構わない（番号は付け直さない・
          ファイル冒頭のコメント参照）。 */}
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
        ) : collapseTelemetry ? (
          // F-1 B-1（2026-09-16）: すべて繋がっていて、行動（ボタン）も要らないときだけ1行に畳む
          // （Ryosuke さんの指摘: ✅が6行常時出ると、隣の⑥の赤い警告の重みが薄れる）。既存の
          // 「詳細設定」と同じ <details> の書き方に合わせる（独自の開閉を作らない）。
          <details className="rounded-lg border border-line bg-overlay p-3">
            <summary className="cursor-pointer select-none text-xs font-semibold text-ink-secondary hover:text-ink">✅ ログ・メトリクス 繋がっています</summary>
            <ul className="text-xs text-ink-secondary space-y-0.5 pl-1 mt-2">
              {telemetryVariants.map(v => (
                <li key={v.variant}>{v.routed ? '✅ ' : '・'}{v.label}{v.routed ? ' 繋がっています' : ' 未接続'}</li>
              ))}
            </ul>
          </details>
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
                        disabled={telemetryBusyKind === kind || panelBusy({ creating, tearingDown, publishing, lbRefreshing })}
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
                            disabled={telemetryBusyKind === kind || panelBusy({ creating, tearingDown, publishing, lbRefreshing })}
                            className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
                          >{telemetryBusyKind === kind ? '用意しています…' : '用意する（費用に同意）'}</button>
                          <button
                            onClick={() => setTelemetryConfirmingKind(null)}
                            disabled={telemetryBusyKind === kind || panelBusy({ creating, tearingDown, publishing, lbRefreshing })}
                            className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura disabled:opacity-40"
                          >やめる</button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setTelemetryError(''); setTelemetryConfirmingKind(kind) }}
                        disabled={panelBusy({ creating, tearingDown, publishing, lbRefreshing })}
                        className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-40"
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

      {/* ⑧ アプリを公開する（D-4・2026-09-15。段階③⑤）。クラスタ・ASG・LB が揃っているときだけ出す
          （shouldShowPublishSection・apprunDedicatedActions.ts）。⑦の後ろに置き、番号は付け直さない
          （理由はファイル冒頭のコメント）。 */}
      {shouldShowPublishSection(apprunState) && (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <p className="text-sm font-semibold text-ink">⑧ アプリを公開する</p>
          <p className="text-xs text-ink-secondary leading-relaxed">
            クラスタの上にこのプロジェクトのアプリを載せて、<b className="text-ink">自分のドメイン名</b>で公開します。
            公開のあと、DNS の A レコードの設定が要ります（ロードバランサの IP が複数なら A レコードも複数）。
          </p>
          {/* D-8（2026-09-16）: 像のフォルダに書き込みを与えたので、アプリは自分でフォルダ・ファイルを
              作れる。ただしコンテナは使い捨てで、書いたデータは公開し直さなくても消える。文言は
              ephemeralDataNote（shared/publishLabels.ts）に一元化（掟10）。
              ⚠️ 体裁（検分の指摘・2026-09-16）: ここは `text-[11px] text-ink-muted` ＝**パネルで
              いちばん小さく薄い字**だった。**いちばん取り返しがつかない注意**（データが消える）が
              いちばん拾いにくい体裁で置かれていた。本文と同じ `text-xs text-ink-secondary` にし、
              独自ドメイン・費用の注意と同じく**太字**で立てる。 */}
          <p className="text-xs font-semibold text-ink-secondary leading-relaxed">{ephemeralDataNote()}</p>
          {appRecord?.applicationID && (
            <div className="space-y-1">
              <p className="text-xs text-brand-green leading-relaxed select-text">
                公開中: https://{appRecord.hosts?.[0] ?? '（ホスト名不明）'}/（バージョン {appRecord.activeVersion ?? '不明'}・
                {appRecord.appPublishedAt ? new Date(appRecord.appPublishedAt).toLocaleString('ja-JP') : '公開日時不明'}）
              </p>
              {/* D-5: 記録の lbAddresses（素の IP）を常時出す。無ければ「まだ取れていません」＋取り直しボタン
                  （LB ノードのアドレスは付くまで数分かかることがある・5-13）。 */}
              {appRecord.lbAddresses && appRecord.lbAddresses.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink">
                  <span>DNS の A レコード:</span>
                  {appRecord.lbAddresses.map(ip => (
                    <span key={ip} className="flex items-center gap-1"><span className="font-mono select-text">{ip}</span><CopyButton text={ip} title="IPをコピー" /></span>
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-xs text-brand-yellow leading-relaxed">IP がまだ取れていません（ロードバランサに IP が付くまで数分かかることがあります）。</p>
                  {lbRefreshButton}
                </div>
              )}
              {/* D-4h（2026-09-16 実機で判明）: IP を直接開くと LB が 404 を返す・https は証明書が
                  発行されるまで開けない（かかる時間は実際のさくらのサーバーで未確認・D-13 B）、の
                  案内を1関数（dnsGuidanceLines）から出す。文字列は publishLabels.ts に一元化（掟10）。 */}
              {dnsGuidanceLines(appRecord.hosts?.[0] ?? '（ホスト名不明）').map((line, i) => (
                <p key={i} className="text-[11px] text-ink-muted leading-relaxed">{line}</p>
              ))}
              {/* O-1（2026-09-17）: DNS を設定したあと、本当に開けるのかを確かめる口。
                  公開直後の確認（verify）とは時間軸が違うので、別のボタンにしてある。 */}
              {siteCheckBlock}
            </div>
          )}
          {!keyReady ? (
            <p className="text-[11px] text-brand-yellow leading-relaxed">①で登録してください。</p>
          ) : !appStatus ? (
            appStatusError ? <ErrorBlock msg={appStatusError} /> : <p className="text-xs text-ink-secondary">確認しています…</p>
          ) : appStatus.envReady === false ? (
            <div className="space-y-2">
              <p className="text-xs text-brand-yellow leading-relaxed">公開の設定（env.json）がまだありません。</p>
              <button
                onClick={() => { void doScaffoldEnv() }}
                disabled={scaffolding}
                className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-40"
              >{scaffolding ? '作っています…' : '公開の設定を作る'}</button>
              {scaffoldError && <ErrorBlock msg={scaffoldError} />}
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-ink-secondary">ホスト名（自分のドメイン名・小文字）</label>
                {/* 即時検査（HOSTNAME_PATTERN）: 入力中に不一致なら枠を黄色にする。文言は下の publishErrors
                    （computePublishFormErrors）に1か所だけ出す（同じ文を2か所に出さない）。 */}
                <input
                  value={host}
                  onChange={e => setHost(e.target.value)}
                  placeholder="例: app.example.com"
                  className={`w-full bg-elevated border rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura ${hostTrimmed && !hostOk ? 'border-brand-yellow' : 'border-line'}`}
                />
              </div>
              {/* F-1 A-2（2026-09-16）: 3状態を言い分ける。false→必須で出す・null→任意で出す・
                  true→出さない（かわりに設定済みの旨を出す。アドレスそのものは API が返さないので出せない）。 */}
              {showLeEmailField ? (
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-ink-secondary">
                    Let&apos;s Encrypt のメールアドレス{needsLeEmail ? '（必須）' : '（任意）'}
                  </label>
                  <input
                    value={leEmail}
                    onChange={e => setLeEmail(e.target.value)}
                    placeholder="例: you@example.com"
                    className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                  />
                  <p className="text-[11px] text-ink-muted leading-relaxed">
                    {needsLeEmail
                      ? '独自ドメインで https を使うために必要です。公開のときにクラスタへ設定します。'
                      : '設定済みかどうかを確かめられませんでした。設定済みなら、空のままで大丈夫です。'}
                  </p>
                  {/* F-1 A-4: 専有型には証明書なしで公開する道が無い（ホスト名必須・Let's Encrypt固定）。
                      メールを出したくない・独自ドメインが要らない人向けの出口。共用型タブは
                      PublishModal.tsx に既にあるので、そこへ戻るよう文で案内する（導線は既存のものを指す）。 */}
                  <p className="text-[11px] text-ink-muted leading-relaxed">
                    メールアドレスを入れたくない・独自ドメインが要らないときは、上のタブから「共用型」を選ぶと公開できます。さくらが用意する住所で、https も自動です。
                  </p>
                </div>
              ) : (
                appStatus.hasLetsEncryptEmail === true && (
                  <p className="text-[11px] text-brand-green leading-relaxed">✅ Let&apos;s Encrypt のメールは設定済みです（アドレスそのものはここには表示できません）。</p>
                )
              )}
              <details className="rounded-lg border border-line bg-overlay p-3">
                <summary className="cursor-pointer select-none text-xs font-semibold text-ink-secondary hover:text-ink">詳細設定（ふつうは変えなくてよい）</summary>
                <p className="text-[11px] text-ink-muted leading-relaxed mt-1">既定のままで公開できます。1台構成でも更新できるよう、既定は小さめです。</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label className="text-[11px] text-ink-secondary">mCPU</label>
                  <input
                    type="number" min={100} max={64000} step={100} value={appCpu}
                    onChange={e => setAppCpu(Number(e.target.value))}
                    className="w-20 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                  />
                  <label className="text-[11px] text-ink-secondary">メモリ(MB)</label>
                  <input
                    type="number" min={128} max={131072} value={appMemory}
                    onChange={e => setAppMemory(Number(e.target.value))}
                    className="w-24 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                  />
                  <label className="text-[11px] text-ink-secondary">台数</label>
                  <input
                    type="number" min={1} max={50} value={appFixedScale}
                    onChange={e => setAppFixedScale(Number(e.target.value))}
                    className="w-16 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                  />
                </div>
                <div className="mt-2 space-y-1">
                  <label className="text-[11px] font-medium text-ink-secondary">ヘルスチェックのパス</label>
                  <input
                    value={healthCheckPath}
                    onChange={e => setHealthCheckPath(e.target.value)}
                    placeholder="空なら env.json の probePath を使います（例: /health）"
                    className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
                  />
                </div>
              </details>
              {publishErrors.map((msg, i) => (
                <p key={i} className="text-xs text-brand-yellow leading-relaxed">⚠️ {msg}</p>
              ))}
              <button
                onClick={() => { void doPublish() }}
                disabled={publishErrors.length > 0 || panelBusy({ creating, tearingDown, publishing, lbRefreshing })}
                className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >{publishing ? '公開しています…' : publishButtonLabel(appPublished)}</button>
              {/* H-1: 押せない理由を書く。**理由の分からない無効化は、壊れているのと区別がつかない。** */}
              {!publishing && panelBusy({ creating, tearingDown, publishing, lbRefreshing }) && (
                <p className="text-xs text-brand-yellow leading-relaxed">{panelBusyReason({ creating, tearingDown, publishing, lbRefreshing })}</p>
              )}
              {publishing && publishProgress && (
                <p className="text-xs text-ink-secondary leading-relaxed">{publishProgress}</p>
              )}
            </>
          )}

          {publishResult && (
            <div className="space-y-1">
              {/* D-7: 成功の見出しは publishHeadline（shared/publishLabels.ts）が決める。
                  公開の手続きが通っても、アプリが応答していなければ（503＝no-backend）
                  「✅ 公開しました」とは言わない（2026-09-16 実機の事故）。 */}
              <p className={publishResult.ok
                ? (publishHeadline(publishResult.verify).tone === 'ok' ? 'text-xs font-semibold text-brand-green' : 'text-xs font-semibold text-brand-red')
                : 'text-xs font-semibold text-brand-red'}>
                {publishResult.ok ? publishHeadline(publishResult.verify).text : `⚠️ 途中で止まりました（${PUBLISH_STAGE_LABEL[publishResult.stage as PublishAppStage] ?? publishResult.stage}）`}
              </p>
              {publishResult.ok ? (
                <>
                  {/* 確かめた結果は必ず一文添える（確認をとばしたときは verify が無いので出さない・
                      とばした理由は warnings に載る）。黙って成功に見せない。 */}
                  {publishResult.verify && (
                    <p className={dedicatedVerifyNotServing(publishResult.verify) ? 'text-xs text-brand-red leading-relaxed select-text' : 'text-xs text-ink-secondary leading-relaxed select-text'}>
                      {dedicatedVerifyMessage(publishResult.verify)}
                    </p>
                  )}
                  {/* D-13 G（2026-09-16）: すぐ上の一文（dedicatedVerifyMessage）は
                      コントロールパネルで記録を見るよう案内するのに、**その場に行き先が無かった**。
                      **直し方のある失敗を、直し方の分からない失敗として見せない**（回復の導線は
                      全経路に出す）。⑥の「残っています」と同じ形・同じ CONTROL_PANEL_URL を使う。 */}
                  {/* D-19b（検分・2026-09-16）: 出す条件は dedicatedVerifyNotServing（shared/publishVerify.ts）に
                      集約した。503 だけでなく、404・502・504 のような失敗応答（error-status）でも
                      すぐ上の一文が案内する確認先へ行けるようにする——
                      **どの結果が「開けない」かの判断を画面に散らさない**（掟10）。 */}
                  {dedicatedVerifyNotServing(publishResult.verify) && (
                    <a href={CONTROL_PANEL_URL} className="inline-block text-[11px] text-sakura hover:underline">🔧 コントロールパネルを開く</a>
                  )}
                  {/* D-8（2026-09-16 実機）: 応答していないとき（no-backend）だけ main が引いてくる
                      コンテナの状態。**文字列は原本の値のまま**出す（勝手に日本語へ言い換えない・掟1）。
                      1行にするのは純関数 containerStateSummary（shared/publishLabels.ts）で、
                      画面は描くだけ（掟10）。 */}
                  {publishResult.containerStates && (
                    <p className="text-xs text-ink-secondary leading-relaxed select-text">
                      {containerStateSummary(publishResult.containerStates)}
                    </p>
                  )}
                  {publishResult.url && (
                    <div className="flex items-center gap-2 text-xs text-ink">
                      <span className="font-mono select-text break-all">{publishResult.url}</span>
                      <CopyButton text={publishResult.url} title="公開URLをコピー" />
                    </div>
                  )}
                  {/* D-7b・C（検分の指摘）: no-backend（503）のときは、DNS の案内より先に
                      すぐ上の dedicatedVerifyMessage（コントロールパネルでの確認先まで
                      案内する一文）を読んでもらう。次の一手を1つに絞るため、DNS の案内
                      （IP・コピー・dnsGuidanceLines）は <details>（閉じた状態）に畳む。
                      判断は純関数 showDnsGuidanceExpanded（shared/publishLabels.ts）に
                      集約し、画面は描くだけ（掟10）。 */}
                  {(() => {
                    const dnsBlock = (
                      <>
                        <p className="text-xs font-semibold text-ink leading-relaxed">DNS の A レコードをこの IP に向けてください:</p>
                        {publishResult.lbAddresses && publishResult.lbAddresses.length > 0 ? (
                          <ul className="text-xs text-ink-secondary space-y-0.5 pl-1">
                            {publishResult.lbAddresses.map(ip => (
                              <li key={ip} className="flex items-center gap-2"><span className="font-mono select-text">{ip}</span><CopyButton text={ip} title="IPをコピー" /></li>
                            ))}
                          </ul>
                        ) : (
                          <div className="space-y-1">
                            <p className="text-xs text-brand-yellow leading-relaxed">IP を取得できませんでした。コントロールパネルのロードバランサで確認してください。</p>
                            {/* D-5: 付くまで数分かかることがあるので、ここからも取り直せる（同じボタン）。 */}
                            {lbRefreshButton}
                          </div>
                        )}
                        {/* D-4h（2026-09-16 実機で判明）: IP を直接開くと LB が 404 を返す・https は証明書が
                            発行されるまで開けない（かかる時間は実際のさくらのサーバーで未確認・D-13 B）、の
                            案内を1関数（dnsGuidanceLines）から出す。文字列は publishLabels.ts に一元化（掟10）。 */}
                        {dnsGuidanceLines(hostTrimmed).map((line, i) => (
                          <p key={i} className="text-[11px] text-ink-muted leading-relaxed">{line}</p>
                        ))}
                      </>
                    )
                    return showDnsGuidanceExpanded(publishResult.verify) ? dnsBlock : (
                      <details className="rounded-lg border border-line bg-overlay p-3">
                        <summary className="cursor-pointer select-none text-xs font-semibold text-ink-secondary hover:text-ink">アプリが応答したら、DNS の設定に進みます</summary>
                        <div className="mt-2 space-y-2">{dnsBlock}</div>
                      </details>
                    )
                  })()}
                  {publishResult.warnings && publishResult.warnings.length > 0 && (
                    <ul className="text-xs text-brand-yellow leading-relaxed list-disc pl-5">
                      {publishResult.warnings.map((w, i) => <li key={i} className="select-text">{w}</li>)}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <ErrorBlock msg={publishResult.message} />
                  {publishResult.detail && <ErrorBlock msg={publishResult.detail} />}
                  {publishResult.stage === 'lets-encrypt' && (
                    <p className="text-xs text-brand-yellow leading-relaxed">Let&apos;s Encrypt のメールがクラスタに未設定です。上のメール欄に入力して、もう一度お試しください。</p>
                  )}
                  {/* D-4f: hint:'reset-registry'（レジストリの接続情報が古い）は、共用型タブの
                      「レジストリを設定し直す」ボタンへ誘導する1文だけ出す（ボタン自体は複製しない・
                      publishFailureHintText・src/shared/publishLabels.ts）。 */}
                  {publishFailureHintText(publishResult.hint) && (
                    <p className="text-xs text-brand-yellow leading-relaxed">{publishFailureHintText(publishResult.hint)}</p>
                  )}
                  {/* 判断2: ⑧の失敗にも「🤖 AIに相談する」を添える（成功時には出さない）。detail も渡す（askAi.ts の第4引数）。 */}
                  <button
                    onClick={() => {
                      const text = askAiAboutFailure('公開', 'さくらのAppRun（専有型）', publishResult.message ?? '失敗しました', publishResult.detail)
                      window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text } }))
                    }}
                    className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
                  >🤖 AIに相談する</button>
                </>
              )}
            </div>
          )}
        </section>
      )}
      {confirmElement}
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
