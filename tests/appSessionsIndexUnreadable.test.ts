import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ── チャットモードの会話の一覧（索引 sessions.json）が読めないとき、写して上書きしない（0.6.26）──────────
// 読めない索引を空の一覧として始めると、既定の会話を1件登録した時点で、索引が1件だけで上書きされる。
// 会話のフォルダは残るが、一覧から全部消え、画面から戻す道が無い。見ること（本物の一時フォルダ）:
//   ・読めない索引は `sessions.json.broken-<日時>` へ写される（元は同じ中身のまま残り、写しは1つ）
//   ・その起動の間は、書き込みの待ち時間を過ぎても、終了時の書き切りでも、索引のファイルは変わらない
//   ・appSessions:list が「読めなかった」を運ぶ（一覧が空なのと区別できる）
//   ・無い・空・読めた索引は、今までどおり（写しを作らず、書き込む）

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { on: () => {}, getPath: () => os.tmpdir() },
}))

import {
  listSessions, listSessionsState, createSession, renameSession, setSessionModel, deleteSession,
  ensureSessionProject, flushAppSessions, resetAppSessionsStore, type AppSessionMeta,
} from '../src/main/appSessionsStore'
import { registerAppSessionsHandlers } from '../src/main/ipc/appSessions'
import { resetConversations } from '../src/main/chat/convStore'
import { resetChatLogCache } from '../src/main/chatStore/file'
import { sessionsIndexPath, APP_CHAT_DIRNAME } from '../src/shared/appChatDirs'

const STAMP = 'sessions.json.broken-20261103-142530'
const DEBOUNCE_PAST = 5000

let tmpDirs: string[] = []

const mkWorkspace = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-indexbroken-'))
  tmpDirs.push(d)
  return d
}
const chatDirOf = (ws: string) => path.join(ws, APP_CHAT_DIRNAME)
const put = (ws: string, content: string) => {
  fs.mkdirSync(chatDirOf(ws), { recursive: true })
  fs.writeFileSync(sessionsIndexPath(ws), content)
}
const listing = (ws: string) => (fs.existsSync(chatDirOf(ws)) ? fs.readdirSync(chatDirOf(ws)).sort() : [])
const copiesOf = (ws: string) => listing(ws).filter(n => n.startsWith('sessions.json.broken-'))
const meta = (id: string, patch: Partial<AppSessionMeta> = {}): AppSessionMeta => ({
  id, title: '新しい会話', model: 'preview/Kimi-K2.7-Code', createdAt: 1000, ...patch,
})

beforeAll(() => {
  registerAppSessionsHandlers({ getMainWindow: () => null } as never)
})

beforeEach(() => {
  tmpDirs = []
  resetAppSessionsStore()
  resetConversations()
  resetChatLogCache() // 写しの記憶も、アプリを起動し直した状態に戻る
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 3, 14, 25, 30))
})

afterEach(() => {
  vi.useRealTimers()
  resetAppSessionsStore()
  resetConversations()
  for (const d of tmpDirs) {
    try { fs.chmodSync(chatDirOf(d), 0o755) } catch { /* 無ければ何もしない */ }
    fs.rmSync(d, { recursive: true, force: true })
  }
})

const BROKEN_CONTENTS: Array<[string, string]> = [
  ['JSON でない文字列', '一覧ではない文字列'],
  ['途中で切れた JSON', '[{"id":"a","title":"途中'],
  ['配列でない JSON（オブジェクト）', '{"id":"a"}'],
  ['配列でない JSON（文字列）', '"sessions"'],
  ['配列でない JSON（null）', 'null'],
  ['配列だが1件も取り出せない（id が無い）', '[{"title":"id なし"},{"title":"id なし2"}]'],
  ['配列だが1件も取り出せない（要素が配列でない値）', '[1,2,3]'],
]

describe('読めない索引: 写して、書かない（本物の一時フォルダ）', () => {
  it.each(BROKEN_CONTENTS)('%s: 一覧は空・unreadable に写しの名前。元は同じ中身で残り、写しは1つ', (_label, content) => {
    const ws = mkWorkspace()
    put(ws, content)

    const state = listSessionsState(ws)

    expect(state).toEqual({ sessions: [], unreadable: { backupName: STAMP } })
    expect(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).toBe(content)
    expect(listing(ws)).toEqual(['sessions.json', STAMP])
    expect(fs.readFileSync(path.join(chatDirOf(ws), STAMP), 'utf-8')).toBe(content)
  })

  it.each(BROKEN_CONTENTS)('%s: 会話を作って待ち時間を過ぎても、終了時に書き切っても、索引のファイルは前後で同じ', (_label, content) => {
    const ws = mkWorkspace()
    put(ws, content)

    listSessions(ws) // 起動直後の一覧
    createSession(ws, meta('n1', { title: '起動後に作った会話' })) // 既定の会話の登録
    vi.advanceTimersByTime(DEBOUNCE_PAST) // 書き込みの待ち時間を過ぎる
    flushAppSessions()
    createSession(ws, meta('n2'))
    flushAppSessions() // 待ち時間の前に終了時の書き切り

    expect(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).toBe(content)
    expect(listing(ws).filter(n => n.endsWith('.tmp'))).toEqual([])
    expect(copiesOf(ws)).toEqual([STAMP])
    // この起動の間は、作った会話を画面へ返す（一覧には載るが、ファイルには書かない）
    expect(listSessionsState(ws).sessions.map(s => s.id)).toEqual(['n2', 'n1'])
    expect(listSessionsState(ws).unreadable).toEqual({ backupName: STAMP })
  })

  it('アプリを起動し直しても（記憶を捨てても）、同じ中身の写しがあれば新しく作らない', () => {
    const ws = mkWorkspace()
    put(ws, BROKEN_CONTENTS[0][1])
    listSessionsState(ws)

    vi.setSystemTime(new Date(2026, 10, 3, 16, 0, 0)) // 1時間半あとの起動
    resetAppSessionsStore()
    resetChatLogCache()
    const state = listSessionsState(ws)

    expect(state.unreadable).toEqual({ backupName: STAMP })
    expect(copiesOf(ws)).toEqual([STAMP])
  })

  it('写しを作れない回（同じ秒の名前が別の中身で埋まっている）: backupName は null。それでも書かない', () => {
    const ws = mkWorkspace()
    put(ws, BROKEN_CONTENTS[0][1])
    for (let n = 1; n <= 50; n++) {
      fs.writeFileSync(path.join(chatDirOf(ws), n === 1 ? STAMP : `${STAMP}-${n}`), `別の写し${n}`)
    }
    const before = listing(ws)

    expect(listSessionsState(ws)).toEqual({ sessions: [], unreadable: { backupName: null } })
    createSession(ws, meta('n1'))
    vi.advanceTimersByTime(DEBOUNCE_PAST)
    flushAppSessions()

    expect(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).toBe(BROKEN_CONTENTS[0][1])
    expect(listing(ws).filter(n => !n.startsWith('sessions.json.broken-'))).toEqual(['sessions', 'sessions.json'])
    expect(listing(ws).filter(n => n.startsWith('sessions.json.broken-')))
      .toEqual(before.filter(n => n.startsWith('sessions.json.broken-')))
  })

  it('読み出せない索引（ファイルの場所がフォルダ）: 写しは作れず backupName は null。書き込みも試みない', () => {
    const ws = mkWorkspace()
    fs.mkdirSync(sessionsIndexPath(ws), { recursive: true })

    expect(listSessionsState(ws)).toEqual({ sessions: [], unreadable: { backupName: null } })
    createSession(ws, meta('n1'))
    vi.advanceTimersByTime(DEBOUNCE_PAST)
    flushAppSessions()

    expect(fs.statSync(sessionsIndexPath(ws)).isDirectory()).toBe(true)
    expect(listing(ws).filter(n => n.endsWith('.tmp'))).toEqual([])
    expect(copiesOf(ws)).toEqual([])
  })

  it('読み出せない索引（権限を外したファイル）: backupName は null。書かない', () => {
    const ws = mkWorkspace()
    put(ws, '[]')
    fs.chmodSync(sessionsIndexPath(ws), 0o000)
    try {
      expect(listSessionsState(ws)).toEqual({ sessions: [], unreadable: { backupName: null } })
      createSession(ws, meta('n1'))
      vi.advanceTimersByTime(DEBOUNCE_PAST)
      flushAppSessions()
    } finally {
      fs.chmodSync(sessionsIndexPath(ws), 0o644)
    }
    expect(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).toBe('[]')
    expect(copiesOf(ws)).toEqual([])
  })
})

describe('読めない索引を読む入口は6つすべて、同じ判断を通る（ensureEntry）', () => {
  const entries: Array<[string, (ws: string) => unknown]> = [
    ['list', ws => listSessions(ws)],
    ['create', ws => createSession(ws, meta('n1'))],
    ['rename', ws => renameSession(ws, 'n1', '改名')],
    ['setModel', ws => setSessionModel(ws, 'n1', 'x')],
    ['delete', ws => deleteSession(ws, 'n1')],
    ['ensureProject', ws => ensureSessionProject(ws, 'n1', ws, '題')],
  ]

  it.each(entries)('最初に呼ばれたのが %s でも、写しが1つできて、索引のファイルは変わらない', (_name, call) => {
    const ws = mkWorkspace()
    put(ws, BROKEN_CONTENTS[0][1])

    call(ws)
    vi.advanceTimersByTime(DEBOUNCE_PAST)
    flushAppSessions()

    expect(copiesOf(ws)).toEqual([STAMP])
    expect(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).toBe(BROKEN_CONTENTS[0][1])
    expect(listSessionsState(ws).unreadable).toEqual({ backupName: STAMP })
  })
})

// ── 読めない印は、そのプロセスの間ずっと残る（起動中に読み直さない）──────────────────────────────
// 利用者が .broken の写しから sessions.json を手で直しても、Koto が動いている間は一覧に書き込まない。
// 読み直して書き込みを再開すると、直したばかりの一覧を、この間に作った会話だけの一覧で上書きしてしまう。
// 開き直したとき（起動時の読み込み）に読めれば、書き込みは今までどおり再開する。
describe('読めなかった索引は、手で直しても、開き直すまで書かない', () => {
  const RESTORED = [meta('x', { title: '手で直した会話' }), meta('y', { title: '手で直した会話2' })]

  it('動いている間に索引を読める形へ直しても、待ち時間のあとも書き切りでも、直したファイルを上書きしない', () => {
    const ws = mkWorkspace()
    put(ws, BROKEN_CONTENTS[0][1])
    listSessionsState(ws) // 起動直後: 読めない → 写しができる
    createSession(ws, meta('n1'))

    put(ws, JSON.stringify(RESTORED)) // 利用者が写しから直した（Koto は動いたまま）
    const restoredText = fs.readFileSync(sessionsIndexPath(ws), 'utf-8')
    createSession(ws, meta('n2'))
    vi.advanceTimersByTime(DEBOUNCE_PAST)
    flushAppSessions()

    expect(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).toBe(restoredText) // 直した一覧のまま
    expect(listSessionsState(ws).unreadable).toEqual({ backupName: STAMP }) // 画面の知らせも、そのプロセスの間は変わらない
    expect(copiesOf(ws)).toEqual([STAMP])
  })

  it('開き直す（起動時の読み込み）と読めるので、直した一覧が出て、書き込みは再開する', () => {
    const ws = mkWorkspace()
    put(ws, BROKEN_CONTENTS[0][1])
    listSessionsState(ws)
    createSession(ws, meta('n1')) // この間に作った会話は、一覧に残らない
    put(ws, JSON.stringify(RESTORED))
    vi.advanceTimersByTime(DEBOUNCE_PAST)
    flushAppSessions()

    resetAppSessionsStore() // 開き直し
    resetChatLogCache()
    const state = listSessionsState(ws)
    expect(state.unreadable).toBeNull()
    expect(state.sessions.map(s => s.id)).toEqual(['x', 'y']) // この間に作った n1 は載らない

    createSession(ws, meta('n2'))
    vi.advanceTimersByTime(DEBOUNCE_PAST)
    expect(JSON.parse(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).map((s: AppSessionMeta) => s.id)).toEqual(['n2', 'x', 'y'])
  })
})

describe('読める索引・無い索引は、今までどおり', () => {
  it('読めた索引: unreadable は null。写しは作らず、会話を作ると待ち時間のあとに書き込む', () => {
    const ws = mkWorkspace()
    put(ws, JSON.stringify([meta('a', { title: '前の会話' })]))

    const state = listSessionsState(ws)
    expect(state.unreadable).toBeNull()
    expect(state.sessions.map(s => s.id)).toEqual(['a'])

    createSession(ws, meta('b'))
    vi.advanceTimersByTime(DEBOUNCE_PAST)

    expect(JSON.parse(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).map((s: AppSessionMeta) => s.id)).toEqual(['b', 'a'])
    expect(copiesOf(ws)).toEqual([])
  })

  it('索引が無い（ENOENT だけが「無い」）: 空の一覧・unreadable は null。写しは作らず、書き込む', () => {
    const ws = mkWorkspace()

    expect(listSessionsState(ws)).toEqual({ sessions: [], unreadable: null })
    createSession(ws, meta('a'))
    vi.advanceTimersByTime(DEBOUNCE_PAST)

    expect(JSON.parse(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).map((s: AppSessionMeta) => s.id)).toEqual(['a'])
    expect(copiesOf(ws)).toEqual([])
  })

  it.each([['空のファイル', ''], ['空白だけのファイル', '  \n']])('%s: 守る中身が無いので読めた空の一覧。写しは作らず、書き込む', (_label, content) => {
    const ws = mkWorkspace()
    put(ws, content)

    expect(listSessionsState(ws)).toEqual({ sessions: [], unreadable: null })
    createSession(ws, meta('a'))
    vi.advanceTimersByTime(DEBOUNCE_PAST)

    expect(JSON.parse(fs.readFileSync(sessionsIndexPath(ws), 'utf-8')).map((s: AppSessionMeta) => s.id)).toEqual(['a'])
    expect(copiesOf(ws)).toEqual([])
  })

  it('空の配列 [] は読めた空の一覧（壊れていない）', () => {
    const ws = mkWorkspace()
    put(ws, '[]')
    expect(listSessionsState(ws)).toEqual({ sessions: [], unreadable: null })
    expect(copiesOf(ws)).toEqual([])
  })

  it('一部の要素が壊れていても、取り出せる会話が1件でもあれば読めた索引（壊れた要素は今までどおり捨てる）', () => {
    const ws = mkWorkspace()
    put(ws, JSON.stringify([meta('a'), { title: 'id なし' }, 5]))
    const state = listSessionsState(ws)
    expect(state.unreadable).toBeNull()
    expect(state.sessions.map(s => s.id)).toEqual(['a'])
    expect(copiesOf(ws)).toEqual([])
  })
})

describe('appSessions:list（本物のハンドラ）は「読めなかった」を運ぶ', () => {
  const callList = (ws: string) => h.handlers.get('appSessions:list')!(null, ws)

  it('壊れた索引: sessions は空、unreadable に写しの名前', async () => {
    const ws = mkWorkspace()
    put(ws, BROKEN_CONTENTS[0][1])
    expect(await callList(ws)).toEqual({ sessions: [], unreadable: { backupName: STAMP } })
  })

  it('写しを作れない回: unreadable は { backupName: null }', async () => {
    const ws = mkWorkspace()
    fs.mkdirSync(sessionsIndexPath(ws), { recursive: true })
    expect(await callList(ws)).toEqual({ sessions: [], unreadable: { backupName: null } })
  })

  it('読めた索引: sessions に会話、unreadable は null', async () => {
    const ws = mkWorkspace()
    put(ws, JSON.stringify([meta('a', { title: '前の会話' })]))
    expect(await callList(ws)).toEqual({
      sessions: [{ id: 'a', title: '前の会話', model: 'preview/Kimi-K2.7-Code', createdAt: 1000 }],
      unreadable: null,
    })
  })

  it('索引が無い: sessions は空、unreadable は null（「読めなかった」と区別できる）', async () => {
    const ws = mkWorkspace()
    expect(await callList(ws)).toEqual({ sessions: [], unreadable: null })
  })

  it('不正な workspaceDir は今までどおり例外', () => {
    expect(() => h.handlers.get('appSessions:list')!(null, 'undefined')).toThrow()
  })
})

// ── 3点セットと、書き込みの止めの置き場所（文字列一致の補助。当て先が他の行に出ないよう、前後ごと書く）──────────
const ROOT = path.join(__dirname, '..')
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
const countOf = (src: string, s: string): number => src.split(s).length - 1

describe('appSessions:list の3点セット（main の返り値・preload・global.d.ts）', () => {
  it('main: list は読み込みの状態（sessions と unreadable）をそのまま返す。一覧だけ返す古い形に戻っていない', () => {
    const src = readCode('src/main/ipc/appSessions.ts')
    expect(src).toContain("ipcMain.handle('appSessions:list', (_, workspaceDir: string) => listSessionsState(workspaceDir))")
    expect(src).not.toContain("ipcMain.handle('appSessions:list', (_, workspaceDir: string) => listSessions(workspaceDir))")
  })

  it('preload: list は返事をそのまま渡す（フィールドを選び直さない）', () => {
    const pre = readCode('src/main/preload.ts')
    expect(countOf(pre, "list: (workspaceDir: string) => ipcRenderer.invoke('appSessions:list', workspaceDir),")).toBe(1)
    expect(pre).not.toContain("ipcRenderer.invoke('appSessions:list', workspaceDir).then")
  })

  it('global.d.ts: list の返事の型は { sessions, unreadable }。会話の配列だけの古い型に戻っていない', () => {
    const d = readCode('src/renderer/global.d.ts')
    const start = d.indexOf('list(workspaceDir: string): Promise<{')
    const end = d.indexOf('create(workspaceDir: string, meta', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = d.slice(start, end)
    expect(block).toContain('sessions: { id: string; title: string; model: string; createdAt: number }[]')
    expect(block).toContain("unreadable: import('../shared/chatUnreadable').UnreadableChat | null")
    expect(d).not.toContain('list(workspaceDir: string): Promise<{ id: string; title: string; model: string; createdAt: number }[]>')
  })
})

describe('appSessionsStore: 索引のファイルへ書く入口は1つ（persistEntry）で、読めない索引の回は書かない', () => {
  const src = readCode('src/main/appSessionsStore.ts')

  it('止めは persistEntry の中の1か所。保存待ちの時間切れと終了時の書き切りが、どちらもそこを通る', () => {
    const start = src.indexOf('function persistEntry(workspaceDir: string, entry: Entry): void {')
    const end = src.indexOf('\n}\n', start)
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, end)
    expect(body).toContain('if (entry.unreadable) return')
    expect(body).toContain('writeIndexNow(workspaceDir, entry.sessions)')
    expect(countOf(src, 'if (entry.unreadable) return')).toBe(1)
    expect(countOf(src, 'persistEntry(workspaceDir, entry)')).toBe(2) // 呼び出しは2か所（時間切れ・書き切り）
    // entry の中身を直に書く古い形（止めを通らない）が残っていない
    expect(countOf(src, 'writeIndexNow(workspaceDir, entry.sessions)')).toBe(1)
  })

  it('索引の読みは readIndexState の1か所。ファイルの有無を existsSync で見て空に倒す古い形に戻っていない', () => {
    expect(src).toContain('const read = readIndexState(workspaceDir)')
    expect(src).not.toContain('fs.existsSync(idxPath) ? readIndexFile(workspaceDir)')
    expect(src).not.toContain('function readIndexFile(')
  })
})
