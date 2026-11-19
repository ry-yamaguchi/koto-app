// tests/claudeTurnIsolation.test.ts — Claude の出来事を回ごとに分ける（画面）。
//
// 本物の useAiChat を、偽の React・偽の electronAPI で動かす。偽の onStream は本物の preload と同じく、
// 購読者を全員ぶん持ち、流した出来事を全員へ配る。偽の chatStart は、渡された最後の引数（回の印）を控える。
// 見るのは、会話へ入った吹き出し・費用の記録・使用量の記録・会話の番号の保存・chatStart の呼び出し。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const rt = vi.hoisted(() => ({ slots: [] as any[], i: 0 }))
vi.mock('react', async () => {
  const actual = await vi.importActual<any>('react')
  const useRef = (init: unknown) => { const s = (rt.slots[rt.i] ??= { current: init }); rt.i++; return s }
  const useState = (init: unknown) => {
    const idx = rt.i++
    const s = (rt.slots[idx] ??= { v: typeof init === 'function' ? (init as () => unknown)() : init })
    return [s.v, (n: unknown) => { s.v = typeof n === 'function' ? (n as (p: unknown) => unknown)(s.v) : n }]
  }
  const useCallback = (fn: unknown) => { rt.i++; return fn }
  const useEffect = () => { rt.i++ }
  const useSyncExternalStore = (_sub: unknown, snap: () => unknown) => { rt.i++; return snap() }
  const hooks = { useRef, useState, useCallback, useEffect, useSyncExternalStore }
  return { ...actual, ...hooks, default: { ...(actual.default ?? actual), ...hooks } }
})
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getAnthropicToken: async () => 'sk-ant-test-key',
}))
vi.mock('../src/renderer/claudeMode', async () => {
  const actual = await vi.importActual<any>('../src/renderer/claudeMode')
  return { ...actual, recordClaudeCost: vi.fn(actual.recordClaudeCost) }
})
vi.mock('../src/renderer/usage', async () => {
  const actual = await vi.importActual<any>('../src/renderer/usage')
  return { ...actual, recordUsage: vi.fn() }
})
vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) } } }),
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({ fetchUrlPage: async () => { throw new Error('このテストでは使わない') } }))

import { useAiChat, type ChatMessage } from '../src/renderer/hooks/useAiChat'
import { CLAUDE_CONSENT_VERSION_KEY, CLAUDE_CONSENT_VERSION, recordClaudeCost } from '../src/renderer/claudeMode'
import { recordUsage } from '../src/renderer/usage'
import { getClaudeSessionId, setClaudeSessionId } from '../src/renderer/claudeSession'
import { resetTurn, turnKey, updateTurn, getTurn, CHAT_APP_KEY } from '../src/renderer/chatTurnRegistry'
import { CLAUDE_OTHER_BUSY_NOTE, markClaudeTurnStarted, resetClaudeTurnForTest } from '../src/renderer/claudeTurn'
import type { ChatEvent } from '../src/shared/chatEvents'

const A = '/work/koto-turn-a'
const B = '/work/koto-turn-b'
const OTHER_TURN = 'ct-other-00000000'

let store: Map<string, string>
let ops: ChatEvent<ChatMessage>[]
/** 購読者の全員（本物の preload の ipcRenderer.on と同じ）。 */
let listeners: Set<(ev: any) => void>
/** chatStart が受け取った引数の一覧。 */
let startCalls: unknown[][]
/** chatStart の答え。 */
let startAnswer: { ok: boolean; busy?: boolean; message?: string }
const chatCancel = vi.fn()
const openPreviewResult = vi.fn()
const confirmFn = vi.fn(async () => true)
const externalFiles = vi.fn()

const flush = (ev: object) => { for (const l of [...listeners]) l(ev) }
const lastTurn = () => startCalls[startCalls.length - 1][startCalls[startCalls.length - 1].length - 1] as string

beforeEach(() => {
  resetClaudeTurnForTest()
  store = new Map()
  ops = []
  listeners = new Set()
  startCalls = []
  startAnswer = { ok: true }
  rt.slots = []
  rt.i = 0
  chatCancel.mockClear()
  openPreviewResult.mockClear()
  confirmFn.mockClear()
  externalFiles.mockClear()
  vi.mocked(recordClaudeCost).mockClear()
  vi.mocked(recordUsage).mockClear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.stubGlobal('window', {
    electronAPI: {
      win: { setBusy: () => {} },
      chatTurn: { start: async () => ({ ok: true }), abort: async () => {} },
      claude: {
        onStream: (cb: (ev: any) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
        chatCancel,
        openPreviewResult,
        chatStart: async (...args: unknown[]) => { startCalls.push(args); return startAnswer },
      },
    },
  })
  store.set(CLAUDE_CONSENT_VERSION_KEY, CLAUDE_CONSENT_VERSION)
})
afterEach(() => {
  for (const d of [A, B]) resetTurn(turnKey(d, 'x'))
  resetTurn(CHAT_APP_KEY)
  vi.unstubAllGlobals()
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))
async function waitUntil(cond: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (cond()) return; await tick() }
  throw new Error(`時間切れ: ${label}`)
}

function render(dir: string | null, extra: Record<string, unknown> = {}) {
  rt.i = 0
  return useAiChat({
    apiKey: 'sk-sakura-test', model: 'm', models: [{ id: 'm' }], maxRounds: 3,
    buildSystemPrompt: () => '',
    toolsProjectDir: dir, convDir: dir, sessionId: 'x',
    buildExecuteOpts: () => ({ writeMode: 'auto' }),
    getHistory: () => [],
    updateShown: () => {},
    onMessageEvent: (ev: ChatEvent<ChatMessage>) => { ops.push(ev) },
    onExternalFilesChanged: externalFiles,
    confirm: confirmFn,
    ...extra,
  } as any)
}
const appended = () => ops.filter(o => o.kind === 'append').map(o => (o as any).msg as ChatMessage)
const RESULT = (turn: string | undefined, costUsd = 0.5) => ({ kind: 'result', costUsd, durationMs: 1, isError: false, turn })

/** A の送信を始め、chatStart が呼ばれて購読が張られるまで待つ。 */
async function startSend(dir = A, text = '依頼です') {
  const chat = render(dir)
  const p = chat.send(text, [])
  await waitUntil(() => startCalls.length >= 1 && listeners.size >= 1, 'chatStart と購読')
  return { chat, p, turn: lastTurn() }
}

describe('自分の印の出来事は、今までどおり当たる', () => {
  it('session・text・tool・result: 吹き出し・費用1回・会話の番号の保存', async () => {
    const { p, turn } = await startSend()
    expect(turn).toMatch(/^ct-[a-z0-9]+-[a-z0-9]{8}$/)
    flush({ kind: 'session', sessionId: 'sess-new', turn })
    flush({ kind: 'text', text: '返事です', turn })
    flush({ kind: 'tool', name: 'Read', detail: 'a.html', turn })
    flush(RESULT(turn))
    await p
    expect(appended().some(m => m.role === 'assistant' && m.content === '返事です')).toBe(true)
    expect(appended().some(m => m.toolNote && /a\.html/.test(m.content))).toBe(true)
    expect(recordClaudeCost).toHaveBeenCalledTimes(1)
    expect(getClaudeSessionId(A)).toBe('sess-new')
    expect(listeners.size).toBe(0)
  })
})

describe('別の印・印の無い出来事は、何も起こさない', () => {
  const FOREIGN = (turn: string | undefined) => [
    { kind: 'session', sessionId: 'sess-foreign', turn },
    { kind: 'text', text: '別の回の本文', turn },
    { kind: 'tool', name: 'Read', detail: 'foreign.html', turn },
    { kind: 'result', costUsd: 9, durationMs: 1, isError: false, turn },
    { kind: 'error', message: '別の回の失敗', turn },
    { kind: 'delegated', model: 'm', promptTokens: 5, completionTokens: 5, turn },
    { kind: 'fileWritten', path: 'foreign.html', turn },
    { kind: 'openPreview', id: 'op1', path: 'index.html', projectDir: B, writeRoot: B, turn },
    { kind: 'writeCheck', text: '別の回の点検', marks: [], projectDir: A, turn },
    { kind: 'superseded', turn },
  ]
  for (const [name, foreignTurn] of [['別の印', OTHER_TURN], ['印の無い（古い形）', undefined]] as const) {
    it(`${name}: 全部の種類が、吹き出し・費用・使用量・番号・プレビュー・購読に触れない。そのあと自分の result で普通に終わる`, async () => {
      setClaudeSessionId(A, 'sess-a')
      const { p, turn } = await startSend()
      const bubbles = appended().length
      for (const ev of FOREIGN(foreignTurn)) flush(ev)
      await tick()
      expect(appended()).toHaveLength(bubbles)
      expect(recordClaudeCost).not.toHaveBeenCalled()
      expect(recordUsage).not.toHaveBeenCalled()
      expect(getClaudeSessionId(A)).toBe('sess-a')
      expect(openPreviewResult).not.toHaveBeenCalled()
      expect(externalFiles).not.toHaveBeenCalled()
      expect(listeners.size).toBe(1) // 購読は外れていない
      flush(RESULT(turn, 0.25))
      await p
      expect(recordClaudeCost).toHaveBeenCalledTimes(1)
      expect(vi.mocked(recordClaudeCost).mock.calls[0][0]).toBe(0.25)
      expect(listeners.size).toBe(0)
    })
  }
})

describe('2つの回を同時に生かす再現（直す前は、ほかの回の出来事が入っていた）', () => {
  it('A の送信を生かしたまま、B の印の text・session・result を流す → A の会話・費用・番号は変わらない', async () => {
    setClaudeSessionId(A, 'sess-a-old')
    const { p, turn } = await startSend(A)
    const before = appended().length
    flush({ kind: 'session', sessionId: 'sess-b-new', turn: 'ct-b-00000000' })
    flush({ kind: 'text', text: 'B の本文', turn: 'ct-b-00000000' })
    flush(RESULT('ct-b-00000000', 3))
    await tick()
    expect(appended()).toHaveLength(before)
    expect(recordClaudeCost).not.toHaveBeenCalled()
    expect(getClaudeSessionId(A)).toBe('sess-a-old')
    // B の result で A の「応答中」が消えない
    expect(getTurn(turnKey(A, 'x')).isLoading).toBe(true)
    flush(RESULT(turn))
    await p
    expect(getTurn(turnKey(A, 'x')).isLoading).toBe(false)
  })
})

describe('superseded・⏹・main の断り', () => {
  it('自分の印の superseded: 吹き出しも費用も出さずに終わり、購読を外す。応答中の印は下ろさない（同じプロジェクトの新しい回のものなので）', async () => {
    const { p, turn } = await startSend()
    const before = appended().length
    expect(getTurn(turnKey(A, 'x')).isLoading).toBe(true)
    flush({ kind: 'superseded', turn })
    await p
    expect(appended().length).toBe(before)
    expect(recordClaudeCost).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
    // 止められた古い回が、同じ鍵の応答中の印と ⏹ を消さない
    expect(getTurn(turnKey(A, 'x')).isLoading).toBe(true)
  })

  it('⏹: chatCancel が自分の印で呼ばれ、回は終わる', async () => {
    const { p, turn } = await startSend()
    getTurn(turnKey(A, 'x')).abort?.()
    await p
    expect(chatCancel).toHaveBeenCalledTimes(1)
    expect(chatCancel).toHaveBeenCalledWith(turn)
  })

  it('chatStart が busy → CLAUDE_OTHER_BUSY_NOTE の吹き出しが1つで終わる', async () => {
    startAnswer = { ok: false, busy: true }
    const chat = render(A)
    await chat.send('依頼です', [])
    expect(appended().filter(m => m.content === CLAUDE_OTHER_BUSY_NOTE)).toHaveLength(1)
    expect(listeners.size).toBe(0)
    expect(getTurn(turnKey(A, 'x')).isLoading).toBe(false)
  })

  it('chatStart が ok:false と message → 失敗の吹き出し（案内の文ではない）で終わる', async () => {
    startAnswer = { ok: false, message: '送信の印が不正です' }
    const chat = render(A)
    await chat.send('依頼です', [])
    expect(appended().filter(m => m.content === CLAUDE_OTHER_BUSY_NOTE)).toHaveLength(0)
    expect(JSON.stringify(appended())).toContain('送信の印が不正です')
    expect(listeners.size).toBe(0)
    expect(getTurn(turnKey(A, 'x')).isLoading).toBe(false)
  })
})

describe('send() の判断: ほかのプロジェクトが応答中なら Claude へ送らない', () => {
  it('ほかのプロジェクトで Claude の回が応答中 → 依頼の吹き出しなし・案内が1つ・chatStart も確認の窓も呼ばれない', async () => {
    store.delete(CLAUDE_CONSENT_VERSION_KEY) // 判断が同意の確認より前でなければ、confirm が呼ばれる
    markClaudeTurnStarted(B, 'other-turn')
    updateTurn(turnKey(B, 'x'), { isLoading: true })
    const chat = render(A)
    await chat.send('依頼です', [])
    expect(startCalls).toHaveLength(0)
    expect(confirmFn).not.toHaveBeenCalled()
    const msgs = appended()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'assistant', toolNote: true, content: CLAUDE_OTHER_BUSY_NOTE })
    expect(msgs.some(m => m.content === '依頼です')).toBe(false)
  })

  it('ほかのプロジェクトが応答中でも、Claude の回の印が無ければ（さくらのAI Engine の応答）送る', async () => {
    updateTurn(turnKey(B, 'x'), { isLoading: true })
    const chat = render(A)
    const p = chat.send('依頼です', [])
    await waitUntil(() => startCalls.length === 1, 'chatStart')
    flush(RESULT(lastTurn()))
    await p
    expect(appended().some(m => m.content === CLAUDE_OTHER_BUSY_NOTE)).toBe(false)
  })

  it('ほかのプロジェクトが応答中でなければ、ふつうに送る', async () => {
    const chat = render(A)
    const p = chat.send('依頼です', [])
    await waitUntil(() => startCalls.length === 1, 'chatStart')
    flush(RESULT(lastTurn()))
    await p
    expect(appended().some(m => m.content === CLAUDE_OTHER_BUSY_NOTE)).toBe(false)
  })

  it('単独チャットの鍵だけが実行中なら、送る', async () => {
    updateTurn(CHAT_APP_KEY, { isLoading: true })
    const chat = render(A)
    const p = chat.send('依頼です', [])
    await waitUntil(() => startCalls.length === 1, 'chatStart')
    flush(RESULT(lastTurn()))
    await p
    expect(startCalls).toHaveLength(1)
  })
})
