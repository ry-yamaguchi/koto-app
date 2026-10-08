// tests/w-chat-costFooter.test.ts — W-102 固定: claudeCostFooter の全分岐（検分の指摘3）。
//
// tests/claudeAgent.test.ts（既存・書き換えない方針）は「成功・金額あり」と
// 「成功・金額0」の2分岐しか固定していない。W-102（2026-09-27 作者決定・親が原本で
// 確かめて2つに分けた）は isError を見る新しい分岐を持つが、それを固定するテストが
// どこにも無かった（検分の指摘3）。ここで残りの分岐（1円未満・エラー×金額0・
// エラー×金額あり）を固定する。

import { describe, it, expect } from 'vitest'
import { claudeCostFooter, approxJpyFromUsd, USD_JPY_APPROX } from '../src/renderer/claudeMode'

describe('W-102: claudeCostFooter の分岐', () => {
  it('成功・金額あり（1円以上）: 円（概算）と $表記を併記する', () => {
    // 決定の例そのもの: 0.1234ドル・150円/ドル換算 → 18.51円 → 四捨五入で19円
    expect(USD_JPY_APPROX).toBe(150)
    expect(claudeCostFooter(0.1234, 'claude-opus-5')).toBe('🤖 Powered by Claude (Opus 5)・今回の利用額 約19円（$0.1234）')
  })

  it('★ 成功・金額あり（1円未満）: 「1円未満」と表示する（$表記は消えない）', () => {
    const usd = 0.001 // 150円換算で0.15円 → 1円未満
    expect(approxJpyFromUsd(usd)).toBeLessThan(1)
    expect(claudeCostFooter(usd, 'claude-opus-5')).toBe('🤖 Powered by Claude (Opus 5)・今回の利用額 1円未満（$0.0010）')
  })

  it('成功・金額0（isError=false, 既定）: 従来どおり「利用額を取得できませんでした」', () => {
    expect(claudeCostFooter(0, 'claude-opus-5')).toBe('🤖 Powered by Claude (Opus 5)・利用額を取得できませんでした')
  })

  it('★★ エラーで終わり・金額0: 空文字（呼び出し側は吹き出しを出さない・利用額の行を付けない）', () => {
    expect(claudeCostFooter(0, 'claude-opus-5', true)).toBe('')
    expect(claudeCostFooter(NaN, 'claude-opus-5', true)).toBe('')
    expect(claudeCostFooter(-1, 'claude-opus-5', true)).toBe('')
  })

  it('★★ エラーで終わったが金額あり（途中まで使った）: 成功時と同じ金額表記を出す', () => {
    expect(claudeCostFooter(0.1234, 'claude-opus-5', true)).toBe('🤖 Powered by Claude (Opus 5)・今回の利用額 約19円（$0.1234）')
  })
})
