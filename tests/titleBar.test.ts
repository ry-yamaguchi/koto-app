import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 2026-08-14 Ryosuke 指摘:「画面上部の公開・保存ボタンがめり込んでいる」
//
// 真ん中の「IDE / チャット」を `absolute left-1/2 -translate-x-1/2` で浮かせていた。
// **浮いているものはレイアウトの流れに入らない**ので、右のボタン群はその存在を知らず、
// ウィンドウを狭めると重なって「公開」が「開」になった。
//
// ── それでも残っていた（2026-08-14 夜・Ryosuke 再指摘）─────────────────────
// 「試してみましたが、結構重なりますね」。3区画にしても直っていなかった。
// 目で判断するのをやめ、**CDP で幅を変えながら位置を実測**した:
//
//   幅720 → 152px 重なる ／ 幅880 → 72px ／ 幅960 → 32px
//   「ターミナル」は縦書き（高さ90px）
//
// 原因は右の区画に付けていた `min-w-0`。flex の既定 `min-width:auto` は
// **「箱は中身より小さくならない」という守り**で、それを自分で外していた。
// 外れていると箱だけ縮み、はみ出した中身が真ん中の切替に重なる。
// 守りを戻すと、狭いときに**先に譲るのは左（アプリ名）**になる。
// 修正後は幅720〜1440で重なり0・折れ返しなし（実測）。ウィンドウ最小幅は900。

const SRC = readFileSync(join(__dirname, '..', 'src', 'renderer', 'components', 'TitleBar.tsx'), 'utf-8')

/** 右の区画（操作ボタンが並ぶほう）の className を取り出す。 */
function rightControlsClass(): string {
  const i = SRC.indexOf('justify-end')
  expect(i).toBeGreaterThan(-1)
  const start = SRC.lastIndexOf('className="', i)
  return SRC.slice(start + 'className="'.length, SRC.indexOf('"', start + 'className="'.length))
}

describe('上部バーが重ならない', () => {
  // ※ 説明のコメントに語が出てくるので、**実際の className だけ**を見る
  it('★ 真ん中の切替を浮かせない（重なりの原因）', () => {
    expect(SRC).not.toMatch(/className="[^"]*absolute left-1\/2/)
    expect(SRC).not.toMatch(/className="[^"]*-translate-x-1\/2/)
  })

  it('左右で真ん中を挟む', () => {
    // 左（ブランド）と右（操作）が両方 flex-1。
    // **`min-w-0` は左だけ**（v0.3.19 では両方に付けていて、それが重なりの正体だった）
    expect((SRC.match(/flex-1/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('★ 右の区画から「中身より小さくならない」守りを外さない', () => {
    const cls = rightControlsClass()
    expect(cls).toContain('flex-1')
    expect(cls).toContain('justify-end')
    // 付け直すと、実測で 152px（幅720）重なる
    expect(cls).not.toContain('min-w-0')
  })

  it('左（アプリ名）は縮んでよい — 隠れても操作は失われない', () => {
    expect(SRC).toMatch(/Brand[\s\S]{0,400}min-w-0/)
  })

  it('ボタンの文字を縮めない・折り返さない（「公開」が「開」にならないように）', () => {
    expect(SRC).toContain('flex-none whitespace-nowrap')
    const buttons = SRC.match(/className="flex-none whitespace-nowrap[^"]*"/g) ?? []
    expect(buttons.length).toBeGreaterThanOrEqual(3)
  })

  it('★ 切替チップも縮まない・折れない（「ターミナル」が縦書きになっていた）', () => {
    expect(SRC).toMatch(/ToggleChip[\s\S]*?className=\{`flex-none whitespace-nowrap/)
  })

  it('狭いときは、まずブランド側から削る（操作は削らない）', () => {
    // 版番号 → 名前 の順に隠れる
    expect(SRC).toMatch(/Koto<\/span>/)
    expect(SRC).toContain('hidden sm:inline')
    expect(SRC).toContain('hidden md:inline')
  })
})
