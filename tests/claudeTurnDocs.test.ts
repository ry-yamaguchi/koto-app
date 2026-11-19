import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_OTHER_BUSY_NOTE } from '../src/renderer/claudeTurn'

// README と使い方ガイドが、画面と同じ文で「ほかのプロジェクトで AI が作業中のあいだは送れない」と言う。
const ROOT = path.join(__dirname, '..')
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8')
const GUIDE = fs.readFileSync(path.join(ROOT, 'docs', 'usage-guide.html'), 'utf-8')

describe('Claude の同時の作業の説明', () => {
  // 画面の文の、先頭の印（ℹ️）を除いた本文
  const body = CLAUDE_OTHER_BUSY_NOTE.replace(/^ℹ️ /, '')
  it('画面の文は、決めた文字列', () => {
    expect(CLAUDE_OTHER_BUSY_NOTE).toBe('ℹ️ ほかのプロジェクトで AI が作業中です。終わってから、もう一度送ってください。')
  })
  it('README と使い方ガイドは、画面と同じ文を含む', () => {
    expect(README).toContain(body)
    expect(GUIDE).toContain(body)
  })
  it('打った文が消えないことを、どちらも言う', () => {
    expect(README).toContain('打った文は消えません')
    expect(GUIDE).toContain('打った文は消えません')
  })
})
