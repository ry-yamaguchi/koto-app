// 自動更新の IPC（update:*）。実体は src/main/updater.ts。
//
// **判定はここに書かない。** 「いま再起動してよいか」は shared/updatePolicy.ts の
// canApplyNow に集約してある。2箇所に置くと片方だけ直され、「作業中に再起動する」
// という最悪の事故に戻る（掟10）。

import { ipcMain } from 'electron'
import type { IpcDeps } from './types'
import { checkForUpdatesNow, currentUpdateState, quitAndInstallNow } from '../updater'
import { revealUpdateLog } from '../updateLog'
import { canApplyNow } from '../../shared/updatePolicy'

export function registerUpdateHandlers(deps: IpcDeps) {
  /** いまの状態を返す（画面を開いた直後に一度聞く）。 */
  ipcMain.handle('update:state', () => currentUpdateState())

  /** 手動で確認する（設定画面・メニューから）。 */
  ipcMain.handle('update:check', async () => await checkForUpdatesNow())

  /**
   * いますぐ再起動して適用する。
   * **作業中なら断る。** 断った理由は renderer が利用者へそのまま見せる。
   */
  ipcMain.handle('update:apply', () => {
    const decision = canApplyNow({
      state: currentUpdateState(),
      isBusy: deps.isBusy(),
      busyLabel: deps.busyLabel(),
      hasUnsavedChanges: deps.hasUnsavedChanges(),
    })
    if (!decision.ok) return decision
    // 実行は updater 側。ここで再起動するとウィンドウの後始末が飛ぶ
    quitAndInstallNow()
    return { ok: true as const }
  })

  /**
   * 更新ログを Finder で表示する。
   * **非エンジニアに「~/Library/Logs を開いて」は通じない**ので、押すだけで
   * 場所が出るようにする。ここが「更新されない」を追える唯一の入口になる。
   */
  ipcMain.handle('update:openLog', async () => await revealUpdateLog())
}
