import { describe, it, expect } from 'vitest'
import { suggestAlternativeRepoName } from '../src/renderer/components/GithubSaveModal'

// 所見28: GitHub保存の保管場所名衝突（422）時のワンクリック代替名提案。
// nameConflict.ts の suggestAlternativeName（既存・十分にテスト済み）を GitHub のリポジトリ名制約
// （文字数上限100・許可文字は safeName で正規化）に合わせてラップした純粋関数のテスト。
describe('suggestAlternativeRepoName', () => {
  it('appends a 4-char suffix from the confusing-character-free charset', () => {
    const name = suggestAlternativeRepoName('myrepo', () => 0)
    expect(name).toMatch(/^myrepo-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/)
  })

  it('is deterministic when the same random function is injected', () => {
    const a = suggestAlternativeRepoName('myrepo', () => 0)
    const b = suggestAlternativeRepoName('myrepo', () => 0)
    expect(a).toBe(b)
  })

  it('normalizes the base through safeName before appending the suffix (spaces/日本語/uppercase)', () => {
    // safeName('My Repo 日本語') -> 'my-repo'（非許可文字はハイフン化・末尾ハイフン除去・小文字化）
    const name = suggestAlternativeRepoName('My Repo 日本語', () => 0)
    expect(name).toBe('my-repo-aaaa')
    expect(name).not.toMatch(/[^a-z0-9._-]/)
  })

  it('keeps the result within the GitHub repo name length limit (100 chars)', () => {
    const longBase = 'a'.repeat(200)
    const name = suggestAlternativeRepoName(longBase, () => 0)
    expect(name.length).toBeLessThanOrEqual(100)
  })

  it('falls back to "project" (via safeName) then "app" suffix base when input becomes empty', () => {
    // safeName('') -> 'project' なので、代替名のベースは 'project' になる
    const name = suggestAlternativeRepoName('', () => 0)
    expect(name.startsWith('project-')).toBe(true)
  })

  it('uses crypto-based randomness by default when no random function is injected', () => {
    const name = suggestAlternativeRepoName('myrepo')
    expect(name).toMatch(/^myrepo-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/)
  })
})
