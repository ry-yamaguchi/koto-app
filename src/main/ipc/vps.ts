// さくらのVPS 公開機能 V1a（①接続の2ルート）の IPC（vps:*）。
// 方式B（掟4）: 秘密鍵・パスワードはすべて renderer から引数で受け取る。main には一切保存しない。
// AIチャットのツール（aiTools.ts）にはここのハンドラを一切公開しない（docs/vps-plan.md §2.5）。
import { ipcMain } from 'electron'
import { isValidHost, isValidPort, isValidUsername, isValidPublicKey } from '../vps/validate'
import { buildStartupScript, buildInstallKeyCommands, buildHardenSshdCommands } from '../vps/scripts'
import { generateKeypair, scanHostKey, runSsh, runSshWithPassword } from '../vps/ssh'
import type { IpcDeps } from './types'

// 「構成は選ばせない」（docs/vps-plan.md §0 原則1）: 2ユーザーの名前は固定する。
// renderer からは受け取らない（scripts.ts 側は引数で受けるテスト可能な設計のまま）。
const ADMIN_USER = 'sakura-admin'
const DEPLOY_USER = 'deploy'

export function registerVpsHandlers(_deps: IpcDeps) {
  ipcMain.handle('vps:generateKeypair', async () => {
    try {
      const keys = await generateKeypair()
      return { ok: true, publicKey: keys.publicKey, privateKey: keys.privateKey }
    } catch (e: any) { return { ok: false, message: e?.message ?? String(e) } }
  })

  ipcMain.handle('vps:buildStartupScript', async (_, publicKey: string) => {
    try {
      const script = buildStartupScript({ publicKey, adminUser: ADMIN_USER, deployUser: DEPLOY_USER })
      return { ok: true, script }
    } catch (e: any) { return { ok: false, message: e?.message ?? String(e) } }
  })

  ipcMain.handle('vps:scanHostKey', async (_, host: string, port: number) => {
    if (!isValidHost(host)) return { ok: false, message: 'ホスト名/IPの形式が不正です' }
    if (!isValidPort(port)) return { ok: false, message: 'ポート番号が不正です（1〜65535）' }
    return scanHostKey(host, port)
  })

  ipcMain.handle('vps:testConnection', async (_, host: string, port: number, user: string, privateKey: string, fingerprint: string) => {
    if (!isValidHost(host)) return { ok: false, message: 'ホスト名/IPの形式が不正です' }
    if (!isValidPort(port)) return { ok: false, message: 'ポート番号が不正です（1〜65535）' }
    if (!isValidUsername(user)) return { ok: false, message: 'ユーザー名の形式が不正です' }
    if (!privateKey) return { ok: false, message: '秘密鍵がありません（先に「① 鍵を生成」してください）' }
    if (!fingerprint) return { ok: false, message: 'ホスト鍵の指紋が未確認です（先にホスト鍵を確認してください）' }
    const r = await runSsh({ host, port, user, privateKey, knownHostFingerprint: fingerprint, command: 'echo koto-vps-ok' })
    if (!r.ok) return r
    const okEcho = (r.stdout ?? '').includes('koto-vps-ok')
    return okEcho ? { ok: true } : { ok: false, stdout: r.stdout, message: '接続はできましたが、想定外の応答でした。' }
  })

  ipcMain.handle('vps:installKeyWithPassword', async (_, host: string, port: number, user: string, password: string, publicKey: string) => {
    if (!isValidHost(host)) return { ok: false, message: 'ホスト名/IPの形式が不正です' }
    if (!isValidPort(port)) return { ok: false, message: 'ポート番号が不正です（1〜65535）' }
    if (!isValidUsername(user)) return { ok: false, message: '接続ユーザー名の形式が不正です' }
    if (!password) return { ok: false, message: 'パスワードが未入力です' }
    if (!isValidPublicKey(publicKey)) return { ok: false, message: '公開鍵の形式が不正です（先に「① 鍵を生成」してください）' }
    let commands: string[]
    try {
      commands = buildInstallKeyCommands({ publicKey, adminUser: ADMIN_USER, deployUser: DEPLOY_USER })
    } catch (e: any) { return { ok: false, message: e?.message ?? String(e) } }
    return runSshWithPassword({ host, port, user, password, commands })
  })

  // 鍵認証の疎通確認（vps:testConnection）が取れた後にだけ呼ぶ想定（呼び出し側=VpsPanel の責務）。
  ipcMain.handle('vps:hardenSshd', async (_, host: string, port: number, user: string, privateKey: string, fingerprint: string) => {
    if (!isValidHost(host)) return { ok: false, message: 'ホスト名/IPの形式が不正です' }
    if (!isValidPort(port)) return { ok: false, message: 'ポート番号が不正です（1〜65535）' }
    if (!isValidUsername(user)) return { ok: false, message: 'ユーザー名の形式が不正です' }
    if (!privateKey) return { ok: false, message: '秘密鍵がありません' }
    if (!fingerprint) return { ok: false, message: 'ホスト鍵の指紋が未確認です' }
    const commands = buildHardenSshdCommands()
    return runSsh({ host, port, user, privateKey, knownHostFingerprint: fingerprint, command: commands.join('\n') })
  })
}
