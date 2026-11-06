// EditorSyncBand.tsx — 保存を止めたタブの上に出す帯（外で書き換わった・消えた・読めない）。
// 文とボタンは editorSyncBand.ts が持つ。ここは描くだけ（押したあとの流れも向こうの runBandAction）。

import React from 'react'
import { syncBandOf, type BandAction } from '../editorSyncBand'

interface Props {
  /** タブの止めた印。無ければ何も描かない。 */
  mark: string | undefined
  /** 操作の最中（二重に押させない）。 */
  busy: boolean
  onAction: (action: BandAction) => void
}

export default function EditorSyncBand({ mark, busy, onAction }: Props) {
  const band = syncBandOf(mark)
  if (!band) return null
  return (
    <div
      role="alert"
      className="flex-none flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-brand-yellow/70 bg-surface px-4 py-2.5"
    >
      <p className="flex-1 min-w-[12rem] text-xs text-ink-secondary leading-relaxed select-text">{band.message}</p>
      <div className="flex flex-none gap-2">
        {band.actions.map(a => (
          <button
            key={a.id}
            disabled={busy}
            onClick={() => onAction(a.id)}
            className="bg-overlay text-ink border border-line rounded-lg px-3 py-1.5 text-xs font-medium hover:border-sakura disabled:opacity-50"
          >{a.label}</button>
        ))}
      </div>
    </div>
  )
}
