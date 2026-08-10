// シェル/OS連携の IPC（shell:* / app:version / proc:run）。deps は使わない（app/shell はグローバル）。
import { app, ipcMain, shell } from 'electron'
import { exec, execSync } from 'child_process'
import type { IpcDeps } from './types'

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

  // ── AIのrun_commandツール用：プロジェクト内でコマンドを実行し、出力を返す ──
  // 常駐プロセス向きではない（60秒でタイムアウト）。出力は上限つきで切詰める。
  const PROC_OUTPUT_MAX = 8000
  ipcMain.handle('proc:run', (_, args: { cwd: string; command: string }) => {
    return new Promise(resolve => {
      exec(args.command, {
        cwd: args.cwd,
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
  })
}
