import React from 'react'
import CopyButton from './CopyButton'
import { splitFailureDetail, FAILURE_DETAIL_LABEL } from '../../shared/failureDetail'
import { FAILURE_DETAIL_CLASS } from './FailureLines'
import { failureCopyNow } from '../failureCopy'

// 赤い帯の失敗表示（掟5: select-text＋コピーボタン）。見た目は従来の赤い塗り／赤い文字のまま。
// 帯ごとの余白・文字の大きさの違いは className で渡す（省略時は標準の帯）。
const FILL_CLASS = 'text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed'
const TEXT_CLASS = 'text-[11px] text-brand-red'

export default function ErrorBand({ text, tone = 'fill', className, children }: {
  text: string
  /** fill＝赤い塗りの帯／text＝赤い文字だけ（接続テストの結果など） */
  tone?: 'fill' | 'text'
  className?: string
  /** 文のあとに続ける操作（例: 認証情報を開く） */
  children?: React.ReactNode
}) {
  const base = className ?? (tone === 'fill' ? FILL_CLASS : TEXT_CLASS)
  const buttonClass = tone === 'fill'
    ? 'flex-none text-[11px] text-white underline hover:opacity-80'
    : 'flex-none text-[11px] text-sakura hover:underline'
  // 文 → 続ける操作（children）→ 詳細の行、の順に描く（操作のボタンを詳細の下へ押し出さない）。
  const { text: main, detail } = splitFailureDetail(text)
  return (
    <div className={`${base} flex items-start gap-2`}>
      <span className="flex-1 select-text">
        {main}{children}
        {detail && <span className={FAILURE_DETAIL_CLASS}>{FAILURE_DETAIL_LABEL}{detail}</span>}
      </span>
      {/* コピーは共通の CopyButton（ほかの画面のコピーと同じ言い方・押したら「✓ コピーしました」）。文・詳細・版・日時を写す */}
      <CopyButton text={text} getText={() => failureCopyNow(text)} className={buttonClass} />
    </div>
  )
}
