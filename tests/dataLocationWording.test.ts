import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// HANAMII の説明は「データは国内」と言い、「100%国内」とは言い切らない（README の言い方にそろえる）。
// 3つの画面・説明の文を、前後の語ごと固定する。

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const countOf = (text: string, needle: string) => text.split(needle).length - 1

const CASES = [
  { file: 'src/renderer/components/PublishModal.tsx', sentence: '公開できます。データは国内です。' },
  { file: 'src/renderer/components/HanamiiPanel.tsx', sentence: 'まとめてアップロードします。データは国内。' },
  { file: 'src/renderer/targetProfiles.ts', sentence: '数十秒で公開でき、データは国内。AppRun' },
]

describe('HANAMII の説明の「データは国内」', () => {
  for (const { file, sentence } of CASES) {
    it(`${file}: 「${sentence}」がちょうど1回ある`, () => {
      expect(countOf(read(file), sentence)).toBe(1)
    })

    it(`${file}: 「100%国内」「100% 国内」が無い`, () => {
      const text = read(file)
      expect(text).not.toContain('100%国内')
      expect(text).not.toContain('100% 国内')
    })
  }
})
