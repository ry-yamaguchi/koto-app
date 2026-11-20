import CopyButton from './CopyButton'
import FailureLines from './FailureLines'
import { failureCopyNow } from '../failureCopy'
import { PUBLISH_SCAN_TITLE, publishScanViewText, type ScanView, type ScanViewLine } from '../publishScanWords'

// 🛡 の節の「Koto の点検」の結果。行の並びは publishScanViewOf が決め、ここは描くだけ。
export default function PublishScanResult({ view, hideTitle }: { view: ScanView; hideTitle?: boolean }) {
  function renderLine(l: ScanViewLine, i: number) {
    switch (l.kind) {
      case 'head':
        return <p key={i} className="text-xs font-semibold text-ink">{l.text}</p>
      case 'group':
        return <p key={i} className="text-[11px] font-semibold text-ink-secondary pt-1">{l.text}</p>
      case 'finding':
        return <p key={i} className="text-xs text-ink-secondary pl-3">{l.text}</p>
      case 'note':
        return <p key={i} className="text-[11px] text-ink-muted">{l.text}</p>
      case 'failure':
        return <p key={i} className="text-xs text-ink-secondary leading-relaxed"><FailureLines text={l.text} /></p>
      default:
        return <p key={i} className="text-xs text-ink-secondary leading-relaxed">{l.text}</p>
    }
  }

  return (
    <div className="rounded-lg border border-line p-3 space-y-1 select-text">
      {!hideTitle && <p className="text-[11px] text-ink-muted">{PUBLISH_SCAN_TITLE}</p>}
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-1">{view.lines.map(renderLine)}</div>
        <CopyButton
          text={publishScanViewText(view)}
          title="結果をコピー"
          getText={view.verdict === 'skip' ? () => failureCopyNow(publishScanViewText(view)) : undefined}
        />
      </div>
    </div>
  )
}
