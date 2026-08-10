import { describe, it, expect } from 'vitest'
import { canSendTo } from '../src/main/windowSend'

// 2026-08-09 実機で発生した落ち方の回帰テスト。
// ターミナルを開いたままウィンドウを閉じると、アプリ全体がこのダイアログで落ちた:
//
//   A JavaScript error occurred in the main process
//   TypeError: Object has been destroyed  （src/main/ipc/term.ts の onData）
//
// 原因は `mainWindow?.webContents.send(...)` という書き方。
// **`?.` は null しか防げない。** 破棄済みの BrowserWindow は null ではないので `?.` を
// すり抜け、`.webContents` に触れた瞬間に例外になる。main プロセスの未捕捉例外なので、
// 画面が閉じているだけの状態からアプリごと落ちる。
//
// macOS ではウィンドウを閉じてもアプリが常駐するため、✗ で閉じたあとに
// ターミナルが出力する／メニューを押すだけで踏める。

const alive = () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false } })

describe('レンダラへ送ってよいかの判定', () => {
  it('生きているウィンドウには送る', () => {
    expect(canSendTo(alive())).toBe(true)
  })

  it('null には送らない', () => {
    expect(canSendTo(null)).toBe(false)
    expect(canSendTo(undefined)).toBe(false)
  })

  // ここが実害。null チェックだけでは足りない
  it('破棄済みのウィンドウには送らない（null ではないので ?. をすり抜ける）', () => {
    expect(canSendTo({ isDestroyed: () => true, webContents: { isDestroyed: () => false } })).toBe(false)
  })

  it('webContents が破棄済みなら送らない', () => {
    expect(canSendTo({ isDestroyed: () => false, webContents: { isDestroyed: () => true } })).toBe(false)
  })

  it('webContents が無い場合も送らない', () => {
    expect(canSendTo({ isDestroyed: () => false, webContents: null })).toBe(false)
    expect(canSendTo({ isDestroyed: () => false } as never)).toBe(false)
  })

  // 解放済みオブジェクトは isDestroyed() 自体が投げることがある。
  // ここで例外を漏らすと、落ちないための関数が落とす側になる
  it('isDestroyed() が例外を投げても送らない（例外を漏らさない）', () => {
    expect(canSendTo({ isDestroyed: () => { throw new Error('released') } } as never)).toBe(false)
    expect(canSendTo({
      isDestroyed: () => false,
      get webContents(): never { throw new Error('released') },
    } as never)).toBe(false)
  })
})
