import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ── チャットモードの会話の削除: 確認なしで消してよいのは「読めて、空」だけ（0.6.26）─────────────────
// 削除は会話のフォルダごと完全に消す。読めなかった記録（壊れた chat.json）を空と読んで確認なしに消すと、
// 元の記録も、読み込みの時点で作った写しも一緒に消える。見ること:
//   ・判断の表（読めて空／読めて中身あり／読めなかった／読み込みの失敗／形が違う／表示中の印）
//   ・確認の本文（読めなかった会話は、元の記録も消えることを言う）
//   ・偽の electronAPI と本物の chat:load・appSessions:delete・一時フォルダで、呼ばれた要求の一覧と、
//     ディスクの前後（答えが no ならフォルダも写しも残る）

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { on: () => {}, getPath: () => os.tmpdir() },
}))

import { registerChatStoreHandlers } from '../src/main/ipc/chatStore'
import { registerAppSessionsHandlers } from '../src/main/ipc/appSessions'
import { resetConversations } from '../src/main/chat/convStore'
import { resetChatLogCache } from '../src/main/chatStore/file'
import { resetAppSessionsStore } from '../src/main/appSessionsStore'
import { loadConversationChecked } from '../src/renderer/chatConvClient'
import { sessionDir } from '../src/shared/appChatDirs'
import {
  deleteConfirmKind, deleteConfirmBody, runDeleteSession, NOTHING_ON_DISK, type DeleteLoad,
} from '../src/renderer/chatDeleteGuard'

const STAMP = 'chat.json.broken-20261103-142530'
const BROKEN = '会話の記録ではない文字列'
const saved = [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: 'はい' }]
const BODY_UNREADABLE = '「壊れた会話」の記録を読めませんでした。削除すると、読めなかった記録も消えます。元に戻せません。'
const BODY_MESSAGES = '「壊れた会話」を削除します。よろしいですか？（元に戻せません）'
const BODY_COPIES = '「壊れた会話」を削除します。この会話の保存フォルダにある、読めなかった記録の写しも消えます。元に戻せません。'

// ── 判断の表 ──────────────────────────────────────────────────────────────

const ok = (messages?: unknown): DeleteLoad => ({ readable: true, unreadable: null, ...(messages === undefined ? {} : { messages }) })
const COPY_INFO = { backupName: STAMP }

describe('deleteConfirmKind: 読めて、空のときだけ none', () => {
  it.each<[string, { shownLength: number | null; load: DeleteLoad | null }, string]>([
    ['表示していない会話・読めて空', { shownLength: null, load: ok([]) }, 'none'],
    ['表示していない会話・読めて中身あり', { shownLength: null, load: ok(saved) }, 'messages'],
    ['表示中・読めて空・画面も空（覚えておいた結果は messages を持たない）', { shownLength: 0, load: ok() }, 'none'],
    ['表示中・読めて空だが画面に吹き出しがある', { shownLength: 2, load: ok() }, 'messages'],
    ['表示していない会話・画面の数は見ない（null）が、読んだ中身がある', { shownLength: null, load: ok([{ role: 'user', content: 'x' }]) }, 'messages'],
    ['読めなかった記録（写しあり）', { shownLength: null, load: { readable: false, unreadable: COPY_INFO } }, 'unreadable'],
    ['読めなかった記録（写しを作れなかった）', { shownLength: null, load: { readable: false, unreadable: { backupName: null } } }, 'unreadable'],
    ['表示中・読めなかった記録・画面は空', { shownLength: 0, load: { readable: false, unreadable: COPY_INFO } }, 'unreadable'],
    ['表示中・読めなかった記録・読めなかったあとに書き始めて画面に吹き出しがある（読めなかった側が先）', { shownLength: 3, load: { readable: false, unreadable: COPY_INFO } }, 'unreadable'],
    ['読めたと言うが読めなかった知らせも付いている（食い違いは読めなかった側）', { shownLength: 0, load: { readable: true, unreadable: COPY_INFO } }, 'unreadable'],
    ['読み込みが失敗した（readable が偽・知らせなし）', { shownLength: null, load: { readable: false, unreadable: null } }, 'unreadable'],
    ['読み込みの結果が無い（読むのに失敗した）', { shownLength: null, load: null }, 'unreadable'],
    ['表示中でも、読み込みの結果が無ければ画面が空でも none にしない', { shownLength: 0, load: null }, 'unreadable'],
    ['形が違う（配列でない: オブジェクト）', { shownLength: null, load: ok({ a: 1 }) }, 'unreadable'],
    ['形が違う（配列でない: 文字列）', { shownLength: null, load: ok('壊れた') }, 'unreadable'],
    ['形が違う（配列でない: null）', { shownLength: null, load: ok(null) }, 'unreadable'],
    ['読めて中身あり・読めなかった記録の写しが残っている', { shownLength: null, load: { ...ok(saved), copies: [STAMP] } }, 'copies'],
    ['読めて空でも、読めなかった記録の写しが残っている（消すと写しも消える）', { shownLength: null, load: { ...ok([]), copies: [STAMP] } }, 'copies'],
    ['表示中・覚えておいた結果に写しがある・画面が空', { shownLength: 0, load: { readable: true, unreadable: null, copies: [STAMP] } }, 'copies'],
    ['写しの一覧が空配列なら、写しは無いのと同じ（中身で決める）', { shownLength: null, load: { ...ok(saved), copies: [] } }, 'messages'],
    ['写しの一覧が空配列・読めて空', { shownLength: null, load: { ...ok([]), copies: [] } }, 'none'],
    ['読めなかった記録に写しの名前も付いている（読めなかった側が先）', { shownLength: null, load: { readable: false, unreadable: COPY_INFO, copies: [STAMP] } }, 'unreadable'],
    ['読み込みが失敗した回は、写しの名前があっても読めなかった側', { shownLength: null, load: { readable: false, unreadable: null, copies: [STAMP] } }, 'unreadable'],
  ])('%s', (_label, input, expected) => {
    expect(deleteConfirmKind(input)).toBe(expected)
  })

  it('保存先がまだ無い間（NOTHING_ON_DISK）は、画面が空なら消えるものが無い', () => {
    expect(deleteConfirmKind({ shownLength: 0, load: NOTHING_ON_DISK })).toBe('none')
    expect(deleteConfirmKind({ shownLength: 1, load: NOTHING_ON_DISK })).toBe('messages')
  })
})

describe('deleteConfirmBody: 確認の本文', () => {
  it('読めなかった会話: 元の記録も消えること・元に戻せないことを言う', () => {
    expect(deleteConfirmBody('unreadable', '壊れた会話')).toBe(BODY_UNREADABLE)
  })

  it('中身がある会話: 今までの文のまま', () => {
    expect(deleteConfirmBody('messages', '壊れた会話')).toBe(BODY_MESSAGES)
  })

  it('読めなかった記録の写しが残る会話: 写しも消えること・元に戻せないことを言う（記録を読めなかったとは言わない）', () => {
    const t = deleteConfirmBody('copies', '壊れた会話')
    expect(t).toBe(BODY_COPIES)
    expect(t).not.toContain('読めませんでした')
  })

  it('画面に出さない語（内部の名前・丸数字）を含まない', () => {
    for (const t of [BODY_UNREADABLE, BODY_MESSAGES, BODY_COPIES]) {
      expect(t).not.toMatch(/IPC|unreadable|backupName|chat\.json/)
      expect(t).not.toMatch(/[①-⑳]/)
    }
  })
})

// ── 偽の読み込み・偽の確認で、呼ばれた要求の一覧を見る ─────────────────────────────────

function fakes(opts: { read?: () => Promise<DeleteLoad>; answer?: boolean } = {}) {
  const confirmBodies: string[] = []
  const removed: string[] = []
  const read = vi.fn(opts.read ?? (async () => ok([])))
  return {
    confirmBodies,
    removed,
    read,
    deps: {
      confirm: async (body: string) => { confirmBodies.push(body); return opts.answer ?? false },
      remove: (id: string) => { removed.push(id) },
    },
  }
}

const base = { id: 's1', title: '壊れた会話', shownLength: null as number | null, known: null as DeleteLoad | null }

describe('runDeleteSession: 呼ばれた要求の一覧', () => {
  it('読めて空: 確認 0 回で消す', async () => {
    const f = fakes({ read: async () => ok([]) })
    const r = await runDeleteSession({ ...base, read: f.read }, f.deps)
    expect(f.confirmBodies).toEqual([])
    expect(f.removed).toEqual(['s1'])
    expect(r).toEqual({ cancelled: false, result: undefined })
  })

  it('読めなかった記録・答えが no: 確認はちょうど 1 回（読めなかった側の本文）、消さない', async () => {
    const f = fakes({ read: async () => ({ readable: false, unreadable: COPY_INFO }), answer: false })
    const r = await runDeleteSession({ ...base, read: f.read }, f.deps)
    expect(f.confirmBodies).toEqual([BODY_UNREADABLE])
    expect(f.removed).toEqual([])
    expect(r).toEqual({ cancelled: true })
  })

  it('読めなかった記録・答えが yes: 確認 1 回のあと、1 回だけ消す', async () => {
    const f = fakes({ read: async () => ({ readable: false, unreadable: COPY_INFO }), answer: true })
    await runDeleteSession({ ...base, read: f.read }, f.deps)
    expect(f.confirmBodies).toEqual([BODY_UNREADABLE])
    expect(f.removed).toEqual(['s1'])
  })

  it('読めた会話に読めなかった記録の写しが残っている・答えが no: 写しの本文で確認ちょうど 1 回、消さない', async () => {
    const f = fakes({ read: async () => ({ ...ok([]), copies: [STAMP] }), answer: false })
    const r = await runDeleteSession({ ...base, read: f.read }, f.deps)
    expect(f.confirmBodies).toEqual([BODY_COPIES])
    expect(f.removed).toEqual([])
    expect(r).toEqual({ cancelled: true })
  })

  it('読めた会話に写しが残っている・答えが yes: 確認 1 回のあと、1 回だけ消す', async () => {
    const f = fakes({ read: async () => ({ ...ok(saved), copies: [STAMP] }), answer: true })
    await runDeleteSession({ ...base, read: f.read }, f.deps)
    expect(f.confirmBodies).toEqual([BODY_COPIES])
    expect(f.removed).toEqual(['s1'])
  })

  it('表示中の会話で、覚えている結果に写しがある: 読みに行かず、画面が空でも確認 1 回', async () => {
    const f = fakes({ answer: false })
    await runDeleteSession(
      { ...base, shownLength: 0, known: { readable: true, unreadable: null, copies: [STAMP] }, read: f.read },
      f.deps,
    )
    expect(f.read).not.toHaveBeenCalled()
    expect(f.confirmBodies).toEqual([BODY_COPIES])
    expect(f.removed).toEqual([])
  })

  it('読めて中身あり・答えが no: 今までの本文で確認 1 回、消さない', async () => {
    const f = fakes({ read: async () => ok(saved), answer: false })
    await runDeleteSession({ ...base, read: f.read }, f.deps)
    expect(f.confirmBodies).toEqual([BODY_MESSAGES])
    expect(f.removed).toEqual([])
  })

  it('読むのに失敗した（例外）: 消さずに確認へ進む（読めなかった側の本文）。答えが no なら消さない', async () => {
    const f = fakes({ read: async () => { throw new Error('ipc') }, answer: false })
    await runDeleteSession({ ...base, read: f.read }, f.deps)
    expect(f.confirmBodies).toEqual([BODY_UNREADABLE])
    expect(f.removed).toEqual([])
  })

  it('表示中の会話で、読み込みのときに読めなかった印を覚えている: 読みに行かず、画面が空でも確認 1 回', async () => {
    const f = fakes({ answer: false })
    await runDeleteSession(
      { ...base, shownLength: 0, known: { readable: false, unreadable: COPY_INFO }, read: f.read },
      f.deps,
    )
    expect(f.read).not.toHaveBeenCalled()
    expect(f.confirmBodies).toEqual([BODY_UNREADABLE])
    expect(f.removed).toEqual([])
  })

  it('表示中の会話で、覚えている印が「読めて」: 読みに行かず、画面が空なら確認なしで消す', async () => {
    const f = fakes({ read: async () => ({ readable: false, unreadable: COPY_INFO }) })
    await runDeleteSession({ ...base, shownLength: 0, known: ok(), read: f.read }, f.deps)
    expect(f.read).not.toHaveBeenCalled()
    expect(f.confirmBodies).toEqual([])
    expect(f.removed).toEqual(['s1'])
  })

  it('表示中の会話で、印が無い（読み込みの前）: 読みに行って、その結果で決める', async () => {
    const f = fakes({ read: async () => ({ readable: false, unreadable: COPY_INFO }), answer: false })
    await runDeleteSession({ ...base, shownLength: 0, known: null, read: f.read }, f.deps)
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.confirmBodies).toEqual([BODY_UNREADABLE])
    expect(f.removed).toEqual([])
  })

  it('表示中の会話で読めたが画面に吹き出しがある: 今までの本文で確認 1 回', async () => {
    const f = fakes({ answer: false })
    await runDeleteSession({ ...base, shownLength: 2, known: ok(), read: f.read }, f.deps)
    expect(f.confirmBodies).toEqual([BODY_MESSAGES])
    expect(f.removed).toEqual([])
  })

  it('確認より前には消さない: 確認の答えを待つ間、消す要求は 0 件', async () => {
    const order: string[] = []
    await runDeleteSession(
      { ...base, read: async () => ({ readable: false, unreadable: COPY_INFO }) },
      {
        confirm: async () => { order.push('confirm'); return true },
        remove: () => { order.push('remove') },
      },
    )
    expect(order).toEqual(['confirm', 'remove'])
  })
})

// ── 偽の electronAPI・本物の chat:load と appSessions:delete・本物の一時フォルダ ─────────────────

let tmpDirs: string[] = []
let calls: Array<{ api: string; args: unknown[] }>
let loadAnswer: null | ((dir: string) => unknown)

const mkWorkspace = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-deleteguard-'))
  tmpDirs.push(d)
  return d
}
const sideOf = (ws: string, id: string) => path.join(sessionDir(ws, id), '.sakuraide')
const chatFileOf = (ws: string, id: string) => path.join(sideOf(ws, id), 'chat.json')
const listing = (ws: string, id: string) => (fs.existsSync(sideOf(ws, id)) ? fs.readdirSync(sideOf(ws, id)).sort() : [])
const meta = (id: string) => ({ id, title: '壊れた会話', model: 'm', createdAt: 1000 })

async function newSessionOnDisk(ws: string, id: string, chatJson: string | null): Promise<void> {
  await h.handlers.get('appSessions:create')!(null, ws, meta(id))
  if (chatJson !== null) {
    fs.mkdirSync(sideOf(ws, id), { recursive: true })
    fs.writeFileSync(chatFileOf(ws, id), chatJson)
  }
}

/** ChatApp が渡すのと同じ形で、削除を走らせる（表示していない会話）。 */
function runFor(ws: string, id: string, answer: boolean) {
  const confirmBodies: string[] = []
  const run = () => runDeleteSession(
    {
      id,
      title: '壊れた会話',
      shownLength: null,
      known: null,
      read: () => loadConversationChecked(sessionDir(ws, id)),
    },
    {
      confirm: async (body) => { confirmBodies.push(body); return answer },
      remove: (sid) => window.electronAPI.appSessions.delete(ws, sid),
    },
  )
  return { run, confirmBodies }
}

beforeAll(() => {
  registerChatStoreHandlers({ getMainWindow: () => null } as never)
  registerAppSessionsHandlers({ getMainWindow: () => null } as never)
})

beforeEach(() => {
  tmpDirs = []
  calls = []
  loadAnswer = null
  resetConversations()
  resetChatLogCache()
  resetAppSessionsStore()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 3, 14, 25, 30))
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('window', {
    electronAPI: {
      chat: {
        load: async (dir: string) => (loadAnswer ? loadAnswer(dir) : h.handlers.get('chat:load')!(null, dir)),
        ops: async (...args: unknown[]) => { calls.push({ api: 'chat.ops', args }); return { ok: true } },
      },
      appSessions: {
        delete: async (ws: string, id: string) => {
          calls.push({ api: 'appSessions.delete', args: [ws, id] })
          return h.handlers.get('appSessions:delete')!(null, ws, id)
        },
      },
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  resetConversations()
  resetAppSessionsStore()
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

const deleteCalls = () => calls.filter(c => c.api === 'appSessions.delete')

describe('壊れた記録の会話を削除する（本物の chat:load・本物の一時フォルダ）', () => {
  it('答えが no: 削除の要求は 0 件。会話のフォルダも、元の記録も、読み込みで作った写しも残る', async () => {
    const ws = mkWorkspace()
    await newSessionOnDisk(ws, 's1', BROKEN)
    const { run, confirmBodies } = runFor(ws, 's1', false)

    const r = await run()

    expect(r).toEqual({ cancelled: true })
    expect(confirmBodies).toEqual([BODY_UNREADABLE])
    expect(deleteCalls()).toEqual([])
    expect(fs.existsSync(sessionDir(ws, 's1'))).toBe(true)
    expect(fs.readFileSync(chatFileOf(ws, 's1'), 'utf-8')).toBe(BROKEN)
    expect(listing(ws, 's1')).toEqual(['chat.json', STAMP])
    expect(fs.readFileSync(path.join(sideOf(ws, 's1'), STAMP), 'utf-8')).toBe(BROKEN)
  })

  it('答えが yes: 削除の要求はちょうど 1 件。会話のフォルダごと消える', async () => {
    const ws = mkWorkspace()
    await newSessionOnDisk(ws, 's1', BROKEN)
    const { run, confirmBodies } = runFor(ws, 's1', true)

    await run()

    expect(confirmBodies).toEqual([BODY_UNREADABLE])
    expect(deleteCalls()).toEqual([{ api: 'appSessions.delete', args: [ws, 's1'] }])
    expect(fs.existsSync(sessionDir(ws, 's1'))).toBe(false)
  })

  it('読めて空（記録のファイルが無い会話）: 確認 0 回で、削除の要求が 1 件、フォルダが消える', async () => {
    const ws = mkWorkspace()
    await newSessionOnDisk(ws, 's1', null)
    const { run, confirmBodies } = runFor(ws, 's1', false)

    const r = await run()

    expect(r).toEqual({ cancelled: false, result: undefined })
    expect(confirmBodies).toEqual([])
    expect(deleteCalls()).toEqual([{ api: 'appSessions.delete', args: [ws, 's1'] }])
    expect(fs.existsSync(sessionDir(ws, 's1'))).toBe(false)
  })

  it('読めて中身あり・答えが no: 今までの本文で確認 1 回、削除の要求は 0 件、記録は同じ中身のまま', async () => {
    const ws = mkWorkspace()
    const body = JSON.stringify(saved)
    await newSessionOnDisk(ws, 's1', body)
    const { run, confirmBodies } = runFor(ws, 's1', false)

    await run()

    expect(confirmBodies).toEqual([BODY_MESSAGES])
    expect(deleteCalls()).toEqual([])
    expect(fs.readFileSync(chatFileOf(ws, 's1'), 'utf-8')).toBe(body)
    expect(listing(ws, 's1')).toEqual(['chat.json'])
  })

  it('壊れた記録に書き足して開き直した会話（記録は読めるが、写しが同じフォルダに残る）: 写しの本文で確認 1 回。答えが no なら全部残る', async () => {
    const ws = mkWorkspace()
    await newSessionOnDisk(ws, 's1', BROKEN)
    // 1通送る: 読んだ時点で写しができ、chat.json は新しい会話に置き換わる（写しは残る）
    await h.handlers.get('chat:ops')!(null, sessionDir(ws, 's1'), [{ kind: 'append', msg: { role: 'user', content: '新しい発言' } }], { flushNow: true })
    resetConversations() // 再起動
    resetChatLogCache()
    const { run, confirmBodies } = runFor(ws, 's1', false)

    await run()

    expect(confirmBodies).toEqual([BODY_COPIES]) // ふつうの確認（BODY_MESSAGES）だけで写しが消えることはない
    expect(deleteCalls()).toEqual([])
    expect(listing(ws, 's1')).toEqual(['chat.json', STAMP])
    expect(fs.readFileSync(path.join(sideOf(ws, 's1'), STAMP), 'utf-8')).toBe(BROKEN)
  })

  it('同じ会話で答えが yes: 削除の要求は 1 件で、写しごとフォルダが消える', async () => {
    const ws = mkWorkspace()
    await newSessionOnDisk(ws, 's1', BROKEN)
    await h.handlers.get('chat:ops')!(null, sessionDir(ws, 's1'), [{ kind: 'append', msg: { role: 'user', content: '新しい発言' } }], { flushNow: true })
    resetConversations()
    resetChatLogCache()
    const { run, confirmBodies } = runFor(ws, 's1', true)

    await run()

    expect(confirmBodies).toEqual([BODY_COPIES])
    expect(deleteCalls()).toEqual([{ api: 'appSessions.delete', args: [ws, 's1'] }])
    expect(fs.existsSync(sessionDir(ws, 's1'))).toBe(false)
  })

  it('読み込みが失敗した（chat:load が ok:false）: 空と読まず、確認 1 回。答えが no なら削除の要求は 0 件', async () => {
    const ws = mkWorkspace()
    await newSessionOnDisk(ws, 's1', null)
    loadAnswer = () => ({ ok: false, messages: null, message: 'EACCES' })
    const { run, confirmBodies } = runFor(ws, 's1', false)

    await run()

    expect(confirmBodies).toEqual([BODY_UNREADABLE])
    expect(deleteCalls()).toEqual([])
    expect(fs.existsSync(sessionDir(ws, 's1'))).toBe(true)
  })

  it('読み込みが例外で終わった（IPC の失敗）: 空と読まず、確認 1 回。答えが no なら削除の要求は 0 件', async () => {
    const ws = mkWorkspace()
    await newSessionOnDisk(ws, 's1', null)
    loadAnswer = () => { throw new Error('ipc') }
    const { run, confirmBodies } = runFor(ws, 's1', false)

    await run()

    expect(confirmBodies).toEqual([BODY_UNREADABLE])
    expect(deleteCalls()).toEqual([])
  })

  it('返事の形が違う（messages が配列でない）: 空と読まず、確認 1 回。答えが no なら削除の要求は 0 件', async () => {
    const ws = mkWorkspace()
    await newSessionOnDisk(ws, 's1', null)
    loadAnswer = () => ({ ok: true, messages: { 形: '違う' }, unreadable: null })
    const { run, confirmBodies } = runFor(ws, 's1', false)

    await run()

    expect(confirmBodies).toEqual([BODY_UNREADABLE])
    expect(deleteCalls()).toEqual([])
  })

  it('写しを作れない回（同じ秒の名前が別の中身で埋まっている）も読めなかった側: 確認 1 回、答えが no なら全部残る', async () => {
    const ws = mkWorkspace()
    await newSessionOnDisk(ws, 's1', BROKEN)
    for (let n = 1; n <= 50; n++) {
      fs.writeFileSync(path.join(sideOf(ws, 's1'), n === 1 ? STAMP : `${STAMP}-${n}`), `別の写し${n}`)
    }
    const before = listing(ws, 's1')
    const { run, confirmBodies } = runFor(ws, 's1', false)

    await run()

    expect(confirmBodies).toEqual([BODY_UNREADABLE])
    expect(deleteCalls()).toEqual([])
    expect(listing(ws, 's1')).toEqual(before)
  })
})
