import { describe, it, expect } from 'vitest'
import { findingsInWrite, hasLongLineSkipped, isSampleFileName } from '../src/shared/writeCheck'
import { WRITE_CHECK_MAX_LINE_CHARS } from '../src/shared/writeCheckLimits'

const RISKY = 'exec(req.query.cmd);'
const lineOf = (len: number) => RISKY + ' /*' + 'x'.repeat(len - RISKY.length - 5) + '*/'
const commandHits = (path: string, text: string) =>
  findingsInWrite({ path, before: null, after: text }).filter(f => f.kind === 'input-to-command')

describe('hasLongLineSkipped', () => {
  it('上限ちょうどは偽・1字超えは真', () => {
    expect(lineOf(WRITE_CHECK_MAX_LINE_CHARS).length).toBe(5000)
    expect(hasLongLineSkipped('a.js', lineOf(5000))).toBe(false)
    expect(hasLongLineSkipped('a.js', lineOf(5001))).toBe(true)
  })
  it('前後の空白は数えない', () => {
    expect(hasLongLineSkipped('a.js', '   ' + lineOf(5000) + '   \n')).toBe(false)
  })
  it('拡張子が対象でなければ偽', () => {
    expect(hasLongLineSkipped('a.css', lineOf(6000))).toBe(false)
    expect(hasLongLineSkipped('a.min.js', lineOf(6000))).toBe(true)
  })
  it('長いコメント行だけなら偽', () => {
    expect(hasLongLineSkipped('a.js', '// ' + 'x'.repeat(6000))).toBe(false)
    expect(hasLongLineSkipped('a.html', '<!-- ' + 'x'.repeat(6000) + ' -->')).toBe(false)
  })
  it('見本のファイルは偽', () => {
    expect(hasLongLineSkipped('config.example.js', lineOf(6000))).toBe(false)
  })
  it('findingsInWrite と同じ材料で、ずれない', () => {
    const long = lineOf(5001)
    expect(commandHits('server.js', long)).toEqual([])
    expect(hasLongLineSkipped('server.js', long)).toBe(true)
    const ok = lineOf(5000)
    expect(commandHits('server.js', ok)).toHaveLength(1)
    expect(hasLongLineSkipped('server.js', ok)).toBe(false)
  })
})

describe('isSampleFileName', () => {
  it.each(['config.example.js', 'a.sample', 'x.template.html', 'y.dist.js', 'sub/.env.example'])('%s は真', (f) => {
    expect(isSampleFileName(f)).toBe(true)
  })
  it.each(['example.js', 'sample/a.js', 'dist/a.js', 'a.js'])('%s は偽', (f) => {
    expect(isSampleFileName(f)).toBe(false)
  })
  it('findingsInWrite と hasLongLineSkipped は、同じ判断を使う', () => {
    const KEY = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    for (const f of ['config.example.js', 'a.sample.js', 'x.template.js', 'y.dist.js', 'example.js', 'sample/a.js', 'dist/a.js', 'a.js']) {
      const sample = isSampleFileName(f)
      expect(findingsInWrite({ path: f, before: null, after: `const t = "${KEY}"\n` }).length === 0, f).toBe(sample)
      if (sample) expect(hasLongLineSkipped(f, lineOf(6000)), f).toBe(false)
      else expect(hasLongLineSkipped(f, lineOf(6000)), f).toBe(true)
    }
  })
})
