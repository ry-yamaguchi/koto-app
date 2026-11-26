import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'

// 0.6.38 の分（【公開】の簡易セキュリティチェックの AI の確認の見積り・小さいファイルから送る・答えの確かめ・AIに修正させる、使う AI とモデルのプロジェクトごとの記憶など）の CHANGELOG が、実機で確かめた範囲を正しく言う（掟9）。
// 0.6.38 は 2026-11-21 に公開した（書きためていた `## [未リリース]` の節名が `## [0.6.38]` に変わった）。節は版の数で探す。
// 0.6.39 は 2026-11-24 に公開済み・0.6.40 は公開の予定で、0.6.38 の節の上に（あれば1つずつ・上から 0.6.40・0.6.39 の順で）載る。最上部の並び（`[未リリース]`・0.6.40・0.6.39・0.6.38）はここと v0639Docs が見る。
// ここで見る並びは、0.6.38 の節がちょうど1つで、その上が `[未リリース]` の節（あれば1つ・いちばん上）と 0.6.40・0.6.39 の節（あれば1つずつ・この順）だけで、その次が公開済みの 0.6.37 の節で、0.6.37 の節が変わっていないこと。
// 0.6.36 以前の並びは v0625Docs〜v0636Docs が、0.6.37 の節の上の並び（`[未リリース]` と 0.6.40・0.6.39・0.6.38 の節だけが載ること）は v0637Docs が見る。
// 公開の木では CHANGELOG の版つきの見出しの角括弧が外れる（`## [0.6.38]` → `## 0.6.38`）ので、版の見出しは角括弧の有無によらず取る。
const CHANGELOG = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')

/** 0.6.38 の公開日（変わったら、ここの1か所だけを直す）。 */
const RELEASE_DATE = '2026-11-21'

// ---- 項目の、最後の太字の文（実機で確かめた範囲）。CHANGELOG の文を直したら、ここを直す（言い回しだけならここの1か所。確かめた範囲の「向き」を変えるなら、下の MARKS も直す） ----
const LAST_1 = '**0.6.38-rc.1 の実際の画面（さくらのレンタルサーバの公開の画面）で確かめました: 【ファイルを点検する】では AI へ送らず、Koto の点検の結果の下に見積りと【AIに確認してもらう】が出ること。押したときだけ AI の確認が始まり、走っている間は【⏹ 中止する】が出て上のボタンは押せないこと。中止できること。進み具合と【⏹ 中止する】は走らせたプロジェクトの画面にだけ出ること。見積りが出たままプロジェクトを切り替えて戻ると、見積りが消えること。利用量の上限で止める設定のときの見積りは、まだ確かめていません。**'
const LAST_2 = '**0.6.38-rc.1 の実際の画面で、約43万字のファイルと小さいファイル4つのプロジェクトで確かめました: 見積りに「6回に分けて」と「1個のファイルは途中までしか送りません」が出て、小さいファイルは全部送る数に入ること。結果に「途中までしか確認していません」とそのファイルの名前が出て、「問題なし」にならないこと。**'
const LAST_3 = '**リンクでフォルダの外を指すファイルと、4,000,000 バイトを超えるファイルの扱いは、実際の画面ではまだ確かめていません。**'
const LAST_4 = '**0.6.38-rc.1 の実際の画面で、見本のサイトで確かめました: 訪問者の入力を画面に出す書き方の指摘が、行の番号と「（AI の判断）」つきで出て、次の行の AI の一言に値が出ないこと。確かめられていない指摘・「念のため」の欄・読み取れなかった返事の出方は、まだ確かめていません。**'
const LAST_5 = '**0.6.38-rc.1 の実際の画面で確かめました: AI の確認の前から、Koto の点検の指摘だけでボタンが出ること。押すと、Koto の点検と AI の確認の指摘が、場所と種類と決まった直し方だけで依頼に入り（値・引用・AI の一言は入らない）、AI が直したあとに点検し直すと、その指摘が消えること。ファイルそのものへの指摘しか無い回は、ボタンが出ないこと。**'
const LAST_6 = '**0.6.38-rc.1 の実際の画面で、公開の画面を開き直したときに「🕐 前回の AI の確認: 日時 ⚠️ 要確認」が出ることを確かめました。**'
const LAST_7 = '**0.6.38-rc.1 の実際の画面でも、2つのモデルでファイルを読む依頼に正しく答えることと、設定の利用額のモデル別の欄に料金つきで出ることを確かめました。**'
const LAST_8 = '**0.6.38-rc.1 の実際の画面で、さくらのAI Engine で確かめました: チャット欄の上で選んだモデルが、そのプロジェクトだけに効き、ほかのプロジェクトと設定は変わらないこと。設定の「IDEで使うモデル（さくらのAI Engine）」を変えると、選んでいないプロジェクトにすぐ効き、選んだプロジェクトは変わらないこと。使う AI の切り替え（チャット欄の上・右下）が、そのプロジェクトだけに効くこと。設定に「IDEで使うモデル（Claude）」の欄があること。Claude に切り替えて送る回は、まだ確かめていません。**'
const LAST_9 = '**0.6.38-rc.1 の実際の画面で、チャット欄を開いたまま新規プロジェクトを作り（さくらのAI Engine・Gemma 4 31B）、作ったあとの上の表示と作成の依頼の回が、選んだモデルになることを確かめました（設定の利用額のモデル別の欄で確かめた）。**'
const LAST_10 = '**キーが片方しか無いときの案内は、実際の画面ではまだ確かめていません。**'
/** 項目7の本文の途中にある太字（最後の太字ではない）。最後の太字と取り違えないことを試すのに使う。 */
const MID_BOLD_7 = '**2026年11月20日に、提供モデルの一覧・ツール・文脈・画像を実測しました。**'
/** 項目の順に、題（太字の見出し）の頭・最後の太字の文。 */
const ITEM_SPECS = [
  { head: '- **【公開】の「🛡 簡易セキュリティチェック」の AI の確認は、送る前の見積りを見てから始めるようにしました**:', last: LAST_1 },
  { head: '- **AI の確認で量が多いときは、小さいファイルから送り、途中までしか送れなかったファイルも名指しするようにしました**:', last: LAST_2 },
  { head: '- **AI の確認で送るのは、「公開されるもの」（`public` フォルダがあればその中、無ければプロジェクトのフォルダ）の中のふつうのファイルだけにしました**:', last: LAST_3 },
  { head: '- **AI の確認の答えを、Koto が確かめてから出すようにしました**:', last: LAST_4 },
  { head: '- **「🛡 簡易セキュリティチェック」の【🛠 AIに修正させる】は、Koto の点検と AI の確認の両方の指摘から依頼を作るようにしました**:', last: LAST_5 },
  { head: '- **前回の確認の表示を「前回の AI の確認」にしました**:', last: LAST_6 },
  { head: '- **さくらのAI Engine の新しいモデルを2つ選べるようにしました**:', last: LAST_7 },
  { head: '- **使う AI（さくらのAI Engine／Claude）とモデルを、プロジェクトごとに覚えるようにしました**:', last: LAST_8 },
  { head: '- **新規プロジェクトで選んだモデルが、開いていたチャット欄に反映されないことがある不具合を直しました**:', last: LAST_9 },
  { head: '- **使う AI に さくらのAI Engine を選んだプロジェクトで、さくらのAI Engine のキーが無いときは、黙って Claude に切り替えないようにしました**:', last: LAST_10 },
] as const
/** 最後の太字の文を持つ項目の数（項目の先頭から）。 */
const WITH_LAST = 10
/**
 * 掟（確かめていないものを確かめたと書かない）の向き。向きを変える直し（実際の画面で確かめたと言う文の有無・まだ の有無）をしたら、上の最後の文とここを合わせる。
 * rc: 0.6.38-rc.1 の実際の画面で確かめたと言う文を含む／notYet: 確かめていない範囲を言う文を含む。
 */
const MARKS: ReadonlyArray<{ rc: boolean; notYet: boolean }> = [
  { rc: true, notYet: true }, // 1
  { rc: true, notYet: false }, // 2
  { rc: false, notYet: true }, // 3
  { rc: true, notYet: true }, // 4
  { rc: true, notYet: false }, // 5
  { rc: true, notYet: false }, // 6
  { rc: true, notYet: false }, // 7
  { rc: true, notYet: true }, // 8
  { rc: true, notYet: false }, // 9
  { rc: false, notYet: true }, // 10
]
const RC = '0.6.38-rc.1 の実際の画面'
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
/** 公開済みの 0.6.37 の節の指紋（`frozenForm` の形で）。 */
const FROZEN_0637 = 'd5b688c239858a2f67739cc93c6e1fafe2c5caf9d7bdf5e094922748b9892c5a'

/** CHANGELOG の節の並びの問題（空なら問題なし）。実物と、書き換えた本文（下の試験）の両方に同じ検査をかける。 */
const changelogProblems = (changelog: string): string[] => {
  const sections = sectionsOf(changelog)
  const problems: string[] = []
  const unreleased = sections.filter(isUnreleased)
  if (unreleased.length > 1) problems.push(`[未リリース] の節が ${unreleased.length} 個ある`)
  if (unreleased.length >= 1 && !isUnreleased(sections[0])) problems.push('[未リリース] の節が、いちばん上にない')
  const released = sections.filter(isVersion('0.6.38'))
  if (released.length !== 1) problems.push(`0.6.38 の節が ${released.length} 個ある（1つのはず）`)
  else {
    const above = sections.slice(0, sections.indexOf(released[0]))
    const newer = above.filter(isVersion('0.6.39'))
    const newest = above.filter(isVersion('0.6.40'))
    if (above.some(s => !isUnreleased(s) && !isVersion('0.6.39')(s) && !isVersion('0.6.40')(s))) problems.push('0.6.38 の節の上に、`[未リリース]` の節と 0.6.40・0.6.39 の節以外がある')
    if (newest.length > 1) problems.push(`0.6.40 の節が ${newest.length} 個ある`)
    if (newest.length === 1 && newer.length === 1 && above.indexOf(newest[0]) > above.indexOf(newer[0])) problems.push('0.6.40・0.6.39 の節の並びが、上から 0.6.40・0.6.39 でない')
    if (newer.length > 1) problems.push(`0.6.39 の節が ${newer.length} 個ある`)
    if (newer.length === 1 && above[above.length - 1] !== newer[0]) problems.push('0.6.39 の節が、0.6.38 の節の直前にない')
    if (newer.length === 0 && newest.length === 1 && above[above.length - 1] !== newest[0]) problems.push('0.6.40 の節が、0.6.38 の節の直前にない')
    if (!new RegExp(`^## \\[?0\\.6\\.38\\]? - ${RELEASE_DATE}\\n`).test(released[0])) problems.push('0.6.38 の節の見出し（版と日付）が公開の日でない')
  }
  const published = sections.filter(isVersion('0.6.37'))
  if (released.length === 1 && published.length === 1 && sections[sections.indexOf(released[0]) + 1] !== published[0]) problems.push('0.6.37 の節が、0.6.38 の節の次にない')
  if (published.length !== 1) problems.push(`0.6.37 の節が ${published.length} 個ある（1つのはず）`)
  else if (fingerprint(published[0]) !== FROZEN_0637) problems.push('0.6.37 の節の中身が変わっている')
  return problems
}

/** 末尾のリンクの定義（私有の木だけにある。公開の木では消えるので、1つも無ければ検査しない）の問題。 */
const linkProblems = (changelog: string): string[] => {
  const defs = changelog.split('\n').filter(l => /^\[\d+\.\d+\.\d+\]: /.test(l))
  if (defs.length === 0) return []
  const want = '[0.6.38]: https://github.com/ry-yamaguchi/koto/compare/v0.6.37...v0.6.38'
  const at = defs.indexOf(want)
  if (defs.filter(l => l.startsWith('[0.6.38]:')).length !== 1 || at < 0) return ['[0.6.38] のリンクの定義が、決めた形で1つだけ無い']
  if (!defs[at + 1]?.startsWith('[0.6.37]:')) return ['[0.6.38] のリンクの定義が、[0.6.37] の定義の直前にない']
  return []
}

const itemsOf = (changelog: string): string[] =>
  (sectionsOf(changelog).find(isVersion('0.6.38')) ?? '').split('\n').filter(l => l.startsWith('- '))
/** 項目の最後の太字（行末の太字だけ。本文の途中の太字は取らない）。 */
const lastBold = (item: string): string => {
  const t = item.trimEnd()
  if (!t.endsWith('**')) return ''
  const open = t.lastIndexOf('**', t.length - 3)
  return open < 0 ? '' : t.slice(open)
}

/** 0.6.38 の節の項目（題・最後の太字の文・確かめた範囲の向き）の問題（空なら問題なし）。実物と公開の木の形の両方に同じ検査をかける。 */
const itemProblems = (changelog: string): string[] => {
  const items = itemsOf(changelog)
  if (items.length !== ITEM_SPECS.length) return [`項目が ${items.length} 個ある（${ITEM_SPECS.length}個のはず）`]
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
    if (tail.includes(RC) !== mark.rc) problems.push(`項目${n}: 「${RC}」が${mark.rc ? '無い' : 'ある'}`)
    if (tail.includes(NOT_YET) !== mark.notYet) problems.push(`項目${n}: 「${NOT_YET}」が${mark.notYet ? '無い' : 'ある'}`)
    if (!mark.rc && new RegExp(CHECKED).test(tail)) problems.push(`項目${n}: 確かめていない項目に「${CHECKED}」がある`)
  })
  return problems
}

/** 公開の木の CHANGELOG の形（版の見出しの角括弧が外れ、リンク定義の行が消える）。 */
const toPublicForm = (changelog: string): string =>
  changelog.replace(/^## \[(\d+\.\d+\.\d+)\]/gm, '## $1').replace(/^\[\d+\.\d+\.\d+\]: .*\n?/gm, '')
/** 角括弧つきの形（私有の木の形）。もともと角括弧が無い公開の木で走っても、両方の形を試せるよう組み立てる。 */
const toBracketedForm = (changelog: string): string => changelog.replace(/^## (\d+\.\d+\.\d+)(?= - )/gm, '## [$1]')

/** 0.6.38 の節の中の1か所だけを書き換えた CHANGELOG（同じ文が古い節にもあるので、節の中に限る）。 */
const editSection = (changelog: string, from: string, to: string): string => {
  const section = sectionsOf(changelog).find(isVersion('0.6.38')) ?? ''
  expect(section.split(from).length - 1, `書き換え元が0.6.38の節に1か所でない: ${from.slice(0, 20)}`).toBe(1)
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
    // 未確認のものを、実際の画面で確かめたと取り違え（確かめた範囲の文だけを入れ替える）
    tryLast(`項目${n}: 実際の画面で確かめたと書いた`, i, `**${RC}で確かめました。**`)
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
    // 本文の途中の太字の中へ、確かめたという文を入れた（最後の太字と取り違えない）
    if (i === 6) {
      tryItem(`項目${n}: 途中の太字へ入れた`, i, item => item.replace(MID_BOLD_7, '**提供モデルの一覧を調べました。確かめました**'))
      // 本文の途中の太字の外（最後の太字の手前）へ、確かめたという文を書き足した
      tryItem(`項目${n}: 途中の太字の外へ書き足した`, i, item => item.replace(MID_BOLD_7, `${MID_BOLD_7}確かめました。`))
      // 最後の太字を、本文の途中の太字に取り替えた（途中の太字を最後の太字と取り違えない）
      tryLast(`項目${n}: 最後の太字を途中の太字に取り替えた`, i, MID_BOLD_7)
    }
    // 最後の太字を「まだ確かめていません」だけにした
    tryLast(`項目${n}: 最後の太字を「まだ」だけにした`, i, `**${NOT_YET}。**`)
    // 題の頭を1文字変えた
    tryItem(`項目${n}: 題の書き換え`, i, item => item.replace('**', '*'))
  }
  // 2つの項目の最後の太字の文を入れ替えた
  const [first, second] = itemsOf(changelog)
  const swappedFirst = first.slice(0, first.length - LASTS[0].length) + LASTS[1]
  const swappedSecond = second.slice(0, second.length - LASTS[1].length) + LASTS[0]
  cases.push({ name: '2つの項目の最後の太字の文を入れ替えた', problems: itemProblems(editSection(editSection(changelog, first, swappedFirst), second, swappedSecond)) })
  // 2つの項目の順を入れ替えた
  cases.push({ name: '2つの項目の順を入れ替えた', problems: itemProblems(editSection(editSection(changelog, first, '@@F'), second, first).replace('@@F', second)) })
  return cases
}

const SECTION = sectionsOf(CHANGELOG).find(isVersion('0.6.38')) ?? ''
const ITEMS = itemsOf(CHANGELOG)

describe('0.6.38 の CHANGELOG の項目', () => {
  it('★★ 0.6.38 の節が読めていて、項目はちょうど10個で、題の頭が決めたとおり（項目の頭に、絵文字の分類の印が無い）', () => {
    expect(SECTION.length).toBeGreaterThan(200)
    expect(ITEMS).toHaveLength(10)
    expect(ITEM_SPECS).toHaveLength(10)
    for (const item of ITEMS) expect(item.startsWith('- **'), '項目の頭が `- **` でない').toBe(true)
    expect(MARKS).toHaveLength(WITH_LAST)
    ITEM_SPECS.forEach((spec, i) => expect(ITEMS[i].startsWith(spec.head), `${i + 1} 番目の項目の題`).toBe(true))
  })
  it('★★ 各項目の最後の太字の文（実機で確かめた範囲）が、頭の定数と1文字も違わない', () => {
    for (let i = 0; i < WITH_LAST; i++) {
      expect(lastBold(ITEMS[i]), `${i + 1} 番目の項目の最後の太字`).toBe(LASTS[i])
      expect(ITEMS[i].endsWith(LASTS[i]), `${i + 1} 番目の項目の末尾`).toBe(true)
    }
  })
  it('★★ 掟の向き: 各項目は表（MARKS）のとおりの確かめた範囲を、最後の太字の中にだけ言う', () => {
    expect(itemProblems(CHANGELOG)).toEqual([])
    // 向きの表が、実物と同じ読み方になっていること（表を直さずに文だけ直すと、ここで気づく）
    const head3 = ITEMS.slice(0, WITH_LAST)
    // 項目の行全体で見る（本文の途中に「確かめた」と書き足しても、ここで気づく）
    expect(head3.map(x => x.includes(RC))).toEqual(MARKS.map(m => m.rc))
    expect(head3.map(x => x.includes(NOT_YET))).toEqual(MARKS.map(m => m.notYet))
    // 各項目の最後の太字の中に、確かめた範囲の文がある（無くなったら、確かめた範囲を言わない項目になる）
    for (const l of LASTS) expect(l).toMatch(/確かめ/)
  })
  it('★★ 対照: 確かめた範囲の文を取り違えた形（実際の画面で確かめたと取り違え・「まだ」の取り違え・文を落とした・最後の文の書き換え・太字の外へ出した・題の書き換え・項目の増減）は見つける', () => {
    const cases = swapCases(CHANGELOG)
    expect(cases.length, '対照の形が足りない').toBeGreaterThanOrEqual(10)
    for (const c of cases) expect(c.problems, c.name).not.toEqual([])
    // 項目が9個になった・11個になった
    expect(itemProblems(editSection(CHANGELOG, ITEMS[9], ''))).toEqual(['項目が 9 個ある（10個のはず）'])
    expect(itemProblems(editSection(CHANGELOG, ITEMS[0], `${ITEMS[0]}\n- **足した項目**: 試験です。`))).toEqual(['項目が 11 個ある（10個のはず）'])
  })
  it('★★ 0.6.38 の節・`[未リリース]` の節（あれば）に、禁止語と丸数字が無い（0.6.38 の節が対象に入っていることも見る）', () => {
    const FORBIDDEN = /Claude Code|無償|無料|道具|[①-⑳㉑-㊿]/
    for (const bad of ['Claude Code で作りました', '無償で使えます', '無料です', '道具を使います', '手順①', '⑳']) expect(FORBIDDEN.test(bad), bad).toBe(true)
    for (const ok of ['手順1', 'Claude に頼みます', '料金は月額です', '1. 選ぶ 2. 押す', 'Claude の実行体', 'ツール']) expect(FORBIDDEN.test(ok), ok).toBe(false)
    const targets = sectionsOf(CHANGELOG).filter(x => isUnreleased(x) || isVersion('0.6.38')(x))
    expect(targets.some(isVersion('0.6.38')), '0.6.38 の節が対象に入っていない').toBe(true)
    for (const section of targets) expect(section, 'CHANGELOG の 0.6.38 の節・[未リリース] の節').not.toMatch(FORBIDDEN)
  })
})

describe('CHANGELOG の節の並び: `[未リリース]` は（あれば）1つだけでいちばん上・0.6.38 の節の上は 0.6.40・0.6.39 の節だけ・公開済みの 0.6.37 の節は変わらない', () => {
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

  it('★★ `[未リリース]` の節が 0.6.40・0.6.39・0.6.38・0.6.37・0.6.36 の節の下にあると見つける', () => {
    const below = insertAbove(BEFORE_WRITING, '0.6.36', UNRELEASED_SECTION)
    expect(changelogProblems(below)).toEqual(['[未リリース] の節が、いちばん上にない'])
    const betweenNewest = insertAbove(BEFORE_WRITING, '0.6.37', UNRELEASED_SECTION)
    expect(changelogProblems(betweenNewest)).toEqual(['[未リリース] の節が、いちばん上にない', '0.6.37 の節が、0.6.38 の節の次にない'])
  })

  it('★★ 0.6.38 と 0.6.37 の節の間に別の版の節が挟まると見つける', () => {
    const sandwiched = insertAbove(BEFORE_WRITING, '0.6.37', '## 0.6.41 - 2026-11-21\n\n- **試験の項目**: 試験です。\n\n---\n\n')
    expect(changelogProblems(sandwiched)).toEqual(['0.6.37 の節が、0.6.38 の節の次にない'])
  })

  it('★★ 末尾のリンクの定義: [0.6.38] が決めた形で、[0.6.37] の直前にある（公開の木では定義が無いので検査しない）', () => {
    expect(linkProblems(CHANGELOG)).toEqual([])
    const withDefs = CHANGELOG.includes('\n[0.6.38]: ') ? CHANGELOG : `${CHANGELOG}\n[0.6.38]: https://github.com/ry-yamaguchi/koto/compare/v0.6.37...v0.6.38\n[0.6.37]: https://github.com/ry-yamaguchi/koto/compare/v0.6.36...v0.6.37\n`
    const line = '[0.6.38]: https://github.com/ry-yamaguchi/koto/compare/v0.6.37...v0.6.38\n'
    expect(withDefs).toContain(line)
    expect(linkProblems(withDefs)).toEqual([])
    expect(linkProblems(withDefs.replace(line, ''))).not.toEqual([])
    expect(linkProblems(withDefs.replace('v0.6.37...v0.6.38', 'v0.6.37...v0.6.41'))).not.toEqual([])
    expect(linkProblems(withDefs.replace(line, `${line}${line}`))).not.toEqual([])
    expect(linkProblems(toPublicForm(withDefs))).toEqual([])
  })

  it('★★ 公開済みの 0.6.37 の節を書き換えると見つける（1文字でも・見出しでも）', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.37')) ?? ''
    expect(published.length).toBeGreaterThan(200)
    const edited = [
      published.replace('- **', '- **（書き換え）'),
      published.replace('2026-11-20', '2026-11-14'),
      published.replace('まだ確かめていません。', 'もう確かめました。'),
      `${published.trimEnd()}。\n\n---\n`,
    ]
    for (const e of edited) {
      expect(e, '書き換えが当たっていない').not.toBe(published)
      expect(changelogProblems(CHANGELOG.replace(published, e))).toEqual(['0.6.37 の節の中身が変わっている'])
    }
  })

  it('★★ 0.6.38 の節が消えた・2つになった・0.6.37 の下に入れ替わった・見出しの日付が違うときも見つける', () => {
    const released = sectionsOf(CHANGELOG).find(isVersion('0.6.38')) ?? ''
    expect(released.length).toBeGreaterThan(200)
    expect(changelogProblems(CHANGELOG.replace(released, ''))).toEqual(['0.6.38 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, `${released}\n${released}`))).toEqual(['0.6.38 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, released.replace(RELEASE_DATE, '2026-11-14')))).toEqual(['0.6.38 の節の見出し（版と日付）が公開の日でない'])
    // 0.6.38 の節を 0.6.37 の節の下へ動かした形
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.37')) ?? ''
    const swapped = CHANGELOG.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released)
    expect(changelogProblems(swapped)).not.toEqual([])
  })

  it('★★ 0.6.37 の節が消えた・2つになったときも見つける', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.37')) ?? ''
    expect(changelogProblems(CHANGELOG.replace(published, ''))).toEqual(['0.6.37 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(published, `${published}\n${published}`))).toEqual(['0.6.37 の節が 2 個ある（1つのはず）'])
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
    const released = sectionsOf(publicForm).find(isVersion('0.6.38')) ?? ''
    const published = sectionsOf(publicForm).find(isVersion('0.6.37')) ?? ''
    expect(released.length).toBeGreaterThan(200)
    expect(changelogProblems(publicForm.replace(released, `${released}\n${released}`))).toEqual(['0.6.38 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(publicForm.replace(released, released.replace(RELEASE_DATE, '2026-11-14')))).toEqual(['0.6.38 の節の見出し（版と日付）が公開の日でない'])
    expect(changelogProblems(publicForm.replace(published, published.replace('- **', '- **（書き換え）')))).toEqual(['0.6.37 の節の中身が変わっている'])
    expect(changelogProblems(publicForm.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released))).not.toEqual([])
    for (const c of swapCases(publicForm)) expect(c.problems, `公開の木の形: ${c.name}`).not.toEqual([])
  })
})

describe('0.6.38 の節の上: 0.6.40・0.6.39 の節（1つずつ・この順）は通り、2つ・別の版・0.6.38 の下に動いた形は見つける', () => {
  const released = sectionsOf(CHANGELOG).find(isVersion('0.6.38')) ?? ''
  const newer = sectionsOf(CHANGELOG).find(isVersion('0.6.39')) ?? ''
  const newest = sectionsOf(CHANGELOG).find(isVersion('0.6.40')) ?? ''
  // 見出しの文字列を `## [` と数字の並びで書かない（syncPublic の「角括弧つきの版の見出しで探さない」検査に当たるため。角括弧つきの形を作る試験用）
  const OTHER = `${'## '}${'[0.6.41]'} - 2026-11-21\n\n- **試験の項目**: 試験です。\n\n---\n\n`
  it('★★ 実物は通り、0.6.40・0.6.39 の節が2つ・別の版の節が上にある（0.6.40 の上・0.6.39 と 0.6.38 の間）・0.6.40 と 0.6.39 を入れ替えた形・0.6.38 の下へ動いた形は見つける', () => {
    expect(newer.length).toBeGreaterThan(100)
    expect(newest.length).toBeGreaterThan(100)
    expect(changelogProblems(CHANGELOG)).toEqual([])
    expect(changelogProblems(CHANGELOG.replace(newest, `${newest}\n${newest}`))).toEqual(['0.6.40 の節が 2 個ある'])
    const order = CHANGELOG.replace(newest, '@@A').replace(newer, '@@B').replace('@@A', newer).replace('@@B', newest)
    expect(changelogProblems(order)).toEqual(['0.6.40・0.6.39 の節の並びが、上から 0.6.40・0.6.39 でない', '0.6.39 の節が、0.6.38 の節の直前にない'])
    expect(changelogProblems(CHANGELOG.replace(newer, `${newer}\n${newer}`))).toEqual(['0.6.39 の節が 2 個ある'])
    const swapped = CHANGELOG.replace(newer, '@@N').replace(released, '@@R').replace('@@N', released).replace('@@R', newer)
    expect(changelogProblems(swapped)).not.toEqual([])
    const at = CHANGELOG.search(/^## \[?0\.6\.40\]?(?![\w.-])/m)
    const beyond = `${CHANGELOG.slice(0, at)}${OTHER}${CHANGELOG.slice(at)}`
    expect(changelogProblems(beyond)).toEqual(['0.6.38 の節の上に、`[未リリース]` の節と 0.6.40・0.6.39 の節以外がある'])
    const betweenAt = CHANGELOG.search(/^## \[?0\.6\.38\]?(?![\w.-])/m)
    const between = `${CHANGELOG.slice(0, betweenAt)}${OTHER}${CHANGELOG.slice(betweenAt)}`
    expect(changelogProblems(between)).toEqual(['0.6.38 の節の上に、`[未リリース]` の節と 0.6.40・0.6.39 の節以外がある', '0.6.39 の節が、0.6.38 の節の直前にない'])
  })
})
