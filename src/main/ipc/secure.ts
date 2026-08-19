// 機密情報の暗号化/復号（OSのキーチェーンを利用）の IPC（secure:*）。deps は使わない。
//
// ── 「読めなかった」を「無かった」と混ぜない（2026-08-19 実機）──────────
// 復号に失敗したとき '' を返していた。**未登録と区別が付かない**ので、画面は
// 「未登録」と表示し、利用者はそこへ入力し直す。すると**元の設定が上書きされて消える**。
//
// これが起きる形が実際にあった: 署名の違うビルド（署名版と、手元の未署名ビルド）は
// **キーチェーンの鍵が別**になる（実測: `Koto Safe Storage` の項目が2つできていた）。
// 一方で保存したものは、もう一方からは読めない。
import { ipcMain, safeStorage } from 'electron'
import type { IpcDeps } from './types'

export function registerSecureHandlers(_deps: IpcDeps) {
  ipcMain.handle('secure:available', () => safeStorage.isEncryptionAvailable())
  ipcMain.handle('secure:encrypt', (_, plain: string) => {
    if (!plain || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.encryptString(plain).toString('base64')
  })
  /**
   * 復号する。
   *
   * - 中身が無い（`b64` が空）… `''`
   * - **復号できなかった** … `null`（**呼び出し側は「未登録」と混ぜてはいけない**）
   */
  ipcMain.handle('secure:decrypt', (_, b64: string) => {
    if (!b64) return ''
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      return null
    }
  })
}
