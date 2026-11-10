import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 本物の口（teardown/hanamiiResume.ts の realDeps と、書き出しの2つの関数）を動かす ───────────────────────────────
// hanamiiResume.test.ts は偽の口を渡した createHanamiiResumer だけを見る。ここは **本物の口**（publishedRecords の読み替え・readProject の metaPath・
// resumeTeardown への引数の渡し方）と、書き出しの2つの関数（呼ぶ所3つが通るもの）が同じ1つの resumer を分け合うことを、window の偽に流して見る。
// 認証情報の口（CredentialsModal の getHanamiiTokenById）だけを偽にする。loadHanamiiToken 自体は本物。

const h = vi.hoisted(() => ({
  resumeCalls: [] as Array<{ dir: string; auth: unknown; opts: unknown }>,
  gate: null as Promise<void> | null,
  records: { ok: true, projects: [] as Array<{ dir: string; publish: unknown }> } as { ok: boolean; projects: Array<{ dir: string; publish: unknown }> },
  files: new Map<string, string>(),
  readPaths: [] as string[],
}))

vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-USED',
  getHanamiiTokenById: async (id: string) => `tok-of-${id}`,
}))

import { resumeHanamiiDeletionsIn, resumeHanamiiDeletionIn } from '../src/renderer/teardown/hanamiiResume'

const mark = (projectId: string) => ({ projectId, acceptedAt: '2026-11-09T01:00:00.000Z', shownPlacements: [{ bucket: 'b1', prefix: 'p1' }], requiresReview: false })
const publishOf = (projectId: string, withMark: boolean, tokenId = 'tok-1') => ({ hanamii: { projectId, tokenId, ...(withMark ? { deletionAccepted: mark(projectId) } : {}) } })

beforeEach(() => {
  h.resumeCalls = []
  h.gate = null
  h.records = { ok: true, projects: [] }
  h.files = new Map()
  h.readPaths = []
  vi.stubGlobal('window', {
    electronAPI: {
      fs: {
        publishedRecords: async () => h.records,
        readFile: async (p: string) => { h.readPaths.push(p); const t = h.files.get(p); if (t === undefined) throw new Error('ENOENT'); return t },
      },
      hanamii: {
        resumeTeardown: async (dir: string, auth: unknown, opts: unknown) => { h.resumeCalls.push({ dir, auth, opts }); if (h.gate) await h.gate; return { ok: true } },
      },
    },
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('本物の口: 印のあるプロジェクトだけを、記録の tokenId のトークンで、main へ引数どおりに渡す', () => {
  it('★★★ resumeHanamiiDeletionsIn: publishedRecords の読み替え。印のあるものだけに、resumeTeardown(dir, { token }, { projectId }) を1回ずつ', async () => {
    h.records = { ok: true, projects: [
      { dir: '/w/a', publish: publishOf('PA', true, 'tok-a') },
      { dir: '/w/b', publish: publishOf('PB', false) },
      { dir: '/w/c', publish: publishOf('PC', true, 'tok-c') },
    ] }
    expect(await resumeHanamiiDeletionsIn('/w')).toEqual(['/w/a', '/w/c'])
    expect(h.resumeCalls).toEqual([
      { dir: '/w/a', auth: { token: 'tok-of-tok-a' }, opts: { projectId: 'PA' } },
      { dir: '/w/c', auth: { token: 'tok-of-tok-c' }, opts: { projectId: 'PC' } },
    ])
  })

  it('★★★ publishedRecords が ok:false なら何も呼ばない', async () => {
    h.records = { ok: false, projects: [{ dir: '/w/a', publish: publishOf('PA', true) }] }
    expect(await resumeHanamiiDeletionsIn('/w')).toEqual([])
    expect(h.resumeCalls).toEqual([])
  })

  it('★★★ resumeHanamiiDeletionIn: そのプロジェクトの .sakuraide.json（metaPath）を読み、印があれば呼ぶ。無ければ呼ばない', async () => {
    h.files.set('/w/a/.sakuraide.json', JSON.stringify({ publish: publishOf('PA', true, 'tok-a') }))
    h.files.set('/w/b/.sakuraide.json', JSON.stringify({ publish: publishOf('PB', false) }))
    expect(await resumeHanamiiDeletionIn('/w/a')).toBe(true)
    expect(await resumeHanamiiDeletionIn('/w/b')).toBe(false)
    expect(await resumeHanamiiDeletionIn('/w/none')).toBe(false) // 読めない記録は呼ばない（投げない）
    expect(h.readPaths).toEqual(['/w/a/.sakuraide.json', '/w/b/.sakuraide.json', '/w/none/.sakuraide.json'])
    expect(h.resumeCalls).toEqual([{ dir: '/w/a', auth: { token: 'tok-of-tok-a' }, opts: { projectId: 'PA' } }])
  })

  it('★★★ tokenId の無い旧い記録は、本物の loadHanamiiToken が使用中のトークンを返す形でも、呼ばない', async () => {
    h.records = { ok: true, projects: [{ dir: '/w/a', publish: { hanamii: { projectId: 'PA', deletionAccepted: mark('PA') } } }] }
    expect(await resumeHanamiiDeletionsIn('/w')).toEqual([])
    expect(h.resumeCalls).toEqual([])
  })
})

describe('★★★ 書き出しの2つの関数は、同じ1つの resumer を分け合う（続きが走っている間は、どちらから呼んでも二重に呼ばない）', () => {
  it('作業場所の入口が走っている間に、プロジェクトの入口・作業場所の入口をもう一度呼んでも、resumeTeardown は1回だけ', async () => {
    const publish = publishOf('PA', true, 'tok-a')
    h.records = { ok: true, projects: [{ dir: '/w/a', publish }] }
    h.files.set('/w/a/.sakuraide.json', JSON.stringify({ publish }))
    let release!: () => void
    h.gate = new Promise<void>(r => { release = r })
    const first = resumeHanamiiDeletionsIn('/w')
    try {
      await new Promise(r => setTimeout(r, 5))
      expect(h.resumeCalls).toHaveLength(1)
      h.gate = Promise.resolve() // 2本目が（まちがって）送られても、止めずに返す（失敗を時間切れにしない）
      expect(await resumeHanamiiDeletionIn('/w/a')).toBe(false)
      expect(await resumeHanamiiDeletionsIn('/w')).toEqual([])
      expect(h.resumeCalls, '2本目の resumeTeardown を送った').toHaveLength(1)
    } finally { release() }
    await first
    // 終わったあとは、また呼べる（部品が詰まったままにならない）
    h.gate = null
    expect(await resumeHanamiiDeletionIn('/w/a')).toBe(true)
    expect(h.resumeCalls).toHaveLength(2)
  })
})
