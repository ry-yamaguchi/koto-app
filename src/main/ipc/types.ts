// IPC 分割の共有型。main.ts が持つ状態（mainWindow・hasUnsavedChanges 等）を
// 各 registerXxxHandlers(deps) へ注入するための deps 型をここに1箇所で定義する。
// 循環 import を避けるため、ipc/ 配下からは main.ts を import しない。

import type { BrowserWindow } from 'electron'

export interface IpcDeps {
  /** 現在のメインウィンドウ（起動直後や再生成のタイミングでは null になり得る）。 */
  getMainWindow: () => BrowserWindow | null
  /** レンダラからの未保存通知（win:dirty）を反映する。 */
  setHasUnsavedChanges: (dirty: boolean) => void
  /** 保存済みで終了してよい状態にし、ウィンドウを閉じる（win:quit-after-save）。 */
  requestQuitAfterSave: () => void
  /** レンダラからの実行中通知（win:busy）を反映する。label は実行中の処理名（終了確認ダイアログに表示）。 */
  setBusy: (busy: boolean, label: string) => void
}
