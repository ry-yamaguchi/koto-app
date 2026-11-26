import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'

// 0.6.39 の分（作業フォルダからの場所で AI に伝える・書き込めないフォルダの案内・エディタの帯の確認のフォーカス・📡 の「一覧から削除」の確認・提供終了の案内・
// 使っていない画像をゴミ箱へ・ゴミ箱へ移せないときの案内・あいさつと切り替え・低い窓のチャット欄・札の理由・Claude の断った書き込みと 🕘 履歴・利用額の断り・資料の料金・0.6.26 の訂正）の
// CHANGELOG が、実機で確かめた範囲を正しく言う（掟9。確かめていないことの断りは削らない＝掟5）。
// 0.6.39 は 2026-11-24 に公開した（書きためていた `## [未リリース]` の節名が `## [0.6.39]` に変わった）。節は版の数で探す。
// 0.6.40 は 2026-11-26 に公開の予定で、0.6.39 の節の上に（あれば1つ・直前に）載る。最上部の並び（`[未リリース]`・0.6.40・0.6.39）はここと v0640Docs が見る。
// ここで見る並びは、0.6.39 の節がちょうど1つで、その上が `[未リリース]` の節（あれば1つ・いちばん上）と 0.6.40 の節（あれば1つ・直前）だけで、その次が公開済みの 0.6.38 の節で、0.6.38 の節が変わっていないこと。
// 0.6.37 以前の並びは v0625Docs〜v0637Docs が、0.6.38 の節の上の並び（`[未リリース]` と 0.6.40・0.6.39 の節だけが載ること）は v0638Docs が見る。
// 公開の木では CHANGELOG の版つきの見出しの角括弧が外れる（`## [0.6.39]` → `## 0.6.39`）ので、版の見出しは角括弧の有無によらず取る（CLAUDE.md 掟2 の注記）。
const CHANGELOG = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf-8')

/** 0.6.39 の公開日（変わったら、ここの1か所だけを直す）。 */
const RELEASE_DATE = '2026-11-24'

// ---- 項目の、最後の太字の文（実機で確かめた範囲）。CHANGELOG の文を直したら、ここを直す（言い回しだけならここの1か所。確かめた範囲の「向き」を変えるなら、下の MARKS も直す） ----
const LAST_1 = '**0.6.39-rc.1 の実際の画面で、GLM-5.3 Flash で確かめました: 「a.js を読んで」と頼んだ3回とも、頭に public/ を付けずに最初から a.js を読んだこと（3回で付けなかったことは、いつも付けないという保証ではありません）。public/a.js を渡させた回は、画面に「実行できなかった操作があります（1件）」と出て読み替えて読まず、AI に一字一句写させた失敗の文に「public/ を外して a.js を指定してください」とあったこと。一覧の「作業フォルダの外」の出方と、ツールの説明と、Claude の側の文は、まだ確かめていません。**'
const LAST_2 = "**0.6.39-rc.1 の実際の画面で確かめました（署名する前のものを、設定やキーの無い別の保存場所で起動）: 名前に「' -> '」を含む書き込めないフォルダの中に新規ファイルを作ろうとすると、案内がフォルダの名前の途中で切れず、作ろうとしたファイルまでの場所を言うこと。同じフォルダの中で名前を変えようとしたときは、案内が場所を言わないこと。ほかの操作の案内は、まだ確かめていません。**"
const LAST_3 = '**0.6.39-rc.1 の実際の画面で確かめました（署名する前のものを、設定やキーの無い別の保存場所で起動）: 「外の内容を読み込む」と、ファイルが消えたときの「閉じる」から開いた確認を、Esc でも Return でも閉じると、カーソルが押したボタンへ戻ること。確認が出ている間も、帯のボタンが押せない状態にならないこと。「外の内容を読み込む」を続けて2回押しても確認は1つしか出ず、2回目は確認の外側に当たって確認が閉じたこと。「閉じる」を続けて2回押したときは、まだ確かめていません。2回目が帯のボタンに届いたときに1回しか動かないところは、実際の画面では起こせず、まだ確かめていません。**'
const LAST_4 = '**0.6.39-rc.1 の実際の画面で、見本の公開の記録で確かめました（署名する前のものを、設定やキーの無い別の保存場所で起動）: 「一覧から削除」を押すと確認の窓が出て、行の中にボタンが足されず、プロジェクトの名前が見えたままで、行の外へはみ出さないこと。Return を押すと「キャンセル」が選ばれ、何も消えないこと。確認の【一覧から削除】を押すと行が消え、開き直しても戻らないこと。**'
const LAST_5 = '**0.6.39-rc.1 の実際の画面で確かめました（署名する前のものを、設定やキーの無い別の保存場所で起動）: 提供が終わったモデルの会話で、案内が会話の記録に1回だけ書かれ、チャットモードを開き、IDE へ戻ってもう一度開いても増えないこと。キーが無かったため、チャットモードの画面に案内が出るところは見ておらず、まだ確かめていません。**'
const LAST_6 = '**0.6.39-rc.1 の実際の画面で確かめました: public/ フォルダのあるプロジェクトで、使っていない画像が public の中からゴミ箱へ移り、プロジェクトの直下にある同じ名前の別のファイルは移らないこと。ロックした画像は、移せなかったものとして名前が出て、指摘に残ること。見た目のチェックのあとで公開されるフォルダが変わったときと、その外を指す名前の扱いは、まだ確かめていません。**'
const LAST_7 = '**0.6.39-rc.1 の実際の画面で、ロックしたフォルダとファイルで確かめました（署名する前のものを、設定やキーの無い別の保存場所で起動）: プロジェクトの削除と、ファイル一覧の「ゴミ箱へ移す」の両方で、「ゴミ箱へ移せませんでした。Finder で、ロックされていないか・権限を確かめてください。」と、そのすぐ下に macOS の元の文の「詳細:」が出て、ゴミ箱へは移らないこと。ロックのほかの理由で移せないときは、まだ確かめていません。**'
const LAST_8 = '**0.6.39-rc.1 の実際の画面で確かめました: あいさつの「考えています…」が出てすぐ別のプロジェクトへ移ると、移った先には「考えています…」も【⏹ 停止】も出ず、移った先の会話は変わらないこと。戻ると、移っている間に終わったあいさつが、記録にも画面にも全文で残っていること。終わる前に戻ると、そのプロジェクトで「考えています…」と【⏹ 停止】が出て、全文になること。0.6.39-rc.2 の実際の画面で確かめました: あいさつの途中でチャット欄を閉じて開き直すと、会話の欄が真っ白にならず、空の会話の案内のあとにあいさつがやり直されて全文が出て、記録のあいさつは1組だけになること。閉じたあと、別のプロジェクトを開いてから戻ったときのやり直しは、まだ確かめていません。**'
const LAST_9 = '**0.6.39-rc.2 の実際の画面で、幅 972・高さ 625 の窓で確かめました: 案内が出ているプロジェクトを開くと、チャット欄がはみ出さず、入力欄と【送信】が下まで欄の中に見えること。案内は縮んで中で送れ、送ると【🧹 フォルダを整理する】が見えること。「✋ 毎回確認」の札が出ると、【許可する】【拒否】が最初から押せる位置にあり、【拒否】で閉じられたこと。ほかの大きさの窓は、まだ確かめていません。**'
const LAST_10 = '**0.6.39-rc.1 の実際の画面で確かめました: require を含む `node -e` のコマンドを頼むと、札の理由が「コードを直接実行します。」と出て、札はこれまでどおり出ること。ほかのコマンドの札の理由は、まだ確かめていません。**'
const LAST_11 = '**0.6.39-rc.1 の実際の画面で確かめました: Claude に、守る場所（.git の中・🕘 履歴の置き場・Koto の記録のファイル）とプロジェクトの外へ書き込ませると、4つとも書き込まれず、🕘 履歴は「まだ履歴がありません。」のままだったこと。ふつうのファイルを書かせると、書く前の時点が1つ履歴に残ること。すでにあるファイルを書き換えようとして断られた回は、まだ確かめていません。**'
const LAST_12 = '**0.6.39-rc.1 の実際の画面で、額のすぐ下に断りの文が1回だけ出ることを確かめました（キーのある設定と、署名する前のものをキーの無い別の保存場所で起動した設定の両方）。README と使い方ガイドの断りの文が、この説明と合うことを確かめました。**'
const LAST_13 = '**README と使い方ガイドの資料の料金の文が、この説明と合うことを確かめました。**'
const LAST_14 = '**README の文が、Koto が「↻ 設定し直す」の下に出す文と合うことを確かめました。この版の実際の画面では、まだ確かめていません。**'

/** 項目の順に、題（太字の見出し）の頭・本文の要の文（本文にちょうど1回）・最後の太字の文。 */
const ITEM_SPECS = [
  { head: '- **さくらのAI Engine に、ファイルの場所を「作業フォルダ（public/ があればその中）からの場所」でそろえて伝えるようにしました**:', key: '一覧は、作業フォルダの中（そのまま渡せる場所）と、作業フォルダの外（読み書きできない場所）に分け', last: LAST_1 },
  { head: "- **名前に「' -> '」を含むフォルダに書き込めなかったとき、案内が実在しない場所を言う不具合を直しました**:", key: '場所を2つ持つ操作（名前の変更など）のときだけ区切って読み', last: LAST_2 },
  { head: '- **エディタの帯から開いた確認を閉じたとき、カーソル（フォーカス）が押したボタンへ戻るようにしました**:', key: '二重に押しても1回しか動きません。', last: LAST_3 },
  { head: '- **📡 公開したもの一覧の「一覧から削除」は、確認の窓で聞くようにしました**:', key: 'Return で選ばれるのは「キャンセル」です。', last: LAST_4 },
  { head: '- **チャットモードで、提供が終わったモデルの案内が同じ会話に2回出る不具合を直しました**:', key: '同じ会話・同じモデルについては1回だけ出します。', last: LAST_5 },
  { head: '- **【公開】の「🗑 使っていない画像をゴミ箱へ」が、public/ フォルダのあるプロジェクトで1つも移せなかった不具合を直しました**:', key: '移すのは、見た目のチェックをした時点の公開されるフォルダの中のものだけにし、その外を指す名前は移しません。', last: LAST_6 },
  { head: '- **プロジェクトの削除で、フォルダをゴミ箱へ移せなかったとき（ロックされているときなど）に、Finder で確かめる案内と、元の文（詳細）を出すようにしました**:', key: 'ファイル一覧の「ゴミ箱へ移す」で移せなかったときも同じです。', last: LAST_7 },
  { head: '- **最初のあいさつの返事を待つ間に別のプロジェクトへ移っても、返事がそのプロジェクトの会話に残るようにしました**:', key: 'チャット欄を閉じたときは、走っているあいさつを止め、次にチャット欄にそのプロジェクトの会話が出たときにあいさつをやり直します（止めた会話は空の会話と同じ案内を出します）。', last: LAST_8 },
  { head: '- **「🧹 フォルダを整理する」の案内が出ているときも、会話の欄が細くなりすぎないようにしました**:', key: '会話の欄に最小の高さを付け、案内は窓が低いときは縮んで中で送れるようにしました', last: LAST_9 },
  { head: '- **「✋ 毎回確認」の札の理由を直しました**:', key: '札が出るかどうかは変えていません。', last: LAST_10 },
  { head: '- **Claude が書き込もうとして Koto が断った書き込みは、🕘 履歴に残さないようにしました**:', key: 'ほかの書き込みは、これまでどおり書く前に控えます。', last: LAST_11 },
  { head: '- **設定の「今月のさくらのAI Engine 利用額（推定）」に、見立ての断りを足しました**:', key: '実際の請求より大きく出ることがあるので、請求はさくらのコントロールパネルで確かめてください（計算のしかたは変えていません）。', last: LAST_12 },
  { head: '- **資料（📚）の料金の説明を直しました**:', key: '（100チャンクごと。月ごとの利用枠はありません）', last: LAST_13 },
  { head: '- **0.6.26 の「↻ 設定し直す」の説明を訂正します**:', key: 'そこに出るのは月額220円（税込）の一文だけです', last: LAST_14 },
] as const
/** 最後の太字の文を持つ項目の数（項目の先頭から）。0.6.39 は全部の項目が持つ。 */
const WITH_LAST = 14

const RC1 = '0.6.39-rc.1 の実際の画面'
const RC2 = '0.6.39-rc.2 の実際の画面'
/** 署名する前のものを、設定やキーの無い別の保存場所で起動して確かめたことを言う印。 */
const UNSIGNED = '署名する前のもの'
/** 画面ではなく、文書（README・使い方ガイド）を突き合わせて確かめたことを言う印。 */
const DOCS = '合うことを確かめました'
const NOT_YET = 'まだ確かめていません'
const CHECKED = '確かめました'

/**
 * 掟（確かめていないものを確かめたと書かない・確かめていないことの断りは削らない）の向き。向きを変える直しをしたら、上の最後の文とここを合わせる。
 * rc1／rc2: その rc の実際の画面で確かめたと言う文を含む／unsigned: 署名する前のもので確かめたと言う文を含む／docs: 文書を突き合わせて確かめたと言う文を含む／notYet: 確かめていない範囲を言う文を含む。
 * 自動更新（0.6.38 → 0.6.39）は確かめていないので、どの項目にも書かない。
 */
const MARKS: ReadonlyArray<{ rc1: boolean; rc2: boolean; unsigned: boolean; docs: boolean; notYet: boolean }> = [
  { rc1: true, rc2: false, unsigned: false, docs: false, notYet: true }, // 1 署名した rc.1
  { rc1: true, rc2: false, unsigned: true, docs: false, notYet: true }, // 2 署名する前のもの
  { rc1: true, rc2: false, unsigned: true, docs: false, notYet: true }, // 3 署名する前のもの
  { rc1: true, rc2: false, unsigned: true, docs: false, notYet: false }, // 4 署名する前のもの
  { rc1: true, rc2: false, unsigned: true, docs: false, notYet: true }, // 5 署名する前のもの
  { rc1: true, rc2: false, unsigned: false, docs: false, notYet: true }, // 6 署名した rc.1
  { rc1: true, rc2: false, unsigned: true, docs: false, notYet: true }, // 7 署名する前のもの
  { rc1: true, rc2: true, unsigned: false, docs: false, notYet: true }, // 8 署名した rc.1 と rc.2
  { rc1: false, rc2: true, unsigned: false, docs: false, notYet: true }, // 9 rc.1 で欠陥が見つかり、署名した rc.2 で通った
  { rc1: true, rc2: false, unsigned: false, docs: false, notYet: true }, // 10 署名した rc.1
  { rc1: true, rc2: false, unsigned: false, docs: false, notYet: true }, // 11 署名した rc.1
  { rc1: true, rc2: false, unsigned: true, docs: true, notYet: false }, // 12 署名した rc.1 と、署名する前のもの・文書の突き合わせ
  { rc1: false, rc2: false, unsigned: false, docs: true, notYet: false }, // 13 文書の突き合わせ
  { rc1: false, rc2: false, unsigned: false, docs: true, notYet: true }, // 14 文書の突き合わせ
]

/** CHANGELOG の `## ` で始まる節（先頭の説明は除く）。上から新しい順。 */
const sectionsOf = (changelog: string): string[] => changelog.split(/\n(?=## )/).filter(s => s.startsWith('## '))
const isUnreleased = (section: string): boolean => /^## \[?未リリース\]?(?![\w.-])/.test(section)
const isVersion = (version: string) => (section: string): boolean =>
  new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(?![\\w.-])`).test(section)
/** 公開済みの節を「変わっていない」と比べるための形（見出しの角括弧・節の間の区切り線・末尾の空白は無いものとする。本文は1文字も変えない）。 */
const frozenForm = (section: string): string =>
  section.replace(/^## \[(\d+\.\d+\.\d+)\]/, '## $1').replace(/(?:\s*\n---)?\s*$/, '')
const fingerprint = (section: string): string => createHash('sha256').update(frozenForm(section)).digest('hex')
/** 公開済みの 0.6.38 の節の指紋（`frozenForm` の形で）。 */
const FROZEN_0638 = '3d17c088a73a923c0e9e2bdea26f2514163eeb2aeec9db0f148deb54079e81f4'

/** CHANGELOG の節の並びの問題（空なら問題なし）。実物と、書き換えた本文（下の試験）の両方に同じ検査をかける。 */
const changelogProblems = (changelog: string): string[] => {
  const sections = sectionsOf(changelog)
  const problems: string[] = []
  const unreleased = sections.filter(isUnreleased)
  if (unreleased.length > 1) problems.push(`[未リリース] の節が ${unreleased.length} 個ある`)
  if (unreleased.length >= 1 && !isUnreleased(sections[0])) problems.push('[未リリース] の節が、いちばん上にない')
  const released = sections.filter(isVersion('0.6.39'))
  if (released.length !== 1) problems.push(`0.6.39 の節が ${released.length} 個ある（1つのはず）`)
  else {
    const above = sections.slice(0, sections.indexOf(released[0]))
    const newer = above.filter(isVersion('0.6.40'))
    if (above.some(s => !isUnreleased(s) && !isVersion('0.6.40')(s))) problems.push('0.6.39 の節の上に、`[未リリース]` の節と 0.6.40 の節以外がある')
    if (newer.length > 1) problems.push(`0.6.40 の節が ${newer.length} 個ある`)
    if (newer.length === 1 && above[above.length - 1] !== newer[0]) problems.push('0.6.40 の節が、0.6.39 の節の直前にない')
    if (!new RegExp(`^## \\[?0\\.6\\.39\\]? - ${RELEASE_DATE}\\n`).test(released[0])) problems.push('0.6.39 の節の見出し（版と日付）が公開の日でない')
  }
  const published = sections.filter(isVersion('0.6.38'))
  if (released.length === 1 && published.length === 1 && sections[sections.indexOf(released[0]) + 1] !== published[0]) problems.push('0.6.38 の節が、0.6.39 の節の次にない')
  if (published.length !== 1) problems.push(`0.6.38 の節が ${published.length} 個ある（1つのはず）`)
  else if (fingerprint(published[0]) !== FROZEN_0638) problems.push('0.6.38 の節の中身が変わっている')
  return problems
}

/** 末尾のリンクの定義（私有の木だけにある。公開の木では消えるので、1つも無ければ検査しない）の問題。 */
const LINK_0639 = '[0.6.39]: https://github.com/ry-yamaguchi/koto/compare/v0.6.38...v0.6.39'
const linkProblems = (changelog: string): string[] => {
  const defs = changelog.split('\n').filter(l => /^\[\d+\.\d+\.\d+\]: /.test(l))
  if (defs.length === 0) return []
  const at = defs.indexOf(LINK_0639)
  if (defs.filter(l => l.startsWith('[0.6.39]:')).length !== 1 || at < 0) return ['[0.6.39] のリンクの定義が、決めた形で1つだけ無い']
  if (!defs[at + 1]?.startsWith('[0.6.38]:')) return ['[0.6.39] のリンクの定義が、[0.6.38] の定義の直前にない']
  return []
}

const itemsOf = (changelog: string): string[] =>
  (sectionsOf(changelog).find(isVersion('0.6.39')) ?? '').split('\n').filter(l => l.startsWith('- '))
/** 項目の最後の太字（行末の太字だけ。本文の途中の太字は取らない）。 */
const lastBold = (item: string): string => {
  const t = item.trimEnd()
  if (!t.endsWith('**')) return ''
  const open = t.lastIndexOf('**', t.length - 3)
  return open < 0 ? '' : t.slice(open)
}
const countOf = (text: string, part: string): number => text.split(part).length - 1
/** 0.6.39 の節の、見出しと空行と項目（`- ` で始まる行）のほかの行。項目の間や後ろに段落を足して「確かめた」と言わせない。 */
const strayLinesOf = (changelog: string): string[] =>
  (sectionsOf(changelog).find(isVersion('0.6.39')) ?? '').split('\n').slice(1).filter(l => l.trim() !== '' && l.trim() !== '---' && !l.startsWith('- '))

/**
 * 本文（最後の太字の外）で、確かめた範囲を言う言葉。言い換え（確認し・実測・実機・実際の画面で・見ました・通りました）も見る。
 * 「確かめてください」（利用者への頼み）・「確かめる案内」（題）・「開く確認です」（確認の窓の話）・「実際の画面に合わせました」（直した中身）は当たらない。
 */
const VERIFY_WORDS = /確かめ(?:まし|た|て(?:い|あ|お))|確認(?:し|でき|済|で(?!す))|実測|実機|実際の画面で|見ました|通りました/
/** 本文で許す言い方（項目の番号ごと）。何が起きたかを言う括弧の中で、確かめた範囲を言う文ではない。1回だけ外して見る（2回目は当たる）。 */
const BODY_ALLOWED: Readonly<Record<number, readonly string[]>> = {
  1: ['0.6.38 の確認で'],
  9: ['0.6.39-rc.1 の実機で'],
}

/** 0.6.39 の節の項目（題・本文の要の文・最後の太字の文・確かめた範囲の向き）の問題（空なら問題なし）。実物と公開の木の形の両方に同じ検査をかける。 */
const itemProblems = (changelog: string): string[] => {
  const items = itemsOf(changelog)
  const stray = strayLinesOf(changelog)
  const problems: string[] = stray.length ? [`0.6.39 の節に、項目でない行が ${stray.length} 行ある`] : []
  if (items.length !== ITEM_SPECS.length) return [...problems, `項目が ${items.length} 個ある（${ITEM_SPECS.length}個のはず）`]
  items.forEach((item, i) => {
    const n = i + 1
    const spec = ITEM_SPECS[i]
    if (!item.startsWith(spec.head)) problems.push(`項目${n}の題が違う`)
    const tail = lastBold(item)
    if (tail !== spec.last) problems.push(`項目${n}の最後の太字の文が違う`)
    // 確かめた範囲を言う文は、最後の太字の中にだけある（本文の途中に、確かめたと書かない。言い換えも見る）
    const body = item.slice(0, item.length - tail.length)
    const rest = (BODY_ALLOWED[n] ?? []).reduce((text, ok) => text.replace(ok, ''), body)
    if (VERIFY_WORDS.test(rest)) problems.push(`項目${n}の最後の太字の外に、確かめた範囲の文がある`)
    // 最後の太字の前は「。」と半角の空白1つ（公開の木とリリースの説明文で、太字が本文に続いて崩れない形）
    if (tail !== '' && !/[^ ]。 $/.test(body)) problems.push(`項目${n}の最後の太字の前が「。」と半角の空白1つでない`)
    if (countOf(body, spec.key) !== 1) problems.push(`項目${n}の本文に、要の文がちょうど1回ない`)
    const mark = MARKS[i]
    if (tail.includes(RC1) !== mark.rc1) problems.push(`項目${n}: 「${RC1}」が${mark.rc1 ? '無い' : 'ある'}`)
    if (tail.includes(RC2) !== mark.rc2) problems.push(`項目${n}: 「${RC2}」が${mark.rc2 ? '無い' : 'ある'}`)
    if (tail.includes(UNSIGNED) !== mark.unsigned) problems.push(`項目${n}: 「${UNSIGNED}」が${mark.unsigned ? '無い' : 'ある'}`)
    if (tail.includes(DOCS) !== mark.docs) problems.push(`項目${n}: 「${DOCS}」が${mark.docs ? '無い' : 'ある'}`)
    if (tail.includes(NOT_YET) !== mark.notYet) problems.push(`項目${n}: 「${NOT_YET}」が${mark.notYet ? '無い' : 'ある'}`)
    if (!mark.rc1 && !mark.rc2 && !mark.docs && tail.includes(CHECKED)) problems.push(`項目${n}: 確かめていない項目に「${CHECKED}」がある`)
  })
  return problems
}

/** 公開の木の CHANGELOG の形（版の見出しの角括弧が外れ、リンク定義の行が消える）。 */
const toPublicForm = (changelog: string): string =>
  changelog.replace(/^## \[(\d+\.\d+\.\d+)\]/gm, '## $1').replace(/^\[\d+\.\d+\.\d+\]: .*\n?/gm, '')
/** 角括弧つきの形（私有の木の形）。もともと角括弧が無い公開の木で走っても、両方の形を試せるよう組み立てる。 */
const toBracketedForm = (changelog: string): string => changelog.replace(/^## (\d+\.\d+\.\d+)(?= - )/gm, '## [$1]')

/** 0.6.39 の節の中の1か所だけを書き換えた CHANGELOG（同じ文が古い節にもありうるので、節の中に限る）。 */
const editSection = (changelog: string, from: string, to: string): string => {
  const section = sectionsOf(changelog).find(isVersion('0.6.39')) ?? ''
  expect(countOf(section, from), `書き換え元が0.6.39の節に1か所でない: ${from.slice(0, 20)}`).toBe(1)
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
    // 確かめていない部分まで、実際の画面で確かめたと取り違え（確かめた範囲の文だけを入れ替える）
    tryLast(`項目${n}: 実際の画面で確かめたとだけ書いた`, i, `**${MARKS[i].rc2 && !MARKS[i].rc1 ? RC2 : RC1}で確かめました。**`)
    // 取り違えた形は、元の文に頼らず固定の文で作る（元の文が変わっても、書き換えが空振りしない）
    tryLast(`項目${n}: 「まだ」を「確かめました」に取り違え`, i, `**取り違えの試験: ${CHECKED}。**`)
    tryLast(`項目${n}: 「まだ」の文を落とした`, i, '**実際の画面では、確かめていません。**')
    // 断りだけを「確かめました」に言い換えた（確かめていない部分を、確かめたことにする）
    if (MARKS[i].notYet) tryLast(`項目${n}: 断りを「確かめました」に言い換えた`, i, LASTS[i].replace(`、${NOT_YET}`, `、${CHECKED}`).replace(`は${NOT_YET}`, `は${CHECKED}`).replace(NOT_YET, CHECKED))
    // どの rc で確かめたかを取り違えた
    if (MARKS[i].rc1) tryLast(`項目${n}: rc.1 を rc.2 に取り違え`, i, LASTS[i].split(RC1).join(RC2))
    if (MARKS[i].rc2) tryLast(`項目${n}: rc.2 を rc.1 に取り違え`, i, LASTS[i].split(RC2).join(RC1))
    // 署名する前のもので確かめたことの断りを落とした
    if (MARKS[i].unsigned) tryLast(`項目${n}: 署名する前のものの断りを落とした`, i, LASTS[i].replace(/（[^）]*署名する前のもの[^）]*）/, ''))
    // 最後の文を書き換えた（1文字）
    tryLast(`項目${n}: 最後の文の書き換え`, i, `**${LASTS[i][2] === 'X' ? 'Y' : 'X'}${LASTS[i].slice(3)}`)
    // 最後の太字の文を落とした
    tryItem(`項目${n}: 最後の太字の文を落とした`, i, item => item.slice(0, item.length - LASTS[i].length).trimEnd())
    // 最後の太字の文の外へ、確かめたという文を出した
    tryLast(`項目${n}: 太字の外へ出した`, i, `確かめました。${LASTS[i]}`)
    // 本文の途中に太字を足し、その中へ確かめたという文を入れた（最後の太字と取り違えない）
    tryItem(`項目${n}: 途中の太字へ入れた`, i, item => item.replace(ITEM_SPECS[i].key, `${ITEM_SPECS[i].key}**途中の太字。確かめました**`))
    // 本文に、検査と違う言葉で確かめたという文を足した（言い換え）
    for (const said of ['実際の画面でも確認しました。', '実測で通りました。', '実機で見ました。', '0.6.39-rc.1 の実機で確かめた。'])
      tryItem(`項目${n}: 本文に言い換えた確かめの文を足した（${said}）`, i, item => item.replace(ITEM_SPECS[i].key, `${ITEM_SPECS[i].key}${said}`))
    // 最後の太字の前の半角の空白を落とした・2つにした
    tryItem(`項目${n}: 最後の太字の前の空白を落とした`, i, item => item.replace(` ${LASTS[i]}`, LASTS[i]))
    tryItem(`項目${n}: 最後の太字の前の空白を2つにした`, i, item => item.replace(` ${LASTS[i]}`, `  ${LASTS[i]}`))
    // 最後の太字を「まだ確かめていません」だけにした
    tryLast(`項目${n}: 最後の太字を「まだ」だけにした`, i, `**${NOT_YET}。**`)
    // 本文の要の文を落とした
    tryItem(`項目${n}: 要の文を落とした`, i, item => item.replace(ITEM_SPECS[i].key, ''))
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

const SECTION = sectionsOf(CHANGELOG).find(isVersion('0.6.39')) ?? ''
const ITEMS = itemsOf(CHANGELOG)

describe('0.6.39 の CHANGELOG の項目', () => {
  it('★★ 0.6.39 の節が読めていて、項目はちょうど14個で、題の頭が決めたとおり（項目の頭に、絵文字の分類の印が無い）', () => {
    expect(SECTION.length).toBeGreaterThan(200)
    expect(ITEMS).toHaveLength(14)
    expect(ITEM_SPECS).toHaveLength(14)
    for (const item of ITEMS) expect(item.startsWith('- **'), '項目の頭が `- **` でない').toBe(true)
    expect(MARKS).toHaveLength(WITH_LAST)
    ITEM_SPECS.forEach((spec, i) => expect(ITEMS[i].startsWith(spec.head), `${i + 1} 番目の項目の題`).toBe(true))
  })
  it('★★ 各項目の本文に、要の文がちょうど1回ある', () => {
    ITEM_SPECS.forEach((spec, i) => expect(countOf(ITEMS[i], spec.key), `${i + 1} 番目の項目の要の文`).toBe(1))
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
    // 項目の行全体で見る（本文の途中に「確かめた」と書き足しても、ここで気づく）
    const all = ITEMS.slice(0, WITH_LAST)
    expect(all.map(x => x.includes(RC1))).toEqual(MARKS.map(m => m.rc1))
    expect(all.map(x => x.includes(RC2))).toEqual(MARKS.map(m => m.rc2))
    expect(all.map(x => x.includes(UNSIGNED))).toEqual(MARKS.map(m => m.unsigned))
    expect(all.map(x => x.includes(DOCS))).toEqual(MARKS.map(m => m.docs))
    expect(all.map(x => x.includes(NOT_YET))).toEqual(MARKS.map(m => m.notYet))
    // 各項目の最後の太字の中に、確かめた範囲の文がある（無くなったら、確かめた範囲を言わない項目になる）
    for (const l of LASTS) expect(l).toMatch(/確かめ/)
    // 確かめていない部分の断りが残っている項目の数（断りを削ったら、ここで気づく）
    expect(MARKS.filter(m => m.notYet)).toHaveLength(11)
  })
  it('★★ 自動更新（0.6.38 → 0.6.39）は確かめていないので、0.6.39 の節は自動更新で確かめたと言わない', () => {
    expect(SECTION).not.toMatch(/自動更新/)
  })
  it('★★ 対照: 確かめた範囲の文を取り違えた形（確かめたとだけ書いた・「まだ」の取り違え・断りの言い換え・rc の取り違え・署名する前の断りを落とした・文を落とした・太字の外へ出した・要の文を落とした・題の書き換え・項目の増減）は見つける', () => {
    const cases = swapCases(CHANGELOG)
    expect(cases.length, '対照の形が足りない').toBeGreaterThanOrEqual(14 * 10)
    for (const c of cases) expect(c.problems, c.name).not.toEqual([])
    // 項目が13個になった・15個になった
    expect(itemProblems(editSection(CHANGELOG, ITEMS[13], ''))).toEqual(['項目が 13 個ある（14個のはず）'])
    expect(itemProblems(editSection(CHANGELOG, ITEMS[0], `${ITEMS[0]}\n- **足した項目**: 試験です。`))).toEqual(['項目が 15 個ある（14個のはず）'])
    // 項目ではない段落を、節の後ろ・項目の間に足した（項目の数も文も変えずに、確かめたと言わせない）
    expect(itemProblems(editSection(CHANGELOG, ITEMS[13], `${ITEMS[13]}\n\n**0.6.39-rc.2 の実際の画面で、すべて確かめました。**`))).toEqual(['0.6.39 の節に、項目でない行が 1 行ある'])
    expect(itemProblems(editSection(CHANGELOG, ITEMS[4], `${ITEMS[4]}\n  まとめて確かめました。`))).toEqual(['0.6.39 の節に、項目でない行が 1 行ある'])
    // 許した言い方を2回にした（2回目は当たる）
    expect(itemProblems(editSection(CHANGELOG, ITEMS[0], ITEMS[0].replace('0.6.38 の確認で', '0.6.38 の確認で、0.6.39-rc.1 の確認で')))).not.toEqual([])
  })
  it('★★ 0.6.39 の節・`[未リリース]` の節（あれば）に、禁止語・丸数字・内部の番号が無い（0.6.39 の節が対象に入っていることも見る）', () => {
    // 内部の名前（確かめの回の名前 rc39・回U・回S、欠陥の番号 D1・rc39-D1）も入れない
    const FORBIDDEN = /Claude Code|無償|無料|道具|[①-⑳㉑-㊿]|P-\d{3}|\brc\d{2,}\b|回[A-Z]|(?<![A-Za-z0-9])D\d+(?![0-9])/
    for (const bad of ['Claude Code で作りました', '無償で使えます', '無料です', '道具を使います', '手順①', '⑳', 'P-131 の直し', 'rc39 の確かめ', '回U で見ました', '回S2 の結果', 'D1 の直し', 'rc39-D1 を直しました']) expect(FORBIDDEN.test(bad), bad).toBe(true)
    for (const ok of ['手順1', 'Claude に頼みます', '料金は月額です', '1. 選ぶ 2. 押す', 'Claude の実行体', 'ツール', 'GLM-5.3 Flash', '0.6.39-rc.1 の実際の画面', '0.6.39-rc.2', 'DeepSeek V4.1 Flash', '2回目は', '3回とも']) expect(FORBIDDEN.test(ok), ok).toBe(false)
    const targets = sectionsOf(CHANGELOG).filter(x => isUnreleased(x) || isVersion('0.6.39')(x))
    expect(targets.some(isVersion('0.6.39')), '0.6.39 の節が対象に入っていない').toBe(true)
    for (const section of targets) expect(section, 'CHANGELOG の 0.6.39 の節・[未リリース] の節').not.toMatch(FORBIDDEN)
  })
})

describe('CHANGELOG の節の並び: `[未リリース]` は（あれば）1つだけでいちばん上・0.6.39 の節の上は 0.6.40 の節だけ・公開済みの 0.6.38 の節は変わらない', () => {
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

  it('★★ `[未リリース]` の節が 0.6.40・0.6.39・0.6.38・0.6.37 の節の下にあると見つける', () => {
    const below = insertAbove(BEFORE_WRITING, '0.6.37', UNRELEASED_SECTION)
    expect(changelogProblems(below)).toEqual(['[未リリース] の節が、いちばん上にない'])
    const betweenNewest = insertAbove(BEFORE_WRITING, '0.6.38', UNRELEASED_SECTION)
    expect(changelogProblems(betweenNewest)).toEqual(['[未リリース] の節が、いちばん上にない', '0.6.38 の節が、0.6.39 の節の次にない'])
  })

  it('★★ 0.6.39 と 0.6.38 の節の間に別の版の節が挟まると見つける', () => {
    const sandwiched = insertAbove(BEFORE_WRITING, '0.6.38', '## 0.6.41 - 2026-11-24\n\n- **試験の項目**: 試験です。\n\n---\n\n')
    expect(changelogProblems(sandwiched)).toEqual(['0.6.38 の節が、0.6.39 の節の次にない'])
  })

  it('★★ 末尾のリンクの定義: [0.6.39] が決めた形で、[0.6.38] の定義の直前にある（公開の木では定義が無いので検査しない）', () => {
    expect(linkProblems(CHANGELOG)).toEqual([])
    const withDefs = CHANGELOG.includes(`\n${LINK_0639}`) ? CHANGELOG : `${CHANGELOG}\n${LINK_0639}\n[0.6.38]: https://github.com/ry-yamaguchi/koto/compare/v0.6.37...v0.6.38\n`
    const line = `${LINK_0639}\n`
    expect(withDefs).toContain(line)
    expect(linkProblems(withDefs)).toEqual([])
    expect(linkProblems(withDefs.replace(line, ''))).not.toEqual([])
    expect(linkProblems(withDefs.replace('v0.6.38...v0.6.39', 'v0.6.38...v0.6.41'))).not.toEqual([])
    expect(linkProblems(withDefs.replace(line, `${line}${line}`))).not.toEqual([])
    // [0.6.38] の下へ動かした形
    const below = withDefs.replace(line, '').replace('[0.6.38]: https://github.com/ry-yamaguchi/koto/compare/v0.6.37...v0.6.38\n', `[0.6.38]: https://github.com/ry-yamaguchi/koto/compare/v0.6.37...v0.6.38\n${line}`)
    expect(below).not.toBe(withDefs)
    expect(linkProblems(below)).not.toEqual([])
    expect(linkProblems(toPublicForm(withDefs))).toEqual([])
  })

  it('★★ 公開済みの 0.6.38 の節を書き換えると見つける（1文字でも・見出しでも）', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.38')) ?? ''
    expect(published.length).toBeGreaterThan(200)
    const edited = [
      published.replace('- **', '- **（書き換え）'),
      published.replace('2026-11-21', '2026-11-14'),
      published.replace('まだ確かめていません。', 'もう確かめました。'),
      `${published.trimEnd()}。\n\n---\n`,
    ]
    for (const e of edited) {
      expect(e, '書き換えが当たっていない').not.toBe(published)
      expect(changelogProblems(CHANGELOG.replace(published, e))).toEqual(['0.6.38 の節の中身が変わっている'])
    }
  })

  it('★★ 0.6.39 の節が消えた・2つになった・0.6.38 の下に入れ替わった・見出しの日付が違うときも見つける', () => {
    const released = sectionsOf(CHANGELOG).find(isVersion('0.6.39')) ?? ''
    expect(released.length).toBeGreaterThan(200)
    expect(changelogProblems(CHANGELOG.replace(released, ''))).toEqual(['0.6.39 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, `${released}\n${released}`))).toEqual(['0.6.39 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(released, released.replace(RELEASE_DATE, '2026-11-14')))).toEqual(['0.6.39 の節の見出し（版と日付）が公開の日でない'])
    // 0.6.39 の節を 0.6.38 の節の下へ動かした形
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.38')) ?? ''
    const swapped = CHANGELOG.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released)
    expect(changelogProblems(swapped)).not.toEqual([])
  })

  it('★★ 0.6.38 の節が消えた・2つになったときも見つける', () => {
    const published = sectionsOf(CHANGELOG).find(isVersion('0.6.38')) ?? ''
    expect(changelogProblems(CHANGELOG.replace(published, ''))).toEqual(['0.6.38 の節が 0 個ある（1つのはず）'])
    expect(changelogProblems(CHANGELOG.replace(published, `${published}\n${published}`))).toEqual(['0.6.38 の節が 2 個ある（1つのはず）'])
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
    const released = sectionsOf(publicForm).find(isVersion('0.6.39')) ?? ''
    const published = sectionsOf(publicForm).find(isVersion('0.6.38')) ?? ''
    expect(released.length).toBeGreaterThan(200)
    expect(changelogProblems(publicForm.replace(released, `${released}\n${released}`))).toEqual(['0.6.39 の節が 2 個ある（1つのはず）'])
    expect(changelogProblems(publicForm.replace(released, released.replace(RELEASE_DATE, '2026-11-14')))).toEqual(['0.6.39 の節の見出し（版と日付）が公開の日でない'])
    expect(changelogProblems(publicForm.replace(published, published.replace('- **', '- **（書き換え）')))).toEqual(['0.6.38 の節の中身が変わっている'])
    expect(changelogProblems(publicForm.replace(released, '@@R').replace(published, '@@P').replace('@@R', published).replace('@@P', released))).not.toEqual([])
    for (const c of swapCases(publicForm)) expect(c.problems, `公開の木の形: ${c.name}`).not.toEqual([])
  })
})

describe('0.6.39 の節の上: 0.6.40 の節（1つ・直前）は通り、2つ・別の版・0.6.39 の下に動いた形は見つける', () => {
  const released = sectionsOf(CHANGELOG).find(isVersion('0.6.39')) ?? ''
  const newer = sectionsOf(CHANGELOG).find(isVersion('0.6.40')) ?? ''
  // 見出しの文字列を `## [` と数字の並びで書かない（syncPublic の「角括弧つきの版の見出しで探さない」検査に当たるため。角括弧つきの形を作る試験用）
  const OTHER = `${'## '}${'[0.6.41]'} - 2026-11-24\n\n- **試験の項目**: 試験です。\n\n---\n\n`
  it('★★ 実物は通り、0.6.40 の節が2つ・別の版の節が上にある（0.6.40 の上・0.6.40 と 0.6.39 の間）・0.6.39 の下へ動いた形は見つける', () => {
    expect(newer.length).toBeGreaterThan(100)
    expect(changelogProblems(CHANGELOG)).toEqual([])
    expect(changelogProblems(CHANGELOG.replace(newer, `${newer}\n${newer}`))).toEqual(['0.6.40 の節が 2 個ある'])
    const swapped = CHANGELOG.replace(newer, '@@N').replace(released, '@@R').replace('@@N', released).replace('@@R', newer)
    expect(changelogProblems(swapped)).not.toEqual([])
    const at = CHANGELOG.search(/^## \[?0\.6\.40\]?(?![\w.-])/m)
    const beyond = `${CHANGELOG.slice(0, at)}${OTHER}${CHANGELOG.slice(at)}`
    expect(changelogProblems(beyond)).toEqual(['0.6.39 の節の上に、`[未リリース]` の節と 0.6.40 の節以外がある'])
    const betweenAt = CHANGELOG.search(/^## \[?0\.6\.39\]?(?![\w.-])/m)
    const between = `${CHANGELOG.slice(0, betweenAt)}${OTHER}${CHANGELOG.slice(betweenAt)}`
    expect(changelogProblems(between)).toEqual(['0.6.39 の節の上に、`[未リリース]` の節と 0.6.40 の節以外がある', '0.6.40 の節が、0.6.39 の節の直前にない'])
  })
})
