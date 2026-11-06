import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ── 会話の記録を読めなかったことを、main の chat:load から画面の読み込みまで運ぶ（0.6.26）──────────────
// 本物の chat:load（ipc/chatStore.ts）を呼び、本物の一時フォルダの chat.json を読ませる。画面の読み込み
// （chatConvClient.ts の loadConversationChecked）は、その返事をそのまま受ける偽の electronAPI で動かす。
// 見ること:
//   ・chat:load の返り値に、写しの名前（作れなかった回は null）が入る。読めた回・無い回は null
//   ・画面の読み込みは、旧 localStorage に会話があっても main へ何も送らない（壊れた記録の上へ書かない）
//   ・ディスクの前後: 元の chat.json は同じ中身のまま、写しがちょうど1つ増える（写しを作れない回は増えない）

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { on: () => {}, getPath: () => os.tmpdir() },
}))

import { registerChatStoreHandlers } from '../src/main/ipc/chatStore'
import { resetConversations } from '../src/main/chat/convStore'
import { resetChatLogCache } from '../src/main/chatStore/file'
import { loadConversationChecked } from '../src/renderer/chatConvClient'

const STAMP = 'chat.json.broken-20261103-142530'
const BROKEN = '会話の記録ではない文字列'
const saved = [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: 'はい' }]

let tmpDirs: string[] = []
let opsSent: Array<{ dir: string; ops: unknown[] }>
let legacy: Map<string, string>

const mkProject = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-chatload-'))
  tmpDirs.push(d)
  return d
}
const sideOf = (dir: string) => path.join(dir, '.sakuraide')
const chatFile = (dir: string) => path.join(sideOf(dir), 'chat.json')
const put = (dir: string, content: string) => {
  fs.mkdirSync(sideOf(dir), { recursive: true })
  fs.writeFileSync(chatFile(dir), content)
}
const listing = (dir: string) => (fs.existsSync(sideOf(dir)) ? fs.readdirSync(sideOf(dir)).sort() : [])
const callLoad = (dir: string) => h.handlers.get('chat:load')!(null, dir)

beforeAll(() => {
  registerChatStoreHandlers({ getMainWindow: () => null } as never)
})

beforeEach(() => {
  tmpDirs = []
  opsSent = []
  legacy = new Map()
  resetConversations()
  resetChatLogCache()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 3, 14, 25, 30))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (legacy.has(k) ? legacy.get(k)! : null),
    setItem: (k: string, v: string) => { legacy.set(k, String(v)) },
    removeItem: (k: string) => { legacy.delete(k) },
  })
  // 画面の読み込みが呼ぶ electronAPI は、本物のハンドラへつなぐ（preload は返事をそのまま渡すだけ）
  vi.stubGlobal('window', {
    electronAPI: {
      chat: {
        load: async (dir: string) => callLoad(dir),
        ops: async (dir: string, ops: unknown[]) => { opsSent.push({ dir, ops }); return { ok: true } },
      },
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetConversations()
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

describe('chat:load の返り値（本物のハンドラ・本物の一時フォルダ）', () => {
  it('壊れた記録: messages は null のまま、unreadable に写しの名前が入る。元は同じ中身でその場に残り、写しは1つ', async () => {
    const dir = mkProject()
    put(dir, BROKEN)

    const res = await callLoad(dir)

    expect(res).toEqual({ ok: true, messages: null, unreadable: { backupName: STAMP } })
    expect(fs.readFileSync(chatFile(dir), 'utf-8')).toBe(BROKEN)
    expect(listing(dir)).toEqual(['chat.json', STAMP])
    expect(fs.readFileSync(path.join(sideOf(dir), STAMP), 'utf-8')).toBe(BROKEN)
  })

  it('2回読んでも写しは1つ、返事は同じ', async () => {
    const dir = mkProject()
    put(dir, BROKEN)
    const first = await callLoad(dir)
    const second = await callLoad(dir)
    expect(second).toEqual(first)
    expect(listing(dir)).toEqual(['chat.json', STAMP])
  })

  it('写しを作れない回（同じ秒の名前が別の中身で埋まっている）: backupName は null。フォルダは増えない', async () => {
    const dir = mkProject()
    put(dir, BROKEN)
    for (let n = 1; n <= 50; n++) {
      fs.writeFileSync(path.join(sideOf(dir), n === 1 ? STAMP : `${STAMP}-${n}`), `別の写し${n}`)
    }
    const before = listing(dir)

    const res = await callLoad(dir)

    expect(res).toEqual({ ok: true, messages: null, unreadable: { backupName: null } })
    expect(listing(dir)).toEqual(before)
    expect(fs.readFileSync(chatFile(dir), 'utf-8')).toBe(BROKEN)
  })

  it('読めた記録: messages が入り、unreadable は null', async () => {
    const dir = mkProject()
    put(dir, JSON.stringify(saved))
    expect(await callLoad(dir)).toEqual({ ok: true, messages: saved, unreadable: null })
    expect(listing(dir)).toEqual(['chat.json'])
  })

  it('記録が無い回: messages は null（今までどおり）、unreadable も null。写しも .sakuraide も作らない', async () => {
    const dir = mkProject()
    expect(await callLoad(dir)).toEqual({ ok: true, messages: null, unreadable: null })
    expect(fs.existsSync(sideOf(dir))).toBe(false)
  })

  it('読めなかった記録のあとに書き始めた回: messages は続きの会話、unreadable も写しの名前のまま', async () => {
    const dir = mkProject()
    put(dir, BROKEN)
    await callLoad(dir)
    await h.handlers.get('chat:ops')!(null, dir, [{ kind: 'append', msg: { role: 'user', content: '新しい発言' } }])

    const res = await callLoad(dir)

    expect(res.ok).toBe(true)
    expect(res.messages).toEqual([expect.objectContaining({ role: 'user', content: '新しい発言' })])
    expect(res.unreadable).toEqual({ backupName: STAMP })
  })
})

describe('chat:load: 途中の壊れた行を捨てて読めた分と、残っている写し', () => {
  const rec = (i: number, c: string) => `{"i":${i},"m":{"role":"user","content":"${c}"}}`
  const damaged = ['{"v":2}', rec(0, 'a'), '{"i":1,"m":{"role":"user","con', rec(2, 'c')].join('\n') + '\n'

  it('壊れた行を捨てた記録: 読めた分の messages と、unreadable（写しの名前）を一緒に返す。写しは元と同じ中身', async () => {
    const dir = mkProject()
    put(dir, damaged)

    const res = await callLoad(dir)

    expect(res).toEqual({ ok: true, messages: [{ role: 'user', content: 'a' }], unreadable: { backupName: STAMP } })
    expect(fs.readFileSync(path.join(sideOf(dir), STAMP), 'utf-8')).toBe(damaged)
    expect(fs.readFileSync(chatFile(dir), 'utf-8')).toBe(damaged)
  })

  it('画面の読み込み: 読めた分を映し、readable は偽、unreadable に写しの名前。旧 localStorage の移行も main への送信もしない', async () => {
    const dir = mkProject()
    put(dir, damaged)
    legacy.set(`sakura_chat:${dir}`, JSON.stringify(saved))

    const r = await loadConversationChecked(dir)

    expect(r).toEqual({ messages: [{ role: 'user', content: 'a' }], readable: false, unreadable: { backupName: STAMP } })
    expect(opsSent).toEqual([])
    expect(legacy.get(`sakura_chat:${dir}`)).toBe(JSON.stringify(saved))
  })

  it('記録は読めるが、同じフォルダに読めなかった記録の写しが残っている: copies に名前を添える（unreadable は null）', async () => {
    const dir = mkProject()
    put(dir, JSON.stringify(saved))
    fs.writeFileSync(path.join(sideOf(dir), STAMP), '前に読めなかった記録')

    expect(await callLoad(dir)).toEqual({ ok: true, messages: saved, unreadable: null, copies: [STAMP] })
    expect(await loadConversationChecked(dir)).toEqual({ messages: saved, readable: true, unreadable: null, copies: [STAMP] })
  })

  it('壊れた記録に書き足して開き直した会話: 読めた記録＋写しの名前（写しは元の壊れた中身のまま）', async () => {
    const dir = mkProject()
    put(dir, BROKEN)
    await h.handlers.get('chat:ops')!(null, dir, [{ kind: 'append', msg: { role: 'user', content: '新しい発言' } }], { flushNow: true })
    resetConversations() // 再起動
    resetChatLogCache()

    const res = await callLoad(dir)

    expect(res.unreadable).toBeNull()
    expect(res.messages).toEqual([expect.objectContaining({ content: '新しい発言' })])
    expect(res.copies).toEqual([STAMP])
    expect(fs.readFileSync(path.join(sideOf(dir), STAMP), 'utf-8')).toBe(BROKEN)
  })

  it('写しが無い会話・記録が無い会話は、copies を付けない', async () => {
    const dir = mkProject()
    expect('copies' in (await callLoad(dir))).toBe(false)
    put(dir, JSON.stringify(saved))
    expect('copies' in (await callLoad(dir))).toBe(false)
  })
})

// ── 旧口 chat:saveProject も、読めない記録を写しなしに置き換えない（0.6.26）────────────────────────
// 呼ぶ者はいないが preload に残っている。読み込みを挟まずに呼べば、壊れた chat.json を置き換えられた。
describe('chat:saveProject（旧口）: 読み込みを挟まずに呼んでも、読めない記録の写しを残す', () => {
  const callSave = (dir: string, messages: unknown[]) => h.handlers.get('chat:saveProject')!(null, dir, JSON.stringify(messages))

  it('壊れた記録: 先に写しを残してから置き換える（写しは元の壊れた中身）', async () => {
    const dir = mkProject()
    put(dir, BROKEN)

    expect(await callSave(dir, saved)).toEqual({ ok: true })

    expect(listing(dir)).toEqual(['chat.json', STAMP])
    expect(fs.readFileSync(path.join(sideOf(dir), STAMP), 'utf-8')).toBe(BROKEN)
    expect(await callLoad(dir)).toEqual(expect.objectContaining({ ok: true, messages: saved }))
  })

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    '書けないフォルダの壊れた記録: 写しを作れないので置き換えず、断る。元は変わらない',
    async () => {
      const dir = mkProject()
      put(dir, BROKEN)
      fs.chmodSync(sideOf(dir), 0o555)
      try {
        expect(await callSave(dir, saved)).toEqual({ ok: false, message: '読めなかった記録の写しを作れなかったので、書き込みません' })
      } finally {
        fs.chmodSync(sideOf(dir), 0o755)
      }
      expect(listing(dir)).toEqual(['chat.json'])
      expect(fs.readFileSync(chatFile(dir), 'utf-8')).toBe(BROKEN)
    }
  )

  it('読める記録・記録が無い会話への保存は、今までどおり（写しを作らない）', async () => {
    const dir = mkProject()
    expect(await callSave(dir, saved)).toEqual({ ok: true })
    expect(listing(dir)).toEqual(['chat.json'])
    expect(await callSave(dir, [...saved, { role: 'user', content: '続き' }])).toEqual({ ok: true })
    expect(listing(dir)).toEqual(['chat.json'])
  })
})

describe('画面の読み込み（本物の chat:load につないだ loadConversationChecked）', () => {
  it('壊れた記録 + 旧 localStorage に会話: 空の会話・readable 偽・写しの名前を返し、main へ何も送らない。ディスクは写しが増えるだけ', async () => {
    const dir = mkProject()
    put(dir, BROKEN)
    legacy.set(`sakura_chat:${dir}`, JSON.stringify(saved))

    const r = await loadConversationChecked(dir)

    expect(r).toEqual({ messages: [], readable: false, unreadable: { backupName: STAMP } })
    expect(opsSent).toEqual([]) // replaceAll を送っていない
    expect(legacy.get(`sakura_chat:${dir}`)).toBe(JSON.stringify(saved)) // 旧キーも消えていない
    expect(fs.readFileSync(chatFile(dir), 'utf-8')).toBe(BROKEN) // 元は置き換わっていない
    expect(listing(dir)).toEqual(['chat.json', STAMP])
  })

  it('写しを作れない回も同じ: 何も送らず、backupName は null', async () => {
    const dir = mkProject()
    put(dir, BROKEN)
    for (let n = 1; n <= 50; n++) {
      fs.writeFileSync(path.join(sideOf(dir), n === 1 ? STAMP : `${STAMP}-${n}`), `別の写し${n}`)
    }
    legacy.set(`sakura_chat:${dir}`, JSON.stringify(saved))

    const r = await loadConversationChecked(dir)

    expect(r).toEqual({ messages: [], readable: false, unreadable: { backupName: null } })
    expect(opsSent).toEqual([])
    expect(fs.readFileSync(chatFile(dir), 'utf-8')).toBe(BROKEN)
  })

  it('記録が無い + 旧 localStorage に会話: 今までどおり移行する（replaceAll を1回送り、旧キーを消す）', async () => {
    const dir = mkProject()
    legacy.set(`sakura_chat:${dir}`, JSON.stringify(saved))

    const r = await loadConversationChecked(dir)

    expect(r).toEqual({ messages: saved, readable: true, unreadable: null })
    expect(opsSent).toEqual([{ dir, ops: [{ kind: 'replaceAll', messages: saved }] }])
    expect(legacy.has(`sakura_chat:${dir}`)).toBe(false)
  })

  it('読めた記録: そのまま映す。unreadable は null', async () => {
    const dir = mkProject()
    put(dir, JSON.stringify(saved))
    expect(await loadConversationChecked(dir)).toEqual({ messages: saved, readable: true, unreadable: null })
    expect(opsSent).toEqual([])
  })
})
