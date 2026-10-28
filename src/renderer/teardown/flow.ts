// teardown/flow.ts — 破棄（削除）の流れ（確認 → 実行 → 進み具合の読み方）。React に依存しない。
//
// 段階0で作った部品（いまは3つの公開先〔共用型・HANAMII・専有型〕の入口がすべてこれを通る）。設計書: docs/teardown-unify-plan.md の 10.3.2 (4)。
// 3つの公開先の削除の流れは、ここだけが持つ（専有型の手本 dedicatedTeardownFlow.ts と apprunDedicatedActions.ts の runTeardown は、0.6.22 段階3B-7 で消した）。
//         進み具合の一文 `opProgressText`・経過の文 `opElapsedText` は、写さず処理の記録の読み方の置き場（projectOpsView.ts）の1つを使う（0.6.22 段階3B-3）。
//
// ── どこに何があるか（掟10: 定義は1か所）─────────────────────────────────────────
//   確認の文を作る        … confirm.ts の buildTeardownConfirm
//   確認の材料を読む      … facts.ts の loadTeardownFacts
//   確認 → 実行           … runTeardownFlow（ここ）。確認の答えが true でなければ IPC を1回も呼ばない・実行中は活動レジストリへ計上
//   公開の記録を消す      … **画面は消さない**。消すのは main の骨（teardownShell）の1か所だけにする（まだどの IPC もこの骨に載っていない）
//
// 掟4（方式B）: キーは使う瞬間に読んで引数で渡す。ここでは保存しない。
// 掟5: 確認は ConfirmModal（useConfirm）。window.confirm は使わない。

import type { ConfirmOptions } from '../useConfirm'
import type { ConfirmWithChoicesAnswer, ConfirmWithChoicesOptions } from '../useConfirmChoices'
import { PUBLISH_CLOSE_WARNING, beginActivity } from '../activity'
import { buildTeardownConfirm } from './confirm'
import { opProgressText } from '../projectOpsView'
import { electronTeardownFactsApi, loadTeardownFacts } from './facts'
import type { ShownPlacement, TargetSpec, TeardownFacts, TeardownInvokeOpts, TeardownOutcome } from './types'

/** 実行に要る口（テストでは偽物を渡す）。 */
export interface RunTeardownFlowDeps<R, A, Res> {
  /** 確認の材料を、押した時点の記録から読む。投げたら、確認も IPC も出さずに失敗の結果にする。 */
  loadFacts(): Promise<TeardownFacts<R>>
  /** ConfirmModal（useConfirm の confirm）。 */
  confirm(opts: ConfirmOptions): Promise<boolean>
  /**
   * 選択つきの確認（useConfirmChoices の confirmWithChoices）。仕様書が選択（`choices`）を持つときだけ使う。
   * 無いのに選択が要る回は、確認も IPC も出さずに失敗の結果にする（`confirm` へは落とさない）。
   */
  confirmWithChoices?(opts: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer>
  /** キー（方式B）。無ければ null か undefined。 */
  loadAuth(record: R): Promise<A | null | undefined>
  /** IPC を1回。仕様書の invoke。 */
  invoke(projectDir: string, auth: A, opts: TeardownInvokeOpts, record: R): Promise<Res>
  /** 活動レジストリ（activity.ts の beginActivity と同じ形）。呼ぶと終了用の関数が返る。 */
  beginActivity(label: string, opts: { closeWarning: { detail: string; confirmLabel: string } }): () => void
  /** 確認が済んで、実行が始まる直前（画面が「破棄しています…」にする）。やめたときは呼ばれない。 */
  onStart?(): void
  /** キーが無いときに結果欄へ出す文（入口ごとに、キーを登録する場所の案内が違う）。 */
  keyMissingMessage: string
  /**
   * 入口が、記録に消すものがあっても「この回は消すものが無い」と決める口（任意）。**読み直した記録**に、入口が持つ門をかけ直すのに使う（0.6.24 R4-e）。
   * `true` でなければ（偽・不明な値）、`spec.hasWork` が偽のときと同じに扱う（確認も IPC も出さず、`nothingToDo`）。渡さない回は `spec.hasWork` だけで決まる（今のまま）。
   */
  hasWork?(record: R): boolean
}

/**
 * 確認で見せた保存場所（名前と prefix の組）。**IPC の opts に載せる値は、この1つの関数だけが作る**（0.6.24 F-1）。
 * 確認の 💾 の段落は `facts.placements` の全件を名指しする（confirm.ts の buildTeardownConfirmBody）ので、「見せた」は `facts.placements` と一致する。
 *   ・保存場所の設定を読めなかった（`placementsUnreadable`）回は `[]`。名前を挙げていないので、何も見せていないことにする（main は消さない）。
 *   ・確認の段落が数えない要素（null・名前の無いもの）は、見せていないので入れない。prefix の無いものは `''`。
 */
export function shownPlacementsOf(facts: Pick<TeardownFacts<unknown>, 'placements' | 'placementsUnreadable'>): ShownPlacement[] {
  if (facts.placementsUnreadable) return []
  return (facts.placements ?? [])
    .filter(p => !!p && typeof p.bucket === 'string' && p.bucket.length > 0)
    .map(p => ({ bucket: p.bucket, prefix: typeof p.prefix === 'string' ? p.prefix : '' }))
}

/**
 * 確認 → 実行。**入口は、これを通ることにする**（段階0の時点では、どの入口もまだこれを呼んでいない。最初の利用者は段階1の HANAMII。
 * 入口が迂回しないことは、`tests/teardownCommonWiring.test.ts` の「仕様書の invoke を呼ぶのは flow.ts だけ」が見張る）。
 *
 * 1. 確認の材料が読めなければ、確認も活動レジストリもキーも IPC も出さずに失敗の結果を返す（消すものが分からないまま消させない）。
 * 2. 消すものが記録に無い（幽霊の行）なら、破壊の確認は出さず IPC も呼ばない。仕様書が `nothingToDoIsOk` のときだけ、結果に `nothingToDo: true` を付ける。
 *    入口が門（`deps.hasWork`）を渡していれば、読み直した記録がその門を通らない回も同じ（プロジェクトの削除の残りの段。0.6.24 R4-e）。
 * 3. 確認の答えが **true でなければ**（no・不明な値）`cancelled`。IPC は1回も呼ばれず、活動レジストリにも載せない。
 *    仕様書が選択（`choices`）を1件以上持つときは `confirmWithChoices` で聞く。入口が渡していなければ、確認も IPC も出さずに失敗の結果にする。
 *    選択の値は `=== true` のものだけ true にして IPC へ渡す（知らない id は落ち、boolean でない値は false）。
 * 4. 窓を閉じるときの警告つきで活動レジストリに載せる。
 * 5. `onStart` → キーを読む → `{ confirmed: true, shownPlacements }`（選択があれば `choices` も）を付けて IPC を1回だけ。成功・失敗を問わず必ず活動レジストリから外す。
 *    `shownPlacements` は確認で見せた保存場所の組（`shownPlacementsOf`）。main はこの組だけを消す（0.6.24 F）。
 *    キーが無ければ IPC を呼ばず `keyMissingMessage` の失敗。IPC の例外は握らずに投げ直す（呼び出し側が受ける）。
 * 6. 公開の記録（📡 の行）は**ここでも画面でも消さない**。
 */
export async function runTeardownFlow<R, A, Res>(
  projectDir: string,
  spec: TargetSpec<R, A, Res>,
  deps: RunTeardownFlowDeps<R, A, Res>,
): Promise<TeardownOutcome<Res>> {
  let facts: TeardownFacts<R>
  try {
    facts = await deps.loadFacts()
  } catch (e: any) {
    return { cancelled: false, result: spec.failure(`${spec.words.factsUnreadable}: ${e?.message ?? String(e)}`) }
  }
  // 消すものが記録に無い（幽霊の行）。「次を…します: 」と何も名前を出さないまま実行を押させない。IPC も呼ばない。
  // 共用型だけ、これを失敗でなく成功の知らせにする（`nothingToDo` の印。印の無い仕様書の結果の形は今のまま）。
  // 入口の門（deps.hasWork）も同じ側に倒す: true でなければ「消すものが無い」（不明な値を、消す側に倒さない）。
  if (!spec.hasWork(facts.record) || (deps.hasWork !== undefined && deps.hasWork(facts.record) !== true)) {
    const result = spec.failure(spec.words.nothingToDo)
    return spec.nothingToDoIsOk === true ? { cancelled: false, result, nothingToDo: true } : { cancelled: false, result }
  }
  const list = spec.choices?.(facts.record) ?? []
  // 確認で見せた保存場所（名前と prefix の組）。選択の有る無しによらず、両方の opts に同じ値を載せる（1か所で作る）。
  const shownPlacements = shownPlacementsOf(facts)
  let invokeOpts: TeardownInvokeOpts = { confirmed: true, shownPlacements }
  if (list.length === 0) {
    const ok = await deps.confirm(buildTeardownConfirm(spec, facts))
    // true のときだけ進める（不明な値を肯定に戻さない。V15）。
    if (ok !== true) return { cancelled: true }
  } else {
    // 選べない確認で破棄させない（`confirm` へ落とすと、レジストリを消すかどうかを聞かないまま進んでしまう）。
    if (!deps.confirmWithChoices) {
      return { cancelled: false, result: spec.failure(`${spec.words.verb}の確認を出せませんでした。何も${spec.words.verb}していません。`) }
    }
    const answer = await deps.confirmWithChoices({ ...buildTeardownConfirm(spec, facts), choices: list })
    if (answer?.confirmed !== true) return { cancelled: true }
    const chosen: Record<string, boolean> = {}
    for (const c of list) chosen[c.id] = answer.choices?.[c.id] === true
    invokeOpts = { confirmed: true, shownPlacements, choices: chosen }
  }
  const end = deps.beginActivity(spec.words.activityLabel, { closeWarning: PUBLISH_CLOSE_WARNING })
  try {
    deps.onStart?.()
    const auth = await deps.loadAuth(facts.record)
    if (!auth) return { cancelled: false, result: spec.failure(deps.keyMissingMessage) }
    return { cancelled: false, result: await deps.invoke(projectDir, auth, invokeOpts, facts.record) }
  } finally {
    end()
  }
}

/**
 * 本物の口（window.electronAPI・活動レジストリ）につないだ deps。**入口は、これを使うことにする**（段階0の時点では、まだどの入口も使っていない）。
 * 確認の材料の読み方・キーの読み方・IPC・窓を閉じる警告を、入口ごとに書き直さないための1つの定義。
 * 入口が決めるのは、確認ダイアログの出し方（`confirm`）・キーが無いときの文・実行が始まる直前の画面の更新（`onStart`）だけ。
 */
export function electronFlowDeps<R, A, Res>(projectDir: string, spec: TargetSpec<R, A, Res>, entry: {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  /** 選択つきの確認（useConfirmChoices の confirmWithChoices）。仕様書が選択を持つ公開先（共用型）の入口だけが渡す。 */
  confirmWithChoices?: (opts: ConfirmWithChoicesOptions) => Promise<ConfirmWithChoicesAnswer>
  keyMissingMessage: string
  onStart?: () => void
  /** 入口の門（RunTeardownFlowDeps.hasWork）。プロジェクトの削除の残りの段だけが渡す（0.6.24 R4-e）。 */
  hasWork?: (record: R) => boolean
}): RunTeardownFlowDeps<R, A, Res> {
  return {
    loadFacts: () => loadTeardownFacts(projectDir, spec, electronTeardownFactsApi()),
    confirm: entry.confirm,
    ...(entry.confirmWithChoices ? { confirmWithChoices: entry.confirmWithChoices } : {}),
    loadAuth: record => spec.loadAuth(record),
    invoke: (dir, auth, opts, record) => spec.invoke(dir, auth, opts, record),
    beginActivity,
    keyMissingMessage: entry.keyMissingMessage,
    ...(entry.onStart ? { onStart: entry.onStart } : {}),
    ...(entry.hasWork ? { hasWork: entry.hasWork } : {}),
  }
}

/**
 * 進み具合の文。**記録（projectOps）が「この公開先の破棄が走っている」と言うなら記録の文**（別の窓で始めたものも、開き直したものも読める）、
 * そうでなければ、この画面が始めた処理に届いた最新の1行。
 *
 * 破棄の記録しか見ない道なので、`running` は boolean。呼び出す側（useTeardownFlow）は「自分の公開先の破棄の記録が走っているか」を渡す。
 */
export function teardownProgressText(s: {
  running: boolean
  runningRecord: { progress?: { label?: string; detail?: string } } | null | undefined
  local: string | null
}): string | null {
  return s.running ? opProgressText(s.runningRecord) : s.local
}

/** 破棄が済んだ（あるいは止まった）ことを、開いている画面（公開の一覧・ステータスバー）へ知らせる。読み直すだけで書かない。 */
export function notifyTeardownFinished(): void {
  window.dispatchEvent(new Event('sakura-meta-changed'))
}
