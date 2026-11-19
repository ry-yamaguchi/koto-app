import { useEffect, useRef, useState } from 'react'
import CopyButton from './CopyButton'
import FailureLines from './FailureLines'
import { useConfirm } from '../useConfirm'
import { failureCopyNow } from '../failureCopy'
import { runOsvFlow } from '../osvCheck'
import { hasOsvConsent, recordOsvConsent } from '../osvConsent'
import {
  OSV_SECTION_TITLE, OSV_BUTTON_LABEL, OSV_BUTTON_BUSY_LABEL, OSV_DESCRIPTION, osvViewText,
  type OsvView, type OsvViewLine,
} from '../osvCheckWords'

// 🛡 の節の「ライブラリの脆弱性」。押したときだけ動く（自動では走らせない）。
// 流れは runOsvFlow の1か所。同意の有無は押した時点で osvConsent から読み、このコンポーネントの状態には持たない。
export default function OsvCheckBlock({ projectDir }: { projectDir: string }) {
  // 調べている最中の印は、押したプロジェクトの持ち物（別のプロジェクトを開いたら、そこでは押せる）
  const [busyDir, setBusyDir] = useState<string | null>(null)
  const busy = busyDir === projectDir
  const [view, setView] = useState<OsvView | null>(null)
  const { confirm, element: confirmElement } = useConfirm()
  // 押した時点の projectDir を覚え、返ってきたときに今のものと比べる
  const dirRef = useRef(projectDir)
  dirRef.current = projectDir

  useEffect(() => { setView(null) }, [projectDir])

  async function run() {
    if (busy) return
    const started = projectDir
    setBusyDir(started)
    try {
      const outcome = await runOsvFlow({
        preview: (dir) => window.electronAPI.osv.preview(dir),
        check: (dir, consented) => window.electronAPI.osv.check(dir, consented),
        hasConsent: hasOsvConsent,
        recordConsent: () => { recordOsvConsent() },
        confirm: (o) => confirm(o),
      }, started)
      if (outcome.kind === 'view' && dirRef.current === started) setView(outcome.view)
    } finally {
      setBusyDir(cur => (cur === started ? null : cur))
    }
  }

  function renderLine(l: OsvViewLine, i: number) {
    switch (l.kind) {
      case 'head':
        return <p key={i} className="text-xs font-semibold text-ink">{l.text}</p>
      case 'note':
        return <p key={i} className="text-[11px] text-ink-muted">{l.text}</p>
      case 'failure':
        return <p key={i} className="text-xs text-ink-secondary leading-relaxed"><FailureLines text={l.text} /></p>
      case 'vuln': {
        const at = l.link && l.linkText ? l.text.indexOf(l.linkText) : -1
        if (!l.link || !l.linkText || at < 0) return <p key={i} className="text-xs text-ink-secondary pl-3">{l.text}</p>
        const link = l.link
        return (
          <p key={i} className="text-xs text-ink-secondary pl-3">
            {l.text.slice(0, at)}
            <button type="button" onClick={() => window.open(link)} className="underline hover:text-sakura">{l.linkText}</button>
            {l.text.slice(at + l.linkText.length)}
          </p>
        )
      }
      case 'lib':
        return <p key={i} className="text-xs text-ink">{l.text}</p>
      default:
        return <p key={i} className="text-xs text-ink-secondary leading-relaxed">{l.text}</p>
    }
  }

  return (
    <div className="border-t border-line pt-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink-secondary">{OSV_SECTION_TITLE}</p>
        <button
          onClick={() => { void run() }}
          disabled={busy}
          className="bg-overlay text-ink border border-line rounded-md px-3 py-1 text-xs font-medium hover:border-sakura disabled:opacity-40"
        >{busy ? OSV_BUTTON_BUSY_LABEL : OSV_BUTTON_LABEL}</button>
      </div>
      <p className="text-[11px] text-ink-muted leading-relaxed">{OSV_DESCRIPTION}</p>
      {view && (
        <div className="rounded-lg border border-line p-3 space-y-1 select-text">
          <div className="flex items-start gap-2">
            <div className="flex-1 space-y-1">{view.lines.map(renderLine)}</div>
            <CopyButton
              text={osvViewText(view)}
              title="結果をコピー"
              getText={view.verdict === 'skip' ? () => failureCopyNow(osvViewText(view)) : undefined}
            />
          </div>
        </div>
      )}
      {confirmElement}
    </div>
  )
}
