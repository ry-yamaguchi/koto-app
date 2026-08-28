// 「前の状態に戻す」導線（P2-⑧）の IPC（backup:*）。
// 実処理は electron に依存しない src/main/backup/store.ts にあり（そちらは実ファイルで単体テスト済み）、
// 純ロジック（畳み込み・ローテーション対象の算出）は src/main/backup/plan.ts にある。
// このファイルはハンドラの登録だけを行う。
import { ipcMain } from 'electron'
import type { IpcDeps } from './types'
import { snapshotBeforeWrite, listSnapshotSummaries, restoreToSnapshot, restoreNoteMessage } from '../backup/store'
import { applyConversationOps } from '../chat/convStore'
import { stamp } from '../../shared/chatTime'
import type { TurnMessage } from '../../shared/chatTurn'

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
  //
  // 0.3.50・roadmap「次の改善2件」その2: 復元が成功したら、会話にもその事実を1件残す
  // （Ryosuke 指摘: 会話には「保存しました」が残ったまま実物は戻る＝AIの頭とディスクがずれる）。
  // 会話の持ち主は main（convStore.ts・B'-3c）なので、ここで直接 append し、画面へも知らせる。
  ipcMain.handle('backup:restore', (event, projectDir: string, snapshotId: string) => {
    // 対象スナップショットの label は復元の**前**に取っておく（restoreToSnapshot は最後に
    // rotate() を呼ぶため、直後に対象自身が古い順で片付けられて読めなくなることがある）。
    const label = listSnapshotSummaries(projectDir).snapshots.find(s => s.id === snapshotId)?.label ?? null
    const result = restoreToSnapshot(projectDir, snapshotId)
    if (result.ok) {
      // TurnMessage として型付けしてから stamp() へ渡す（stamp<T extends { at?: string }> は
      // `at` を持たない「弱い型」の引数を推論すると TS2559 で拒む。TurnMessage は `at?` を
      // 含むのでここを通せる。restoreNoteMessage 自体の返り値の型は仕様書どおり変えていない）。
      const note: TurnMessage = restoreNoteMessage({ label, restored: result.restored?.length ?? 0, deleted: result.deleted?.length ?? 0 })
      const msg = stamp(note)
      applyConversationOps(projectDir, [{ kind: 'append', msg }]) // convStore へ＝保存される
      event.sender.send('chat:appended', { projectDir, msg }) // 開いている画面へも知らせる
    }
    return result
  })
}
