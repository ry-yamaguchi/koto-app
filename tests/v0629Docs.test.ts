import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'

// 0.6.29 の分（Electron 44・Brotli の根本の直し・eMudhra の証明書の拒否・macOS 13 以上）の CHANGELOG が、実機で確かめた範囲を正しく言う（掟9）。
// 0.6.29 は 2026-11-11 に公開した（書きためていた `## [未リリース]` の節名が `## [0.6.29]` に変わった）。節は版の数で探す。
// 0.6.30・0.6.31 は 2026-11-13 に公開済みで、0.6.29 の節の上に（あれば1つずつ・上から 0.6.31・0.6.30 の順で）載る。最上部の並び（`[未リリース]`・0.6.31・0.6.30・0.6.29）は v0631Docs・v0630Docs が見る。
// ここで見る並びは、0.6.29 の節がちょうど1つで、その次が公開済みの 0.6.28 の節で、0.6.28 の節が変わっていないこと。
// 0.6.27 以前の並びは v0625Docs・v0626Docs・v0627Docs・v0628Docs が見る。
// 公開の木では CHANGELOG の版つきの見出しの角括弧が外れる（`## [0.6.28]` → `## 0.6.28`）ので、版の見出しは角括弧の有無によらず取る。
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
/** 公開済みの 0.6.28 の節の指紋（`frozenForm` の形で）。 */
const FROZEN_0628 = '820203fb3d1caebfc0b0f8993cbed605f69290af8a53198c667f104ea39b1ce2'

/** CHANGELOG の節の並びの問題（空なら問題なし）。実物と、書き換えた本文（下の試験）の両方に同じ検査をかける。 */
const changelogProblems = (changelog: string): string[] => {
  const sections = sectionsOf(changelog)
  const problems: string[] = []
  const unreleased = sections.filter(isUnreleased)
  if (unreleased.length > 1) problems.push(`[未リリース] の節が ${unreleased.length} 個ある`)
  if (unreleased.length >= 1 && !isUnreleased(sections[0])) problems.push('[未リリース] の節が、いちばん上にない')
  const released = sections.filter(isVersion('0.6.29'))
  if (released.length !== 1) problems.push(`0.6.29 の節が ${released.length} 個ある（1つのはず）`)
  else {
    const above = sections.slice(0, sections.indexOf(released[0]))
    const newer = above.filter(isVersion('0.6.30'))
    const newest = above.filter(isVersion('0.6.31'))
    if (above.some(s => !isUnreleased(s) && !isVersion('0.6.30')(s) && !isVersion('0.6.31')(s))) problems.push('0.6.29 の節の上に、`[未リリース]` の節と 0.6.31・0.6.30 の節以外がある')
    if (newest.length > 1) problems.push(`0.6.31 の節が ${newest.length} 個ある`)
    if (newer.length > 1) problems.push(`0.6.30 の節が ${newer.length} 個ある`)
    if (newest.length === 1 && newer.length === 1 && above.indexOf(newest[0]) > above.indexOf(newer[0])) problems.push('0.6.31・0.6.30 の節の並びが、上から 0.6.31・0.6.30 でない')
    if (newer.length === 1 && above[above.length - 1] !== newer[0]) problems.push('0.6.30 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 1 && above[above.length - 1] !== newest[0]) problems.push('0.6.31 の節が、0.6.29 の節の直前にない')
    if (!/^## \[?0\.6\.29\]? - 2026-11-11\n/.test(released[0])) problems.push('0.6.29 の節の見出し（版と日付）が公開の日でない')
  }
  const published = sections.filter(isVersion('0.6.28'))
  if (released.length === 1 && published.length === 1 && sections[sections.indexOf(released[0]) + 1] !== published[0]) problems.push('0.6.28 の節が、0.6.29 の節の次にない')
  if (published.length !== 1) problems.push(`0.6.28 の節が ${published.length} 個ある（1つのはず）`)
  else if (fingerprint(published[0]) !== FROZEN_0628) problems.push('0.6.28 の節の中身が変わっている')
  return problems
}

const SECTION = sectionsOf(CHANGELOG).find(isVersion('0.6.29')) ?? ''
const ITEMS = SECTION.split('\n').filter(l => l.startsWith('- '))
const VERIFIED = '0.6.29-rc.1 の実際の Koto で確かめました。'

describe('0.6.29 の CHANGELOG の項目', () => {
  it('★★ 0.6.29 の節が読めていて、項目はちょうど4つで、順に 🔒 Brotli・🔒 eMudhra・⚠️ macOS 13・🔧 キー', () => {
    expect(SECTION.length).toBeGreaterThan(1000)
    expect(ITEMS).toHaveLength(4)
    const heads = ['- 🔒 **Koto の土台（Electron）を新しくし、Brotli', '- 🔒 **鍵が漏れた認証局（eMudhra）', '- ⚠️ **macOS 13 以上が必要になりました', '- 🔧 **Koto の土台を上げても、保存したキーはそのまま使えます']
    heads.forEach((h, i) => expect(ITEMS[i].startsWith(h), `${i + 1} 番目の項目の頭`).toBe(true))
  })
  it('★★ 項目1: CVE の番号があり、「0.6.29-rc.1 の実際の Koto で確かめました。」を含み、Brotli で圧縮して返すページは「まだ確かめていません。**」で終わる', () => {
    expect(ITEMS[0]).toContain('CVE-2026-111497')
    expect(ITEMS[0]).toContain(VERIFIED)
    expect(ITEMS[0].endsWith('まだ確かめていません。**')).toBe(true)
  })
  it('★★ 項目2: GHSA の番号・crane（まだ拒否しない）・Koto の中の通信の確かめ・画面からは確かめられないもう一方の通信を言う', () => {
    expect(ITEMS[1]).toContain('GHSA-jr5w-w6x2-84p9')
    expect(ITEMS[1]).toContain('crane')
    expect(ITEMS[1]).toContain('0.6.29-rc.1 の Koto の中の通信が')
    expect(ITEMS[1]).toContain('Koto の画面からは確かめられません')
  })
  it('★★ 項目3: macOS 12 以前に更新が届かないことは、確かめていないと言って終わる', () => {
    expect(ITEMS[2].endsWith('**macOS 12 以前の Mac に更新が届かないことは、まだ確かめていません。**')).toBe(true)
  })
  it('★★ 項目4: 手で入れ替えた 0.6.29-rc.1 で確かめたことと、自動更新での入れ替えは確かめていないことを言い、測っていないコンテナレジストリの鍵には触れない', () => {
    expect(ITEMS[3]).toContain('手で入れ替えた 0.6.29-rc.1')
    expect(ITEMS[3].endsWith('自動更新での入れ替えでは、まだ確かめていません。**')).toBe(true)
    expect(ITEMS[3]).not.toContain('コンテナレジストリ')
  })
  it('★★ 0.6.29 の節・`[未リリース]` の節（あれば）に、禁止語と丸数字が無い（0.6.29 の節が対象に入っていることも見る）', () => {
    const FORBIDDEN = /Claude Code|無償|無料|[①-⑳㉑-㊿]/
    for (const bad of ['Claude Code で作りました', '無償で使えます', '無料です', '手順①', '⑳']) expect(FORBIDDEN.test(bad), bad).toBe(true)
    for (const ok of ['手順1', 'Claude に頼みます', '料金は月額です', '1. 選ぶ 2. 押す']) expect(FORBIDDEN.test(ok), ok).toBe(false)
    const targets = sectionsOf(CHANGELOG).filter(x => isUnreleased(x) || isVersion('0.6.29')(x))
    expect(targets.some(isVersion('0.6.29')), '0.6.29 の節が対象に入っていない').toBe(true)
    for (const section of targets) expect(section, 'CHANGELOG の 0.6.29 の節・[未リリース] の節').not.toMatch(FORBIDDEN)
  })
})

describe('CHANGELOG の節の並び: 0.6.29 の節は1つだけ・その上は `[未リリース]` と 0.6.31・0.6.30 の節だけ・次は公開済みの 0.6.28 の節で変わらない', () => {
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
    const written = insertAbove(BEFORE_WRITING, '0.6.31', UNRELEASED_SECTION)
    expect(isUnreleased(top(written))).toBe(true)
    expect(changelogProblems(written)).toEqual([])
    // 公開の木（koto-app）の CHANGELOG は、もともと版の見出しに角括弧が無い。どちらの木で走っても
    // 「角括弧あり」と「角括弧なし」の両方を試すよう、角括弧つきの形をここで組み立ててから外す
    // （2026-11-11、角括弧を外すだけの形は公開の木で元と同じになり、この対照が公開の CI だけで落ちた）。
    const bracketed = written.replace(/^## (\d+\.\d+\.\d+)(?= - )/gm, '## [$1]')
    const publicForm = bracketed.replace(/^## \[(\d+\.\d+\.\d+)\]/gm, '## $1')
    expect(publicForm).not.toBe(bracketed)
    expect(changelogProblems(bracketed)).toEqual([])
    expect(changelogProblems(publicForm)).toEqual([])
  })

  it('★★ `[未リリース]` の節が2つあると見つける', () => {
    const twice = insertAbove(insertAbove(BEFORE_WRITING, '0.6.31', UNRELEASED_SECTION), '0.6.31', UNRELEASED_SECTION)
    expect(changelogProblems(twice)).toEqual(['[未リリース] の節が 2 個ある'])
  })

  it('★★ `[未リリース]` の節が 0.6.31・0.6.30・0.6.29・0.6.28 の節の下にあると見つける', () => {
    const below = insertAbove(BEFORE_WRITING, '0.6.27', UNRELEASED_SECTION)
    expect(changelogProblems(below)).toEqual(['[未リリース] の節が、いちばん上にない'])
  })

  it('★★ 公開済みの 0.6.28 の節を書き換えると見つける（1文字でも・見出しでも）', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.28')) ?? ''
    expect(published.length).toBeGreaterThan(500)
    const edited = [
      published.replace('🔒', '🐛'),
      published.replace('2026-11-11', '2026-11-12'),
      published.replace('まだ確かめていません。', 'もう確かめました。'),
      `${published.trimEnd()}。\n\n---\n`,
    ]
    for (const e of edited) {
      expect(e, '書き換えが当たっていない').not.toBe(published)
      expect(changelogProblems(CHANGELOG.replace(published, e))).toEqual(['0.6.28 の節の中身が変わっている'])
    }
  })

  it('★★ 0.6.29 の節が消えた・2つになった・0.6.28 の下に入れ替わった・見出しの日付が違うときも見つける', () => {
    const released = sectionsOf(CHANGELOG).find(isVersion('0.6.29')) ?? ''
    expect(released.length).toBeGreaterThan(500)
    expect(changelogProblems(CHANGELOG.replace(released, ''))).toEqual(['0.6.29 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, `${released}\n${released}`))).toEqual(['0.6.29 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, released.replace('2026-11-11', '2026-11-12')))).toEqual(['0.6.29 の節の見出し（版と日付）が公開の日でない'])
    // 0.6.29 の節を 0.6.28 の節の下へ動かした形
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.28')) ?? ''
    const swapped = CHANGELOG.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released)
    expect(changelogProblems(swapped)).not.toEqual([])
  })

  it('★★ 0.6.28 の節が消えた・2つになったときも見つける', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.28')) ?? ''
    expect(changelogProblems(CHANGELOG.replace(published, ''))).toEqual(['0.6.28 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(published, `${published}\n${published}`))).toEqual(['0.6.28 の節が 2 個ある（1つのはず）'])
  })
})

describe('0.6.29 の節の上: 0.6.31・0.6.30 の節（1つずつ・この順）は通り、2つ・別の版・0.6.29 の下に動いた形は見つける', () => {
  const released = sectionsOf(CHANGELOG).find(isVersion('0.6.29')) ?? ''
  const newer = sectionsOf(CHANGELOG).find(isVersion('0.6.30')) ?? ''
  const newest = sectionsOf(CHANGELOG).find(isVersion('0.6.31')) ?? ''
  // 見出しの文字列を `## [` と数字の並びで書かない（syncPublic の「角括弧つきの版の見出しで探さない」検査に当たるため。角括弧つきの形を作る試験用）
  const OTHER = `${'## '}${'[0.6.32]'} - 2026-11-12\n\n- 🔧 **試験の項目**: 試験です。\n\n---\n\n`
  it('★★ 実物は通り、0.6.31・0.6.30 の節が2つ・別の版の節が上にある（0.6.31 の上・0.6.30 と 0.6.29 の間）・0.6.29 の下へ動いた形・並びが逆の形は見つける', () => {
    expect(newer.length).toBeGreaterThan(100)
    expect(newest.length).toBeGreaterThan(100)
    expect(changelogProblems(CHANGELOG)).toEqual([])
    expect(changelogProblems(CHANGELOG.replace(newer, `${newer}\n${newer}`))).toEqual(['0.6.30 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(newest, `${newest}\n${newest}`))).toEqual(['0.6.31 の節が 2 個ある'])
    // 0.6.31 と 0.6.30 を入れ替えた形
    const order = CHANGELOG.replace(newest, '@@A').replace(newer, '@@B').replace('@@A', newer).replace('@@B', newest)
    expect(changelogProblems(order)).toEqual(['0.6.31・0.6.30 の節の並びが、上から 0.6.31・0.6.30 でない', '0.6.30 の節が、0.6.29 の節の直前にない'])
    const swapped = CHANGELOG.replace(newer, '@@N').replace(released, '@@R').replace('@@N', released).replace('@@R', newer)
    expect(changelogProblems(swapped)).not.toEqual([])
    const at = CHANGELOG.search(/^## \[?0\.6\.31\]?(?![\w.-])/m)
    const beyond = `${CHANGELOG.slice(0, at)}${OTHER}${CHANGELOG.slice(at)}`
    expect(changelogProblems(beyond)).toEqual(['0.6.29 の節の上に、`[未リリース]` の節と 0.6.31・0.6.30 の節以外がある'])
    const betweenAt = CHANGELOG.search(/^## \[?0\.6\.29\]?(?![\w.-])/m)
    const between = `${CHANGELOG.slice(0, betweenAt)}${OTHER}${CHANGELOG.slice(betweenAt)}`
    expect(changelogProblems(between)).toEqual(['0.6.29 の節の上に、`[未リリース]` の節と 0.6.31・0.6.30 の節以外がある', '0.6.30 の節が、0.6.29 の節の直前にない'])
  })
})
