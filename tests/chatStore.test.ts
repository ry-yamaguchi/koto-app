// チャット履歴のファイル保存（<project>/.sakuraide/chat.json ほか）の純粋ロジックのテスト。
// 対象: src/main/chatStore/paths.ts（保存先パス組み立て・封じ込め・JSON検証）、
//       src/renderer/chatMigration.ts（ファイル→localStorage移行→空 の優先順位判定）、
//       除外リスト（.sakuraide が GitHub保存の SKIP_DIRS に入っていること）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { projectChatPath, appChatPath, isValidJson } from '../src/main/chatStore/paths'
import { loadProjectChatFile, resetChatLogCache } from '../src/main/chatStore/file'
import { isBlankChatLog } from '../src/main/chatStore/log'
import { parseJsonArray, resolveChatSource } from '../src/renderer/chatMigration'
import { SKIP_DIRS } from '../src/main/github/enumerate'

describe('chatStore paths', () => {
  it('プロジェクト別チャットの保存先は <project>/.sakuraide/chat.json', () => {
    expect(projectChatPath('/Users/x/SAKURAIDE/myapp')).toBe('/Users/x/SAKURAIDE/myapp/.sakuraide/chat.json')
  })

  it('単独チャットの保存先は <workspace>/.sakuraide/chats/chat-app.json', () => {
    expect(appChatPath('/Users/x/SAKURAIDE')).toBe('/Users/x/SAKURAIDE/.sakuraide/chats/chat-app.json')
  })

  it('ルート末尾のスラッシュを正規化して同じ場所を指す', () => {
    expect(projectChatPath('/Users/x/myapp/')).toBe('/Users/x/myapp/.sakuraide/chat.json')
  })

  it('isValidJson: 正常なJSON文字列のみ許可（空・壊れたJSON・非文字列は不可）', () => {
    expect(isValidJson('[]')).toBe(true)
    expect(isValidJson('{"a":1}')).toBe(true)
    expect(isValidJson('')).toBe(false)
    expect(isValidJson('{oops')).toBe(false)
    expect(isValidJson(null)).toBe(false)
    expect(isValidJson(123 as unknown)).toBe(false)
  })
})

describe('chatMigration', () => {
  it('parseJsonArray: 配列のJSONだけを配列として返す', () => {
    expect(parseJsonArray('[1,2]')).toEqual([1, 2])
    expect(parseJsonArray('{"a":1}')).toBeNull() // 配列でない
    expect(parseJsonArray('broken')).toBeNull()
    expect(parseJsonArray(null)).toBeNull()
    expect(parseJsonArray(undefined)).toBeNull()
    expect(parseJsonArray('')).toBeNull()
  })

  it('resolveChatSource: ファイルがあれば常にファイル優先（localStorage は見ない）', () => {
    expect(resolveChatSource([1], [2])).toEqual({ kind: 'file', data: [1] })
    // 空配列のファイルも「ファイルあり」として尊重する（消した履歴が旧localStorageから蘇らないように）
    expect(resolveChatSource([], [2])).toEqual({ kind: 'file', data: [] })
  })

  it('resolveChatSource: ファイルが無く localStorage 旧形式があれば移行', () => {
    expect(resolveChatSource(null, [2])).toEqual({ kind: 'migrate', data: [2] })
  })

  it('resolveChatSource: どちらも無ければ empty', () => {
    expect(resolveChatSource(null, null)).toEqual({ kind: 'empty' })
  })
})

describe('公開物・保存からの除外', () => {
  it('GitHub保存の SKIP_DIRS に .sakuraide が入っている（チャット履歴に秘密情報が混ざり得るため）', () => {
    expect(SKIP_DIRS.has('.sakuraide')).toBe(true)
    expect(SKIP_DIRS.has('.sakuraide-backup')).toBe(true) // 既存の除外も維持
  })
})

// ── 壊れた chat.json を「無い」と区別し、読んだ時点で写しを残す（0.6.26）──────────────────
// 本物の一時フォルダで、loadProjectChatFile の呼び出し結果と、フォルダの前後を見る。
// ソースの文字列は見ない（実装を壊したら落ちることは、ミューテーションで確かめる）。
describe('loadProjectChatFile: 壊れた記録は「無い」と区別し、読んだ時点で写しを残す', () => {
  const COPY_PREFIX = 'chat.json.broken-'
  const STAMP_NAME = 'chat.json.broken-20261103-142530'
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

  let dir = ''
  let file = ''
  const side = () => path.dirname(file)
  const names = () => fs.readdirSync(side()).sort()
  const copyNames = () => names().filter((n) => n.startsWith(COPY_PREFIX))
  const put = (content: string | Buffer) => {
    fs.mkdirSync(side(), { recursive: true })
    fs.writeFileSync(file, content)
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-broken-'))
    file = projectChatPath(dir)
    resetChatLogCache() // 読んだ写しの記憶も含めて、起動し直した状態から始める
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 3, 14, 25, 30))
  })
  afterEach(() => {
    vi.useRealTimers()
    try { fs.chmodSync(side(), 0o755) } catch { /* 無ければ何もしない */ }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // 壊れた記録の表。v1 と v2 の混在は、v1 の配列のあとに v2 の行が続く形（foldChatLog は丸ごと読めない）
  const BROKEN: Array<[string, string | Buffer]> = [
    ['JSON でない文字列', 'これは会話の記録ではありません'],
    ['途中で切れた v1', '[{"role":"user","content":"a"},{"role":"assis'],
    ['v1 と v2 の混在', '[{"role":"user","content":"a"}]\n{"i":1,"m":{"role":"user","content":"b"}}\n'],
    ['v の無い JSON オブジェクト', '{"a":1}\n'],
    ['v2 の先頭行が壊れている', '{"v":2\n{"i":0,"m":{"role":"user","content":"a"}}\n'],
    ['UTF-8 として読めないバイト列', Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0x0a])],
  ]

  it.each(BROKEN)('%s: unreadable で返り、元と同じ中身の写しが1つできる。元はその場に残る', (_label, content) => {
    put(content)
    const before = fs.readFileSync(file)

    expect(loadProjectChatFile(file)).toEqual({ ok: true, json: null, unreadable: { backupName: STAMP_NAME } })

    expect(names()).toEqual(['chat.json', STAMP_NAME]) // 増えたのは写しだけ
    expect(fs.readFileSync(path.join(side(), STAMP_NAME)).equals(before)).toBe(true) // 中身が元と同じ
    expect(fs.readFileSync(file).equals(before)).toBe(true) // 元は消えず、名前も変わらず、中身も同じ
  })

  it('ファイルが無い回は今までどおり { ok: true, json: null } で、写しを作らず、フォルダも作らない', () => {
    expect(loadProjectChatFile(file)).toEqual({ ok: true, json: null })
    expect(fs.existsSync(side())).toBe(false)
  })

  it('空のファイル・空白だけのファイルは「未保存」と同じ。写しを作らない（守る中身が無い）', () => {
    for (const content of ['', '  \n\n']) {
      put(content)
      const r = loadProjectChatFile(file)
      expect(r).toEqual({ ok: true, json: null })
      expect('unreadable' in r).toBe(false)
      expect(copyNames()).toEqual([])
    }
  })

  it('読める記録（v1・v2・v2 の末尾切れ・ヘッダだけ）は unreadable を付けず、写しも作らない', () => {
    const rows: Array<[string, string]> = [
      ['v1', '[{"role":"user","content":"a"}]'],
      ['v2', '{"v":2}\n{"i":0,"m":{"role":"user","content":"a"}}\n'],
      ['v2 の末尾が切れている', '{"v":2}\n{"i":0,"m":{"role":"user","content":"a"}}\n{"i":1,"m":{"rol'],
      ['v2 のヘッダだけ', '{"v":2}\n'],
    ]
    for (const [, content] of rows) {
      put(content)
      const r = loadProjectChatFile(file)
      expect(r.ok).toBe(true)
      expect((r as { json: string | null }).json).not.toBeNull()
      expect('unreadable' in r).toBe(false)
      expect(copyNames()).toEqual([])
    }
  })

  it('同じ壊れた記録を続けて2回読んでも、写しは1つ（名前も同じ）', () => {
    put('壊れた記録')
    const a = loadProjectChatFile(file)
    vi.setSystemTime(new Date(2026, 10, 3, 14, 25, 45)) // 日時が進んでも新しい写しを作らない
    const b = loadProjectChatFile(file)
    expect(b).toEqual(a)
    expect(copyNames()).toEqual([STAMP_NAME])
  })

  it('アプリを起動し直したあと（記憶が空）でも、同じ中身の写しがあれば新しく作らず、その名前を返す', () => {
    put('壊れた記録')
    loadProjectChatFile(file)
    resetChatLogCache() // 再起動
    vi.setSystemTime(new Date(2026, 10, 4, 9, 0, 0))
    expect(loadProjectChatFile(file)).toEqual({ ok: true, json: null, unreadable: { backupName: STAMP_NAME } })
    expect(copyNames()).toEqual([STAMP_NAME])
  })

  it('中身が違う壊れ方をしたら、別の写しを作る。前の写しは残る（同じ秒でも上書きしない）', () => {
    put('壊れた記録1')
    loadProjectChatFile(file)
    put('壊れた記録2（別の壊れ方）')
    expect(loadProjectChatFile(file)).toEqual({ ok: true, json: null, unreadable: { backupName: `${STAMP_NAME}-2` } })
    expect(fs.readFileSync(path.join(side(), STAMP_NAME), 'utf-8')).toBe('壊れた記録1')
    expect(fs.readFileSync(path.join(side(), `${STAMP_NAME}-2`), 'utf-8')).toBe('壊れた記録2（別の壊れ方）')
  })

  it('写しを手で消したあとに読み直すと、写しを作り直す（「残してあります」を偽にしない）', () => {
    put('壊れた記録')
    loadProjectChatFile(file)
    fs.rmSync(path.join(side(), STAMP_NAME))
    expect(loadProjectChatFile(file)).toEqual({ ok: true, json: null, unreadable: { backupName: STAMP_NAME } })
    expect(copyNames()).toEqual([STAMP_NAME])
  })

  it('読めない（ファイルの代わりにフォルダがある）回は「無い」ではなく unreadable（写しは作れない）。何も書き足さない', () => {
    fs.mkdirSync(file, { recursive: true }) // chat.json という名前のフォルダ
    expect(loadProjectChatFile(file)).toEqual({ ok: true, json: null, unreadable: { backupName: null } })
    expect(names()).toEqual(['chat.json'])
  })

  it.skipIf(isRoot)('読めない（権限を外したファイル）回は unreadable で、写しは作れない。中身は変わらない', () => {
    put('権限を外す前の中身')
    fs.chmodSync(file, 0o000)
    try {
      expect(loadProjectChatFile(file)).toEqual({ ok: true, json: null, unreadable: { backupName: null } })
      expect(names()).toEqual(['chat.json'])
    } finally {
      fs.chmodSync(file, 0o644)
    }
    expect(fs.readFileSync(file, 'utf-8')).toBe('権限を外す前の中身')
  })

  it.skipIf(isRoot)('書けないフォルダ（.sakuraide を読み取り専用）の壊れた記録は、写しを作れず backupName が null。元は変わらない', () => {
    put('壊れた記録')
    fs.chmodSync(side(), 0o555)
    expect(loadProjectChatFile(file)).toEqual({ ok: true, json: null, unreadable: { backupName: null } })
    fs.chmodSync(side(), 0o755)
    expect(names()).toEqual(['chat.json'])
    expect(fs.readFileSync(file, 'utf-8')).toBe('壊れた記録')
  })

  it('旧口の chat:loadProject が呼ぶ loadProjectChatFile も同じ判定を通る（結果は ok:true のまま unreadable が付く）', () => {
    put('壊れた記録')
    const r = loadProjectChatFile(file)
    expect(r.ok).toBe(true)
    expect((r as { unreadable?: { backupName: string | null } }).unreadable?.backupName).toBe(STAMP_NAME)
  })
})

describe('isBlankChatLog: 空・空白だけは壊れたものと区別する', () => {
  it('空文字列・空白・改行だけは true、中身があれば false', () => {
    expect(isBlankChatLog('')).toBe(true)
    expect(isBlankChatLog(' \n\t ')).toBe(true)
    expect(isBlankChatLog('[]')).toBe(false)
    expect(isBlankChatLog('x')).toBe(false)
  })
})
