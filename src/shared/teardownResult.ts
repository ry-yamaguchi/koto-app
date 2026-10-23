// teardownResult.ts — 破棄（削除）の結果を、公開先によらない1つの形（TeardownView）に読み直す純関数。**定義はこの1か所**（掟10）。
//
// ── なぜ1か所か ───────────────────────────────────────────────────────────────────
// 破棄の結果の読み手は、これまで公開先ごと・入口ごとに別々に書かれていた（専有型の結果欄・共用型の AppRunPanel・
// HANAMII の HanamiiOpResult・一覧の result.text・サイドバーの alert、そして main の summarizeResult）。
// 同じ返り値を、画面が「その場」で読むのと、閉じて開き直したあとに main の記録（summarizeResult を通ったもの）から
// 読むのとで、見出しや警告が食い違うと、月額が続く警告を見逃す穴になる（2026-09-30 検分の指摘6と同じ形）。
// そこで、その場の返り値（toTeardownView）も、開き直したときの記録（resumedTeardownView）も、
// **同じ TeardownView に直す**。2つが同じ返り値から同じ形を作ることは、tests/teardownResultCommon.test.ts が
// 本物の summarizeResult を通して固定する。
//
// ── 文の作り手は、この2つの関数だけ（段階1で一本化した）────────────────────────────────────
// ・警告の文は、**この teardownWarningsOf と reportedLinesOf だけが作る**。main/projectOps.ts の summarizeResult は
//   この2つを呼ぶだけで、自分では文を作らない（段階0では summarizeResult の写しだった。段階1で呼ぶ形に直した）。
//   その場の画面（toTeardownView）も開き直した画面（summarizeResult を通した記録）も、同じ2つの関数を通るので、文が食い違わない。
// ・まだ警告にしていない事実を足すときは、**この2つの関数に足す**（summarizeResult には足さない）。
//   今のところ足していないのは、共用型の skipped。**警告にしない**と決めた（段階2）: skipped は公開（cloud:apply）も返し、
//   「段階3で対応」のような公開の行まで警告になるため。鍵の無効化の失敗は、main が executed の ⚠️ の行にする
//   （reportedLinesOf が警告へ移す。HANAMII・専有型と同じ道）。
// ・段階0では、どの入口・どの IPC からもまだ呼ばれなかった。最初の利用者は段階1の HANAMII。
// ・専有型のファイル（apprunDedicatedActions.ts など）は import しない（段階3の最後に載せ替えるとき輪にならないように、
//   定数も読み方も写してここに置く）。
//
// electron にも React にも依存しない。node の path/fs も import しない（renderer から読まれる。tests/appChatDirs.test.ts）。
import type { PublishTargetKind } from './publishMeta'
import { readStageTimings, type StageTimings } from './stageTiming'
import { isRegistryOrigin, teardownRemainingWarnings } from './cloudCost'
import { hasWarnMark } from './opsText'
import { STORAGE_LISTED_CHECK } from './teardownSupport'
import { isStoppedByQuit } from './inFlightOps'
import { teardownCallOf, teardownStateOf, type TeardownCall } from './teardownCall'

/**
 * 警告の書き出し。**定義はこの1か所**（0.6.22 段階3B-2 で、専有型の apprunDedicatedActions.ts の同じ定数を消してここへ一本化した。
 * 専有型の開き直しの知らせ `resumedNoteOf` も、共通の resumedTeardownNote を通ってここを使う）。警告の文を作る teardownWarningsOf と同じこのファイルに置く——
 * 描く側（TeardownResultView）が import し、書き出しが main の実際の文と食い違わないようにする。
 */
const REMAINING_WARNING_TAIL = 'できずに残っているものがあります。残っている間は課金が続きます'
export const TEARDOWN_REMAINING_WARNING_HEAD = `削除${REMAINING_WARNING_TAIL}`
export const TEARDOWN_IN_PROGRESS_WARNING_HEAD = '削除の途中で、待ち切れずに止まりました'

/**
 * HANAMII が DELETE を受け付けただけで、まだ終わっていない回（`deletionAccepted: true`。原本は 202・`deleted=false`・`deletion=accepted`）の文。
 * main は 2xx で `deleted` が true でないものを全部この回に入れる（204・空の本文など、原本に例の無い形を含む）ので、文は「済んだと確認できなかった」と
 * 確かめた範囲で言い、「受け付けた」「まだ終わっていない」は可能性として添える（断定しない）。
 * main の `hanamii:teardown` が結果の message に使い、`teardownWarningsOf` が警告にも使う（同じ文の作り手を1つにする）。
 * 専有型の「待ち切れずに止まりました」（`TEARDOWN_IN_PROGRESS_WARNING_HEAD`）とは別の文——Koto が待ち切れなかったのではなく、HANAMII が受け付けただけ。
 */
export const HANAMII_DELETION_ACCEPTED_WARNING =
  'HANAMII の削除が済んだと確認できませんでした（受け付けただけで、まだ終わっていない場合があります）。しばらくしてから、もう一度破棄を押してください。保存場所と記録は、削除が確認できるまで残してあります。'

/**
 * 結果欄の赤い欄の書き出し。**警告の書き出し（TEARDOWN_REMAINING_WARNING_HEAD）の「削除」を、その流れの言葉（`TeardownWords.verb`）に替えたもの**
 * （1回の流れの中は公開先の言葉で1つ。見出しが「破棄できませんでした」なのに赤い欄だけ「削除できずに…」とは言わない）。
 * 動詞より後ろの文は警告の書き出しと同じ1つの定義から取る（描く側が文を書き写さない）。
 */
export function teardownRemainingHeadFor(verb: '破棄' | '削除'): string {
  return `${verb}${REMAINING_WARNING_TAIL}`
}

/** 記録が無い・読めないときの一言（apprunDedicatedActions.ts の RESULT_UNREADABLE と同じ文）。 */
export const TEARDOWN_RESULT_UNREADABLE = '結果を読み取れませんでした。コントロールパネルで、実際の状態を確かめてください。'

/**
 * 残ったもの1件。
 *   label   … 画面にそのまま出す名前（`アプリケーション『X』`・`保存場所『B』（月額が続きます）`）。summarizeResult の
 *             remainingNames と同じ文字列で、警告の文の中の名前の並びも、この label から作る（名前の作り手を1つにする）。
 *   billing … 残っている間、費用が続くことを画面が言うべきものか。残ったもの（remaining）は true、待ち切れず止まったもの
 *             （inProgress。削除の途中で、費用の話は警告の文が言う）は false。
 *   kind    … どの管理画面で消せるか。'service' は公開先の管理画面、'storage' は保存場所（さくらのクラウドのコントロールパネル）。
 */
export type TeardownLeftover = { label: string; billing: boolean; kind: 'service' | 'storage' }

export type TeardownView = {
  ok: boolean
  /** 見出しの3つ（✅ 済んだ／⏳ 途中／⚠️ できなかった）。HANAMII の `deletionAccepted: true`（受付済み）も inProgress にする。 */
  state: 'done' | 'inProgress' | 'failed'
  /** アプリ（HANAMII のプロジェクト・AppRun のアプリ）は消えたか。分からなければ null。 */
  appDeleted: boolean | null
  /** 起きたこと（⚠️・※ で始まる行は warnings へ移したあと）。 */
  executed: string[]
  message: string
  /** 消せずに残ったもの（失敗）。 */
  remaining: TeardownLeftover[]
  /** 待ち切れずに途中で止まったもの。 */
  inProgress: TeardownLeftover[]
  /** 見逃してはいけない知らせ（月額が続く等）。 */
  warnings: string[]
  stageTimings: StageTimings | null
  /**
   * 起動の読み戻しが置いた「Koto の終了で止まりました」の知らせ（記録の `extra.stoppedByQuit`）。**true のときだけ付け、false のときはキーごと付けない**
   * （必須の boolean にすると、型を丸ごと書いた既存の期待が割れる）。失敗ではない（state は 'inProgress'）ので、画面は「AIに相談する」を出さず、
   * 見出しは「に終わりました」と言わない。その場の返り値（toTeardownView）には付かない（知らせを作れるのは main の起動の読み戻しだけ）。
   */
  stoppedByQuit?: true
}

/** 記録（main/projectOps.ts の OpResult と同じ形）。renderer の型に依らないよう、ここで最小の形を持つ。 */
export type TeardownRecordResult = {
  ok?: boolean; message?: string; lines?: string[]; warnings?: string[]; extra?: Record<string, unknown>
} | null | undefined

// ── 小さな読み取り（形が違えば空に倒す。推測しない）──────────────────────────────────────
const asStr = (x: unknown): string => (typeof x === 'string' ? x : '')
const asStrList = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v !== '') : [])
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
/** 文字列だけの配列ならそれ、そうでなければ null（「無い」と「空」を分ける: 残したレジストリの借り手は、空なら「いない」、null なら「分からない」）。 */
const asStrListOrNull = (x: unknown): string[] | null => (Array.isArray(x) && x.every(v => typeof v === 'string') ? [...x] : null)

/** 同じ文は1度だけ（summarizeResult の addWarning と同じ。空の文は入れない）。 */
function pushUnique(list: string[], text: string): void {
  if (text && !list.includes(text)) list.push(text)
}

// ── 残ったもの ────────────────────────────────────────────────────────────────────────
/** 専有型の4つの ID。**削除の順**（アプリ → ロードバランサ → ASG → クラスタ）。名前は remainingNames（projectOps.ts）と同じ。 */
const SERVICE_NAMES: ReadonlyArray<readonly [key: string, name: string]> = [
  ['applicationID', 'アプリケーション'],
  ['loadBalancerID', 'ロードバランサ'],
  ['asgID', 'オートスケーリンググループ'],
  ['clusterID', 'クラスタ'],
]

function serviceLeftovers(x: unknown, billing: boolean): TeardownLeftover[] {
  if (!isObj(x)) return []
  const out: TeardownLeftover[] = []
  for (const [key, name] of SERVICE_NAMES) {
    if (asStr(x[key])) out.push({ label: `${name}『${asStr(x[key])}』`, billing, kind: 'service' })
  }
  return out
}

/** 残った保存場所1件。月額が続く（保存場所そのものが残っているとき）。 */
function storageLeftover(bucket: string): TeardownLeftover {
  return { label: `保存場所『${bucket}』（月額が続きます）`, billing: true, kind: 'storage' }
}

/**
 * 専有型: 返り値（記録なら extra）全体から、`remaining` の4つの ID ＋ 保存場所（最後）を読む。
 * 保存場所は `remainingBuckets`（残りの全件。保存場所が2件以上で途中で止まった回・段階3B-2）、無ければ `remaining.storageBucket`
 * （止まった1件。旧い返り値・段階3B-2より前の処理の記録を開き直したときも変わらない）。同じ名前は1つ。
 * `buildView` と `teardownWarningsOf` の両方がこれを呼ぶ（片方だけ直すと、画面の一覧と警告の名前が食い違う）。
 */
function dedicatedRemaining(v: Record<string, unknown>): TeardownLeftover[] {
  const remaining = v.remaining
  const out = serviceLeftovers(remaining, true)
  const many = asStrList(v.remainingBuckets)
  const names = many.length > 0 ? many : (isObj(remaining) && asStr(remaining.storageBucket) ? [asStr(remaining.storageBucket)] : [])
  for (const b of new Set(names)) out.push(storageLeftover(b))
  return out
}

/**
 * 残った保存場所の読み方（HANAMII と共用型が同じ1つを通る）: `remainingBuckets`（無ければ `remainingBucket`）の各保存場所。
 * 同じ名前は1つ。teardownWarningsOf の「消せずに残った」の文もこの読みから名前を作る（画面の一覧と警告の名前が食い違わない）。
 */
function hanamiiRemaining(x: Record<string, unknown>): TeardownLeftover[] {
  const many = asStrList(x.remainingBuckets)
  const names = many.length > 0 ? many : (asStr(x.remainingBucket) ? [asStr(x.remainingBucket)] : [])
  return Array.from(new Set(names)).map(storageLeftover)
}

/**
 * 共用型: 失敗（ok:false）の回に残った保存場所。成功（ok:true）の回は、残した保存場所があっても失敗ではないので
 * remaining に入れず、警告（keptBucketName(s)）だけが言う。
 *   ・`remainingBuckets`（無ければ `remainingBucket`）があれば、その全件（HANAMII と同じ読み。段階2で main が返すようになった）。
 *     `keptBucketName(s)`（ほかが使うので残した保存場所）は一覧に混ぜない。残した保存場所は警告だけが言う。
 *   ・**どちらも無い旧い返り値だけ**、今までの読み方に倒す: `keptBucketName` を1件。段階2より前に作られた処理の記録を
 *     開き直したとき、表示が変わらないようにする。`keptBucketName` は「利用者のファイルがあって残した」と「消すのに失敗して残った」を
 *     区別しない（どちらも state に bucket が残る）。月額が続くことは同じで、警告の文も変わらない。
 */
function sharedRemaining(ok: boolean, x: Record<string, unknown>): TeardownLeftover[] {
  if (ok) return []
  const listed = hanamiiRemaining(x)
  if (listed.length > 0) return listed
  return asStr(x.keptBucketName) ? [storageLeftover(asStr(x.keptBucketName))] : []
}

// ── 警告 ─────────────────────────────────────────────────────────────────────────────
/**
 * 返り値が**文のまま持っている**行と警告を、起きたこと（executed）と警告（warnings）に分ける。
 * **summarizeResult（main/projectOps.ts）の `addLine`・`verifyNote`・`warnings`・`notice` の部分の写し**（並びも同じ）:
 *   ・executed の各行・verifyNote … ⚠️・※ で始まれば警告、ほかは起きたこと
 *   ・warnings（文の配列）・notice（文） … そのまま警告
 *
 * 今の3つの破棄の IPC（hanamii:teardown・cloud:teardown・apprunDedicated:teardown）は warnings・notice・verifyNote を
 * 返さない。それでも読んでおく——新しい知らせは warnings で返すのが main の決まり（projectOps.ts の summarizeResult の注意）で、
 * 読まないと、段階1・2で破棄の返り値に warnings を足したとき、開き直した画面（記録から読む）にだけ警告が出て、
 * その場の画面からは消える（2026-09-30 検分の指摘6と同じ形）。
 *
 * **summarizeResult はこの関数を呼ぶ**（teardownWarningsOf と同じ。文の作り手を1つにする）。
 */
export function reportedLinesOf(raw: unknown): { executed: string[]; warnings: string[] } {
  const v = isObj(raw) ? raw : {}
  const executed: string[] = []
  const warnings: string[] = []
  const addLine = (t: string): void => {
    if (hasWarnMark(t)) pushUnique(warnings, t)
    else executed.push(t)
  }
  for (const t of asStrList(v.executed)) addLine(t)
  if (asStr(v.verifyNote)) addLine(asStr(v.verifyNote))
  for (const w of asStrList(v.warnings)) pushUnique(warnings, w)
  if (asStr(v.notice)) pushUnique(warnings, asStr(v.notice))
  return { executed, warnings }
}

/**
 * 返り値の事実から警告の文を作る。**警告の文の作り手はここ1つ**（summarizeResult〔main/projectOps.ts〕もこれを呼ぶ）。
 * 作る文（この並び）:
 *   ・teardownRemainingWarnings … 破棄したのに残した保存場所・レジストリ（月額が続く）。**「後で消す場合は削除して」は、このプロジェクトだけのもの
 *     （Koto が作り、ほかが使っていないレジストリ）にだけ言う**。借りたレジストリ・ほかのプロジェクトも使う保存場所は、「残しました」と、理由と、消すとどうなるかを言う
 *   ・専有型の inProgress（待ち切れずに止まった）／ ok でなく remaining があるとき（消せずに残った）
 *   ・HANAMII・共用型の remainingBuckets（無ければ remainingBucket）… ok でなく、専有型の remaining が無いとき（消せずに残った保存場所。
 *     専有型の「消せずに残った」と同じ文・同じ書き出し。専有型は remaining を返すので、ここは通らない）。共用型の旧い返り値
 *     （keptBucketName だけ）はここを通らず、上の teardownRemainingWarnings が言う
 *   ・HANAMII の deletionAccepted（HANAMII が削除を受け付けただけ）… HANAMII_DELETION_ACCEPTED_WARNING
 *     （専有型の inProgress の文〔Koto が待ち切れなかった〕とは別の文。事実が違う）
 *
 * 含めないもの:
 *   ・executed／verifyNote の ⚠️・※ の行と、返り値の warnings（文の配列）・notice（文）… reportedLinesOf の仕事
 *     （toTeardownView が先にそれを読み、そのあとにこの関数の文を足す。並びは summarizeResult と同じ）
 *   ・共用型の skipped … **警告にしない**（段階2で決めた）。skipped は公開（cloud:apply）の返り値にもあり、summarizeResult はすべての
 *     処理の記録でこの関数を呼ぶので、足すと公開の「段階3で対応」などの行まで警告になる。鍵の無効化の失敗は、main が executed の
 *     ⚠️ の行にして返す（reportedLinesOf が警告へ移す）。
 *   ・まだ警告にしていない事実を足すときは、ここに足す（summarizeResult には足さない）
 */
export function teardownWarningsOf(raw: unknown): string[] {
  const v = isObj(raw) ? raw : {}
  const out: string[] = []
  // 破棄したのに残った保存場所・レジストリ（月額が続く）。文は画面の破棄の結果と同じ関数（cloudCost.ts）で作る。
  // 名前が記録に無いレジストリ（keptRegistryUnnamed）も、名前なしで「残る」と言う。利用者のファイルがあってバケットごと消さなかった回は、
  // executed に「…残します」と入るだけで ⚠️ が付かず警告の枠にならない（共用型と扱いが食い違う）ので、事実として返してここで警告にする。
  // 残したレジストリの由来と借り手、残した保存場所の理由も、返り値の事実から渡す。**無ければ「分からない」に倒す**（このプロジェクトだけのものとは言わない。「後で消す場合は」を言わない）。
  for (const w of teardownRemainingWarnings({
    keptBucketName: asStr(v.keptBucketName),
    keptBucketNames: asStrList(v.keptBucketNames),
    keptBucketsUsedByOthers: asStrList(v.keptBucketsUsedByOthers),
    keptBucketsWithOwnFiles: asStrList(v.keptBucketsWithOwnFiles),
    keptRegistryName: asStr(v.keptRegistryName),
    keptRegistryOrigin: isRegistryOrigin(v.keptRegistryOrigin) ? v.keptRegistryOrigin : null,
    keptRegistryUsers: asStrListOrNull(v.keptRegistryUsers),
    keptRegistryUnnamed: v.keptRegistryUnnamed === true,
  })) pushUnique(out, w)

  // 専有型の破棄: 待ち切れなかった／消せずに残った。
  if (v.inProgress && typeof v.inProgress === 'object') {
    pushUnique(out, `${TEARDOWN_IN_PROGRESS_WARNING_HEAD}。しばらくしてから、もう一度削除を実行してください（続きから進みます）。`)
  } else if (v.ok !== true) {
    // 専有型は remaining（4つの ID）＋保存場所（remainingBuckets。無ければ remaining.storageBucket）、HANAMII・共用型は remainingBuckets で返す。
    // 専有型の返り値は remaining を持つので、HANAMII の読みは通らない（専有型が remainingBuckets を返しても、同じ保存場所を二重に言わない）。
    const left = v.remaining && typeof v.remaining === 'object' ? dedicatedRemaining(v) : hanamiiRemaining(v)
    const names = left.map(l => l.label)
    if (names.length > 0) {
      // 保存場所が入っているときは、削除する前の確かめを添える（ほかのプロジェクトも使っていることがある。Koto は中身を確かめていない）。
      const check = left.some(l => l.kind === 'storage') ? `。${STORAGE_LISTED_CHECK}` : ''
      pushUnique(out, `${TEARDOWN_REMAINING_WARNING_HEAD}。コントロールパネルから直接削除することもできます: ${names.join('・')}${check}`)
    }
  }

  // HANAMII: 削除を受け付けただけで、まだ終わっていない（Koto が待ち切れなかったのではない。専有型の文は使わない）。
  if (v.deletionAccepted === true) pushUnique(out, HANAMII_DELETION_ACCEPTED_WARNING)
  return out
}

// ── 共通の形へ ────────────────────────────────────────────────────────────────────────
/** その場の返り値と記録を、同じ入れ物に直したもの。ここから先は同じ道を通る（双子が食い違わない）。 */
type Facts = {
  ok: boolean
  /** ⚠️・※ の行を除いた、起きたこと。 */
  executed: string[]
  message: string
  warnings: string[]
  /** 返り値そのもの（その場）／記録の extra（開き直し）。同じ名前の項目を持つ。 */
  fields: Record<string, unknown>
  /** 記録が「Koto の終了で止まりました」の知らせか（開き直しの記録だけ。判定は `isStoppedByQuit` の1つ）。 */
  stoppedByQuit?: true
}

function unreadableView(): TeardownView {
  return {
    ok: false, state: 'failed', appDeleted: null, executed: [], message: TEARDOWN_RESULT_UNREADABLE,
    remaining: [], inProgress: [], warnings: [], stageTimings: null,
  }
}

/**
 * 途中の2つの印を、返り値（記録なら extra）から読む。専有型の「待ち切れて止まった」（`inProgress` の中身。一覧に出す）と、
 * HANAMII の「削除を受け付けただけ」（`deletionAccepted`。一覧は空: 内訳を返さない）。`buildView`（見出し）と `callOfFacts`（呼び名）の両方がこれを通る。
 */
function pendingMarks(target: string, x: Record<string, unknown>): { stopped: Record<string, unknown> | null; accepted: boolean } {
  return {
    stopped: target === 'sakura-apprun-dedicated' && isObj(x.inProgress) ? x.inProgress : null,
    accepted: target === 'hanamii' && x.deletionAccepted === true,
  }
}

/** 呼び名を、読み直した事実から決める。**見出し（buildView）も、記録を直接読む入口（resultCallOf）も、これを通る**。 */
function callOfFacts(target: string, f: Facts): TeardownCall {
  const { stopped, accepted } = pendingMarks(target, f.fields)
  return teardownCallOf({ ok: f.ok, accepted, stopped: stopped !== null, stoppedByQuit: f.stoppedByQuit === true, warnings: f.warnings.length })
}

function buildView(target: PublishTargetKind, f: Facts): TeardownView {
  const x = f.fields
  const dedicated = target === 'sakura-apprun-dedicated'
  const hanamii = target === 'hanamii'
  const shared = target === 'sakura-apprun'
  // 途中になるのは3つ（呼び名は callOfFacts の1つ）。専有型の「待ち切れて止まった」と、HANAMII の「削除を受け付けただけ」と、
  // 「Koto の終了で止まりました」の知らせ（失敗ではない。一覧は空）。ok が先。
  const { stopped } = pendingMarks(target, x)
  const state = teardownStateOf(callOfFacts(target, f))
  // 3つの破棄とも、返り値に appDeleted を持つ（共用型は段階2から）。真偽値でなければ null（分からないものを作らない）。
  const appDeleted = (dedicated || hanamii || shared) && typeof x.appDeleted === 'boolean' ? x.appDeleted : null
  const remaining = dedicated ? dedicatedRemaining(x) : hanamii ? hanamiiRemaining(x) : sharedRemaining(f.ok, x)
  return {
    ok: f.ok,
    state,
    appDeleted,
    executed: f.executed,
    message: f.message,
    remaining,
    inProgress: stopped ? serviceLeftovers(stopped, false) : [],
    warnings: f.warnings,
    // 段ごとの時間は、その場は返り値、開き直しは記録（finishOp が extra に足す）にある。無ければ null（測っていないものを作らない）。
    stageTimings: readStageTimings(x.stageTimings),
    // true のときだけキーごと付ける（false を書くと、型を丸ごと書いた既存の期待が割れる）。
    ...(f.stoppedByQuit ? { stoppedByQuit: true as const } : {}),
  }
}

/** その場の返り値（3つの IPC のどれか）を読む。 */
export function toTeardownView(target: PublishTargetKind, raw: unknown): TeardownView {
  if (!isObj(raw)) return unreadableView()
  // summarizeResult と同じ分け方と並び: 文で持っている行・警告（reportedLinesOf）→ 事実から作る警告（teardownWarningsOf）。
  const { executed, warnings } = reportedLinesOf(raw)
  for (const w of teardownWarningsOf(raw)) pushUnique(warnings, w)
  return buildView(target, { ok: raw.ok === true, executed, message: asStr(raw.message), warnings, fields: raw })
}

/** 記録（main の処理の記録の result）を、読み直しの事実にする。`resumedTeardownView` と `resultCallOf` が同じ読み方をする。 */
function recordFacts(rec: Record<string, unknown>): Facts {
  // 記録の lines は、summarizeResult が ⚠️・※ の行を warnings へ移したあとの「起きたこと」。warnings は作り直さず、記録のまま使う
  // （記録を作ったときの警告を、読む側の事情で増減させない）。
  const warnings: string[] = []
  for (const w of asStrList(rec.warnings)) pushUnique(warnings, w)
  return {
    ok: rec.ok === true,
    executed: asStrList(rec.lines),
    message: asStr(rec.message),
    warnings,
    fields: isObj(rec.extra) ? rec.extra : {},
    // 知らせを作れるのは main の起動の読み戻しだけ（その場の返り値〔toTeardownView〕には付けない）。成功した記録は知らせではない（ok が先）。
    ...(rec.ok !== true && isStoppedByQuit(rec) ? { stoppedByQuit: true as const } : {}),
  }
}

/** 閉じて開き直したときの記録を読む。同じ返り値なら toTeardownView と同じ結果になること（双子のテスト）。 */
export function resumedTeardownView(target: PublishTargetKind, rec: TeardownRecordResult): TeardownView {
  if (!isObj(rec)) return unreadableView()
  return buildView(target, recordFacts(rec))
}

/**
 * 記録1件の結果を、画面でどう呼ぶか（`TeardownCall`）。見出しを言い分ける入口（【公開】の結果カード・開き直しの知らせ）はこれを通る。
 * 見出しの TeardownView.state と同じ読み（`resumedTeardownView` と同じ recordFacts・同じ呼び名の決め方）なので、同じ記録を「失敗」と「途中」に言い分けない。
 * 読めない記録（無い・オブジェクトでない）は失敗（`resumedTeardownView` と同じ）。公開・作成の記録を通しても、途中の印（deletionAccepted・inProgress）は付かないので、
 * ok・警告・Koto の終了で止まった知らせだけで決まる。
 */
export function resultCallOf(target: string, rec: TeardownRecordResult): TeardownCall {
  if (!isObj(rec)) return 'failed'
  return callOfFacts(target, recordFacts(rec))
}
