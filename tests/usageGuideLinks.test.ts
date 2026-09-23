import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// docs/usage-guide.html は Koto のアプリ内ヘルプ。目次から各節へ `href="#…"` で飛ぶ。
//
// ── なぜこの検査が要るか（2026-09-16）────────────────────────────────
// 専有型の説明を独立した節へ移したとき、**目次のリンク先（id）を壊しても、どのテストも
// 気づかなかった**（実際に `id` を書き換える変異を当てて確かめた）。担当は手元の道具で
// 確かめていたが、自動の歯止めが無いので、次に節を動かす人は同じ穴に落ちる。
// リンクが切れても画面は壊れず、押しても何も起きないだけなので、**人が気づきにくい**。
const guide = readFileSync(join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')

/** ページ内リンクの飛び先（`href="#…"` の `#` より後ろ）。 */
function inPageLinkTargets(html: string): string[] {
  return [...html.matchAll(/href="#([^"]+)"/g)].map(m => m[1])
}

/** 定義されている id。 */
function definedIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]))
}

describe('使い方ガイド: 目次から各節へのリンクが切れていない', () => {
  it('★ href="#…" の飛び先が、すべて実在する id を指す', () => {
    const ids = definedIds(guide)
    const targets = inPageLinkTargets(guide)
    expect(targets.length).toBeGreaterThan(10) // 目次があること自体も確かめる
    const broken = targets.filter(t => !ids.has(t))
    expect(broken).toEqual([])
  })

  it('★ 本文の節が、すべて目次に載っている（節を足して目次に載せ忘れない）', () => {
    // ── なぜ「どこかからリンクされている」では足りないか（2026-09-16）──────────
    // はじめは「href="#…" のどこかに出てくること」で確かめていたが、③の本文からも
    // 専有型の節へリンクしているため、**目次から消しても素通りした**（変異で確認）。
    // 当て先を**目次の囲みの中だけ**に絞る。
    const toc = guide.slice(guide.indexOf('このガイドの内容'), guide.indexOf('<section id='))
    expect(toc.length).toBeGreaterThan(200) // 目次を取り違えていないことも確かめる
    const inToc = new Set(inPageLinkTargets(toc))
    // 節の書き方は2通りある（`<section id="…">` が既存の形。`<h2 id="…">` もあり得る）。
    // **両方を数える**（片方だけ見ていると、書き方の違う節を見落とす）。
    const body = guide.slice(guide.indexOf('<section id='))
    const sectionIds = [...body.matchAll(/<section\s+id="([^"]+)"/g)].map(m => m[1])
    const h2Ids = [...body.matchAll(/<h2\s+id="([^"]+)"/g)].map(m => m[1])
    const all = [...sectionIds, ...h2Ids]
    expect(all.length).toBeGreaterThan(10)
    const missing = all.filter(id => !inToc.has(id))
    expect(missing).toEqual([])
  })

  it('id が重複していない（同じ名前へ飛ぶと最初のものにしか行けない）', () => {
    const all = [...guide.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
    const dupes = all.filter((v, i) => all.indexOf(v) !== i)
    expect(dupes).toEqual([])
  })
})
