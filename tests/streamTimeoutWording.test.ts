import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import http from 'node:http'
import type { Server } from 'node:http'

import { runSakuraStream } from '../src/main/sakura/engine'
import {
  STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, STREAM_MAX_RETRIES,
  streamTimeoutMessage,
} from '../src/shared/chatTimeouts'

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-25 検分の指摘21/27/28/29: 実機の症状「ヘッダだけ返して黙る」では、利用者は
// STREAM_IDLE_TIMEOUT_MS（90秒）しか待っていないのに、吹き出しには
// 「120秒×2回（合計およそ240秒）試しても始まらなかった」と出ていた。
// 直前まで画面が数えていた経過秒（90秒）と食い違い、利用者は自分が見ていた数字を疑うことになる。
//
// ── このテストの流儀 ───────────────────────────────────────────────
// 文言そのものを書き写して比べない（それでは文言を変えた瞬間に一緒に書き換えられる）。
// **実機と同じ症状の偽サーバに実際に流し**、そのとき返ってきた印から作られる文が
// 「実際に待った上限」だけを示しているか（待っていない時間を語っていないか）を見る。
//
// ── 指摘29: 「定数から作られている」の見方を直した ────────────────────────
// 前の版は「文に出てきた数字が、いまの定数の値と一致するか」しか見ていなかったので、
// `'…90秒までです'` と**手で書いても素通り**した（定数を90→60に変えた日に、文言だけ
// 90秒のまま取り残される＝このテストが防ぎたかった当の事故が防げない）。
// いまは原本（src/shared/chatTimeouts.ts）の streamTimeoutMessage の中身を読み、
// **返す文に手書きの秒数が1つも無いこと**と、**sec(定数) の式で作られていること**を
// 併せて固定する（tests/compactStop.test.ts が useAiChat の形を原本で固定するのと同じ手）。
// ─────────────────────────────────────────────────────────────────────────────

let server: Server | null = null

afterEach(() => {
  if (server) { server.closeAllConnections(); server.close(); server = null }
})

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

const sec = (ms: number) => Math.round(ms / 1000)

/** 文中に出てくる「N秒」の N を、出てきた順に取り出す。 */
const secsIn = (msg: string) => [...msg.matchAll(/(\d+)秒/g)].map(m => Number(m[1]))

describe('無音で打ち切ったときの文言が、実際に待った時間と食い違わない', () => {
  it('★ ヘッダだけ返して黙る相手（実機の症状）は、無音の上限だけを語る（120秒・240秒を出さない）', async () => {
    // SDK の時計は**応答ヘッダが返った時点で解除される**ので、この症状では
    // STREAM_FIRST_CHUNK_TIMEOUT_MS は一度も発火しない（engine.ts・streamIdle.ts のコメント）。
    // つまり利用者が実際に待つのは STREAM_IDLE_TIMEOUT_MS ぶんだけ。
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.flushHeaders() // ヘッダだけを実際に送り出す。チャンクは1件も書かない
    })
    const deltas: string[] = []
    const r = await runSakuraStream(
      {
        apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }],
        baseURL: `http://127.0.0.1:${port}/v1`,
        timeoutMs: 5_000, // ヘッダは即座に返るので、この時計は発火しない（発火したら試験が無意味）
        idleMs: 250,      // 本番は STREAM_IDLE_TIMEOUT_MS（実時間で90秒待たないための差し込み口）
      },
      { onDelta: d => deltas.push(d), onReasoning: () => {}, onAbortReady: () => {} },
    )
    expect(deltas).toEqual([])      // 本当に1件も届いていない（この前提が崩れたら試験が無意味）
    expect(r.aborted).toBeUndefined() // ⏹ ではない
    // どちらの時計で切れたのかを取り違えない（SDK の時計＝'first' ではない）
    expect(r.timedOut).toBe('first-silent')

    const msg = streamTimeoutMessage(r.timedOut!)
    // ★ 実際に待った上限（無音の90秒）だけが出ていて、待っていない時間は出てこない
    expect(secsIn(msg)).toEqual([sec(STREAM_IDLE_TIMEOUT_MS)])
    expect(msg).not.toContain(`${sec(STREAM_FIRST_CHUNK_TIMEOUT_MS)}秒`)
    expect(msg).not.toContain(`${sec(STREAM_FIRST_CHUNK_TIMEOUT_MS * (STREAM_MAX_RETRIES + 1))}秒`)
    // 1件も届いていないので「途中までの内容はそのまま残しています」とは言わない
    expect(msg).not.toContain('途中までの内容はそのまま残しています')
    // 画面に現れない出来事（応答ヘッダだけ到着＝「返事を始めかけた」）の言葉で説明しない（指摘27）
    expect(msg).not.toContain('始めかけた')
    // 画面に出ていないもの（経過秒）を「出ていた」と断定しない（指摘28）
    expect(msg).not.toContain('画面に出ていた')
    // ⏹ で止めたときの言葉と混ぜない
    expect(msg).not.toContain('停止しました')
    expect(msg).not.toContain('⏹')
  }, 20_000)

  it('対照: 応答ヘッダすら返らない相手（SDK の時計）のときだけ、120秒×2回を語る', async () => {
    const port = await listen(() => { /* 何も返さない＝ヘッダも送らない */ })
    const r = await runSakuraStream(
      {
        apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }],
        baseURL: `http://127.0.0.1:${port}/v1`,
        timeoutMs: 200, // 本番は STREAM_FIRST_CHUNK_TIMEOUT_MS
      },
      { onDelta: () => {}, onReasoning: () => {}, onAbortReady: () => {} },
    )
    expect(r.timedOut).toBe('first')
    const msg = streamTimeoutMessage(r.timedOut!)
    expect(secsIn(msg)).toEqual([
      sec(STREAM_FIRST_CHUNK_TIMEOUT_MS),
      sec(STREAM_FIRST_CHUNK_TIMEOUT_MS * (STREAM_MAX_RETRIES + 1)),
    ])
    expect(msg).toContain(`${STREAM_MAX_RETRIES + 1}回`)
    // こちらでは無音の上限（90秒）は関係しないので出さない
    expect(msg).not.toContain(`${sec(STREAM_IDLE_TIMEOUT_MS)}秒`)
  }, 20_000)

  it('対照: 途中まで届いてから黙ったときは、残っているものがあると伝える（無音の上限は同じ90秒）', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify({
        id: 'x', object: 'chat.completion.chunk', created: 0, model: 'test',
        choices: [{ index: 0, delta: { content: 'こんにち' }, finish_reason: null }],
      })}\n\n`)
      // 以降、何も書かない
    })
    const r = await runSakuraStream(
      {
        apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }],
        baseURL: `http://127.0.0.1:${port}/v1`, timeoutMs: 5_000, idleMs: 250,
      },
      { onDelta: () => {}, onReasoning: () => {}, onAbortReady: () => {} },
    )
    expect(r.timedOut).toBe('idle')
    const msg = streamTimeoutMessage(r.timedOut!)
    expect(secsIn(msg)).toEqual([sec(STREAM_IDLE_TIMEOUT_MS)])
    expect(msg).toContain('途中までの内容はそのまま残しています')
  }, 20_000)

  // ── 3つの症状で、同じ文を使い回していないこと ────────────────────────────
  // 「つながらない」「つながったが無音」「途中で止まった」は待った時間も残るものも違う。
  it('★ 3つの時間切れは、それぞれ別の文（取り違えたら気づけるようにする）', () => {
    const msgs = (['first', 'first-silent', 'idle'] as const).map(k => streamTimeoutMessage(k))
    expect(new Set(msgs).size).toBe(3)
    for (const m of msgs) {
      expect(m.length).toBeGreaterThan(10) // 黙って終わらせない（何か言う）
      expect(m).not.toContain('停止しました')
      expect(m).not.toContain('⏹')
      expect(m).not.toContain('**') // 掟5: 画面の文に Markdown 記法を出さない
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 指摘29: 「秒数はすべて定数から作られている」を、**手で書いた数字が通らない形**で固定する。
// ─────────────────────────────────────────────────────────────────────────────
describe('秒数の作り方（原本で固定する）', () => {
  const SRC_REL = 'src/shared/chatTimeouts.ts'
  const src = fs.readFileSync(path.join(__dirname, '..', SRC_REL), 'utf8')

  /** streamTimeoutMessage の中身だけを取り出し、説明（// のコメント行）を落とす。
   *  コメントには経緯として「120秒×2回」等の数字が書いてあるので、混ぜると見分けがつかない。 */
  function messageBodyWithoutComments(): string {
    const start = src.indexOf('export function streamTimeoutMessage(')
    expect(start).toBeGreaterThan(0) // 関数名を変えたらここで気づく
    const end = src.indexOf('\n}\n', start)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')
  }

  it('★ 画面に出す文に、手で書いた秒数が1つも無い（定数を変えた日に文言だけ取り残されない）', () => {
    const body = messageBodyWithoutComments()
    // 「90秒」とベタ書きしたら、ここで落ちる（前の版はこれを素通りさせていた）
    expect(body).not.toMatch(/\d+\s*秒/)
    expect(body).not.toMatch(/\d+\s*回/)
    // 秒数・回数は式から作る
    expect(body).toContain('${sec(STREAM_IDLE_TIMEOUT_MS)}秒')
    expect(body).toContain('${sec(STREAM_FIRST_CHUNK_TIMEOUT_MS)}秒')
    expect(body).toContain('${sec(STREAM_FIRST_CHUNK_TIMEOUT_MS * (STREAM_MAX_RETRIES + 1))}秒')
    expect(body).toContain('${STREAM_MAX_RETRIES + 1}回')
  })

  it('★ 出来上がった文の数字が、いまの定数の値と一致する（式がよそを指していないこと）', () => {
    // 上の「式で作られている」だけだと、別の定数の式に差し替えられても通る。
    // 実際に出来上がった文の数字と、その症状で本当に待つ時間を突き合わせる。
    expect(secsIn(streamTimeoutMessage('first'))).toEqual([
      sec(STREAM_FIRST_CHUNK_TIMEOUT_MS),
      sec(STREAM_FIRST_CHUNK_TIMEOUT_MS * (STREAM_MAX_RETRIES + 1)),
    ])
    expect(secsIn(streamTimeoutMessage('first-silent'))).toEqual([sec(STREAM_IDLE_TIMEOUT_MS)])
    expect(secsIn(streamTimeoutMessage('idle'))).toEqual([sec(STREAM_IDLE_TIMEOUT_MS)])
  })
})
