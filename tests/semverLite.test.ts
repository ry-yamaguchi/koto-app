import { describe, it, expect } from 'vitest'
import { parseSemver, compareSemver, isExactVersion } from '../src/shared/semverLite'

// https://semver.org/ の 2.0.0 の厳密な形と、11 節の大小
describe('parseSemver', () => {
  it('数・前置き・ビルドを読む', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] })
    expect(parseSemver('1.0.0-alpha.1')).toEqual({ major: 1, minor: 0, patch: 0, pre: ['alpha', '1'] })
    expect(parseSemver('1.0.0-x-y.0+build.5')).toEqual({ major: 1, minor: 0, patch: 0, pre: ['x-y', '0'] })
    expect(parseSemver('0.0.0')).not.toBeNull()
  })

  it.each([
    'v1.2.3', '1.2', '^1.2.3', '~1.2.3', '>=1.0.0', '1.x', 'latest', '*', '', ' 1.2.3', '1.2.3 ', '1.2.3\n',
    '01.2.3', '1.02.3', '1.2.03', '1.0.0-01', '1.0.0-', '1.0.0-a..b', '1.0.0+', '1.0.0+a..b', '1.0.0-a_b',
    '9007199254740993.0.0', `1.0.0-${'a'.repeat(100)}`,
  ])('受けない形: %j', (v) => {
    expect(parseSemver(v)).toBeNull()
    expect(isExactVersion(v)).toBe(false)
  })

  it.each([4, null, undefined, {}, ['1.2.3'], true])('文字列でない値は受けない: %j', (v) => {
    expect(parseSemver(v)).toBeNull()
    expect(isExactVersion(v)).toBe(false)
  })

  it('長さは 100 字まで', () => {
    const ok = `1.0.0-${'a'.repeat(94)}`
    expect(ok.length).toBe(100)
    expect(isExactVersion(ok)).toBe(true)
  })
})

describe('compareSemver', () => {
  const p = (v: string) => parseSemver(v)!

  it('semver.org の例の並びを、隣り合う全部の組で', () => {
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
    for (let i = 0; i + 1 < order.length; i++) {
      expect(compareSemver(p(order[i]), p(order[i + 1]))).toBe(-1)
      expect(compareSemver(p(order[i + 1]), p(order[i]))).toBe(1)
    }
  })

  it('major・minor・patch は数として比べる', () => {
    expect(compareSemver(p('1.2.3'), p('1.10.0'))).toBe(-1)
    expect(compareSemver(p('2.0.0'), p('10.0.0'))).toBe(-1)
    expect(compareSemver(p('1.0.9'), p('1.0.10'))).toBe(-1)
    expect(compareSemver(p('1.2.3'), p('1.2.3'))).toBe(0)
  })

  it('数の識別子は英字より小さい・大きな数でも数として比べる', () => {
    expect(compareSemver(p('1.0.0-1'), p('1.0.0-a'))).toBe(-1)
    expect(compareSemver(p('1.0.0-9007199254740993'), p('1.0.0-9007199254740992'))).toBe(1)
  })

  it('英字どうしは ASCII の順', () => {
    expect(compareSemver(p('1.0.0-B'), p('1.0.0-a'))).toBe(-1)
  })

  it('ビルドの印は無視する', () => {
    expect(compareSemver(p('1.0.0+a'), p('1.0.0+b'))).toBe(0)
  })
})
