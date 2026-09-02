// シェル/OS連携の IPC（shell:* / app:version / proc:run）。deps は使わない（app/shell はグローバル）。
import { app, ipcMain, shell } from 'electron'
import { exec, execSync } from 'child_process'
import * as net from 'net'
import type { IpcDeps } from './types'

// ── AIのrun_commandツール用：プロジェクト内でコマンドを実行し、出力を返す ──
// 常駐プロセス向きではない（60秒でタイムアウト）。出力は上限つきで切詰める。
// B'-3d-2b: main の io（buildMainIo・src/main/chat/turnRunner.ts）が io.runCommand として
// そのまま直呼びする。中身は proc:run ハンドラの実処理をそのまま関数として切り出したもの
// （PROC_OUTPUT_MAX・timeout・maxBuffer・shell・返り値の形、すべて現行そのまま）。
const PROC_OUTPUT_MAX = 8000
export function runProjectCommand(
  cwd: string, command: string
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    exec(command, {
      cwd,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      shell: process.env.SHELL || '/bin/zsh',
      env: process.env,
    }, (err: any, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        timedOut: !!(err && err.killed),
        stdout: String(stdout ?? '').slice(0, PROC_OUTPUT_MAX),
        stderr: String(stderr ?? '').slice(0, PROC_OUTPUT_MAX),
      })
    })
  })
}

// ── ②試すの疎通確認（2026-09-01・実機の教訓）────────────────────────────
// 従来は「コマンドを実行した」＝「サーバーが起動した」とみなし、固定1.5秒後に
// 問答無用でブラウザを開いていた。依存が欠けて即クラッシュするケース（helmet 欠け等）では
// 利用者に「接続が拒否されました」だけが見えてしまう。ここでは実際にポートへ接続できるか
// 確かめてから開くための土台を提供する（WorkflowBar.tsx が 500ms 間隔でポーリングする）。
//
// 127.0.0.1 に接続でき次第 true。エラー、または 500ms 経っても繋がらなければ false。
// ソケットは必ず destroy する（開いたまま放置しない）。
export function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), 500)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export function registerShellHandlers(_deps: IpcDeps) {
  // アプリのバージョンをレンダラへ
  ipcMain.handle('app:version', () => app.getVersion())

  // ローカルファイル／URLを既定ブラウザで開く（HTMLプレビュー等）
  ipcMain.handle('shell:openPath', async (_, p: string) => {
    // ローカルファイルは file:// URL として既定ブラウザで開く
    return shell.openExternal('file://' + encodeURI(p))
  })
  // Finder（エクスプローラ）で対象を選択表示
  ipcMain.handle('shell:showInFolder', (_, p: string) => shell.showItemInFolder(p))

  // コマンドの存在確認（公開前チェック用。rsync / docker など）
  ipcMain.handle('shell:which', (_, cmd: string) => {
    if (!/^[A-Za-z0-9._-]+$/.test(cmd)) return null // 任意文字列のシェル実行は許さない
    try {
      const p = execSync(`command -v ${cmd}`, { shell: process.env.SHELL || '/bin/zsh' }).toString().trim()
      return p || null
    } catch {
      return null
    }
  })

  ipcMain.handle('proc:run', (_, args: { cwd: string; command: string }) => runProjectCommand(args.cwd, args.command))

  // ②試すの疎通確認（ポートが開通したか）。中身は isPortOpen（electron 非依存）。
  ipcMain.handle('shell:portOpen', (_, port: number) => isPortOpen(port))
}
