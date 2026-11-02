// TargetCheckButton.tsx — 公開先を変えたあとの案内の吹き出しに付く「この公開先で動くか AI に確かめる」ボタン。
//
// 見え方（出す・隠す・押せない）は targetCheck.ts の targetCheckButtonState が決める。
// 押したときの処理は親から受ける。応答中は押せない。押したあとは、押す前の吹き出しのボタンだけ隠れる。

import React from 'react'
import { TARGET_CHECK_BUTTON_LABEL, targetCheckButtonState, type TargetCheckSpent } from '../targetCheck'

export default function TargetCheckButton({ offered, dir, spent, at, isLoading, onPress }: {
  /** 吹き出しの `offerTargetCheck` */
  offered: boolean | undefined
  /** いま開いているプロジェクト */
  dir: string | null | undefined
  /** プロジェクトごとにボタンを押した時刻 */
  spent: TargetCheckSpent
  /** 吹き出しの時刻（押した時刻より後の吹き出しにだけ出すため） */
  at?: string
  isLoading: boolean
  onPress: () => void
}) {
  const { show, disabled } = targetCheckButtonState({ offered, dir, spent, isLoading, at })
  if (!show) return null
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      className="mt-2 sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
    >{TARGET_CHECK_BUTTON_LABEL}</button>
  )
}
