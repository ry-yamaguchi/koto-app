import { describe, it, expect } from 'vitest'
import {
  isKeyOverLimitOf, checkBeforeRequestOf, applyRecord, hashKey, priceFor, PRICING,
  DEFAULT_SETTINGS, type BudgetSettings, type UsageStore,
} from '../src/shared/usageBudget'

// ── W-20（2026-09-27決定・案2）: 設定の「⚠️ 上限に達しています」が、実際に止まる基準と違う ──────
//
// 直す前は、先頭の帯が「全キー合計 vs 既定の上限」で「上限に達しています」を出していたが、
// 実際に止める判定（checkBeforeRequestOf）は「そのキー自身の実効上限（キー個別→既定の順）」で
// 見ている。キー個別の上限を高くしていると、全キー合計が既定の上限を超えても AI は動き続けるのに
// 帯は「達した」と言い、その逆（個別上限を低くしている）もありえた＝画面が事実と違う金額の話をする。
//
// 直した後は、帯・棒グラフをやめ、キー別の行に「上限に達しています」を出す。その判定に使うのが
// isKeyOverLimitOf（SettingsModal.tsx の isKeyOverLimit 経由）。ここでは
// 1) isKeyOverLimitOf 単体の境界値・無制限の扱いと、
// 2) isKeyOverLimitOf が「実際に止める」判定（checkBeforeRequestOf の allowed:false）と
//    常に同じ結論になること（掟10: 二重の基準を作らない）を固定する。

const KEY_A = 'sk-aaaaaaaaaaaaaaaa'
const FP_A = hashKey(KEY_A)
const MODEL = Object.keys(PRICING)[0]
const MONTH = '2026-09'

function settings(overrides: Partial<BudgetSettings> = {}): BudgetSettings {
  return { ...DEFAULT_SETTINGS, perKeyLimits: {}, ...overrides }
}

describe('W-20: isKeyOverLimitOf（設定画面のキー別「上限に達しています」の判定）', () => {
  it('上限が無制限（null）なら、いくら使っていても達しない', () => {
    const s = settings({ monthlyLimitYen: null })
    const months = applyRecord({}, MONTH, FP_A, MODEL, 100_000_000, 100_000_000)
    expect(isKeyOverLimitOf(s, months, MONTH, FP_A)).toBe(false)
  })

  it('未使用なら達しない', () => {
    const s = settings({ monthlyLimitYen: 100 })
    expect(isKeyOverLimitOf(s, {}, MONTH, FP_A)).toBe(false)
  })

  it('上限ちょうど（境界）で達したと判定する', () => {
    const s = settings({ monthlyLimitYen: 100 })
    const price = priceFor(MODEL)
    const tokensFor100Yen = Math.ceil((100 / price.in) * 1_000_000)
    const months = applyRecord({}, MONTH, FP_A, MODEL, tokensFor100Yen, 0)
    expect(isKeyOverLimitOf(s, months, MONTH, FP_A)).toBe(true)
  })

  it('★ enforce（上限に達したら停止）の設定に関係なく判定する（表示は止める設定と無関係のため）', () => {
    const price = priceFor(MODEL)
    const tokensFor100Yen = Math.ceil((100 / price.in) * 1_000_000)
    const months = applyRecord({}, MONTH, FP_A, MODEL, tokensFor100Yen, 0)
    expect(isKeyOverLimitOf(settings({ monthlyLimitYen: 100, enforce: true }), months, MONTH, FP_A)).toBe(true)
    expect(isKeyOverLimitOf(settings({ monthlyLimitYen: 100, enforce: false }), months, MONTH, FP_A)).toBe(true)
  })
})

describe('W-20: isKeyOverLimitOf は checkBeforeRequestOf が「止める」と判定するのと同じ基準（食い違いを作らない）', () => {
  it('★ enforce:true のとき、isKeyOverLimitOf と「止まる（allowed:false）」は常に一致する', () => {
    const price = priceFor(MODEL)
    for (const yen of [0, 10, 99, 100, 101, 1000]) {
      const months = yen === 0 ? {} : applyRecord({}, MONTH, FP_A, MODEL, Math.ceil((yen / price.in) * 1_000_000), 0)
      const s = settings({ monthlyLimitYen: 100, enforce: true })
      const over = isKeyOverLimitOf(s, months, MONTH, FP_A)
      const blocked = !checkBeforeRequestOf(s, months, MONTH, FP_A).allowed
      expect(over, `yen=${yen}: isKeyOverLimitOf=${over} と blocked=${blocked} が食い違う`).toBe(blocked)
    }
  })

  it('キー個別の上限が既定より優先される（他のキーの利用額で誤って「達した」にならない）', () => {
    const s = settings({ monthlyLimitYen: 1, perKeyLimits: { [FP_A]: 1000 } }) // 個別は高い
    const price = priceFor(MODEL)
    const months = applyRecord({}, MONTH, FP_A, MODEL, Math.ceil((500 / price.in) * 1_000_000), 0) // 既定(¥1)は超えるが個別(¥1000)は超えない
    expect(isKeyOverLimitOf(s, months, MONTH, FP_A)).toBe(false)
  })
})
