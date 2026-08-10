// さくらのレンタルサーバ：SSH/SCP によるリモート操作の IPC（remote:*）。deps は使わない。
// セキュリティ最重要: すべて execFile（配列引数）で実行し、シェル文字列連結はしない。
// host/account/リモートパスは下記ヘルパーで厳格に検証してから引数へ渡す。
import { ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execFile } from 'child_process'
import type { IpcDeps } from './types'

// 共通SSHオプション。BatchMode=yes でパスワード要求時は即失敗（鍵認証前提）。
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new']
const SSH_TIMEOUT = 20000 // execFile 側のタイムアウト（ssh の ConnectTimeout と併用）

/** ホスト名の検証。英数字・ドット・ハイフンのみ許可。不正は例外。 */
function validateHost(host: string): string {
  if (typeof host !== 'string' || !/^[A-Za-z0-9.\-]+$/.test(host)) {
    throw new Error('ホスト名が不正です（英数字・ドット・ハイフンのみ）')
  }
  return host
}

/** アカウント名の検証。英数字・ドット・アンダースコア・ハイフンのみ許可。不正は例外。 */
function validateAccount(acc: string): string {
  if (typeof acc !== 'string' || !/^[A-Za-z0-9._\-]+$/.test(acc)) {
    throw new Error('アカウント名が不正です（英数字・ドット・アンダースコア・ハイフンのみ）')
  }
  return acc
}

/**
 * リモートパスの検証。次を「すべて」満たすときのみ許可、外れたら例外。
 * - 文字種は英数字・ドット・アンダースコア・ハイフン・スラッシュ・チルダのみ
 *   （空白やシェルメタ文字 ; | & $ ( ) < > * ? ! " ' \ 改行 を一切含まない）
 * - `..` を含まない
 * - /home/<account>/ 配下、または ~/、または www/ ・先頭スラッシュ無しの相対（ホーム基準）に限定。
 *   絶対パスの場合は必ず /home/<account>/ で始まること（/etc 等ホーム外は拒否）。
 */
function validateRemotePath(p: string, account: string): string {
  validateAccount(account)
  if (typeof p !== 'string' || p.length === 0) throw new Error('リモートパスが空です')
  if (!/^[A-Za-z0-9._\-\/~]+$/.test(p)) {
    throw new Error('リモートパスに使えない文字が含まれています')
  }
  if (p.includes('..')) throw new Error('リモートパスに「..」は使えません')
  // チルダは「~」単体か「~/」始まり（自分のホーム基準）のみ許可。
  // 「~root/...」のような他ユーザ展開や、語中の「~」を含むパスは拒否。
  if (p.includes('~') && p !== '~' && !p.startsWith('~/')) {
    throw new Error('リモートパスのチルダ（~）の使い方が不正です')
  }
  // チルダ始まり（ホーム基準）はOK
  if (p === '~' || p.startsWith('~/')) return p
  if (p.startsWith('/')) {
    // 絶対パスは /home/<account>/ 配下のみ許可
    const homePrefix = `/home/${account}/`
    if (p !== `/home/${account}` && !p.startsWith(homePrefix)) {
      throw new Error('リモートパスはホームディレクトリの外を指定できません')
    }
    return p
  }
  // 先頭スラッシュ無しの相対パス（www/ 等）はホーム基準としてOK
  return p
}

const REMOTE_OUTPUT_MAX = 8000

/** execFile を Promise でラップ（タイムアウト・出力上限つき） */
function runExecFile(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: SSH_TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout ?? '').slice(0, REMOTE_OUTPUT_MAX),
        stderr: String(stderr ?? '').slice(0, REMOTE_OUTPUT_MAX),
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      })
    })
  })
}

/** ssh/scp の stderr を初心者向けの日本語メッセージに要約する。 */
function friendlySshError(stderr: string): string {
  const s = (stderr || '').toLowerCase()
  if (s.includes('permission denied') || s.includes('publickey') || s.includes('password')) {
    return 'SSHで接続できませんでした。公開の「初めての準備」ガイドに従ってSSHを有効化し、鍵認証（SSH鍵）を設定してください。'
  }
  if (s.includes('host key verification') || s.includes('remote host identification')) {
    return 'サーバの鍵情報の確認でエラーになりました。known_hosts の設定を確認してください。'
  }
  if (s.includes('could not resolve') || s.includes('name or service not known') || s.includes('nodename nor servname')) {
    return 'ホスト名を解決できませんでした。ホスト名（例: example.sakura.ne.jp）を確認してください。'
  }
  if (s.includes('connection timed out') || s.includes('operation timed out') || s.includes('connection refused')) {
    return 'サーバに接続できませんでした（タイムアウト/接続拒否）。ネットワークやSSHの有効化を確認してください。'
  }
  if (s.includes('no such file') || s.includes('not found')) {
    return '指定したファイルまたはフォルダが見つかりませんでした。'
  }
  return (stderr || '').trim().slice(0, 300) || '操作に失敗しました。'
}

export function registerRemoteHandlers(_deps: IpcDeps) {
  // 1. 接続テスト: ssh <opts> <target> echo sakura-ide-ok
  ipcMain.handle('remote:test', async (_, args: { host: string; account: string }) => {
    try {
      const host = validateHost(args.host)
      const account = validateAccount(args.account)
      const target = `${account}@${host}`
      const r = await runExecFile('ssh', [...SSH_OPTS, target, 'echo', 'sakura-ide-ok'])
      if (r.ok && r.stdout.includes('sakura-ide-ok')) return { ok: true }
      return { ok: false, message: friendlySshError(r.stderr) }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 2. リモート一覧: ssh <opts> <target> ls -1Ap -- <path>
  ipcMain.handle('remote:list', async (_, args: { host: string; account: string; path?: string }) => {
    try {
      const host = validateHost(args.host)
      const account = validateAccount(args.account)
      const rawPath = args.path && args.path.length ? args.path : `/home/${account}/www`
      const remotePath = validateRemotePath(rawPath, account)
      const r = await runExecFile('ssh', [...SSH_OPTS, `${account}@${host}`, 'ls', '-1Ap', '--', remotePath])
      if (!r.ok) return { ok: false, message: friendlySshError(r.stderr) }
      const entries = r.stdout
        .split('\n')
        .map(s => s.replace(/\r$/, ''))
        .filter(s => s.length > 0)
        .map(name => {
          const isDir = name.endsWith('/')
          return { name: isDir ? name.slice(0, -1) : name, isDir }
        })
      return { ok: true, path: remotePath, entries }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 3. ダウンロード: scp <opts> <target>:<remotePath> <localPath>
  // localPath は呼び出し側（renderer）がプロジェクト内に解決した絶対パスを渡す（confineToProject相当）。
  ipcMain.handle('remote:download', async (_, args: { host: string; account: string; remotePath: string; localPath: string }) => {
    try {
      const host = validateHost(args.host)
      const account = validateAccount(args.account)
      const remotePath = validateRemotePath(args.remotePath, account)
      const localPath = args.localPath
      if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) {
        throw new Error('保存先パスが不正です')
      }
      fs.mkdirSync(path.dirname(localPath), { recursive: true }) // 親ディレクトリを作成
      const r = await runExecFile('scp', [...SSH_OPTS, `${account}@${host}:${remotePath}`, localPath])
      if (!r.ok) return { ok: false, message: friendlySshError(r.stderr) }
      return { ok: true, localPath }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 4. アップロード（上書き前に自動バックアップ）:
  //    まず ssh <opts> <target> cp -f -- <remotePath> <remotePath>.bak-<stamp>（対象が無ければ失敗→バックアップ無しで続行）
  //    その後 scp <opts> <localPath> <target>:<remotePath>
  ipcMain.handle('remote:upload', async (_, args: { host: string; account: string; remotePath: string; localPath: string }) => {
    try {
      const host = validateHost(args.host)
      const account = validateAccount(args.account)
      const remotePath = validateRemotePath(args.remotePath, account)
      const localPath = args.localPath
      if (typeof localPath !== 'string' || !path.isAbsolute(localPath) || !fs.existsSync(localPath)) {
        throw new Error('アップロード元ファイルが見つかりません')
      }
      const target = `${account}@${host}`
      // 上書き前バックアップ（配列引数で cp を実行。対象が無ければ失敗→無視）
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = validateRemotePath(`${remotePath}.bak-${stamp}`, account)
      const bak = await runExecFile('ssh', [...SSH_OPTS, target, 'cp', '-f', '--', remotePath, backupPath])
      const backedUp = bak.ok
      // 本体をアップロード
      const r = await runExecFile('scp', [...SSH_OPTS, localPath, `${target}:${remotePath}`])
      if (!r.ok) return { ok: false, backedUp, message: friendlySshError(r.stderr) }
      return { ok: true, backedUp, backupPath: backedUp ? backupPath : null }
    } catch (e: any) {
      return { ok: false, backedUp: false, message: e?.message ?? String(e) }
    }
  })
}
