// windowSend.ts — レンダラへの送信を、閉じられたウィンドウでも落ちないようにする。
//
// ── なぜ要るか（2026-08-09 実機で発生）──────────────────────────────────
// ターミナルを開いたままウィンドウを閉じたところ、アプリ全体がこのダイアログで落ちた:
//
//   A JavaScript error occurred in the main process
//   TypeError: Object has been destroyed  （src/main/ipc/term.ts の onData）
//
// 原因は2つ重なっている。
//
//   1. `mainWindow` を閉じても null にしていなかった（'closed' で null 化していなかった）
//   2. 送信側が `mainWindow?.webContents.send(...)` と書いていた
//
// **`?.` は null しか防げない。** 破棄済みの BrowserWindow は null ではないので `?.` を
// すり抜け、`.webContents` に触れた瞬間に例外になる。しかも main プロセスの未捕捉例外なので、
// 画面が閉じているだけの状態からアプリごと落ちる。
//
// macOS ではウィンドウを閉じてもアプリは常駐する（window-all-closed で終了しない設計）。
// つまり **✗ で閉じたあとにターミナルが出力する／メニューを押す**だけで踏める。
//
// 送信は5箇所あり、それぞれで書き方を守らせるのは無理がある（片方だけ直されて残る）。
// ここに集約する。

import type { BrowserWindow } from 'electron'

/**
 * そのウィンドウへ送ってよいか（純関数）。electron に依存しないので単体テストできる。
 *
 * null・破棄済みウィンドウ・破棄済み webContents のいずれでも false。
 * **破棄済みかどうかは isDestroyed() でしか分からない**（null チェックでは足りない）。
 */
export function canSendTo(
  win: { isDestroyed(): boolean; webContents?: { isDestroyed(): boolean } | null } | null | undefined,
): boolean {
  if (!win) return false
  try {
    if (win.isDestroyed()) return false
    const wc = win.webContents
    if (!wc) return false
    return !wc.isDestroyed()
  } catch {
    // isDestroyed() 自体が投げる状態（解放済み等）も「送れない」に倒す
    return false
  }
}

/**
 * レンダラへ送る。ウィンドウが閉じられていれば**黙って捨てる**。
 *
 * 捨ててよい理由: ここを通るのはターミナルの出力・メニューの指示など、
 * 受け手の画面が無ければ意味を持たないものだけである。届かないことより、
 * 届けようとして落ちることの方が害が大きい。
 */
export function sendToWindow(win: BrowserWindow | null | undefined, channel: string, ...args: unknown[]): void {
  if (!canSendTo(win as never)) return
  win!.webContents.send(channel, ...args)
}
