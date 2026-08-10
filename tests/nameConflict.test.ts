import { describe, it, expect } from 'vitest'
import { isNameConflictError, isCreationLimitError, suggestAlternativeName } from '../src/renderer/nameConflict'

describe('isCreationLimitError', () => {
  it('AppRunの作成上限エラー（2026-07-12 実例の文言）を検出する', () => {
    const real = 'AppRunアプリ『newproject』の作成に失敗しました（HTTP 400） — {"error":{"code":400,"message":"Validation Error","errors":[{"domain":"global","reason":"violates application restriction","message":"Creation limit reached.","location_type":"body"}]}}'
    expect(isCreationLimitError(real)).toBe(true)
    expect(isCreationLimitError('Creation limit reached.')).toBe(true)
    expect(isCreationLimitError('violates application restriction')).toBe(true)
    expect(isCreationLimitError('アプリ数が上限に達しました')).toBe(true)
  })

  it('名前衝突や無関係のエラーでは false（衝突提案と誤って同時表示されない）', () => {
    expect(isCreationLimitError('Application name already exists')).toBe(false)
    expect(isCreationLimitError('認証に失敗しました（401）')).toBe(false)
    expect(isCreationLimitError('')).toBe(false)
  })

  it('作成上限の実例文言は名前衝突とは判定されない（相互排他）', () => {
    expect(isNameConflictError('Creation limit reached. violates application restriction')).toBe(false)
  })
})

describe('isNameConflictError', () => {
  it('returns true when status is 409, regardless of message', () => {
    expect(isNameConflictError('any message', 409)).toBe(true)
    expect(isNameConflictError('', 409)).toBe(true)
  })

  it('returns false for other status codes even with unrelated message', () => {
    expect(isNameConflictError('認証に失敗しました', 401)).toBe(false)
    expect(isNameConflictError('サーバエラー', 500)).toBe(false)
  })

  it('returns true for known English conflict phrases', () => {
    expect(isNameConflictError('Application name already exists')).toBe(true)
    expect(isNameConflictError('application exists for this workspace')).toBe(true)
    expect(isNameConflictError('Error: conflict')).toBe(true)
  })

  it('returns true for known Japanese conflict phrases', () => {
    expect(isNameConflictError('この名前は既に使われています')).toBe(true)
    expect(isNameConflictError('名前が利用されています')).toBe(true)
    expect(isNameConflictError('重複したリソースがあります')).toBe(true)
  })

  it('is case-insensitive for English phrases', () => {
    expect(isNameConflictError('CONFLICT')).toBe(true)
    expect(isNameConflictError('Already Exists')).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isNameConflictError('認証に失敗しました（HTTP 401）')).toBe(false)
    expect(isNameConflictError('ネットワークエラーです')).toBe(false)
    expect(isNameConflictError('')).toBe(false)
  })

  it('does not throw on non-string message', () => {
    // @ts-expect-error 呼び出し側の型崩れ（undefined等）に対する防御を確認する
    expect(isNameConflictError(undefined)).toBe(false)
  })

  // IPC層は多くの場合 status を渡さず「（HTTP 409）」のように文字列へ埋め込む（ユーザー指摘 2026-07-12）。
  it('detects an embedded "（HTTP 409）" notation (full-width parens) in the message', () => {
    expect(isNameConflictError('公開に失敗しました（HTTP 409）: {"error":"conflict"}')).toBe(true)
  })

  it('detects an embedded "(HTTP 409)" notation (half-width parens) in the message', () => {
    expect(isNameConflictError('Failed to publish (HTTP 409): duplicate')).toBe(true)
  })

  it('does not react to other status codes embedded the same way', () => {
    expect(isNameConflictError('認証に失敗しました（HTTP 401）')).toBe(false)
  })

  it('does not react when the digits merely start with 409 (e.g. 4090)', () => {
    expect(isNameConflictError('不明なエラー（HTTP 4090）')).toBe(false)
    expect(isNameConflictError('HTTP 4090')).toBe(false)
  })

  it('detects the newly added "duplicat" phrase (case-insensitive)', () => {
    expect(isNameConflictError('Duplicate application name')).toBe(true)
  })

  it('detects the newly added "既に" phrase', () => {
    expect(isNameConflictError('この名前は既に使用されています')).toBe(true)
  })

  it('still does not react to a bare "exist" (e.g. "does not exist") to avoid false positives', () => {
    expect(isNameConflictError('指定されたリソースは exist しません')).toBe(false)
    expect(isNameConflictError('The resource does not exist')).toBe(false)
  })
})

describe('suggestAlternativeName', () => {
  it('appends a 4-char suffix from the confusing-character-free charset', () => {
    const name = suggestAlternativeName('myapp', 40, () => 0)
    expect(name).toMatch(/^myapp-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/)
  })

  it('is deterministic when the same random function is injected', () => {
    const a = suggestAlternativeName('myapp', 40, () => 0)
    const b = suggestAlternativeName('myapp', 40, () => 0)
    expect(a).toBe(b)
  })

  it('produces different suffixes for different random sequences', () => {
    const a = suggestAlternativeName('myapp', 40, () => 0)
    const b = suggestAlternativeName('myapp', 40, () => 0.9)
    expect(a).not.toBe(b)
  })

  it('never uses confusing characters (0/1/i/l/o) in the suffix', () => {
    for (let i = 0; i <= 10; i++) {
      const r = Math.min(i / 10, 0.999)
      const name = suggestAlternativeName('base', 40, () => r)
      const suffix = name.split('-').pop()!
      expect(suffix).toHaveLength(4)
      expect(suffix).not.toMatch(/[01ilo]/i)
    }
  })

  it('strips trailing hyphens from base before appending the suffix', () => {
    const name = suggestAlternativeName('myapp---', 40, () => 0)
    expect(name.startsWith('myapp-')).toBe(true)
    expect(name).not.toContain('myapp----')
  })

  it('truncates base so the result fits within maxLen', () => {
    const longBase = 'a'.repeat(50)
    const name = suggestAlternativeName(longBase, 20, () => 0)
    expect(name.length).toBeLessThanOrEqual(20)
    expect(name).toMatch(/^a+-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/)
  })

  it('falls back to "app" when base becomes empty after trimming hyphens', () => {
    const name = suggestAlternativeName('----', 40, () => 0)
    expect(name.startsWith('app-')).toBe(true)
  })

  it('uses crypto-based randomness by default when no random function is injected', () => {
    const name = suggestAlternativeName('myapp', 40)
    expect(name).toMatch(/^myapp-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/)
  })

  it('two default (crypto-random) calls are very unlikely to collide', () => {
    const a = suggestAlternativeName('myapp', 40)
    const b = suggestAlternativeName('myapp', 40)
    // 31^4 通りあるため、たまたま衝突する確率は無視できるほど小さい（フレーク耐性のため exact 一致以外は許容しない設計）。
    expect(a).not.toBe(b)
  })
})
