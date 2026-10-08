import type { ApprunDedicatedPlanRow } from '../shared/apprunDedicatedShapes'

// 専有型③「使えるプランと制限」の自動取得（C・2026-09-17 Ryosuke さん指摘／2026-09-24 再指摘）。
//
// ── なぜ自動にしてよいのか ────────────────────────────────────────────
// ③が取るのは**制限値・プラン一覧・既存クラスタの件数**だけで、画面にも
// 「何も作らず、何も変更しません」と書いてある（GET のみ・課金も発生しない）。
// 利用者に割り当てられた情報を見ているだけなので、**押させる理由が無い**。
// 認証情報（さくらのクラウドAPIキー）が揃った時点で、こちらから取りに行く。
//
// ── 自動にしてよい操作の線引き（ここを緩めない）──────────────────────────
// **自動で行ってよいのは「何も作らず・何も変えない」取得だけ。**
// ⑤クラスタを作る・⑥破棄する・⑧公開する は、**作る／消す／変える**操作なので
// 自動にしない（確認ダイアログと費用の同意はそのまま。掟10）。
//
// ── 何度も取りに行かないための記憶 ──────────────────────────────────
// 画面（パネル）は公開ダイアログを開き直すたびに作り直される（App.tsx の
// `{showPublish && <PublishModal .../>}`）。コンポーネント内の ref だけで覚えると
// **開き直すたびに4本の GET が飛ぶ**ので、モジュール側に覚える（zonesCache.ts と同じ発想）。
//
// **覚えるのは「試した」ではなく取得した中身そのもの**（2026-09-24 検分の指摘1・2・3）。
// 直す前は「このキーではもう試した」だけをモジュールに置き、取れた中身はパネルの state に
// 置いていた。公開ダイアログを閉じると中身だけが消え、開き直すと「試し済み」だから自動取得は
// 走らず、失敗フラグも初期値に戻るので「🔍 調べる」も出ない——③が永久に空のまま、
// ⑤のプランを選べず**クラスタを作れない行き止まり**になっていた。
// 記憶の寿命（モジュール）と中身の寿命（モジュール）を揃え、開き直したら**記憶から復元する**。
// キーを切り替えたときは別のキーとして扱う＝取り直してよい（前のキーの一覧は使えない）。

/** ③が取得した中身（開き直したときに復元するもの）。ゾーン一覧は zonesCache.ts が持つのでここには入れない。 */
export type InvestigateSnapshot = {
  limits: Record<string, number | null> | null
  limitsError: string | null
  workerPlans: ApprunDedicatedPlanRow[] | null
  workerError: string | null
  lbPlans: ApprunDedicatedPlanRow[] | null
  lbError: string | null
  clusterInfo: { count: number; hasMore: boolean } | null
  clusterError: string | null
  checkError: string | null
}

/** ③を自動で取りに行ってよいかの判断材料。 */
export type AutoInvestigateInput = {
  /** ①のさくらのクラウドAPIキーが登録されているか（null＝まだ確かめていない）。 */
  hasKey: boolean | null
  /** いま③の取得が走っているか。 */
  checking: boolean
  /** 使用中のキーの識別子（無ければ null）。切り替えたら取り直す。 */
  keyId: string | null
  /**
   * キーの一覧（と使用中のID）の読み込みが終わっているか（2026-09-24 検分の指摘6・11）。
   * 終わる前は `keyId` がまだ null で、**実際に使うキーと違う識別子**で覚えてしまう。
   */
  keysReady: boolean
}

// 「取りに行った（結果待ちを含む）」——同じ描画で二重に投げないための記憶。
const attempted = new Set<string>()
// 取得した中身。**これがあるかぎり取りに行かない／開き直したら復元する。**
const snapshots = new Map<string, InvestigateSnapshot>()

function tokenOf(keyId: string | null | undefined): string {
  return keyId ?? '(既定のキー)'
}

/**
 * ③を自動で取りに行ってよいか（純関数＋モジュール側の記憶）。
 *
 * - **キーの一覧が確定する前は取りに行かない**（keysReady・指摘6/11）。先に投げると、
 *   実際に使うキーと違う識別子（'(既定のキー)'）で覚えてしまい、次に開いたときに
 *   同じキーなのに「別物」として4本の GET を投げ直すことになる。
 * - **認証情報が無いときは取りに行かない**（hasKey が true 以外＝未登録・未確認）。
 *   キーを登録していないだけの利用者に、開いた瞬間エラーを見せないため。
 * - 走っている最中は重ねて投げない。
 * - **取得した中身をもう持っているなら投げない**（開き直しは復元で済ませる）。
 * - 投げた直後（結果待ち）も投げ直さない。結果を記憶できずに終わった場合
 *   （取得の途中でキーが切り替わった等）は中身が無いので、画面には「🔍 調べる」が出る
 *   （shouldShowInvestigateButton が中身の有無を見る）——行き止まりにしない。
 */
export function shouldAutoInvestigate(s: AutoInvestigateInput): boolean {
  if (!s.keysReady) return false
  if (s.hasKey !== true) return false
  if (s.checking) return false
  const token = tokenOf(s.keyId)
  if (snapshots.has(token)) return false
  return !attempted.has(token)
}

/** このキーでは自動取得を試みた、と覚える（投げる直前に呼ぶ）。 */
export function markAutoInvestigated(keyId: string | null): void {
  attempted.add(tokenOf(keyId))
}

/**
 * 取得した中身を覚える（成功・失敗どちらも）。失敗もそのまま覚えるので、開き直したときは
 * **失敗したという表示ごと**戻り、「🔍 調べる」も出せる（押し直す手段を消さない）。
 */
export function rememberInvestigateSnapshot(keyId: string | null, snapshot: InvestigateSnapshot): void {
  snapshots.set(tokenOf(keyId), snapshot)
}

/** 覚えている中身を返す（無ければ null）。パネルはマウント時にこれを state へ戻す。 */
export function recallInvestigateSnapshot(keyId: string | null): InvestigateSnapshot | null {
  return snapshots.get(tokenOf(keyId)) ?? null
}

/**
 * 記憶（試したか・中身の両方）を捨てる。
 * **'sakura:credentials-changed' を受けた画面から呼ぶ**（2026-09-24 検分の指摘8）:
 * 同じ id のまま token/secret だけ書き換えられた場合、keyId は変わらないので、
 * 捨てないと**前のアカウントの制限値・既存クラスタ件数**が残り続ける。
 */
export function forgetInvestigated(): void {
  attempted.clear()
  snapshots.clear()
}

/** 記憶を捨てる（テスト用の別名。画面からは forgetInvestigated を使う）。 */
export function resetAutoInvestigated(): void {
  forgetInvestigated()
}

/**
 * ③の取得が失敗したか（4本のうち1本でも失敗したら失敗扱い）。
 * **成功しているのに「🔍 調べる」を出し続けないため**の判定（掟10・判断を画面に散らさない）。
 */
export function investigateFailed(s: {
  checkError?: string | null
  limitsError?: string | null
  workerError?: string | null
  lbError?: string | null
  clusterError?: string | null
}): boolean {
  return !!(s.checkError || s.limitsError || s.workerError || s.lbError || s.clusterError)
}

/**
 * ③のボタンの見出し（null＝出さない）。**判断はここ1か所**（掟10）。
 *
 * - 認証情報が無いときは出さない——次の一手は①のキー登録であって、③を押すことではない。
 * - 取得に失敗した／まだ中身が無いときは「🔍 調べる」。**中身が無いのに何も出さないと、
 *   利用者は③を取り直せなくなる**（2026-09-24 検分の指摘2・3。行き止まりの保険）。
 * - 取れているときは「🔄 最新にする」を**控えめに**残す（指摘12）。コントロールパネル側で
 *   クラスタを増減しても③の件数・上限が古いままになるため、取り直す道を1つ用意する。
 *   「押さないと進まない」と読ませない文言にして、自動取得の趣旨と両立させる。
 */
export function investigateButtonLabel(s: {
  hasKey: boolean | null
  failed: boolean
  hasSnapshot: boolean
}): '🔍 調べる' | '🔄 最新にする' | null {
  if (s.hasKey !== true) return null
  if (s.failed) return '🔍 調べる'
  if (!s.hasSnapshot) return '🔍 調べる'
  return '🔄 最新にする'
}

/** ③のボタンを出すか（判断は investigateButtonLabel に集約。ここは有無だけ）。 */
export function shouldShowInvestigateButton(s: {
  hasKey: boolean | null
  failed: boolean
  hasSnapshot: boolean
}): boolean {
  return investigateButtonLabel(s) !== null
}
