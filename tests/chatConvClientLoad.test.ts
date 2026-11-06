// 会話の読み込み（src/renderer/chatConvClient.ts の loadConversationChecked・loadConversationView）。
// 守るもの: main の会話ストアに問い合わせて答えが返ったか（readable）を、空の会話と区別して返す。
// 問い合わせに失敗した回（IPC の失敗・ok:false）を、保存済みの会話が無い回と同じに扱うと、
// あいさつが読めなかった会話の上に書いてしまう。
// 記録が壊れて読めなかった回（unreadable）も同じで、空に見えても「会話が無い」ではない。旧 localStorage の
// 移行（replaceAll）へ進むと壊れた記録の上へ旧データを書き、readable を真にするとあいさつが書き込む。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadConversationChecked, loadConversationView } from '../src/renderer/chatConvClient'

const DIR = '/work/my-app'
const LEGACY_KEY = `sakura_chat:${DIR}`
const saved = [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: 'はい' }]

type LoadAnswer =
  | { ok: true; messages: unknown[] | null; unreadable?: unknown; copies?: unknown }
  | { ok: false; message: string }
  | 'throws'

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
    expect(await loadConversationChecked(DIR)).toEqual({ messages: saved, readable: true, unreadable: null })
  })

  it('会話の記録がまだ無い（読めて、中身が null）: 空の会話。readable は真（本当に空のプロジェクト）', async () => {
    answer = { ok: true, messages: null }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: true, unreadable: null })
  })

  it('問い合わせが ok:false で返った: 空に見えても readable は偽', async () => {
    answer = { ok: false, message: 'EACCES' }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: false, unreadable: null })
  })

  it('問い合わせが例外で終わった（IPC の失敗）: 空に見えても readable は偽', async () => {
    answer = 'throws'
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: false, unreadable: null })
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
    expect(r).toEqual({ messages: saved, readable: true, unreadable: null })
    expect(opsCalls).toEqual([{ dir: DIR, ops: [{ kind: 'replaceAll', messages: saved }] }])
    expect(store.has(LEGACY_KEY)).toBe(false)
  })
})

describe('loadConversationChecked — 記録が読めなかった回（unreadable）', () => {
  const COPY = 'chat.json.broken-20261103-142530'

  it('写しを作れた回: unreadable が写しの名前を運び、messages は空、readable は偽', async () => {
    answer = { ok: true, messages: null, unreadable: { backupName: COPY } }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: false, unreadable: { backupName: COPY } })
  })

  it('写しを作れなかった回: backupName が null のまま運ばれる（写しがあるとは言わない）', async () => {
    answer = { ok: true, messages: null, unreadable: { backupName: null } }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: false, unreadable: { backupName: null } })
  })

  it('旧 localStorage に会話があっても移行しない: replaceAll を送らず、旧キーも消さず、messages は空', async () => {
    store.set(LEGACY_KEY, JSON.stringify(saved))
    answer = { ok: true, messages: null, unreadable: { backupName: COPY } }

    const r = await loadConversationChecked(DIR)

    expect(r.messages).toEqual([])
    expect(r.readable).toBe(false)
    expect(opsCalls).toEqual([]) // main へ何も送っていない（壊れた記録の上へ旧データを書かない）
    expect(store.get(LEGACY_KEY)).toBe(JSON.stringify(saved)) // 旧キーはそのまま
  })

  it('読めなかった記録のあとに main の手元で会話が続いている回は、その会話を映す（空にしない）。readable は偽のまま', async () => {
    store.set(LEGACY_KEY, JSON.stringify([{ role: 'user', content: '古い' }]))
    answer = { ok: true, messages: saved, unreadable: { backupName: COPY } }

    const r = await loadConversationChecked(DIR)

    expect(r).toEqual({ messages: saved, readable: false, unreadable: { backupName: COPY } })
    expect(opsCalls).toEqual([])
  })

  it('形の分からない unreadable も「読めなかった」と読む（読めた扱いに戻さない）。写しの名前が文字列でなければ null', async () => {
    const odd: unknown[] = [true, 1, 'broken', {}, { backupName: 5 }, { backupName: '' }, { backupName: undefined }]
    for (const unreadable of odd) {
      answer = { ok: true, messages: null, unreadable }
      store.set(LEGACY_KEY, JSON.stringify(saved))
      opsCalls = []
      expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: false, unreadable: { backupName: null } })
      expect(opsCalls).toEqual([])
    }
  })

  it('unreadable が null や無い（読めた・古い形の返事）なら、今までどおり。旧 localStorage の移行も働く', async () => {
    for (const unreadable of [null, undefined]) {
      store.set(LEGACY_KEY, JSON.stringify(saved))
      opsCalls = []
      answer = { ok: true, messages: null, unreadable }
      expect(await loadConversationChecked(DIR)).toEqual({ messages: saved, readable: true, unreadable: null })
      expect(opsCalls).toEqual([{ dir: DIR, ops: [{ kind: 'replaceAll', messages: saved }] }])
    }
  })

  it('読めた記録に写しが残っている回（copies）: 名前を運ぶ。読めた扱い（readable 真・unreadable null）のまま', async () => {
    answer = { ok: true, messages: saved, unreadable: null, copies: [COPY] }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: saved, readable: true, unreadable: null, copies: [COPY] })
  })

  it('記録も旧 localStorage も無い回（messages が null）でも、写しの名前を運ぶ', async () => {
    answer = { ok: true, messages: null, unreadable: null, copies: [COPY] }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: true, unreadable: null, copies: [COPY] })
    expect(opsCalls).toEqual([])
  })

  it('写しが残っている回は、記録が無くても（空の会話）・旧 localStorage の移行でも名前を運ぶ', async () => {
    answer = { ok: true, messages: [], unreadable: null, copies: [COPY] }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: [], readable: true, unreadable: null, copies: [COPY] })

    store.set(LEGACY_KEY, JSON.stringify(saved))
    answer = { ok: true, messages: null, unreadable: null, copies: [COPY] }
    expect(await loadConversationChecked(DIR)).toEqual({ messages: saved, readable: true, unreadable: null, copies: [COPY] })
  })

  it('copies が無い・空・形の分からない値なら、copies を付けない（写しがあるとは言わない）', async () => {
    for (const copies of [undefined, null, [], 'x', 5, {}, [5, null, '']]) {
      answer = { ok: true, messages: saved, unreadable: null, copies }
      const r = await loadConversationChecked(DIR)
      expect(r).toEqual({ messages: saved, readable: true, unreadable: null })
      expect('copies' in r).toBe(false)
    }
  })

  it('読めなかった記録の回は、copies があっても運ばない（読めなかった側の知らせだけ）', async () => {
    answer = { ok: true, messages: null, unreadable: { backupName: COPY }, copies: [COPY] }
    const r = await loadConversationChecked(DIR)
    expect(r).toEqual({ messages: [], readable: false, unreadable: { backupName: COPY } })
    expect('copies' in r).toBe(false)
  })

  it('loadConversationView（読めたかを使わない呼び手）は、読めなかった記録の回も messages だけ（空）を返す', async () => {
    answer = { ok: true, messages: null, unreadable: { backupName: COPY } }
    expect(await loadConversationView(DIR)).toEqual([])
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
