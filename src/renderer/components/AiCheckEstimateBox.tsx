import { estimateViewOf, type AiEstimate } from '../aiCheckEstimate'
import FailureLines from './FailureLines'

// 🛡 の節の「送る前の見積り」の枠。文と、ボタンを出すかの判断は estimateViewOf が決め、ここは描くだけ。
export default function AiCheckEstimateBox({ estimate, running, disabled, onRun }: {
  estimate: AiEstimate
  /** AI の確認が走っている間（札を「確認中…」にする） */
  running: boolean
  /** 点検・AI の確認のどちらかが走っている間は押せない */
  disabled: boolean
  onRun: () => void
}) {
  const view = estimateViewOf(estimate)
  return (
    <div className="rounded-lg border border-line p-3 space-y-1 select-text">
      {view.lines.map((l, i) => {
        switch (l.kind) {
          case 'note':
            return <p key={i} className="text-[11px] text-ink-muted">{l.text}</p>
          case 'warning':
            return <p key={i} className="text-[11px] text-ink-secondary">{l.text}</p>
          case 'failure':
            return <p key={i} className="text-xs text-ink-secondary leading-relaxed"><FailureLines text={l.text} /></p>
          default:
            return <p key={i} className="text-xs text-ink-secondary leading-relaxed">{l.text}</p>
        }
      })}
      {view.canSend && (
        <button
          onClick={onRun}
          disabled={disabled}
          className="bg-overlay text-ink border border-line rounded-md px-3 py-1 text-xs font-medium hover:border-sakura disabled:opacity-40"
        >{running ? '確認中…' : 'AIに確認してもらう'}</button>
      )}
    </div>
  )
}
