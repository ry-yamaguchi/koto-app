// KeptNothingHint.tsx — 📡 公開したもの一覧で、何も消さなかった回の結果に添える、行の消し方の一言。
//
// 何も消さなかった回は、公開の記録（この一覧の行）が消えずに残る。残る行を、利用者が自分で片づけられることを言う。
// 出すのは、確認も main も出さずに画面が結果を組んだ回（`keptNothing`）と、main まで届いて何も消さずに返した回（結果の `keptOnly`）。
// 何かを消した回には出さない（その行は消える）。3つの公開先の結果欄が同じこの部品を使う。
import type { TeardownFlowOutcome } from '../../teardown/useTeardownFlow'

/** 消すものが記録に無かった回（共用型の「破棄するものはありません」）と、何も消さなかった回が、同じ一言で行の消し方を言う。 */
export const LIST_ROW_FORGET_HINT = 'この行は「一覧から削除」で消せます。'

/** 一言を出す回か。`keptNothing`・`view.keptOnly` は、どちらも真偽値の `true` だけを真と読む（文字列・その他は読まない）。 */
export function keepsListRow(outcome: { keptNothing?: unknown; view?: { keptOnly?: unknown } | null }): boolean {
  return outcome.keptNothing === true || outcome.view?.keptOnly === true
}

export default function KeptNothingHint({ outcome }: { outcome: Pick<TeardownFlowOutcome, 'keptNothing'> & { view?: { keptOnly?: unknown } | null } }) {
  if (!keepsListRow(outcome)) return null
  return <p className="text-xs text-ink-secondary leading-relaxed select-text" data-kept-nothing-hint>{LIST_ROW_FORGET_HINT}</p>
}
