import { describe, it, expect } from 'vitest'
import {
  parseDocument,
  parseDocumentList,
  parsePageMeta,
  parseChunk,
  parseChunkList,
  parseQueryHit,
  parseQueryResult,
  parseChatResult,
  isTerminalStatus,
  statusLabel,
} from '../src/main/rag/parse'

describe('parseDocument', () => {
  it('parses a full document response', () => {
    const doc = parseDocument({
      id: 'd1', name: '仕様書', status: 'available', tags: ['sakura-ide', '仕様'],
      model: 'multilingual-e5-large', chunk_size: 512, chunk_count: 8, error_message: null,
      content: '本文', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-02T00:00:00Z',
    })
    expect(doc).toEqual({
      id: 'd1', name: '仕様書', status: 'available', tags: ['sakura-ide', '仕様'],
      model: 'multilingual-e5-large', chunkSize: 512, chunkCount: 8, errorMessage: null,
      content: '本文', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z',
    })
  })

  it('defensively fills missing fields without throwing', () => {
    const doc = parseDocument({ id: 'd2' })
    expect(doc).toEqual({
      id: 'd2', name: 'd2', status: 'pending', tags: [],
      model: null, chunkSize: null, chunkCount: null, errorMessage: null,
      content: null, createdAt: null, updatedAt: null,
    })
  })

  it('returns null when id is missing or wrong type', () => {
    expect(parseDocument({})).toBeNull()
    expect(parseDocument({ id: 123 })).toBeNull()
    expect(parseDocument(null)).toBeNull()
    expect(parseDocument(undefined)).toBeNull()
    expect(parseDocument('text')).toBeNull()
  })

  it('ignores non-array tags', () => {
    const doc = parseDocument({ id: 'd3', tags: 'not-an-array' })
    expect(doc?.tags).toEqual([])
  })
})

describe('parseDocumentList', () => {
  it('parses meta and results', () => {
    const r = parseDocumentList({
      meta: { page: 1, page_size: 20, total_pages: 2, count: 25, next: 'url2', previous: null },
      results: [{ id: 'a' }, { id: 'b' }],
    })
    expect(r.meta).toEqual({ page: 1, pageSize: 20, totalPages: 2, count: 25, next: 'url2', previous: null })
    expect(r.documents.map(d => d.id)).toEqual(['a', 'b'])
  })

  it('handles missing results/meta gracefully', () => {
    const r = parseDocumentList({})
    expect(r.documents).toEqual([])
    expect(r.meta).toEqual({ page: null, pageSize: null, totalPages: null, count: null, next: null, previous: null })
  })

  it('filters out invalid entries in results', () => {
    const r = parseDocumentList({ results: [{ id: 'ok' }, { noId: true }, null, 'x'] })
    expect(r.documents.map(d => d.id)).toEqual(['ok'])
  })

  it('handles null input', () => {
    const r = parseDocumentList(null)
    expect(r.documents).toEqual([])
  })
})

describe('parsePageMeta', () => {
  it('returns all nulls for empty/undefined input', () => {
    expect(parsePageMeta(undefined)).toEqual({ page: null, pageSize: null, totalPages: null, count: null, next: null, previous: null })
    expect(parsePageMeta({})).toEqual({ page: null, pageSize: null, totalPages: null, count: null, next: null, previous: null })
  })
})

describe('parseChunk / parseChunkList', () => {
  it('parses a chunk', () => {
    const c = parseChunk({ document: 'd1', chunk_index: 3, content: 'text', metadata: { page: 1 } })
    expect(c).toEqual({ document: 'd1', chunkIndex: 3, content: 'text', metadata: { page: 1 } })
  })

  it('defaults content to empty string when missing', () => {
    const c = parseChunk({ document: 'd1' })
    expect(c?.content).toBe('')
  })

  it('returns null for non-object input', () => {
    expect(parseChunk(null)).toBeNull()
    expect(parseChunk('x')).toBeNull()
  })

  it('parses a chunk list with meta', () => {
    const r = parseChunkList({ meta: { count: 2 }, results: [{ content: 'a' }, { content: 'b' }] })
    expect(r.chunks.map(c => c.content)).toEqual(['a', 'b'])
    expect(r.meta.count).toBe(2)
  })
})

describe('parseQueryHit / parseQueryResult', () => {
  it('parses a hit with nested document', () => {
    const hit = parseQueryHit({
      document: { id: 'd1', name: '仕様書' },
      chunk_index: 2, distance: 0.12, content: '抜粋', metadata: { foo: 'bar' },
    })
    expect(hit?.document?.id).toBe('d1')
    expect(hit?.distance).toBe(0.12)
    expect(hit?.content).toBe('抜粋')
  })

  it('handles missing document gracefully', () => {
    const hit = parseQueryHit({ content: 'x' })
    expect(hit?.document).toBeNull()
    expect(hit?.distance).toBeNull()
  })

  it('parses a full query result list', () => {
    const hits = parseQueryResult({ results: [{ content: 'a' }, { content: 'b' }] })
    expect(hits.length).toBe(2)
  })

  it('returns empty array when results missing', () => {
    expect(parseQueryResult({})).toEqual([])
    expect(parseQueryResult(null)).toEqual([])
  })
})

describe('parseChatResult', () => {
  it('parses answer and sources', () => {
    const r = parseChatResult({
      answer: '回答本文',
      sources: [{ document: { id: 'd1', name: '仕様書' }, content: '抜粋1' }],
    })
    expect(r.answer).toBe('回答本文')
    expect(r.sources.length).toBe(1)
    expect(r.sources[0].document?.name).toBe('仕様書')
  })

  it('defaults to empty answer and sources when missing', () => {
    const r = parseChatResult({})
    expect(r.answer).toBe('')
    expect(r.sources).toEqual([])
  })

  it('handles null input', () => {
    const r = parseChatResult(null)
    expect(r.answer).toBe('')
    expect(r.sources).toEqual([])
  })
})

describe('isTerminalStatus', () => {
  it('is true for available/error/deleted', () => {
    expect(isTerminalStatus('available')).toBe(true)
    expect(isTerminalStatus('error')).toBe(true)
    expect(isTerminalStatus('deleted')).toBe(true)
  })

  it('is false for pending/processing/unknown/undefined', () => {
    expect(isTerminalStatus('pending')).toBe(false)
    expect(isTerminalStatus('processing')).toBe(false)
    expect(isTerminalStatus('something-else')).toBe(false)
    expect(isTerminalStatus(undefined)).toBe(false)
    expect(isTerminalStatus(null)).toBe(false)
  })
})

describe('statusLabel', () => {
  it('maps known statuses to Japanese labels', () => {
    expect(statusLabel('pending')).toBe('取り込み中')
    expect(statusLabel('processing')).toBe('取り込み中')
    expect(statusLabel('available')).toBe('利用可能')
    expect(statusLabel('error')).toBe('エラー')
    expect(statusLabel('deleted')).toBe('削除済み')
  })

  it('falls back to raw value or 不明 for unknown/missing status', () => {
    expect(statusLabel('mystery')).toBe('mystery')
    expect(statusLabel(undefined)).toBe('不明')
    expect(statusLabel(null)).toBe('不明')
  })
})
