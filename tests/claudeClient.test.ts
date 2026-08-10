import { describe, it, expect } from 'vitest'
import {
  describeClaudeError, parseModelsCount, parseAnthropicModels, toUnpackedPath, candidatePackageNames,
} from '../src/main/claude/client'

describe('parseModelsCount', () => {
  it('returns the length of a data array', () => {
    expect(parseModelsCount({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })).toBe(3)
  })

  it('returns 0 for an empty data array', () => {
    expect(parseModelsCount({ data: [] })).toBe(0)
  })

  it('returns null when data is missing', () => {
    expect(parseModelsCount({})).toBeNull()
  })

  it('returns null when data is not an array', () => {
    expect(parseModelsCount({ data: 'not-an-array' })).toBeNull()
  })

  it('returns null for null/undefined input', () => {
    expect(parseModelsCount(null)).toBeNull()
    expect(parseModelsCount(undefined)).toBeNull()
  })
})

// ── claude:models（ライブ取得）で使う応答パース ────────────────────────
describe('parseAnthropicModels', () => {
  it('maps id/display_name/created_at, preserving the API order (newest-first)', () => {
    const json = {
      data: [
        { id: 'claude-opus-5', type: 'model', display_name: 'Claude Opus 5', created_at: '2026-07-01T00:00:00Z' },
        { id: 'claude-sonnet-5', type: 'model', display_name: 'Claude Sonnet 5', created_at: '2026-06-01T00:00:00Z' },
      ],
    }
    expect(parseAnthropicModels(json)).toEqual([
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', createdAt: '2026-07-01T00:00:00Z' },
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', createdAt: '2026-06-01T00:00:00Z' },
    ])
  })

  it('falls back displayName to id and createdAt to "" when missing/non-string', () => {
    const json = { data: [{ id: 'claude-new-model' }] }
    expect(parseAnthropicModels(json)).toEqual([{ id: 'claude-new-model', displayName: 'claude-new-model', createdAt: '' }])
  })

  it('skips entries whose id is missing or non-string', () => {
    const json = { data: [{ id: 'claude-a' }, { display_name: 'no id' }, { id: 42 }, null] }
    expect(parseAnthropicModels(json)).toEqual([{ id: 'claude-a', displayName: 'claude-a', createdAt: '' }])
  })

  it('returns an empty array when data is missing or not an array', () => {
    expect(parseAnthropicModels({})).toEqual([])
    expect(parseAnthropicModels({ data: 'not-an-array' })).toEqual([])
    expect(parseAnthropicModels(null)).toEqual([])
    expect(parseAnthropicModels(undefined)).toEqual([])
  })
})

describe('describeClaudeError', () => {
  it('gives a Japanese re-issue guidance message for 401', () => {
    const msg = describeClaudeError(401)
    expect(msg).toContain('401')
    expect(msg).toContain('platform.claude.com')
    expect(msg).not.toContain('Claude Code') // ブランディング制約: 「Claude Code」表記は使用不可
  })

  it('gives an access-denied message for 403', () => {
    expect(describeClaudeError(403)).toContain('403')
  })

  it('gives a rate-limit message for 429', () => {
    expect(describeClaudeError(429)).toContain('429')
  })

  it('gives a generic server-side message for 5xx', () => {
    expect(describeClaudeError(500)).toContain('500')
    expect(describeClaudeError(503)).toContain('503')
  })

  it('gives a generic message for other statuses', () => {
    expect(describeClaudeError(404)).toBe('接続に失敗しました（HTTP 404）')
  })
})

describe('toUnpackedPath', () => {
  it('replaces app.asar with app.asar.unpacked in a packaged path', () => {
    const p = '/Applications/Koto.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    expect(toUnpackedPath(p)).toBe(
      '/Applications/Koto.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    )
  })

  it('leaves a development (non-asar) path unchanged', () => {
    const p = '/Users/dev/sakura-ide/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    expect(toUnpackedPath(p)).toBe(p)
  })

  it('is idempotent when the path already contains app.asar.unpacked', () => {
    const p = '/Applications/Koto.app/Contents/Resources/app.asar.unpacked/node_modules/foo/claude'
    expect(toUnpackedPath(p)).toBe(p)
  })

  it('replaces multiple occurrences of app.asar in the same path', () => {
    const p = '/x/app.asar/y/app.asar/z'
    expect(toUnpackedPath(p)).toBe('/x/app.asar.unpacked/y/app.asar.unpacked/z')
  })
})

describe('candidatePackageNames', () => {
  it('builds a single candidate for darwin/win32', () => {
    expect(candidatePackageNames('darwin', 'arm64')).toEqual(['@anthropic-ai/claude-agent-sdk-darwin-arm64'])
    expect(candidatePackageNames('win32', 'x64')).toEqual(['@anthropic-ai/claude-agent-sdk-win32-x64'])
  })

  it('builds glibc and musl candidates for linux (glibc first)', () => {
    expect(candidatePackageNames('linux', 'x64')).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-x64',
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
    ])
  })

  it('builds an android-specific candidate', () => {
    expect(candidatePackageNames('android', 'arm64')).toEqual(['@anthropic-ai/claude-agent-sdk-linux-arm64-android'])
  })
})
