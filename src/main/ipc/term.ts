// ターミナルの IPC（term:*）。node-pty の Map（terminals）はモジュール内に保持する。
// deps: getMainWindow（pty の data/exit をメインウィンドウへ送るために使用）。
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as pty from 'node-pty'
import type { IpcDeps } from './types'

export function registerTermHandlers(deps: IpcDeps) {
  // Terminal IPC
  const terminals = new Map<number, pty.IPty>()
  let termId = 0

  ipcMain.handle('term:create', (_, cwd?: string) => {
    const id = ++termId
    const shell = process.env.SHELL || '/bin/zsh'
    // プロジェクトフォルダが指定されていればそこで起動（無ければホーム）
    const startDir = cwd && fs.existsSync(cwd) ? cwd : process.env.HOME
    // ログインシェルとして起動する（-l）。Homebrew の PATH 設定（eval "$(brew shellenv)"）は
    // ~/.zprofile に書かれるのが標準で、これはログインシェルでしか読まれない。-l が無いと
    // 「node/npm を入れているのにターミナルから見つからない」が起きる（2026-07-30 ユーザー報告）。
    // main の PATH 自体も起動時に補正済み（src/main/loginPath.ts）。両方あるとより確実。
    const term = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: startDir,
      env: process.env as Record<string, string>
    })
    terminals.set(id, term)
    term.onData(data => {
      deps.getMainWindow()?.webContents.send(`term:data:${id}`, data)
    })
    term.onExit(() => {
      terminals.delete(id)
      deps.getMainWindow()?.webContents.send(`term:exit:${id}`)
    })
    return id
  })

  ipcMain.handle('term:write', (_, id: number, data: string) => {
    terminals.get(id)?.write(data)
  })

  ipcMain.handle('term:resize', (_, id: number, cols: number, rows: number) => {
    terminals.get(id)?.resize(cols, rows)
  })

  ipcMain.handle('term:destroy', (_, id: number) => {
    terminals.get(id)?.kill()
    terminals.delete(id)
  })
}
