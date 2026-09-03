// B'-3e-a/B'-3e-b: 単独チャット（ChatApp）のセッション置き場の一元定義（src/shared/appChatDirs.ts）。
// 純関数のみ・electron 非依存なので実ファイルシステムを介さず直接検証できる。
import { describe, it, expect } from 'vitest'
import {
  APP_CHAT_DIRNAME, sessionDir, sessionIdFromDir, sessionsIndexPath,
  isValidSessionId, isValidWorkspaceDir,
} from '../src/shared/appChatDirs'

describe('appChatDirs: APP_CHAT_DIRNAME', () => {
  it('ドット始まり（公開物・通常表示に混ざらない場所）', () => {
    expect(APP_CHAT_DIRNAME.startsWith('.')).toBe(true)
  })
})

describe('appChatDirs: sessionDir', () => {
  it('workspaceDir / APP_CHAT_DIRNAME / sessions / sessionId の形になる', () => {
    expect(sessionDir('/Users/x/SAKURAIDE', 'abc123')).toBe(
      `/Users/x/SAKURAIDE/${APP_CHAT_DIRNAME}/sessions/abc123`
    )
  })

  it('セッションごとに別の擬似dirになる（衝突しない）', () => {
    const a = sessionDir('/ws', '1')
    const b = sessionDir('/ws', '2')
    expect(a).not.toBe(b)
  })
})

describe('appChatDirs: sessionIdFromDir（sessionDir の逆関数・B\'-3e-b）', () => {
  it('★★ 正しい dir → 対応する sessionId', () => {
    expect(sessionIdFromDir('/ws', sessionDir('/ws', 'abc123'))).toBe('abc123')
  })

  it('★★ 他所（別ワークスペース）の dir → null', () => {
    expect(sessionIdFromDir('/other-ws', sessionDir('/ws', 'abc123'))).toBeNull()
  })

  it('★★ ワークスペース直下（sessions/<id>）ではない形 → null', () => {
    // セッション一覧の索引（sessions.json 自体）
    expect(sessionIdFromDir('/ws', sessionsIndexPath('/ws'))).toBeNull()
    // sessions/ の直下ではなく、さらにネストしている
    expect(sessionIdFromDir('/ws', `/ws/${APP_CHAT_DIRNAME}/sessions/a/b`)).toBeNull()
    // sessions/ 自体（id が空）
    expect(sessionIdFromDir('/ws', `/ws/${APP_CHAT_DIRNAME}/sessions/`)).toBeNull()
    // 全く関係ないパス
    expect(sessionIdFromDir('/ws', '/ws/some/other/path')).toBeNull()
  })

  it('id に .. や / を含む不正な形は通さない（sessionDir が組み立てない形をここでも拒む）', () => {
    expect(sessionIdFromDir('/ws', `/ws/${APP_CHAT_DIRNAME}/sessions/..`)).toBeNull()
  })
})

describe('appChatDirs: sessionsIndexPath', () => {
  it('workspaceDir / APP_CHAT_DIRNAME / sessions.json の形になる', () => {
    expect(sessionsIndexPath('/Users/x/SAKURAIDE')).toBe(`/Users/x/SAKURAIDE/${APP_CHAT_DIRNAME}/sessions.json`)
  })

  it('sessionDir と同じ APP_CHAT_DIRNAME を共有する（既存 appChatPath の隣ではなく単独チャット専用フォルダの中に索引がある）', () => {
    const idx = sessionsIndexPath('/ws')
    const dir = sessionDir('/ws', 'x')
    expect(idx.startsWith(`/ws/${APP_CHAT_DIRNAME}/`)).toBe(true)
    expect(dir.startsWith(`/ws/${APP_CHAT_DIRNAME}/`)).toBe(true)
  })
})

describe('appChatDirs: isValidSessionId — 止めるべき例', () => {
  it.each([
    ['空文字', ''],
    ['..', '..'],
    ['.', '.'],
    ['親ディレクトリへの相対参照', '../x'],
    ['スラッシュを含む', 'a/b'],
    ['バックスラッシュを含む（Windows区切り）', 'a\\b'],
    ['先頭がスラッシュ（絶対パス化）', '/etc/passwd'],
    ['数値（文字列でない）', 123 as any],
    ['null', null as any],
    ['undefined', undefined as any],
    ['オブジェクト', { id: 'x' } as any],
  ])('%s は拒否する', (_label, id) => {
    expect(isValidSessionId(id)).toBe(false)
  })
})

describe('appChatDirs: isValidSessionId — 通すべき例', () => {
  it.each([
    ['newSession() が作る形（Date.now().toString()）', Date.now().toString()],
    ['ハイフンを含む一般的なID', 'abc-123-def'],
    ['英数字のみ', 'session1'],
    ['ドットを含むが単独の .. ではない', 'a.b.c'],
  ])('%s は許可する', (_label, id) => {
    expect(isValidSessionId(id)).toBe(true)
  })

  it('通した id を sessionDir へ渡すと、常に workspaceDir 配下に収まる', () => {
    const ids = [Date.now().toString(), 'abc-123', 'session1']
    for (const id of ids) {
      expect(isValidSessionId(id)).toBe(true)
      const dir = sessionDir('/ws', id)
      expect(dir.startsWith('/ws/')).toBe(true)
      expect(dir).not.toContain('..')
    }
  })
})

// ── isValidWorkspaceDir（#16・掟10）──────────────────────────────────────
// appSessionsStore.ts の全公開関数の入口で使う「守り」。実事故（相対パス "undefined" が
// cwd 相対に書いた）を再発させないための検証。
describe('appChatDirs: isValidWorkspaceDir — 止めるべき例', () => {
  it.each([
    ['空文字', ''],
    ['相対パス', 'undefined'],
    ['相対パス（サブパス付き）', 'SAKURAIDE/myproj'],
    ['.. を含む（絶対パスの中でも）', '/Users/x/../etc'],
    ['.. そのもの', '..'],
    ['NUL を含む', '/Users/x\0/evil'],
    ['数値（文字列でない）', 123 as any],
    ['null', null as any],
    ['undefined 値', undefined as any],
    ['オブジェクト', { dir: '/x' } as any],
  ])('%s は拒否する', (_label, dir) => {
    expect(isValidWorkspaceDir(dir)).toBe(false)
  })
})

describe('appChatDirs: isValidWorkspaceDir — 通すべき例', () => {
  it.each([
    ['単純な絶対パス', '/Users/x/SAKURAIDE'],
    ['ルート直下', '/tmp'],
    ['ドットを含むが親参照ではない', '/Users/x/my.workspace'],
    ['末尾スラッシュあり', '/Users/x/SAKURAIDE/'],
  ])('%s は許可する', (_label, dir) => {
    expect(isValidWorkspaceDir(dir)).toBe(true)
  })
})

// ── renderer から import される shared に node 組み込みを持ち込ませない（2026-09-02 実測）────
//
// vite は node 組み込み（path/fs 等）を**空の shim**にするため、型もビルドも通るのに
// 実行時に `(void 0) is not a function` で死ぬ（appChatDirs の path.join で ChatApp が
// 起動できなかった）。「型が通ることは繋がっている証拠にならない」（掟10）の renderer 版。
// sigv4.ts（node:crypto）だけは main 専用として許す（renderer から import しないこと）。
import * as fs from 'fs'
import * as path from 'path'
describe('shared は node 組み込みを import しない（renderer で空 shim になり実行時に死ぬ）', () => {
  it('★★ src/shared/*.ts に path/fs の import が無い（sigv4.ts の node:crypto だけ例外）', () => {
    const dir = path.join(__dirname, '..', 'src/shared')
    const offenders: string[] = []
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      if (f === 'sigv4.ts') continue // main 専用（S3署名）。renderer から import しないこと
      const src = fs.readFileSync(path.join(dir, f), 'utf-8')
      if (/from ['"](?:node:)?(?:path|fs|crypto|os|child_process|net)['"]/.test(src)) offenders.push(f)
    }
    expect(offenders, `node 組み込みを import している: ${offenders.join(', ')}`).toEqual([])
  })
})
