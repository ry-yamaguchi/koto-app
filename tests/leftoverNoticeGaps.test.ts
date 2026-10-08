import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { leftoverScanLine, askAiMoveDataText, askAiMoveDataPlan } from '../src/shared/leftoverData'
import { dataLayerUpdateLine } from '../src/shared/storageNoticeText'

// ── ここで固定するもの（2026-09-24 検分・2026-09-25 の指摘V8 で 1 を戻した）─────
// 1. 取りこぼした件数（`referenced`）を捨てない。とくに
//    **見つけた一覧が空のときこそ黙らない**（そこがいちばん知らせるべき場面）
// 2. 「一緒に移してもらう」の依頼文が、**二度取り込んでも増えない形**を頼む
// 3. 画面に出る1行に Markdown 記法（`**`）を混ぜない
//
// 1 の背景（2026-09-24）: 探す側（src/main/ipc/unused.ts）は「取りこぼしうる件数を
// 返り値に載せて隠さない。0件を『見つかりませんでした』と断定しないのは呼ぶ側
// （leftoverScanLine）の責務」と書いて渡している。ところが呼ぶ側は `truncated` しか
// 読まず、`referenced` が 1 でも 5 でも空文字を返していた。
//
// 1 の背景（2026-09-25・指摘38 → 指摘V8）: 「毎回出る注意書きになる」という心配から
// 一度**見つけた一覧があるときだけ出す**（`found > 0`）に変えたが、これは**門の向きが逆**
// だった。探しに行くのは「✅ 書き直せている」ときだけなので、一覧が空でなければ
// 「💾 いま入っているデータをどうしますか」が同じ枠に必ず出ている。つまりその形は
// **問いが出ている場面でだけ喋り、問いが出ない場面では黙る**ことになる。
// 取りこぼし（移行メモ1行で古い保存が隠れる形）は**一覧が空のまま**起きるので、
// そこで黙れば利用者に確かめる手立てが残らない。
//
// 心配のほうは**数え方**で解いた: 探す側が `referenced` を「覚え書きや説明にだけ名前が
// 残っていたせいで隠れたもの」に絞った（tests/leftoverScanMain.test.ts で固定）。
// だからここでは**一覧の有無で門を開け閉めしない**。

describe('leftoverScanLine: 取りこぼした件数（referenced）の扱い', () => {
  /** 「中身のある古いデータ」が1件見つかった状態（＝💾 の問いが出ている状態）。 */
  const FOUND = [{ file: 'data/old.json', detail: 'joinCode あり' }]

  // ★★★ 指摘V8 の本命。**問いが出ない場面（一覧が空）でこそ知らせる。**
  // ここを `found > 0 && …` に戻すと落ちる。
  it('★★★ 見つけた一覧が空でも、取りこぼしがあるときは黙らない（💾 の問いが出ない場面）', () => {
    for (const referenced of [1, 2, 7]) {
      expect(leftoverScanLine({ ok: true, truncated: false, referenced, files: [] })).not.toBe('')
      // files を渡していない形（呼ぶ側が渡し忘れても黙らない）でも同じ
      expect(leftoverScanLine({ ok: true, truncated: false, referenced })).not.toBe('')
    }
  })

  // ★★ 一覧の有無で言うことを変えない（門も文面も一覧に寄りかからない）
  it('★★ 一覧があってもなくても同じ1行（一覧の有無で開け閉めしない）', () => {
    const empty = leftoverScanLine({ ok: true, truncated: false, referenced: 1, files: [] })
    const withList = leftoverScanLine({ ok: true, truncated: false, referenced: 1, files: FOUND })
    expect(empty).not.toBe('')
    expect(withList).toBe(empty)
    // 一覧が空のときに座りの悪くなる言い方をしない
    expect(empty).not.toContain('この一覧')
  })

  it('★ 取りこぼしが無ければ黙る（余計な行を増やさない）', () => {
    expect(leftoverScanLine({ ok: true, truncated: false, referenced: 0, files: FOUND })).toBe('')
    expect(leftoverScanLine({ ok: true, truncated: false, referenced: 0, files: [] })).toBe('')
  })

  it('★ 件数が増えても同じ1行（多い少ないで言うことを変えない）', () => {
    const one = leftoverScanLine({ ok: true, referenced: 1, files: FOUND })
    const many = leftoverScanLine({ ok: true, referenced: 7, files: FOUND })
    expect(one).toBe(many)
  })

  it('★ 断定しない（「ありません」「見つかりませんでした」と言い切らない）', () => {
    const line = leftoverScanLine({ ok: true, referenced: 2, files: FOUND })
    expect(line).toContain('はっきり分かりませんでした')
    expect(line).not.toContain('ありません')
    expect(line).not.toContain('見つかりませんでした')
    // 次にどうすればよいかまで書く
    expect(line).toContain('チャットから')
  })

  it('★ 打ち切りと重なったら、広いほう（全部は調べられませんでした）を出す', () => {
    // 一覧が空でも、打ち切りは別の話として必ず出す（調べていない範囲があるのは事実）
    const both = leftoverScanLine({ ok: true, truncated: true, referenced: 3, files: [] })
    expect(both).toContain('全部は調べられませんでした')
    expect(leftoverScanLine({ ok: true, truncated: true, referenced: 3, files: FOUND }))
      .toContain('全部は調べられませんでした')
  })

  it('★ 壊れた値でも落ちない・余計なことを言わない', () => {
    expect(leftoverScanLine({ ok: true })).toBe('')
    expect(leftoverScanLine({ ok: true, referenced: undefined, files: FOUND })).toBe('')
    expect(leftoverScanLine({ ok: true, referenced: Number.NaN as any, files: FOUND })).toBe('')
    expect(leftoverScanLine({ ok: true, referenced: -1, files: FOUND })).toBe('')
    expect(leftoverScanLine({ ok: true, referenced: 'いくつか' as any, files: FOUND })).toBe('')
    // 一覧が壊れていても、取りこぼしの知らせは止めない（門は一覧を見ない）
    expect(leftoverScanLine({ ok: true, referenced: 1, files: null })).not.toBe('')
    expect(leftoverScanLine({ ok: true, referenced: 1, files: 'こわれた' as any })).not.toBe('')
  })

  it('★ ファイル名を出さない・Markdown 記法を混ぜない（素のテキストで出る）', () => {
    const line = leftoverScanLine({ ok: true, referenced: 1, files: [{ file: 'data/schedule.json', detail: 'joinCode あり' }] as any })
    expect(line).not.toBe('')
    expect(line).not.toContain('schedule.json')
    expect(line).not.toContain('.json')
    expect(line).not.toMatch(/\*\*|`/)
  })
})

// ── 依頼文: 二度取り込んでも増えない形にする ────────────────────────────────
// 依頼文は「アプリ自身が起動したときに一度だけ取り込む」形を頼んでいるが、
// `save()` は **id の無いレコードに毎回新しい id を振る**（templates/koto-data.js の
// `if (isNew) record.id = newId()`）。AppRun はアプリの入れ物が増えることがあり、
// 2つが同時に立ち上がると**両方が**「まだ1件も入っていない」を見て**両方が取り込む**。
// そのとき id が毎回変われば、**同じデータが2組**できる。
// **歯止めは確率ではなく形で持つ**（掟10）——同じ id になる形を依頼文で指定する。
describe('askAiMoveDataText: Koto 自身の規則と食い違う頼み方をしない', () => {
  const files = [{ file: 'data/schedule.json', detail: 'joinCode あり、dates 0件' }]
  const text = askAiMoveDataText(files, 'esm')

  it('★ 元のデータが持っている id は、捨てずに渡すよう頼む', () => {
    expect(text).toContain('元のデータが id を持っているときは')
    expect(text).toContain('その id を捨てずにそのまま渡してください')
  })

  // ★★ これが本命。2026-09-25、親が二重取り込みを防ぐつもりで
  // 「元の並び順から決まる名前を毎回付けてください」と書き足し、検分で取り消した。
  // aiContext.ts が AI へ送っている規則は「**id は自分で決めないこと（Koto が付けます）**」で、
  // 正面から食い違う。食い違う指示を同時に渡すと AI は辻褄を合わせて嘘をつく
  // （この機能そのものが、それを防ぐために作られた）。**同じ間違いを二度させない。**
  it('★★ id を自分で決めろとは頼まない（aiContext の規則と食い違わせない）', () => {
    for (const kind of ['esm', 'cjs'] as const) {
      const t = askAiMoveDataText(files, kind)
      expect(t, 'id を付けろと頼んでいる').not.toContain('id を付けて')
      expect(t, 'id を付けろと頼んでいる').not.toContain('名前（1件目')
      expect(t, 'id を決めろと頼んでいる').not.toContain('id を決め')
      expect(t, '並び順から id を作れと頼んでいる').not.toContain('元の並び順から決まる')
    }
  })

  // 規則の側が変わったら、こちらの但し書きも見直す必要がある（食い違いは両側から生まれる）
  it('★★ 規則の側に「読んだ id をそのまま使うのは構わない」の但し書きが残っている', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/aiContext.ts'), 'utf-8')
    expect(src).toContain('id は自分で決めないこと（Koto が付けます）')
    expect(src, 'この但し書きが消えると、id を引き継ぐ頼み方も規則違反になる')
      .toContain('読んだレコードの id をそのまま使って更新するのは構いません')
  })

  it('★ もとからの頼みごとを落としていない（空のときだけ・確かめてから完了）', () => {
    expect(text).toContain('アプリ自身が起動したときに一度だけ取り込む形にしてください')
    expect(text).toContain('まだ1件も入っていないときだけ')
    expect(text).toContain('同じ名前と同じ値のまま koto-data へ入れてください')
    expect(text).toContain('1件でも入っていれば、何もしないでください')
    expect(text).toContain('古いファイルは消さないでください')
    expect(text).toContain('読み直して、同じ内容が入っていることを確かめてから、完了と答えてください')
    expect(text).toContain('package.json の "type" は変更しないでください')
  })

  it('★ 送ってよいと判断されたときも、同じ文が届く（手前で落ちていない）', () => {
    const plan = askAiMoveDataPlan(files, { ok: true, ready: true, moduleKind: 'esm' })
    expect(plan.send).toBe(true)
    expect(plan.send === true && plan.text).toBe(text)
  })

  it('★ cjs でも同じ頼み方になる（読み込み方だけが違う）', () => {
    expect(askAiMoveDataText(files, 'cjs')).toContain('その id を捨てずにそのまま渡してください')
  })
})

// ── 画面に出る1行に Markdown を混ぜない（v0.2.98 の教訓・掟5）────────────────
// `dataLayerUpdateLine` の「そのままにしました」だけが `**` で囲まれており、
// StorageNotice.tsx は素のテキストとして描く（<p>{checkLine}</p>）ので、
// 非エンジニア向けの画面に**アスタリスクがそのまま出ていた**。
describe('dataLayerUpdateLine: 素のテキストで出す', () => {
  const lines = [
    dataLayerUpdateLine({ ok: true, file: 'koto-data.js', replaced: true }),
    dataLayerUpdateLine({ ok: true, file: 'koto-data.js', needsUpdate: true }),
    dataLayerUpdateLine({ ok: true, file: null, needsUpdate: true }),
  ]

  it('★ どの分かれ道でも Markdown 記法を混ぜない', () => {
    for (const line of lines) {
      expect(line).not.toContain('**')
      expect(line).not.toContain('`')
      expect(line).not.toMatch(/^#|\[.*\]\(.*\)/)
    }
  })

  it('★ 言うことは変えない（触れなかったことと、次にどうすればよいか）', () => {
    const untouched = dataLayerUpdateLine({ ok: true, file: 'koto-data.js', needsUpdate: true })
    expect(untouched).toContain('そのままにしました')
    expect(untouched).toContain('Koto に相談してください')
    expect(dataLayerUpdateLine({ ok: true, file: 'koto-data.js', replaced: true })).toContain('新しい版に差し替えました')
  })

  it('★ ソースの決まり（Markdown を使わない）と実物が一致している', () => {
    // 画面に出る文字列リテラルの中に `**` が無いこと。コメント（`**…**` で強調している）は外す。
    const src = readFileSync(join(__dirname, '..', 'src/shared/storageNoticeText.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    const shown = src.match(/'[^'\n]*'|`[^`]*`/g) ?? []
    expect(shown.filter(s => s.includes('**'))).toEqual([])
  })
})
