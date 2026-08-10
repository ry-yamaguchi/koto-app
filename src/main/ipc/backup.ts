// 「前の状態に戻す」導線（P2-⑧）の IPC（backup:*）。
// 実処理は electron に依存しない src/main/backup/store.ts にあり（そちらは実ファイルで単体テスト済み）、
// 純ロジック（畳み込み・ローテーション対象の算出）は src/main/backup/plan.ts にある。
// このファイルはハンドラの登録だけを行う。
import { ipcMain } from 'electron'
import type { IpcDeps } from './types'
import { snapshotBeforeWrite, listSnapshotSummaries, restoreToSnapshot } from '../backup/store'

// claude/agent.ts・claude/tools.ts は store から直接 import している（IPC を経由しない main 内呼び出し）。

export function registerBackupHandlers(_deps: IpcDeps) {
  // ファイルを上書きする直前に呼ばれる：旧内容を退避し、この作業のスナップショットマニフェストへ
  // 1エントリ追記する（同一スナップショットIDの複数ファイルは同じdirにまとまる）。
  // 戻り値: 実際にバックアップを取ったか（新規作成/変化なしなら false）。
  ipcMain.handle('backup:snapshotBeforeWrite', (_, projectDir: string, snapshotId: string, rel: string, newContent: string, label?: string) => {
    return snapshotBeforeWrite(projectDir, snapshotId, rel, newContent, label)
  })

  // 履歴一覧（新しい順）。旧形式（マニフェスト無し）は出さない。
  ipcMain.handle('backup:list', (_, projectDir: string) => listSnapshotSummaries(projectDir))

  // 指定した時点へ復元（対象以降を畳み込む＝その時点の状態にまるごと戻す）。
  ipcMain.handle('backup:restore', (_, projectDir: string, snapshotId: string) => restoreToSnapshot(projectDir, snapshotId))
}
