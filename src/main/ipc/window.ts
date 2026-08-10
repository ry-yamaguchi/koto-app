// ウィンドウ関連の IPC（win:*）。deps: setHasUnsavedChanges・requestQuitAfterSave を受ける。
import { ipcMain } from 'electron'
import type { IpcDeps } from './types'

export function registerWindowHandlers(deps: IpcDeps) {
  // レンダラからの未保存状態の通知
  ipcMain.on('win:dirty', (_, dirty: boolean) => { deps.setHasUnsavedChanges(dirty) })

  // レンダラからの実行中状態の通知（終了時の「実行中です」警告に使う）
  ipcMain.on('win:busy', (_, busy: boolean, label: string) => { deps.setBusy(busy, label) })

  // レンダラが全保存を終えたら呼ぶ → 実際に終了
  ipcMain.handle('win:quit-after-save', () => {
    deps.requestQuitAfterSave()
  })
}
