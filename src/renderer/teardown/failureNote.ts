// 破棄の流れ（書き込みの経路）が投げた失敗を、利用者向けの日本語1文にする。
// 通信が途中で切れたとき、破棄が済んだかは分からない。確かめる場所は公開したものの一覧（📡）なので、
// 破棄の流れの画面はみな、ここを通して文を作る（確かめる場所の名前を1か所に置く）。
import { failureText } from '../../shared/failureText'

/** 破棄の途中で切れたときに、状態を確かめる場所。 */
export const TEARDOWN_CHECK_AT = '📡 公開したもの一覧'

export function teardownFailureText(e: unknown): string {
  return failureText(e, { checkAt: TEARDOWN_CHECK_AT })
}
