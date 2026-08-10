import { describe, it, expect } from 'vitest'
import { buildRagBlockText, parseRagSettings, mergeRagSettings, buildWebPageMarkdown, sanitizeFilename } from '../src/renderer/ragContext'

// buildRagBlockText が参照する RagQueryHit / RagDocument はグローバル型（src/renderer/global.d.ts）。
// テストではプレーンオブジェクトで代用する（型は any 経由で満たす）。
function makeHit(overrides: Partial<{ name: string | undefined; content: string }> = {}): any {
  return {
    document: overrides.name === undefined ? null : { name: overrides.name, id: 'd1', status: 'available', tags: [], model: null, chunkSize: null, chunkCount: null, errorMessage: null, content: null, createdAt: null, updatedAt: null },
    chunkIndex: 0,
    distance: 0.1,
    content: overrides.content ?? '本文抜粋',
    metadata: null,
  }
}

describe('buildRagBlockText', () => {
  it('returns empty string for zero hits', () => {
    expect(buildRagBlockText([])).toBe('')
  })

  it('builds a header + source-attributed block for one or more hits', () => {
    const hits = [makeHit({ name: '仕様書.pdf', content: '第1章の内容' })]
    const text = buildRagBlockText(hits)
    expect(text).toContain('# 関連資料（さくらのAI Engineに登録済みの資料からの抜粋）')
    expect(text).toContain('【出典: 仕様書.pdf】')
    expect(text).toContain('第1章の内容')
  })

  it('includes each hit for multiple results', () => {
    const hits = [makeHit({ name: 'A.pdf', content: '内容A' }), makeHit({ name: 'B.pdf', content: '内容B' })]
    const text = buildRagBlockText(hits)
    expect(text).toContain('【出典: A.pdf】')
    expect(text).toContain('内容A')
    expect(text).toContain('【出典: B.pdf】')
    expect(text).toContain('内容B')
  })

  it('falls back to (名称不明) when document/name is missing', () => {
    const hits = [makeHit({ name: undefined })]
    const text = buildRagBlockText(hits)
    expect(text).toContain('【出典: (名称不明)】')
  })

  it('truncates chunk content longer than 2000 chars', () => {
    const longContent = 'あ'.repeat(2500)
    const hits = [makeHit({ name: '長文.txt', content: longContent })]
    const text = buildRagBlockText(hits)
    // 切詰め後は元の長さより短くなり、末尾に省略記号が付く
    const sourceIndex = text.indexOf('長文.txt')
    const after = text.slice(sourceIndex)
    expect(after.length).toBeLessThan(longContent.length)
    expect(after).toContain('…')
  })
})

describe('parseRagSettings', () => {
  it('returns null when rag key is missing', () => {
    expect(parseRagSettings({})).toBeNull()
    expect(parseRagSettings(null)).toBeNull()
    expect(parseRagSettings(undefined)).toBeNull()
  })

  it('parses enabled + tags from a valid rag key', () => {
    const settings = parseRagSettings({ rag: { enabled: true, tags: ['仕様書', '契約'] } })
    expect(settings).toEqual({ enabled: true, tags: ['仕様書', '契約'] })
  })

  it('defaults tags to [] when missing or malformed', () => {
    expect(parseRagSettings({ rag: { enabled: true } })).toEqual({ enabled: true, tags: [] })
    expect(parseRagSettings({ rag: { enabled: false, tags: 'not-an-array' } })).toEqual({ enabled: false, tags: [] })
  })
})

describe('mergeRagSettings', () => {
  it('preserves existing keys (e.g. publish) while writing rag', () => {
    const meta = { name: 'my-app', target: 'sakura-apprun', publish: { hanamii: { projectId: 'p1' } } }
    const merged = mergeRagSettings(meta, { enabled: true, tags: ['a', 'b'] })
    expect(merged).toEqual({
      name: 'my-app',
      target: 'sakura-apprun',
      publish: { hanamii: { projectId: 'p1' } },
      rag: { enabled: true, tags: ['a', 'b'] },
    })
  })

  it('creates a fresh object with just rag when meta is empty/null', () => {
    expect(mergeRagSettings(null, { enabled: false, tags: [] })).toEqual({ rag: { enabled: false, tags: [] } })
    expect(mergeRagSettings({}, { enabled: true, tags: ['x'] })).toEqual({ rag: { enabled: true, tags: ['x'] } })
  })

  it('overwrites a previous rag value entirely (not deep-merged)', () => {
    const meta = { rag: { enabled: true, tags: ['old'] } }
    const merged = mergeRagSettings(meta, { enabled: false, tags: [] })
    expect(merged.rag).toEqual({ enabled: false, tags: [] })
  })
})

describe('buildWebPageMarkdown', () => {
  const fetchedAt = new Date(2026, 6, 3, 9, 5) // 2026-07-03 09:05（月は0始まり）

  it('builds the expected header + separator + body shape', () => {
    const md = buildWebPageMarkdown({ title: 'さくらのナレッジ 記事タイトル', url: 'https://knowledge.sakura.ad.jp/12345/', content: '本文テキストです。' }, fetchedAt)
    expect(md).toBe(
      '# さくらのナレッジ 記事タイトル\n\n' +
      '- 出典URL: https://knowledge.sakura.ad.jp/12345/\n' +
      '- 取得日時: 2026-07-03 09:05（Koto で取得）\n\n' +
      '---\n\n' +
      '本文テキストです。'
    )
  })

  it('pads single-digit month/day/hour/minute with zero', () => {
    const md = buildWebPageMarkdown({ title: 'T', url: 'https://example.com', content: 'body' }, new Date(2026, 0, 5, 3, 7))
    expect(md).toContain('取得日時: 2026-01-05 03:07')
  })

  it('falls back to (タイトル不明) when title is empty or whitespace', () => {
    expect(buildWebPageMarkdown({ title: '', url: 'https://example.com', content: 'x' }, fetchedAt)).toContain('# (タイトル不明)')
    expect(buildWebPageMarkdown({ title: '   ', url: 'https://example.com', content: 'x' }, fetchedAt)).toContain('# (タイトル不明)')
  })
})

describe('sanitizeFilename', () => {
  it('removes forbidden characters and newlines', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij')
    expect(sanitizeFilename('line1\nline2\r\nline3')).toBe('line1 line2 line3')
  })

  it('trims surrounding whitespace', () => {
    expect(sanitizeFilename('  タイトル  ')).toBe('タイトル')
  })

  it('truncates to 50 characters', () => {
    const long = 'あ'.repeat(80)
    const result = sanitizeFilename(long)
    expect(result.length).toBe(50)
    expect(result).toBe('あ'.repeat(50))
  })

  it('falls back to web-page when the sanitized result is empty', () => {
    expect(sanitizeFilename('')).toBe('web-page')
    expect(sanitizeFilename('   ')).toBe('web-page')
    expect(sanitizeFilename('///:::')).toBe('web-page')
  })
})
