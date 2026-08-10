// 機密情報の暗号化/復号（OSのキーチェーンを利用）の IPC（secure:*）。deps は使わない。
import { ipcMain, safeStorage } from 'electron'
import type { IpcDeps } from './types'

export function registerSecureHandlers(_deps: IpcDeps) {
  ipcMain.handle('secure:available', () => safeStorage.isEncryptionAvailable())
  ipcMain.handle('secure:encrypt', (_, plain: string) => {
    if (!plain || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.encryptString(plain).toString('base64')
  })
  ipcMain.handle('secure:decrypt', (_, b64: string) => {
    try {
      if (!b64 || !safeStorage.isEncryptionAvailable()) return ''
      return safeStorage.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      return ''
    }
  })
}
