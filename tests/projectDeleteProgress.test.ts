import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { projectDeleteProgressLine } from '../src/renderer/teardown/projectDeleteProgress'
import { HANAMII_DELETION_WAIT_PROGRESS } from '../src/shared/hanamiiDeletionText'

// プロジェクトの削除の窓が、待っている間に出す進み具合の1行（読む部分）。文は main の定数（HANAMII_DELETION_WAIT_PROGRESS）から引く。
const rec = (over: Record<string, unknown> = {}) => ({
  op: '削除', target: 'hanamii', handler: 'hanamii:teardown', startedAt: 1, running: true,
  progress: { label: HANAMII_DELETION_WAIT_PROGRESS, detail: '45秒経過' }, seen: false, ...over,
}) as unknown as ProjectOpRecordShape
const snap = (running: ProjectOpRecordShape | null) => ({ running, last: null, earlier: [] }) as ProjectOpsSnapshotShape

describe('projectDeleteProgressLine', () => {
  it('走っている HANAMII の破棄の「待ちの文 N秒経過」を出す（定数から引く）', () => {
    expect(projectDeleteProgressLine(snap(rec()))).toBe(`${HANAMII_DELETION_WAIT_PROGRESS} 45秒経過`)
  })
  it('自動の続き（resumeTeardown）の記録も出す', () => {
    expect(projectDeleteProgressLine(snap(rec({ handler: 'hanamii:resumeTeardown' })))).toBe(`${HANAMII_DELETION_WAIT_PROGRESS} 45秒経過`)
  })
  it('別の公開先の破棄・HANAMII の公開・走っていない記録・文が空の記録・無い記録は出さない', () => {
    expect(projectDeleteProgressLine(snap(rec({ target: 'sakura-apprun', handler: 'cloud:teardown' })))).toBeNull()
    expect(projectDeleteProgressLine(snap(rec({ handler: 'hanamii:publish' })))).toBeNull()
    expect(projectDeleteProgressLine(snap(rec({ running: false })))).toBeNull()
    expect(projectDeleteProgressLine(snap(rec({ progress: { label: '', detail: '' } })))).toBeNull()
    expect(projectDeleteProgressLine(snap(null))).toBeNull()
    expect(projectDeleteProgressLine(null)).toBeNull()
    expect(projectDeleteProgressLine({} as ProjectOpsSnapshotShape)).toBeNull()
  })
  it('終わった記録（last）は読まない（待っている間だけ）', () => {
    expect(projectDeleteProgressLine({ running: null, last: rec({ running: false }), earlier: [] } as unknown as ProjectOpsSnapshotShape)).toBeNull()
  })
})

describe('窓の配線', () => {
  const src = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
  it('窓は busy の間だけ、projectDir を渡して1行を置く。記録は ack しない', () => {
    const dialog = src('src/renderer/components/ProjectDeleteDialog.tsx')
    expect(dialog).toContain('{busy && <ProjectDeleteProgressLine projectDir={projectDir} />}')
    const line = src('src/renderer/components/teardown/ProjectDeleteProgressLine.tsx')
    expect(line).toContain('watchProjectOps(window.electronAPI.projectOps, projectDir, snap => setLine(projectDeleteProgressLine(snap)))')
    expect(line).not.toMatch(/\back\(|sendAck|ackShown/)
  })
})
