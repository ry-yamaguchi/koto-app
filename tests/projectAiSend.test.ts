// tests/projectAiSend.test.ts — 送る回の使う AI とモデルは、送った瞬間に1回だけ読んで固定する（掟11）。
//
// 本物の useAiChat を、偽の React（フックを呼び出し順の置き場で動かす最小の実装）・偽の localStorage・偽の window で動かし、
//   - 記憶（プロジェクトごと）→ 設定の既定の順で、Claude かさくらのAI Engine か・そのモデルが決まること
//   - 設定の既定（sakura_claude_mode など）を、「切り替えて続ける」が書き換えないこと
//   - 同意の窓・キーの読み込みを待つ間に記憶や既定が変わっても、その回は変わらないこと
// を、chatStart の引数・chatTurn.start の spec で確かめる。ソースの文字列は見ない。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const rt = vi.hoisted(() => ({
  slots: [] as any[],
  i: 0,
  /** getAnthropicToken の答え（Promise を返す関数。外から解けるようにできる）。 */
  token: (() => Promise.resolve(null)) as () => Promise<string | null>,
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
  getAnthropicToken: () => rt.token(),
}))

import { useAiChat } from '../src/renderer/hooks/useAiChat'
import { CLAUDE_CONSENT_VERSION_KEY, CLAUDE_CONSENT_VERSION, setClaudeMode } from '../src/renderer/claudeMode'
import { rememberProjectAi, readProjectAi } from '../src/renderer/projectAi'
import { resetTurn, turnKey } from '../src/renderer/chatTurnRegistry'

const A = '/work/project-a'
const B = '/work/project-b'

let store: Map<string, string>
/** chatStart の引数（呼ばれた順）。claudeModel は8番目（index 7）。 */
let chatStartArgs: unknown[][]
/** chatTurn.start の payload（呼ばれた順）。 */
let engineStarts: any[]
let streamListener: ((ev: any) => void) | null

beforeEach(() => {
  store = new Map()
  chatStartArgs = []
  engineStarts = []
  streamListener = null
  rt.slots = []
  rt.i = 0
  rt.token = () => Promise.resolve('sk-ant-test')
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.stubGlobal('window', {
    dispatchEvent: () => true,
    electronAPI: {
      win: { setBusy: () => {} },
      chatTurn: {
        start: async (payload: any) => { engineStarts.push(payload); return { ok: true } },
        abort: async () => {},
      },
      claude: {
        onStream: (cb: (ev: any) => void) => { streamListener = cb; return () => { if (streamListener === cb) streamListener = null } },
        chatCancel: () => {},
        chatStart: async (...args: unknown[]) => {
          chatStartArgs.push(args)
          const turn = args[args.length - 1] as string
          setTimeout(() => { streamListener?.({ kind: 'result', costUsd: 0, durationMs: 1, isError: false, turn }) }, 0)
          return { ok: true }
        },
      },
    },
  })
  // さくらの一覧の予備（キャッシュ）と、同意済み
  store.set('sakura_models_cache', JSON.stringify(['m', 'm2', 'm3']))
  store.set(CLAUDE_CONSENT_VERSION_KEY, CLAUDE_CONSENT_VERSION)
})
afterEach(() => {
  resetTurn(turnKey(A, 'x'))
  resetTurn(turnKey(B, 'x'))
  resetTurn(turnKey(null, 'x'))
  vi.unstubAllGlobals()
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))
async function waitUntil(cond: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (cond()) return; await tick() }
  throw new Error(`時間切れ: ${label}`)
}

function renderChat(o: { dir: string | null; apiKey?: string; model?: string; confirm?: () => Promise<boolean> }) {
  rt.i = 0
  return useAiChat({
    apiKey: o.apiKey ?? 'k',
    model: o.model ?? 'm', models: [{ id: 'm' }, { id: 'm2' }, { id: 'm3' }], maxRounds: 3,
    buildSystemPrompt: () => '',
    toolsProjectDir: o.dir, convDir: o.dir, sessionId: 'x',
    buildExecuteOpts: () => ({ writeMode: 'auto' }),
    getHistory: () => [],
    updateShown: () => {},
    onMessageEvent: () => {},
    confirm: o.confirm ?? (async () => true),
  } as any)
}

describe('送る回の使う AI とモデルは、そのプロジェクトの記憶 → 設定の既定で決まる', () => {
  it('T1: 記憶が Claude（モデル sonnet）・既定はオフ・両方のキー → Claude の経路で、そのモデルを chatStart へ渡す', async () => {
    store.set('sakura_claude_mode', 'off')
    rememberProjectAi(A, { brain: 'claude', claudeModel: 'claude-sonnet-5' })
    await renderChat({ dir: A }).send('こんにちは', [])
    expect(chatStartArgs).toHaveLength(1)
    expect(chatStartArgs[0][7]).toBe('claude-sonnet-5')
    expect(engineStarts).toHaveLength(0)
  })

  it('T2: 記憶がさくら（モデル m2）・既定はオン → AI Engine の経路で、spec.model は m2', async () => {
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'm2' })
    await renderChat({ dir: A }).send('こんにちは', [])
    expect(engineStarts).toHaveLength(1)
    expect(engineStarts[0].spec.model).toBe('m2')
    expect(chatStartArgs).toHaveLength(0)
  })

  it('T3: 別のプロジェクト B だけがさくらを覚えている → A（記憶なし・既定オン）は Claude の経路', async () => {
    rememberProjectAi(B, { brain: 'sakura' })
    await renderChat({ dir: A }).send('こんにちは', [])
    expect(chatStartArgs).toHaveLength(1)
    expect(engineStarts).toHaveLength(0)
  })

  it('T4: 記憶が Claude のとき「さくらのAI Engine に切り替えて続ける」→ A の記憶だけがさくらになり、設定の既定・B は変わらず、送り直しは AI Engine へ', async () => {
    rememberProjectAi(A, { brain: 'claude', claudeModel: 'claude-sonnet-5' })
    rememberProjectAi(B, { brain: 'claude' })
    const modeBefore = store.get('sakura_claude_mode') ?? null
    const bBefore = store.get('koto_project_ai:' + B)
    const chat = renderChat({ dir: A })
    chat.switchToAiEngineAndResend('続けて', [])
    await waitUntil(() => engineStarts.length === 1, 'AI Engine へ送り直す')
    expect(readProjectAi(A).brain).toBe('sakura')
    expect(readProjectAi(A).claudeModel).toBe('claude-sonnet-5') // モデルの記憶には触れない
    expect(store.get('sakura_claude_mode') ?? null).toBe(modeBefore)
    expect(store.get('koto_project_ai:' + B)).toBe(bBefore)
    expect(chatStartArgs).toHaveLength(0)
  })

  it('T5a: 同意の確認の窓を待つ間に、記憶のモデルと既定の AI を変えても、その回は最初に読んだモデルの Claude で送る', async () => {
    store.delete(CLAUDE_CONSENT_VERSION_KEY) // 同意はまだ
    rememberProjectAi(A, { brain: 'claude', claudeModel: 'claude-sonnet-5' })
    let answer!: (v: boolean) => void
    const confirmCalled = vi.fn()
    const confirm = () => new Promise<boolean>(r => { confirmCalled(); answer = r })
    const sent = renderChat({ dir: A, confirm }).send('こんにちは', [])
    await waitUntil(() => confirmCalled.mock.calls.length === 1, '同意の確認が出る')
    rememberProjectAi(A, { claudeModel: 'claude-haiku-4-5' })
    setClaudeMode(false)
    answer(true)
    await sent
    expect(chatStartArgs).toHaveLength(1)
    expect(chatStartArgs[0][7]).toBe('claude-sonnet-5')
    expect(engineStarts).toHaveLength(0)
  })

  it('T5b: キーを読み込む間に、さくらのモデルの記憶を m2 → m3 に変えても、その回の spec.model は m2', async () => {
    rememberProjectAi(A, { brain: 'sakura', sakuraModel: 'm2' })
    let release!: (v: string | null) => void
    rt.token = () => new Promise<string | null>(r => { release = r })
    const sent = renderChat({ dir: A }).send('こんにちは', [])
    await tick()
    rememberProjectAi(A, { sakuraModel: 'm3' })
    release(null)
    await sent
    expect(engineStarts).toHaveLength(1)
    expect(engineStarts[0].spec.model).toBe('m2')
  })

  it('T6: 記憶がさくら・さくらのキー無し・Claude のキー有り → 黙って Claude にせず、どちらにも送らない', async () => {
    rememberProjectAi(A, { brain: 'sakura' })
    await renderChat({ dir: A, apiKey: '' }).send('こんにちは', [])
    expect(chatStartArgs).toHaveLength(0)
    expect(engineStarts).toHaveLength(0)
  })

  it('T7: プロジェクトが無い（チャットモード）ときは、記憶を読まず、spec.model は引数の model', async () => {
    store.set('koto_project_ai:null', JSON.stringify({ v: 1, brain: 'claude', sakuraModel: 'm2' }))
    await renderChat({ dir: null, model: 'arg-model' }).send('こんにちは', [])
    expect(engineStarts).toHaveLength(1)
    expect(engineStarts[0].spec.model).toBe('arg-model')
    expect(chatStartArgs).toHaveLength(0)
  })
})
