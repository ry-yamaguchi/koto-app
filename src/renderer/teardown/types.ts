// teardown/types.ts — 公開したものの破棄（削除）の流れで使う型だけ（処理は持たない）。
//
// 段階0で作った部品（いまは3つの公開先〔共用型・HANAMII・専有型〕の入口がすべてこれを通る）。設計書: docs/teardown-unify-plan.md の 10.3.2 (1)。
// 0.6.21 までの専有型の手本（dedicatedTeardownFlow.ts ほか）は、段階3B-7 で消した。3つの公開先の流れは、この型と共通の部品の1つだけ。
// 公開先ごとの違いは、全部 TargetSpec に置く。

import type { PublishTargetKind } from '../../shared/publishMeta'
import type { TeardownView } from '../../shared/teardownResult'
import type { KeptNothingReply } from '../../shared/keptNothingReply'
import type { PlacementKeep, TwinRefusal } from '../../shared/twinFactsTypes'
import type { ConfirmChoice } from '../useConfirmChoices'

/**
 * 確認が名指しする保存場所1件。`keep` があるものは、破棄が**データにも保存場所にも手を付けず、残す**（同じデータを使うフォルダがいる・いるかどうか確かめられない。
 * `cloud:twinFacts` の答え）。確認は、消す側の文（一覧・「データも削除します」・元に戻せません）に入れず、「残ります」と言う。`keep` の無いものは、今までどおり消す側。
 * `keep` を持つ保存場所も `facts.placements` の全件に入る（確認が名指しする組・main へ運ぶ「見せた保存場所」は、消さないものも含む）。
 */
export type TeardownPlacement = { bucket: string; prefix?: string; shared?: boolean; keep?: PlacementKeep }

/** 保存場所の設定を読めなかった理由。 */
export type PlacementsUnreadableCause = 'settings' | 'call'

/** 1回の流れの中で使う言葉（共用型・HANAMII は「破棄」、専有型は「削除」。1回の流れの中で名前を変えない）。 */
export type TeardownWords = {
  verb: '破棄' | '削除'
  /** 確認の見出し。例: 'HANAMII の公開を破棄します'（専有型は '専有型クラスタを削除します'）。 */
  confirmTitle: string
  /** 確認の実行ボタン。例: '破棄する'（専有型は '削除する'）。 */
  confirmLabel: string
  /** 窓を閉じるときの警告に出る名前。例: 'HANAMII の破棄'（専有型は '専有型クラスタの削除'）。 */
  activityLabel: string
  /**
   * 📡 公開したもの一覧の行のボタンの文字（押す前の名前）。共用型・HANAMII は '🗑 破棄'、専有型は '🗑 削除'。
   * `🗑 ${verb}` で作らない（押せる場所の名前は入口のもの。動詞を変えたときに、ボタンの名前まで黙って変わらないように）。
   * 実行中の文字は `running`。
   */
  rowButton: string
  /** 実行中のボタンの文字。例: '破棄しています…'。 */
  running: string
  doneHeadline: string
  /**
   * 何も消さなかった回（結果の `keptOnly`）の見出し。必須（書き忘れると、何も消していないのに「破棄しました」と言う側に戻るので、型で止める）。
   * 見出しの選びは `teardown/headline.ts` の1つ。
   */
  keptHeadline: string
  /**
   * 保存場所を残した回（ほかが使う・利用者のファイルがある・複製。`keptOnly` ではない）の見出し。専有型だけが持つ（「すべて削除しました」と言うと、残した保存場所と食い違うため）。
   * 無い公開先は、その回も `doneHeadline` のまま。
   */
  doneKeptStorageHeadline?: string
  inProgressHeadline: string
  failedHeadline: string
  /** 確認の材料（公開の記録）を読めなかったときの失敗の頭。例: '破棄するものの記録を読めませんでした'。 */
  factsUnreadable: string
  /** 消すものが記録に無いとき（幽霊の行）の案内。 */
  nothingToDo: string
  /** AI に相談するときの、公開先の名前（askAiAboutFailure の第2引数）。 */
  askAiTarget: string
}

/**
 * 確認の材料。専有型の手本（消した）の材料を一般化した形: 公開先ごとの記録は型引数 `R`・ロードバランサの時間の予告は `waitNote`。
 * `placementsUnreadableCause` は必須（読めたときは null）。
 */
export type TeardownFacts<R> = {
  projectName: string
  record: R
  placements: TeardownPlacement[]
  placementsUnreadable: boolean
  placementsUnreadableCause: PlacementsUnreadableCause | null
  otherTargets: string[]
  otherTargetsUnreadable: boolean
  waitNote: string | null
  /**
   * 公開先の断り（`cloud:twinFacts` の答え）。**読めた回だけ**付く。`null` は、同じ公開の記録を持つフォルダがいないと確かめられたこと。
   * `twin`（複製がいる）・`unknown`（確かめられない）なら、流れは確認を出さず、main の断りと同じ文の結果を返す（flow.ts）。
   */
  refusal?: TwinRefusal | null
  /** `cloud:twinFacts` を呼んだが読めなかった回（失敗・形の違う答え）だけ `true`。このとき `refusal` と、保存場所の `keep` は付かない（確認は今までどおり出て、注意の1行が付く）。 */
  twinFactsUnreadable?: true
}

/**
 * 写し元: ActionOutcome<R>（apprunDedicatedActions.ts）。
 * `nothingToDo` は、仕様書が `nothingToDoIsOk` のときだけ、「消すものが記録に無かった」回に付く（段階2。付かない回の形は今のまま）。
 * `shownPlacements` は、入口が `reportShown` を渡したときだけ、IPC まで進んだ回に付く（確認で見せた保存場所の組。渡さない入口の形は今のまま）。
 *   何も消さないと分かっている回（`keptNothing`）も、確認も IPC も出さずに結果を返すが、その結果は「済んだ」ことを言うので、入口が `reportShown` を渡していれば付ける。
 * `keptNothing` は、何も消さないと分かっていたので、確認も IPC も出さず、画面が結果を組んだ回だけ `true`（teardown/keptNothing.ts の門）。
 *   main は走っていないので、公開の記録（📡 の行）も消えていない。入口は、記録が消えた前提の後始末をしない。付くのは true のときだけ。
 */
export type TeardownOutcome<Res> =
  | { cancelled: true }
  | { cancelled: false; result: Res; nothingToDo?: true; keptNothing?: true; shownPlacements?: ShownPlacement[] }

/**
 * 確認で見せた保存場所（名前と prefix の組）。main は、この組と一致する保存場所だけを消す（0.6.24 F）。
 * 名前だけでは消す範囲が決まらない（実際に消すのは prefix の配下）ので、組で運ぶ。prefix の無い保存場所は `''`。
 * `keepData: true` は、確認が「消しません」と言った保存場所（`keep` のあるもの）にだけ付く。付いていれば、main は記録がいま何と言っていても、データにもバケットにも鍵にも触れずに残す。
 * 付かない保存場所には、キーも作らない（`false`・`undefined` も付けない）。
 */
export type ShownPlacement = { bucket: string; prefix: string; keepData?: true }

/**
 * 実行に渡す opts（確認の済みの印・確認で見せた保存場所・選択つきの確認で選ばれた値）。選択の無い確認では `choices` を付けない。
 * `shownPlacements` は必須（付け忘れを型で止める）。値は flow.ts の `shownPlacementsOf(facts)` の1か所だけが作る。
 * 保存場所の設定を読めなかった回は `[]`（何も見せていない）。
 */
export type TeardownInvokeOpts = {
  confirmed: true
  shownPlacements: ShownPlacement[]
  choices?: Readonly<Record<string, boolean>>
}

/** 公開先の仕様書。公開先ごとの違いは全部ここに置く（項目の説明は設計書 10.3.3）。 */
export interface TargetSpec<R, A, Res> {
  target: PublishTargetKind
  handler: string
  words: TeardownWords
  /** 「アプリ・ロードバランサ…の課金は止まります」と言ってよいか（原本で確かめた公開先だけ true）。 */
  claimsComputeBillingStops: boolean
  /**
   * 「この操作は元に戻せません」をどこまで言うか（既定値なし・必須。書き忘れを型で止める）。
   *   'always'       … 確認の最後に無条件で言う（専有型・共用型）。
   *   'storage-only' … Koto が消す保存場所のデータがあるときだけ、そのデータについて言う。HANAMII。
   * HANAMII のプロジェクトそのものの削除が元に戻せるかは、原本に書いていない【未確認】ので言わない。
   */
  irreversibleNote: 'always' | 'storage-only'
  readRecord(projectDir: string): Promise<R>
  hasWork(record: R): boolean
  /**
   * 消すものの名前。`placements` は確認の材料（`facts.placements`）で、`keep` の付いた保存場所（消さずに残す）を見分けるために渡す
   * （渡さない・`keep` の無い回は、記録の保存場所をすべて消す側として数える）。
   */
  targets(record: R, placements?: ReadonlyArray<TeardownPlacement | null | undefined> | null): string[]
  /**
   * 確認の見出し（`words.confirmTitle`）を、記録の中身で言い換える（0.6.24 A-8）。null・無いときは `words.confirmTitle` のまま。
   * 共用型は、アプリが無く保存場所・コンテナレジストリだけが残る回に「保存場所を破棄します」と言う（公開を破棄すると言わない）。
   * 保存場所が全部 `keep`（消さない）の回は、消す保存場所に数えない（`targets` と同じく `placements` で見分ける）。
   * **3つの入口（【公開】の 🗑・📡・プロジェクトの削除）は同じ確認の文の作り手（confirm.ts の buildTeardownConfirm）を通る**ので、これ1つで全部に効く。
   */
  confirmTitleOf?(record: R, placements?: ReadonlyArray<TeardownPlacement | null | undefined> | null): string | null
  /**
   * 確認の中に出す選択（チェック）。無い・空なら、選択の無い確認を出す（今までどおり）。共用型の「コンテナレジストリも削除する」。
   * 1件以上あるのに入口が `confirmWithChoices` を渡していなければ、確認も IPC も出さずに失敗の結果にする（選べない確認で破棄させない）。
   */
  choices?(record: R): ConfirmChoice[]
  /**
   * 確認の本文に足す段落（💾・ほかの公開先の段落のあと、時間の予告と最後の問いの前に置く）。無ければ文は今のまま。
   * `placements` は `targets` と同じ（消さずに残す保存場所を「削除します」と言わないために渡す）。
   */
  notes?(record: R, placements?: ReadonlyArray<TeardownPlacement | null | undefined> | null): string[]
  /**
   * 消す保存場所を、記録から決める公開先だけが持つ。持っていれば、確認の保存場所（`facts.placements`）は共通の読み口
   * （`storage:placement`＝env.json の同意済みだけ）ではなくこれになる（確認が言うものと main が消すものを同じ関数で決める。P5）。
   * 共用型は main の `cloud:teardownRecord` が返す `placements`（env.json の同意済み全件 + state にだけある保存場所）。
   */
  placementsOf?(record: R): TeardownPlacement[]
  /**
   * 消すものが記録に無い（幽霊の行）ことを、失敗ではなく**成功の知らせ**として扱う公開先だけが true にする（共用型）。
   * true のとき、流れは結果に `nothingToDo: true` を付ける。入口がそれを見て、失敗の枠でなく中立の知らせで出す・
   * プロジェクトの削除ではそのまま先へ進める。無い・false の公開先（HANAMII・専有型）の結果は今のまま。
   */
  nothingToDoIsOk?: true
  /**
   * 前回の破棄で、公開先のものはもう消えていて保存場所だけが残った回の、確認の最初の段落。残っていなければ null。
   * 専有型の記録の `storageLeftoverBucket` に当たる。返ったときは、「次を{verb}します: …」の段落の代わりにこの文を最初に出す。
   * `placements` は確認の材料（`facts.placements`）で、`keep` の付いた保存場所（消さずに残す）を「削除します」の名前に入れないために渡す
   * （渡さない・`keep` の無い回は、記録の残りの保存場所をすべて消す側として言う）。
   */
  leftoverNote?(record: R, placements?: ReadonlyArray<TeardownPlacement | null | undefined> | null): string | null
  waitNote?(record: R, estimates: unknown): string | null
  loadAuth(record: R): Promise<A | null>
  invoke(projectDir: string, auth: A, opts: TeardownInvokeOpts, record: R): Promise<Res>
  failure(message: string): Res
  /**
   * 記録に、保存場所の鍵（アクセスキーの ID）が残っているか。鍵を記録に持つ公開先（共用型・専有型）だけが持つ。
   * 鍵が残る回は、何も消さない門（teardown/keptNothing.ts）を通さず、確認へ進める。main は鍵が残る回に、鍵を無効にしなかった警告を足すことがあり
   * （ほかのフォルダの記録が同じ鍵の ID を持つ・確かめられない）、画面はそれを読まないので、同じ結果を組めない。
   * `false` と言い切れるときだけ false を返す（不明・欠けは true。門は `false` 以外を「鍵が残る」と読む）。持たない公開先（HANAMII）は、鍵を記録に持たない。
   */
  keyRecorded?(record: R): boolean
  /**
   * 何も消さないと分かっている回（保存場所が全部「消さずに残す」で、消す資源も無い。teardown/keptNothing.ts の門）に、流れが確認も IPC も出さずに返す結果を、この公開先の返り値の形で作る。
   * `reply` は、main が同じ入力で返す結果と同じ文の作り手で組んだもの（shared/keptNothingReply.ts）。3つの仕様書（共用型・HANAMII・専有型）はすべて持つ。
   * 持たない仕様書は、門を通らない（今までどおり確認へ進む）。
   */
  keptNothingResult?(reply: KeptNothingReply): Res
  toView(raw: Res): TeardownView
  subscribeProgress?(cb: (message: string) => void): () => void
}
