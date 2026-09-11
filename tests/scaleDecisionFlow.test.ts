import { describe, it, expect } from 'vitest'
import { nextApplyOpts } from '../src/renderer/scaleDecisionFlow'

// 委譲仕様: 選択カードのボタンを押したあと、cloud.apply を呼び直す opts（画面側の判断）。
// 「同じ confirmed で」呼び直す（Ryosuke さん決定・案②・2026-09-10）。

describe("nextApplyOpts: 選んだ方を scaleDecision に載せ、confirmed は引き継ぐ", () => {
  it("choice:'koto' → { confirmed, scaleDecision: 'koto' }", () => {
    expect(nextApplyOpts({ confirmed: true }, 'koto')).toEqual({ confirmed: true, scaleDecision: 'koto' })
    expect(nextApplyOpts({ confirmed: false }, 'koto')).toEqual({ confirmed: false, scaleDecision: 'koto' })
  })

  it("choice:'sakura' → { confirmed, scaleDecision: 'sakura' }", () => {
    expect(nextApplyOpts({ confirmed: true }, 'sakura')).toEqual({ confirmed: true, scaleDecision: 'sakura' })
    expect(nextApplyOpts({ confirmed: false }, 'sakura')).toEqual({ confirmed: false, scaleDecision: 'sakura' })
  })
})
