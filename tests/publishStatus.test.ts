import { describe, it, expect } from 'vitest'
import {
  buildPublishStatusRows,
  isStale,
  formatPublishedAt,
  parseApprunLegacy,
  detectInterruptedPublish,
  latestPublishedTarget,
  withoutPublishTarget,
} from '../src/renderer/publishStatus'

describe('buildPublishStatusRows', () => {
  it('returns empty array when publish is undefined/null', () => {
    expect(buildPublishStatusRows(undefined)).toEqual([])
    expect(buildPublishStatusRows(null)).toEqual([])
  })

  it('returns empty array when publish has no targets and no legacy fields', () => {
    expect(buildPublishStatusRows({})).toEqual([])
  })

  it('builds a row per target in targets, in a fixed order', () => {
    const rows = buildPublishStatusRows({
      targets: {
        'sakura-rental': { publishedAt: '2026-07-01T00:00:00Z', url: 'https://example.sakura.ne.jp/' },
        hanamii: { publishedAt: '2026-07-02T00:00:00Z', url: 'https://foo.hanamii.jp' },
      },
    })
    expect(rows.map(r => r.target)).toEqual(['hanamii', 'sakura-rental'])
    expect(rows[0]).toMatchObject({ publishedAt: '2026-07-02T00:00:00Z', url: 'https://foo.hanamii.jp', dateUnknown: false })
    expect(rows[1]).toMatchObject({ publishedAt: '2026-07-01T00:00:00Z', url: 'https://example.sakura.ne.jp/', dateUnknown: false })
  })

  it('marks a target row as dateUnknown when publishedAt is missing/null', () => {
    const rows = buildPublishStatusRows({ targets: { hanamii: { publishedAt: null, url: null } } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ target: 'hanamii', publishedAt: null, dateUnknown: true })
  })

  it('legacy rescue: hanamii.projectId without targets.hanamii yields a date-unknown hanamii row', () => {
    const rows = buildPublishStatusRows({ hanamii: { projectId: 'proj123' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ target: 'hanamii', publishedAt: null, url: null, dateUnknown: true })
  })

  it('legacy rescue: lastPublishedAt + host without targets["sakura-rental"] yields a rental row', () => {
    const rows = buildPublishStatusRows({ lastPublishedAt: '2026-06-01T00:00:00Z', host: 'example.sakura.ne.jp' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      target: 'sakura-rental',
      publishedAt: '2026-06-01T00:00:00Z',
      url: 'https://example.sakura.ne.jp/',
      dateUnknown: false,
    })
  })

  it('does not apply legacy rescue when targets already has a record for that target', () => {
    const rows = buildPublishStatusRows({
      targets: { hanamii: { publishedAt: '2026-07-03T00:00:00Z', url: null } },
      hanamii: { projectId: 'proj123' },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].publishedAt).toBe('2026-07-03T00:00:00Z')
  })

  it('legacy rescue does not apply to apprun (no legacy source for it)', () => {
    const rows = buildPublishStatusRows({ lastPublishedAt: '2026-06-01T00:00:00Z' } as any)
    expect(rows).toEqual([])
  })

  it('combines targets and legacy rescue for different targets simultaneously', () => {
    const rows = buildPublishStatusRows({
      targets: { 'sakura-apprun': { publishedAt: '2026-07-01T00:00:00Z', url: 'https://app.example.com' } },
      hanamii: { projectId: 'proj123' },
      lastPublishedAt: '2026-06-01T00:00:00Z',
      host: 'example.sakura.ne.jp',
    })
    expect(rows.map(r => r.target).sort()).toEqual(['hanamii', 'sakura-apprun', 'sakura-rental'])
  })
})

describe('isStale', () => {
  it('returns false when publishedAt or latest is missing', () => {
    expect(isStale(null, '2026-07-04T00:00:00Z')).toBe(false)
    expect(isStale('2026-07-04T00:00:00Z', null)).toBe(false)
    expect(isStale(undefined, undefined)).toBe(false)
  })

  it('returns false when publishedAt or latest is unparsable', () => {
    expect(isStale('not-a-date', '2026-07-04T00:00:00Z')).toBe(false)
    expect(isStale('2026-07-04T00:00:00Z', 'not-a-date')).toBe(false)
  })

  it('returns false when latest is before or equal to publishedAt', () => {
    expect(isStale('2026-07-04T00:00:00Z', '2026-07-03T00:00:00Z')).toBe(false)
    expect(isStale('2026-07-04T00:00:00Z', '2026-07-04T00:00:00Z')).toBe(false)
  })

  it('returns false when latest is after publishedAt but within the margin', () => {
    expect(isStale('2026-07-04T00:00:00Z', '2026-07-04T00:00:30Z')).toBe(false)
  })

  it('returns true when latest is after publishedAt beyond the margin', () => {
    expect(isStale('2026-07-04T00:00:00Z', '2026-07-04T00:05:00Z')).toBe(true)
  })

  it('respects a custom margin', () => {
    expect(isStale('2026-07-04T00:00:00Z', '2026-07-04T00:00:05Z', 10_000)).toBe(false)
    expect(isStale('2026-07-04T00:00:00Z', '2026-07-04T00:00:15Z', 10_000)).toBe(true)
  })
})

describe('formatPublishedAt', () => {
  it('returns null for null/undefined/unparsable input', () => {
    expect(formatPublishedAt(null)).toBeNull()
    expect(formatPublishedAt(undefined)).toBeNull()
    expect(formatPublishedAt('not-a-date')).toBeNull()
  })

  it('formats an ISO date as M/D HH:mm', () => {
    const d = new Date('2026-07-04T09:05:00Z')
    const expected = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    expect(formatPublishedAt('2026-07-04T09:05:00Z')).toBe(expected)
  })
})


describe('parseApprunLegacy / AppRunレガシー救済', () => {
  const state = { name: 'x', backend: 'apprun', resources: [{ kind: 'apprun-app', id: 'a1' }], meta: { createdAt: '2026-07-04T13:59:47.547Z' } }

  it('parses createdAt when an apprun-app resource exists', () => {
    expect(parseApprunLegacy(state)).toEqual({ createdAt: '2026-07-04T13:59:47.547Z' })
  })

  it('returns null when no apprun-app resource / invalid input', () => {
    expect(parseApprunLegacy({ resources: [{ kind: 'bucket' }] })).toBeNull()
    expect(parseApprunLegacy({})).toBeNull()
    expect(parseApprunLegacy(null)).toBeNull()
  })

  it('adds a sakura-apprun row from legacy state when targets has none', () => {
    const rows = buildPublishStatusRows({}, { apprunLegacy: { createdAt: '2026-07-04T13:59:47.547Z' } })
    const row = rows.find(r => r.target === 'sakura-apprun')
    expect(row).toBeTruthy()
    expect(row?.dateUnknown).toBe(false)
    expect(row?.publishedAt).toBe('2026-07-04T13:59:47.547Z')
  })

  it('does not duplicate when targets already has sakura-apprun', () => {
    const publish = { targets: { 'sakura-apprun': { publishedAt: '2026-07-05T00:00:00Z' } } }
    const rows = buildPublishStatusRows(publish, { apprunLegacy: { createdAt: '2026-07-04T00:00:00Z' } })
    expect(rows.filter(r => r.target === 'sakura-apprun')).toHaveLength(1)
    expect(rows[0].publishedAt).toBe('2026-07-05T00:00:00Z')
  })

})

describe('detectInterruptedPublish', () => {
  const NOW = new Date('2026-07-28T12:00:00Z').getTime()

  it('returns null when there is no pending marker', () => {
    expect(detectInterruptedPublish({}, NOW)).toBeNull()
    expect(detectInterruptedPublish({ pending: null }, NOW)).toBeNull()
  })

  it('returns null when the pending marker started very recently (likely still in progress)', () => {
    const startedAt = new Date(NOW - 1_000).toISOString() // 1秒前
    expect(detectInterruptedPublish({ pending: { target: 'hanamii', startedAt } }, NOW)).toBeNull()
  })

  it('returns the pending marker when it started long enough ago (likely interrupted)', () => {
    const startedAt = new Date(NOW - 60_000).toISOString() // 1分前
    const result = detectInterruptedPublish({ pending: { target: 'sakura-apprun', startedAt } }, NOW)
    expect(result).toEqual({ target: 'sakura-apprun', startedAt })
  })

  it('returns null when the target is not a known publish target', () => {
    const startedAt = new Date(NOW - 60_000).toISOString()
    expect(detectInterruptedPublish({ pending: { target: 'not-a-real-target' as any, startedAt } }, NOW)).toBeNull()
  })

  it('returns null when startedAt is unparsable', () => {
    expect(detectInterruptedPublish({ pending: { target: 'vercel', startedAt: 'not-a-date' } }, NOW)).toBeNull()
  })
})

// 2026-07-31 ユーザー要望: ③公開は「最後に公開した公開先」の画面で開く。
// 各パネルが書く meta.target には頼らない（AppRunだけ更新していなかった実例があるため）。
describe('latestPublishedTarget', () => {
  it('公開実績が複数あれば、publishedAt が最も新しい公開先を返す', () => {
    expect(latestPublishedTarget({
      targets: {
        'sakura-rental': { publishedAt: '2026-07-01T00:00:00.000Z', url: 'https://a/' },
        'sakura-apprun': { publishedAt: '2026-07-30T00:00:00.000Z', url: 'https://b/' },
        hanamii: { publishedAt: '2026-07-15T00:00:00.000Z', url: 'https://c/' },
      },
    })).toBe('sakura-apprun')
  })

  it('公開実績が1件ならそれを返す', () => {
    expect(latestPublishedTarget({ targets: { vercel: { publishedAt: '2026-07-20T00:00:00.000Z', url: null } } })).toBe('vercel')
  })

  it('公開実績が無ければ null（呼び出し側が meta.target へフォールバックする）', () => {
    expect(latestPublishedTarget({})).toBeNull()
    expect(latestPublishedTarget({ targets: {} })).toBeNull()
    expect(latestPublishedTarget(undefined)).toBeNull()
    expect(latestPublishedTarget(null)).toBeNull()
  })

  it('publishedAt が無い・壊れている記録は候補にしない', () => {
    expect(latestPublishedTarget({
      targets: {
        'sakura-rental': { publishedAt: null, url: 'https://a/' },
        vercel: { publishedAt: 'not-a-date', url: null },
      },
    })).toBeNull()
  })

  it('日時が壊れた記録が混ざっていても、正常な記録から選ぶ', () => {
    expect(latestPublishedTarget({
      targets: {
        'sakura-rental': { publishedAt: 'not-a-date', url: null },
        hanamii: { publishedAt: '2026-07-10T00:00:00.000Z', url: null },
      },
    })).toBe('hanamii')
  })

  it('未知のキー（将来の公開先・破損データ）は無視する', () => {
    expect(latestPublishedTarget({
      targets: {
        'sakura-rental': { publishedAt: '2026-07-01T00:00:00.000Z', url: null },
        'unknown-target': { publishedAt: '2026-07-31T00:00:00.000Z', url: null },
      } as any,
    })).toBe('sakura-rental')
  })
})

// 2026-08-06: Koto 自身で破棄しても公開記録が残り、「📡 公開したもの一覧」に
// もう存在しない公開が出続けていた（実データで5件の幽霊を確認）。
// 外部で消された分は分からないが、**自分で消したものは記録に反映する**。
describe('withoutPublishTarget（破棄したら記録からも消す）', () => {
  const meta = {
    lastPublishedAt: '2026-08-01T00:00:00.000Z',
    url: 'https://example.com/',
    targets: {
      'sakura-apprun': { publishedAt: '2026-08-01T00:00:00.000Z', url: 'https://a/' },
      hanamii: { publishedAt: '2026-07-01T00:00:00.000Z', url: 'https://h/' },
    },
  } as any

  it('指定した公開先だけを取り除く', () => {
    const next = withoutPublishTarget(meta, 'sakura-apprun')
    expect(next.targets?.['sakura-apprun']).toBeUndefined()
    expect(next.targets?.hanamii).toBeDefined() // 他は残る
  })

  it('元のオブジェクトを壊さない（画面の状態と食い違わせない）', () => {
    withoutPublishTarget(meta, 'sakura-apprun')
    expect(meta.targets['sakura-apprun']).toBeDefined()
  })

  it('最後に公開した情報（lastPublishedAt / url）は履歴として残す', () => {
    const next = withoutPublishTarget(meta, 'sakura-apprun')
    expect(next.lastPublishedAt).toBe('2026-08-01T00:00:00.000Z')
    expect(next.url).toBe('https://example.com/')
  })

  it('記録が無い・null でも落ちない', () => {
    expect(withoutPublishTarget(null, 'hanamii').targets).toEqual({})
    expect(withoutPublishTarget(undefined, 'hanamii').targets).toEqual({})
    expect(withoutPublishTarget({} as any, 'hanamii').targets).toEqual({})
  })

  it('取り除いた後は一覧に出ない', () => {
    const next = withoutPublishTarget(meta, 'sakura-apprun')
    const rows = buildPublishStatusRows(next, {})
    expect(rows.map(r => r.target)).not.toContain('sakura-apprun')
    expect(rows.map(r => r.target)).toContain('hanamii')
  })
})
