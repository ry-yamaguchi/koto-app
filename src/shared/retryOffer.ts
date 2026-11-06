// retryOffer.ts — 失敗の吹き出しの「もう一度送る」ボタン（純粋ロジック）。
//
// 失敗の吹き出しは印（offerRetry）だけを持つ（chatFailure.ts）。送り直す材料（依頼の文と画像）は、
// 押した時点の会話から取り出す。画像のデータ URL を会話の保存に二重に入れないため。
// ボタンを出す・出さないの判断と材料の取り出しをここ1か所に集め、ChatPanel・ChatApp・useAiChat が
// 同じ答えを使う（electron にも React にも依存しない）。

type Bubble = {
  role: string
  content?: string
  hidden?: boolean
  summary?: unknown
  images?: string[]
  offerRetry?: true | boolean
}

/** 利用者が画面で見ている依頼の吹き出し（AI への内部指示 hidden・まとめ summary は含めない）。 */
function isVisibleRequest(m: Bubble): boolean {
  return m.role === 'user' && !m.hidden && !m.summary
}

/**
 * 「もう一度送る」で送り直す依頼。最後の失敗の吹き出しより前で、最後の見える利用者の吹き出し。
 * 失敗の吹き出しが無い・材料になる吹き出しが無い・中身が空のときは null（送らない）。
 */
export function retryRequestOf(messages: readonly Bubble[]): { text: string; images: string[] } | null {
  let failureAt = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].offerRetry) { failureAt = i; break }
  }
  if (failureAt < 0) return null
  for (let i = failureAt - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isVisibleRequest(m)) continue
    const text = m.content ?? ''
    const images = m.images ?? []
    if (!text.trim() && images.length === 0) return null
    return { text, images }
  }
  return null
}

/**
 * i 番目の吹き出しに「もう一度送る」を出すか。`offerRetry` があり、以降に見える利用者の吹き出しも
 * 別の失敗の吹き出しも無く（送り直したあと・次の依頼を送ったあと・失敗が続いたときは、古い失敗には出さない）、送り直す材料があるときだけ真。
 * `shown` は画面に並べている吹き出し。
 */
export function showsRetry(shown: readonly Bubble[], i: number): boolean {
  if (!shown[i]?.offerRetry) return false
  for (let k = i + 1; k < shown.length; k++) {
    if (isVisibleRequest(shown[k]) || shown[k].offerRetry) return false
  }
  return retryRequestOf(shown.slice(0, i + 1)) !== null
}
