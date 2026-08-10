import { useEffect, useRef, useState } from 'react'
import type { ModelOption } from '../hooks/useModels'

interface Props {
  models: ModelOption[]
  value: string
  onChange: (id: string) => void
  /** ボタンの見た目（既存のセレクタの見た目を踏襲するため呼び出し側から渡す） */
  buttonClassName?: string
  /** メニューを右ぞろえにする（既定は左ぞろえ） */
  align?: 'left' | 'right'
}

/**
 * モデル選択用の自前ドロップダウン。
 * ネイティブ <select> はブラウザが上下どちらに開くかを自動で決めてしまい「常に下に開く」を
 * 制御できない。そのため下方向（top-full）に固定で開くカスタムUIに置き換えている。
 * 実装は WorkflowBar の公開先メニューと同じハウスパターン（外側mousedown / Escape で閉じる）。
 */
export default function ModelSelect({ models, value, onChange, buttonClassName, align = 'left' }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const currentLabel = models.find(m => m.id === value)?.label ?? value

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={buttonClassName ?? 'flex items-center gap-1 text-xs bg-elevated border border-line rounded-md px-1.5 py-0.5 text-ink hover:border-sakura cursor-pointer transition-colors'}
      >
        <span className="truncate">{currentLabel}</span>
        <span className="text-ink-muted">▾</span>
      </button>
      {open && (
        <div className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full mt-1 z-30 min-w-full max-h-[60vh] overflow-y-auto bg-elevated border border-line-soft rounded-lg py-1 shadow-lg`}>
          {models.map(m => {
            const selected = m.id === value
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { setOpen(false); onChange(m.id) }}
                className={`block w-full text-left px-3 py-1.5 text-xs whitespace-nowrap hover:bg-overlay transition-colors ${selected ? 'text-sakura font-semibold' : 'text-ink-secondary'}`}
              >
                {selected ? '✓ ' : ''}{m.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
