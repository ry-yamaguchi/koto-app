import { describe, it, expect } from 'vitest'
import {
  isOsvId, osvLinkFor, readBatchReply, readVulnDetail, fixedVersionFor, highestVersion,
  type OsvDetail,
} from '../src/shared/osvShapes'

// OSV.dev の実物の応答の形（要約・詳細文・参照は写していない）
const R1 = {
  results: [
    { vulns: [{ id: 'GHSA-qw6h-vgh9-j6wx', modified: '2026-09-10T03:50:18.298562Z' }, { id: 'GHSA-rv95-896h-c2vc', modified: '2026-09-10T03:50:10.750068Z' }] },
    {},
    { vulns: [{ id: 'GHSA-29mw-wpgm-hmr9', modified: '2025-09-29T21:12:31.102523Z' }] },
  ],
}

const V1 = {
  id: 'GHSA-rv95-896h-c2vc',
  summary: '(省略)',
  details: '(省略)',
  aliases: ['CVE-2024-29041'],
  modified: '2026-09-10T03:50:10.750068508Z',
  published: '2024-03-25T19:40:26Z',
  database_specific: { cwe_ids: ['CWE-1286', 'CWE-601'], severity: 'MODERATE', github_reviewed: true },
  references: [{ type: 'WEB', url: '(省略)' }],
  affected: [
    { package: { name: 'express', ecosystem: 'npm', purl: 'pkg:npm/express' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.19.2' }] }] },
    { package: { name: 'express', ecosystem: 'npm', purl: 'pkg:npm/express' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '5.0.0-alpha.1' }, { fixed: '5.0.0-beta.3' }] }] },
  ],
  schema_version: '1.9.0',
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N' }],
}

const detailOf = (affected: unknown): OsvDetail => {
  const d = readVulnDetail({ id: 'X-1', affected }, 'X-1')
  if (!d) throw new Error('test setup')
  return d
}
const pkg = (name = 'lib', ecosystem = 'npm') => ({ name, ecosystem })

describe('readBatchReply の ID の形', () => {
  it.each(['../../x', 'a/b', '.', '..', 'a'.repeat(101), 'X\n✅ 問題ありません', ''])('形が違う ID %j は応答全体が null', (id) => {
    expect(readBatchReply({ results: [{ vulns: [{ id: 'GHSA-ok' }, { id }] }] }, 1)).toBeNull()
  })
})

describe('readBatchReply', () => {
  it('実物の形を読む', () => {
    expect(readBatchReply(R1, 3)).toEqual([
      { ids: ['GHSA-qw6h-vgh9-j6wx', 'GHSA-rv95-896h-c2vc'], nextPageToken: null },
      { ids: [], nextPageToken: null },
      { ids: ['GHSA-29mw-wpgm-hmr9'], nextPageToken: null },
    ])
  })
  it('弱点なしの {} は空', () => {
    expect(readBatchReply({ results: [{}] }, 1)).toEqual([{ ids: [], nextPageToken: null }])
  })
  it('next_page_token だけの項目も読む', () => {
    expect(readBatchReply({ results: [{ next_page_token: 'abc' }] }, 1)).toEqual([{ ids: [], nextPageToken: 'abc' }])
  })
  it('重複する id を除く', () => {
    const r = readBatchReply({ results: [{ vulns: [{ id: 'A-1' }, { id: 'B-1' }, { id: 'A-1' }] }] }, 1)
    expect(r?.[0].ids).toEqual(['A-1', 'B-1'])
  })
  it.each([
    ['null', null],
    ['配列', []],
    ['文字列', 'x'],
    ['results が物', { results: {} }],
    ['長さ違い', { results: [{}, {}] }],
    ['要素が null', { results: [null] }],
    ['要素が配列', { results: [[]] }],
    ['vulns が物', { results: [{ vulns: {} }] }],
    ['vulns の要素が null', { results: [{ vulns: [null] }] }],
    ['id が数', { results: [{ vulns: [{ id: 1 }] }] }],
    ['id が空', { results: [{ vulns: [{ id: '' }] }] }],
    ['id が長すぎ', { results: [{ vulns: [{ id: 'a'.repeat(201) }] }] }],
    ['next_page_token が数', { results: [{ next_page_token: 1 }] }],
    ['next_page_token が空', { results: [{ next_page_token: '' }] }],
  ])('形が違えば null: %s', (_n, v) => {
    expect(readBatchReply(v, 1)).toBeNull()
  })
  it('別のキー名は拾わない', () => {
    expect(readBatchReply({ results: [{ vulnerabilities: [{ id: 'A-1' }] }] }, 1)).toEqual([{ ids: [], nextPageToken: null }])
    expect(readBatchReply({ results: [{ nextPageToken: 'abc' }] }, 1)).toEqual([{ ids: [], nextPageToken: null }])
    expect(readBatchReply({ items: [{}] }, 1)).toBeNull()
  })
})

describe('readVulnDetail', () => {
  it('実物の形を読む', () => {
    const d = readVulnDetail(V1, 'GHSA-rv95-896h-c2vc')
    expect(d).toMatchObject({ id: 'GHSA-rv95-896h-c2vc', withdrawn: false, severityLabel: 'MODERATE' })
    expect(d?.affected).toHaveLength(2)
  })
  it('id が expectedId と違えば null', () => {
    expect(readVulnDetail(V1, 'GHSA-other')).toBeNull()
  })
  it('withdrawn: 無ければ false・文字列なら true・数なら null', () => {
    expect(readVulnDetail({ id: 'A-1' }, 'A-1')?.withdrawn).toBe(false)
    expect(readVulnDetail({ id: 'A-1', withdrawn: '2024-01-01T00:00:00Z' }, 'A-1')?.withdrawn).toBe(true)
    expect(readVulnDetail({ id: 'A-1', withdrawn: 1 }, 'A-1')).toBeNull()
  })
  it('affected が物なら null・要素が物でなければ null', () => {
    expect(readVulnDetail({ id: 'A-1', affected: {} }, 'A-1')).toBeNull()
    expect(readVulnDetail({ id: 'A-1', affected: [null] }, 'A-1')).toBeNull()
  })
  it('package が無い要素は飛ばす', () => {
    expect(readVulnDetail({ id: 'A-1', affected: [{ ranges: [] }, { package: pkg(), ranges: [] }] }, 'A-1')?.affected).toHaveLength(1)
  })
  it('events の fixed が数なら null', () => {
    expect(readVulnDetail({ id: 'A-1', affected: [{ package: pkg(), ranges: [{ type: 'SEMVER', events: [{ fixed: 1 }] }] }] }, 'A-1')).toBeNull()
  })
  it('ranges の形が違えば null', () => {
    expect(readVulnDetail({ id: 'A-1', affected: [{ package: pkg(), ranges: {} }] }, 'A-1')).toBeNull()
    expect(readVulnDetail({ id: 'A-1', affected: [{ package: pkg(), ranges: [{ type: 1, events: [] }] }] }, 'A-1')).toBeNull()
    expect(readVulnDetail({ id: 'A-1', affected: [{ package: pkg(), ranges: [{ type: 'SEMVER' }] }] }, 'A-1')).toBeNull()
  })
  it.each([
    ['MODERATE', 'MODERATE'],
    ['<b>x</b>', null],
    ['A'.repeat(21), null],
    [5, null],
  ])('severity %s → ラベル %s（全体は読める）', (sev, label) => {
    const d = readVulnDetail({ id: 'A-1', database_specific: { severity: sev } }, 'A-1')
    expect(d).not.toBeNull()
    expect(d?.severityLabel).toBe(label)
  })
  it('CVSS の文字列はラベルにしない', () => {
    expect(readVulnDetail({ id: 'A-1', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N' }] }, 'A-1')?.severityLabel).toBeNull()
  })
  it('summary・details・references の文は戻り値に入らない', () => {
    const d = readVulnDetail({ ...V1, summary: 'SUMMARY-TEXT', details: 'DETAILS-TEXT', references: [{ url: 'https://example.invalid/REF' }] }, 'GHSA-rv95-896h-c2vc')
    const s = JSON.stringify(d)
    expect(s).not.toContain('SUMMARY-TEXT')
    expect(s).not.toContain('DETAILS-TEXT')
    expect(s).not.toContain('REF')
  })
})

describe('fixedVersionFor', () => {
  const d = readVulnDetail(V1, 'GHSA-rv95-896h-c2vc') as OsvDetail
  it('4 系は 4.19.2', () => expect(fixedVersionFor(d, 'express', '4.17.1')).toBe('4.19.2'))
  it('5 系の alpha は 5.0.0-beta.3', () => expect(fixedVersionFor(d, 'express', '5.0.0-alpha.8')).toBe('5.0.0-beta.3'))
  it('直ったバージョンは null', () => expect(fixedVersionFor(d, 'express', '4.19.2')).toBeNull())
  it('名前が違えば null', () => expect(fixedVersionFor(d, 'lodash', '4.17.1')).toBeNull())
  it('version が読めなければ null', () => expect(fixedVersionFor(d, 'express', '^4.17.1')).toBeNull())
  it('type が SEMVER 以外の範囲は見ない', () => {
    for (const type of ['GIT', 'ECOSYSTEM']) {
      expect(fixedVersionFor(detailOf([{ package: pkg(), ranges: [{ type, events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }]), 'lib', '1.0.0')).toBeNull()
    }
  })
  it('ecosystem が npm 以外の同名は見ない', () => {
    expect(fixedVersionFor(detailOf([{ package: pkg('lib', 'PyPI'), ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }]), 'lib', '1.0.0')).toBeNull()
  })
  it('introduced が読めない形の範囲は捨てる', () => {
    expect(fixedVersionFor(detailOf([{ package: pkg(), ranges: [{ type: 'SEMVER', events: [{ introduced: 'abc' }, { fixed: '2.0.0' }] }] }]), 'lib', '1.0.0')).toBeNull()
  })
  it('fixed が読めない形の範囲は捨てる', () => {
    expect(fixedVersionFor(detailOf([{ package: pkg(), ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: 'abc' }] }] }]), 'lib', '1.0.0')).toBeNull()
  })
  it('last_affected だけの範囲は null', () => {
    expect(fixedVersionFor(detailOf([{ package: pkg(), ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { last_affected: '2.0.0' }] }] }]), 'lib', '1.0.0')).toBeNull()
  })
  it('introduced より前は対象外', () => {
    expect(fixedVersionFor(detailOf([{ package: pkg(), ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.1.0' }] }] }]), 'lib', '1.0.0')).toBeNull()
  })
  it('複数あればいちばん大きい fixed（記録の文字列のまま）', () => {
    const x = detailOf([
      { package: pkg(), ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.0' }] }] },
      { package: pkg(), ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.10.0' }] }] },
    ])
    expect(fixedVersionFor(x, 'lib', '1.0.0')).toBe('1.10.0')
  })
})

describe('fixedVersionFor の events の読み方', () => {
  const one = (events: Array<Record<string, string>>) => detailOf([{ package: pkg(), ranges: [{ type: 'SEMVER', events }] }])
  it('last_affected のあとは始まりを忘れる', () => {
    expect(fixedVersionFor(one([{ introduced: '0' }, { last_affected: '0.4.0' }, { fixed: '2.0.0' }]), 'lib', '0.5.0')).toBeNull()
  })
  it('fixed のあとは始まりを忘れる', () => {
    expect(fixedVersionFor(one([{ introduced: '0' }, { fixed: '1.0.0' }, { fixed: '2.0.0' }]), 'lib', '1.5.0')).toBeNull()
  })
  it('読めない introduced があれば、前の fixed があっても範囲ごと捨てる', () => {
    expect(fixedVersionFor(one([{ introduced: '0' }, { fixed: '1.0.0' }, { introduced: 'abc' }, { fixed: '2.0.0' }]), 'lib', '0.5.0')).toBeNull()
  })
  it('読めない fixed があれば、前の fixed があっても範囲ごと捨てる', () => {
    expect(fixedVersionFor(one([{ introduced: '0' }, { fixed: '1.0.0' }, { introduced: '0' }, { fixed: 'abc' }]), 'lib', '0.5.0')).toBeNull()
  })
  it('1つの範囲の中で複数の fixed が含むときは、いちばん大きいもの', () => {
    expect(fixedVersionFor(one([{ introduced: '0' }, { fixed: '2.0.0' }, { introduced: '1.0.0' }, { fixed: '3.0.0' }]), 'lib', '1.5.0')).toBe('3.0.0')
  })
})

describe('readVulnDetail の細部', () => {
  it('withdrawn が空文字なら取り下げ扱いにしない', () => {
    expect(readVulnDetail({ id: 'A-1', withdrawn: '' }, 'A-1')?.withdrawn).toBe(false)
  })
  it('withdrawn が空でない文字列なら true', () => {
    expect(readVulnDetail({ id: 'A-1', withdrawn: '2024-01-01T00:00:00Z' }, 'A-1')?.withdrawn).toBe(true)
  })
  it('package の無い要素は ranges が壊れていても飛ばす', () => {
    const d = readVulnDetail({ id: 'A-1', affected: [{ ranges: 5 }, { package: { name: 'lib', ecosystem: 'npm' }, ranges: [] }] }, 'A-1')
    expect(d?.affected).toEqual([{ name: 'lib', ecosystem: 'npm', ranges: [] }])
  })
  it('package があって ranges が壊れていれば全体 null', () => {
    expect(readVulnDetail({ id: 'A-1', affected: [{ package: { name: 'lib', ecosystem: 'npm' }, ranges: 5 }] }, 'A-1')).toBeNull()
  })
})

describe('fixedVersionFor: 選んだバージョン自身がまだ弱点に入るなら出さない', () => {
  const det = (ranges: Array<{ type: string; events: Array<Record<string, string>> }>) =>
    ({ id: 'X-1', withdrawn: false, severityLabel: null, affected: [{ name: 'a', ecosystem: 'npm', ranges }] })
  it('隣り合う範囲（fixed と同じバージョンから、また始まる）→ null', () => {
    const d = det([{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.0' }, { introduced: '1.0.0' }, { fixed: '2.0.0' }] }])
    expect(fixedVersionFor(d, 'a', '0.5.0')).toBeNull()
    expect(fixedVersionFor(d, 'a', '1.5.0')).toBe('2.0.0')
  })
  it('別の範囲が、選んだバージョンを含む → null', () => {
    const d = det([
      { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.0' }] },
      { type: 'SEMVER', events: [{ introduced: '1.1.0' }, { fixed: '1.3.0' }] },
    ])
    expect(fixedVersionFor(d, 'a', '1.0.0')).toBeNull()
  })
  it('別の範囲が last_affected で、選んだバージョンを含む → null。含まなければ出す', () => {
    const inRange = det([
      { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.0' }] },
      { type: 'SEMVER', events: [{ introduced: '1.2.0' }, { last_affected: '1.2.5' }] },
    ])
    expect(fixedVersionFor(inRange, 'a', '1.0.0')).toBeNull()
    const apart = det([
      { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.0' }] },
      { type: 'SEMVER', events: [{ introduced: '2.0.0' }, { last_affected: '2.0.5' }] },
    ])
    expect(fixedVersionFor(apart, 'a', '1.0.0')).toBe('1.2.0')
  })
  it('終わりの無い範囲（introduced だけ）が、選んだバージョンを含む → null', () => {
    const d = det([
      { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.0' }] },
      { type: 'SEMVER', events: [{ introduced: '1.0.0' }] },
    ])
    expect(fixedVersionFor(d, 'a', '0.5.0')).toBeNull()
  })
  it('同じライブラリに読めない範囲があれば、確かめられないので null', () => {
    const d = det([
      { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.0' }] },
      { type: 'SEMVER', events: [{ introduced: 'abc' }, { fixed: '9.0.0' }] },
    ])
    expect(fixedVersionFor(d, 'a', '0.5.0')).toBeNull()
  })
  it('離れた別の系列があるだけなら、そのまま出す', () => {
    const d = det([
      { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.19.2' }] },
      { type: 'SEMVER', events: [{ introduced: '5.0.0-alpha.1' }, { fixed: '5.0.0-beta.3' }] },
    ])
    expect(fixedVersionFor(d, 'a', '4.17.1')).toBe('4.19.2')
  })
})

describe('readBatchReply: 続きを取るための値の長さ', () => {
  it('2,000 字までは受け、超えたら全体を null', () => {
    expect(readBatchReply({ results: [{ next_page_token: 'x'.repeat(2000) }] }, 1)).toEqual([{ ids: [], nextPageToken: 'x'.repeat(2000) }])
    expect(readBatchReply({ results: [{ next_page_token: 'x'.repeat(2001) }] }, 1)).toBeNull()
  })
})

describe('highestVersion', () => {
  it('空は null', () => expect(highestVersion([])).toBeNull())
  it('読めないものが1つでもあれば null', () => expect(highestVersion(['1.0.0', 'x'])).toBeNull())
  it('いちばん大きいものの元の文字列', () => expect(highestVersion(['4.19.2', '4.20.0', '5.0.0-beta.3'])).toBe('5.0.0-beta.3'))
  it('数として比べる', () => expect(highestVersion(['1.9.0', '1.10.0'])).toBe('1.10.0'))
})

describe('isOsvId / osvLinkFor', () => {
  it('GHSA は可', () => {
    expect(isOsvId('GHSA-rv95-896h-c2vc')).toBe(true)
    expect(osvLinkFor('GHSA-rv95-896h-c2vc')).toBe('https://osv.dev/vulnerability/GHSA-rv95-896h-c2vc')
  })
  it.each(['a/b', 'a?b', '', 'a'.repeat(101), 'a\nb'])('不可: %j', (id) => {
    expect(isOsvId(id)).toBe(false)
    expect(osvLinkFor(id)).toBeNull()
  })
  it('文字列でなければ不可', () => expect(isOsvId(1)).toBe(false))
  it('100 字は可', () => expect(isOsvId('a'.repeat(100))).toBe(true))
  it('「.」「..」や、記号で始まる ID は不可（URL に入れると別の場所を指す）', () => {
    for (const id of ['.', '..', '.a', '-a', '_a', '..GHSA']) {
      expect(isOsvId(id)).toBe(false)
      expect(osvLinkFor(id)).toBeNull()
    }
    expect(isOsvId('a..b')).toBe(true)
  })
})
