// 画面側の失敗の吹き出し（useAiChat.ts）。書き主ごとに、吹き出しが1回だけ・印つきで出る。
//
//   A. 振る舞い: 本物の useAiChat を偽の React・偽の electronAPI で動かす。
//      A1. chatTurn.start が reject: 書き主は画面側なので、emit（ops を main へ送る）から出す。
//          依頼の吹き出しがまだ会話に無ければ、依頼→失敗の順（無いと「もう一度送る」が1つ前の依頼を指す）
//      A2. convDir がある会話で、chat:applied と chatTurn:event が同じ吹き出しを運んでも、画面は1つ
//      A3. Claude の失敗: 書き主は画面側（emit）。印が付く。請求で使えないときの案内には付かない
//      A4. ターン中に別のプロジェクトへ切り替わっても、書き換えは送信した瞬間の行き先（onMessageEvent）へ出る
//   B. 配線: 型2か所の印・呼び出しの形ごとの照合・直す前の形が戻らないこと

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ── 偽の React（フックを呼び出し順の置き場で動かす最小の実装）─────────────────
const rt = vi.hoisted(() => ({
  slots: [] as any[],
  i: 0,
  /** getAnthropicToken の答え。null なら AI Engine の道、値があれば Claude の道 */
  claudeToken: null as string | null,
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
  const useEffect = () => { rt.i++ }
  const useSyncExternalStore = (_sub: unknown, snap: () => unknown) => { rt.i++; return snap() }
  const hooks = { useRef, useState, useCallback, useEffect, useSyncExternalStore }
  return { ...actual, ...hooks, default: { ...(actual.default ?? actual), ...hooks } }
})
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getAnthropicToken: async () => rt.claudeToken,
}))

import { useAiChat, type ChatMessage } from '../src/renderer/hooks/useAiChat'
import { CLAUDE_CONSENT_KEY } from '../src/renderer/claudeMode'
import { getTurn, resetTurn, turnKey } from '../src/renderer/chatTurnRegistry'
import { applyToMessages, type ChatEvent } from '../src/shared/chatEvents'
import { failureBubbleOf, requestBubbleOf, UNEXPECTED_FAILURE_TEXT } from '../src/shared/chatFailure'

const ROOT = path.join(__dirname, '..')
const PROJECT = '/work/koto-project-a'

let store: Map<string, string>
/** onMessageEvent（ChatPanel・ChatApp では main へ ops を送る口）に届いた出来事 */
let ops: ChatEvent<ChatMessage>[]
/** 画面の吹き出し（updateShown が当たる先） */
let screen: ChatMessage[]
let startImpl: (payload: any, handlers: any) => Promise<any>
let streamListener: ((ev: any) => void) | null
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  store = new Map()
  ops = []
  screen = []
  rt.slots = []
  rt.i = 0
  rt.claudeToken = null
  streamListener = null
  startImpl = async () => ({ ok: true })
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.stubGlobal('window', {
    electronAPI: {
      win: { setBusy: () => {} },
      chatTurn: { start: (payload: any, handlers: any) => startImpl(payload, handlers), abort: async () => {} },
      claude: {
        onStream: (cb: (ev: any) => void) => { streamListener = cb; return () => { if (streamListener === cb) streamListener = null } },
        chatCancel: () => {},
      },
    },
  })
  store.set(CLAUDE_CONSENT_KEY, '1')
})
afterEach(() => {
  resetTurn(turnKey(PROJECT, 'x'))
  resetTurn(turnKey(null, 'x'))
  errorSpy.mockRestore()
  vi.unstubAllGlobals()
})

function render(over: {
  convDir?: string | null; toolsProjectDir?: string | null; apiKey?: string; errorPrefix?: string
  /** 書き換えの行き先（既定は ops）。ChatPanel では、その render のプロジェクトの会話へ書く口 */
  onMessageEvent?: (ev: ChatEvent<ChatMessage>) => void
} = {}) {
  rt.i = 0
  return useAiChat({
    apiKey: over.apiKey ?? 'k',
    model: 'm', models: [{ id: 'm' }], maxRounds: 3,
    buildSystemPrompt: () => '',
    toolsProjectDir: over.toolsProjectDir === undefined ? PROJECT : over.toolsProjectDir,
    convDir: over.convDir === undefined ? PROJECT : over.convDir,
    sessionId: 'x',
    errorPrefix: over.errorPrefix,
    buildExecuteOpts: () => ({ writeMode: 'auto' }),
    getHistory: () => [],
    updateShown: (fn: (p: ChatMessage[]) => ChatMessage[]) => { screen = fn(screen) },
    onMessageEvent: over.onMessageEvent ?? ((ev: ChatEvent<ChatMessage>) => { ops.push(ev) }),
    confirm: async () => true,
  } as any)
}

const bubbleOps = () => ops.filter(o => o.kind === 'append' || o.kind === 'replaceLast' || o.kind === 'removeLast')

// ── A1. chatTurn.start の reject ──────────────────────────────────────────
describe('A1. chatTurn.start が reject: 画面側の emit から、依頼（無ければ）→失敗の吹き出しを出す', () => {
  beforeEach(() => {
    startImpl = async () => { throw new Error("Error invoking remote method 'chatTurn:start': Error: IPC failed (test)") }
  })

  it('★ 届く前に失敗した回: ops は「依頼の吹き出し→失敗の吹き出し（印）」の2回。原文は出ない。send は投げ直さない', async () => {
    const chat = render()
    await expect(chat.send('こんにちは', [])).resolves.toBeUndefined()

    // 依頼の吹き出しは main が runEngineTurn の中で足す。届かなかった回は会話に無いので、ここで足す
    // （無いと、会話は [前の依頼, 前の返事, 失敗] になり、「もう一度送る」が1つ前の依頼を指す）
    expect(ops).toHaveLength(2)
    expect(ops[0]).toStrictEqual({ kind: 'append', msg: requestBubbleOf('こんにちは', []) })
    expect(ops[1]).toMatchObject({ kind: 'append', msg: { role: 'assistant', content: UNEXPECTED_FAILURE_TEXT, offerRetry: true } })
    expect(bubbleOps().filter(o => o.kind === 'append' && (o.msg as ChatMessage).offerRetry)).toHaveLength(1)
    expect(JSON.stringify(ops)).not.toContain('Error invoking remote method')
    // 画面へ直接は当てない（画面へは main が chat:applied で届ける）
    expect(screen).toEqual([])
    // ⚠️ が立ち、実行中は終わっている
    const t = getTurn(turnKey(PROJECT, 'x'))
    expect(t.attention).toBe('error')
    expect(t.isLoading).toBe(false)
    // 原文はログに残る
    expect(errorSpy.mock.calls.some(c => String(c[0]).includes('chatTurn.start'))).toBe(true)
  })

  it('画像だけの送信: 依頼の吹き出しは既定の文と画像を持つ（送信の入口と同じ規則）', async () => {
    const chat = render()
    await chat.send('  ', ['data:image/png;base64,xxx'])
    expect(ops[0]).toStrictEqual({ kind: 'append', msg: requestBubbleOf('', ['data:image/png;base64,xxx']) })
    expect((ops[0] as any).msg).toMatchObject({ role: 'user', content: 'この画像について教えてください。', images: ['data:image/png;base64,xxx'] })
    expect(ops).toHaveLength(2)
  })

  it('★ main が依頼の吹き出しを届けたあとで reject: 依頼は足さない（2つにならない）。失敗の吹き出しだけ足す', async () => {
    startImpl = async (_p, handlers) => {
      handlers.onEvent({ kind: 'append', msg: { role: 'user', content: 'こんにちは' } })
      throw new Error('IPC failed after the request was recorded (test)')
    }
    const chat = render()
    await chat.send('こんにちは', [])
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ kind: 'append', msg: { role: 'assistant', offerRetry: true } })
  })

  it('★ main が失敗の吹き出しまで届けたあとで reject: 2つ目を足さない（⚠️ だけ立てる）', async () => {
    startImpl = async (_p, handlers) => {
      handlers.onEvent({ kind: 'append', msg: { role: 'user', content: 'こんにちは' } })
      handlers.onEvent({ kind: 'append', msg: failureBubbleOf('失敗しました') })
      throw new Error('IPC failed after the failure was recorded (test)')
    }
    const chat = render()
    await chat.send('こんにちは', [])
    expect(ops).toEqual([])
    expect(getTurn(turnKey(PROJECT, 'x')).attention).toBe('error')
  })

  it('単独チャット（⚠️ の接頭辞）でも同じ形。convDir が無くても依頼と失敗は emit から', async () => {
    const chat = render({ errorPrefix: '⚠️ ', convDir: null, toolsProjectDir: null })
    await chat.send('こんにちは', [])
    expect(ops).toHaveLength(2)
    expect(ops[0]).toMatchObject({ kind: 'append', msg: { role: 'user', content: 'こんにちは' } })
    expect(ops[1]).toMatchObject({ kind: 'append', msg: { content: `⚠️ ${UNEXPECTED_FAILURE_TEXT}`, offerRetry: true } })
  })

  it('正常に終わった回・結末がエラーの回では、この吹き出しを足さない', async () => {
    startImpl = async () => ({ ok: true, endedWithError: true })
    const chat = render()
    await chat.send('こんにちは', [])
    expect(bubbleOps()).toEqual([])
    expect(getTurn(turnKey(PROJECT, 'x')).attention).toBe('error')
  })
})

// ── A2. chat:applied と chatTurn:event が同じ吹き出しを運ぶ ───────────────
describe('A2. convDir がある会話: main が書き主。chat:applied と chatTurn:event の両方が届いても画面は1つ', () => {
  /** chat:applied を受けた ChatPanel が画面へ当てること（applyToMessages で畳む）。 */
  const applied = (op: ChatEvent<ChatMessage>) => { screen = applyToMessages(screen, op) }

  it('★ convDir がある: chatTurn:event の吹き出しは捨てられ、画面は chat:applied の1つだけ', async () => {
    startImpl = async (_p, handlers) => {
      const bubble = failureBubbleOf('失敗しました')
      applied({ kind: 'append', msg: bubble })
      handlers.onEvent({ kind: 'append', msg: bubble })
      handlers.onEvent({ kind: 'attention', value: 'error' })
      return { ok: true, endedWithError: true }
    }
    const chat = render({ convDir: PROJECT })
    await chat.send('こんにちは', [])
    expect(screen).toHaveLength(1)
    expect(screen[0].offerRetry).toBe(true)
    // main が書き主なので、画面側から ops は1つも送らない（二重書きにならない）
    expect(ops).toEqual([])
  })

  it('convDir が無い異常系: chat:applied は届かないので、chatTurn:event の吹き出しが唯一の道（画面は1つ）', async () => {
    startImpl = async (_p, handlers) => {
      handlers.onEvent({ kind: 'append', msg: failureBubbleOf('失敗しました') })
      return { ok: true, endedWithError: true }
    }
    const chat = render({ convDir: null, toolsProjectDir: null })
    await chat.send('こんにちは', [])
    expect(screen).toHaveLength(1)
    expect(screen[0].offerRetry).toBe(true)
    expect(ops).toEqual([])
  })
})

// ── A3. Claude の失敗 ─────────────────────────────────────────────────────
describe('A3. Claude の失敗: 書き主は画面側。印は失敗の吹き出しだけに付く', () => {
  async function sendWithClaudeError(message: string, apiKey: string) {
    rt.claudeToken = 'sk-ant-test-key'
    const chatStart = vi.fn(async () => {
      setTimeout(() => { streamListener?.({ kind: 'error', message }) }, 0)
    })
    ;(window as any).electronAPI.claude.chatStart = chatStart
    const chat = render({ apiKey })
    // finish() は error の後に呼ばれて send が戻る
    await chat.send('これを直して', [])
    return chatStart
  }

  it('★ 通常の失敗: 失敗の吹き出しが1つ・印が1つ（emit から）。⚠️ も立つ', async () => {
    await sendWithClaudeError('Claude が正常に動きませんでした (test)', '')
    const appended = ops.filter(o => o.kind === 'append').map(o => (o as any).msg as ChatMessage)
    // 最初はユーザーの吹き出し、次が失敗の吹き出し
    expect(appended.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(appended.filter(m => m.offerRetry)).toHaveLength(1)
    expect(appended[1].offerRetry).toBe(true)
    expect(getTurn(turnKey(PROJECT, 'x')).attention).toBe('error')
  })

  it('請求で Claude が使えない（切替ボタンのある案内）には、印を付けない', async () => {
    await sendWithClaudeError('402 billing: credit balance is too low (test)', 'sakura-key')
    const appended = ops.filter(o => o.kind === 'append').map(o => (o as any).msg as ChatMessage)
    const guide = appended.find(m => m.offerAiEngineFallback)
    expect(guide).toBeDefined()
    expect(appended.some(m => m.offerRetry)).toBe(false)
  })
})

// ── A4. ターン中にプロジェクトが切り替わる ─────────────────────────────────
describe('A4. 書き換えの行き先は送信した瞬間のもの（切り替え先の会話に書かない・掟11）', () => {
  it('★ start の reject: 送信後に別のプロジェクトの render が作られても、依頼と失敗は送信した瞬間の onMessageEvent へ出る', async () => {
    const toA: ChatEvent<ChatMessage>[] = []
    const toB: ChatEvent<ChatMessage>[] = []
    startImpl = async () => {
      // 送信後に利用者が別のプロジェクト B を開いた（B の render ＝ 別の onMessageEvent）
      render({ toolsProjectDir: '/work/koto-project-b', convDir: '/work/koto-project-b', onMessageEvent: ev => { toB.push(ev) } })
      throw new Error('IPC failed (test)')
    }
    const chatA = render({ onMessageEvent: ev => { toA.push(ev) } })
    await chatA.send('こんにちは', [])
    expect(toA.map(o => o.kind)).toEqual(['append', 'append'])
    expect(toA.filter(o => (o as any).msg?.offerRetry)).toHaveLength(1)
    expect(toB).toEqual([])
    resetTurn(turnKey('/work/koto-project-b', 'x'))
  })

  it('★ Claude の失敗: 応答の途中で別のプロジェクトの render が作られても、失敗の吹き出しは送信した瞬間の行き先へ出る', async () => {
    rt.claudeToken = 'sk-ant-test-key'
    const toA: ChatEvent<ChatMessage>[] = []
    const toB: ChatEvent<ChatMessage>[] = []
    ;(window as any).electronAPI.claude.chatStart = vi.fn(async () => {
      setTimeout(() => {
        render({ toolsProjectDir: '/work/koto-project-b', convDir: '/work/koto-project-b', onMessageEvent: ev => { toB.push(ev) } })
        streamListener?.({ kind: 'error', message: 'Claude が正常に動きませんでした (test)' })
      }, 0)
    })
    const chatA = render({ onMessageEvent: ev => { toA.push(ev) } })
    await chatA.send('これを直して', [])
    expect(toA.filter(o => (o as any).msg?.offerRetry)).toHaveLength(1)
    expect(toB).toEqual([])
    resetTurn(turnKey('/work/koto-project-b', 'x'))
  })
})

// ── B. 配線 ───────────────────────────────────────────────────────────────
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => { const t = line.trim(); return !t.startsWith('//') && !t.startsWith('*') })
    .join('\n')

function typeBlock(code: string, name: string): string {
  const start = code.indexOf(`export type ${name} = {`)
  expect(start, `${name} の宣言`).toBeGreaterThanOrEqual(0)
  return code.slice(start, code.indexOf('\n}\n', start))
}

describe('B. 配線（useAiChat.ts）', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')

  it('吹き出しの型2か所（ChatMessage・TurnMessage）に offerRetry?: true がある', () => {
    expect(typeBlock(src, 'ChatMessage')).toContain('offerRetry?: true')
    expect(typeBlock(readCode('src/shared/chatTurn.ts'), 'TurnMessage')).toContain('offerRetry?: true')
  })

  it('Claude の失敗は failureBubbleOf を通る（呼び出しの形ごと）。直す前の手組みは戻らない', () => {
    expect(src).toContain('appendBubble(failureBubbleOf(errorPrefix + formatClaudeError(rawMessage)))')
    expect(src).not.toContain("appendBubble({ role: 'assistant', content: errorPrefix + formatClaudeError(rawMessage) })")
    // 切替ボタンのある案内は、そのまま（印を付けない）
    const at = src.indexOf('offerAiEngineFallback: { text, images },')
    expect(at).toBeGreaterThan(-1)
    const around = src.slice(src.lastIndexOf('appendBubble({', at), at + 40)
    expect(around).not.toContain('failureBubbleOf')
  })

  it('chatTurn.start の catch は emit で、足りない吹き出し（依頼→失敗）と ⚠️ を出す。viewOnlyEmit は使わない', () => {
    const startAt = src.indexOf('await window.electronAPI.chatTurn.start(')
    const catchAt = src.indexOf('} catch (e) {', startAt)
    const finallyAt = src.indexOf('} finally {', catchAt)
    expect(startAt).toBeGreaterThan(-1)
    expect(catchAt).toBeGreaterThan(startAt)
    expect(finallyAt).toBeGreaterThan(catchAt)
    const body = src.slice(catchAt, finallyAt)
    expect(body.split('for (const ev of unexpectedFailureAppends({ rawText, images, errorPrefix, written })) emit(ev)')).toHaveLength(2)
    expect(body.split("emit({ kind: 'attention', value: 'error' })")).toHaveLength(2)
    expect(body).not.toContain('viewOnlyEmit')
    expect(body).not.toContain('updateShown(')
    expect(body).not.toMatch(/\bthrow\b/)
    // 吹き出しを手で組む形・直す前の形（失敗の吹き出しだけを足す）は無い
    expect(body).not.toContain('unexpectedFailureBubble(')
    expect(body).not.toContain("role: 'user'")
    // 吹き出しを viewOnlyEmit で出す形は、どこにも無い
    expect(src).not.toContain("viewOnlyEmit({ kind: 'append'")
  })

  it('届いた出来事を数える: start の onEvent は noteWritten で数えてから viewOnlyEmit へ渡す（数える印は start の前に作る）', () => {
    const startAt = src.indexOf('await window.electronAPI.chatTurn.start(')
    const writtenAt = src.indexOf('const written: WrittenState = { request: false, failure: false }')
    expect(writtenAt).toBeGreaterThan(-1)
    expect(writtenAt).toBeLessThan(startAt)
    expect(src).toContain('onEvent: (ev) => { noteWritten(written, ev as any); viewOnlyEmit(ev as any) },')
    expect(src.split('noteWritten(')).toHaveLength(2)
  })

  it('import している。失敗の文は chatFailure.ts だけに書く。依頼の文の規則は requestTextOf の1つ', () => {
    expect(src).toContain("import { failureBubbleOf, noteWritten, requestBubbleOf, requestTextOf, unexpectedFailureAppends, type WrittenState } from '../../shared/chatFailure'")
    expect(src).not.toContain('Koto の内部で問題が起きました')
    expect(src.split('requestTextOf(')).toHaveLength(3)
    expect(src).not.toContain('この画像について教えてください')
  })

  it('viewOnlyEmit の message系は convDir が無いときだけ当てる（無条件に当てる形へ戻さない）', () => {
    const start = src.indexOf('const viewOnlyEmit = useCallback(')
    const m = /\n {2}\}, \[[^\]]*\]\)/.exec(src.slice(start))
    expect(start).toBeGreaterThan(-1)
    expect(m).not.toBeNull()
    const block = src.slice(start, start + m!.index + m![0].length)
    expect(block).toContain('if (!convDir) updateShown(prev => applyToMessages(prev, ev))')
  })
})
