import { describe, it, expect } from 'vitest'
import * as net from 'net'
import { isPortOpen } from '../src/main/ipc/shell'

// isPortOpen（②試すの疎通確認・shell:portOpen ハンドラの実体）を、実際にポートを
// listen / close して駆動する（2026-09-01・実機で helmet 欠けにより node server.js が
// 即クラッシュし、固定1.5秒待ちのブラウザ起動が「接続が拒否されました」だけを見せていた件の対応）。
//
// src/main/ipc/shell.ts はトップレベルで 'electron' を import しているが、
// **import されるだけでは electron の実体には触れない**（tests/learningWiring.test.ts /
// tests/toolExecMainIo.test.ts の前例と同じ）。isPortOpen 自体は 'net' しか使わないため、
// electron 非依存のまま実駆動できる。

function listenOnFreePort(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('ポート番号が取得できなかった'))
        return
      }
      resolve({ server, port: addr.port })
    })
  })
}

describe('isPortOpen: 実際にポートを listen/close して疎通確認する', () => {
  it('listen 中のポートは true', async () => {
    const { server, port } = await listenOnFreePort()
    try {
      expect(await isPortOpen(port)).toBe(true)
    } finally {
      server.close()
    }
  })

  it('閉じたポートは false', async () => {
    const { server, port } = await listenOnFreePort()
    await new Promise<void>(resolve => server.close(() => resolve()))
    expect(await isPortOpen(port)).toBe(false)
  })
})
