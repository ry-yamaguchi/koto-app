import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import http from 'node:http'
import type { Server } from 'node:http'

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-25 検分の指摘4: 【🗂 まとめる】の待ち中、⏹ ボタンも「⏹ で停止できます」も出るのに、
// **押しても何も起きなかった**（最悪およそ600秒＝NON_STREAM_TIMEOUT_MS × 再試行）。
//
// 0.3.50 で engine.ts の runSakuraChat に中断の口（cbs.onAbortReady）を足したとき、渡したのは
// main のターン経路（chat/turnRunner.ts）だけで、renderer から呼ばれる口（IPC の sakura:chat）
// には配線していなかった。**同じ欠陥の片方だけが直った**状態で、表示側だけが
// 「⏹ で停止できます」と言うようになっていた（2026-09-23 の「300秒以上戻ってこない。停止もしない」と
// まったく同じ見え方）。
//
// ── このテストの流儀（2026-09-23 の教訓・掟10）──────────────────────────
// **「返ってこない」場合を模す。** 止まらない道筋は「返ってこない」ときにしか現れない。
// ここでは *決して応答しない* 本物の http サーバを立て、preload → IPC → engine → その偽サーバ、
// という**実際の経路そのもの**に流す。ソースの文字列ではなく、
//   ・⏹ を押したら、返事を待っている最中でも通信が切れて promise が終わること
//   ・押さなければ最後まで普通に返ること（副作用が無いことの対照）
// を固定する。配線が抜けていれば、この promise は**永久に解決せず**テストは時間切れで落ちる。
// ─────────────────────────────────────────────────────────────────────────────

/** 偽 electron。ipcMain.handle で登録された main のハンドラを、ipcRenderer.invoke から実際に呼ぶ。 */
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** contextBridge へ露出された window.electronAPI 相当（preload.ts の中身そのもの）。 */
  exposed: null as any,
  /** ipcRenderer.invoke の呼ばれた順（チャンネルと引数）。 */
  invokes: [] as { channel: string; args: any[] }[],
  /** onStart（中断関数の受け渡し）が起きた地点も同じ列に記録する。 */
  marks: [] as string[],
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  contextBridge: { exposeInMainWorld: (_name: string, api: any) => { h.exposed = api } },
  ipcRenderer: {
    on: () => {}, removeListener: () => {},
    invoke: async (channel: string, ...args: any[]) => {
      h.invokes.push({ channel, args })
      h.marks.push(`invoke:${channel}`)
      const fn = h.handlers.get(channel)
      if (!fn) throw new Error(`未登録のチャンネル: ${channel}`)
      try {
        return await fn({ sender: { send: () => {} } }, ...args)
      } catch (e: any) {
        // 本物の Electron は main の例外を**文字列に包んで**renderer へ渡す（name は失われる）。
        // 包んだ形でも ⏹ 停止として判定できることまで、ここで一緒に固定する。
        throw new Error(`Error invoking remote method '${channel}': ${e?.message ?? String(e)}`)
      }
    },
  },
  webUtils: { getPathForFile: () => '' },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {}, dialog: {},
}))

import { registerSakuraHandlers } from '../src/main/ipc/sakura'
import '../src/main/preload' // 読み込むだけで contextBridge へ露出される
import { runCompact, type EngineTurnPorts } from '../src/shared/chatTurn'
import { turnKey, getTurn, updateTurn, resetTurn } from '../src/renderer/chatTurnRegistry'
import { compactPrompt, acceptSummary, compactSource } from '../src/renderer/historyCompact'
import { modelLabel, estimateTokens } from '../src/renderer/usage'
import { formatChatError } from '../src/renderer/aiTools'

registerSakuraHandlers({} as any)
/** preload.ts が露出した本物の window.electronAPI.sakura（テスト用に作り直さない）。 */
const sakura = () => h.exposed.sakura

let server: Server | null = null

afterEach(() => {
  if (server) { server.closeAllConnections(); server.close(); server = null }
  h.invokes.length = 0
  h.marks.length = 0
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

/** **決して応答しない**偽サーバ。要求が届いたら arrived が解決するが、返事は永久に返さない。 */
async function silentServer(): Promise<{ baseURL: string; arrived: Promise<void> }> {
  let onArrive: () => void = () => {}
  const arrived = new Promise<void>(resolve => { onArrive = resolve })
  const port = await listen((_req, _res) => { onArrive() /* 何も書かない・閉じない */ })
  return { baseURL: `http://127.0.0.1:${port}/v1`, arrived }
}

// まとめ本文は acceptSummary（shared/historyCompact.ts）が受け取れる形にする
// （目印「## まとめ」＋ MIN_SUMMARY_CHARS 以上）。偽の返事でも本物の判定を通す。
const SUMMARY_BODY = 'アプリを作りたいという相談を受け、どんなアプリかを聞いたところまでです。'
const OK_BODY = JSON.stringify({
  id: 'x', object: 'chat.completion', created: 0, model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: `## まとめ\n${SUMMARY_BODY}` }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
})

/** 普通に答える偽サーバ（対照用）。 */
async function answeringServer(): Promise<string> {
  const port = await listen((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(OK_BODY)
  })
  return `http://127.0.0.1:${port}/v1`
}

const MSGS = [{ role: 'user', content: 'ここまでをまとめて' }]

// ═══════════════════════════════════════════════════════════════════════════
// 1. IPC（main / preload）に実際に流す
// ═══════════════════════════════════════════════════════════════════════════

describe('非ストリーミングの sakura:chat に ⏹ が配線されている', () => {
  it('★ 返事が一度も返ってこない相手でも、⏹ を押せば止まる（押さなければ最悪およそ600秒戻らない）', async () => {
    const { baseURL, arrived } = await silentServer()
    let abortFn: (() => void) | null = null
    const p = sakura().chat(
      { apiKey: 'test-key', model: 'test-model', messages: MSGS, maxTokens: 4096, baseURL },
      (fn: () => void) => { abortFn = fn },
    )
    // 中断関数は**要求を送る前に**渡される（engine.ts の「先に中断関数を渡す」と同じ形）
    expect(abortFn).not.toBeNull()
    await arrived // 要求はサーバへ届いた。だがサーバは何も返さない
    abortFn!()
    // 配線が抜けていれば、ここは永久に解決しない（＝テストは時間切れで落ちる）
    await expect(p).rejects.toThrow(/abort/i)
  })

  it('対照: ⏹ を押さなければ、最後まで普通に返る（止める配線が邪魔をしていない）', async () => {
    const baseURL = await answeringServer()
    let abortFn: (() => void) | null = null
    const r = await sakura().chat(
      { apiKey: 'test-key', model: 'test-model', messages: MSGS, maxTokens: 4096, baseURL },
      (fn: () => void) => { abortFn = fn },
    )
    expect(r.content).toContain(SUMMARY_BODY)
    expect(r.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 })
    // 終わった呼び出しの中断関数を押しても、何も起きない（片づけ済み＝落ちない）
    expect(abortFn).not.toBeNull()
    expect(() => abortFn!()).not.toThrow()
  })

  it('★ 中断関数は invoke より先に渡され、押すと**同じ id**で sakura:chat-abort が呼ばれる', async () => {
    const { baseURL, arrived } = await silentServer()
    let abortFn: (() => void) | null = null
    const p = sakura().chat(
      { apiKey: 'test-key', model: 'test-model', messages: MSGS, maxTokens: 4096, baseURL },
      (fn: () => void) => { h.marks.push('onStart'); abortFn = fn },
    )
    // 順序: onStart → sakura:chat（逆だと「返事を待っている間」に押せない）
    expect(h.marks.slice(0, 2)).toEqual(['onStart', 'invoke:sakura:chat'])
    await arrived
    abortFn!()
    await expect(p).rejects.toThrow(/abort/i)
    const started = h.invokes.find(x => x.channel === 'sakura:chat')
    const aborted = h.invokes.find(x => x.channel === 'sakura:chat-abort')
    expect(typeof started?.args[0]?.id).toBe('string')
    expect(aborted?.args[0]).toBe(started?.args[0]?.id) // 別の id を採番していたら空振りする
  })

  it('知らない id で ⏹ を押しても落ちない（すでに終わった呼び出し・二度押し）', async () => {
    expect(() => h.handlers.get('sakura:chat-abort')!({}, 'このidは無い')).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. 🗂 まとめ作り本体（runCompact）に、renderer と同じ形でつないで流す
// ═══════════════════════════════════════════════════════════════════════════

/** useAiChat.ts の buildPorts と**同じ形**の chatOnce（中断関数を registry へ登録する）で ports を組む。
 *  runCompact が使うのは emit / chatOnce / usage / h だけなので、それ以外は素通りの実装を置く。 */
function compactPorts(key: string, baseURL: string): EngineTurnPorts {
  return {
    emit: () => {},
    chatOnce: (req: any) => sakura().chat({ ...req, baseURL }, (fn: () => void) => { updateTurn(key, { abort: fn }) }),
    usage: { check: () => ({ allowed: true }), record: () => {}, estimate: (t: string) => estimateTokens(t) },
    h: { compactPrompt, acceptSummary, compactSource, modelLabel, formatChatError },
  } as unknown as EngineTurnPorts
}

const HISTORY = [
  { role: 'user', content: 'アプリを作りたい' },
  { role: 'assistant', content: 'どんなアプリですか' },
] as any[]
const PLAN = { base: null, from: 0, to: 2, mark: 'm1' }

describe('🗂 まとめ作り（runCompact）の待ち中に ⏹ を押す', () => {
  const key = turnKey('/proj-compact-stop', undefined)
  afterEach(() => { resetTurn(key) })

  it('★ 返ってこないまとめ作りの最中、registry の ⏹ を押すと { aborted: true } で終わる', async () => {
    const { baseURL, arrived } = await silentServer()
    resetTurn(key)
    expect(getTurn(key).abort).toBeNull() // 押す相手がまだ居ない状態から始める

    const p = runCompact({ apiKey: 'k', model: 'test-model' }, compactPorts(key, baseURL), HISTORY, PLAN)
    await arrived
    // **返事を待っている最中**に、⏹ の相手が登録されている（await のあとに登録する形では null のまま）
    const stop = getTurn(key).abort
    expect(stop).not.toBeNull()
    stop!()

    // 「（⏹ 停止しました）」を出す分岐（useAiChat.ts の compactNow）へ入る形で返ること
    await expect(p).resolves.toEqual({ aborted: true })
  })

  it('対照: 押さなければ、まとめの本文が返る', async () => {
    const baseURL = await answeringServer()
    resetTurn(key)
    const r: any = await runCompact({ apiKey: 'k', model: 'test-model' }, compactPorts(key, baseURL), HISTORY, PLAN)
    expect(r.msg?.content).toContain(SUMMARY_BODY)
    expect(r.msg?.summary).toEqual({ upTo: 2, mark: 'm1' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. renderer の配線（React のフックは import できないのでソースで固定する）
// ═══════════════════════════════════════════════════════════════════════════

describe('useAiChat.ts の配線（🗂 まとめ作りの chatOnce に停止を渡す）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/hooks/useAiChat.ts'), 'utf-8')

  it('chatOnce は中断関数を registry へ登録する（上のテストが流したのと同じ形）', () => {
    expect(src).toContain('chatOnce: (req) => window.electronAPI.sakura.chat(req, (fn) => { updateTurn(key, { abort: fn }) }),')
  })

  it('直す前の形（停止を渡さない chatOnce）が残っていない', () => {
    expect(src).not.toContain('chatOnce: (req) => window.electronAPI.sakura.chat(req),')
  })
})
