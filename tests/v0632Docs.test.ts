import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'

// 0.6.32 の分（Claude の失敗の区分・失敗した回の利用額・内部のアドレスの見分け・囲いの題の無害化・プレビューは HTML だけ・Claude のモードの Koto のツール・ページ読みの確認・確認の札の見え方・読み取りの閉じ込め・同意の確認し直し）の CHANGELOG が、実機で確かめた範囲を正しく言う（掟9）。
// 0.6.32 は 2026-11-18 に公開した（書きためていた `## [未リリース]` の節名が `## [0.6.32]` に変わった）。節は版の数で探す。
// 0.6.33 は 2026-11-18 に公開済み・0.6.34 は 2026-11-19 に公開の予定で、0.6.32 の節の上に（あれば1つずつ・上から 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の順で）載る。最上部の並び（`[未リリース]`・0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32）はここと v0633Docs・v0634Docs が見る。
// ここで見る並びは、0.6.32 の節がちょうど1つで、その上が `[未リリース]` の節（あれば1つ・いちばん上）と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の節（あれば1つずつ・上から 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の順・0.6.33 が直前）だけで、その次が公開済みの 0.6.31 の節で、0.6.31 の節が変わっていないこと。
// 0.6.30 以前の並びは v0625Docs〜v0630Docs が、0.6.31 の節の上の並び（`[未リリース]` と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33・0.6.32 の節だけが載ること）は v0631Docs が見る。
// 公開の木では CHANGELOG の版つきの見出しの角括弧が外れる（`## [0.6.31]` → `## 0.6.31`）ので、版の見出しは角括弧の有無によらず取る。
const CHANGELOG = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')

// ---- 項目の、最後の太字の文（実機で確かめた範囲）。CHANGELOG の文を直したら、ここを直す（言い回しだけならここの1か所。確かめた範囲の「向き」を変えるなら、下の MARKS も直す） ----
const NOT_YET_PLAIN = '**実際の画面では、まだ確かめていません。**'
const LAST_1 = '**実際の画面では、まだ確かめていません（失敗を起こすには保存済みのキーを入れ替える必要があるため、起こしていません）。認証の失敗・モデルが見つからない失敗・残高不足の3つで「詳細:」に区分と原文が残ることは、偽の API と同梱の Claude の実行体を使った、隔離した環境での実測で確かめました。**'
const LAST_2 = '**実際の画面では、まだ確かめていません（失敗を起こしていないため）。失敗の知らせが1つにまとまることは、偽の API と同梱の Claude の実行体を使った、隔離した環境での実測で確かめました。**'
const LAST_3 = NOT_YET_PLAIN
const LAST_4 = NOT_YET_PLAIN
const LAST_5 = '**Claude のモードで、HTML のファイルが既定のブラウザで開くこと、txt のファイルと無いファイルは開かずに理由が Claude に返ることは、0.6.32-rc.1 の実際の画面で確かめました。さくらのAI Engine のモードで HTML のファイルが開くことも、同じ画面で確かめました。さくらのAI Engine のモードで HTML 以外を断るところ（AI がツールを呼ばずに断ったため）と、送信のあとで別のプロジェクトへ切り替えたときの開く先は、まだ確かめていません。**'
const LAST_6 = '**Claude がページを読むこと、資料を探すこと（見つからない回と、見つかって出典を挙げて答える回）、プレビューを開くことは、0.6.32-rc.1 の実際の画面で確かめました。「📚 資料を使わない」のプロジェクトでは、資料を探すツールも実装を任せるツールも、Claude が挙げた使えるツールの中に無いことも、同じ画面で確かめました。資料を探したときに、さくらのAI Engine の費用が出ることは、まだ確かめていません。**'
const LAST_7 = '**確認で断るとページを読まないこと、許可すると読むこと、「🪄 おまかせ」では確認なしで読むことは、0.6.32-rc.1 の実際の画面で確かめました。**'
const LAST_8 = '**切れ目の無い 332 字の URL と、300 字を超えるコマンドが、札の中で折り返して末尾まで見えること、札が出たときに「許可する」「拒否」が見える位置まで会話が送られることは、0.6.32-rc.2 の実際の画面で確かめました。さくらのAI Engine のときの札で、長い文が折り返すところは、まだ確かめていません。**'
const LAST_9 = '**「🪄 おまかせ」でも「✋ 毎回確認」でも、プロジェクトの外のファイルの読み取りは確認を出さずに断ること、中のファイルは読めること、「✋ 毎回確認」ではコマンドで外のファイルを読もうとすると確認が出ることは、0.6.32-rc.1 の実際の画面で確かめました。ファイルを名前や中身で探すツールで外を指したときに断るところは、実際の画面ではまだ確かめていません（隔離した環境での実測では断りました）。**'
const LAST_10 = '**同意済みの状態で確認が出ること、確認が出ている間は依頼の吹き出しが増えず返事も始まらないこと、同意のあとは Koto を起動し直しても確認が出ないことは、0.6.32-rc.1 の実際の画面で確かめました。保存領域が読めないときに確認を出すところは、まだ確かめていません。**'
/** 項目の順に、題（太字の見出し）の頭・最後の太字の文。 */
const ITEM_SPECS = [
  { head: '- **Claude の失敗の画面に、原因の区分を残すようにしました**:', last: LAST_1 },
  { head: '- **Claude で失敗した回の利用料も、今月の利用額に入るようにしました**:', last: LAST_2 },
  { head: '- **AI がページを読むときの、内部のアドレスの見分けを固くしました**:', last: LAST_3 },
  { head: '- **外から読んだ文の囲いで、題の部分も無害化するようにしました**:', last: LAST_4 },
  { head: '- **AI がプレビューで開けるのは、HTML のファイルだけにしました**:', last: LAST_5 },
  { head: '- **Claude のモードで、Koto のツールが使えるようになりました**:', last: LAST_6 },
  { head: '- **「✋ 毎回確認」のとき、Claude がページを読む前に URL を見せて確認します**:', last: LAST_7 },
  { head: '- **「✋ 毎回確認」の確認の札が、見えにくいことがあったのを直しました**:', last: LAST_8 },
  { head: '- **Claude のファイルの読み取りを、プロジェクトの中に限りました**:', last: LAST_9 },
  { head: '- **Claude の同意の確認を、送られるものが増えたので、同意済みの人にも1回だけ出し直します**:', last: LAST_10 },
] as const
/**
 * 掟（確かめていないものを確かめたと書かない）の向き。向きを変える直し（rc.1・rc.2 の有無・まだ の有無）をしたら、上の最後の文とここを合わせる。
 * rc1: 0.6.32-rc.1 の実際の画面で確かめたと言う文を含む／rc2: 0.6.32-rc.2 の実際の画面で確かめたと言う文を含む／
 * notYet: 確かめていない範囲を言う文を含む／isolated: 隔離した環境での実測で確かめたと言う文を含む（実際の画面ではない）。
 * 項目の順は ITEM_SPECS と同じ（1 失敗の区分・2 失敗した回の利用額・3 内部のアドレス・4 囲いの題・5 プレビュー・6 Koto のツール・7 ページ読みの確認・8 確認の札・9 読み取りの閉じ込め・10 同意の確認）。
 */
const MARKS: ReadonlyArray<{ rc1: boolean; rc2: boolean; notYet: boolean; isolated: boolean }> = [
  { rc1: false, rc2: false, notYet: true, isolated: true }, // 1
  { rc1: false, rc2: false, notYet: true, isolated: true }, // 2
  { rc1: false, rc2: false, notYet: true, isolated: false }, // 3
  { rc1: false, rc2: false, notYet: true, isolated: false }, // 4
  { rc1: true, rc2: false, notYet: true, isolated: false }, // 5
  { rc1: true, rc2: false, notYet: true, isolated: false }, // 6
  { rc1: true, rc2: false, notYet: false, isolated: false }, // 7
  { rc1: false, rc2: true, notYet: true, isolated: false }, // 8
  { rc1: true, rc2: false, notYet: true, isolated: false }, // 9
  { rc1: true, rc2: false, notYet: true, isolated: false }, // 10
]
const RC1 = '0.6.32-rc.1 の実際の画面で確かめました'
const RC2 = '0.6.32-rc.2 の実際の画面で確かめました'
const ISOLATED = '隔離した環境での実測で確かめました'
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
/** 公開済みの 0.6.31 の節の指紋（`frozenForm` の形で）。 */
const FROZEN_0631 = '87fc47414cde890352e729f5e0d8a211668e83a28f63924d7371f5a3767bb1a9'

/** CHANGELOG の節の並びの問題（空なら問題なし）。実物と、書き換えた本文（下の試験）の両方に同じ検査をかける。 */
const changelogProblems = (changelog: string): string[] => {
  const sections = sectionsOf(changelog)
  const problems: string[] = []
  const unreleased = sections.filter(isUnreleased)
  if (unreleased.length > 1) problems.push(`[未リリース] の節が ${unreleased.length} 個ある`)
  if (unreleased.length >= 1 && !isUnreleased(sections[0])) problems.push('[未リリース] の節が、いちばん上にない')
  const released = sections.filter(isVersion('0.6.32'))
  if (released.length !== 1) problems.push(`0.6.32 の節が ${released.length} 個ある（1つのはず）`)
  else {
    const above = sections.slice(0, sections.indexOf(released[0]))
    const newer = above.filter(isVersion('0.6.33'))
    const top = above.filter(isVersion('0.6.35'))
    const apex = above.filter(isVersion('0.6.36'))
    const peak = above.filter(isVersion('0.6.38'))
    const n39 = above.filter(isVersion('0.6.39'))
    const crest = above.filter(isVersion('0.6.37'))
    const newest = above.filter(isVersion('0.6.34'))
    if (above.some(s => !isUnreleased(s) && !isVersion('0.6.33')(s) && !isVersion('0.6.34')(s) && !isVersion('0.6.35')(s) && !isVersion('0.6.36')(s) && !isVersion('0.6.37')(s) && !isVersion('0.6.38')(s) && !isVersion('0.6.39')(s))) problems.push('0.6.32 の節の上に、`[未リリース]` の節と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の節以外がある')
    if (peak.length > 1) problems.push(`0.6.38 の節が ${peak.length} 個ある`)
    if (n39.length > 1) problems.push(`0.6.39 の節が ${n39.length} 個ある`)
    if (crest.length > 1) problems.push(`0.6.37 の節が ${crest.length} 個ある`)
    if (apex.length > 1) problems.push(`0.6.36 の節が ${apex.length} 個ある`)
    if (top.length > 1) problems.push(`0.6.35 の節が ${top.length} 個ある`)
    if (newest.length > 1) problems.push(`0.6.34 の節が ${newest.length} 個ある`)
    if (newer.length > 1) problems.push(`0.6.33 の節が ${newer.length} 個ある`)
    if (([n39, peak, crest, apex, top, newest, newer] as string[][]).filter(a => a.length === 1).some((a, i, all) => i > 0 && above.indexOf(all[i - 1][0]) > above.indexOf(a[0]))) problems.push('0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の節の並びが、上から 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 でない')
    if (newer.length === 1 && above[above.length - 1] !== newer[0]) problems.push('0.6.33 の節が、0.6.32 の節の直前にない')
    if (newer.length === 0 && newest.length === 1 && above[above.length - 1] !== newest[0]) problems.push('0.6.34 の節が、0.6.32 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && top.length === 1 && above[above.length - 1] !== top[0]) problems.push('0.6.35 の節が、0.6.32 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && top.length === 0 && apex.length === 1 && above[above.length - 1] !== apex[0]) problems.push('0.6.36 の節が、0.6.32 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && top.length === 0 && apex.length === 0 && crest.length === 1 && above[above.length - 1] !== crest[0]) problems.push('0.6.37 の節が、0.6.32 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && top.length === 0 && apex.length === 0 && crest.length === 0 && peak.length === 1 && above[above.length - 1] !== peak[0]) problems.push('0.6.38 の節が、0.6.32 の節の直前にない')
    if (newer.length === 0 && newest.length === 0 && top.length === 0 && apex.length === 0 && crest.length === 0 && peak.length === 0 && n39.length === 1 && above[above.length - 1] !== n39[0]) problems.push('0.6.39 の節が、0.6.32 の節の直前にない')
    if (!/^## \[?0\.6\.32\]? - 2026-11-18\n/.test(released[0])) problems.push('0.6.32 の節の見出し（版と日付）が公開の日でない')
  }
  const published = sections.filter(isVersion('0.6.31'))
  if (released.length === 1 && published.length === 1 && sections[sections.indexOf(released[0]) + 1] !== published[0]) problems.push('0.6.31 の節が、0.6.32 の節の次にない')
  if (published.length !== 1) problems.push(`0.6.31 の節が ${published.length} 個ある（1つのはず）`)
  else if (fingerprint(published[0]) !== FROZEN_0631) problems.push('0.6.31 の節の中身が変わっている')
  return problems
}

const itemsOf = (changelog: string): string[] =>
  (sectionsOf(changelog).find(isVersion('0.6.32')) ?? '').split('\n').filter(l => l.startsWith('- '))
const lastBold = (item: string): string => item.match(/\*\*[^*]+\*\*\s*$/)?.[0].trim() ?? ''

/** 0.6.32 の節の項目（題・最後の太字の文・確かめた範囲の向き）の問題（空なら問題なし）。実物と公開の木の形の両方に同じ検査をかける。 */
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
    if (tail.includes(RC1) !== mark.rc1) problems.push(`項目${n}: 「${RC1}」が${mark.rc1 ? '無い' : 'ある'}`)
    if (tail.includes(RC2) !== mark.rc2) problems.push(`項目${n}: 「${RC2}」が${mark.rc2 ? '無い' : 'ある'}`)
    if (tail.includes(ISOLATED) !== mark.isolated) problems.push(`項目${n}: 「${ISOLATED}」が${mark.isolated ? '無い' : 'ある'}`)
    if (tail.includes(NOT_YET) !== mark.notYet) problems.push(`項目${n}: 「${NOT_YET}」が${mark.notYet ? '無い' : 'ある'}`)
    if (!mark.rc1 && !mark.rc2 && !mark.isolated && /確かめました/.test(tail)) problems.push(`項目${n}: 確かめていない項目に「確かめました」がある`)
  })
  return problems
}

/** 公開の木の CHANGELOG の形（版の見出しの角括弧が外れ、リンク定義の行が消える）。 */
const toPublicForm = (changelog: string): string =>
  changelog.replace(/^## \[(\d+\.\d+\.\d+)\]/gm, '## $1').replace(/^\[\d+\.\d+\.\d+\]: .*\n?/gm, '')
/** 角括弧つきの形（私有の木の形）。もともと角括弧が無い公開の木で走っても、両方の形を試せるよう組み立てる。 */
const toBracketedForm = (changelog: string): string => changelog.replace(/^## (\d+\.\d+\.\d+)(?= - )/gm, '## [$1]')

/** 0.6.32 の節の中の1か所だけを書き換えた CHANGELOG（同じ文が古い節にもあるので、節の中に限る）。 */
const editSection = (changelog: string, from: string, to: string): string => {
  const section = sectionsOf(changelog).find(isVersion('0.6.32')) ?? ''
  expect(section.split(from).length - 1, `書き換え元が0.6.32の節に1か所でない: ${from.slice(0, 20)}`).toBe(1)
  return changelog.replace(section, section.replace(from, to))
}

const LASTS: string[] = ITEM_SPECS.map(spec => spec.last)
/**
 * 確かめた範囲の文を取り違えた形の問題の一覧。書き換えが元と同じなら空振りなので、名指しで落とす。
 * 最後の太字の文は項目をまたいで同じことがある（項目3と4）ので、項目の行ごと書き換える。
 */
const swapCases = (changelog: string): { name: string; problems: string[] }[] => {
  const cases: { name: string; problems: string[] }[] = []
  const tryEdit = (name: string, i: number, to: string) => {
    expect(to, `対照の書き換えが当たっていない: ${name}`).not.toBe(LASTS[i])
    const item = itemsOf(changelog)[i]
    expect(item.endsWith(LASTS[i]), `項目${i + 1}の末尾が最後の文でない: ${name}`).toBe(true)
    cases.push({ name, problems: itemProblems(editSection(changelog, item, item.slice(0, item.length - LASTS[i].length) + to)) })
  }
  const still = '**実際の画面では、まだ確かめていません。**'
  // 実際の画面で確かめたことを、未確認へ戻した（項目5・6・7・8・9・10）
  for (const i of [4, 5, 6, 7, 8, 9]) tryEdit(`項目${i + 1}: 未確認へ戻した`, i, still)
  // 未確認を、確かめたことにした（項目3・4・1・2）
  for (const i of [2, 3]) tryEdit(`項目${i + 1}: rc.1 で確かめたことにした`, i, '**' + RC1 + '。**')
  tryEdit('項目1: 「まだ」を「確かめました」に取り違え', 0, LASTS[0].replace('まだ確かめていません（', '確かめました（'))
  tryEdit('項目2: 「まだ」を「確かめました」に取り違え', 1, LASTS[1].replace('まだ確かめていません（', '確かめました（'))
  // 隔離した環境での実測で確かめた、を落とした（項目1・2）／実際の画面で確かめた、に言い換えた
  tryEdit('項目1: 隔離した環境での実測を落とした', 0, LASTS[0].replace(/[^。*]*隔離した環境での実測で確かめました。/, ''))
  tryEdit('項目2: 実測を実際の画面に言い換えた', 1, LASTS[1].replace(ISOLATED, RC1))
  // rc.1 と rc.2 の取り違え（項目5・6・7・9・10 は rc.1、項目8 は rc.2）
  for (const i of [4, 5, 6, 8, 9]) tryEdit(`項目${i + 1}: rc.1 を rc.2 に取り違え`, i, LASTS[i].replace(RC1, RC2))
  tryEdit('項目8: rc.2 を rc.1 に取り違え', 7, LASTS[7].replace(RC2, RC1))
  // 「まだ確かめていません」の文を落とした・確かめたと言う文を落とした（項目5・9・10）
  tryEdit('項目5: 「まだ」の文を落とした', 4, LASTS[4].replace(/[^。*]*まだ確かめていません。/, ''))
  tryEdit('項目10: 「まだ」の文を落とした', 9, LASTS[9].replace(/[^。*]*まだ確かめていません。/, ''))
  tryEdit('項目9: 「まだ」を「確かめました」に取り違え', 8, LASTS[8].replace('ではまだ確かめていません', 'では確かめました'))
  tryEdit('項目5: 「確かめました」の文を落とした', 4, LASTS[4].replace(/^\*\*[^*]*?確かめました。(?=さくら)/, '**'))
  // 最後の文を書き換えた（1文字）
  tryEdit('項目6: 最後の文の書き換え', 5, LASTS[5].replace('資料を探すこと', '資料を探す事'))
  tryEdit('項目8: 最後の文の書き換え', 7, LASTS[7].replace('332 字', '330 字'))
  // 最後の太字の文の外へ、確かめたという文を出した
  tryEdit('項目7: 太字の外へ出した', 6, `確かめました。${LASTS[6]}`)
  return cases
}

const SECTION = sectionsOf(CHANGELOG).find(isVersion('0.6.32')) ?? ''
const ITEMS = itemsOf(CHANGELOG)

describe('0.6.32 の CHANGELOG の項目', () => {
  it('★★ 0.6.32 の節が読めていて、項目はちょうど10個で、題の頭が決めたとおり', () => {
    expect(SECTION.length).toBeGreaterThan(3000)
    expect(ITEMS).toHaveLength(10)
    expect(ITEM_SPECS).toHaveLength(10)
    expect(MARKS).toHaveLength(10)
    ITEM_SPECS.forEach((spec, i) => expect(ITEMS[i].startsWith(spec.head), `${i + 1} 番目の項目の題`).toBe(true))
  })
  it('★★ 項目の最後の太字の文（実機で確かめた範囲）が、頭の定数と1文字も違わない', () => {
    ITEM_SPECS.forEach((spec, i) => {
      expect(lastBold(ITEMS[i]), `${i + 1} 番目の項目の最後の太字`).toBe(spec.last)
      expect(ITEMS[i].endsWith(spec.last), `${i + 1} 番目の項目の末尾`).toBe(true)
    })
  })
  it('★★ 掟の向き: 実際の画面で確かめた項目は rc.1（8 は rc.2）・実際の画面で確かめていない項目は「まだ確かめていません」・実測だけの項目はそう言う', () => {
    expect(itemProblems(CHANGELOG)).toEqual([])
    // 向きの表が、実物と同じ読み方になっていること（表を直さずに文だけ直すと、ここで気づく）
    expect(ITEMS.map(x => x.includes(RC1))).toEqual(MARKS.map(m => m.rc1))
    expect(ITEMS.map(x => x.includes(RC2))).toEqual(MARKS.map(m => m.rc2))
    expect(ITEMS.map(x => x.includes(NOT_YET))).toEqual(MARKS.map(m => m.notYet))
    expect(ITEMS.map(x => x.includes(ISOLATED))).toEqual(MARKS.map(m => m.isolated))
    // 項目の向き（決めたとおり）: 実際の画面で確かめた 5・6・7・9・10（rc.1）と 8（rc.2）／まだ確かめていない 1・2・3・4／まだの文が残る 1・2・3・4・5・6・8・9・10
    expect(MARKS.map((m, i) => (m.rc1 ? i + 1 : 0)).filter(Boolean)).toEqual([5, 6, 7, 9, 10])
    expect(MARKS.map((m, i) => (m.rc2 ? i + 1 : 0)).filter(Boolean)).toEqual([8])
    expect(MARKS.map((m, i) => (m.notYet ? i + 1 : 0)).filter(Boolean)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10])
    expect(MARKS.map((m, i) => (m.isolated ? i + 1 : 0)).filter(Boolean)).toEqual([1, 2])
    // 項目3・4は、実機でも実測でも見ていない（テストだけ）ので、何も確かめたと言わない
    expect(ITEMS[2].endsWith(NOT_YET_PLAIN)).toBe(true)
    expect(ITEMS[3].endsWith(NOT_YET_PLAIN)).toBe(true)
    // 項目1・2は、実際の画面ではまだ確かめていないと先に言い、実測は別の文で言う
    expect(ITEMS[0]).toContain('**実際の画面では、まだ確かめていません（')
    expect(ITEMS[1]).toContain('**実際の画面では、まだ確かめていません（')
  })
  it('★★ 対照: 確かめた範囲の文を取り違えた形（確かめたと「まだ」の取り違え・rc.1 と rc.2 の取り違え・文を落とした・最後の文の書き換え・項目の増減）は見つける', () => {
    const cases = swapCases(CHANGELOG)
    expect(cases.length, '対照の形が足りない').toBeGreaterThanOrEqual(20)
    for (const c of cases) expect(c.problems, c.name).not.toEqual([])
    // 項目が9個になった・11個になった
    expect(itemProblems(CHANGELOG.replace(/^- \*\*Claude の失敗の画面に.*\n/m, ''))).toEqual(['項目が 9 個ある（10個のはず）'])
    expect(itemProblems(CHANGELOG.replace(/^(- \*\*Claude の失敗の画面に.*\n)/m, '$1- **足した項目**: 試験です。\n'))).toEqual(['項目が 11 個ある（10個のはず）'])
  })
  it('★★ 0.6.32 の節・`[未リリース]` の節（あれば）に、禁止語と丸数字が無い（0.6.32 の節が対象に入っていることも見る）', () => {
    const FORBIDDEN = /Claude Code|無償|無料|道具|[①-⑳㉑-㊿]/
    for (const bad of ['Claude Code で作りました', '無償で使えます', '無料です', '道具を使います', '手順①', '⑳']) expect(FORBIDDEN.test(bad), bad).toBe(true)
    for (const ok of ['手順1', 'Claude に頼みます', '料金は月額です', '1. 選ぶ 2. 押す', 'Claude の実行体', 'ツール']) expect(FORBIDDEN.test(ok), ok).toBe(false)
    const targets = sectionsOf(CHANGELOG).filter(x => isUnreleased(x) || isVersion('0.6.32')(x))
    expect(targets.some(isVersion('0.6.32')), '0.6.32 の節が対象に入っていない').toBe(true)
    for (const section of targets) expect(section, 'CHANGELOG の 0.6.32 の節・[未リリース] の節').not.toMatch(FORBIDDEN)
  })
})

describe('CHANGELOG の節の並び: 0.6.32 の節は1つだけ・その上は `[未リリース]` と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の節だけ・次は公開済みの 0.6.31 の節で変わらない', () => {
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
    const twice = insertAbove(insertAbove(BEFORE_WRITING, TOP_VERSION, UNRELEASED_SECTION), '0.6.33', UNRELEASED_SECTION)
    expect(changelogProblems(twice)).toEqual(['[未リリース] の節が 2 個ある'])
  })

  it('★★ `[未リリース]` の節が 0.6.33・0.6.32・0.6.31・0.6.30 の節の下にあると見つける', () => {
    const below = insertAbove(BEFORE_WRITING, '0.6.30', UNRELEASED_SECTION)
    expect(changelogProblems(below)).toEqual(['[未リリース] の節が、いちばん上にない'])
  })

  it('★★ 公開済みの 0.6.31 の節を書き換えると見つける（1文字でも・見出しでも）', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.31')) ?? ''
    expect(published.length).toBeGreaterThan(300)
    const edited = [
      published.replace('- **', '- **（書き換え）'),
      published.replace('2026-11-13', '2026-11-14'),
      published.replace('まだ確かめていません。', 'もう確かめました。'),
      `${published.trimEnd()}。\n\n---\n`,
    ]
    for (const e of edited) {
      expect(e, '書き換えが当たっていない').not.toBe(published)
      expect(changelogProblems(CHANGELOG.replace(published, e))).toEqual(['0.6.31 の節の中身が変わっている'])
    }
  })

  it('★★ 0.6.32 の節が消えた・2つになった・0.6.31 の下に入れ替わった・見出しの日付が違うときも見つける', () => {
    const released = sectionsOf(CHANGELOG).find(isVersion('0.6.32')) ?? ''
    expect(released.length).toBeGreaterThan(300)
    expect(changelogProblems(CHANGELOG.replace(released, ''))).toEqual(['0.6.32 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, `${released}\n${released}`))).toEqual(['0.6.32 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, released.replace('2026-11-18', '2026-11-14')))).toEqual(['0.6.32 の節の見出し（版と日付）が公開の日でない'])
    // 0.6.32 の節を 0.6.31 の節の下へ動かした形
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.31')) ?? ''
    const swapped = CHANGELOG.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released)
    expect(changelogProblems(swapped)).not.toEqual([])
  })

  it('★★ 0.6.31 の節が消えた・2つになったときも見つける', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.31')) ?? ''
    expect(changelogProblems(CHANGELOG.replace(published, ''))).toEqual(['0.6.31 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(published, `${published}\n${published}`))).toEqual(['0.6.31 の節が 2 個ある（1つのはず）'])
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
    const released = sectionsOf(publicForm).find(isVersion('0.6.32')) ?? ''
    const published = sectionsOf(publicForm).find(isVersion('0.6.31')) ?? ''
    expect(released.length).toBeGreaterThan(300)
    expect(changelogProblems(publicForm.replace(released, `${released}\n${released}`))).toEqual(['0.6.32 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(publicForm.replace(released, released.replace('2026-11-18', '2026-11-14')))).toEqual(['0.6.32 の節の見出し（版と日付）が公開の日でない'])
    expect(changelogProblems(publicForm.replace(published, published.replace('- **', '- **（書き換え）')))).toEqual(['0.6.31 の節の中身が変わっている'])
    expect(changelogProblems(publicForm.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released))).not.toEqual([])
    for (const c of swapCases(publicForm)) expect(c.problems, `公開の木の形: ${c.name}`).not.toEqual([])
  })
})

describe('0.6.32 の節の上: 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の節（1つずつ・この順）は通り、2つ・別の版・0.6.32 の下に動いた形は見つける', () => {
  const released = sectionsOf(CHANGELOG).find(isVersion('0.6.32')) ?? ''
  const newer = sectionsOf(CHANGELOG).find(isVersion('0.6.33')) ?? ''
  const crest = sectionsOf(CHANGELOG).find(isVersion('0.6.34')) ?? ''
  const summit = sectionsOf(CHANGELOG).find(isVersion('0.6.35')) ?? ''
  const pinnacle = sectionsOf(CHANGELOG).find(isVersion('0.6.36')) ?? ''
  const zenith = sectionsOf(CHANGELOG).find(isVersion('0.6.37')) ?? ''
  const meridian = sectionsOf(CHANGELOG).find(isVersion('0.6.38')) ?? ''
  const apex = sectionsOf(CHANGELOG).find(isVersion('0.6.39')) ?? ''
  // 見出しの文字列を `## [` と数字の並びで書かない（syncPublic の「角括弧つきの版の見出しで探さない」検査に当たるため。角括弧つきの形を作る試験用）
  const OTHER = `${'## '}${'[0.6.40]'} - 2026-11-20\n\n- **試験の項目**: 試験です。\n\n---\n\n`
  it('★★ 実物は通り、0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の節が2つ・別の版の節が上にある（0.6.33 の上・0.6.33 と 0.6.32 の間）・0.6.34 と 0.6.33 を入れ替えた形・0.6.32 の下へ動いた形は見つける', () => {
    expect(newer.length).toBeGreaterThan(100)
    expect(crest.length).toBeGreaterThan(100)
    expect(summit.length).toBeGreaterThan(100)
    expect(pinnacle.length).toBeGreaterThan(100)
    expect(zenith.length).toBeGreaterThan(100)
    expect(meridian.length).toBeGreaterThan(100)
    expect(apex.length).toBeGreaterThan(100)
    expect(changelogProblems(CHANGELOG)).toEqual([])
    expect(changelogProblems(CHANGELOG.replace(newer, `${newer}\n${newer}`))).toEqual(['0.6.33 の節が 2 個ある'])
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
    // 0.6.34 と 0.6.33 を入れ替えた形
    const order = CHANGELOG.replace(crest, '@@A').replace(newer, '@@B').replace('@@A', newer).replace('@@B', crest)
    expect(changelogProblems(order)).toEqual(['0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の節の並びが、上から 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 でない', '0.6.33 の節が、0.6.32 の節の直前にない'])
    const swapped = CHANGELOG.replace(newer, '@@N').replace(released, '@@R').replace('@@N', released).replace('@@R', newer)
    expect(changelogProblems(swapped)).not.toEqual([])
    const at = CHANGELOG.search(/^## \[?0\.6\.33\]?(?![\w.-])/m)
    const beyond = `${CHANGELOG.slice(0, at)}${OTHER}${CHANGELOG.slice(at)}`
    expect(changelogProblems(beyond)).toEqual(['0.6.32 の節の上に、`[未リリース]` の節と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の節以外がある'])
    const betweenAt = CHANGELOG.search(/^## \[?0\.6\.32\]?(?![\w.-])/m)
    const between = `${CHANGELOG.slice(0, betweenAt)}${OTHER}${CHANGELOG.slice(betweenAt)}`
    expect(changelogProblems(between)).toEqual(['0.6.32 の節の上に、`[未リリース]` の節と 0.6.39・0.6.38・0.6.37・0.6.36・0.6.35・0.6.34・0.6.33 の節以外がある', '0.6.33 の節が、0.6.32 の節の直前にない'])
  })
})
