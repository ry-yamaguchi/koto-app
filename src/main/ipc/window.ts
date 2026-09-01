// ウィンドウ関連の IPC（win:*）。deps: setHasUnsavedChanges・requestQuitAfterSave を受ける。
import { ipcMain } from 'electron'
import type { IpcDeps } from './types'

export function registerWindowHandlers(deps: IpcDeps) {
  // レンダラからの未保存状態の通知
  ipcMain.on('win:dirty', (_, dirty: boolean) => { deps.setHasUnsavedChanges(dirty) })

  // レンダラからの実行中状態の通知。busy/label は「何かしら実行中か」（自動更新の再起動ゲート）、
  // closeBlockingBusy/closeBlockingLabel は「閉じると本当に中断されるか」（終了時の
  // 「実行中です」警告。B'-3d-3: AI応答は main でターンが完走するため対象外になった）。
  ipcMain.on('win:busy', (_, busy: boolean, label: string, closeBlockingBusy: boolean, closeBlockingLabel: string) => {
    deps.setBusy(busy, label, closeBlockingBusy, closeBlockingLabel)
  })

  // レンダラが全保存を終えたら呼ぶ → 実際に終了
  ipcMain.handle('win:quit-after-save', () => {
    deps.requestQuitAfterSave()
  })
}
