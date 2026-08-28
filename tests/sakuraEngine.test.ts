import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import { runSakuraStream } from '../src/main/sakura/engine'

// 2026-08-28 発見の不具合: main の runSakuraStream は「⏹ 停止＝例外」を前提にしていたが、
// openai SDK 4.104.0 はストリーミング中に stream.controller.abort() を呼んでも
// **for-await が例外を投げず静かに終わる**（このファイルの1件目のテストで実証）。
// catch に入らないので aborted の付かない普通の完了が返り、「（⏹ 停止しました）」が出ない。
//
// ここでは**本物の http サーバ**（vitest は node 環境なので、外部依存なしに listen(0) できる）を
// 使い、実際の SSE ストリームに対して実物の runSakuraStream を呼ぶ。fetch や openai SDK を
// モックしない——モックすると「モックした通りに動く」ことしか確かめられず、まさに今回の
// 不具合（SDKの実際の挙動）を見逃す。

let server: Server | null = null

afterEach(() => {
  if (server) {
    server.close()
    server = null
  }
})

/** ローカルに http サーバを立てて空きポートで listen し、ポート番号を返す。 */
function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler)
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('サーバのポートを取得できませんでした'))
    })
  })
}

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

describe('runSakuraStream: ⏹ 停止しても「停止しました」が出ない不具合の修理', () => {
  it('途中で onAbortReady の中断関数を呼ぶと { aborted: true } で resolve する（修理の本丸）', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      let i = 0
      const timer = setInterval(() => {
        i++
        res.write(sseChunk({
          id: 'x', object: 'chat.completion.chunk', created: 0, model: 'test',
          choices: [{ index: 0, delta: { content: `chunk${i} ` }, finish_reason: null }],
        }))
      }, 15)
      // クライアント側の abort でソケットが閉じたら、送り続けているタイマーを止める
      _req.on('close', () => clearInterval(timer))
      res.on('close', () => clearInterval(timer))
    })

    let abortFn: (() => void) | null = null
    const deltas: string[] = []
    const result = await runSakuraStream(
      {
        apiKey: 'test-key',
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        baseURL: `http://127.0.0.1:${port}/v1`,
      },
      {
        onDelta: d => {
          deltas.push(d)
          // 2つ目のデルタを受け取った時点（＝ストリーミングの途中）で止める
          if (deltas.length === 2 && abortFn) abortFn()
        },
        onReasoning: () => {},
        onAbortReady: fn => { abortFn = fn },
      },
    )

    expect(result).toEqual({ usage: null, aborted: true })
  })

  it('最後まで流すと aborted は付かず、toolCalls / usage が返る', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const send = (obj: unknown) => res.write(sseChunk(obj))
      send({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'test',
        choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }] })
      send({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'test',
        choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] })
      send({
        id: 'x', object: 'chat.completion.chunk', created: 0, model: 'test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })

    const deltas: string[] = []
    let abortReadyCalled = false
    const result = await runSakuraStream(
      {
        apiKey: 'test-key',
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        baseURL: `http://127.0.0.1:${port}/v1`,
      },
      {
        onDelta: d => deltas.push(d),
        onReasoning: () => {},
        onAbortReady: () => { abortReadyCalled = true }, // 中断関数を受け取るだけで、呼ばない
      },
    )

    expect(abortReadyCalled).toBe(true)
    expect(result.aborted).toBeUndefined()
    expect(deltas.join('')).toBe('hello world')
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
    expect(result.toolCalls).toBeNull()
  })
})
