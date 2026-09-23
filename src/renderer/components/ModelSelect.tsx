import { useEffect, useRef, useState } from 'react'
import type { ModelOption } from '../hooks/useModels'
import { modelPickerText, orderModelsForPicker } from '../../shared/modelInfo'

interface Props {
  models: ModelOption[]
  value: string
  onChange: (id: string) => void
  /** ボタンの見た目（既存のセレクタの見た目を踏襲するため呼び出し側から渡す） */
  buttonClassName?: string
  /** メニューを右ぞろえにする（既定は左ぞろえ） */
  align?: 'left' | 'right'
  /** 一覧の先頭に出す既定モデルの id（DEFAULT_MODEL / DEFAULT_CHAT_MODEL）。
   *  一覧に無い id（例: Claudeモデル一覧に さくらの既定idを渡した場合）を渡しても並びは変わらない。 */
  defaultId?: string
}

/**
 * マウスオーバーで出す説明（純関数）。modelPickerText(id).description が空（表に無い未知の id）なら
 * null を返し、呼び出し側はツールチップを出さない。判断はここ1つを通す（掟10）。
 */
export function pickerTooltip(id: string): string | null {
  const description = modelPickerText(id).description
  return description ? description : null
}

/**
 * モデル選択用の自前ドロップダウン。
 * ネイティブ <select> はブラウザが上下どちらに開くかを自動で決めてしまい「常に下に開く」を
 * 制御できない。そのため下方向（top-full）に固定で開くカスタムUIに置き換えている。
 * 実装は WorkflowBar の公開先メニューと同じハウスパターン（外側mousedown / Escape で閉じる）。
 *
 * 【UX-A2・2026-09-15 Ryosuke さん実機判断】見える文字はモデル名（modelPickerText(id, label).name。
 * label は一覧の ModelOption.label＝Claude 一覧なら claudeMode.ts の名前）、目的の説明はマウスオーバー。ネイティブの title は文字の大きさを変えられないので使わず、
 * 自前のツールチップを2か所に出す（一覧の文字 text-xs より大きい text-sm）:
 *   - ボタンにマウスオーバー → ボタンの直下（ドロップダウンが閉じているときだけ）
 *   - 一覧の各行にマウスオーバー → ドロップダウン枠の最下段（スクロール領域の外。枠内スクロールで切れない）
 */
export default function ModelSelect({ models, value, onChange, buttonClassName, align = 'left', defaultId }: Props) {
  const [open, setOpen] = useState(false)
  const [buttonHover, setButtonHover] = useState(false)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  // 【UX-A・判断1】既定モデルを先頭に。
  // defaultId が一覧に無ければ orderModelsForPicker は並びを変えずに返す（Claudeモデル一覧等）。
  const ordered = defaultId
    ? orderModelsForPicker(models.map(m => m.id), defaultId)
        .map(id => models.find(m => m.id === id))
        .filter((m): m is ModelOption => !!m)
    : models

  useEffect(() => {
    if (!open) { setHoverId(null); return }
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

  const side = align === 'right' ? 'right-0' : 'left-0'
  // 見える文字は、一覧が持つ label を modelPickerText へ渡して決める（表示の元は modelPickerText の1つ・掟10）。
  // Claude 頭脳モードの一覧（claudeMode.ts の label／ライブ取得の displayName）は さくらの表に無いので、
  // label を渡さないと「claude-sonnet-5」のような技術 id が見えてしまう（2026-09-15 検分で発覚）。
  const current = models.find(m => m.id === value)
  const currentName = value ? modelPickerText(value, current?.label).name : ''
  // ボタン直下のツールチップ（開いている間はドロップダウンと重なるので出さない）
  const buttonTip = !open && buttonHover && value ? pickerTooltip(value) : null
  // 一覧の最下段の説明欄（マウスオーバー中の行の説明。行から外れたら消す）
  const listTip = hoverId ? pickerTooltip(hoverId) : null

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        onMouseEnter={() => setButtonHover(true)}
        onMouseLeave={() => setButtonHover(false)}
        className={buttonClassName ?? 'flex items-center gap-1 text-xs bg-elevated border border-line rounded-md px-1.5 py-0.5 text-ink hover:border-sakura cursor-pointer transition-colors'}
      >
        <span className="truncate">{currentName}</span>
        <span className="text-ink-muted">▾</span>
      </button>
      {buttonTip && (
        <div className={`absolute ${side} top-full mt-1 z-40 bg-elevated border border-line rounded-md px-2 py-1 shadow-lg text-sm text-ink whitespace-nowrap pointer-events-none`}>{buttonTip}</div>
      )}
      {open && (
        <div className={`absolute ${side} top-full mt-1 z-30 min-w-full bg-elevated border border-line-soft rounded-lg shadow-lg`}>
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {ordered.map(m => {
              const selected = m.id === value
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { setOpen(false); onChange(m.id) }}
                  onMouseEnter={() => setHoverId(m.id)}
                  onMouseLeave={() => setHoverId(null)}
                  className={`block w-full text-left px-3 py-1.5 text-xs whitespace-nowrap hover:bg-overlay transition-colors ${selected ? 'text-sakura font-semibold' : 'text-ink-secondary'}`}
                >
                  {selected ? '✓ ' : ''}{modelPickerText(m.id, m.label).name}
                </button>
              )
            })}
          </div>
          {listTip && (
            <div className="border-t border-line-soft px-3 py-1.5 text-sm text-ink whitespace-nowrap">{listTip}</div>
          )}
        </div>
      )}
    </div>
  )
}
