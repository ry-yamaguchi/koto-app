// WriteFixButton.tsx — ⚠️ の吹き出し（書いた中身の点検）に付く「🛠 AIに修正させる」ボタン。
//
// 見え方（出す・押せない）は writeFix.ts の writeFixButtonState が決める。
// 押したときの処理は親から受ける。応答中は押せない。

import React from 'react'
import type { WriteFixMark } from '../../shared/securityFindings'
import { WRITE_FIX_BUTTON_LABEL, writeFixButtonState } from '../writeFix'

export default function WriteFixButton({ marks, dir, isLoading, onPress }: {
  /** 吹き出しの `writeFix` */
  marks: readonly WriteFixMark[] | undefined
  /** いま開いているプロジェクト */
  dir: string | null | undefined
  isLoading: boolean
  onPress: () => void
}) {
  const { show, disabled } = writeFixButtonState({ marks, dir, isLoading })
  if (!show) return null
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      className="mt-2 sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
    >{WRITE_FIX_BUTTON_LABEL}</button>
  )
}
