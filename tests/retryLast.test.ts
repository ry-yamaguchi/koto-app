// tests/retryLast.test.ts — 「もう一度送る」を押したときの送信（useAiChat.retryLast）。
// 本物の useAiChat を偽の React で動かし、chatStart へ渡った呼び出しの一覧を見る。
//  - 最後の失敗の前の依頼が、文も画像も同じ形で1回だけ送られる
//  - 送っている間の二重押しは無視される（押下中の印）
//  - 材料が無い会話では何も送らない

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const rt = vi.hoisted(() => ({
  slots: [] as any[],
  i: 0,
  effects: [] as Array<() => void | (() => void)>,
}))
vi.mock('react', async () => {
  const actual = await vi.importActual<any>('react')
  const useRef = (init: unknown) => { const s = (rt.slots[rt.i] ??= { current: init }); rt.i++; return s }
  const useState = (init: unknown) => {
    const idx = rt.i++
    const s = (rt.slots[idx] ??= { v: typeof init === 'function' ? (init as () => unknown)() : init })
    return [s.v, (n: unknown) => { s.v = typeof n === 'function' ? (n as (p: unknown) => unknown)(s.v) : n }]
  }
  const useCallback = (fn: unknown) => { rt.i++; return fn }
  const useEffect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const idx = rt.i++
    const prev = rt.slots[idx] as { deps?: unknown[] } | undefined
    const changed = !deps || !prev || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]))
    rt.slots[idx] = { deps }
    if (changed) rt.effects.push(fn)
  }
  const useSyncExternalStore = (_sub: unknown, snap: () => unknown) => { rt.i++; return snap() }
  const hooks = { useRef, useState, useCallback, useEffect, useSyncExternalStore }
  return { ...actual, ...hooks, default: { ...(actual.default ?? actual), ...hooks } }
})
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getAnthropicToken: async () => 'sk-ant-test-key',
}))

import { useAiChat } from '../src/renderer/hooks/useAiChat'
import { CLAUDE_CONSENT_KEY } from '../src/renderer/claudeMode'
import { resetTurn, turnKey } from '../src/renderer/chatTurnRegistry'

const PROJECT = '/work/retry-project'
const IMG = 'data:image/png;base64,AAAA'

let store: Map<string, string>
type ChatStartCall = { projectDir: string; text: string; images: string[] }
let chatStartCalls: ChatStartCall[]
let streamListener: ((ev: any) => void) | null
let holdStream: boolean

beforeEach(() => {
  store = new Map()
  chatStartCalls = []
  streamListener = null
  holdStream = false
  rt.slots = []
  rt.i = 0
  rt.effects = []
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.stubGlobal('window', {
    electronAPI: {
      win: { setBusy: () => {} },
      claude: {
        onStream: (cb: (ev: any) => void) => { streamListener = cb; return () => { if (streamListener === cb) streamListener = null } },
        chatCancel: () => {},
        chatStart: async (projectDir: string, _key: string, text: string, images: string[]) => {
          chatStartCalls.push({ projectDir, text, images })
          if (holdStream) return
          setTimeout(() => { streamListener?.({ kind: 'result', costUsd: 0, durationMs: 1, isError: false }) }, 0)
        },
      },
    },
  })
  store.set(CLAUDE_CONSENT_KEY, '1')
})
afterEach(() => {
  resetTurn(turnKey(PROJECT, 'x'))
  vi.unstubAllGlobals()
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))

function renderChat(history: any[]) {
  rt.i = 0
  rt.effects = []
  const result = useAiChat({
    apiKey: '',
    model: '', models: [], maxRounds: 5,
    buildSystemPrompt: () => '',
    toolsProjectDir: PROJECT, convDir: PROJECT, sessionId: 'x',
    buildExecuteOpts: () => ({ writeMode: 'auto' }),
    getHistory: () => history,
    updateShown: () => {},
    onMessageEvent: () => {},
    confirm: async () => true,
  } as any)
  for (const e of rt.effects) e()
  return result
}

const fail = { role: 'assistant', content: '⚠️ 失敗', offerRetry: true, toolNote: true }

describe('useAiChat.retryLast', () => {
  it('★★★ 最後の失敗の前の依頼が、文も画像もそのまま、1回だけ送られる', async () => {
    const chat = renderChat([
      { role: 'user', content: '前の依頼' }, { role: 'assistant', content: '前の返事' },
      { role: 'user', content: 'この絵で作って', images: [IMG] }, fail,
    ])
    await chat.retryLast()
    expect(chatStartCalls).toHaveLength(1)
    expect(chatStartCalls[0].projectDir).toBe(PROJECT)
    expect(chatStartCalls[0].text).toContain('この絵で作って')
    expect(chatStartCalls[0].text).not.toContain('前の依頼')
    expect(chatStartCalls[0].images).toEqual([IMG])
  })

  it('★★★ 送っている間の二重押しは無視される（1回だけ送る）', async () => {
    holdStream = true // 1回目の送信が終わらないまま、同じボタンがもう一度押される
    const chat = renderChat([{ role: 'user', content: '依頼' }, fail])
    void chat.retryLast()
    await tick()
    void chat.retryLast()
    await tick()
    expect(chatStartCalls).toHaveLength(1)
  })

  it('送り終えたあとは、また押せる（押下中の印が戻る）', async () => {
    const chat = renderChat([{ role: 'user', content: '依頼' }, fail])
    await chat.retryLast()
    await chat.retryLast()
    expect(chatStartCalls).toHaveLength(2)
  })

  it('材料が無い会話（失敗が無い・見える依頼が無い）では何も送らない', async () => {
    await renderChat([{ role: 'user', content: '依頼' }, { role: 'assistant', content: '返事' }]).retryLast()
    await renderChat([{ role: 'user', content: '内部', hidden: true }, fail]).retryLast()
    await renderChat([]).retryLast()
    expect(chatStartCalls).toHaveLength(0)
  })
})
