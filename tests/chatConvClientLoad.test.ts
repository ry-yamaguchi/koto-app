// 会話の読み込み（src/renderer/chatConvClient.ts の loadConversationChecked・loadConversationView）。
// 守るもの: main の会話ストアに問い合わせて答えが返ったか（readable）を、空の会話と区別して返す。
// 問い合わせに失敗した回（IPC の失敗・ok:false）を、保存済みの会話が無い回と同じに扱うと、
// あいさつが読めなかった会話の上に書いてしまう。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadConversationChecked, loadConversationView } from '../src/renderer/chatConvClient'

const DIR = '/work/my-app'
const LEGACY_KEY = `sakura_chat:${DIR}`
const saved = [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: 'はい' }]

type LoadAnswer = { ok: true; messages: unknown[] | null } | { ok: false; message: string } | 'throws'

let store: Map<string, string>
let opsCalls: Array<{ dir: string; ops: unknown[] }>
let answer: LoadAnswer

beforeEach(() => {
  store = new Map()
  opsCalls = []
  answer = { ok: true, messages: null }
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
  vi.stubGlobal('window', {
    electronAPI: {
      chat: {
        load: async () => { if (answer === 'throws') throw new Error('ipc'); return answer },
        ops: async (dir: string, ops: unknown[]) => { opsCalls.push({ dir, ops }); return { ok: true } },
      },
    },
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('loadConversationChecked — 読めたか（readable）', () => {
  it('保存済みの会話を読めた: その会話を返し、readable は真', async () => {
    answer = { ok: true, messages: saved }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: saved, readable: true })
  })

  it('会話の記録がまだ無い（読めて、中身が null）: 空の会話。readable は真（本当に空のプロジェクト）', async () => {
    answer = { ok: true, messages: null }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: true })
  })

  it('問い合わせが ok:false で返った: 空に見えても readable は偽', async () => {
    answer = { ok: false, message: 'EACCES' }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: false })
  })

  it('問い合わせが例外で終わった（IPC の失敗）: 空に見えても readable は偽', async () => {
    answer = 'throws'
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: false })
  })

  it('読めなかった回でも、旧 localStorage の会話は返す（今までの振る舞い）。ただし readable は偽のまま', async () => {
    store.set(LEGACY_KEY, JSON.stringify(saved))
    answer = 'throws'
    const r = await loadConversationChecked(DIR)
    expect(r.messages).toEqual(saved)
    expect(r.readable).toBe(false)
  })

  it('旧 localStorage からの移行（ファイルが無く旧キーがある）: 会話を返し、main へ載せ、旧キーを消す。readable は真', async () => {
    store.set(LEGACY_KEY, JSON.stringify(saved))
    answer = { ok: true, messages: null }
    const r = await loadConversationChecked(DIR)
    expect(r).toEqual({ messages: saved, readable: true })
    expect(opsCalls).toEqual([{ dir: DIR, ops: [{ kind: 'replaceAll', messages: saved }] }])
    expect(store.has(LEGACY_KEY)).toBe(false)
  })
})

describe('loadConversationView — 今までの呼び手は、読めたかを使わず messages だけを受ける', () => {
  it('どの回も loadConversationChecked の messages と同じ（配列のまま）', async () => {
    for (const a of [{ ok: true, messages: saved }, { ok: true, messages: null }, { ok: false, message: 'x' }, 'throws'] as LoadAnswer[]) {
      answer = a
      const checked = await loadConversationChecked(DIR)
      expect(await loadConversationView(DIR)).toEqual(checked.messages)
    }
  })
})
