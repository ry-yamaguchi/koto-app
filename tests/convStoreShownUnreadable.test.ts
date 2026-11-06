import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  loadConversation, loadConversationState, applyConversationOps, flushConversations, resetConversations, dropConversation,
} from '../src/main/chat/convStore'
import { projectChatPath } from '../src/main/chatStore/paths'
import { resetChatLogCache } from '../src/main/chatStore/file'

// ── 読めなかった記録を、画面に答えたとおりに扱う（0.6.26）────────────────────────────────────────────
// chat:load（loadConversationState）が画面に「書き込みません」と答えた会話は、最初の書き込み（ensureEntry）が
// 読み直して写しを作れてしまっても書かない。保存先を組み立てられない回は「無い」ではなく読めなかった側に倒す。
// 壊れた行を捨てて読めた分だけを返す回は、読めた分と知らせを一緒に運ぶ。記録は読めても写しが残っている回は、
// その名前を運ぶ。本物の一時フォルダで、返り値とディスクの前後を見る。

const STAMP_NAME = 'chat.json.broken-20261103-142530'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const MSG = { role: 'user', content: '新しい発言' }
const rec = (i: number, content: string) => `{"i":${i},"m":{"role":"user","content":${JSON.stringify(content)}}}`

let tmpDirs: string[] = []
const mkProjectDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-convshown-'))
  tmpDirs.push(d)
  return d
}
const sideOf = (dir: string) => path.dirname(projectChatPath(dir))
const names = (dir: string) => (fs.existsSync(sideOf(dir)) ? fs.readdirSync(sideOf(dir)).sort() : [])
const put = (dir: string, content: string) => {
  fs.mkdirSync(sideOf(dir), { recursive: true })
  fs.writeFileSync(projectChatPath(dir), content)
}

beforeEach(() => {
  tmpDirs = []
  resetConversations()
  resetChatLogCache()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 3, 14, 25, 30))
})
afterEach(() => {
  vi.useRealTimers()
  resetConversations()
  for (const d of tmpDirs) {
    try { fs.chmodSync(sideOf(d), 0o755) } catch { /* 無ければ何もしない */ }
    fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('保存先を組み立てられない回（非文字列・空の projectDir）は「無い」ではなく、読めなかった側', () => {
  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['数値', 123],
    ['null', null],
    ['空文字列', ''],
  ])('%s: messages は null のまま、unreadable は写しなし（backupName: null）。ファイルは何も作られない', (_label, bad) => {
    expect(loadConversation(bad as string)).toBeNull()
    expect(loadConversationState(bad as string)).toEqual({ messages: null, unreadable: { backupName: null } })
  })

  it.each<[string, unknown]>([['undefined', undefined], ['数値', 123], ['空文字列', '']])(
    '%s: 書き込みの前の ensureEntry も、読めなかった側で始める。書き切っても何も書かない',
    (_label, bad) => {
      const stray = path.join(process.cwd(), '.sakuraide')
      const existed = fs.existsSync(stray)
      applyConversationOps(bad as string, [{ kind: 'append', msg: MSG }], { flushNow: true })
      flushConversations()
      expect(loadConversationState(bad as string).unreadable).toEqual({ backupName: null })
      expect(fs.existsSync(stray)).toBe(existed) // 作業場所（cwd）に .sakuraide が作られていない
    }
  )
})

describe('chat:load が「書き込みません」と答えた会話は、あとから写しを作れても書かない', () => {
  // 書けないフォルダ（.sakuraide を読み取り専用）で壊れた記録を開く → 写しを作れず backupName: null
  const openUnwritable = (dir: string, original: string) => {
    put(dir, original)
    fs.chmodSync(sideOf(dir), 0o555)
    const shown = loadConversationState(dir)
    expect(shown).toEqual({ messages: null, unreadable: { backupName: null } })
    return shown
  }

  it.skipIf(isRoot)('権限を直してから最初の書き込みをしても、書き込まない（画面の言葉どおり）。元は変わらない', () => {
    const dir = mkProjectDir()
    const original = '会話の記録ではない文字列'
    openUnwritable(dir, original)
    fs.chmodSync(sideOf(dir), 0o755) // 利用者が権限を直した

    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })
    flushConversations()

    // 読み直した最初の書き込みは写しを作れるが、置き換えない（chat.json は同じ中身のまま、.tmp も無い）
    expect(names(dir).filter((n) => n !== 'chat.json' && !n.startsWith('chat.json.broken-'))).toEqual([])
    expect(fs.readFileSync(projectChatPath(dir), 'utf-8')).toBe(original)
    expect(loadConversationState(dir).unreadable).toEqual({ backupName: null }) // 次の読み込みも同じ答え
  })

  it.skipIf(isRoot)('権限を直し、記録も手で直してから最初の書き込みをした回は、読めるので書く（止めない）', () => {
    const dir = mkProjectDir()
    openUnwritable(dir, '会話の記録ではない文字列')
    fs.chmodSync(sideOf(dir), 0o755)
    put(dir, '{"v":2}\n' + rec(0, '手で直した記録') + '\n') // 読める記録に直した

    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })

    expect(loadConversationState(dir).unreadable).toBeNull()
    expect(names(dir)).toEqual(['chat.json']) // 写しは要らない
    resetConversations()
    resetChatLogCache()
    expect(loadConversation(dir)?.map((m) => m.content)).toEqual(['手で直した記録', '新しい発言'])
  })

  it('写しを作れた回（backupName が文字列）は、今までどおり書き込む。写しに元が残る', () => {
    const dir = mkProjectDir()
    put(dir, '壊れた記録')
    expect(loadConversationState(dir).unreadable).toEqual({ backupName: STAMP_NAME })

    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })

    expect(fs.readFileSync(path.join(sideOf(dir), STAMP_NAME), 'utf-8')).toBe('壊れた記録')
    expect(fs.readFileSync(projectChatPath(dir), 'utf-8').startsWith('{"v":2}')).toBe(true)
  })

  it.skipIf(isRoot)('dropConversation は画面に答えた印も捨てる（その会話を消したあと、同じ場所を開き直しても持ち越さない）', () => {
    const dir = mkProjectDir()
    openUnwritable(dir, '壊れた記録')
    fs.chmodSync(sideOf(dir), 0o755)

    dropConversation(dir) // 会話を削除した（同じ場所に新しい記録が現れる）

    // 印を捨てたので、読み直した最初の書き込みは写しを作って書く
    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })
    expect(names(dir)).toContain(STAMP_NAME)
    expect(fs.readFileSync(projectChatPath(dir), 'utf-8').startsWith('{"v":2}')).toBe(true)
  })
})

describe('壊れた行を捨てて読めた分だけを返す回は、読めた分と知らせを一緒に運ぶ', () => {
  const damaged = ['{"v":2}', rec(0, 'a'), '{"i":1,"m":{"role":"user","con', rec(2, 'c')].join('\n') + '\n'

  it('loadConversationState: messages に読めた分、unreadable に写しの名前。写しは元と同じ中身', () => {
    const dir = mkProjectDir()
    put(dir, damaged)

    const state = loadConversationState(dir)

    expect(state.messages?.map((m) => m.content)).toEqual(['a'])
    expect(state.unreadable).toEqual({ backupName: STAMP_NAME })
    expect(fs.readFileSync(path.join(sideOf(dir), STAMP_NAME), 'utf-8')).toBe(damaged)
    expect(loadConversation(dir)?.map((m) => m.content)).toEqual(['a']) // 旧 localStorage の移行の判定: null ではない
  })

  it('書き込みの前の ensureEntry は、読めた分から始める（空にしない）。書いたあとも写しは元のまま', () => {
    const dir = mkProjectDir()
    put(dir, damaged)

    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })

    expect(fs.readFileSync(path.join(sideOf(dir), STAMP_NAME), 'utf-8')).toBe(damaged)
    resetConversations()
    resetChatLogCache()
    expect(loadConversation(dir)?.map((m) => m.content)).toEqual(['a', '新しい発言'])
    expect(loadConversationState(dir).unreadable).toBeNull() // きれいに書き直したので、次からは読めた記録
  })

  it.skipIf(isRoot)('書けないフォルダでは写しを作れず、書き込まない。読めた分は画面に映す', () => {
    const dir = mkProjectDir()
    put(dir, damaged)
    fs.chmodSync(sideOf(dir), 0o555)

    const state = loadConversationState(dir)
    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })
    flushConversations()
    fs.chmodSync(sideOf(dir), 0o755)

    expect(state.messages?.map((m) => m.content)).toEqual(['a'])
    expect(state.unreadable).toEqual({ backupName: null })
    expect(names(dir)).toEqual(['chat.json'])
    expect(fs.readFileSync(projectChatPath(dir), 'utf-8')).toBe(damaged)
  })
})

describe('記録は読めても、読めなかった記録の写しが残っている会話は、その名前を copies で運ぶ', () => {
  it('壊れた記録に書き足したあと、開き直す（記憶を捨てる）と、読めた記録＋写しの名前', () => {
    const dir = mkProjectDir()
    put(dir, '壊れた記録')
    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })
    resetConversations() // 再起動
    resetChatLogCache()

    const state = loadConversationState(dir)

    expect(state.unreadable).toBeNull()
    expect(state.messages?.map((m) => m.content)).toEqual(['新しい発言'])
    expect(state.copies).toEqual([STAMP_NAME])
  })

  it('メモリに載っている会話も、写しが残っていれば名前を運ぶ（読めなかった印があるあいだは運ばない）', () => {
    const dir = mkProjectDir()
    put(dir, '壊れた記録')
    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })
    // 読めなかった印がメモリに残っている回: unreadable が写しの名前を運ぶので、copies は付けない
    expect(loadConversationState(dir)).toEqual({ messages: [expect.objectContaining(MSG)], unreadable: { backupName: STAMP_NAME } })
    expect('copies' in loadConversationState(dir)).toBe(false)
  })

  it('写しが無い会話・ファイルが無い会話には copies を付けない', () => {
    const dir = mkProjectDir()
    expect('copies' in loadConversationState(dir)).toBe(false) // ファイルが無い
    applyConversationOps(dir, [{ kind: 'append', msg: MSG }], { flushNow: true })
    resetConversations()
    resetChatLogCache()
    const state = loadConversationState(dir)
    expect(state.unreadable).toBeNull()
    expect('copies' in state).toBe(false)
  })

  it('保存先を組み立てられない回は、写しを調べずに空として扱う（例外にしない）', () => {
    expect(() => loadConversationState(undefined as unknown as string)).not.toThrow()
  })
})
