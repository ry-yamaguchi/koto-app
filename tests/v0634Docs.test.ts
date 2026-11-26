import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'

// 0.6.34 の分（AI が書いたファイルの ⚠️・「🛠 AIに修正させる」・AI への予防の指示）の CHANGELOG が、実機で確かめた範囲を正しく言う（掟9）。
// 0.6.34 は 2026-11-19 に公開した（書きためていた `## [未リリース]` の節名が `## [0.6.34]` に変わった）。節は版の数で探す。
// 0.6.35 は同じ日に公開の予定で、0.6.34 の節の上に（あれば1つ・直前に）載る。最上部の並び（`[未リリース]`・0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34）はここと v0635Docs が見る。
// ここで見る並びは、0.6.34 の節がちょうど1つで、その上が `[未リリース]` の節（あれば1つ・いちばん上）と 0.6.35 の節（あれば1つ・直前）だけで、その次が公開済みの 0.6.33 の節で、0.6.33 の節が変わっていないこと。
// 0.6.32 以前の並びは v0625Docs〜v0632Docs が、0.6.33 の節の上の並び（`[未リリース]` と 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34 の節だけが載ること）は v0633Docs が見る。
// 公開の木では CHANGELOG の版つきの見出しの角括弧が外れる（`## [0.6.33]` → `## 0.6.33`）ので、版の見出しは角括弧の有無によらず取る。
const CHANGELOG = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')

/** 0.6.34 の公開の予定日（変わったら、ここの1か所だけを直す）。 */
const RELEASE_DATE = '2026-11-19'

// ---- 項目1〜3の、最後の太字の文（実機で確かめた範囲）。CHANGELOG の文を直したら、ここを直す（言い回しだけならここの1か所。確かめた範囲の「向き」を変えるなら、下の MARKS も直す） ----
const LAST_1 = '**0.6.34-rc.1 の実際の画面で確かめました: さくらのAI Engine では、APIキーの形と、訪問者の入力をコマンド・画面（HTML）に使う書き方で ⚠️ が出ること、前からあった行では出ないこと、複数の指摘が1つの吹き出しに並ぶこと、⏹ で止めた回も出ること。Claude では、APIキーの形で ⚠️ が出ることと、⏹ で止めた回は出ないこと。どちらも、値は ⚠️ の吹き出しにも、会話の記録の ⚠️ にも出ませんでした。秘密鍵・接続先の文字列・名前がキーやパスワードらしい固定の値・ファイルのパスに使う書き方・件数や大きさの上限・失敗で終わった回は、まだ確かめていません。**'
const LAST_2 = '**0.6.34-rc.1 の実際の画面で確かめました: 押すと値の入っていない依頼の文が送られること、応答中は押せないこと、AI が直したあとに押すと AI には頼まないこと（さくらのAI Engine と Claude の両方で）。前からの行も含めて頼むところと、送った直後の押し直しは、まだ確かめていません。**'
const LAST_3 = '**0.6.34-rc.1 の実際の画面で確かめました: キーの直書きを頼むと、さくらのAI Engine（Kimi K2.7 Code）は1回目は断り、重ねて頼むと書きました。Claude（Haiku 5.5）は断りました。直すときは、どちらも値の入れ先を聞いてきました。指示が無いときとの比べは、まだ確かめていません。**'
/** 項目の順に、題（太字の見出し）の頭・最後の太字の文（項目4は前の版の実機の確かめの記録で、最後の太字の文を持たない）。 */
const ITEM_SPECS = [
  { head: '- **AI が書いたファイルに、キーやパスワードの直書きなどが残っていたら、⚠️ で知らせます**:', last: LAST_1 },
  { head: '- **⚠️ の吹き出しに【🛠 AIに修正させる】を足しました**:', last: LAST_2 },
  { head: '- **AI への予防の指示を足しました**:', last: LAST_3 },
  { head: '- **0.6.33 について確かめたこと**:', last: null },
] as const
/** 最後の太字の文を持つ項目の数（項目の先頭から）。 */
const WITH_LAST = 3
/**
 * 掟（確かめていないものを確かめたと書かない）の向き。向きを変える直し（rc.1・rc.2 の有無・まだ の有無）をしたら、上の最後の文とここを合わせる。
 * rc1: 0.6.34-rc.1 の実際の画面で確かめたと言う文を含む／rc2: 0.6.34-rc.2 の実際の画面で確かめたと言う文を含む／
 * notYet: 確かめていない範囲を言う文を含む／isolated: 隔離した環境での実測で確かめたと言う文を含む（実際の画面ではない）。
 * 項目の順は ITEM_SPECS の先頭3つと同じ（1 ⚠️ で知らせる／2 AIに修正させる／3 予防の指示）。
 */
const MARKS: ReadonlyArray<{ rc1: boolean; rc2: boolean; notYet: boolean; isolated: boolean }> = [
  { rc1: true, rc2: false, notYet: true, isolated: false }, // 1
  { rc1: true, rc2: false, notYet: true, isolated: false }, // 2
  { rc1: true, rc2: false, notYet: true, isolated: false }, // 3
]
const RC1 = '0.6.34-rc.1 の実際の画面で確かめました'
const RC2 = '0.6.34-rc.2 の実際の画面で確かめました'
const ISOLATED = '隔離した環境での実測で確かめました'
const NOT_YET = 'まだ確かめていません'
const CHECKED = '確かめました'

/** CHANGELOG の `## ` で始まる節（先頭の説明は除く）。上から新しい順。 */
const sectionsOf = (changelog: string): string[] => changelog.split(/\n(?=## )/).filter(s => s.startsWith('## '))
const isUnreleased = (section: string): boolean => /^## \[?未リリース\]?(?![\w.-])/.test(section)
const isVersion = (version: string) => (section: string): boolean =>
  new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(?![\\w.-])`).test(section)
/** 公開済みの節を「変わっていない」と比べるための形（見出しの角括弧・節の間の区切り線・末尾の空白は無いものとする。本文は1文字も変えない）。 */
const frozenForm = (section: string): string =>
  section.replace(/^## \[(\d+\.\d+\.\d+)\]/, '## $1').replace(/(?:\s*\n---)?\s*$/, '')
const fingerprint = (section: string): string => createHash('sha256').update(frozenForm(section)).digest('hex')
/** 公開済みの 0.6.33 の節の指紋（`frozenForm` の形で）。 */
const FROZEN_0633 = '95765dad2fb7465843112c1127a0b135ea2c111ab20966df04ae649f8d368270'

/** CHANGELOG の節の並びの問題（空なら問題なし）。実物と、書き換えた本文（下の試験）の両方に同じ検査をかける。 */
const changelogProblems = (changelog: string): string[] => {
  const sections = sectionsOf(changelog)
  const problems: string[] = []
  const unreleased = sections.filter(isUnreleased)
  if (unreleased.length > 1) problems.push(`[未リリース] の節が ${unreleased.length} 個ある`)
  if (unreleased.length >= 1 && !isUnreleased(sections[0])) problems.push('[未リリース] の節が、いちばん上にない')
  const released = sections.filter(isVersion('0.6.34'))
  if (released.length !== 1) problems.push(`0.6.34 の節が ${released.length} 個ある（1つのはず）`)
  else {
    const above = sections.slice(0, sections.indexOf(released[0]))
    const newer = above.filter(isVersion('0.6.35'))
    const newest = above.filter(isVersion('0.6.36'))
    const peak = above.filter(isVersion('0.6.38'))
    const n39 = above.filter(isVersion('0.6.39'))
    const n40 = above.filter(isVersion('0.6.40'))
    const crest = above.filter(isVersion('0.6.37'))
    if (above.some(s => !isUnreleased(s) && !isVersion('0.6.35')(s) && !isVersion('0.6.36')(s) && !isVersion('0.6.37')(s) && !isVersion('0.6.38')(s) && !isVersion('0.6.39')(s) && !isVersion('0.6.40')(s))) problems.push('0.6.34 の節の上に、`[未リリース]` の節と 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 の節以外がある')
    if (peak.length > 1) problems.push(`0.6.38 の節が ${peak.length} 個ある`)
    if (n39.length > 1) problems.push(`0.6.39 の節が ${n39.length} 個ある`)
    if (n40.length > 1) problems.push(`0.6.40 の節が ${n40.length} 個ある`)
    if (crest.length > 1) problems.push(`0.6.37 の節が ${crest.length} 個ある`)
    if (newest.length > 1) problems.push(`0.6.36 の節が ${newest.length} 個ある`)
    if (([n40, n39, peak, crest, newest, newer] as string[][]).filter(a => a.length === 1).some((a, i, all) => i > 0 && above.indexOf(all[i - 1][0]) > above.indexOf(a[0]))) problems.push('0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 の節の並びが、上から 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 でない')
    if (newer.length > 1) problems.push(`0.6.35 の節が ${newer.length} 個ある`)
    if (newer.length === 1 && above[above.length - 1] !== newer[0]) problems.push('0.6.35 の節が、0.6.34 の節の直前にない')
    if (newer.length === 0 && newest.length === 1 && above[above.length - 1] !== newest[0]) problems.push('0.6.36 の節が、0.6.34 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && crest.length === 1 && above[above.length - 1] !== crest[0]) problems.push('0.6.37 の節が、0.6.34 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && crest.length === 0 && peak.length === 1 && above[above.length - 1] !== peak[0]) problems.push('0.6.38 の節が、0.6.34 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && crest.length === 0 && peak.length === 0 && n39.length === 1 && above[above.length - 1] !== n39[0]) problems.push('0.6.39 の節が、0.6.34 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && crest.length === 0 && peak.length === 0 && n39.length === 0 && n40.length === 1 && above[above.length - 1] !== n40[0]) problems.push('0.6.40 の節が、0.6.34 の節の直前にない')
    if (!new RegExp(`^## \\[?0\\.6\\.34\\]? - ${RELEASE_DATE}\\n`).test(released[0])) problems.push('0.6.34 の節の見出し（版と日付）が公開の日でない')
  }
  const published = sections.filter(isVersion('0.6.33'))
  if (released.length === 1 && published.length === 1 && sections[sections.indexOf(released[0]) + 1] !== published[0]) problems.push('0.6.33 の節が、0.6.34 の節の次にない')
  if (published.length !== 1) problems.push(`0.6.33 の節が ${published.length} 個ある（1つのはず）`)
  else if (fingerprint(published[0]) !== FROZEN_0633) problems.push('0.6.33 の節の中身が変わっている')
  return problems
}

/** 末尾のリンクの定義（私有の木だけにある。公開の木では消えるので、1つも無ければ検査しない）の問題。 */
const linkProblems = (changelog: string): string[] => {
  const defs = changelog.split('\n').filter(l => /^\[\d+\.\d+\.\d+\]: /.test(l))
  if (defs.length === 0) return []
  const want = '[0.6.34]: https://github.com/ry-yamaguchi/koto/compare/v0.6.33...v0.6.34'
  const at = defs.indexOf(want)
  if (defs.filter(l => l.startsWith('[0.6.34]:')).length !== 1 || at < 0) return ['[0.6.34] のリンクの定義が、決めた形で1つだけ無い']
  if (!defs[at + 1]?.startsWith('[0.6.33]:')) return ['[0.6.34] のリンクの定義が、[0.6.33] の定義の直前にない']
  return []
}

const itemsOf = (changelog: string): string[] =>
  (sectionsOf(changelog).find(isVersion('0.6.34')) ?? '').split('\n').filter(l => l.startsWith('- '))
const lastBold = (item: string): string => item.match(/\*\*[^*]+\*\*\s*$/)?.[0].trim() ?? ''

/** 0.6.34 の節の項目（題・最後の太字の文・確かめた範囲の向き）の問題（空なら問題なし）。実物と公開の木の形の両方に同じ検査をかける。 */
const itemProblems = (changelog: string): string[] => {
  const items = itemsOf(changelog)
  if (items.length !== ITEM_SPECS.length) return [`項目が ${items.length} 個ある（${ITEM_SPECS.length}個のはず）`]
  const problems: string[] = []
  items.forEach((item, i) => {
    const n = i + 1
    if (!item.startsWith(ITEM_SPECS[i].head)) problems.push(`項目${n}の題が違う`)
    if (i >= WITH_LAST) {
      // 前の版の実機の確かめの記録: 最後の太字の文は無く、本文の中に「確かめました」と「まだ確かめていません」の両方がある（この項目の文は今後変えない）
      if (!item.includes(CHECKED)) problems.push(`項目${n}の本文に「${CHECKED}」が無い`)
      if (!item.includes(NOT_YET)) problems.push(`項目${n}の本文に「${NOT_YET}」が無い`)
      return
    }
    const tail = lastBold(item)
    if (tail !== ITEM_SPECS[i].last) problems.push(`項目${n}の最後の太字の文が違う`)
    // 確かめた範囲を言う文は、最後の太字の中にだけある（本文の途中に、確かめたと書かない）
    const body = item.slice(0, item.length - tail.length)
    if (/確かめました|まだ確かめていません/.test(body)) problems.push(`項目${n}の最後の太字の外に、確かめた範囲の文がある`)
    const mark = MARKS[i]
    if (tail.includes(RC1) !== mark.rc1) problems.push(`項目${n}: 「${RC1}」が${mark.rc1 ? '無い' : 'ある'}`)
    if (tail.includes(RC2) !== mark.rc2) problems.push(`項目${n}: 「${RC2}」が${mark.rc2 ? '無い' : 'ある'}`)
    if (tail.includes(ISOLATED) !== mark.isolated) problems.push(`項目${n}: 「${ISOLATED}」が${mark.isolated ? '無い' : 'ある'}`)
    if (tail.includes(NOT_YET) !== mark.notYet) problems.push(`項目${n}: 「${NOT_YET}」が${mark.notYet ? '無い' : 'ある'}`)
    if (!mark.rc1 && !mark.rc2 && !mark.isolated && new RegExp(CHECKED).test(tail)) problems.push(`項目${n}: 確かめていない項目に「${CHECKED}」がある`)
  })
  return problems
}

/** 公開の木の CHANGELOG の形（版の見出しの角括弧が外れ、リンク定義の行が消える）。 */
const toPublicForm = (changelog: string): string =>
  changelog.replace(/^## \[(\d+\.\d+\.\d+)\]/gm, '## $1').replace(/^\[\d+\.\d+\.\d+\]: .*\n?/gm, '')
/** 角括弧つきの形（私有の木の形）。もともと角括弧が無い公開の木で走っても、両方の形を試せるよう組み立てる。 */
const toBracketedForm = (changelog: string): string => changelog.replace(/^## (\d+\.\d+\.\d+)(?= - )/gm, '## [$1]')

/** 0.6.34 の節の中の1か所だけを書き換えた CHANGELOG（同じ文が古い節にもあるので、節の中に限る）。 */
const editSection = (changelog: string, from: string, to: string): string => {
  const section = sectionsOf(changelog).find(isVersion('0.6.34')) ?? ''
  expect(section.split(from).length - 1, `書き換え元が0.6.34の節に1か所でない: ${from.slice(0, 20)}`).toBe(1)
  return changelog.replace(section, section.replace(from, to))
}

const LASTS: string[] = ITEM_SPECS.slice(0, WITH_LAST).map(spec => spec.last as string)
/**
 * 確かめた範囲の文を取り違えた形の問題の一覧。書き換えが元と同じなら空振りなので、名指しで落とす。
 * 項目の行ごと書き換える（最後の太字の文が同じ項目が増えても、取り違えない）。
 */
const swapCases = (changelog: string): { name: string; problems: string[] }[] => {
  const cases: { name: string; problems: string[] }[] = []
  /** 項目 i（0始まり）の行を fn で書き換えた形の問題。 */
  const tryItem = (name: string, i: number, fn: (item: string) => string) => {
    const item = itemsOf(changelog)[i]
    const edited = fn(item)
    expect(edited, `対照の書き換えが当たっていない: ${name}`).not.toBe(item)
    cases.push({ name, problems: itemProblems(editSection(changelog, item, edited)) })
  }
  /** 項目 i の最後の太字の文だけを to に替えた形。 */
  const tryLast = (name: string, i: number, to: string) =>
    tryItem(name, i, item => {
      expect(item.endsWith(LASTS[i]), `項目${i + 1}の末尾が最後の文でない: ${name}`).toBe(true)
      return item.slice(0, item.length - LASTS[i].length) + to
    })
  for (let i = 0; i < WITH_LAST; i++) {
    const n = i + 1
    // 未確認のものを、実際の画面で確かめたと取り違え（rc.1・rc.2・実測）
    tryLast(`項目${n}: 実際の画面で確かめたと書いた（rc.1）`, i, `**${RC1}。**`)
    tryLast(`項目${n}: 実際の画面で確かめたと書いた（rc.2）`, i, `**${RC2}。**`)
    tryLast(`項目${n}: 実測で確かめたと書いた`, i, `**${ISOLATED}。**`)
    // 「まだ」を「確かめました」に取り違え・確かめた範囲の言葉を落とした
    // 取り違えた形は、元の文に頼らず固定の文で作る（元の文が変わっても、書き換えが空振りしない）
    tryLast(`項目${n}: 「まだ」を「確かめました」に取り違え`, i, `**取り違えの試験: ${CHECKED}。**`)
    tryLast(`項目${n}: 「まだ」の文を落とした`, i, '**実際の画面では、確かめていません。**')
    // 最後の文を書き換えた（1文字）
    tryLast(`項目${n}: 最後の文の書き換え`, i, `**${LASTS[i][2] === 'X' ? 'Y' : 'X'}${LASTS[i].slice(3)}`)
    // 最後の太字の文を落とした
    tryItem(`項目${n}: 最後の太字の文を落とした`, i, item => item.slice(0, item.length - LASTS[i].length).trimEnd())
    // 最後の太字の文の外へ、確かめたという文を出した
    tryLast(`項目${n}: 太字の外へ出した`, i, `確かめました。${LASTS[i]}`)
    // 題の頭を1文字変えた
    tryItem(`項目${n}: 題の書き換え`, i, item => item.replace('**', '*'))
  }
  // 項目4（前の版の実機の確かめの記録）: 「まだ確かめていません」を消した・「確かめました」を消した・題の書き換え
  tryItem('項目4: 「まだ確かめていません」を消した', 3, item => item.replace(NOT_YET, '確かめられていません'))
  tryItem('項目4: 「確かめました」を全部消した', 3, item => item.split(CHECKED).join('見ました'))
  tryItem('項目4: 題の書き換え', 3, item => item.replace('0.6.33 について', '0.6.32 について'))
  return cases
}

const SECTION = sectionsOf(CHANGELOG).find(isVersion('0.6.34')) ?? ''
const ITEMS = itemsOf(CHANGELOG)

describe('0.6.34 の CHANGELOG の項目', () => {
  it('★★ 0.6.34 の節が読めていて、項目はちょうど4個で、題の頭が決めたとおり', () => {
    expect(SECTION.length).toBeGreaterThan(200)
    expect(ITEMS).toHaveLength(4)
    expect(ITEM_SPECS).toHaveLength(4)
    expect(MARKS).toHaveLength(WITH_LAST)
    ITEM_SPECS.forEach((spec, i) => expect(ITEMS[i].startsWith(spec.head), `${i + 1} 番目の項目の題`).toBe(true))
  })
  it('★★ 項目1〜3の最後の太字の文（実機で確かめた範囲）が、頭の定数と1文字も違わない', () => {
    for (let i = 0; i < WITH_LAST; i++) {
      expect(lastBold(ITEMS[i]), `${i + 1} 番目の項目の最後の太字`).toBe(LASTS[i])
      expect(ITEMS[i].endsWith(LASTS[i]), `${i + 1} 番目の項目の末尾`).toBe(true)
    }
  })
  it('★★ 掟の向き: 項目1〜3は表（MARKS）のとおりの確かめた範囲を、最後の太字の中にだけ言う', () => {
    expect(itemProblems(CHANGELOG)).toEqual([])
    // 向きの表が、実物と同じ読み方になっていること（表を直さずに文だけ直すと、ここで気づく）
    const head3 = ITEMS.slice(0, WITH_LAST)
    expect(head3.map(x => x.includes(RC1))).toEqual(MARKS.map(m => m.rc1))
    expect(head3.map(x => x.includes(RC2))).toEqual(MARKS.map(m => m.rc2))
    expect(head3.map(x => x.includes(NOT_YET))).toEqual(MARKS.map(m => m.notYet))
    expect(head3.map(x => x.includes(ISOLATED))).toEqual(MARKS.map(m => m.isolated))
    // 項目1〜3の最後の太字の中に、確かめた範囲の文がある（無くなったら、確かめた範囲を言わない項目になる）
    for (const l of LASTS) expect(l).toMatch(/確かめ/)
  })
  it('★★ 項目4（0.6.33 について確かめたこと）は、題の頭と、本文に「確かめました」と「まだ確かめていません」の両方があること', () => {
    const item = ITEMS[3]
    expect(item.startsWith('- **0.6.33 について確かめたこと**:')).toBe(true)
    expect(item).toContain(CHECKED)
    expect(item).toContain(NOT_YET)
    // 項目4は最後の太字の文を持たない（項目1〜3と形が違う）
    expect(lastBold(item)).toBe('')
  })
  it('★★ 対照: 確かめた範囲の文を取り違えた形（rc.1・rc.2・実測に取り違え・「まだ」の取り違え・文を落とした・最後の文の書き換え・太字の外へ出した・題の書き換え・項目4の文を消した・項目の増減）は見つける', () => {
    const cases = swapCases(CHANGELOG)
    expect(cases.length, '対照の形が足りない').toBeGreaterThanOrEqual(27)
    for (const c of cases) expect(c.problems, c.name).not.toEqual([])
    // 項目が3個になった・5個になった
    expect(itemProblems(CHANGELOG.replace(/^- \*\*0\.6\.33 について確かめたこと.*\n/m, ''))).toEqual(['項目が 3 個ある（4個のはず）'])
    expect(itemProblems(CHANGELOG.replace(/^(- \*\*0\.6\.33 について確かめたこと.*\n)/m, '$1- **足した項目**: 試験です。\n'))).toEqual(['項目が 5 個ある（4個のはず）'])
  })
  it('★★ 0.6.34 の節・`[未リリース]` の節（あれば）に、禁止語と丸数字が無い（0.6.34 の節が対象に入っていることも見る）', () => {
    const FORBIDDEN = /Claude Code|無償|無料|道具|[①-⑳㉑-㊿]/
    for (const bad of ['Claude Code で作りました', '無償で使えます', '無料です', '道具を使います', '手順①', '⑳']) expect(FORBIDDEN.test(bad), bad).toBe(true)
    for (const ok of ['手順1', 'Claude に頼みます', '料金は月額です', '1. 選ぶ 2. 押す', 'Claude の実行体', 'ツール']) expect(FORBIDDEN.test(ok), ok).toBe(false)
    const targets = sectionsOf(CHANGELOG).filter(x => isUnreleased(x) || isVersion('0.6.34')(x))
    expect(targets.some(isVersion('0.6.34')), '0.6.34 の節が対象に入っていない').toBe(true)
    for (const section of targets) expect(section, 'CHANGELOG の 0.6.34 の節・[未リリース] の節').not.toMatch(FORBIDDEN)
  })
})

describe('CHANGELOG の節の並び: `[未リリース]` は（あれば）1つだけでいちばん上・0.6.34 の節の上は 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 の節だけ・公開済みの 0.6.33 の節は変わらない', () => {
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

  it('★★ 対照: 先頭に `[未リリース]` の節が1つ載った形は通る（これから書く形を止めない）', () => {
    expect(sectionsOf(BEFORE_WRITING).filter(isUnreleased)).toEqual([])
    const written = insertAbove(BEFORE_WRITING, TOP_VERSION, UNRELEASED_SECTION)
    expect(isUnreleased(top(written))).toBe(true)
    expect(changelogProblems(written)).toEqual([])
  })

  it('★★ `[未リリース]` の節が2つあると見つける', () => {
    const twice = insertAbove(insertAbove(BEFORE_WRITING, TOP_VERSION, UNRELEASED_SECTION), TOP_VERSION, UNRELEASED_SECTION)
    expect(changelogProblems(twice)).toEqual(['[未リリース] の節が 2 個ある'])
  })

  it('★★ `[未リリース]` の節が 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32 の節の下にあると見つける', () => {
    const below = insertAbove(BEFORE_WRITING, '0.6.32', UNRELEASED_SECTION)
    expect(changelogProblems(below)).toEqual(['[未リリース] の節が、いちばん上にない'])
    const betweenNewest = insertAbove(BEFORE_WRITING, '0.6.33', UNRELEASED_SECTION)
    expect(changelogProblems(betweenNewest)).toEqual(['[未リリース] の節が、いちばん上にない', '0.6.33 の節が、0.6.34 の節の次にない'])
  })

  it('★★ 0.6.34 と 0.6.33 の節の間に別の版の節が挟まると見つける', () => {
    const sandwiched = insertAbove(BEFORE_WRITING, '0.6.33', '## 0.6.41 - 2026-11-20\n\n- **試験の項目**: 試験です。\n\n---\n\n')
    expect(changelogProblems(sandwiched)).toEqual(['0.6.33 の節が、0.6.34 の節の次にない'])
  })

  it('★★ 末尾のリンクの定義: [0.6.34] が決めた形で、[0.6.33] の直前にある（公開の木では定義が無いので検査しない）', () => {
    expect(linkProblems(CHANGELOG)).toEqual([])
    const withDefs = CHANGELOG.includes('\n[0.6.34]: ') ? CHANGELOG : `${CHANGELOG}\n[0.6.34]: https://github.com/ry-yamaguchi/koto/compare/v0.6.33...v0.6.34\n[0.6.33]: https://github.com/ry-yamaguchi/koto/compare/v0.6.32...v0.6.33\n`
    const line = '[0.6.34]: https://github.com/ry-yamaguchi/koto/compare/v0.6.33...v0.6.34\n'
    expect(withDefs).toContain(line)
    expect(linkProblems(withDefs)).toEqual([])
    expect(linkProblems(withDefs.replace(line, ''))).not.toEqual([])
    expect(linkProblems(withDefs.replace('v0.6.33...v0.6.34', 'v0.6.33...v0.6.35'))).not.toEqual([])
    expect(linkProblems(withDefs.replace(line, `${line}${line}`))).not.toEqual([])
    expect(linkProblems(toPublicForm(withDefs))).toEqual([])
  })

  it('★★ 公開済みの 0.6.33 の節を書き換えると見つける（1文字でも・見出しでも）', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.33')) ?? ''
    expect(published.length).toBeGreaterThan(200)
    const edited = [
      published.replace('- **', '- **（書き換え）'),
      published.replace('2026-11-18', '2026-11-14'),
      published.replace('まだ確かめていません。', 'もう確かめました。'),
      `${published.trimEnd()}。\n\n---\n`,
    ]
    for (const e of edited) {
      expect(e, '書き換えが当たっていない').not.toBe(published)
      expect(changelogProblems(CHANGELOG.replace(published, e))).toEqual(['0.6.33 の節の中身が変わっている'])
    }
  })

  it('★★ 0.6.34 の節が消えた・2つになった・0.6.33 の下に入れ替わった・見出しの日付が違うときも見つける', () => {
    const released = sectionsOf(CHANGELOG).find(isVersion('0.6.34')) ?? ''
    expect(released.length).toBeGreaterThan(200)
    expect(changelogProblems(CHANGELOG.replace(released, ''))).toEqual(['0.6.34 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, `${released}\n${released}`))).toEqual(['0.6.34 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, released.replace(RELEASE_DATE, '2026-11-14')))).toEqual(['0.6.34 の節の見出し（版と日付）が公開の日でない'])
    // 0.6.34 の節を 0.6.33 の節の下へ動かした形
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.33')) ?? ''
    const swapped = CHANGELOG.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released)
    expect(changelogProblems(swapped)).not.toEqual([])
  })

  it('★★ 0.6.33 の節が消えた・2つになったときも見つける', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.33')) ?? ''
    expect(changelogProblems(CHANGELOG.replace(published, ''))).toEqual(['0.6.33 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(published, `${published}\n${published}`))).toEqual(['0.6.33 の節が 2 個ある（1つのはず）'])
  })

  it('★★ 公開の木の形（版の見出しの角括弧なし・リンク定義なし）でも、実物の検査が通り、壊れた形は見つける', () => {
    // 公開の木（koto-app）の CHANGELOG は、もともと版の見出しに角括弧が無い。どちらの木で走っても
    // 「角括弧あり」と「角括弧なし」の両方を試すよう、角括弧つきの形をここで組み立ててから外す
    const bracketed = toBracketedForm(CHANGELOG)
    const publicForm = toPublicForm(bracketed)
    expect(publicForm).not.toBe(bracketed)
    expect(/^## \[\d/m.test(publicForm), '公開の木の形に、角括弧つきの版の見出しが残っている').toBe(false)
    for (const form of [bracketed, publicForm]) {
      expect(changelogProblems(form)).toEqual([])
      expect(itemProblems(form)).toEqual([])
      expect(itemsOf(form)).toEqual(ITEMS)
    }
    // 先頭に `[未リリース]` が載った形（公開の木では角括弧なしの版の見出しの上に載る）
    const written = toPublicForm(insertAbove(toBracketedForm(BEFORE_WRITING), TOP_VERSION, UNRELEASED_SECTION))
    expect(changelogProblems(written)).toEqual([])
    expect(itemProblems(written)).toEqual([])
    // 壊れた形は、公開の木の形でも見つける
    const released = sectionsOf(publicForm).find(isVersion('0.6.34')) ?? ''
    const published = sectionsOf(publicForm).find(isVersion('0.6.33')) ?? ''
    expect(released.length).toBeGreaterThan(200)
    expect(changelogProblems(publicForm.replace(released, `${released}\n${released}`))).toEqual(['0.6.34 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(publicForm.replace(released, released.replace(RELEASE_DATE, '2026-11-14')))).toEqual(['0.6.34 の節の見出し（版と日付）が公開の日でない'])
    expect(changelogProblems(publicForm.replace(published, published.replace('- **', '- **（書き換え）')))).toEqual(['0.6.33 の節の中身が変わっている'])
    expect(changelogProblems(publicForm.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released))).not.toEqual([])
    for (const c of swapCases(publicForm)) expect(c.problems, `公開の木の形: ${c.name}`).not.toEqual([])
  })
})

describe('0.6.34 の節の上: 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 の節（1つずつ・この順）は通り、2つ・別の版・0.6.34 の下に動いた形は見つける', () => {
  const released = sectionsOf(CHANGELOG).find(isVersion('0.6.34')) ?? ''
  const newer = sectionsOf(CHANGELOG).find(isVersion('0.6.35')) ?? ''
  const newest = sectionsOf(CHANGELOG).find(isVersion('0.6.36')) ?? ''
  const zenith = sectionsOf(CHANGELOG).find(isVersion('0.6.37')) ?? ''
  const meridian = sectionsOf(CHANGELOG).find(isVersion('0.6.38')) ?? ''
  const apex = sectionsOf(CHANGELOG).find(isVersion('0.6.39')) ?? ''
  const vertex = sectionsOf(CHANGELOG).find(isVersion('0.6.40')) ?? ''
  // 見出しの文字列を `## [` と数字の並びで書かない（syncPublic の「角括弧つきの版の見出しで探さない」検査に当たるため。角括弧つきの形を作る試験用）
  const OTHER = `${'## '}${'[0.6.41]'} - 2026-11-20\n\n- **試験の項目**: 試験です。\n\n---\n\n`
  it('★★ 実物は通り、0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 の節が2つ・別の版の節が上にある（0.6.36 の上・0.6.35 と 0.6.34 の間）・0.6.36 と 0.6.35 を入れ替えた形・0.6.34 の下へ動いた形は見つける', () => {
    expect(newer.length).toBeGreaterThan(100)
    expect(newest.length).toBeGreaterThan(100)
    expect(zenith.length).toBeGreaterThan(100)
    expect(meridian.length).toBeGreaterThan(100)
    expect(apex.length).toBeGreaterThan(100)
    expect(vertex.length).toBeGreaterThan(100)
    expect(changelogProblems(CHANGELOG)).toEqual([])
    expect(changelogProblems(CHANGELOG.replace(newest, `${newest}\n${newest}`))).toEqual(['0.6.36 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(zenith, `${zenith}\n${zenith}`))).toEqual(['0.6.37 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(meridian, `${meridian}\n${meridian}`))).toEqual(['0.6.38 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(apex, `${apex}\n${apex}`))).toEqual(['0.6.39 の節が 2 個ある'])
    expect(changelogProblems(CHANGELOG.replace(vertex, `${vertex}\n${vertex}`))).toEqual(['0.6.40 の節が 2 個ある'])
    // 0.6.37 と 0.6.36 を入れ替えた形
    expect(changelogProblems(CHANGELOG.replace(zenith, '@@A').replace(newest, '@@B').replace('@@A', newest).replace('@@B', zenith))).not.toEqual([])
    // 0.6.38 と 0.6.37 を入れ替えた形
    expect(changelogProblems(CHANGELOG.replace(meridian, '@@A').replace(zenith, '@@B').replace('@@A', zenith).replace('@@B', meridian))).not.toEqual([])
    // 0.6.39 と 0.6.38 を入れ替えた形
    expect(changelogProblems(CHANGELOG.replace(apex, '@@A').replace(meridian, '@@B').replace('@@A', meridian).replace('@@B', apex))).not.toEqual([])
    // 0.6.40 と 0.6.39 を入れ替えた形
    expect(changelogProblems(CHANGELOG.replace(vertex, '@@A').replace(apex, '@@B').replace('@@A', apex).replace('@@B', vertex))).not.toEqual([])
    const order = CHANGELOG.replace(newest, '@@A').replace(newer, '@@B').replace('@@A', newer).replace('@@B', newest)
    expect(changelogProblems(order)).toEqual(['0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 の節の並びが、上から 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 でない', '0.6.35 の節が、0.6.34 の節の直前にない'])
    expect(changelogProblems(CHANGELOG.replace(newer, `${newer}\n${newer}`))).toEqual(['0.6.35 の節が 2 個ある'])
    const swapped = CHANGELOG.replace(newer, '@@N').replace(released, '@@R').replace('@@N', released).replace('@@R', newer)
    expect(changelogProblems(swapped)).not.toEqual([])
    const at = CHANGELOG.search(/^## \[?0\.6\.36\]?(?![\w.-])/m)
    const beyond = `${CHANGELOG.slice(0, at)}${OTHER}${CHANGELOG.slice(at)}`
    expect(changelogProblems(beyond)).toEqual(['0.6.34 の節の上に、`[未リリース]` の節と 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 の節以外がある'])
    const betweenAt = CHANGELOG.search(/^## \[?0\.6\.34\]?(?![\w.-])/m)
    const between = `${CHANGELOG.slice(0, betweenAt)}${OTHER}${CHANGELOG.slice(betweenAt)}`
    expect(changelogProblems(between)).toEqual(['0.6.34 の節の上に、`[未リリース]` の節と 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35 の節以外がある', '0.6.35 の節が、0.6.34 の節の直前にない'])
  })
})
