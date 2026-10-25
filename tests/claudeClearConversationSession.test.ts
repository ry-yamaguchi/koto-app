// tests/claudeClearConversationSession.test.ts — 「🗑 会話をクリア」で、そのプロジェクトの Claude の覚えた会話の番号も忘れる。
//
// 実機（2026-10-24・rc.1）: 画面の会話を消すだけで、localStorage の 'sakura_claude_session:<projectDir>' が残っていた。
// 保存されていない会話の番号が残ると、以後の依頼が毎回 resume でその番号を渡して「No conversation found」で止まる
// （「会話をクリア」でも直らない）。直しは useAiChat.ts の forgetClaudeSession（掟7: チャットの状態はこのフックが持つ）を、
// ChatPanel の clear が確定したときだけ呼ぶ形。
//
// ここでは
//   1. 本物の useAiChat を、偽の React（フックを呼び出し順の置き場で動かす最小の実装）で動かし、
//      forgetClaudeSession のあとの chatStart の resumeSessionId が null になること・保存も消えることを確かめる
//   2. ChatPanel が clear に渡す関数（confirmedActions.ts の clearConversationAction）を runClearConversation に通し、
//      確定したときだけ「画面の会話を消す」と「番号を忘れる」の両方が呼ばれ、キャンセルでは両方とも呼ばれないことを確かめる
//   3. ターンの途中で別のプロジェクトへ切り替えたあとに、前のプロジェクトのターンの session が届いても、
//      切り替え先の次の chatStart には渡らない（共有の claudeSessionRef を前のプロジェクトの番号で上書きしない。掟11）
// ソースの文字列は見ない。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ── 偽の React ─────────────────────────────────────────────────────────────
// フックは呼び出し順（スロット）で状態を持つ。effect は render の後でまとめて実行する。
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
  // effect は本物の React と同じく、依存配列が変わったときだけ走らせる（描画のたびに走らせると、
  // 「プロジェクトが変わったら保存済みの番号を読み直す」effect が、忘れた直後の再描画でも走ってしまい、
  // メモリ上の番号を消し忘れても気づけない）。
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
// 認証情報の取り出しだけ偽物（画面の部品は読み込まない）。
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getAnthropicToken: async () => 'sk-ant-test-key',
}))

import { useAiChat } from '../src/renderer/hooks/useAiChat'
import { getClaudeSessionId, setClaudeSessionId } from '../src/renderer/claudeSession'
import { CLAUDE_CONSENT_KEY } from '../src/renderer/claudeMode'
import { runClearConversation, clearConversationAction } from '../src/renderer/confirmedActions'
import { resetTurn, turnKey } from '../src/renderer/chatTurnRegistry'

const PROJECT = '/Users/test/koto-project-a'
const OTHER_PROJECT = '/Users/test/koto-project-b'

// ── 偽の localStorage・window.electronAPI ───────────────────────────────────
let store: Map<string, string>
type ChatStartCall = { projectDir: string; resumeSessionId: string | null }
let chatStartCalls: ChatStartCall[]
let streamListener: ((ev: any) => void) | null
/** 次の chatStart が SDK から受け取る session（無ければ出さない）。 */
let nextSessionFromSdk: string | null
/** true のあいだ、chatStart は出来事を流さない（テストが streamListener へ自分で流す）。 */
let holdStream: boolean

beforeEach(() => {
  store = new Map()
  chatStartCalls = []
  streamListener = null
  nextSessionFromSdk = null
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
        // 解除は自分の登録のときだけ（別のターンが登録し直したあとの古いターンの解除で、新しい登録を消さない）
        onStream: (cb: (ev: any) => void) => { streamListener = cb; return () => { if (streamListener === cb) streamListener = null } },
        chatCancel: () => {},
        chatStart: async (projectDir: string, _key: string, _text: string, _images: string[], _snapshotId: string, resumeSessionId: string | null) => {
          chatStartCalls.push({ projectDir, resumeSessionId })
          if (holdStream) return
          // 実物と同じく、出来事は chatStart の呼び出しのあとで流れてくる（session → result）
          setTimeout(() => {
            if (nextSessionFromSdk) streamListener?.({ kind: 'session', sessionId: nextSessionFromSdk })
            streamListener?.({ kind: 'result', costUsd: 0, durationMs: 1, isError: false })
          }, 0)
        },
      },
    },
  })
  // Claude モードは既定でオン。同意の確認ダイアログを出さずに済むよう、同意済みにしておく。
  store.set(CLAUDE_CONSENT_KEY, '1')
})
afterEach(() => {
  resetTurn(turnKey(PROJECT, 'x'))
  resetTurn(turnKey(OTHER_PROJECT, 'x'))
  vi.unstubAllGlobals()
})

const tick = () => new Promise<void>(r => setTimeout(r, 0))
async function waitUntil(cond: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (cond()) return; await tick() }
  throw new Error(`時間切れ: ${label}`)
}

/** useAiChat を1回描画する（フックの返り値＝その render の send / forgetClaudeSession）。effect も実行する。 */
function renderChat(toolsProjectDir: string | null) {
  rt.i = 0
  rt.effects = []
  const result = useAiChat({
    apiKey: '', // さくらのAI Engine のキーなし＝Claude だけのモード
    model: '', models: [], maxRounds: 5,
    buildSystemPrompt: () => '',
    toolsProjectDir, convDir: toolsProjectDir, sessionId: 'x',
    buildExecuteOpts: () => ({ writeMode: 'auto' }),
    getHistory: () => [],
    updateShown: () => {},
    onMessageEvent: () => {},
    confirm: async () => true,
  } as any)
  for (const e of rt.effects) e()
  return result
}

describe('useAiChat.forgetClaudeSession: 覚えた会話の番号を忘れ、次の chatStart は新しい会話で始まる', () => {
  it('前提（対照）: 保存済みの番号があれば、次の依頼はその番号で resume する', async () => {
    setClaudeSessionId(PROJECT, 'sess-old')
    const chat = renderChat(PROJECT)
    await chat.send('こんにちは', [])
    expect(chatStartCalls).toHaveLength(1)
    expect(chatStartCalls[0].resumeSessionId).toBe('sess-old')
  })

  it('★★★ 忘れたあとは、保存も消え、次の chatStart の resumeSessionId は null', async () => {
    setClaudeSessionId(PROJECT, 'sess-old')
    const chat = renderChat(PROJECT)
    chat.forgetClaudeSession()
    expect(getClaudeSessionId(PROJECT)).toBeNull()
    const again = renderChat(PROJECT)
    await again.send('こんにちは', [])
    expect(chatStartCalls).toHaveLength(1)
    expect(chatStartCalls[0].resumeSessionId).toBeNull()
  })

  it('★★★ 依頼のあとに SDK が新しい番号を出しても、忘れれば次は null（メモリ上の番号も消える）', async () => {
    setClaudeSessionId(PROJECT, 'sess-old')
    nextSessionFromSdk = 'sess-new'
    const chat = renderChat(PROJECT)
    await chat.send('1回目', [])
    expect(chatStartCalls[0].resumeSessionId).toBe('sess-old')
    expect(getClaudeSessionId(PROJECT)).toBe('sess-new') // 新しい番号は今までどおり覚える

    chat.forgetClaudeSession()
    expect(getClaudeSessionId(PROJECT)).toBeNull()

    nextSessionFromSdk = null
    const again = renderChat(PROJECT)
    await again.send('2回目', [])
    expect(chatStartCalls[1].resumeSessionId).toBeNull() // 番号を保存からではなく、メモリ上の ref から使い回していないこと
  })

  it('★★ 忘れるのはそのプロジェクトだけ（ほかのプロジェクトの番号は残る）', () => {
    setClaudeSessionId(PROJECT, 'sess-a')
    setClaudeSessionId(OTHER_PROJECT, 'sess-b')
    renderChat(PROJECT).forgetClaudeSession()
    expect(getClaudeSessionId(PROJECT)).toBeNull()
    expect(getClaudeSessionId(OTHER_PROJECT)).toBe('sess-b')
  })

  it('★★ 確認の窓の間に別のプロジェクトへ切り替わっていたら、切り替え先の番号は消さない（掟11）', async () => {
    setClaudeSessionId(PROJECT, 'sess-a')
    setClaudeSessionId(OTHER_PROJECT, 'sess-b')
    const forgetA = renderChat(PROJECT).forgetClaudeSession
    renderChat(OTHER_PROJECT)
    forgetA()
    expect(getClaudeSessionId(PROJECT)).toBeNull()
    expect(getClaudeSessionId(OTHER_PROJECT)).toBe('sess-b')
    await renderChat(OTHER_PROJECT).send('B の依頼', [])
    expect(chatStartCalls[chatStartCalls.length - 1].resumeSessionId).toBe('sess-b')
  })

  it('単独チャット（toolsProjectDir=null）で呼んでも何も壊さない（保存には触れない）', () => {
    setClaudeSessionId(PROJECT, 'sess-a')
    expect(() => renderChat(null).forgetClaudeSession()).not.toThrow()
    expect(getClaudeSessionId(PROJECT)).toBe('sess-a')
  })
})

describe('「🗑 会話をクリア」の確定: 画面の会話を消すのと、番号を忘れるのは一緒に起き、キャンセルでは両方とも起きない', () => {
  it('★★★ 確定したとき: 会話を消す・番号を忘れる の両方が呼ばれる（実物のフックで、保存も消える）', async () => {
    setClaudeSessionId(PROJECT, 'sess-old')
    const chat = renderChat(PROJECT)
    const clearMessages = vi.fn()
    const outcome = await runClearConversation('この操作は元に戻せません。よろしいですか？', {
      confirm: async () => true,
      clear: clearConversationAction({ clearMessages, forgetClaudeSession: chat.forgetClaudeSession }),
    })
    expect(outcome).toEqual({ cancelled: false, result: undefined })
    expect(clearMessages).toHaveBeenCalledTimes(1)
    expect(getClaudeSessionId(PROJECT)).toBeNull()
    // そのまま次の依頼を送ると、新しい会話で始まる
    const again = renderChat(PROJECT)
    await again.send('こんにちは', [])
    expect(chatStartCalls[0].resumeSessionId).toBeNull()
  })

  it('★★★ キャンセルしたとき: どちらも呼ばれない（会話も、覚えた番号も残る）', async () => {
    setClaudeSessionId(PROJECT, 'sess-old')
    const chat = renderChat(PROJECT)
    const clearMessages = vi.fn()
    const outcome = await runClearConversation('この操作は元に戻せません。よろしいですか？', {
      confirm: async () => false,
      clear: clearConversationAction({ clearMessages, forgetClaudeSession: chat.forgetClaudeSession }),
    })
    expect(outcome).toEqual({ cancelled: true })
    expect(clearMessages).not.toHaveBeenCalled()
    expect(getClaudeSessionId(PROJECT)).toBe('sess-old')
    const again = renderChat(PROJECT)
    await again.send('こんにちは', [])
    expect(chatStartCalls[0].resumeSessionId).toBe('sess-old')
  })

  it('clearConversationAction: 会話を消す→番号を忘れる の順に、1回ずつ呼ぶ', () => {
    const order: string[] = []
    clearConversationAction({ clearMessages: () => order.push('messages'), forgetClaudeSession: () => order.push('session') })()
    expect(order).toEqual(['messages', 'session'])
  })
})

describe('別のプロジェクトのターンの session は、いま見ているプロジェクトの番号にならない（掟11）', () => {
  const RESULT = { kind: 'result', costUsd: 0, durationMs: 1, isError: false }

  it('対照: 同じプロジェクトのままなら、届いた session が次の chatStart の resumeSessionId になる', async () => {
    setClaudeSessionId(PROJECT, 'sess-a-old')
    nextSessionFromSdk = 'sess-a-new'
    const chat = renderChat(PROJECT)
    await chat.send('1回目', [])
    expect(chatStartCalls[0].resumeSessionId).toBe('sess-a-old')
    nextSessionFromSdk = null
    await renderChat(PROJECT).send('2回目', [])
    expect(chatStartCalls[1].resumeSessionId).toBe('sess-a-new')
  })

  it('★★★ A のターンの途中で B へ切り替え、そのあと A の session が届く → B の次の chatStart は B の保存値のまま・A の保存値は新しい番号', async () => {
    setClaudeSessionId(PROJECT, 'sess-a-old')
    setClaudeSessionId(OTHER_PROJECT, 'sess-b')
    holdStream = true
    const chatA = renderChat(PROJECT)
    const sendA = chatA.send('A の依頼', [])
    await waitUntil(() => chatStartCalls.length === 1, 'A の chatStart が呼ばれる')
    expect(chatStartCalls[0]).toEqual({ projectDir: PROJECT, resumeSessionId: 'sess-a-old' })
    const listenerA = streamListener!
    expect(listenerA).toBeTruthy()

    // B へ切り替える（props が変わり、effect が回る）
    const chatB = renderChat(OTHER_PROJECT)
    // A のターンに、遅れて session が届く
    listenerA({ kind: 'session', sessionId: 'sess-a-new' })
    // A の保存値は新しい番号になり、B の保存値は触られない
    expect(getClaudeSessionId(PROJECT)).toBe('sess-a-new')
    expect(getClaudeSessionId(OTHER_PROJECT)).toBe('sess-b')

    // B で送ると、B の保存値で resume する（A の番号ではない）
    holdStream = false
    await chatB.send('B の依頼', [])
    expect(chatStartCalls).toHaveLength(2)
    expect(chatStartCalls[1]).toEqual({ projectDir: OTHER_PROJECT, resumeSessionId: 'sess-b' })

    // A のターンを終わらせる
    listenerA(RESULT)
    await sendA
  })

  it('★★ A へ戻ってきたら、保存された新しい番号で resume する', async () => {
    setClaudeSessionId(PROJECT, 'sess-a-old')
    setClaudeSessionId(OTHER_PROJECT, 'sess-b')
    holdStream = true
    const sendA = renderChat(PROJECT).send('A の依頼', [])
    await waitUntil(() => chatStartCalls.length === 1, 'A の chatStart が呼ばれる')
    const listenerA = streamListener!
    renderChat(OTHER_PROJECT) // B へ切り替え
    listenerA({ kind: 'session', sessionId: 'sess-a-new' })
    listenerA(RESULT)
    await sendA

    renderChat(OTHER_PROJECT) // 描画だけ（B のまま）
    holdStream = false
    await renderChat(PROJECT).send('A の2回目', []) // A へ戻る（effect が保存値を読み直す）
    expect(chatStartCalls[1]).toEqual({ projectDir: PROJECT, resumeSessionId: 'sess-a-new' })
  })
})
