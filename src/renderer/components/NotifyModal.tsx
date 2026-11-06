// NotifyModal.tsx — 操作の失敗や断りを知らせる、OK が1つだけの窓（window.alert の代わり。useConfirm の notify が出す）。
// 枠は ui/Modal.tsx（alertdialog）。Esc と背景クリックは OK と同じ（閉じるだけ）。本文は select-text（原因をコピーできるように。掟5）。

import Modal from '../ui/Modal'
import FailureLines from './FailureLines'

export const NOTIFY_TITLE_ID = 'notify-modal-title'
export const NOTIFY_BODY_ID = 'notify-modal-body'

export interface NotifyModalProps {
  open: boolean
  title: string
  body: string
  okLabel?: string
  onClose: () => void
}

export default function NotifyModal({ open, title, body, okLabel = 'OK', onClose }: NotifyModalProps) {
  if (!open) return null
  return (
    <Modal
      role="alertdialog"
      labelledBy={NOTIFY_TITLE_ID}
      describedBy={NOTIFY_BODY_ID}
      backdropClassName="bg-black/30 p-4"
      panelClassName="w-full max-w-md rounded-xl border border-line bg-surface p-4 space-y-3"
      onRequestClose={() => onClose()}
    >
      <p id={NOTIFY_TITLE_ID} className="text-sm font-semibold text-ink">{title}</p>
      <p id={NOTIFY_BODY_ID} className="text-sm text-ink-secondary leading-relaxed select-text whitespace-pre-wrap"><FailureLines text={body} /></p>
      <div className="flex justify-end pt-1">
        <button
          onClick={onClose}
          data-autofocus
          className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
        >{okLabel}</button>
      </div>
    </Modal>
  )
}
