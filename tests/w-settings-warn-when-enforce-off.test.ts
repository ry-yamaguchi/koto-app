import { describe, it, expect } from 'vitest'
import {
  checkBeforeRequestOf, applyRecord, hashKey, priceFor, PRICING, DEFAULT_SETTINGS,
  type BudgetSettings,
} from '../src/shared/usageBudget'

// ── W-21（2026-09-27決定・別案）: 「オフの場合は警告のみ表示します」なのに、作業中にはどこにも
// 警告が出なかった ────────────────────────────────────────────────────
//
// 直す前は enforce:false のとき checkBeforeRequestOf が即 { allowed: true } を返し、上限を超えて
// いても何も伝えていなかった（「警告は出る」と信じてオフにした人が、気づかないまま使いすぎる）。
//
// 直した後は、enforce:false でも実効上限を超えていれば `allowed:true` のまま `warning` を返す
// （止めない・作業中にも知らせる）。enforce:true で止めるときは、これまでどおり `message` のみ
// （`warning` は付けない）。呼び出し側（useAiChat.ts／ChatPanel.tsx）はこの `warning` をチャットに
// 表示する想定（このファイルはその判定・文面の純関数だけを固定する。handoff 参照）。

const KEY_A = 'sk-aaaaaaaaaaaaaaaa'
const FP_A = hashKey(KEY_A)
const MODEL = Object.keys(PRICING)[0]
const MONTH = '2026-09'

function settings(overrides: Partial<BudgetSettings> = {}): BudgetSettings {
  return { ...DEFAULT_SETTINGS, perKeyLimits: {}, ...overrides }
}

function monthsOverBy(yen: number): ReturnType<typeof applyRecord> {
  const price = priceFor(MODEL)
  return applyRecord({}, MONTH, FP_A, MODEL, Math.ceil((yen / price.in) * 1_000_000), 0)
}

describe('W-21: checkBeforeRequestOf は enforce:false でも上限超過を warning で知らせる（止めない）', () => {
  it('★ enforce:false・上限超過 → allowed:true のまま warning が付く（直す前は何も付かなかった）', () => {
    const s = settings({ enforce: false, monthlyLimitYen: 100 })
    const months = monthsOverBy(150)
    const r = checkBeforeRequestOf(s, months, MONTH, FP_A)
    expect(r.allowed).toBe(true) // 止めない
    expect(r.warning).toBeDefined()
    expect(r.warning).toContain('上限')
    expect(r.warning).toMatch(/¥/) // 金額を示す
  })

  it('enforce:false・上限未満 → warning は付かない（達していないのに知らせない）', () => {
    const s = settings({ enforce: false, monthlyLimitYen: 100 })
    const months = monthsOverBy(50)
    const r = checkBeforeRequestOf(s, months, MONTH, FP_A)
    expect(r.allowed).toBe(true)
    expect(r.warning).toBeUndefined()
  })

  it('enforce:false・上限が無制限（null） → warning は付かない', () => {
    const s = settings({ enforce: false, monthlyLimitYen: null })
    const months = monthsOverBy(100_000)
    const r = checkBeforeRequestOf(s, months, MONTH, FP_A)
    expect(r.allowed).toBe(true)
    expect(r.warning).toBeUndefined()
  })

  it('★ enforce:true・上限超過 → これまでどおり止める（allowed:false・message）。warning は付けない', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 100 })
    const months = monthsOverBy(150)
    const r = checkBeforeRequestOf(s, months, MONTH, FP_A)
    expect(r.allowed).toBe(false)
    expect(r.message).toBeDefined()
    expect(r.warning).toBeUndefined() // 止めているのに warning まで出すと二重の意味になる
  })

  it('止めるときのメッセージ文言は、移設前と一字一句同じ（退行させない）', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 1 })
    const months = monthsOverBy(2)
    const r = checkBeforeRequestOf(s, months, MONTH, FP_A)
    expect(r.message).toMatch(/¥/)
    expect(r.message).toContain('認証情報')
    expect(r.message).toContain('に達しました')
  })
})
