import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'

// 0.6.28 の分（HANAMII の失敗の扱い・Brotli の緩和）の CHANGELOG が、実機で確かめた範囲を正しく言う（掟9）。
// 0.6.28 は 2026-11-11 に公開した（書きためていた `## [未リリース]` の節名が `## [0.6.28]` に変わった）。節は版の数で探す。
// CHANGELOG の最上部の並び（`[未リリース]` は（あれば）1つだけでいちばん上・0.6.28 の節・公開済みの 0.6.27 の節は変わらない）はここで見る。
// 0.6.26 以前の並びは v0625Docs・v0626Docs・v0627Docs が見る。
// 公開の木では CHANGELOG の版つきの見出しの角括弧が外れる（`## [0.6.27]` → `## 0.6.27`）ので、版の見出しは角括弧の有無によらず取る。
const CHANGELOG = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')

/** CHANGELOG の `## ` で始まる節（先頭の説明は除く）。上から新しい順。 */
const sectionsOf = (changelog: string): string[] => changelog.split(/\n(?=## )/).filter(s => s.startsWith('## '))
const isUnreleased = (section: string): boolean => /^## \[?未リリース\]?(?![\w.-])/.test(section)
const isVersion = (version: string) => (section: string): boolean =>
  new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(?![\\w.-])`).test(section)
/** 公開済みの節を「変わっていない」と比べるための形（見出しの角括弧・節の間の区切り線・末尾の空白は無いものとする。本文は1文字も変えない）。 */
const frozenForm = (section: string): string =>
  section.replace(/^## \[(\d+\.\d+\.\d+)\]/, '## $1').replace(/(?:\s*\n---)?\s*$/, '')
const fingerprint = (section: string): string => createHash('sha256').update(frozenForm(section)).digest('hex')
/** 公開済みの 0.6.27 の節の指紋（`frozenForm` の形で）。 */
const FROZEN_0627 = 'cbde153530f842aaecc549f0a25c9366685b809ef479316b96f9957c0d83421c'

/** CHANGELOG の節の並びの問題（空なら問題なし）。実物と、書き換えた本文（下の試験）の両方に同じ検査をかける。 */
const changelogProblems = (changelog: string): string[] => {
  const sections = sectionsOf(changelog)
  const problems: string[] = []
  const unreleased = sections.filter(isUnreleased)
  if (unreleased.length > 1) problems.push(`[未リリース] の節が ${unreleased.length} 個ある`)
  if (unreleased.length >= 1 && !isUnreleased(sections[0])) problems.push('[未リリース] の節が、いちばん上にない')
  const released = sections.filter(isVersion('0.6.28'))
  if (released.length !== 1) problems.push(`0.6.28 の節が ${released.length} 個ある（1つのはず）`)
  else {
    if (sections.filter(s => !isUnreleased(s))[0] !== released[0]) problems.push('0.6.28 の節が、`[未リリース]` の節を除いていちばん上にない')
    if (!/^## \[?0\.6\.28\]? - 2026-11-11\n/.test(released[0])) problems.push('0.6.28 の節の見出し（版と日付）が公開の日でない')
  }
  const published = sections.filter(isVersion('0.6.27'))
  if (released.length === 1 && published.length === 1 && sections[sections.indexOf(released[0]) + 1] !== published[0]) problems.push('0.6.27 の節が、0.6.28 の節の次にない')
  if (published.length !== 1) problems.push(`0.6.27 の節が ${published.length} 個ある（1つのはず）`)
  else if (fingerprint(published[0]) !== FROZEN_0627) problems.push('0.6.27 の節の中身が変わっている')
  return problems
}

const SECTION = sectionsOf(CHANGELOG).find(isVersion('0.6.28')) ?? ''
const ITEMS = SECTION.split('\n').filter(l => l.startsWith('- '))
const VERIFIED = '0.6.28-rc.2 の実際の画面で確かめました。'
const UNVERIFIED_TAIL = 'まだ確かめていません。**'
const NOT_VERIFIED_AT_ALL = '**実際の画面では、まだ確かめていません。**'

describe('0.6.28 の CHANGELOG の項目', () => {
  it('★★ 0.6.28 の節が読めていて、項目はちょうど6つで、順に Brotli・✅・20分・鍵・断られた理由・AI の前提', () => {
    expect(SECTION.length).toBeGreaterThan(1000)
    expect(ITEMS).toHaveLength(6)
    const heads = ['- 🔒 **ページを読むときに、Brotli', '- 🐛 **HANAMII の失敗を「✅」と言わない', '- 🔧 **HANAMII の時間のかかる処理を、途中で打ち切らない',
      '- 🐛 **HANAMII のプロジェクトが作られたか分からないときに、保存場所の鍵を取り消さない', '- 🔧 **HANAMII に断られたときの理由を出す', '- 🔧 **AI に伝える HANAMII の前提を直しました']
    heads.forEach((h, i) => expect(ITEMS[i].startsWith(h), `${i + 1} 番目の項目の頭`).toBe(true))
  })
  it('★★ 項目1・2・3・5 は「0.6.28-rc.2 の実際の画面で確かめました。」を含み、末尾は確かめていない範囲の一文で終わる', () => {
    for (const i of [0, 1, 2, 4]) {
      expect(ITEMS[i], `項目${i + 1}`).toContain(VERIFIED)
      expect(ITEMS[i].endsWith(UNVERIFIED_TAIL), `項目${i + 1} の末尾`).toBe(true)
      expect(ITEMS[i], `項目${i + 1} に旧い一文が残っている`).not.toContain(NOT_VERIFIED_AT_ALL)
    }
  })
  it('★★ 項目4・6 は「実際の画面では、まだ確かめていません。」で終わり、「確かめました」を言わない', () => {
    for (const i of [3, 5]) {
      expect(ITEMS[i].endsWith(NOT_VERIFIED_AT_ALL), `項目${i + 1} の末尾`).toBe(true)
      expect(ITEMS[i], `項目${i + 1}`).not.toContain('確かめました')
    }
  })
  it('★★ 項目1 に CVE の番号があり、項目5 は HANAMII の返事を「返した」と1回の観察として書く（「返すため」と断定しない）', () => {
    expect(ITEMS[0]).toContain('CVE-2026-111497')
    expect(ITEMS[4]).toContain('HANAMII が起動の失敗（deploy_error）として返した')
    expect(ITEMS[4]).not.toContain('HANAMII は起動の失敗として返すため')
  })
  // 反証役の指摘（2026-11-11）: 実機で見ていないこと・原本に無いことを言い切らない
  it('★★ 予定と推定を言い切らない: 項目1 は根本の直しを「予定」と言い、項目2 は旧い版の誤りを「おそれ」と言い、項目5 はエラーコードの意味を4つの種類と言い切らない', () => {
    expect(ITEMS[0]).toContain('次の版で行う予定です。')
    expect(ITEMS[0]).not.toContain('次の版で行います。')
    expect(ITEMS[0]).toContain('Claude の中で別の作業役を動かす道具')
    expect(ITEMS[0]).not.toContain('別の AI を呼び出す道具')
    expect(ITEMS[1]).toContain('と言うおそれがありました。')
    expect(ITEMS[1]).not.toContain('と言うことがありました。')
    expect(ITEMS[4]).toContain('HANAMII が返すエラーコードごとに')
    expect(ITEMS[4]).not.toContain('失敗の種類（構成・ビルド・起動・ヘルスチェック）ごとに')
  })
  it('★★ 項目2 は、応答の最後に書かれた失敗を読む直しを「確かめました」の側に入れない（rc.2 では一度もその形にならなかった）', () => {
    const [verified, notYet] = ITEMS[1].split('0.6.28-rc.2 の実際の画面で確かめました。')
    expect(notYet).toContain('HANAMII が処理の途中の失敗を応答の最後に書いて返したときに失敗として出ること')
    expect(verified).not.toContain('公開し直した新しい版が起動しなかったときに失敗として出ること')
  })
  it('★★ 0.6.28 の節・`[未リリース]` の節（あれば）に、禁止語と丸数字が無い（0.6.28 の節が対象に入っていることも見る）', () => {
    const FORBIDDEN = /Claude Code|無償|無料|[①-⑳㉑-㊿]/
    for (const bad of ['Claude Code で作りました', '無償で使えます', '無料です', '手順①', '⑳']) expect(FORBIDDEN.test(bad), bad).toBe(true)
    for (const ok of ['手順1', 'Claude に頼みます', '料金は月額です', '1. 選ぶ 2. 押す']) expect(FORBIDDEN.test(ok), ok).toBe(false)
    const targets = sectionsOf(CHANGELOG).filter(x => isUnreleased(x) || isVersion('0.6.28')(x))
    expect(targets.some(isVersion('0.6.28')), '0.6.28 の節が対象に入っていない').toBe(true)
    for (const section of targets) expect(section, 'CHANGELOG の 0.6.28 の節・[未リリース] の節').not.toMatch(FORBIDDEN)
  })
})

describe('CHANGELOG の節の並び: `[未リリース]` は（あれば）1つだけでいちばん上・0.6.28 の節がその次・公開済みの 0.6.27 の節は変わらない', () => {
  it('★★ 実物の CHANGELOG に、節の並びの問題が無い', () => {
    expect(changelogProblems(CHANGELOG)).toEqual([])
  })

  // 検査そのものが効くことの試験: 実物を書き換えるかわりに、同じ検査へ書き換えた本文を渡して、見つけることを確かめる
  const top = (changelog: string): string => sectionsOf(changelog)[0]
  /** 指定した版の節の直前に、別の節を挿す。 */
  const insertAbove = (changelog: string, heading: string, inserted: string): string => {
    const at = changelog.search(new RegExp(`^## \\[?${heading.replace(/\./g, '\\.')}\\]?(?![\\w.-])`, 'm'))
    expect(at, `${heading} の節が見つからない`).toBeGreaterThan(0)
    return `${changelog.slice(0, at)}${inserted}${changelog.slice(at)}`
  }
  const UNRELEASED_SECTION = '## [未リリース]\n\n- 🔧 **試験の項目**: 試験です。\n\n---\n\n'
  /** 実物から `[未リリース]` の節（あれば）を抜いた形。挿す試験は、書きためる前の形から始める（次の版を書きためている間も、試験が同じ意味を保つ）。 */
  const BEFORE_WRITING = (() => {
    const at = CHANGELOG.search(/^## \[?未リリース\]?(?![\w.-])/m)
    if (at < 0) return CHANGELOG
    const next = CHANGELOG.slice(at + 1).search(/^## /m)
    expect(next, '[未リリース] の次の節が見つからない').toBeGreaterThan(0)
    return CHANGELOG.slice(0, at) + CHANGELOG.slice(at + 1 + next)
  })()

  it('★★ 対照: 先頭に `[未リリース]` の節が1つ載った形・公開の木の形（角括弧なし）は通る（これから書く形を止めない）', () => {
    expect(sectionsOf(BEFORE_WRITING).filter(isUnreleased)).toEqual([])
    const written = insertAbove(BEFORE_WRITING, '0.6.28', UNRELEASED_SECTION)
    expect(isUnreleased(top(written))).toBe(true)
    expect(changelogProblems(written)).toEqual([])
    const publicForm = written.replace(/^## \[(\d+\.\d+\.\d+)\]/gm, '## $1')
    expect(publicForm).not.toBe(written)
    expect(changelogProblems(publicForm)).toEqual([])
  })

  it('★★ `[未リリース]` の節が2つあると見つける', () => {
    const twice = insertAbove(insertAbove(BEFORE_WRITING, '0.6.28', UNRELEASED_SECTION), '0.6.28', UNRELEASED_SECTION)
    expect(changelogProblems(twice)).toEqual(['[未リリース] の節が 2 個ある'])
  })

  it('★★ `[未リリース]` の節が 0.6.28・0.6.27 の節の下にあると見つける', () => {
    const below = insertAbove(BEFORE_WRITING, '0.6.26', UNRELEASED_SECTION)
    expect(changelogProblems(below)).toEqual(['[未リリース] の節が、いちばん上にない'])
  })

  it('★★ 公開済みの 0.6.27 の節を書き換えると見つける（1文字でも・見出しでも）', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.27')) ?? ''
    expect(published.length).toBeGreaterThan(500)
    const edited = [
      published.replace('🔧', '🐛'),
      published.replace('2026-11-09', '2026-11-10'),
      published.replace('まだ確かめていません。', 'もう確かめました。'),
      `${published.trimEnd()}。\n\n---\n`,
    ]
    for (const e of edited) {
      expect(e, '書き換えが当たっていない').not.toBe(published)
      expect(changelogProblems(CHANGELOG.replace(published, e))).toEqual(['0.6.27 の節の中身が変わっている'])
    }
  })

  it('★★ 0.6.28 の節が消えた・2つになった・0.6.27 の下に入れ替わった・見出しの日付が違うときも見つける', () => {
    const released = sectionsOf(CHANGELOG).find(isVersion('0.6.28')) ?? ''
    expect(released.length).toBeGreaterThan(500)
    expect(changelogProblems(CHANGELOG.replace(released, ''))).toEqual(['0.6.28 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, `${released}\n${released}`))).toEqual(['0.6.28 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, released.replace('2026-11-11', '2026-11-12')))).toEqual(['0.6.28 の節の見出し（版と日付）が公開の日でない'])
    // 0.6.28 の節を 0.6.27 の節の下へ動かした形
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.27')) ?? ''
    const swapped = CHANGELOG.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released)
    expect(changelogProblems(swapped)).not.toEqual([])
  })

  it('★★ 0.6.27 の節が消えた・2つになったときも見つける', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.27')) ?? ''
    expect(changelogProblems(CHANGELOG.replace(published, ''))).toEqual(['0.6.27 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(published, `${published}\n${published}`))).toEqual(['0.6.27 の節が 2 個ある（1つのはず）'])
  })
})
