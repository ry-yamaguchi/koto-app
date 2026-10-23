// teardown/projectDeletePlan.ts — プロジェクトの削除で、フォルダをゴミ箱へ移してよいかの「判断」と、画面の文の定数（純関数）。
//
// 段階3A（3A-4a）。設計書: docs/teardown-unify-plan.md の 10.9.3。window・React・IPC に触らない（テストは偽物なしで呼べる）。
// Sidebar.tsx にあった DedicatedResourceIds・PUBLISH_RECORD_UNREADABLE_NOTE・remainingPlacementsNote と、止めるかの判断（projectDeleteBlockOf）を
// ここへ移した（Sidebar からは再エクスポートしない）。残りは、止める理由（projectDeleteBlockOf）・先に破棄する公開先の並び・
// 移してよいかの判断（projectDeleteVerdict）。ダイアログ（ProjectDeleteDialog）と走らせる関数（projectDelete.ts）は、この判断を呼ぶ。

import { PUBLISH_TARGET_LABEL, type PublishTargetKind } from '../publishStatus'
import type { RunningOpEntry } from '../projectMeta'
import { opWordFor } from '../../shared/opWord'
import type { TeardownView } from '../../shared/teardownResult'
import { dedicatedTeardownHasWork, dedicatedStorageLeftoverNames, bucketNamesText, teardownSupport } from '../../shared/teardownSupport'
import { BUCKET_MONTHLY_YEN, REGISTRY_MONTHLY_YEN, registryIsOnlyThisProjects, type RegistryOrigin } from '../../shared/cloudCost'
import type { TeardownWords } from './types'

/** apprunDedicated.state の記録のうち、止める判断に使う項目（shared/publishMeta.ts の ApprunDedicatedRecord の一部）。 */
export type DedicatedResourceIds = {
  applicationID?: string | null; clusterID?: string | null; asgID?: string | null; loadBalancerID?: string | null
  storageLeftoverBucket?: string | null
  /** 残っている保存場所の全件（段階3B-2・B=2）。無い旧い記録は `storageLeftoverBucket` の1件を言う。 */
  storageLeftoverBuckets?: readonly string[] | null
} | null | undefined

/** いま main が走らせている操作と公開先（projectMeta.ts の定義。projectDelete.ts は projectMeta を import しないので、ここから渡す）。 */
export type { RunningOpEntry }

/** いま main が走らせている操作の名前（RunningOpEntry の op）。 */
export type RunningOpName = RunningOpEntry['op']

/** 止める理由。null は止めない。 */
export type ProjectDeleteBlock =
  | null
  | { reason: 'running'; op: RunningOpName; target: RunningOpEntry['target'] }   // このプロジェクトの公開・破棄・作成が進んでいる。op は記録の語（文にするときは opWordFor を通す）
  | { reason: 'dedicated' }                                    // 専有型の公開の記録か、リソースの ID がある
  | { reason: 'dedicated-storage-leftover'; buckets: readonly string[] }   // 専有型の削除で、保存場所だけが残った（残っている全件の名前）

/**
 * プロジェクトの削除を止める理由（規則は上から。最初に当たったものを返す）。
 *  0. 公開・破棄・作成が進んでいる → running（最優先。進んでいる間に「先に手順6で」と言わない）
 *  1. 専有型の ID（アプリ・クラスタ・ASG・LB）が残っている → dedicated（専有型の行があるかは問わない）
 *  2. 保存場所だけが残っている（storageLeftoverBuckets の全件。無ければ storageLeftoverBucket の1件）→ dedicated-storage-leftover
 *     （専有型の行があっても言い分ける。D1=1 で、保存場所だけ残った回は 📡 の行が残るため。段階3B-7・設計書 10.11.9 の D3）
 *  3. publish.targets に専有型の行だけがあり、記録が空（幽霊の行）→ dedicated
 *  4. どれでもない → null
 * 専有型は、クラスタ・LB の記録がフォルダ（.sakura-cloud・.sakuraide.json）の中にしかなく、フォルダを移すと月額を Koto から止められなくなる。
 * 「公開も一緒に破棄する」のチェックの有無に関わらず止める（外すと破棄は呼ばれないため）。ID は publish.targets とは別の場所
 * （publish.apprunDedicated）にあるので、手順5でクラスタだけ作った回も見る。「何か残っているか」は dedicatedTeardownHasWork に任せ、
 * ここは理由の言い分けだけをする（判断を2つ持たない）。専有型の行だけがあり記録が空の回（幽霊の行）も止める。
 */
export function projectDeleteBlockOf(
  targets: readonly PublishTargetKind[], dedicated: DedicatedResourceIds, running?: RunningOpEntry | null,
): ProjectDeleteBlock {
  if (running) return { reason: 'running', op: running.op, target: running.target }
  const hasRow = targets.includes('sakura-apprun-dedicated')
  // 専有型の行も残りも無ければ止めない。行だけがあり記録が空の回（幽霊の行）は、下で dedicated になる。
  if (!hasRow && !dedicatedTeardownHasWork(dedicated)) return null
  const hasId = !!(dedicated?.applicationID || dedicated?.clusterID || dedicated?.asgID || dedicated?.loadBalancerID)
  const buckets = dedicatedStorageLeftoverNames(dedicated)
  // 保存場所だけが残った回だけ、言い分ける（行があっても）。形が読めない値（文字列でない）は、安全側（dedicated）に倒す。
  return !hasId && buckets.length > 0 ? { reason: 'dedicated-storage-leftover', buckets } : { reason: 'dedicated' }
}

/** 止めたときの赤い文（先頭の「⚠️ 」は描く側が付ける）。 */
export function projectDeleteBlockNote(block: Exclude<ProjectDeleteBlock, null>): string {
  switch (block.reason) {
    case 'running':
      // 記録の op は共用型・HANAMII の破棄も専有型の削除も '削除'。画面の言葉は公開先で決める（破棄の流れの「破棄」と揃える。D3）
      return `いまこのプロジェクトの${opWordFor(block.op, block.target)}が進んでいます。終わってから、もう一度このプロジェクトを削除してください。`
    case 'dedicated':
      return 'さくらのAppRun 専有型のリソースが残っているため、この画面からは削除できません。'
        + '先に「📦 さくらのAppRun」の専有型タブ「手順6 作ったものを削除する」で、クラスタ・ロードバランサを含めて削除してから、もう一度このプロジェクトを削除してください。'
        + '手順6の削除ボタンが出ていないときは、📡 公開したもの一覧の「一覧から削除」でその行を消してください。'
    case 'dedicated-storage-leftover':
      return `さくらのAppRun 専有型の削除で、保存場所${bucketNamesText(block.buckets)}だけが残っています（消すまで月額が続きます）。`
        + '先に「📦 さくらのAppRun」の専有型タブ「手順6 作ったものを削除する」で残った保存場所を削除してから、もう一度このプロジェクトを削除してください。'
  }
}

/**
 * 公開の記録（.sakuraide.json・.sakura-cloud/）を読めなかったときに、プロジェクト削除の確認へ出す注意。
 * 読めないまま何も言わないと、公開が残っていても警告が出ないままフォルダをゴミ箱へ移せてしまう——
 * 記録もフォルダと一緒に移るので、あとから Koto では破棄できなくなる。読めた回（記録が無いだけの回を含む）には出さない。
 */
export const PUBLISH_RECORD_UNREADABLE_NOTE =
  '公開の記録（.sakuraide.json・.sakura-cloud/）を読めないため、公開が残っているか分かりません。'
  + '公開が残っているままフォルダをゴミ箱へ移すと、どこに何を公開したかの記録も一緒に移り、あとから Koto では破棄できなくなります（公開先によっては月額が続きます）。'
  // 公開の記録が読めないときは、【公開】の画面も 📡 の一覧も同じ記録を読むので答えを出せない。
  // 記録に頼らずに確かめられる場所だけを挙げる（2026-10-08 検分2巡目）
  + '📡 公開したもの一覧の『さくら側にあるものと、かかっている費用』で『調べる』を押すか、各サービスの管理画面で、公開が残っていないか確かめてから削除してください。'

/**
 * プロジェクト削除で「公開も一緒に破棄する」を外したとき、保存場所が残ることを伝える文（W-22）。
 * 同じ保存場所を別のプレフィックスで2件持つと同じバケット名が2回並ぶので、名前は重複を除いて出す。
 * 金額は保存場所が2つ以上あるときだけ「1つにつき」と明記する（月額は**バケット単位**。合算すると同じ保存場所を2重に数えかねない）。
 */
export function remainingPlacementsNote(placements: Array<{ bucket: string }>): string {
  const names = Array.from(new Set(placements.map(p => p.bucket)))
  const amount = names.length > 1 ? `1つにつき月額${BUCKET_MONTHLY_YEN}円・税込` : `月額${BUCKET_MONTHLY_YEN}円・税込`
  return `保存場所「${names.join('・')}」とその中のデータは残ります（消すまで${amount}が続きます）。`
}

/** プロジェクト削除で先に破棄する公開先の並び（共用型の破棄は HANAMII のデータも消すので、HANAMII が先）。専有型は入らない（止める側）。 */
export const PROJECT_DELETE_TEARDOWN_ORDER: readonly PublishTargetKind[] = ['hanamii', 'sakura-apprun']

/**
 * 共用型の公開先の行が無いのに、共用型の記録（cloud:teardownRecord）に消すものがあるときの、その中身。
 * registryOrigin・registryUsers は、レジストリが「このプロジェクトだけのもの」か（月額をこのプロジェクトの話として言ってよいか）の材料（sharedLeftoverNote が見る）。
 */
export type SharedLeftover = {
  registryName: string | null
  /** そのレジストリを、このプロジェクトのために Koto が作ったか（owned）・借りたか（adopted）・分からないか（unknown）。 */
  registryOrigin: RegistryOrigin
  /** 同じレジストリを使っている、ほかのプロジェクトの名前。 */
  registryUsers: readonly string[]
  placements: Array<{ bucket: string; prefix: string; shared: boolean }>
}

/**
 * 共用型の公開先の行があるとき、共用型の記録（cloud:teardownRecord）が言うコンテナレジストリ。記録にレジストリの名前が無ければ、このオブジェクトを作らない（null）。
 * origin は、このプロジェクトのために Koto が作ったか（owned）・借りたか（adopted）・分からないか（unknown）。users は同じレジストリを使っているほかのプロジェクト。
 */
export type SharedRegistry = { registryName: string; origin: RegistryOrigin; users: readonly string[] }

export type ProjectDeleteFacts = {
  targets: PublishTargetKind[]    // 旧い記録の公開先も含む。読めなければ、読めた分
  unreadable: boolean             // 公開の記録のどこかが読めなかった（PUBLISH_RECORD_UNREADABLE_NOTE を出す）
  dedicated: DedicatedResourceIds // apprunDedicated.state。読めなければ null
  placements: Array<{ bucket: string; prefix: string; shared: boolean }>
  running: RunningOpEntry | null  // いま main が走らせている操作と公開先（聞けなければ null）
  sharedLeftover: SharedLeftover | null // targets に 'sakura-apprun' が無いのに、共用型の記録に消すものがある
  /** targets に 'sakura-apprun' があるときの、共用型の記録のコンテナレジストリ。記録にレジストリが無い・記録を読めなかった・行が無い回は null。 */
  sharedRegistry: SharedRegistry | null
}
export type ProjectDeletePlan = {
  block: ProjectDeleteBlock
  /** 先に破棄する公開先（並びは PROJECT_DELETE_TEARDOWN_ORDER）。 */
  teardown: PublishTargetKind[]
}

/**
 * 止める理由と、先に破棄する公開先を決める。teardown は targets のうち、Koto から破棄できる（'supported'）専有型でないもの。
 * **並びは targets の並びに依らない**（PROJECT_DELETE_TEARDOWN_ORDER の位置）。表に無い 'supported' の種類（将来の公開先）は末尾に残す
 * （落とさない。teardownPublished が「この画面からは破棄できません」を失敗に積むので、フォルダは移らない＝安全側）。
 * 手動の案内（Vercel・レンタルサーバ）は持たない（ManualTeardownNote が自分で決める）。sharedLeftover があっても teardown には足さない
 * （文を出すだけ。破棄はしない）。
 */
export function planProjectDeleteTeardown(facts: ProjectDeleteFacts): ProjectDeletePlan {
  const eligible = facts.targets.filter(t => teardownSupport(t) === 'supported' && t !== 'sakura-apprun-dedicated')
  const ordered = PROJECT_DELETE_TEARDOWN_ORDER.filter(t => eligible.includes(t))
  const rest = Array.from(new Set(eligible.filter(t => !PROJECT_DELETE_TEARDOWN_ORDER.includes(t))))
  return { block: projectDeleteBlockOf(facts.targets, facts.dedicated, facts.running), teardown: [...ordered, ...rest] }
}

/**
 * 共用型の残りだけがあるときに、赤い箱へ出す文（止めない）。保存場所があれば remainingPlacementsNote、
 * レジストリがあればその名前を、この順に続ける。どちらも無い回は空（呼ばない）。
 *
 * レジストリの月額まで言うのは、そのレジストリが「このプロジェクトのために Koto が作った（owned）もので、ほかのプロジェクトが使っていない」ときだけ
 * （ownRegistryBillingNote と同じ判断。registryIsOnlyThisProjects）。借りたもの・作ったか分からないもの・ほかが使っているものは、
 * 残ることだけを言う（その月額は、このプロジェクトの話ではない、または分からない）。
 */
export function sharedLeftoverNote(leftover: SharedLeftover): string {
  const registry = leftover.registryName
    ? `コンテナレジストリ『${leftover.registryName}』も残ります`
      + (registryIsOnlyThisProjects({ registryName: leftover.registryName, origin: leftover.registryOrigin, otherUsers: leftover.registryUsers.length })
        ? `（消すまで月額${REGISTRY_MONTHLY_YEN}円・税込が続きます）。`
        : '。')
    : ''
  return (leftover.placements.length > 0 ? remainingPlacementsNote(leftover.placements) : '') + registry
}

/**
 * 「公開も一緒に破棄する」を外したとき、コンテナレジストリの月額が続くと言う文。言わないときは空。
 *
 * **言うのは、先に破棄する公開先に共用型があり、その記録のレジストリが「このプロジェクトのために Koto が作ったもの（owned）で、
 * ほかのプロジェクトが使っていない」ときだけ。** 次のときは、その月額はこのプロジェクトの話ではない、または分からないので言わない:
 *   ・記録にレジストリが無い（共用型の行だけがあり、.sakura-cloud が無いプロジェクトなど）／記録を読めなかった
 *   ・借りたもの（adopted）・作ったか分からないもの（unknown）
 *   ・Koto が作ったが、ほかのプロジェクトが使っているもの（このプロジェクトを破棄しなくても、使っているほうが続ける）
 * 行があるだけで言うと、レジストリの記録が無いプロジェクトにも「月額220円が続きます」と言ってしまう（0.6.22-rc.1 の実機）。
 * 判断は、確認の「コンテナレジストリも削除する」の既定オンと同じ関数（registryIsOnlyThisProjects。shared/cloudCost.ts）に通す（「このプロジェクトだけのレジストリ」を2つ書かない）。
 */
export function ownRegistryBillingNote(facts: Pick<ProjectDeleteFacts, 'sharedRegistry'>, teardown: readonly PublishTargetKind[]): string {
  const r = facts.sharedRegistry
  if (!r || !teardown.includes('sakura-apprun')) return ''
  if (!registryIsOnlyThisProjects({ registryName: r.registryName, origin: r.origin, otherUsers: r.users.length })) return ''
  return `コンテナレジストリの月額${REGISTRY_MONTHLY_YEN}円（税込）が、消すまで続きます。`
}

/** 公開先1つぶんの破棄の結果（teardownPublished が返す）。 */
export type ProjectDeleteStep =
  | { target: PublishTargetKind; kind: 'done'; view: TeardownView; words: TeardownWords }
  | { target: PublishTargetKind; kind: 'nothingToDo'; message: string }
  | { target: PublishTargetKind; kind: 'failed'; line: string; view: TeardownView | null; words: TeardownWords | null }
  | { target: PublishTargetKind; kind: 'cancelled'; line: string }

export type ProjectDeleteVerdict = { moveToTrash: boolean; hold: boolean }

const warningsOf = (s: ProjectDeleteStep): string[] =>
  s.kind === 'done' && Array.isArray(s.view?.warnings) ? s.view.warnings : []

/**
 * フォルダをゴミ箱へ移してよいか。**不明な形を、移す側に倒さない**。
 *  1. 止める理由がある → 移さない。
 *  2. チェックを外した、または破棄する公開先が無い → 移す（破棄せずに移す）。
 *  3. それ以外は、plan.teardown の各公開先に**ちょうど1つ**の step があり、その kind が done か nothingToDo のときだけ移す。
 *     step が無い（やめたあと・飛ばされた）・2つある・failed・cancelled・知らない kind・plan に無い公開先の step がある → 移さない。
 *  4. hold: 移すが、done の警告（残った保存場所・鍵の ⚠️）が1件以上ある → 見せてから、もう一度押してもらう。
 */
export function projectDeleteVerdict(plan: ProjectDeletePlan, teardownOnDelete: boolean, steps: readonly ProjectDeleteStep[]): ProjectDeleteVerdict {
  if (plan.block !== null) return { moveToTrash: false, hold: false }
  if (teardownOnDelete === false || plan.teardown.length === 0) return { moveToTrash: true, hold: false }
  const ok = (s: ProjectDeleteStep) => s.kind === 'done' || s.kind === 'nothingToDo'
  const allOk = steps.every(s => plan.teardown.includes(s.target) && ok(s))
    && plan.teardown.every(t => steps.filter(s => s.target === t).length === 1)
  return { moveToTrash: allOk, hold: allOk && steps.some(s => warningsOf(s).length > 0) }
}

/** 'failed'・'cancelled' の line（もとの failed[] と同じ文）。 */
export function failureLinesOf(steps: readonly ProjectDeleteStep[]): string[] {
  return steps.flatMap(s => (s.kind === 'failed' || s.kind === 'cancelled' ? [s.line] : []))
}

/** 'done' の warnings を `${公開先の名前}: ${警告}` にしたもの（もとの kept[] と同じ文）。 */
export function keptLinesOf(steps: readonly ProjectDeleteStep[]): string[] {
  return steps.flatMap(s => warningsOf(s).map(w => `${PUBLISH_TARGET_LABEL[s.target]}: ${w}`))
}

/**
 * 破棄が済んだ公開先（done）を除いた並び。破棄のあとの画面が、開いたときの材料のままで「これから消す」と言い続けないために使う
 * （済んだ公開先は、箱の一覧にもチェックの説明にも出さない。結果の欄が済んだと言う）。
 */
export function withoutDoneTargets<T extends PublishTargetKind>(targets: readonly T[], steps: readonly ProjectDeleteStep[]): T[] {
  return targets.filter(t => !steps.some(s => s.target === t && s.kind === 'done'))
}

/**
 * 読み直した材料に、利用者がまだ見ていない注意（seen に無かったもの）が増えたか。増えたら、移す前に見せる（押し直しの経路が使う）。
 * 見るのは2つ。公開の記録が読めなくなったこと（unreadable）と、共用型の残り（sharedLeftover）の新しい保存場所・レジストリ。
 * 同じ注意を見せたあとの押しでは、増えていない（seen が読み直した材料になる）ので、行き止まりにならない。
 * 公開先が増えた回は数えない（破棄の確認が、消すものを名指しで見せる）。
 */
export function noticesAddedSince(seen: ProjectDeleteFacts, fresh: ProjectDeleteFacts): boolean {
  if (fresh.unreadable && !seen.unreadable) return true
  const now = fresh.sharedLeftover
  if (now === null) return false
  const before = seen.sharedLeftover
  if (before === null) return true
  const key = (p: { bucket: string; prefix: string }) => `${p.bucket}|${p.prefix}`
  const known = new Set(before.placements.map(key))
  return (now.registryName !== null && now.registryName !== before.registryName) || now.placements.some(p => !known.has(key(p)))
}

// ── 画面の文（もとの window.alert の文を、意味を変えずに移した。「OK を押すと」だけ「🗑 ゴミ箱に移動」を押すと、に言い換えた）──
export const PROJECT_DELETE_STOPPED_HEAD = '公開の破棄を完了できなかったため、プロジェクトの削除を中止しました。'
export const PROJECT_DELETE_STOPPED_TAIL =
  'このままフォルダを削除すると、どこに何を公開したかの記録も消えて、Koto から破棄できなくなります。'
  + '【公開】の画面から破棄するか、各サービスの管理画面で削除してください。'
export const PROJECT_DELETE_REVIEW_HEAD = '公開の破棄は済みましたが、残ったものがあります。'
// 残ったものの中心は、ほかのプロジェクトも使うので残した保存場所と、借りた・ほかも使うコンテナレジストリ。そのまま削除を勧めると、ほかのプロジェクトのデータが消える・アプリが止まる（消さないと決めた理由そのもの。
// 結果の警告〔shared/cloudCost.ts の remainingCostWarning・keptSharedRegistryNote〕も、これらには「後で消す場合は」と言わない）。
export const PROJECT_DELETE_REVIEW_TAIL =
  '「🗑 ゴミ箱に移動」を押すと、フォルダをゴミ箱へ移します。残ったものは、各サービスの管理画面から削除できます。'
  + 'ほかのプロジェクトも使う保存場所とコンテナレジストリは、消さないでください。消すと、保存場所はそのプロジェクトのデータが消え、コンテナレジストリはそのアプリが止まります。'
