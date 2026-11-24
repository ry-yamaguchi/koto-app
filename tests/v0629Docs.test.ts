import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'

// 0.6.29 の分（Electron 44・Brotli の根本の直し・eMudhra の証明書の拒否・macOS 13 以上）の CHANGELOG が、実機で確かめた範囲を正しく言う（掟9）。
// 0.6.29 は 2026-11-11 に公開した（書きためていた `## [未リリース]` の節名が `## [0.6.29]` に変わった）。節は版の数で探す。
// 0.6.30・0.6.31 は 2026-11-13 に、0.6.32 は 2026-11-18 に公開済み・0.6.33 は同じ日に公開の予定で、0.6.29 の節の上に（あれば1つずつ・上から 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 の順で）載る。最上部の並び（`[未リリース]`・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30・0.6.29）は v0631Docs・v0630Docs が見る。
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
const FROZEN_0628 = '19ca376175362fdbcb0e785b296c42291a09c790e7cb6691e996a0a33b590612'

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
    const n32 = above.filter(isVersion('0.6.32'))
    const n33 = above.filter(isVersion('0.6.33'))
    const n35 = above.filter(isVersion('0.6.35'))
    const n36 = above.filter(isVersion('0.6.36'))
    const n38 = above.filter(isVersion('0.6.38'))
    const n39 = above.filter(isVersion('0.6.39'))
    const n37 = above.filter(isVersion('0.6.37'))
    const n34 = above.filter(isVersion('0.6.34'))
    if (above.some(s => !isUnreleased(s) && !isVersion('0.6.30')(s) && !isVersion('0.6.31')(s) && !isVersion('0.6.32')(s) && !isVersion('0.6.33')(s) && !isVersion('0.6.34')(s) && !isVersion('0.6.35')(s) && !isVersion('0.6.36')(s) && !isVersion('0.6.37')(s) && !isVersion('0.6.38')(s) && !isVersion('0.6.39')(s))) problems.push('0.6.29 の節の上に、`[未リリース]` の節と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 の節以外がある')
    if (n36.length > 1) problems.push(`0.6.36 の節が ${n36.length} 個ある`)
    if (n38.length > 1) problems.push(`0.6.38 の節が ${n38.length} 個ある`)
    if (n39.length > 1) problems.push(`0.6.39 の節が ${n39.length} 個ある`)
    if (n37.length > 1) problems.push(`0.6.37 の節が ${n37.length} 個ある`)
    if (n35.length > 1) problems.push(`0.6.35 の節が ${n35.length} 個ある`)
    if (n34.length > 1) problems.push(`0.6.34 の節が ${n34.length} 個ある`)
    if (n33.length > 1) problems.push(`0.6.33 の節が ${n33.length} 個ある`)
    if (n32.length > 1) problems.push(`0.6.32 の節が ${n32.length} 個ある`)
    if (newest.length > 1) problems.push(`0.6.31 の節が ${newest.length} 個ある`)
    if (newer.length > 1) problems.push(`0.6.30 の節が ${newer.length} 個ある`)
    const orderOf = (x: string): number => (isVersion('0.6.39')(x) ? -6 : isVersion('0.6.38')(x) ? -5 : isVersion('0.6.37')(x) ? -4 : isVersion('0.6.36')(x) ? -3 : isVersion('0.6.35')(x) ? -2 : isVersion('0.6.34')(x) ? -1 : isVersion('0.6.33')(x) ? 0 : isVersion('0.6.32')(x) ? 1 : isVersion('0.6.31')(x) ? 2 : 3)
    if (above.filter(s => isVersion('0.6.39')(s) || isVersion('0.6.38')(s) || isVersion('0.6.37')(s) || isVersion('0.6.36')(s) || isVersion('0.6.35')(s) || isVersion('0.6.34')(s) || isVersion('0.6.33')(s) || isVersion('0.6.32')(s) || isVersion('0.6.31')(s) || isVersion('0.6.30')(s)).some((s, i, a) => i > 0 && orderOf(a[i - 1]) > orderOf(s))) problems.push('0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 の節の並びが、上から 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 でない')
    if (newer.length === 1 && above[above.length - 1] !== newer[0]) problems.push('0.6.30 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 1 && above[above.length - 1] !== newest[0]) problems.push('0.6.31 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && n32.length === 1 && above[above.length - 1] !== n32[0]) problems.push('0.6.32 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && n32.length === 0 && n33.length === 1 && above[above.length - 1] !== n33[0]) problems.push('0.6.33 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && n32.length === 0 && n33.length === 0 && n34.length === 1 && above[above.length - 1] !== n34[0]) problems.push('0.6.34 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && n32.length === 0 && n33.length === 0 && n34.length === 0 && n35.length === 1 && above[above.length - 1] !== n35[0]) problems.push('0.6.35 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && n32.length === 0 && n33.length === 0 && n34.length === 0 && n35.length === 0 && n36.length === 1 && above[above.length - 1] !== n36[0]) problems.push('0.6.36 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && n32.length === 0 && n33.length === 0 && n34.length === 0 && n35.length === 0 && n36.length === 0 && n37.length === 1 && above[above.length - 1] !== n37[0]) problems.push('0.6.37 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && n32.length === 0 && n33.length === 0 && n34.length === 0 && n35.length === 0 && n36.length === 0 && n37.length === 0 && n38.length === 1 && above[above.length - 1] !== n38[0]) problems.push('0.6.38 の節が、0.6.29 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && n32.length === 0 && n33.length === 0 && n34.length === 0 && n35.length === 0 && n36.length === 0 && n37.length === 0 && n38.length === 0 && n39.length === 1 && above[above.length - 1] !== n39[0]) problems.push('0.6.39 の節が、0.6.29 の節の直前にない')
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
  it('★★ 0.6.29 の節が読めていて、項目はちょうど4つで、順に Brotli・eMudhra・macOS 13・キー', () => {
    expect(SECTION.length).toBeGreaterThan(1000)
    expect(ITEMS).toHaveLength(4)
    const heads = ['- **Koto の土台（Electron）を新しくし、Brotli', '- **鍵が漏れた認証局（eMudhra）', '- **macOS 13 以上が必要になりました', '- **Koto の土台を上げても、保存したキーはそのまま使えます']
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

describe('CHANGELOG の節の並び: 0.6.29 の節は1つだけ・その上は `[未リリース]` と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 の節だけ・次は公開済みの 0.6.28 の節で変わらない', () => {
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
  const UNRELEASED_SECTION = '## [未リリース]\n\n- **試験の項目**: 試験です。\n\n---\n\n'
  /** 実物から `[未リリース]` の節（あれば）を抜いた形。挿す試験は、書きためる前の形から始める（次の版を書きためている間も、試験が同じ意味を保つ）。 */
  const BEFORE_WRITING = (() => {
    const at = CHANGELOG.search(/^## \[?未リリース\]?(?![\w.-])/m)
    if (at < 0) return CHANGELOG
    const next = CHANGELOG.slice(at + 1).search(/^## /m)
    expect(next, '[未リリース] の次の節が見つからない').toBeGreaterThan(0)
    return CHANGELOG.slice(0, at) + CHANGELOG.slice(at + 1 + next)
  })()
  /** 書きためる前の形でいちばん上にある版（`[未リリース]` を挿す先。次の版の節が載っていても、載っていなくても同じ意味を保つ）。 */
  const TOP_VERSION = /^## \[?(\d+\.\d+\.\d+)\]?(?= - )/m.exec(BEFORE_WRITING)?.[1] ?? ''

  it('★★ 対照: 先頭に `[未リリース]` の節が1つ載った形・公開の木の形（角括弧なし）は通る（これから書く形を止めない）', () => {
    expect(sectionsOf(BEFORE_WRITING).filter(isUnreleased)).toEqual([])
    const written = insertAbove(BEFORE_WRITING, TOP_VERSION, UNRELEASED_SECTION)
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
    const twice = insertAbove(insertAbove(BEFORE_WRITING, TOP_VERSION, UNRELEASED_SECTION), '0.6.33', UNRELEASED_SECTION)
    expect(changelogProblems(twice)).toEqual(['[未リリース] の節が 2 個ある'])
  })

  it('★★ `[未リリース]` の節が 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30・0.6.29・0.6.28 の節の下にあると見つける', () => {
    const below = insertAbove(BEFORE_WRITING, '0.6.27', UNRELEASED_SECTION)
    expect(changelogProblems(below)).toEqual(['[未リリース] の節が、いちばん上にない'])
  })

  it('★★ 公開済みの 0.6.28 の節を書き換えると見つける（1文字でも・見出しでも）', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.28')) ?? ''
    expect(published.length).toBeGreaterThan(500)
    const edited = [
      published.replace('- **', '- **（書き換え）'),
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

describe('0.6.29 の節の上: 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 の節（1つずつ・この順）は通り、2つ・別の版・0.6.29 の下に動いた形は見つける', () => {
  const released = sectionsOf(CHANGELOG).find(isVersion('0.6.29')) ?? ''
  const newer = sectionsOf(CHANGELOG).find(isVersion('0.6.30')) ?? ''
  const newest = sectionsOf(CHANGELOG).find(isVersion('0.6.31')) ?? ''
  const uppermost = sectionsOf(CHANGELOG).find(isVersion('0.6.32')) ?? ''
  const peak = sectionsOf(CHANGELOG).find(isVersion('0.6.33')) ?? ''
  const crest = sectionsOf(CHANGELOG).find(isVersion('0.6.34')) ?? ''
  const summit = sectionsOf(CHANGELOG).find(isVersion('0.6.35')) ?? ''
  const pinnacle = sectionsOf(CHANGELOG).find(isVersion('0.6.36')) ?? ''
  const zenith = sectionsOf(CHANGELOG).find(isVersion('0.6.37')) ?? ''
  const meridian = sectionsOf(CHANGELOG).find(isVersion('0.6.38')) ?? ''
  const apex = sectionsOf(CHANGELOG).find(isVersion('0.6.39')) ?? ''
  // 見出しの文字列を `## [` と数字の並びで書かない（syncPublic の「角括弧つきの版の見出しで探さない」検査に当たるため。角括弧つきの形を作る試験用）
  const OTHER = `${'## '}${'[0.6.40]'} - 2026-11-20\n\n- **試験の項目**: 試験です。\n\n---\n\n`
  it('★★ 実物は通り、0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 の節が2つ・別の版の節が上にある（0.6.33 の上・0.6.30 と 0.6.29 の間）・0.6.29 の下へ動いた形・並びが逆の形は見つける', () => {
    expect(newer.length).toBeGreaterThan(100)
    expect(newest.length).toBeGreaterThan(100)
    expect(uppermost.length).toBeGreaterThan(100)
    expect(peak.length).toBeGreaterThan(100)
    expect(crest.length).toBeGreaterThan(100)
    expect(summit.length).toBeGreaterThan(100)
    expect(pinnacle.length).toBeGreaterThan(100)
    expect(zenith.length).toBeGreaterThan(100)
    expect(meridian.length).toBeGreaterThan(100)
    expect(apex.length).toBeGreaterThan(100)
    expect(changelogProblems(CHANGELOG)).toEqual([])
    expect(changelogProblems(CHANGELOG.replace(newer, `${newer}\n${newer}`))).toEqual(['0.6.30 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(newest, `${newest}\n${newest}`))).toEqual(['0.6.31 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(uppermost, `${uppermost}\n${uppermost}`))).toEqual(['0.6.32 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(peak, `${peak}\n${peak}`))).toEqual(['0.6.33 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(crest, `${crest}\n${crest}`))).toEqual(['0.6.34 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(summit, `${summit}\n${summit}`))).toEqual(['0.6.35 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(pinnacle, `${pinnacle}\n${pinnacle}`))).toEqual(['0.6.36 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(zenith, `${zenith}\n${zenith}`))).toEqual(['0.6.37 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(meridian, `${meridian}\n${meridian}`))).toEqual(['0.6.38 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(apex, `${apex}\n${apex}`))).toEqual(['0.6.39 の節が 2 個ある'])
    // 0.6.37 と 0.6.36 を入れ替えた形
    expect(changelogProblems(CHANGELOG.replace(zenith, '@@A').replace(pinnacle, '@@B').replace('@@A', pinnacle).replace('@@B', zenith))).not.toEqual([])
    // 0.6.38 と 0.6.37 を入れ替えた形
    expect(changelogProblems(CHANGELOG.replace(meridian, '@@A').replace(zenith, '@@B').replace('@@A', zenith).replace('@@B', meridian))).not.toEqual([])
    // 0.6.39 と 0.6.38 を入れ替えた形
    expect(changelogProblems(CHANGELOG.replace(apex, '@@A').replace(meridian, '@@B').replace('@@A', meridian).replace('@@B', apex))).not.toEqual([])
    // 0.6.31 と 0.6.30 を入れ替えた形
    const order = CHANGELOG.replace(newest, '@@A').replace(newer, '@@B').replace('@@A', newer).replace('@@B', newest)
    expect(changelogProblems(order)).toEqual(['0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 の節の並びが、上から 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 でない', '0.6.30 の節が、0.6.29 の節の直前にない'])
    const swapped = CHANGELOG.replace(newer, '@@N').replace(released, '@@R').replace('@@N', released).replace('@@R', newer)
    expect(changelogProblems(swapped)).not.toEqual([])
    const at = CHANGELOG.search(/^## \[?0\.6\.33\]?(?![\w.-])/m)
    const beyond = `${CHANGELOG.slice(0, at)}${OTHER}${CHANGELOG.slice(at)}`
    expect(changelogProblems(beyond)).toEqual(['0.6.29 の節の上に、`[未リリース]` の節と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 の節以外がある'])
    const betweenAt = CHANGELOG.search(/^## \[?0\.6\.29\]?(?![\w.-])/m)
    const between = `${CHANGELOG.slice(0, betweenAt)}${OTHER}${CHANGELOG.slice(betweenAt)}`
    expect(changelogProblems(between)).toEqual(['0.6.29 の節の上に、`[未リリース]` の節と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32・0.6.31・0.6.30 の節以外がある', '0.6.30 の節が、0.6.29 の節の直前にない'])
  })
})
