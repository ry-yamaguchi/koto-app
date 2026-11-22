import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 公開している文書（README・CHANGELOG・SECURITY・使い方の HTML）に、飾りの絵文字を載せない（掟9。作者の指示 2026-11-20）。
// 文中の絵文字は「画面に実在するもの」だけ。src のどこかに出てくる文字なら、画面に実在しうるとみなす（一覧を手で持たず、src を読んで作る）。
// CHANGELOG の項目の頭に付けていた分類の印（追加・修正などの印）は、画面のものではないので付けない。

const ROOT = path.join(__dirname, '..')
const DOCS = ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'docs/usage-guide.html'] as const
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]/gu

/** 画面のものではない分類の印（項目の頭に付けない）。 */
const CATEGORY_MARKS = ['✨', '🔧', '🐛', '🔒', '📦', '📝', '🔄', '⚠️', '⚠']

/**
 * 例外: 画面に実在しないが、CHANGELOG の履歴の文にだけ出てよい文字（理由つき）。
 * 4つの文書のどこにも出なくなったら「もう要らない例外」として落ちる。
 */
const EXCEPTIONS: Record<string, { only: string; reason: string }> = {
  '☑': { only: 'CHANGELOG.md', reason: '以前の画面のチェックボックス「☑ 画像を使う」を、履歴として引いている' },
  '⭐': { only: 'CHANGELOG.md', reason: '「おすすめマーク（⭐/⚠️）を撤去」と、絵文字そのものを話題にした履歴の文' },
}

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

/** 項目（行頭が「- 」「* 」「+ 」「1. 」。字下げした子の項目も含む）の頭に分類の印がある行を返す。 */
export const categoryMarkedItems = (text: string, doc: string): string[] => {
  const bad: string[] = []
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/)
    const mark = m ? CATEGORY_MARKS.find(c => m[1].startsWith(c)) : undefined
    if (mark) bad.push(`${doc} ${i + 1} 行目: 項目の頭に分類の印「${mark}」がある`)
  })
  return bad
}

/** 文書ごとの、絵文字の出てくる行（どの文書のどの文字か、メッセージに出すため）。 */
const emojiIn = (doc: string): Map<string, number[]> => {
  const found = new Map<string, number[]>()
  read(doc).split('\n').forEach((line, i) => {
    for (const ch of line.match(EMOJI) ?? []) found.set(ch, [...(found.get(ch) ?? []), i + 1])
  })
  return found
}

/** src を再帰で読み、.ts・.tsx・.html・.css に出てくる絵文字の集合を作る。 */
const emojiInSrc = (): Set<string> => {
  const set = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx|html|css)$/.test(entry.name)) for (const ch of fs.readFileSync(full, 'utf-8').match(EMOJI) ?? []) set.add(ch)
    }
  }
  walk(path.join(ROOT, 'src'))
  return set
}

describe('公開している文書に、飾りの絵文字を載せない', () => {
  const changelog = read('CHANGELOG.md')

  it('CHANGELOG の項目（字下げした子の項目も含む）は、分類の印で始まらない', () => {
    expect(categoryMarkedItems(changelog, 'CHANGELOG.md')).toEqual([])
  })

  it('対照: 親の項目・字下げした子の項目・番号の項目の頭の印を、同じ判定で見つける', () => {
    const sample = ['- **題**: 本文', '  - ⚠️ **子**: 本文', '- 🔧 **題2**: 本文', '1. ✨ 番号の項目', '- 📚 資料の検索'].join('\n')
    expect(categoryMarkedItems(sample, '写し')).toEqual([
      '写し 2 行目: 項目の頭に分類の印「⚠️」がある',
      '写し 3 行目: 項目の頭に分類の印「🔧」がある',
      '写し 4 行目: 項目の頭に分類の印「✨」がある',
    ])
  })

  it('CHANGELOG の冒頭に「分類:」の説明の行が無い', () => {
    const bad = changelog.split('\n').flatMap((line, i) => (/^\s*分類\s*[:：]/.test(line) ? [`CHANGELOG.md ${i + 1} 行目: 分類の説明の行が残っている`] : []))
    expect(bad).toEqual([])
  })

  it('4つの文書に出る絵文字は、どれも src にも出てくる（画面に実在しうる）。例外は CHANGELOG の履歴の2つだけ', () => {
    const inSrc = emojiInSrc()
    expect(inSrc.size, 'src から読めた絵文字が少なすぎる（読み方が壊れている）').toBeGreaterThan(20)
    const bad: string[] = []
    for (const doc of DOCS) {
      for (const [ch, lines] of emojiIn(doc)) {
        if (inSrc.has(ch)) continue
        if (EXCEPTIONS[ch]?.only === doc) continue
        const code = `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`
        bad.push(`${doc} ${lines.slice(0, 5).join('・')} 行目: 「${ch}」(${code}) は src の画面に出てこない（飾りなら消す。履歴として要るなら EXCEPTIONS に理由つきで足す）`)
      }
    }
    expect(bad).toEqual([])
  })

  it('例外の文字は、いまも文書に出ている（もう要らない例外は外す）', () => {
    const inSrc = emojiInSrc()
    const bad: string[] = []
    for (const [ch, { only, reason }] of Object.entries(EXCEPTIONS)) {
      const used = DOCS.some(doc => emojiIn(doc).has(ch))
      if (!used) bad.push(`例外「${ch}」（${reason}）は、4つの文書のどこにも出ていない。EXCEPTIONS から外す`)
      if (!emojiIn(only).has(ch)) bad.push(`例外「${ch}」は ${only} に出る前提だが、出ていない`)
      if (inSrc.has(ch)) bad.push(`例外「${ch}」は src に出てくるので、例外にしなくてよい。EXCEPTIONS から外す`)
    }
    expect(bad).toEqual([])
  })
})
