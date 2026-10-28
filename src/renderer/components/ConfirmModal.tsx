// ConfirmModal.tsx — 破壊操作・実行前の確認を出す、Koto 共通の確認ダイアログ（判断9・2026-09-11）。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
// 掟5「破壊操作は必ず確認ダイアログ」は、これまで2つの流儀が混在していた:
//   (1) AppRunPanel.tsx の🗑破棄確認（赤枠・自前のモーダル）
//   (2) window.confirm（RollbackSection・Sidebar のファイル移動・専有型の手順5・6 等）
// window.confirm はブラウザ標準のダイアログで、Koto の見た目（テーマ・フォント・
// select-text＋コピー可能なエラー文言）に乗らず、ライトモードでの見え方も統一できない。
// ここに(1)の見た目（rounded-xl border border-brand-red/70 bg-surface p-4・本文
// select-text・「キャンセル」／実行の2ボタン）を一般化し、以後はこれだけを使う
// （2026-09-11 CLAUDE.md 掟5 改定）。
//
// 判断ロジック（open/onConfirm/onCancel のどれが呼ばれるか）はこのコンポーネント自身は
// 持たない——呼び出し側（useConfirm.tsx）が Promise<boolean> に変換する。ここは表示だけ。

/**
 * 確認の中に出すチェック欄の1件（任意。段階2・2b-1 で足した）。例: 「コンテナレジストリも削除する」。
 * 答えの組み立て（値が無いときの既定・不明な値の扱い）は useConfirmChoices.tsx の resolveConfirmWithChoices が持つ。ここは描くだけ。
 */
export interface ConfirmChoice {
  id: string
  label: string
  defaultChecked: boolean
  /** 赤い注意（例: 借り物の置き場の断り）。 */
  note?: string
  /** チェックの状態で変わる説明（例: 消すと月額が止まる／残すと続く）。今のチェックの状態の側が空の文字列なら、説明は出さない。 */
  help?: { checked: string; unchecked: string }
}

export interface ConfirmModalProps {
  open: boolean
  title: string
  /** 本文（複数行可）。select-text にして、必要ならそのままコピーできるようにする（掟5）。 */
  body: string
  confirmLabel?: string
  cancelLabel?: string
  /** true なら赤枠・赤いボタン（元に戻せない／課金が続く等の強い確認）。既定 false。 */
  danger?: boolean
  /** 本文とボタンの間に出すチェック欄。無い・空なら何も描かない（今までの確認と同じ）。 */
  choices?: ConfirmChoice[]
  /** チェックの状態（id → 入っているか）。無い id は defaultChecked。 */
  choiceValues?: Record<string, boolean>
  onToggleChoice?: (id: string, checked: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = '実行する',
  cancelLabel = 'キャンセル',
  danger = false,
  choices,
  choiceValues,
  onToggleChoice,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onCancel}
    >
      <div
        className={`w-full max-w-md rounded-xl border ${danger ? 'border-brand-red/70' : 'border-line'} bg-surface p-4 space-y-3`}
        onClick={e => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-ink">{danger ? '⚠️ ' : ''}{title}</p>
        <p className="text-sm text-ink-secondary leading-relaxed select-text whitespace-pre-wrap">{body}</p>
        {choices && choices.length > 0 && (
          <div className="space-y-2">
            {choices.map(c => {
              const checked = choiceValues?.[c.id] ?? c.defaultChecked
              return (
                <div key={c.id} className="space-y-1">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={e => onToggleChoice?.(c.id, e.target.checked)}
                      className="mt-0.5 accent-[rgb(var(--sakura-rgb))]"
                    />
                    <span className="text-sm text-ink font-medium">{c.label}</span>
                  </label>
                  {c.note && <p className="text-xs text-brand-red leading-relaxed pl-6 select-text">⚠️ {c.note}</p>}
                  {/* 空の説明は出さない（チェックの名前の言い直しになる説明は、呼び手が空にする） */}
                  {c.help && (checked ? c.help.checked : c.help.unchecked) !== '' && (
                    <p className={`text-xs leading-relaxed pl-6 select-text ${checked ? 'text-ink-secondary' : 'text-brand-red'}`}>
                      {checked ? c.help.checked : c.help.unchecked}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="flex justify-between items-center pt-1">
          <button
            onClick={onCancel}
            className="bg-overlay text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium hover:border-sakura"
          >{cancelLabel}</button>
          <button
            onClick={onConfirm}
            className={danger
              ? 'bg-brand-red-fill text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90'
              : 'sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90'}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
