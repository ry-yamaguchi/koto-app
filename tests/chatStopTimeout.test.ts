import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import http from 'node:http'
import type { Server } from 'node:http'

import { runSakuraStream } from '../src/main/sakura/engine'
import { forEachChunkWithIdleTimeout } from '../src/shared/streamIdle'
import { chatStatusLine, STOP_HINT } from '../src/shared/chatStatusLine'
import OpenAI from 'openai'
import {
  STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, STREAM_MAX_RETRIES,
  NON_STREAM_TIMEOUT_MS, DELEGATE_TIMEOUT_MS, MODELS_TIMEOUT_MS, MODELS_MAX_RETRIES,
  streamTimeoutMessage, compactTimeoutMessage, delegateTimeoutMessage, isSdkTimeoutError,
} from '../src/shared/chatTimeouts'
import {
  requestApproval, answerApproval, cancelApprovalsForTurn, listPending,
  setApprovalListener, resetApprovalsForTest, type PendingApproval,
} from '../src/main/chat/approvalStore'

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-23 実機（作者 Ryosuke さん）: チャットが「実際に変更が必要か確かめています… 308秒」で
// 固まり、**⏹ を押しても止まらなかった**。356秒まで伸びても反応が無く、Koto を終了する以外に
// 抜ける手段が無かった。
//
// ── なぜ、この症状が何度もすり抜けたか（ここがいちばん大事）─────────────────
// tests/chatTurn.test.ts の停止まわりのテストは、偽の通信が**必ず即座に返る**作りで、
// **「返ってこない」場合を1件も扱っていなかった**。止まらない道筋は「返ってこない」ときにしか
// 現れないので、何度直しても残り続けた。このファイルは**決して解決しない通信**を正面から扱う。
// 実時間で待たないよう、時計は vitest の偽時計（vi.useFakeTimers）か、ミリ秒単位の差し込み口
// （runSakuraStream の timeoutMs / idleMs。baseURL と同じテスト用の口）で縮める。
// ─────────────────────────────────────────────────────────────────────────────

let server: Server | null = null

afterEach(() => {
  if (server) { server.close(); server = null }
  vi.useRealTimers()
  resetApprovalsForTest()
})

/** ローカルに http サーバを立てて空きポートで listen し、ポート番号を返す（sakuraEngine.test.ts と同じ形）。 */
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

function sseHead(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
}

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function contentChunk(text: string): string {
  return sseChunk({
    id: 'x', object: 'chat.completion.chunk', created: 0, model: 'test',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })
}

function reasoningChunk(text: string): string {
  return sseChunk({
    id: 'x', object: 'chat.completion.chunk', created: 0, model: 'test',
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 待ち時間の上限（値そのもの）
// ═══════════════════════════════════════════════════════════════════════════

describe('待ち時間の上限（shared/chatTimeouts.ts）', () => {
  it('★ 非ストリーミングの上限は、ストリーミングより長い（まとめ作りを時間切れで壊さない）', () => {
    // 🗂 まとめ作り・delegate_implementation は「生成が全部終わるまで」が1回の通信。
    // ストリーミングと同じ短さにすると、正常なまとめ作りが時間切れで壊れる。
    expect(NON_STREAM_TIMEOUT_MS).toBeGreaterThan(STREAM_FIRST_CHUNK_TIMEOUT_MS)
    expect(NON_STREAM_TIMEOUT_MS).toBeGreaterThan(STREAM_IDLE_TIMEOUT_MS)
  })

  it('openai 4.104.0 の既定（600秒・再試行2回＝最悪およそ30分）より必ず短く終わる', () => {
    const OPENAI_DEFAULT_TIMEOUT_MS = 600_000
    const OPENAI_DEFAULT_MAX_RETRIES = 2
    const worstNow = STREAM_FIRST_CHUNK_TIMEOUT_MS * (STREAM_MAX_RETRIES + 1)
    expect(worstNow).toBeLessThan(OPENAI_DEFAULT_TIMEOUT_MS * (OPENAI_DEFAULT_MAX_RETRIES + 1))
    expect(worstNow).toBeLessThanOrEqual(5 * 60_000) // 最悪でも5分以内には必ず戻る
  })

  it('★ 時間切れの文は「⏹ 停止しました」とは違う言葉（押してもいないのに停止と出さない）', () => {
    for (const kind of ['first', 'idle'] as const) {
      const msg = streamTimeoutMessage(kind)
      expect(msg).not.toContain('停止しました')
      expect(msg).not.toContain('⏹')
      expect(msg.length).toBeGreaterThan(10) // 黙って終わらせない（何か言う）
    }
    // 2つの時間切れは別々の理由なので、別々の文にする
    expect(streamTimeoutMessage('first')).not.toBe(streamTimeoutMessage('idle'))
  })

  it('文中の秒数は定数から作る（値を変えたら文言も追随する＝一元定義・掟10）', () => {
    expect(streamTimeoutMessage('first')).toContain(`${Math.round(STREAM_FIRST_CHUNK_TIMEOUT_MS / 1000)}秒`)
    expect(streamTimeoutMessage('idle')).toContain(`${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}秒`)
  })

  it('★ 「始まらなかった」の文の秒数が、利用者が実際に待つ時間と食い違わない（検分の指摘7）', () => {
    // node_modules/openai/core.js:322-331 は、fetch の時間切れに対し
    // **retriesRemaining の判定を APIConnectionTimeoutError への変換より先**に行う。
    // よって STREAM_MAX_RETRIES=1 なら 120秒×2回＝およそ241秒待たされる。画面の経過秒
    // カウンタはその数字を出しているので、「120秒待っても」とだけ書くと食い違う。
    const msg = streamTimeoutMessage('first')
    const totalSec = Math.round(STREAM_FIRST_CHUNK_TIMEOUT_MS * (STREAM_MAX_RETRIES + 1) / 1000)
    expect(msg).toContain(`${totalSec}秒`)          // 合計の待ち時間が文に出ている
    expect(msg).toContain(`${STREAM_MAX_RETRIES + 1}回`) // 試行回数も明示する
  })

  it('★ 🗂 まとめ作りの時間切れも日本語で伝える（英語の Request timed out. を出さない）', () => {
    const msg = compactTimeoutMessage()
    expect(msg).not.toMatch(/timed out/i)
    expect(msg).toContain('まとめ')
    // 秒数は定数から作る（一元定義・掟10）
    expect(msg).toContain(`${Math.round(NON_STREAM_TIMEOUT_MS / 1000)}秒`)
    expect(msg).not.toContain('停止しました') // ⏹ とは違う言葉
  })

  it('★ delegate の上限は、まとめ作りより長い（max_tokens が4倍・検分の指摘4）', () => {
    // まとめ作りは max_tokens=4096、delegate は DELEGATE_MAX_TOKENS=16384。
    // 同じ 300秒を当てると、これまで通っていた大きな委譲が時間切れで壊れる。
    expect(DELEGATE_TIMEOUT_MS).toBeGreaterThan(NON_STREAM_TIMEOUT_MS)
    // 日本語で、しかも「やり直せる」案内になっている
    const msg = delegateTimeoutMessage()
    expect(msg).not.toMatch(/timed out/i)
    expect(msg).toContain('小さく分けて')
  })

  it('★ モデル一覧の取得にも上限がある（⏹ に相当する止め方が無い口・検分の指摘13）', () => {
    const OPENAI_DEFAULT_WORST_MS = 600_000 * 3
    expect(MODELS_TIMEOUT_MS * (MODELS_MAX_RETRIES + 1)).toBeLessThan(OPENAI_DEFAULT_WORST_MS)
    expect(MODELS_TIMEOUT_MS * (MODELS_MAX_RETRIES + 1)).toBeLessThanOrEqual(2 * 60_000)
  })
})

describe('時間切れの判定（shared/chatTimeouts.ts の isSdkTimeoutError）', () => {
  it('★ SDK の APIConnectionTimeoutError は時間切れ（構成子名で見る。name は設定されない）', () => {
    const err = new OpenAI.APIConnectionTimeoutError()
    expect(err.message).toBe('Request timed out.') // node_modules/openai/error.js:88-92 の既定文言
    expect(isSdkTimeoutError(err)).toBe(true)
  })

  it('★ サーバ由来の「timed out」を自分の時間切れに化けさせない（検分の指摘8・14）', () => {
    // 504 Gateway Timeout の本文やモデルのエラー文に 'timed out' が入るだけで一致すると、
    // 数秒で返ってきたサーバの失敗が「120秒待っても始まらなかった」と説明され、
    // 本当の原因が隠れて利用者が無駄に再送を繰り返す。
    expect(isSdkTimeoutError({ message: '504 Gateway Timeout: upstream request timed out' })).toBe(false)
    expect(isSdkTimeoutError({ message: 'The model timed out while generating' })).toBe(false)
    expect(isSdkTimeoutError({ message: 'Connection error.' })).toBe(false)
    expect(isSdkTimeoutError(new Error('boom'))).toBe(false)
    expect(isSdkTimeoutError(undefined)).toBe(false)
    // SDK の既定文言そのものは（構成子名が失われていても）拾う
    expect(isSdkTimeoutError({ message: 'Request timed out.' })).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. 返事が始まったあとの無音（偽の時計で試す）
// ═══════════════════════════════════════════════════════════════════════════

describe('無音の見張り（shared/streamIdle.ts）', () => {
  /** 外から1件ずつ push できる、決して自分からは終わらない並び。 */
  function controllable<T>() {
    const waiting: ((r: IteratorResult<T>) => void)[] = []
    const queued: IteratorResult<T>[] = []
    const iterable: AsyncIterable<T> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const q = queued.shift()
          if (q) return Promise.resolve(q)
          return new Promise<IteratorResult<T>>(resolve => { waiting.push(resolve) })
        },
      }),
    }
    const deliver = (r: IteratorResult<T>) => {
      const w = waiting.shift()
      if (w) w(r)
      else queued.push(r)
    }
    return { iterable, push: (value: T) => deliver({ value, done: false }), finish: () => deliver({ value: undefined as any, done: true }) }
  }

  it('★ 決して来ないチャンクは、上限で打ち切られる（実時間では待たない）', async () => {
    vi.useFakeTimers()
    const src = controllable<string>()
    const seen: string[] = []
    let aborted = false
    const p = forEachChunkWithIdleTimeout(src.iterable, c => seen.push(c), {
      idleMs: STREAM_IDLE_TIMEOUT_MS,
      onTimeout: () => { aborted = true },
    })
    // 上限の直前では、まだ打ち切られていない
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    // received=0 ＝ 1件も届かないまま打ち切った（呼び出し側が 'first' と 'idle' を見分ける材料）
    expect(await p).toEqual({ timedOut: true, received: 0 })
    expect(aborted).toBe(true) // 打ち切るときは通信も止める
    expect(seen).toEqual([])
  })

  it('★ 届き続けているかぎり打ち切らない（推論の文字だけでも「届いている」と数える）', async () => {
    vi.useFakeTimers()
    const src = controllable<string>()
    const seen: string[] = []
    const p = forEachChunkWithIdleTimeout(src.iterable, c => seen.push(c), { idleMs: STREAM_IDLE_TIMEOUT_MS })
    // 上限より短い間隔で「推論だけ」が流れ続ける（推論モデルは本文が出るまで数十秒沈黙する）。
    // 合計は上限の3倍以上だが、1回も途切れていないので打ち切ってはいけない。
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1000)
      src.push(`思考${i}`)
      await vi.advanceTimersByTimeAsync(0)
    }
    src.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ timedOut: false, received: 4 })
    expect(seen).toEqual(['思考0', '思考1', '思考2', '思考3'])
  })

  it('最後まで読み切れば timedOut は立たない', async () => {
    vi.useFakeTimers()
    const src = controllable<string>()
    const p = forEachChunkWithIdleTimeout(src.iterable, () => {}, { idleMs: 1000 })
    src.push('a')
    src.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(await p).toEqual({ timedOut: false, received: 1 })
  })

  it('★ 1件届いたあとに無音になったら received=1（＝「途中まで残っている」と言ってよい）', async () => {
    // 検分の指摘11: 呼び出し側（engine.ts）はこの件数で 'first' と 'idle' を選び分ける。
    // 1件でも届いていれば「途中までの内容はそのまま残しています」は事実になる。
    vi.useFakeTimers()
    const src = controllable<string>()
    const p = forEachChunkWithIdleTimeout(src.iterable, () => {}, { idleMs: 1000 })
    src.push('こん')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await p).toEqual({ timedOut: true, received: 1 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. 実物の runSakuraStream（本物の http サーバ。SDK をモックしない）
// ═══════════════════════════════════════════════════════════════════════════

describe('runSakuraStream: 返ってこない通信', () => {
  it('★ 返事が始まる前に ⏹ を押しても効く（中断関数はリクエストの前に渡される）', async () => {
    // ヘッダも本文も返さないサーバ＝「返事が始まらない」状態を作る。
    // 直す前はリクエストを投げた**あと**に onAbortReady を呼んでいたので、この区間で
    // ⏹ を押しても止める相手がまだ存在せず、永久に戻らなかった。
    const port = await listen(() => { /* 何も返さない（接続だけ受ける） */ })

    let settled = false
    let abortFn: (() => void) | null = null
    const p = runSakuraStream(
      { apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], baseURL: `http://127.0.0.1:${port}/v1` },
      { onDelta: () => {}, onReasoning: () => {}, onAbortReady: fn => { abortFn = fn } },
    ).then(r => { settled = true; return r })

    // 中断関数は「まだ1文字も返ってきていない」時点で既に手に入っている
    await new Promise(r => setTimeout(r, 120))
    expect(abortFn).not.toBeNull()
    expect(settled).toBe(false) // 本当に返ってきていない（この前提が崩れたら試験が無意味）

    abortFn!()
    expect(await p).toEqual({ usage: null, aborted: true })
  })

  it('★ 返事が始まらないまま上限に達したら、時間切れとして戻る（永久に待たない）', async () => {
    const port = await listen(() => { /* 何も返さない */ })
    const r = await runSakuraStream(
      {
        apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }],
        baseURL: `http://127.0.0.1:${port}/v1`,
        timeoutMs: 200, // 本番は STREAM_FIRST_CHUNK_TIMEOUT_MS（実時間で2分待たないための差し込み口）
      },
      { onDelta: () => {}, onReasoning: () => {}, onAbortReady: () => {} },
    )
    expect(r).toEqual({ usage: null, timedOut: 'first' })
    expect(r.aborted).toBeUndefined() // ⏹ ではない（違う言葉を出すための区別）
  }, 20_000)

  it('★ 返事が始まったあと無音になったら、上限で打ち切られる（SDK の時計は解除済み）', async () => {
    // ヘッダと1チャンクだけ返して黙る＝ openai 4.104.0 の timeout が解除されたあと、
    // streaming.js には setTimeout が0件なので、誰も見張っていない状態。
    const port = await listen((_req, res) => {
      sseHead(res)
      res.write(contentChunk('こんにち'))
      // 以降、何も書かない（close もしない）
    })
    const deltas: string[] = []
    const r = await runSakuraStream(
      {
        apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }],
        baseURL: `http://127.0.0.1:${port}/v1`,
        idleMs: 250, // 本番は STREAM_IDLE_TIMEOUT_MS
      },
      { onDelta: d => deltas.push(d), onReasoning: () => {}, onAbortReady: () => {} },
    )
    expect(r).toEqual({ usage: null, timedOut: 'idle' })
    expect(deltas.join('')).toBe('こんにち') // 届いたぶんは呼び出し側へ流れている
  }, 20_000)

  it('★ ヘッダだけ返して1件も書かないサーバは「返事が始まらなかった」側（検分の指摘11）', async () => {
    // SDK の timeout は**応答ヘッダが返った時点で**解除される（core.js の fetchWithTimeout の
    // `.finally`）。実機の症状はこれ——STREAM_FIRST_CHUNK_TIMEOUT_MS は一度も発火せず、
    // 必ず無音側で打ち切られる。件数を見ずに 'idle' と決めていたため、1文字も届いていないのに
    // 「途中までの内容はそのまま残しています」と表示されていた（残っているものが無い）。
    const port = await listen((_req, res) => {
      sseHead(res)
      res.flushHeaders() // ヘッダだけを実際に送り出す。チャンクは1件も書かない
    })
    const deltas: string[] = []
    const r = await runSakuraStream(
      {
        apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }],
        baseURL: `http://127.0.0.1:${port}/v1`,
        timeoutMs: 5_000, // ヘッダは即座に返るので、この時計は発火しない（発火したら試験が無意味）
        idleMs: 250,
      },
      { onDelta: d => deltas.push(d), onReasoning: () => {}, onAbortReady: () => {} },
    )
    expect(deltas).toEqual([]) // 本当に1件も届いていない（この前提が崩れたら試験が無意味）
    expect(r).toEqual({ usage: null, timedOut: 'first' })
    // 画面に出る文が、実機の症状と食い違わない
    expect(streamTimeoutMessage(r.timedOut!)).not.toContain('途中までの内容はそのまま残しています')
  }, 20_000)

  it('★ 推論の文字だけが流れている間は打ち切られない（正常な応答を切らない）', async () => {
    const port = await listen((_req, res) => {
      sseHead(res)
      let i = 0
      const timer = setInterval(() => {
        i += 1
        if (i <= 5) { res.write(reasoningChunk(`思考${i} `)); return } // 本文は一度も出さない
        clearInterval(timer)
        res.write(contentChunk('答え'))
        res.write('data: [DONE]\n\n')
        res.end()
      }, 60) // 上限（150ms）より短い間隔。合計は上限を大きく超える
      _req.on('close', () => clearInterval(timer))
    })
    const reasoning: string[] = []
    const r = await runSakuraStream(
      {
        apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }],
        baseURL: `http://127.0.0.1:${port}/v1`,
        idleMs: 150,
      },
      { onDelta: () => {}, onReasoning: d => reasoning.push(d), onAbortReady: () => {} },
    )
    expect(r.timedOut).toBeUndefined() // 打ち切っていない
    expect(reasoning.length).toBe(5)
  }, 20_000)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. 書き込み確認の待ちを ⏹ で解く（approvalStore）
// ═══════════════════════════════════════════════════════════════════════════

describe('書き込み確認の待ち（main/chat/approvalStore.ts）', () => {
  it('★ ⏹ で取り消すと「拒否」として解け、ダイアログが閉じる', async () => {
    const seen: PendingApproval[][] = []
    setApprovalListener(list => seen.push(list))
    const p = requestApproval({ turnId: 't1', dir: '/proj', label: 'text.txt を保存します' })
    expect(listPending()).toHaveLength(1) // 駐機中（このままだと永久に待つ）

    expect(cancelApprovalsForTurn('t1')).toBe(1)
    expect(await p).toBe(false) // **承認したことにしない**（勝手に書き込ませない）
    expect(listPending()).toEqual([])
    expect(seen[seen.length - 1]).toEqual([]) // 画面へ「空になった」が push される＝ダイアログが閉じる
  })

  it('他のターンの保留には触らない（掟11 環境の独立）', async () => {
    const mine = requestApproval({ turnId: 't1', dir: '/a', label: 'A' })
    requestApproval({ turnId: 't2', dir: '/b', label: 'B' })
    expect(cancelApprovalsForTurn('t1')).toBe(1)
    expect(await mine).toBe(false)
    expect(listPending().map(p => p.label)).toEqual(['B']) // t2 はそのまま駐機
  })

  it('取り消すものが無ければ何もしない（通知も出さない）', () => {
    const seen: PendingApproval[][] = []
    setApprovalListener(list => seen.push(list))
    expect(cancelApprovalsForTurn('t-none')).toBe(0)
    expect(seen).toEqual([])
  })

  it('取り消したあとに答えが来ても二重解決しない（answerApproval は false を返す）', async () => {
    let id = ''
    setApprovalListener(list => { id = list[0]?.id ?? id })
    const p = requestApproval({ turnId: 't1', dir: null, label: 'A' })
    cancelApprovalsForTurn('t1')
    expect(await p).toBe(false)
    expect(answerApproval(id, true)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. 止め方の案内が隠れない（shared/chatStatusLine.ts）
// ═══════════════════════════════════════════════════════════════════════════

describe('進行中の1行（shared/chatStatusLine.ts）', () => {
  it('★ ステータス文言が出ていても、長引けば「⏹ で停止できます」が読める', () => {
    // 直す前は `statusNote || (stalled ? '…（⏹ で停止できます）' : '…')` だったので、
    // ステータス文言が出ている間は案内が**絶対に**表示されなかった。
    // しかも「実際に変更が必要か確かめています…」はターンが終わるまで消えないので、
    // 固まっている間ずっと隠れていた（実機で 308秒→356秒、抜け方が分からなかった）。
    const line = chatStatusLine('実際に変更が必要か確かめています…', true)
    expect(line).toContain('実際に変更が必要か確かめています…')
    expect(line).toContain(STOP_HINT)
  })

  it('4通りの組み合わせ', () => {
    expect(chatStatusLine('', false)).toBe('考えています…')
    expect(chatStatusLine('📄 資料を探しています…', false)).toBe('📄 資料を探しています…')
    expect(chatStatusLine('', true)).toBe(`⏳ 時間がかかっています…${STOP_HINT}`)
    expect(chatStatusLine('📄 資料を探しています…', true)).toBe(`📄 資料を探しています…${STOP_HINT}`)
    expect(chatStatusLine(null, false)).toBe('考えています…')
    expect(chatStatusLine(undefined, true)).toBe(`⏳ 時間がかかっています…${STOP_HINT}`)
  })

  it('★ 判断は1か所だけ。2つの画面は同じ純関数を呼ぶ（掟10・二重修正禁止）', () => {
    const files = ['src/renderer/components/ChatPanel.tsx', 'src/renderer/components/ChatApp.tsx']
    for (const rel of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
      expect(src, rel).toContain('{chatStatusLine(statusNote, stalled)}')
      expect(src, rel).toContain("import { chatStatusLine } from '../../shared/chatStatusLine'")
      // 直す前の形（条件を書き写したもの）へ戻っていないこと
      expect(src, rel).not.toContain("statusNote || (stalled ?")
      expect(src, rel).not.toContain('考えています…')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. エージェントループ本体（shared/chatTurn.ts）を偽 ports で駆動する
// ═══════════════════════════════════════════════════════════════════════════

import {
  runEngineTurn, runCompact, type EngineTurnSpec, type EngineTurnPorts, type TurnHelpers, type TurnMessage,
} from '../src/shared/chatTurn'
import { applyToMessages } from '../src/shared/chatEvents'
// 本物の純粋関数（tests/chatTurn.test.ts と同じ組み立て方。偽物で固めると実物と離れる）
import {
  formatChatError, condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, stripRepeatedGuidance, isToolArgsComplete, isToolUnsupportedError,
  toolStatusLabel, WRITING_TOOLS, toolsFor,
} from '../src/renderer/aiTools'
import { toolActionName, unexecutedToolsNote } from '../src/shared/aiToolsCore'
import { isImageUnsupportedError } from '../src/renderer/visionSupport'
import { modelLabel, pickBestModel, estimateTokens } from '../src/renderer/usage'
import { extractUrls, wantsWebSearch } from '../src/renderer/webContext'
import { planSend, planCompact, compactPrompt, acceptSummary, compactSource } from '../src/renderer/historyCompact'
import { searchStatusContext } from '../src/renderer/aiContext'

const helpers: TurnHelpers = {
  formatChatError, condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, stripRepeatedGuidance, isToolArgsComplete, isToolUnsupportedError,
  isImageUnsupportedError, toolStatusLabel, modelLabel, pickBestModel, writingTools: WRITING_TOOLS,
  extractUrls, wantsWebSearch, toolsFor, planSend, planCompact, compactPrompt, acceptSummary, compactSource,
  searchStatusContext,
}

function spec(over: Partial<EngineTurnSpec> = {}): EngineTurnSpec {
  return {
    rawText: 'text.txt を直して', images: [], assetBlock: '', apiKey: 'k', model: 'modelA',
    models: [{ id: 'modelA' }], maxRounds: 5, toolsProjectDir: '/proj', convDir: '/proj',
    errorPrefix: '', twoStageVision: false, routedModel: null, hasRag: false, turnOpts: {},
    snapshotId: 's1', snapshotLabel: 'text.txt を直して', ...over,
  }
}

type Cfg = {
  stream: any[]
  stopRequested?: () => boolean
  approveToolCall?: (name: string, args: string) => Promise<string | null>
  executeTool?: (name: string, args: string) => Promise<string>
}

function makePorts(cfg: Cfg) {
  const log: any[] = []
  let i = 0
  const ports: EngineTurnPorts = {
    emit: ev => { log.push({ tag: 'emit', ev }) },
    chatStream: async (_req, onDelta, onAbortReady, onThinking) => {
      const s = cfg.stream[i++] ?? { content: '' }
      onAbortReady(() => {})
      for (const d of s.thinkingDeltas ?? []) onThinking(d)
      if (s.content) onDelta(s.content)
      return { usage: null, aborted: s.aborted, timedOut: s.timedOut, toolCalls: s.toolCalls ?? null, reasoningText: null }
    },
    chatOnce: async () => ({ content: '', usage: null }),
    getHistory: () => [],
    buildSystemPrompt: () => 'システム',
    approveToolCall: cfg.approveToolCall
      ? async (name, args) => { log.push({ tag: 'approve', name }); return cfg.approveToolCall!(name, args) }
      : undefined,
    executeTool: async (name, args) => {
      log.push({ tag: 'executeTool', name, args })
      return cfg.executeTool ? cfg.executeTool(name, args) : 'ok'
    },
    getSearchConfig: async () => null,
    fetchPagesBlock: async () => '',
    autoSearchBlock: async () => '',
    notifyActivity: () => {},
    setAbort: () => {},
    stopRequested: cfg.stopRequested,
    usage: { check: () => ({ allowed: true }), record: () => {}, estimate: t => estimateTokens(t) },
    toolSupport: { shouldSendTools: () => true, isKnownToolCapable: () => true, record: () => {} },
    vision: { shouldTryDirect: () => true, record: () => {}, defaultModel: () => 'v' },
    compactWarnOnce: () => false,
    h: helpers,
  }
  return { ports, log }
}

/** 出来事を本物の applyToMessages で畳み、**最終的に画面へ残る**メッセージ列を得る。 */
function shown(log: any[]): TurnMessage[] {
  let msgs: TurnMessage[] = []
  for (const e of log) {
    if (e.tag === 'emit' && (e.ev.kind === 'append' || e.ev.kind === 'replaceLast' || e.ev.kind === 'removeLast')) {
      msgs = applyToMessages(msgs, e.ev)
    }
  }
  return msgs
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

describe('runEngineTurn: ラウンドの途中で ⏹ を押す', () => {
  it('★ ツールを複数積んだラウンドの途中で ⏹ が効く（残りは実行しない）', async () => {
    // 直す前はラッチを読むのが**ラウンドの冒頭1か所だけ**だったので、1ラウンドに複数の
    // ツールが積まれていると全部終わるまで ⏹ が効かなかった。
    let stop = false
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: [
        call('c1', 'read_file', { path: 'a.txt' }),
        call('c2', 'write_file', { path: 'b.txt', content: 'x' }),
        call('c3', 'write_file', { path: 'c.txt', content: 'y' }),
      ] }],
      stopRequested: () => stop,
      executeTool: async () => { stop = true; return '読みました' }, // 1件目の実行中に ⏹ が押された
    })
    await runEngineTurn(spec(), ports)

    const executed = log.filter(e => e.tag === 'executeTool').map(e => e.name)
    expect(executed).toEqual(['read_file']) // 2件目・3件目は実行されない

    const last = shown(log)
    expect(last.some(m => (m.content ?? '').includes('（⏹ 停止しました）'))).toBe(true)
    // ★ 実行していない「✏️ ファイルを保存しています…」が画面に残らない（2026-09-23 実機の訴え）
    const note = last.map(m => m.content ?? '').join('\n')
    expect(note).toContain('📄')                       // 実際に走った読み取りの行は残る
    expect(note).not.toContain('ファイルを保存しています') // 走っていない書き込みの行は消える
    expect(note).toContain('⏹ 停止したため、残りの操作は実行していません。')
  })

  it('★ すでに実行したツールの結果は捨てない（AIへの履歴が壊れない）', async () => {
    let stop = false
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: [call('c1', 'read_file', { path: 'a.txt' }), call('c2', 'read_file', { path: 'b.txt' })] }],
      stopRequested: () => stop,
      executeTool: async () => { stop = true; return '中身' },
    })
    await runEngineTurn(spec(), ports)
    // 1件目は最後まで実行され、結果が得られている（呼ばれたこと自体が記録に残る）
    expect(log.filter(e => e.tag === 'executeTool')).toHaveLength(1)
  })

  it('ラウンドの冒頭で既に押されていれば、通信すら始めない（従来の道筋は残っている）', async () => {
    const { ports, log } = makePorts({ stream: [{ content: 'やあ' }], stopRequested: () => true })
    await runEngineTurn(spec(), ports)
    expect(log.filter(e => e.tag === 'executeTool')).toHaveLength(0)
    expect(shown(log).some(m => (m.content ?? '') === '（⏹ 停止しました）')).toBe(true)
  })
})

describe('runEngineTurn: 書き込み確認の待ち中に ⏹', () => {
  it('★ 承認待ちで固まらない。⏹ で拒否として解け、ターンが終わる', async () => {
    // 本物の approvalStore を使う（requestApproval は**タイムアウトしない**＝ここが直す前の袋小路）。
    let stop = false
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: [call('c1', 'write_file', { path: 'b.txt', content: 'x' })] }],
      stopRequested: () => stop,
      approveToolCall: async () => {
        const p = requestApproval({ turnId: 'turn-1', dir: '/proj', label: 'b.txt を保存します' })
        // 利用者が ⏹ を押す（turnRunner の chatTurn:abort ハンドラと同じ2つの副作用）
        setTimeout(() => { stop = true; cancelApprovalsForTurn('turn-1') }, 5)
        return (await p) ? null : '利用者が許可しなかったため実行していません'
      },
    })
    // 直す前はここで永久に待っていた（ターンが返らない）。
    await runEngineTurn(spec(), ports)

    expect(log.filter(e => e.tag === 'executeTool')).toHaveLength(0) // 承認したことにしない
    expect(listPending()).toEqual([]) // ダイアログは閉じている
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).not.toContain('ファイルを保存しています') // 保存していないのに残さない
    // ★ 検分の指摘2・12: 利用者は「許可しない」を押していない。⏹ を押しただけ。
    // cancelApprovalsForTurn が resolve(false)＝拒否として解く都合を、そのまま画面へ出さない。
    expect(text).not.toContain('⛔ 許可されなかったため、実行していない操作があります。')
    expect(text).toContain('⏹ 停止したため、残りの操作は実行していません。')
    expect(text).toContain('（⏹ 停止しました）')
  })

  it('★ 本物の「許可しない」は、これまでどおり ⛔ と出る（⏹ と混同しない）', async () => {
    // 上の直しで ⛔ の道筋まで消してしまっていないことを固定する。
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: [call('c1', 'write_file', { path: 'b.txt', content: 'x' })] }],
      stopRequested: () => false, // ⏹ は押されていない
      approveToolCall: async () => '利用者が許可しなかったため実行していません',
    })
    await runEngineTurn(spec(), ports)
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).toContain('⛔ 許可されなかったため、実行していない操作があります。')
    expect(text).not.toContain('⏹ 停止したため、残りの操作は実行していません。')
    expect(text).not.toContain('ファイルを保存しています')
  })
})

describe('runEngineTurn: ツールが失敗したとき', () => {
  it('★ 保存に失敗したら「✏️ ファイルを保存しています…」を残さない（検分の指摘3・6）', async () => {
    // executeToolCore は失敗を例外にせず `エラー: …` の文字列で返す。
    // 直す前は「戻ってきた＝実行できた」と記録していたので、失敗しても見出しが残っていた
    // （＝今回の発端「確認しかしていないのに『保存しています…』が2件出ていた」と同じ見え方）。
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: [
        call('c1', 'read_file', { path: 'a.txt' }),
        call('c2', 'write_file', { path: 'b.txt', content: 'x' }),
      ] }],
      executeTool: async (name) => (name === 'write_file'
        ? 'エラー: 保存できませんでした（EACCES: permission denied）'
        : 'ファイル: a.txt\n\n中身'),
    })
    await runEngineTurn(spec(), ports)
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).toContain('📄')                        // 成功した読み取りの行は残る
    expect(text).not.toContain('ファイルを保存しています') // 失敗した書き込みの行は消える
    // 2026-09-23: 件数と「何が」を出すようにした（下の describe で詳しく固定している）
    expect(text).toContain('⚠️ 実行できなかった操作があります（1件）。')
    expect(text).toContain('　・✏️ ファイルの保存（b.txt）')
    expect(text).not.toContain('⛔')  // 拒否されたわけではない
    expect(text).not.toContain('⏹')  // 停止したわけでもない
  })

  it('★ 保存に失敗したターンは「変更した」扱いにしない（変更なしの指摘を抑止しない）', async () => {
    // wroteFiles が失敗でも立っていたため、「ファイルは変更されていません」の道筋が
    // 丸ごと抑止されていた（検分の指摘6）。AI が「直しました」と言い切ったときに気づけない。
    const { ports, log } = makePorts({
      stream: [
        { content: '', toolCalls: [call('c1', 'write_file', { path: 'b.txt', content: 'x' })] },
        { content: 'b.txt を修正しました。' }, // ← 保存は失敗しているのに「直した」と言う
        { content: '変更は不要でした。' },      // ← 促されても書かずに終える
      ],
      executeTool: async () => 'エラー: 保存できませんでした（EACCES: permission denied）',
    })
    await runEngineTurn(spec(), ports)
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).toContain('ファイルは変更されていません')
  })
})

describe('runEngineTurn: 時間切れ', () => {
  it('★ 時間切れのときは、⏹ とは違う言葉が画面に残る（黙って終わらせない）', async () => {
    const { ports, log } = makePorts({ stream: [{ content: 'こんにち', timedOut: 'idle' }] })
    await runEngineTurn(spec(), ports)
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).toContain('こんにち')                       // 途中までの内容は残す
    expect(text).toContain(streamTimeoutMessage('idle'))
    expect(text).not.toContain('⏹ 停止しました')             // 押してもいないのに停止と言わない
  })

  it('★ 時間切れのあと、次のラウンドへ進まない（再試行で更に待たせない）', async () => {
    const { ports, log } = makePorts({
      stream: [
        { content: '', timedOut: 'first', toolCalls: [call('c1', 'read_file', { path: 'a.txt' })] },
        { content: '2回目' },
      ],
    })
    await runEngineTurn(spec(), ports)
    expect(log.filter(e => e.tag === 'executeTool')).toHaveLength(0)
    expect(shown(log).map(m => m.content ?? '').join('\n')).not.toContain('2回目')
  })

  it('★ 🗂 まとめ作りが時間切れでも、英語の「Request timed out.」を画面に出さない（検分の指摘1）', async () => {
    // runSakuraChat に上限を入れたことで、まとめ作りが初めて時間切れで終わるようになった。
    // 直す前は isAbortError（/abort/i）に当たらず formatChatError へ落ち、
    // 「⚠️ エラー: Request timed out.」がそのまま吹き出しに出ていた。
    const { ports } = makePorts({ stream: [] })
    ports.chatOnce = async () => { throw new OpenAI.APIConnectionTimeoutError() }
    const plan = { base: '', from: 0, to: 1, mark: 1 }
    const r = await runCompact({ apiKey: 'k', model: 'modelA' }, ports, [{ role: 'user', content: 'x' }], plan)
    expect(r).toEqual({ timedOut: true })
    expect('error' in r).toBe(false) // 英語のエラー文言へは落ちない
  })

  it('★ 自動のまとめが時間切れでも、案内は日本語（1度だけ・黙って忘れない）', async () => {
    // 送る量が予算を超えてまとめを試み、それが時間切れになった場合の道筋。
    const { ports, log } = makePorts({ stream: [{ content: 'やあ' }] })
    ports.chatOnce = async () => { throw new OpenAI.APIConnectionTimeoutError() }
    ports.compactWarnOnce = () => true
    ports.h = { ...helpers, planCompact: () => ({ base: '', from: 0, to: 1, mark: 1 }) }
    await runEngineTurn(spec(), ports)
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).not.toMatch(/timed out/i)
    expect(text).toContain(compactTimeoutMessage())
  })

  it('★ あいさつの経路も時間切れを受け取る（空の吹き出しのまま黙らせない・検分の指摘5・15）', () => {
    // greet は runEngineTurn を通らず window.electronAPI.sakura.chatStream を直に呼ぶ。
    // runSakuraStream は時間切れのとき throw せず return するので、catch のフォールバックは
    // 効かない。DOM を持たない試験環境なので、ここは呼び出しの形で固定する
    // （当て先が他の行に出ないよう、受け取りの形ごと・直す前の形の禁止つきで書く・掟10）。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf8')
    expect(src).toContain('const { usage, timedOut } = await window.electronAPI.sakura.chatStream(')
    expect(src).not.toContain('const { usage } = await window.electronAPI.sakura.chatStream(') // 直す前の形
    expect(src).toContain("import { streamTimeoutMessage } from '../../shared/chatTimeouts'")
    expect(src).toContain('streamTimeoutMessage(timedOut)')
    // 秒数・文言をこの画面に書き写していない（一元定義・掟10）
    expect(src).not.toContain('120秒')
  })

  it('保存する前に「保存しました」と読める表示を出さない（実行前の見出しは進行形）', () => {
    const label = toolStatusLabel('write_file', JSON.stringify({ path: 'b.txt' }))
    expect(label).not.toMatch(/保存しました|変更しました|書き込みました/)
    expect(label).toContain('保存しています')
  })
})

// ── 実行できなかった操作を、名前で伝える（2026-09-23 実機・Ryosuke）──────────────
// 実機の画面で「⚠️ 実行できなかった操作があります。」が3回出たが、**何が失敗したのか
// 利用者には分からなかった**。成功した操作の見出しと同じ枠に並ぶので、対照して読める
// 形にする。文言は shared/aiToolsCore.ts の一元定義（toolActionName / unexecutedToolsNote）。
describe('runEngineTurn: 実行できなかった操作の名前を出す', () => {
  it('★ どの操作が失敗したのかが、成功した操作と並べて読める', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: [
        call('c1', 'read_file', { path: 'server.js' }),
        call('c2', 'write_file', { path: 'server.js', content: 'x' }),
        call('c3', 'run_command', { command: 'npm test' }),
      ] }],
      executeTool: async (name) => (name === 'read_file'
        ? 'ファイル: server.js\n\n中身'
        : 'エラー: 保存できませんでした（EACCES: permission denied）'),
    })
    await runEngineTurn(spec(), ports)
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).toContain('📄 ファイルを読んでいます… server.js')   // 成功した操作の見出しは残る
    expect(text).toContain('⚠️ 実行できなかった操作があります（2件）。')
    expect(text).toContain('　・✏️ ファイルの保存（server.js）')
    expect(text).toContain('　・⚡ コマンドの実行（npm test）')
    expect(text).not.toContain('ファイルを保存しています')             // 失敗した見出しは残さない
    expect(text).not.toMatch(/EACCES|permission denied/)               // 英語の生の文字列は出さない
  })

  it('★ 件数が多いときは上限で切り、切ったことが分かる', async () => {
    const paths = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: paths.map((p, i) => call(`c${i}`, 'write_file', { path: p, content: 'x' })) }],
      executeTool: async () => 'エラー: 保存できませんでした',
    })
    await runEngineTurn(spec(), ports)
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).toContain('⚠️ 実行できなかった操作があります（7件）。')
    expect(text).toContain('　・✏️ ファイルの保存（e.txt）')      // 上限（5件）までは名前で出す
    expect(text).not.toContain('　・✏️ ファイルの保存（f.txt）')  // 6件目からは出さない
    expect(text).toContain('　・ほか 2件は省略しました。')          // 黙って捨てない
  })

  it('★ 「⛔ 許可されなかった」「⏹ 停止した」との書き分けは保つ', async () => {
    // 失敗（ツールが `エラー: …` を返した）だけのときに、他の2つの文言を混ぜない。
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: [call('c1', 'write_file', { path: 'b.txt', content: 'x' })] }],
      executeTool: async () => 'エラー: 保存できませんでした',
    })
    await runEngineTurn(spec(), ports)
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).toContain('⚠️ 実行できなかった操作があります（1件）。')
    expect(text).not.toContain('⛔ 許可されなかったため、実行していない操作があります。')
    expect(text).not.toContain('⏹ 停止したため、残りの操作は実行していません。')
  })

  it('★ 許可しなかった操作は「失敗」に混ぜない（⛔ のまま）', async () => {
    const { ports, log } = makePorts({
      stream: [{ content: '', toolCalls: [call('c1', 'write_file', { path: 'b.txt', content: 'x' })] }],
      stopRequested: () => false,
      approveToolCall: async () => '利用者が許可しなかったため実行していません',
    })
    await runEngineTurn(spec(), ports)
    const text = shown(log).map(m => m.content ?? '').join('\n')
    expect(text).toContain('⛔ 許可されなかったため、実行していない操作があります。')
    expect(text).not.toContain('実行できなかった操作があります')
  })
})

describe('toolActionName / unexecutedToolsNote（画面に出る文の一元定義）', () => {
  it('操作の名前は、見出しと同じ絵文字で、何をしようとしたかが分かる', () => {
    expect(toolActionName('read_file', JSON.stringify({ path: 'server.js' }))).toBe('📄 ファイルの読み取り（server.js）')
    expect(toolActionName('write_file', JSON.stringify({ path: 'server.js' }))).toBe('✏️ ファイルの保存（server.js）')
    expect(toolActionName('edit_file', JSON.stringify({ path: 'server.js' }))).toBe('✏️ ファイルの編集（server.js）')
    expect(toolActionName('run_command', JSON.stringify({ command: 'npm test' }))).toBe('⚡ コマンドの実行（npm test）')
    expect(toolActionName('list_files', '{}')).toBe('📁 ファイル一覧の確認')
    expect(toolActionName('search_web', JSON.stringify({ query: '予定表' }))).toBe('🔍 Webの検索（予定表）')
  })

  it('長いコマンドは途中で切り、切ったことが分かる（画面が流れない）', () => {
    const long = 'npm install ' + 'x'.repeat(80)
    const s = toolActionName('run_command', JSON.stringify({ command: long }))
    expect(s.length).toBeLessThan(long.length)
    expect(s).toContain('…）')
  })

  it('引数が壊れていても、何の操作かは伝える', () => {
    expect(toolActionName('write_file', '{壊れた')).toBe('✏️ ファイルの保存')
  })

  it('★ 表に無いツールでも、英語の内部名を画面に出さない', () => {
    // AI が存在しないツール名を呼ぶと「未対応のツールです」で失敗になり、この行が
    // 「⚠️ 実行できなかった操作があります（1件）。／　・🔧 create_directory」として
    // 利用者に見えていた（2026-09-23 検分）。仕様は「利用者向けの日本語。内部用語を書かない」。
    for (const name of ['create_directory', 'str_replace_editor', 'NotAToolName']) {
      const s = toolActionName(name, '{}')
      expect(s, `英語の内部名がそのまま出ている: ${s}`).not.toContain(name)
    }
    expect(toolActionName('create_directory', '{}')).toBe('🔧 その他の操作')
  })

  it('一覧が空でも黙らない', () => {
    expect(unexecutedToolsNote([])).toBe('⚠️ 実行できなかった操作があります。')
  })

  it('実行中の見出し（toolStatusLabel）の文言は変えていない', () => {
    // 表にまとめ直したときに、見えている文が1文字も変わっていないことを固定する。
    expect(toolStatusLabel('read_file', JSON.stringify({ path: 'a.txt' }))).toBe('📄 ファイルを読んでいます… a.txt')
    expect(toolStatusLabel('write_file', JSON.stringify({ path: 'a.txt' }))).toBe('✏️ ファイルを保存しています… a.txt')
    expect(toolStatusLabel('edit_file', JSON.stringify({ path: 'a.txt' }))).toBe('✏️ ファイルを編集しています… a.txt')
    expect(toolStatusLabel('list_files', '{}')).toBe('📁 ファイル一覧を確認しています…')
    expect(toolStatusLabel('run_command', JSON.stringify({ command: 'ls' }))).toBe('⚡ コマンドを実行しています… ls')
    expect(toolStatusLabel('open_preview', '{}')).toBe('🌐 プレビューを開いています… index.html')
    expect(toolStatusLabel('search_web', JSON.stringify({ query: 'あ' }))).toBe('🔍 Webを検索しています… 「あ」')
    expect(toolStatusLabel('search_docs', JSON.stringify({ query: 'あ' }))).toBe('📚 資料を検索しています… 「あ」')
    expect(toolStatusLabel('search_in_files', JSON.stringify({ query: 'あ' }))).toBe('🔍 内容を検索しています… 「あ」')
    expect(toolStatusLabel('fetch_url', JSON.stringify({ url: 'https://example.com' }))).toBe('🌐 ページを取得しています… https://example.com')
    expect(toolStatusLabel('unknown_tool', '{}')).toBe('🔧 unknown_tool を実行しています…')
    expect(toolStatusLabel('read_file', '{壊れた')).toBe('🔧 read_file を実行しています…') // 従来どおり
  })
})
