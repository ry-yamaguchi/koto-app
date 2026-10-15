import { describe, it, expect } from 'vitest'
import { stripRepeatedGuidance } from '../src/shared/aiToolsCore'

// 「次にやること」案内の定型文が毎ターン繰り返される問題（2026-08-30 実機・Ryosuke 指摘）。
// プロンプトの「連続で繰り返さない」指示をモデル（Kimi K2.7）が無視したため、
// Koto 側で機械的に抑止する（stripToolMarkup と同じ発想）。
// 消してよいのは「①案内の形をした段落で ②直前の返事に同じ段落がそのまま在る」ものだけ。

// 旧い呼び方（丸数字つき・2026-10-07 に廃止）。**会話の履歴に残る古い返事**を想定して、いまも抑止の対象にしている。
// いまの呼び方（【試す】【公開】・数字なし）の case は、下の「いまの呼び方」の2つ。
const GUIDE = '画面上部の【② 試す】ボタンで、text.txt の内容を確認してみてください。'
const LEAD = '次にやることを1つ案内します。'

describe('stripRepeatedGuidance: 直前と同一の案内定型文だけを取り除く', () => {
  it('★★ 直前の返事と同一の案内段落は消える（本文は残る）', () => {
    const prev = `text.txt を保存しました。\n\n${LEAD}\n\n${GUIDE}`
    const cur = `ls の結果は text.txt の1件です。\n\n${LEAD}\n\n${GUIDE}`
    expect(stripRepeatedGuidance(cur, prev)).toBe('ls の結果は text.txt の1件です。')
  })

  it('★★ 初出の案内（直前に無い）は消えない', () => {
    const prev = 'ファイルを読みました。'
    const cur = `保存しました。\n\n${GUIDE}`
    expect(stripRepeatedGuidance(cur, prev)).toBe(cur)
  })

  it('★★ 案内の形でない段落は、直前と同一でも消えない（本文の反復を勝手に削らない）', () => {
    const prev = `結果は次のとおりです。\n\n- text.txt`
    const cur = `結果は次のとおりです。\n\n- text.txt`
    expect(stripRepeatedGuidance(cur, prev)).toBe(cur)
  })

  it('★ 内容の違う案内（別のファイル名など）は消えない', () => {
    const prev = `保存しました。\n\n画面上部の【② 試す】ボタンで、index.html の内容を確認してみてください。`
    const cur = `保存しました。\n\n${GUIDE}`
    expect(stripRepeatedGuidance(cur, prev)).toBe(cur)
  })

  it('★ ③公開 の案内も対象', () => {
    const g3 = '画面上部の【③ 公開】ボタンから公開できます。'
    const prev = `確認できました。\n\n${g3}`
    const cur = `いいですね。\n\n${g3}`
    expect(stripRepeatedGuidance(cur, prev)).toBe('いいですね。')
  })

  it('★★ いまの呼び方（【試す】【公開】・数字なし）の案内も、直前と同一なら消える（2026-10-07・丸数字を廃止）', () => {
    const g1 = '画面上部の【試す】ボタンで、text.txt の内容を確認してみてください。'
    const g2 = '画面上部の【公開】ボタンから公開できます。'
    for (const g of [g1, g2]) {
      const prev = `保存しました。\n\n${g}`
      const cur = `ls の結果は1件です。\n\n${g}`
      expect(stripRepeatedGuidance(cur, prev), g).toBe('ls の結果は1件です。')
    }
  })

  it('★ いまの呼び方でも、初出は消えない。案内の形でない段落（ボタンの説明）は直前と同一でも消えない', () => {
    const cur = '保存しました。\n\n画面上部の【試す】ボタンで確認してみてください。'
    expect(stripRepeatedGuidance(cur, '読みました。')).toBe(cur)
    const body = '「試す」は、実行して確認するボタンです。'
    expect(stripRepeatedGuidance(`A\n\n${body}`, `B\n\n${body}`)).toBe(`A\n\n${body}`)
  })

  it('★ 全段落が案内だった場合は元のまま（空の返事にしない）', () => {
    const prev = `保存しました。\n\n${GUIDE}`
    const cur = GUIDE
    expect(stripRepeatedGuidance(cur, prev)).toBe(GUIDE)
  })

  it('★ 直前の返事が無ければ（会話の最初）何もしない', () => {
    expect(stripRepeatedGuidance(`保存しました。\n\n${GUIDE}`, null)).toBe(`保存しました。\n\n${GUIDE}`)
    expect(stripRepeatedGuidance(`保存しました。\n\n${GUIDE}`, undefined)).toBe(`保存しました。\n\n${GUIDE}`)
  })

  it('★ 何も消さないときは原文をそのまま返す（空行の形を変えない）', () => {
    const cur = 'A\n\n\nB' // 3連改行
    expect(stripRepeatedGuidance(cur, '別の返事')).toBe(cur)
  })
})
