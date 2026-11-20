import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  PUBLISH_SCAN_FILE_LIMIT_BYTES,
  PUBLISH_SCAN_TOTAL_LIMIT_BYTES,
  PUBLISH_SCAN_MAX_FILES,
} from '../src/shared/publishScanLimits'
import { WRITE_CHECK_MAX_LINE_CHARS } from '../src/shared/writeCheckLimits'

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const readme = read('README.md')
const guide = read('docs/usage-guide.html')
const security = read('SECURITY.md')

function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from)
  expect(a, `${from} が見つからない`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a + from.length)
  expect(b, `${to} が見つからない`).toBeGreaterThan(a)
  return src.slice(a, b)
}

const readmeSection = between(readme, '### (12) 簡易セキュリティチェック', '### (13)')
const guideSection = between(guide, '<section id="seccheck">', '</section>')
const usageSection = between(guide, '<section id="usage">', '</section>')

const BANNED = ['無償', '無料', 'Claude Code', 'OWASP', '準拠', '対策済み', '部品', '道具', '機械']

describe('Koto の点検の文書', () => {
  it('3つの文書に「Koto の点検」がある', () => {
    for (const doc of [readme, guide, security]) expect(doc).toContain('Koto の点検')
  })

  it('README と使い方ガイドに、ボタンの札と保存するファイルの点検がある', () => {
    for (const doc of [readme, guide]) {
      expect(doc).toContain('【ファイルを点検する】')
      expect(doc).toContain('保存するファイルの点検')
    }
  })

  it('節に、AI による読解だけという古い文が残っていない', () => {
    expect(readmeSection).not.toContain('AI による読解だけです')
    expect(guideSection).not.toContain('AI による読解だけです')
    expect(readmeSection).not.toContain('AIによる簡易的な確認')
    expect(guideSection).not.toContain('AI による簡易的な確認')
  })

  it('該当の行に、使わない語が無い', () => {
    const lines = [readme, guide, security]
      .flatMap(d => d.split('\n'))
      .filter(l => l.includes('Koto の点検') || l.includes('ファイルを点検する') || l.includes('保存するファイルの点検'))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      for (const w of BANNED) expect(l, `「${w}」が入っている`).not.toContain(w)
      expect(l).not.toMatch(/[①-⑳]/)
    }
  })

  it('使い方ガイドの「AIの利用量がかかる場面」は、Koto の点検を AI を使う場面に挙げていない', () => {
    expect(usageSection).toContain('🛡 簡易セキュリティチェック')
    const row = usageSection.split('\n').find(l => l.includes('🛡 簡易セキュリティチェック')) as string
    expect(row).toContain('AI の確認')
    expect(row).toContain('Koto の点検だけのときは、AI を使いません')
    for (const l of usageSection.split('\n').filter(x => x.includes('Koto の点検'))) expect(l).toContain('AI を使いません')
  })

  it('文書に書いた上限の数値が、定数と合う', () => {
    const fmt = (n: number) => n.toLocaleString('en-US')
    for (const sec of [readmeSection, guideSection]) {
      expect(sec).toContain(`${fmt(PUBLISH_SCAN_FILE_LIMIT_BYTES)} バイトを超える`)
      expect(sec).toContain(`${fmt(PUBLISH_SCAN_TOTAL_LIMIT_BYTES)} バイト`)
      expect(sec).toContain(`${fmt(PUBLISH_SCAN_MAX_FILES)} ファイル`)
      expect(sec).toContain(`${fmt(WRITE_CHECK_MAX_LINE_CHARS)} 字を超える行`)
    }
  })
})
