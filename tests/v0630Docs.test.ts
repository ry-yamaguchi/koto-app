import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'

// 0.6.30 の分（提供が終わったモデルの除去・HANAMII の公開し直しの失敗と案内・接続テストの未保存の知らせ・更新の仕組みの部品）の CHANGELOG が、実機で確かめた範囲を正しく言う（掟9）。
// 0.6.30 は 2026-11-13 に公開した（書きためていた `## [未リリース]` の節名が `## [0.6.30]` に変わった）。節は版の数で探す。
// CHANGELOG の最上部の並び（`[未リリース]` は（あれば）1つだけでいちばん上・0.6.30 の節・公開済みの 0.6.29 の節は変わらない）はここで見る。
// 0.6.28 以前の並びは v0625Docs〜v0629Docs が見る。
// 公開の木では CHANGELOG の版つきの見出しの角括弧が外れる（`## [0.6.29]` → `## 0.6.29`）ので、版の見出しは角括弧の有無によらず取る。
const CHANGELOG = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')

// ---- 5項目それぞれの、最後の太字の文（実機で確かめた範囲）。CHANGELOG の文を直したら、ここを直す（言い回しだけならここの1か所。確かめた範囲の「向き」を変えるなら、下の MARKS も直す。題・対照・公開の木の試験は MARKS から対象を選ぶので、直さなくてよい） ----
const LAST_1 = '**モデルを選ぶ一覧に Kimi K2.6 が出ないことは、0.6.30-rc.1 の実際の画面で確かめました。内蔵の一覧を使う場面（提供中のモデルを取れないとき）と、既定のモデルに選んでいたときの切り替えと知らせは、まだ確かめていません。**'
const LAST_2 = '**ヘルスチェックのパスを、アプリが 404 を返す /nope にして公開し直し、新しい版が起動しなかったあとも、Koto の記録と「📡 公開したもの一覧」に URL と公開日時が前のまま残り、前の版が動き続けることは、0.6.30-rc.1 の実際の画面で確かめました。**'
const LAST_3 = '**ヘルスチェックのパスを /nope にして公開し直した回に、ヘルスチェックのパスも確かめる案内が出ることは、0.6.30-rc.1 の実際の画面で確かめました。ヘルスチェックのパスを変えた再起動を HANAMII が断ったときに、「🚀 公開する（更新）」の案内が出ること、設定を変えずにもう一度再起動して断られたときには出ないことは、0.6.30-rc.2 の実際の画面で確かめました。ヘルスチェックを有効にしていないときに案内が出ないことは、まだ確かめていません。**'
const LAST_4 = '**保存済みのキーで接続テストが通ったときに、この知らせが出ないことは、0.6.30-rc.2 の実際の画面で確かめました。保存していない値で通ったときに知らせが出ることは、まだ確かめていません。**'
const LAST_5 = '**新しい部品で「更新を確認」が動き、「お使いのバージョンは最新です。」と出ることは、0.6.30-rc.1 の実際の画面で確かめました。更新のダウンロードと入れ替えは、まだ確かめていません。**'
/** 項目の順に、題（太字の見出し）の頭・最後の太字の文。 */
const ITEM_SPECS = [
  { head: '- 🔧 **提供が終わったモデル（Kimi K2.6）を外しました**:', last: LAST_1 },
  { head: '- 🐛 **HANAMII の公開し直しに失敗しても、公開中の URL を失わないようにしました**:', last: LAST_2 },
  { head: '- 🔧 **HANAMII の失敗の案内を足しました**:', last: LAST_3 },
  { head: '- 🔧 **接続テストが通ったのに保存していないとき、知らせるようにしました**:', last: LAST_4 },
  { head: '- 🔒 **Koto の更新の仕組みの部品を新しくしました**:', last: LAST_5 },
] as const
/**
 * 掟（確かめていないものを確かめたと書かない）の向き。向きを変える直し（rc.1/rc.2/まだ の有無）をしたら、上の最後の文とここを合わせる。
 * 「何も確かめたと言わない項目」の検査・対照の書き換えは、ここ（MARKS）から対象の項目を選ぶ（いまは該当なし。項目4は、rc.2 で確かめたと言う文になった）。
 * rc1・rc2: その実機の版で確かめたと言う文を含む／notYet: 確かめていない範囲を言う文を含む。
 */
const MARKS: ReadonlyArray<{ rc1: boolean; rc2: boolean; notYet: boolean }> = [
  { rc1: true, rc2: false, notYet: true },
  { rc1: true, rc2: false, notYet: false },
  { rc1: true, rc2: true, notYet: true },
  { rc1: false, rc2: true, notYet: true },
  { rc1: true, rc2: false, notYet: true },
]
const RC1 = '0.6.30-rc.1 の実際の画面で確かめました'
const RC2 = '0.6.30-rc.2 の実際の画面で確かめました'
const NOT_YET = 'まだ確かめていません'

/** CHANGELOG の `## ` で始まる節（先頭の説明は除く）。上から新しい順。 */
const sectionsOf = (changelog: string): string[] => changelog.split(/\n(?=## )/).filter(s => s.startsWith('## '))
const isUnreleased = (section: string): boolean => /^## \[?未リリース\]?(?![\w.-])/.test(section)
const isVersion = (version: string) => (section: string): boolean =>
  new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(?![\\w.-])`).test(section)
/** 公開済みの節を「変わっていない」と比べるための形（見出しの角括弧・節の間の区切り線・末尾の空白は無いものとする。本文は1文字も変えない）。 */
const frozenForm = (section: string): string =>
  section.replace(/^## \[(\d+\.\d+\.\d+)\]/, '## $1').replace(/(?:\s*\n---)?\s*$/, '')
const fingerprint = (section: string): string => createHash('sha256').update(frozenForm(section)).digest('hex')
/** 公開済みの 0.6.29 の節の指紋（`frozenForm` の形で）。 */
const FROZEN_0629 = '0197d67c244665efdf0fc26b82a1890b26008e8a8fc1019a840f5267aa15f1ac'

/** CHANGELOG の節の並びの問題（空なら問題なし）。実物と、書き換えた本文（下の試験）の両方に同じ検査をかける。 */
const changelogProblems = (changelog: string): string[] => {
  const sections = sectionsOf(changelog)
  const problems: string[] = []
  const unreleased = sections.filter(isUnreleased)
  if (unreleased.length > 1) problems.push(`[未リリース] の節が ${unreleased.length} 個ある`)
  if (unreleased.length >= 1 && !isUnreleased(sections[0])) problems.push('[未リリース] の節が、いちばん上にない')
  const released = sections.filter(isVersion('0.6.30'))
  if (released.length !== 1) problems.push(`0.6.30 の節が ${released.length} 個ある（1つのはず）`)
  else {
    if (sections.filter(s => !isUnreleased(s))[0] !== released[0]) problems.push('0.6.30 の節が、`[未リリース]` の節を除いていちばん上にない')
    if (!/^## \[?0\.6\.30\]? - 2026-11-13\n/.test(released[0])) problems.push('0.6.30 の節の見出し（版と日付）が公開の日でない')
  }
  const published = sections.filter(isVersion('0.6.29'))
  if (released.length === 1 && published.length === 1 && sections[sections.indexOf(released[0]) + 1] !== published[0]) problems.push('0.6.29 の節が、0.6.30 の節の次にない')
  if (published.length !== 1) problems.push(`0.6.29 の節が ${published.length} 個ある（1つのはず）`)
  else if (fingerprint(published[0]) !== FROZEN_0629) problems.push('0.6.29 の節の中身が変わっている')
  return problems
}

const itemsOf = (changelog: string): string[] =>
  (sectionsOf(changelog).find(isVersion('0.6.30')) ?? '').split('\n').filter(l => l.startsWith('- '))
const lastBold = (item: string): string => item.match(/\*\*[^*]+\*\*\s*$/)?.[0].trim() ?? ''

/** 0.6.30 の節の5項目（題・最後の太字の文・確かめた範囲の向き）の問題（空なら問題なし）。実物と公開の木の形の両方に同じ検査をかける。 */
const itemProblems = (changelog: string): string[] => {
  const items = itemsOf(changelog)
  if (items.length !== 5) return [`項目が ${items.length} 個ある（5個のはず）`]
  const problems: string[] = []
  items.forEach((item, i) => {
    const n = i + 1
    if (!item.startsWith(ITEM_SPECS[i].head)) problems.push(`項目${n}の題が違う`)
    const tail = lastBold(item)
    if (tail !== ITEM_SPECS[i].last) problems.push(`項目${n}の最後の太字の文が違う`)
    // 確かめた範囲を言う文は、最後の太字の中にだけある（本文の途中に、確かめたと書かない）
    const body = item.slice(0, item.length - tail.length)
    if (/確かめました|まだ確かめていません/.test(body)) problems.push(`項目${n}の最後の太字の外に、確かめた範囲の文がある`)
    const mark = MARKS[i]
    if (tail.includes(RC1) !== mark.rc1) problems.push(`項目${n}: 「${RC1}」が${mark.rc1 ? '無い' : 'ある'}`)
    if (tail.includes(RC2) !== mark.rc2) problems.push(`項目${n}: 「${RC2}」が${mark.rc2 ? '無い' : 'ある'}`)
    if (tail.includes(NOT_YET) !== mark.notYet) problems.push(`項目${n}: 「${NOT_YET}」が${mark.notYet ? '無い' : 'ある'}`)
    if (!mark.rc1 && !mark.rc2 && /確かめました/.test(tail)) problems.push(`項目${n}: 確かめていない項目に「確かめました」がある`)
  })
  return problems
}

/** 公開の木の CHANGELOG の形（版の見出しの角括弧が外れ、リンク定義の行が消える）。 */
const toPublicForm = (changelog: string): string =>
  changelog.replace(/^## \[(\d+\.\d+\.\d+)\]/gm, '## $1').replace(/^\[\d+\.\d+\.\d+\]: .*\n?/gm, '')
/** 角括弧つきの形（私有の木の形）。もともと角括弧が無い公開の木で走っても、両方の形を試せるよう組み立てる。 */
const toBracketedForm = (changelog: string): string => changelog.replace(/^## (\d+\.\d+\.\d+)(?= - )/gm, '## [$1]')

/** 0.6.30 の節の中の1か所だけを書き換えた CHANGELOG（同じ文が古い節にもあるので、節の中に限る）。 */
const editSection = (changelog: string, from: string, to: string): string => {
  const section = sectionsOf(changelog).find(isVersion('0.6.30')) ?? ''
  expect(section.split(from).length - 1, `書き換え元が0.6.30の節に1か所でない: ${from.slice(0, 20)}`).toBe(1)
  return changelog.replace(section, section.replace(from, to))
}

const LASTS: string[] = ITEM_SPECS.map(spec => spec.last)
/**
 * 確かめた範囲の文を取り違えた形の問題の一覧。対象の項目は MARKS から選ぶ（向きが変わっても書き換えが当たる）。
 * 書き換えが元と同じなら空振りなので、名指しで落とす。
 */
const swapCases = (changelog: string): { name: string; problems: string[] }[] => {
  const cases: { name: string; problems: string[] }[] = []
  const tryEdit = (name: string, i: number, to: string) => {
    expect(to, `対照の書き換えが当たっていない: ${name}`).not.toBe(LASTS[i])
    cases.push({ name, problems: itemProblems(editSection(changelog, LASTS[i], to)) })
  }
  // 確かめていない項目（rc1 も rc2 も無い）に「確かめました」を書いた。いまは、どの項目も rc.1 か rc.2 で確かめたと言うので、この枝は動かない（確かめていない項目ができたら動く）
  const none = MARKS.findIndex(m => !m.rc1 && !m.rc2)
  if (none >= 0) tryEdit('確かめていない項目に「確かめました」', none, `**${RC1}。**`)
  // 確かめた項目（rc1 があり「まだ」が無い）に「まだ」を足した
  const noYet = MARKS.findIndex(m => m.rc1 && !m.notYet)
  if (noYet >= 0) tryEdit('確かめた項目に「まだ」', noYet, LASTS[noYet].replace('確かめました。**', `確かめました。${NOT_YET}。**`))
  // rc.2 を rc.1 に取り違えた
  const rc2 = MARKS.findIndex(m => m.rc2)
  if (rc2 >= 0) tryEdit('rc.2 を rc.1 に取り違え', rc2, LASTS[rc2].replace(RC2, RC1))
  // 「まだ確かめていません」の文を落とした
  const notYet = MARKS.findIndex(m => m.notYet)
  if (notYet >= 0) tryEdit('「まだ」の文を落とした', notYet, LASTS[notYet].replace(/[^。*]*まだ確かめていません。/, ''))
  // 最後の太字の文の外へ、確かめたという文を出した
  tryEdit('太字の外へ出した', 0, `確かめました。${LASTS[0]}`)
  return cases
}

const SECTION = sectionsOf(CHANGELOG).find(isVersion('0.6.30')) ?? ''
const ITEMS = itemsOf(CHANGELOG)

describe('0.6.30 の CHANGELOG の項目', () => {
  it('★★ 0.6.30 の節が読めていて、項目はちょうど5つで、順に 🔧 Kimi K2.6・🐛 公開中の URL・🔧 失敗の案内・🔧 接続テストの未保存・🔒 更新の部品', () => {
    expect(SECTION.length).toBeGreaterThan(1000)
    expect(ITEMS).toHaveLength(5)
    ITEM_SPECS.forEach((spec, i) => expect(ITEMS[i].startsWith(spec.head), `${i + 1} 番目の項目の題`).toBe(true))
  })
  it('★★ 5項目それぞれの最後の太字の文（実機で確かめた範囲）が、頭の定数と1文字も違わない', () => {
    ITEM_SPECS.forEach((spec, i) => {
      expect(lastBold(ITEMS[i]), `${i + 1} 番目の項目の最後の太字`).toBe(spec.last)
      expect(ITEMS[i].endsWith(spec.last), `${i + 1} 番目の項目の末尾`).toBe(true)
    })
  })
  it('★★ 掟の向き: 0.6.30-rc.1 で確かめたと言うのは項目1・2・3・5、0.6.30-rc.2 は項目3・4、「まだ確かめていません」は項目1・3・4・5にあって項目2に無い（項目4は rc.1 では確かめていない）', () => {
    expect(itemProblems(CHANGELOG)).toEqual([])
    // 向きの表が、実物と同じ読み方になっていること（表を直さずに文だけ直すと、ここで気づく）
    expect(ITEMS.map(x => x.includes(RC1))).toEqual(MARKS.map(m => m.rc1))
    expect(ITEMS.map(x => x.includes(RC2))).toEqual(MARKS.map(m => m.rc2))
    expect(ITEMS.map(x => x.includes(NOT_YET))).toEqual(MARKS.map(m => m.notYet))
    // rc1 も rc2 も無い項目は、確かめたと一度も言わない（MARKS から選ぶ）
    MARKS.forEach((m, i) => {
      if (!m.rc1 && !m.rc2) expect(ITEMS[i], `項目${i + 1}`).not.toMatch(/確かめました|rc\.[12]/)
    })
  })
  it('★★ 対照: 確かめた範囲の文を取り違えた形（項目2に「まだ」・rc.2 の取り違え・最後の文の書き換え・項目の増減）は見つける', () => {
    const cases = swapCases(CHANGELOG)
    expect(cases.length, '対照の形が足りない').toBeGreaterThanOrEqual(3)
    for (const c of cases) expect(c.problems, c.name).not.toEqual([])
    // 項目が4つになった・6つになった
    expect(itemProblems(CHANGELOG.replace(/^- 🔒 \*\*Koto の更新の仕組み.*\n/m, ''))).toEqual(['項目が 4 個ある（5個のはず）'])
    expect(itemProblems(CHANGELOG.replace(/^(- 🔒 \*\*Koto の更新の仕組み.*\n)/m, '$1- 🔧 **足した項目**: 試験です。\n'))).toEqual(['項目が 6 個ある（5個のはず）'])
  })
  it('★★ 0.6.30 の節・`[未リリース]` の節（あれば）に、禁止語と丸数字が無い（0.6.30 の節が対象に入っていることも見る）', () => {
    const FORBIDDEN = /Claude Code|無償|無料|[①-⑳㉑-㊿]/
    for (const bad of ['Claude Code で作りました', '無償で使えます', '無料です', '手順①', '⑳']) expect(FORBIDDEN.test(bad), bad).toBe(true)
    for (const ok of ['手順1', 'Claude に頼みます', '料金は月額です', '1. 選ぶ 2. 押す']) expect(FORBIDDEN.test(ok), ok).toBe(false)
    const targets = sectionsOf(CHANGELOG).filter(x => isUnreleased(x) || isVersion('0.6.30')(x))
    expect(targets.some(isVersion('0.6.30')), '0.6.30 の節が対象に入っていない').toBe(true)
    for (const section of targets) expect(section, 'CHANGELOG の 0.6.30 の節・[未リリース] の節').not.toMatch(FORBIDDEN)
  })
})

describe('CHANGELOG の節の並び: `[未リリース]` は（あれば）1つだけでいちばん上・0.6.30 の節がその次・公開済みの 0.6.29 の節は変わらない', () => {
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

  it('★★ 対照: 先頭に `[未リリース]` の節が1つ載った形は通る（これから書く形を止めない）', () => {
    expect(sectionsOf(BEFORE_WRITING).filter(isUnreleased)).toEqual([])
    const written = insertAbove(BEFORE_WRITING, '0.6.30', UNRELEASED_SECTION)
    expect(isUnreleased(top(written))).toBe(true)
    expect(changelogProblems(written)).toEqual([])
  })

  it('★★ `[未リリース]` の節が2つあると見つける', () => {
    const twice = insertAbove(insertAbove(BEFORE_WRITING, '0.6.30', UNRELEASED_SECTION), '0.6.30', UNRELEASED_SECTION)
    expect(changelogProblems(twice)).toEqual(['[未リリース] の節が 2 個ある'])
  })

  it('★★ `[未リリース]` の節が 0.6.30・0.6.29・0.6.28 の節の下にあると見つける', () => {
    const below = insertAbove(BEFORE_WRITING, '0.6.27', UNRELEASED_SECTION)
    expect(changelogProblems(below)).toEqual(['[未リリース] の節が、いちばん上にない'])
  })

  it('★★ 公開済みの 0.6.29 の節を書き換えると見つける（1文字でも・見出しでも）', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.29')) ?? ''
    expect(published.length).toBeGreaterThan(500)
    const edited = [
      published.replace('🔒', '🐛'),
      published.replace('2026-11-11', '2026-11-12'),
      published.replace('まだ確かめていません。', 'もう確かめました。'),
      `${published.trimEnd()}。\n\n---\n`,
    ]
    for (const e of edited) {
      expect(e, '書き換えが当たっていない').not.toBe(published)
      expect(changelogProblems(CHANGELOG.replace(published, e))).toEqual(['0.6.29 の節の中身が変わっている'])
    }
  })

  it('★★ 0.6.30 の節が消えた・2つになった・0.6.29 の下に入れ替わった・見出しの日付が違うときも見つける', () => {
    const released = sectionsOf(CHANGELOG).find(isVersion('0.6.30')) ?? ''
    expect(released.length).toBeGreaterThan(500)
    expect(changelogProblems(CHANGELOG.replace(released, ''))).toEqual(['0.6.30 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, `${released}\n${released}`))).toEqual(['0.6.30 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, released.replace('2026-11-13', '2026-11-14')))).toEqual(['0.6.30 の節の見出し（版と日付）が公開の日でない'])
    // 0.6.30 の節を 0.6.29 の節の下へ動かした形
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.29')) ?? ''
    const swapped = CHANGELOG.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released)
    expect(changelogProblems(swapped)).not.toEqual([])
  })

  it('★★ 0.6.29 の節が消えた・2つになったときも見つける', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.29')) ?? ''
    expect(changelogProblems(CHANGELOG.replace(published, ''))).toEqual(['0.6.29 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(published, `${published}\n${published}`))).toEqual(['0.6.29 の節が 2 個ある（1つのはず）'])
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
    const written = toPublicForm(insertAbove(toBracketedForm(BEFORE_WRITING), '0.6.30', UNRELEASED_SECTION))
    expect(changelogProblems(written)).toEqual([])
    expect(itemProblems(written)).toEqual([])
    // 壊れた形は、公開の木の形でも見つける
    const released = sectionsOf(publicForm).find(isVersion('0.6.30')) ?? ''
    const published = sectionsOf(publicForm).find(isVersion('0.6.29')) ?? ''
    expect(released.length).toBeGreaterThan(500)
    expect(changelogProblems(publicForm.replace(released, `${released}\n${released}`))).toEqual(['0.6.30 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(publicForm.replace(released, released.replace('2026-11-13', '2026-11-14')))).toEqual(['0.6.30 の節の見出し（版と日付）が公開の日でない'])
    expect(changelogProblems(publicForm.replace(published, published.replace('🔒', '🐛')))).toEqual(['0.6.29 の節の中身が変わっている'])
    expect(changelogProblems(publicForm.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released))).not.toEqual([])
    for (const c of swapCases(publicForm)) expect(c.problems, `公開の木の形: ${c.name}`).not.toEqual([])
  })
})
