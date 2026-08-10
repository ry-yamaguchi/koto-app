import { describe, it, expect } from 'vitest'
import { buildPublishedIndex, groupPublishedByTarget } from '../src/renderer/publishedIndex'

// 2026-07-31 ユーザー要望: 「HANAMIIで公開したものは何だったか」をサービス側が落ちていても確認できるように、
// ローカルの公開記録（.sakuraide.json の publish）を横断して一覧にする。

const proj = (dir: string, name: string, publish: unknown, apprunState: unknown = null) => ({ dir, name, publish, apprunState })

describe('buildPublishedIndex', () => {
  it('複数プロジェクト・複数公開先を1本の配列にし、新しい順に並べる', () => {
    const rows = buildPublishedIndex([
      proj('/w/a', 'a', { targets: { hanamii: { publishedAt: '2026-07-01T00:00:00.000Z', url: 'https://a.example/' } } }),
      proj('/w/b', 'b', {
        targets: {
          hanamii: { publishedAt: '2026-07-20T00:00:00.000Z', url: 'https://b.example/' },
          vercel: { publishedAt: '2026-07-10T00:00:00.000Z', url: 'https://b.vercel.app/' },
        },
      }),
    ])
    expect(rows.map(r => `${r.projectName}:${r.target}`)).toEqual([
      'b:hanamii', 'b:vercel', 'a:hanamii',
    ])
    expect(rows[0].url).toBe('https://b.example/')
    expect(rows[0].dir).toBe('/w/b')
  })

  it('公開記録が無いプロジェクトは行を持たない', () => {
    expect(buildPublishedIndex([proj('/w/x', 'x', null), proj('/w/y', 'y', { targets: {} })])).toEqual([])
  })

  it('日時が分からない記録（レガシー救済）は最後に置く', () => {
    const rows = buildPublishedIndex([
      // hanamii.projectId だけがある旧プロジェクト → 日時不明の行として拾われる
      proj('/w/old', 'old', { hanamii: { projectId: 'p1' } }),
      proj('/w/new', 'new', { targets: { vercel: { publishedAt: '2026-07-15T00:00:00.000Z', url: 'https://n/' } } }),
    ])
    expect(rows.map(r => r.projectName)).toEqual(['new', 'old'])
    expect(rows[1].dateUnknown).toBe(true)
    expect(rows[1].publishedAt).toBeNull()
  })

  it('AppRunのレガシー実績（.sakura-cloud/state.json）も拾う', () => {
    const rows = buildPublishedIndex([
      // 実際の .sakura-cloud/state.json の形（resources[].kind と meta.createdAt）に合わせる
      proj('/w/legacy', 'legacy', null, { resources: [{ kind: 'apprun-app' }], meta: { createdAt: '2026-06-01T00:00:00.000Z' } }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].target).toBe('sakura-apprun')
  })

  it('壊れた入力（null・dirが無い）で落ちない', () => {
    expect(buildPublishedIndex([null as any, { name: 'x' } as any])).toEqual([])
    expect(buildPublishedIndex(undefined as any)).toEqual([])
  })

  it('プロジェクト名が空ならフォルダ名で補う', () => {
    const rows = buildPublishedIndex([
      proj('/w/folder-name', '', { targets: { vercel: { publishedAt: '2026-07-15T00:00:00.000Z', url: null } } }),
    ])
    expect(rows[0].projectName).toBe('folder-name')
  })
})

describe('groupPublishedByTarget', () => {
  it('公開先ごとにまとめ、直近に使った公開先を先頭にする', () => {
    const rows = buildPublishedIndex([
      proj('/w/a', 'a', { targets: { 'sakura-rental': { publishedAt: '2026-07-01T00:00:00.000Z', url: 'https://a/' } } }),
      proj('/w/b', 'b', { targets: { hanamii: { publishedAt: '2026-07-25T00:00:00.000Z', url: 'https://b/' } } }),
      proj('/w/c', 'c', { targets: { hanamii: { publishedAt: '2026-07-05T00:00:00.000Z', url: 'https://c/' } } }),
    ])
    const groups = groupPublishedByTarget(rows)
    expect(groups.map(g => g.target)).toEqual(['hanamii', 'sakura-rental'])
    expect(groups[0].entries.map(e => e.projectName)).toEqual(['b', 'c'])
  })

  it('日時が1つも分からない公開先は最後に置く', () => {
    const rows = buildPublishedIndex([
      proj('/w/old', 'old', { hanamii: { projectId: 'p1' } }),
      proj('/w/new', 'new', { targets: { vercel: { publishedAt: '2026-07-15T00:00:00.000Z', url: null } } }),
    ])
    expect(groupPublishedByTarget(rows).map(g => g.target)).toEqual(['vercel', 'hanamii'])
  })

  it('空配列なら空', () => {
    expect(groupPublishedByTarget([])).toEqual([])
  })
})
