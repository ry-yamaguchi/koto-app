// RetryButton.tsx — 失敗の吹き出しに付く「もう一度送る」ボタン。
//
// 出す・出さないの判断は shared/retryOffer.ts の showsRetry が決める（呼び出し側が渡す）。
// 押したときの処理は親から受ける。応答中は押せない。

import React from 'react'

/** ボタンの文。 */
export const RETRY_BUTTON_LABEL = 'もう一度送る'

export default function RetryButton({ show, isLoading, onPress }: {
  /** showsRetry(shown, i) の答え */
  show: boolean
  isLoading: boolean
  onPress: () => void
}) {
  if (!show) return null
  return (
    <button
      onClick={onPress}
      disabled={isLoading}
      className="mt-2 sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
    >{RETRY_BUTTON_LABEL}</button>
  )
}
