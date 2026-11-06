// main の失敗の吹き出しは、runEngineTurn が既に出したあとで後片づけが投げても、2つにならない。
//
// 本物の registerChatTurnHandlers と本物の runEngineTurn を動かし、通信（runSakuraStream）だけを
// 「ネットワーク断」で投げる偽物にする。画面への送信（wc.send）は、ちょうどその瞬間から投げる
// （画面のフレームが破棄された形。isDestroyed() は false のまま）。
//   ・runEngineTurn の catch が失敗の吹き出しを会話に書く → 画面への送信が投げる → runEngineTurn は投げる
//   ・turnRunner の catch は「会話に何が入っているか」を見て、2つ目の失敗の吹き出しを足さない
//   ・会話に残る失敗の吹き出しは、本当の原因（ネットワーク断）の文であって、送信の失敗の英語の文ではない
// （turnRunner の catch だけの振る舞いは tests/turnRunnerFailure.test.ts）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** true になった時点から、偽の wc.send が投げる */
  disposed: false,
  /** runSakuraStream が投げる文 */
  streamError: 'network down',
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  dialog: {},
}))

// 通信だけを差し替える（ほかは本物）。通信が投げると同時に、画面への送信も投げ始める。
vi.mock('../src/main/sakura/engine', () => ({
  runSakuraStream: async () => {
    h.disposed = true
    throw new Error(h.streamError)
  },
  runSakuraChat: async () => ({ content: '', usage: null }),
}))

import { registerChatTurnHandlers } from '../src/main/chat/turnRunner'
import { loadConversation, resetConversations, setApplyListener } from '../src/main/chat/convStore'
import { initUsageStore } from '../src/main/usageStore'
import { initLearningStore } from '../src/main/learningStore'
import { formatChatError } from '../src/renderer/aiTools'

let tmpDirs: string[] = []
function mkDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-turnrunner-real-'))
  tmpDirs.push(d)
  return d
}

beforeEach(() => {
  tmpDirs = []
  h.handlers.clear()
  h.disposed = false
  h.streamError = 'network down'
  resetConversations()
  setApplyListener(null)
  // 使用量・学習の保存先は一時フォルダ（利用者の保存領域には触れない）
  const store = mkDir()
  initUsageStore(store)
  initLearningStore(store)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  registerChatTurnHandlers({} as any)
})
afterEach(() => {
  resetConversations()
  setApplyListener(null)
  initUsageStore(null)
  initLearningStore(null)
  vi.restoreAllMocks()
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

/** 偽の WebContents。ask には空で答え、disposed になったら ask 以外の送信が投げる。 */
function fakeWc(turnId: string, opts: { frameGone: boolean }) {
  const sent: string[] = []
  const wc = {
    isDestroyed: () => false,
    send: (channel: string, payload: any) => {
      if (channel.startsWith('chatTurn:ask:')) {
        setTimeout(() => { void h.handlers.get('chatTurn:answer')!({}, { turnId, callId: payload.callId, ok: true, result: '' }) }, 0)
        return
      }
      if (opts.frameGone && h.disposed) throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      sent.push(channel)
    },
    once: () => {},
    on: () => {},
    off: () => {},
  }
  return { wc, sent }
}

function payloadOf(convDir: string, over: { rawText?: string } = {}) {
  return {
    turnId: 't1',
    spec: {
      rawText: over.rawText ?? 'こんにちは', images: [], assetBlock: '', apiKey: 'k', model: 'm', models: [{ id: 'm' }], maxRounds: 3,
      toolsProjectDir: null, convDir, errorPrefix: '', twoStageVision: false, routedModel: null, hasRag: false,
      turnOpts: {}, snapshotId: 's', snapshotLabel: 'x',
    },
    caps: { onUserMessage: false, buildRagBlock: false },
  } as any
}

async function startTurn(wc: any, payload: any) {
  return h.handlers.get('chatTurn:start')!({ sender: wc }, payload)
}

describe('本物の runEngineTurn: 失敗の吹き出しを出したあとで後片づけが投げても、2つにならない', () => {
  it('★ 通信が失敗し、同時に画面への送信も投げる: 会話は 依頼 → 失敗（本当の原因の文）の2つだけ。ハンドラは reject しない', async () => {
    const dir = mkDir()
    const { wc } = fakeWc('t1', { frameGone: true })

    const result = await startTurn(wc, payloadOf(dir))

    expect(result).toEqual({ ok: true, endedWithError: true })
    const messages = loadConversation(dir)!
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages[0].content).toBe('こんにちは')
    // 失敗の吹き出しは1つ。文は本当の原因（ネットワーク断）で、送信の失敗（英語の内部の文）ではない
    expect(messages.filter(m => m.offerRetry)).toHaveLength(1)
    expect(messages[1].content).toBe(formatChatError('network down'))
    expect(JSON.stringify(messages)).not.toContain('Render frame was disposed')
    expect(JSON.stringify(messages)).not.toContain('Koto の内部で問題が起きました')
    // 空の assistant は残らない（取り除く出来事を出したあとで送信が投げても、元の失敗が残る）
    expect(messages.filter(m => m.role === 'assistant' && !m.content.trim())).toEqual([])
  })

  it('画面が生きていれば（送信が投げなければ）、これまでどおり 依頼 → 失敗 の2つで、想定外の文は出ない', async () => {
    const dir = mkDir()
    const { wc } = fakeWc('t1', { frameGone: false })

    const result = await startTurn(wc, payloadOf(dir))

    expect(result).toEqual({ ok: true, endedWithError: true })
    const messages = loadConversation(dir)!
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]).toMatchObject({ offerRetry: true, toolNote: true, content: formatChatError('network down') })
  })
})
