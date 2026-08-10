// チャット履歴のファイル保存（<project>/.sakuraide/chat.json ほか）の純粋ロジックのテスト。
// 対象: src/main/chatStore/paths.ts（保存先パス組み立て・封じ込め・JSON検証）、
//       src/renderer/chatMigration.ts（ファイル→localStorage移行→空 の優先順位判定）、
//       除外リスト（.sakuraide が GitHub保存の SKIP_DIRS に入っていること）。
import { describe, it, expect } from 'vitest'
import { projectChatPath, appChatPath, isValidJson } from '../src/main/chatStore/paths'
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
