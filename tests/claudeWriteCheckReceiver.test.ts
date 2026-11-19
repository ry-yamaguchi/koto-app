// tests/claudeWriteCheckReceiver.test.ts — Claude のストリームで届いた writeCheck を、本物の useAiChat が
// 「その会話の ⚠️ の吹き出し」として当てる（toolNote・印つき）。result の前に届くので、受け取りはまだ続いている。
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
// 費用の記録の回数と額を数える（中身は本物のまま）
vi.mock('../src/renderer/claudeMode', async () => {
  const actual = await vi.importActual<any>('../src/renderer/claudeMode')
  return { ...actual, recordClaudeCost: vi.fn(actual.recordClaudeCost) }
})
vi.mock('../src/main/ipc/sakura', () => ({
  sakuraClient: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) } } }),
  isContextLimitError: () => false,
  safeMaxTokens: () => null,
}))
vi.mock('../src/main/ipc/web', () => ({ fetchUrlPage: async () => { throw new Error('このテストでは使わない') } }))

import { useAiChat, type ChatMessage } from '../src/renderer/hooks/useAiChat'
import { CLAUDE_CONSENT_VERSION_KEY, CLAUDE_CONSENT_VERSION, recordClaudeCost } from '../src/renderer/claudeMode'
import { resetTurn, turnKey } from '../src/renderer/chatTurnRegistry'
import type { ChatEvent } from '../src/shared/chatEvents'

const PROJECT = '/work/koto-write-check-receiver'

let store: Map<string, string>
let ops: ChatEvent<ChatMessage>[]
let streamListener: ((ev: any) => void) | null

beforeEach(() => {
  store = new Map()
  ops = []
  rt.slots = []
  rt.i = 0
  streamListener = null
  vi.mocked(recordClaudeCost).mockClear()
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
        onStream: (cb: (ev: any) => void) => { streamListener = cb; return () => { if (streamListener === cb) streamListener = null } },
        chatCancel: () => {},
      },
    },
  })
  store.set(CLAUDE_CONSENT_VERSION_KEY, CLAUDE_CONSENT_VERSION)
})
afterEach(() => {
  resetTurn(turnKey(PROJECT, 'x'))
  vi.unstubAllGlobals()
})

const NOTICE = '⚠️ public/app.js の1行目に、APIキーが直接書かれています（ghp_…・40文字）。公開すると、他の人に使われるおそれがあります。'
const MARKS = [{ file: 'public/app.js', kind: 'known-key', line: 1 }]

async function runTurn(events: unknown[]) {
  ;(window as any).electronAPI.claude.chatStart = vi.fn(async () => {
    for (const e of events) streamListener?.(e)
  })
  rt.i = 0
  const chat = useAiChat({
    apiKey: '', model: 'm', models: [{ id: 'm' }], maxRounds: 3,
    buildSystemPrompt: () => '',
    toolsProjectDir: PROJECT, convDir: PROJECT, sessionId: 'x',
    buildExecuteOpts: () => ({ writeMode: 'auto' }),
    getHistory: () => [],
    updateShown: () => {},
    onMessageEvent: (ev: ChatEvent<ChatMessage>) => { ops.push(ev) },
    confirm: async () => true,
  } as any)
  await chat.send('これを直して', [])
}

const appended = () => ops.filter(o => o.kind === 'append').map(o => (o as any).msg as ChatMessage)

describe('Claude のストリーム: writeCheck の受け取り', () => {
  it('★★★ writeCheck は toolNote の ⚠️ の吹き出し（印つき）になり、result より前に並ぶ。受け取りは result まで続く', async () => {
    await runTurn([
      { kind: 'session', sessionId: 's1' },
      { kind: 'text', text: '書きました' },
      { kind: 'writeCheck', text: NOTICE, marks: MARKS, projectDir: PROJECT },
      { kind: 'result', costUsd: 0.01, durationMs: 5, isError: false },
    ])
    const msgs = appended()
    const i = msgs.findIndex(m => m.writeFix)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(msgs[i]).toMatchObject({ role: 'assistant', toolNote: true, content: NOTICE, writeFix: MARKS })
    expect(msgs.filter(m => m.writeFix)).toHaveLength(1)
    expect(msgs[i - 1]).toMatchObject({ content: '書きました' })
  })

  it('★★★ ほかのプロジェクトの回の writeCheck は、この会話に入れない（掟11）', async () => {
    await runTurn([
      { kind: 'writeCheck', text: NOTICE, marks: MARKS, projectDir: '/work/another-project' },
      { kind: 'result', costUsd: 0.01, durationMs: 5, isError: false },
    ])
    expect(appended().filter(m => m.writeFix)).toEqual([])
    expect(appended().some(m => m.content === NOTICE)).toBe(false)
  })

  it('writeCheck が無ければ、印つきの吹き出しは出ない（対照）', async () => {
    await runTurn([{ kind: 'result', costUsd: 0.01, durationMs: 5, isError: false }])
    expect(appended().filter(m => m.writeFix)).toEqual([])
  })
})
