// OfflineBanner.tsx — 回線が切れているときだけ、画面の上に出す1行の帯。
// ボタンは置かない。押せるものも止めない（印は「届かない」を見分けられないため。押したあとの失敗の文が本番）。

import React from 'react'
import { useOnlineStatus } from '../hooks/useOnlineStatus'

export const OFFLINE_BANNER_TEXT = 'インターネットに接続されていません。AI や公開は、接続してからお使いください。'

export default function OfflineBanner() {
  const online = useOnlineStatus()
  if (online) return null
  // 注意の帯（黄の縁）の色づかい。文字はテーマの文字色なので、ライトモードでも読める。
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex-none border-b border-brand-yellow/70 bg-surface px-4 py-1.5 text-xs text-ink-secondary leading-relaxed select-text"
    >
      {OFFLINE_BANNER_TEXT}
    </div>
  )
}
