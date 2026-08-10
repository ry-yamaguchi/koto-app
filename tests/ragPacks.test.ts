import { describe, it, expect } from 'vitest'
import {
  RAG_PACKS,
  RAG_IDE_TAG,
  packTags,
  packTotalChars,
  formatApproxChars,
  estimatePackCostPerTurnYen,
} from '../src/renderer/ragPacks'

describe('RAG_PACKS definition validity', () => {
  it('has a non-empty pack list', () => {
    expect(RAG_PACKS.length).toBeGreaterThan(0)
  })

  it('has unique pack ids', () => {
    const ids = RAG_PACKS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every pack has a label, description, and at least one page', () => {
    for (const pack of RAG_PACKS) {
      expect(pack.label.length).toBeGreaterThan(0)
      expect(pack.description.length).toBeGreaterThan(0)
      expect(pack.pages.length).toBeGreaterThan(0)
    }
  })

  it('every page has a well-formed http/https URL', () => {
    for (const pack of RAG_PACKS) {
      for (const page of pack.pages) {
        expect(() => new URL(page.url)).not.toThrow()
        expect(page.url).toMatch(/^https:\/\//)
      }
    }
  })

  it('every page has a non-empty title and positive approxChars', () => {
    for (const pack of RAG_PACKS) {
      for (const page of pack.pages) {
        expect(page.title.length).toBeGreaterThan(0)
        expect(page.approxChars).toBeGreaterThan(0)
      }
    }
  })

  it('has no duplicate URLs across the whole pack set', () => {
    const urls = RAG_PACKS.flatMap(p => p.pages.map(pg => pg.url))
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('packTags', () => {
  it('includes the IDE origin tag, the pack tag, and the web tag', () => {
    expect(packTags('rental')).toEqual([RAG_IDE_TAG, 'pack:rental', 'web'])
  })

  it('namespaces the pack tag with the given id', () => {
    expect(packTags('ai-engine')).toContain('pack:ai-engine')
    expect(packTags('hanamii')).toContain('pack:hanamii')
  })
})

describe('packTotalChars', () => {
  it('sums approxChars across all pages in a pack', () => {
    const pack = { id: 'x', label: 'X', description: '', pages: [
      { url: 'https://a', title: 'A', approxChars: 100 },
      { url: 'https://b', title: 'B', approxChars: 250 },
    ] }
    expect(packTotalChars(pack)).toBe(350)
  })

  it('returns 0 for a pack with no pages', () => {
    expect(packTotalChars({ id: 'x', label: 'X', description: '', pages: [] })).toBe(0)
  })
})

describe('formatApproxChars', () => {
  it('formats 0 as 0字', () => {
    expect(formatApproxChars(0)).toBe('0字')
  })

  it('formats small counts (<10000) as 千字, rounded up to at least 1千字', () => {
    expect(formatApproxChars(500)).toBe('約1千字')
    expect(formatApproxChars(3400)).toBe('約3千字')
    expect(formatApproxChars(9999)).toBe('約10千字')
  })

  it('formats 10000-99999 with one decimal place of 万字', () => {
    expect(formatApproxChars(11148)).toBe('約1.1万字')
    expect(formatApproxChars(17485)).toBe('約1.7万字')
    expect(formatApproxChars(29512)).toBe('約3万字')
  })

  it('formats 100000+ as a rounded integer of 万字', () => {
    expect(formatApproxChars(160866)).toBe('約16万字')
    expect(formatApproxChars(100000)).toBe('約10万字')
  })
})

describe('estimatePackCostPerTurnYen', () => {
  it('returns a positive number for a known model', () => {
    const yen = estimatePackCostPerTurnYen('Qwen3-Coder-480B-A35B-Instruct-FP8')
    expect(yen).toBeGreaterThan(0)
  })

  it('scales with the model input price (a pricier model costs more per turn)', () => {
    const cheap = estimatePackCostPerTurnYen('Qwen3-Coder-30B-A3B-Instruct') // in: 15
    const pricey = estimatePackCostPerTurnYen('preview/Kimi-K2.6') // in: 60
    expect(pricey).toBeGreaterThan(cheap)
  })

  it('falls back to the default price for an unknown model (still positive, finite)', () => {
    const yen = estimatePackCostPerTurnYen('some-unknown-model')
    expect(yen).toBeGreaterThan(0)
    expect(Number.isFinite(yen)).toBe(true)
  })
})
