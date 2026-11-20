import { useEffect, useRef, useState } from 'react'
import PublishScanResult from './PublishScanResult'
import { runPublishScanView } from '../publishScanRun'
import { GITHUB_SCAN_TITLE, GITHUB_SCAN_NOTE, PUBLISH_SCAN_BUTTON_NO_AI, PUBLISH_SCAN_BUSY, type ScanView } from '../publishScanWords'

/** 点検して、押した時点のプロジェクトのままのときだけ結果を置く。 */
export async function scanAndPlace(
  started: string,
  current: () => string,
  place: (v: ScanView) => void,
): Promise<void> {
  const view = await runPublishScanView(started, 'github')
  if (current() === started) place(view)
}

// GitHub に保存するファイルの点検。押したときだけ走り、保存は止めない（親へ何も返さない）。
export default function GithubSaveScan({ projectDir }: { projectDir: string }) {
  const [busy, setBusy] = useState(false)
  const [scan, setScan] = useState<ScanView | null>(null)
  const dirRef = useRef(projectDir)
  dirRef.current = projectDir

  useEffect(() => { setScan(null) }, [projectDir])

  async function run() {
    if (busy) return
    setBusy(true)
    setScan(null)
    try {
      await scanAndPlace(projectDir, () => dirRef.current, setScan)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink">{GITHUB_SCAN_TITLE}</p>
        <button
          onClick={() => { void run() }}
          disabled={busy}
          className="bg-overlay text-ink border border-line rounded-md px-3 py-1 text-xs font-medium hover:border-sakura disabled:opacity-40"
        >{busy ? PUBLISH_SCAN_BUSY : PUBLISH_SCAN_BUTTON_NO_AI}</button>
      </div>
      <p className="text-[11px] text-ink-muted leading-relaxed">{GITHUB_SCAN_NOTE}</p>
      {scan && <PublishScanResult view={scan} hideTitle />}
    </div>
  )
}
