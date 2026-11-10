// hanamiiDeletionText.ts — HANAMII が削除を受け付けた（202）あとの、画面に出る文の定数（一元定義）。
// 文はここに置き、main（hanamii:teardown・hanamii:resumeTeardown・待つ側）も画面も定数を引く。teardownResult.ts からも再エクスポートする
// （既存の import を壊さない）。テストは定数から引いて一字一句を固定する。electron・DOM に依存しない。

/** 待っている間の進み具合の文（詳細は「N秒経過」）。 */
export const HANAMII_DELETION_WAIT_PROGRESS = '⏳ HANAMII がプロジェクトを削除し終えるのを待っています…'

/**
 * HANAMII が DELETE を受け付けた（202）が、Koto が待っても削除が済んだと確認できなかった回（`deletionAccepted: true`）の文。
 * Koto は最長で約5分、HANAMII が削除し終えるのを待つ。それでも済まなかった・確かめられなかった回は、保存場所と記録に触れずにここで止まり、
 * 次に Koto を起動したときか、この画面を開き直したときに、続きを自動で確かめて終える（記録に「受け付けの印」が残っている）。
 * main の `hanamii:teardown`・`hanamii:resumeTeardown` が結果の message に使い、`teardownWarningsOf` が警告にも使う（同じ文の作り手を1つにする）。
 * 専有型の「待ち切れずに止まりました」（`TEARDOWN_IN_PROGRESS_WARNING_HEAD`）とは別の文——HANAMII の側の削除がまだ済んでいない。
 */
export const HANAMII_DELETION_ACCEPTED_WARNING =
  'HANAMII の削除が、まだ済んでいません。次に Koto を起動したときか、この画面を開き直したときに、続きを自動で確かめて、削除を終えます。保存場所と記録は、削除が確認できるまで残してあります。'

/**
 * HANAMII が「この削除には確認が要る」と答えた回（`deletionReview: true`。202 の本文の `project.requiresReview === true`）の文。
 * Koto は待たずに止める（待っても終わらない可能性があり、意味は原本に無い）。HANAMII 側の確認が済めば、次に Koto を開いたとき自動で片づく。
 */
export const HANAMII_DELETION_REVIEW_WARNING =
  'HANAMII から、この削除には確認が要るという応答がありました。HANAMII の管理画面で状態を確かめてください。削除が済めば、次に Koto を開いたときに、続きを自動で進めます。保存場所と記録は残してあります。'

/**
 * 続きの自動の確かめの入口が、受け付けの印の無いプロジェクトを断る文（外へは何も出していない）。印が無いのは、削除が済んだ・一覧から削除した・
 * 公開し直した回なので、「続ける必要がない」と言う（画面に内部の仕組みの名前「印」を出さない・掟5-4）。
 * 鍵の前の下見（resumePrecheck）で断る回は処理の記録を作らないので、画面に出るのは、下見と鍵の中の間に印が外れた回だけ。
 */
export const HANAMII_RESUME_NO_MARK_MESSAGE =
  'HANAMII の削除を続ける必要は、もうありませんでした。何も削除していません。'

/**
 * 受け付けの印を、公開の記録に書けなかった回に、結果の「起きたこと」へ足す1行（続きの自動の確かめの根拠が無い）。原因は最後に付ける。
 * 同じ結果の文（HANAMII_DELETION_ACCEPTED_WARNING）は「次に開いたとき自動で続ける」と言うので、「ただし今回は」で受けて食い違わせない。
 * 内部の仕組みの名前「印」は画面に出さない（掟5-4）。
 */
export const HANAMII_ACCEPTED_MARK_FAILED_LINE =
  '⚠️ ただし今回は、自動では続きません。しばらくしてから、もう一度破棄を押してください'
