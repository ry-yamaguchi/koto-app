// ConfirmModal.tsx — 破壊操作・実行前の確認を出す、Koto 共通の確認ダイアログ（判断9・2026-09-11）。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
// 掟5「破壊操作は必ず確認ダイアログ」は、これまで2つの流儀が混在していた:
//   ① AppRunPanel.tsx の🗑破棄確認（赤枠・自前のモーダル）
//   ② window.confirm（RollbackSection・Sidebar のファイル移動・専有型⑤⑥ 等）
// window.confirm はブラウザ標準のダイアログで、Koto の見た目（テーマ・フォント・
// select-text＋コピー可能なエラー文言）に乗らず、ライトモードでの見え方も統一できない。
// ここに①の見た目（rounded-xl border border-brand-red/70 bg-surface p-4・本文
// select-text・「やめる」／実行の2ボタン）を一般化し、以後はこれだけを使う
// （2026-09-11 CLAUDE.md 掟5 改定）。
//
// 判断ロジック（open/onConfirm/onCancel のどれが呼ばれるか）はこのコンポーネント自身は
// 持たない——呼び出し側（useConfirm.tsx）が Promise<boolean> に変換する。ここは表示だけ。

export interface ConfirmModalProps {
  open: boolean
  title: string
  /** 本文（複数行可）。select-text にして、必要ならそのままコピーできるようにする（掟5）。 */
  body: string
  confirmLabel?: string
  cancelLabel?: string
  /** true なら赤枠・赤いボタン（元に戻せない／課金が続く等の強い確認）。既定 false。 */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = '実行する',
  cancelLabel = 'やめる',
  danger = false,
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
