// ProjectDeleteProgressLine.tsx — プロジェクトの削除の窓が、HANAMII の削除を待っている間に出す進み具合の1行。
// 読む部分は teardown/projectDeleteProgress.ts。ここは記録を聞いて描くだけ（ack はしない。結果は窓が自分の返り値から出す）。
// 窓が busy の間だけ置く。記録はこのプロジェクトのものだけを受ける（watchProjectOps が別のプロジェクトの知らせを捨てる）。
import { useEffect, useState } from 'react'
import { watchProjectOps } from '../../projectOpsView'
import { projectDeleteProgressLine } from '../../teardown/projectDeleteProgress'

export default function ProjectDeleteProgressLine({ projectDir }: { projectDir: string }) {
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    const watch = watchProjectOps(window.electronAPI.projectOps, projectDir, snap => setLine(projectDeleteProgressLine(snap)))
    return () => watch.stop()
  }, [projectDir])
  if (line === null) return null
  return <p className="text-ink-secondary select-text" data-project-delete-progress>{line}</p>
}
