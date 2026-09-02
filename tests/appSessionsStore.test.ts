// B'-3e-a: 単独チャット（ChatApp）のセッション索引の唯一の持ち主（src/main/appSessionsStore.ts）。
// learningStore.test.ts・convStore.test.ts と同じ流儀: 実ファイル（一時フォルダ）で検証する。
// electron を import しない（workspaceDir は呼び出し側が毎回渡す・グローバル状態を持たないため）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  listSessions, createSession, renameSession, setSessionModel, deleteSession,
  flushAppSessions, setAppSessionsListener, resetAppSessionsStore, type AppSessionMeta,
} from '../src/main/appSessionsStore'
import { sessionDir, sessionsIndexPath } from '../src/shared/appChatDirs'
import { appChatPath } from '../src/main/chatStore/paths'
import { loadConversation, applyConversationOps, resetConversations, flushConversations } from '../src/main/chat/convStore'
import { resetChatLogCache } from '../src/main/chatStore/file'

let tmpDirs: string[] = []
function mkWorkspaceDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-appsessions-'))
  tmpDirs.push(d)
  return d
}

beforeEach(() => {
  tmpDirs = []
  resetAppSessionsStore()
  resetConversations() // 移行が convStore も触るため、そちらのメモリも毎回空にする
  resetChatLogCache()
})
afterEach(() => {
  resetAppSessionsStore()
  resetConversations()
  setAppSessionsListener(null)
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

const meta = (id: string, patch: Partial<AppSessionMeta> = {}): AppSessionMeta => ({
  id, title: '新しい会話', model: 'preview/Kimi-K2.7-Code', createdAt: 1000, ...patch,
})

describe('appSessionsStore: listSessions（未保存・索引ファイルも旧ファイルも無い）', () => {
  it('空配列を返す', () => {
    const ws = mkWorkspaceDir()
    expect(listSessions(ws)).toEqual([])
  })
})

describe('appSessionsStore: CRUD（作成・改名・モデル変更・削除の往復）', () => {
  it('createSession → listSessions で読み戻せる（先頭に足される）', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a', { title: '最初の会話' }))
    createSession(ws, meta('b', { title: '2番目の会話' }))
    expect(listSessions(ws).map(s => s.id)).toEqual(['b', 'a']) // 後から作った方が先頭
  })

  it('createSession は擬似 dir を実際に掘る（convStore が保存できるように）', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a'))
    expect(fs.existsSync(sessionDir(ws, 'a'))).toBe(true)
  })

  it('renameSession でタイトルだけ変わる（他のフィールドは不変）', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a', { title: '旧タイトル', model: 'm1', createdAt: 500 }))
    renameSession(ws, 'a', '新タイトル')
    expect(listSessions(ws)).toEqual([{ id: 'a', title: '新タイトル', model: 'm1', createdAt: 500 }])
  })

  it('setSessionModel でモデルだけ変わる', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a', { model: 'm1' }))
    setSessionModel(ws, 'a', 'm2')
    expect(listSessions(ws)[0].model).toBe('m2')
  })

  it('知らない id への rename/setModel は無視する（例外を投げない・他セッションに影響しない）', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a'))
    expect(() => renameSession(ws, 'ghost', 'x')).not.toThrow()
    expect(() => setSessionModel(ws, 'ghost', 'x')).not.toThrow()
    expect(listSessions(ws)).toHaveLength(1)
  })

  it('deleteSession: 索引から消え、擬似 dir も再帰削除され、convStore のキャッシュも落ちる', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a'))
    const dir = sessionDir(ws, 'a')
    // このセッションに1件保存しておく（convStore にメモリキャッシュが乗っている状態を作る）
    // ※ appSessions.delete は main 側だけで完結する想定のため、ここでは直接 convStore を使う
    // （ChatApp からの実際の書き込みは chat.ops IPC 経由。ここは main 側の削除だけを検証する）。
    applyConversationOps(dir, [{ kind: 'append', msg: { role: 'user', content: 'hi' } }])
    flushConversations()
    expect(fs.existsSync(dir)).toBe(true)

    deleteSession(ws, 'a')
    expect(listSessions(ws)).toEqual([])
    expect(fs.existsSync(dir)).toBe(false) // 擬似 dir が再帰削除されている

    // convStore のキャッシュが落ちている証拠: drop 後に flush してもフォルダが蘇生しない
    flushConversations()
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('知らない id の delete は何もしない（例外を投げない）', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a'))
    expect(() => deleteSession(ws, 'ghost')).not.toThrow()
    expect(listSessions(ws)).toHaveLength(1)
  })

  it('不正な sessionId（パス区切り・..・空）は create/rename/setModel/delete いずれも無視する（掟10）', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('../evil'))
    expect(listSessions(ws)).toEqual([])
    expect(fs.existsSync(path.join(ws, '..', 'evil'))).toBe(false)

    createSession(ws, meta('a'))
    renameSession(ws, '../a', 'x')
    setSessionModel(ws, '..', 'x')
    deleteSession(ws, '')
    expect(listSessions(ws)).toEqual([{ id: 'a', title: '新しい会話', model: 'preview/Kimi-K2.7-Code', createdAt: 1000 }])
  })
})

describe('appSessionsStore: 保存（デバウンス・quit時フラッシュ・ファイルの形）', () => {
  it('create 直後はまだ索引ファイルへ書かれない（1.5秒デバウンス）', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a'))
    expect(fs.existsSync(sessionsIndexPath(ws))).toBe(false)
  })

  it('flushAppSessions でデバウンスを待たずに書かれる', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a', { title: 't', model: 'm', createdAt: 42 }))
    flushAppSessions()
    expect(fs.existsSync(sessionsIndexPath(ws))).toBe(true)
    const raw = JSON.parse(fs.readFileSync(sessionsIndexPath(ws), 'utf-8'))
    expect(raw).toEqual([{ id: 'a', title: 't', model: 'm', createdAt: 42 }])
  })

  it('書いた索引ファイルを、メモリを空にしてから読み直せる', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a'))
    flushAppSessions()
    resetAppSessionsStore()
    expect(listSessions(ws)).toEqual([{ id: 'a', title: '新しい会話', model: 'preview/Kimi-K2.7-Code', createdAt: 1000 }])
  })

  it('保留が無ければ flushAppSessions は何もしない', () => {
    const ws = mkWorkspaceDir()
    listSessions(ws) // 索引ファイルも旧ファイルも無い→保留なし
    flushAppSessions()
    expect(fs.existsSync(sessionsIndexPath(ws))).toBe(false)
  })
})

describe('appSessionsStore: setAppSessionsListener（変更のたび呼ばれる押し出し口）', () => {
  it('create/rename/setModel/delete のたびに最新の一覧で呼ばれる', () => {
    const ws = mkWorkspaceDir()
    const calls: AppSessionMeta[][] = []
    setAppSessionsListener((_ws, sessions) => calls.push(sessions))
    createSession(ws, meta('a'))
    renameSession(ws, 'a', 'x')
    setSessionModel(ws, 'a', 'm2')
    deleteSession(ws, 'a')
    expect(calls).toHaveLength(4)
    expect(calls[3]).toEqual([])
  })

  it('setAppSessionsListener(null) で外せる', () => {
    const ws = mkWorkspaceDir()
    let called = 0
    setAppSessionsListener(() => { called++ })
    setAppSessionsListener(null)
    createSession(ws, meta('a'))
    expect(called).toBe(0)
  })

  it('無視される呼び出し（不正idや知らないid）では呼ばれない', () => {
    const ws = mkWorkspaceDir()
    createSession(ws, meta('a'))
    const calls: unknown[] = []
    setAppSessionsListener((_ws, sessions) => calls.push(sessions))
    renameSession(ws, 'ghost', 'x')
    expect(calls).toHaveLength(0)
  })
})

describe('appSessionsStore: 一度きりの移行（旧 chat-app.json → 各セッション chat.json v2 ＋ 索引）', () => {
  function writeLegacy(ws: string, sessions: any[]): void {
    const p = appChatPath(ws)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(sessions), 'utf-8')
  }

  it('旧ファイルが無ければ、索引は空のまま（何も migrate しない）', () => {
    const ws = mkWorkspaceDir()
    expect(listSessions(ws)).toEqual([])
    expect(fs.existsSync(appChatPath(ws))).toBe(false)
  })

  it('旧ファイルがあれば1回だけ移行する: 索引・各セッション chat.json（v2）・.bak リネーム', () => {
    const ws = mkWorkspaceDir()
    writeLegacy(ws, [
      { id: 's1', title: '会話1', model: 'm1', createdAt: 100, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] },
      { id: 's2', title: '会話2', model: 'm2', createdAt: 200, messages: [] },
    ])

    const list = listSessions(ws)
    expect(list).toEqual([
      { id: 's1', title: '会話1', model: 'm1', createdAt: 100 },
      { id: 's2', title: '会話2', model: 'm2', createdAt: 200 },
    ])

    // 索引ファイルが書かれている
    expect(fs.existsSync(sessionsIndexPath(ws))).toBe(true)

    // 各セッションの chat.json が v2（1行目 {"v":2}）で書かれ、中身も引き継がれている
    const chatPath = path.join(sessionDir(ws, 's1'), '.sakuraide', 'chat.json')
    const raw = fs.readFileSync(chatPath, 'utf-8')
    expect(raw.startsWith('{"v":2}')).toBe(true)
    resetConversations()
    expect(loadConversation(sessionDir(ws, 's1'))).toEqual([
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' },
    ])

    // 旧ファイルは削除ではなくリネーム（保険）
    expect(fs.existsSync(appChatPath(ws))).toBe(false)
    const dirEntries = fs.readdirSync(path.dirname(appChatPath(ws)))
    expect(dirEntries.some(f => f.startsWith('chat-app.json.bak-'))).toBe(true)
  })

  it('2回目の呼び出しは no-op（索引ファイルが既にあるので旧ファイルを見に行かない）', () => {
    const ws = mkWorkspaceDir()
    writeLegacy(ws, [{ id: 's1', title: '会話1', model: 'm1', createdAt: 100, messages: [] }])
    listSessions(ws) // 1回目: 移行が走る
    resetAppSessionsStore() // プロセス再起動を模す（メモリを空にする）
    resetConversations()

    // 索引ファイルが既にあるはずなので、旧ファイル（もう .bak にリネーム済み）を探しに行かず
    // 索引ファイルをそのまま読む。同じ結果が返る（冪等）。
    const second = listSessions(ws)
    expect(second).toEqual([{ id: 's1', title: '会話1', model: 'm1', createdAt: 100 }])
  })

  it('壊れた旧JSONは移行せず、索引は空で始まる。旧ファイルはそのまま残る（安全側）', () => {
    const ws = mkWorkspaceDir()
    const p = appChatPath(ws)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{not valid json', 'utf-8')

    expect(listSessions(ws)).toEqual([])
    expect(fs.existsSync(p)).toBe(true) // リネームされていない＝そのまま残る
    expect(fs.existsSync(sessionsIndexPath(ws))).toBe(false) // 索引ファイルも書かれない
  })

  it('旧JSONが配列でない（想定外の形）場合も移行せず空で始まる', () => {
    const ws = mkWorkspaceDir()
    writeLegacy(ws, { not: 'an array' } as any)
    expect(listSessions(ws)).toEqual([])
    expect(fs.existsSync(appChatPath(ws))).toBe(true)
  })

  it('旧データの id が不正（パス区切り等）なセッションは読み飛ばす（他の正常なセッションは移行される）', () => {
    const ws = mkWorkspaceDir()
    writeLegacy(ws, [
      { id: '../evil', title: '不正', model: 'm', createdAt: 1, messages: [] },
      { id: 'ok', title: '正常', model: 'm', createdAt: 2, messages: [] },
    ])
    expect(listSessions(ws)).toEqual([{ id: 'ok', title: '正常', model: 'm', createdAt: 2 }])
  })
})
