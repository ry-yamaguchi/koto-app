// tests/claudeCostOnFailure.test.ts — Claude のターンが失敗で終わっても、費用は1回だけ記録され、失敗の吹き出しは1つ。
//
// 以前は main が「失敗の知らせ（error）→ 結果（result・費用つき）」の順で送り、画面は最初の error で受け取りをやめていたため、
// 失敗した回の費用が今月の利用額に入らなかった。SDK は失敗の回にも total_cost_usd を載せる（実測: 道具を1回使ったあとの失敗では
// 失敗の前に成功した往復の分が入る）。失敗の知らせは SDK が result のあとにも2つ（result 自身の errors・終了時の例外）出すので、
// 吹き出しが重なっていた。
//
// ここでは偽の SDK に実測と同じ形のメッセージを流し、startClaudeChat の出来事を本物の useAiChat（偽の React・偽の electronAPI）へ
// そのまま渡して、画面で起きることを数える（main の順序と画面の受け取りの両方が噛み合わないと落ちる）。
//   - 費用の記録（recordClaudeCost）: ちょうど1回・SDK が返した額
//   - 失敗の吹き出し: 1つ。「詳細:」に区分名と SDK の原文の両方。終了時の例外の文は出ない
//   - 認証・モデル不明でも、SDK の文は別の吹き出しにならず詳細へ入る
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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
import { startClaudeChat, type ClaudeSdkModule } from '../src/main/claude/agent'
import type { UiEvent } from '../src/main/claude/events'

const PROJECT = '/work/koto-cost-on-failure'
const COST = 0.00145

let store: Map<string, string>
let ops: ChatEvent<ChatMessage>[]
let streamListener: ((ev: any) => void) | null
let projectDir = ''
let delivered: UiEvent[]

beforeEach(() => {
  store = new Map()
  ops = []
  rt.slots = []
  rt.i = 0
  streamListener = null
  delivered = []
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-cost-fail-'))
  fs.mkdirSync(path.join(projectDir, 'public'), { recursive: true })
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
  fs.rmSync(projectDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

// ── SDK のメッセージ（実測と同じ形）──────────────────────────────────────────
type Script = () => AsyncGenerator<unknown>
const init = { type: 'system', subtype: 'init', session_id: 'sess-1' }
const retry = (n: number, error: string, status: number) => ({ type: 'system', subtype: 'api_retry', attempt: n, max_retries: 10, error_status: status, error })
const failedAssistant = (error: string, status: number, text: string) =>
  ({ type: 'assistant', error, api_error_status: status, message: { content: [{ type: 'text', text }] } })
const failedResult = (extra: Record<string, unknown> = {}) =>
  ({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', total_cost_usd: COST, duration_ms: 5, ...extra })
const readTool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/a.txt' } }] } }
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }
const thrownAfter = (text: string) => new Error(`Claude Code returned an error result: ${text}`)

interface Shape { name: string; script: Script; /** 詳細に入っているべき文（区分名・SDK の原文） */ detail: string[] }
const SHAPES: Shape[] = [
  {
    name: '401（認証の失敗が居座る）: api_retry → assistant(authentication_failed) → result → 例外',
    script: async function* () {
      yield init
      for (let n = 1; n <= 3; n++) yield retry(n, 'authentication_failed', 401)
      yield failedAssistant('authentication_failed', 401, 'Invalid API key · Fix external API key')
      yield failedResult()
      throw thrownAfter('Invalid API key · Fix external API key')
    },
    detail: ['authentication_failed', 'Invalid API key · Fix external API key'],
  },
  {
    name: '残高不足: assistant(billing_error) → result → 例外',
    script: async function* () {
      yield init
      yield failedAssistant('billing_error', 400, 'Credit balance is too low')
      yield failedResult()
      throw thrownAfter('Credit balance is too low')
    },
    detail: ['billing_error', 'Credit balance is too low'],
  },
  {
    name: '529（混み合いが居座る）: assistant(server_error・SDK の文) → result → 例外',
    script: async function* () {
      yield init
      yield failedAssistant('server_error', 529, 'API Error: Repeated 529 Overloaded errors. The API is at capacity')
      yield failedResult()
      throw thrownAfter('API Error: Repeated 529 Overloaded errors')
    },
    detail: ['Repeated 529 Overloaded errors'],
  },
  {
    name: '404（モデルが無い）: assistant(model_not_found) → result → 例外',
    script: async function* () {
      yield init
      yield failedAssistant('model_not_found', 404, "There's an issue with the selected model (claude-opus-5). It may not exist or you may not have access to it.")
      yield failedResult()
      throw thrownAfter("There's an issue with the selected model")
    },
    detail: ['model_not_found', "There's an issue with the selected model (claude-opus-5)"],
  },
  {
    name: '道具を1回使ったあとの失敗（Read → 401）',
    script: async function* () {
      yield init
      yield readTool
      yield toolResult
      yield failedAssistant('authentication_failed', 401, 'Invalid API key · Fix external API key')
      yield failedResult()
      throw thrownAfter('Invalid API key · Fix external API key')
    },
    detail: ['authentication_failed', 'Invalid API key · Fix external API key'],
  },
  {
    name: 'result だけが失敗（errors は文字列でない値の一覧）: 「エラー: 」だけにしない',
    script: async function* () {
      yield init
      yield failedResult({ subtype: 'error_during_execution', errors: [{ code: 1 }, 42, null] })
    },
    detail: ['error_during_execution'],
  },
  {
    name: '例外なしで終わる失敗（assistant → result だけ）',
    script: async function* () {
      yield init
      yield failedAssistant('rate_limit', 429, 'Rate limit reached')
      yield failedResult()
    },
    detail: ['rate_limit', 'Rate limit reached'],
  },
]

function makeSdk(script: Script) {
  return {
    query: () => script(),
    tool: (name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler }),
    createSdkMcpServer: (opts: any) => ({ type: 'sdk', name: opts.name, instance: {}, tools: opts.tools }),
  } as unknown as ClaudeSdkModule
}

/** 1ターン。startClaudeChat の出来事を、そのまま画面（useAiChat）の受け取りへ渡す。 */
async function runTurn(script: Script, resume: string | null = null) {
  ;(window as any).electronAPI.claude.chatStart = vi.fn(async () => {
    startClaudeChat({
      projectDir, writeRoot: path.join(projectDir, 'public'), apiKey: 'k', writeMode: 'auto', aiEngineKey: null,
      prompt: 'p', images: [], snapshotId: 's', resumeSessionId: resume, model: '',
      onEvent: e => { delivered.push(e); streamListener?.(e) },
      onOpenPreview: () => {}, ragBudgetCheck: () => ({ allowed: true }), onDelegated: () => {}, onFileWritten: () => {},
    }, makeSdk(script))
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
const failureBubbles = () => appended().filter(m => m.offerRetry)

describe('失敗した回: 費用は1回記録され、失敗の吹き出しは1つ', () => {
  for (const shape of SHAPES) {
    it(`★★★ ${shape.name}`, async () => {
      await runTurn(shape.script)

      // 費用: SDK が返した額を、ちょうど1回
      expect(vi.mocked(recordClaudeCost).mock.calls).toEqual([[COST]])
      // main の順序: 費用つきの結果が失敗の知らせより先。失敗の知らせは1つ
      const kinds = delivered.map(e => e.kind).filter(k => k === 'result' || k === 'error')
      expect(kinds).toEqual(['result', 'error'])
      expect(delivered.find(e => e.kind === 'result')).toMatchObject({ isError: true, costUsd: COST })
      // 画面: 失敗の吹き出しが1つ。詳細に区分名と SDK の原文の両方。終了時の例外の言い直しは出ない
      const bubbles = failureBubbles()
      expect(bubbles).toHaveLength(1)
      const shown = bubbles[0].content
      expect(shown).toContain('詳細: ')
      const detail = shown.slice(shown.lastIndexOf('詳細: '))
      for (const piece of shape.detail) expect(detail, piece).toContain(piece)
      expect(shown.trim()).not.toMatch(/エラー:\s*$/)
      expect(JSON.stringify(appended())).not.toContain('Claude Code returned an error result')
      // SDK の文が、別の吹き出し（text）として重ならない
      const textBubbles = appended().filter(m => m.role === 'assistant' && !m.toolNote && !m.offerRetry)
      expect(textBubbles).toEqual([])
    })
  }

  it('費用の行（利用額）は、失敗の吹き出しのあとに1つ出る', async () => {
    await runTurn(SHAPES[0].script)
    const all = appended().filter(m => m.role === 'assistant')
    const failureAt = all.findIndex(m => m.offerRetry)
    const footerAt = all.findIndex(m => m.content.includes('今回の利用額'))
    expect(failureAt).toBeGreaterThanOrEqual(0)
    expect(footerAt).toBeGreaterThan(failureAt)
    expect(all.filter(m => m.content.includes('今回の利用額'))).toHaveLength(1)
  })

  it('費用が 0 の失敗でも、記録は1回（0 を足す）・費用の行は出ない', async () => {
    await runTurn(async function* () {
      yield init
      yield failedAssistant('billing_error', 400, 'Credit balance is too low')
      yield failedResult({ total_cost_usd: 0 })
    })
    expect(vi.mocked(recordClaudeCost).mock.calls).toEqual([[0]])
    expect(failureBubbles()).toHaveLength(1)
    expect(appended().some(m => m.content.includes('今回の利用額'))).toBe(false)
  })

  it('resume を渡した回の失敗も同じ（費用1回・吹き出し1つ・例外の言い直しなし）', async () => {
    await runTurn(SHAPES[1].script, 'old-session')
    expect(vi.mocked(recordClaudeCost).mock.calls).toEqual([[COST]])
    expect(failureBubbles()).toHaveLength(1)
    expect(JSON.stringify(appended())).not.toContain('Claude Code returned an error result')
  })

  it('成功した回は今までどおり: 費用1回・失敗の吹き出しなし', async () => {
    await runTurn(async function* () {
      yield init
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'できました' }] } }
      yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: COST, duration_ms: 5 }
    })
    expect(vi.mocked(recordClaudeCost).mock.calls).toEqual([[COST]])
    expect(failureBubbles()).toEqual([])
  })

  it('結果が来ないまま例外で終わる回は、例外の文が1つだけ出る（費用は記録されない）', async () => {
    await runTurn(async function* () {
      yield init
      throw new Error('spawn failed (test)')
    })
    expect(vi.mocked(recordClaudeCost)).not.toHaveBeenCalled()
    expect(failureBubbles()).toHaveLength(1)
  })

  it('result が来ないまま assistant の error だけで終わる回も、失敗の知らせが1つ届く（保留した error を取りこぼさない）', async () => {
    await runTurn(async function* () {
      yield init
      yield failedAssistant('authentication_failed', 401, 'Invalid API key · Fix external API key')
    })
    expect(delivered.filter(e => e.kind === 'error')).toHaveLength(1)
    expect(delivered.some(e => e.kind === 'result')).toBe(false)
    const bubbles = failureBubbles()
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].content).toContain('authentication_failed')
  })

  it('assistant の error のあとに例外（result 無し）で終わる回も、失敗の知らせが1つ届く', async () => {
    await runTurn(async function* () {
      yield init
      yield failedAssistant('authentication_failed', 401, 'Invalid API key · Fix external API key')
      throw new Error('stream broke (test)')
    })
    expect(delivered.filter(e => e.kind === 'error').length).toBeGreaterThanOrEqual(1)
    const bubbles = failureBubbles()
    expect(bubbles.length).toBeGreaterThanOrEqual(1)
    expect(bubbles.map(b => b.content).join('\n')).toContain('authentication_failed')
  })

  it('秘密の形とホームの場所は、詳細に残らない', async () => {
    const secret = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-')
    await runTurn(async function* () {
      yield init
      yield failedAssistant('authentication_failed', 401, `Invalid API key ${secret} at /Users/someone/project`)
      yield failedResult()
    })
    const shown = failureBubbles()[0].content
    expect(shown).not.toContain(secret)
    expect(shown).not.toContain('/Users/someone')
  })
})
