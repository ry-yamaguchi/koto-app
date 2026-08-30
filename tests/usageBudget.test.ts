import { describe, it, expect } from 'vitest'
import {
  checkBeforeRequestOf, applyRecord, computeUsage, computeUsageForKey, computeUsageByModel,
  effectiveLimitOf, budgetStatusOf, budgetStatusForKeyOf,
  hashKey, priceFor, PRICING, DEFAULT_SETTINGS,
  sanitizeSettings, sanitizeMonths,
  type BudgetSettings, type UsageStore,
} from '../src/shared/usageBudget'
import { estimateTokens } from '../src/shared/modelInfo'

// 利用上限（お金）まわりの回帰テスト。2026-08-05 時点で専用テストが1件も無かった。
// ここが壊れると「上限を設定したのに課金が止まらない」「上限内なのに使えない」が起きる。
//
// B'-3d-1b: 持ち主が main（usageStore.ts）へ移り、判定・計算は shared/usageBudget.ts の
// 純関数（store を引数に取る形）になった。ここでは localStorage を一切使わず、その純関数を
// 直接テストする（electron / window 依存が無いので vitest の 'node' 環境でそのまま動く）。
// **旧テスト（tests/usageBudget.test.ts・renderer/usage.ts 経由）の全シナリオを保つ**。

const KEY_A = 'sk-aaaaaaaaaaaaaaaa'
const KEY_B = 'sk-bbbbbbbbbbbbbbbb'
const FP_A = hashKey(KEY_A)
const FP_B = hashKey(KEY_B)
const MODEL = Object.keys(PRICING)[0] // 価格表にあるモデル
const MONTH = '2026-08'

function settings(overrides: Partial<BudgetSettings> = {}): BudgetSettings {
  return { ...DEFAULT_SETTINGS, perKeyLimits: {}, ...overrides }
}

describe('上限の判定（checkBeforeRequestOf）', () => {
  it('上限の適用がオフなら、いくら使っていても通す', () => {
    const s = settings({ enforce: false, monthlyLimitYen: 100 })
    const months = applyRecord({}, MONTH, FP_A, MODEL, 100_000_000, 100_000_000) // 大量に使う
    expect(checkBeforeRequestOf(s, months, MONTH, FP_A).allowed).toBe(true)
  })

  it('上限が無制限（null）なら通す', () => {
    const s = settings({ enforce: true, monthlyLimitYen: null })
    const months = applyRecord({}, MONTH, FP_A, MODEL, 100_000_000, 100_000_000)
    expect(checkBeforeRequestOf(s, months, MONTH, FP_A).allowed).toBe(true)
  })

  it('上限未満なら通し、達したら止める（境界を含む）', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 100 })
    expect(checkBeforeRequestOf(s, {}, MONTH, FP_A).allowed).toBe(true) // 未使用

    // 上限ちょうどまで使う
    const price = priceFor(MODEL)
    const tokensFor100Yen = Math.ceil((100 / price.in) * 1_000_000)
    const months = applyRecord({}, MONTH, FP_A, MODEL, tokensFor100Yen, 0)
    const cost = computeUsageForKey(months, MONTH, FP_A).costYen
    expect(cost).toBeGreaterThanOrEqual(100)

    const r = checkBeforeRequestOf(s, months, MONTH, FP_A)
    expect(r.allowed).toBe(false)          // 「達した」時点で止める
    expect(r.message).toContain('上限')     // 何が起きたか伝える
  })

  it('止めるときは、いくら使ったか・どうすれば解除できるかを伝える', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 1 })
    const months = applyRecord({}, MONTH, FP_A, MODEL, 100_000_000, 0)
    const r = checkBeforeRequestOf(s, months, MONTH, FP_A)
    expect(r.allowed).toBe(false)
    expect(r.message).toMatch(/¥/)          // 金額を示す
    expect(r.message).toContain('認証情報')  // 解除の導線を示す
  })
})

describe('キーごとの上限（effectiveLimitOf）', () => {
  it('キー個別の設定が既定より優先される', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 1000, perKeyLimits: { [FP_A]: 10 } })
    expect(effectiveLimitOf(s, FP_A)).toBe(10)
    expect(effectiveLimitOf(s, FP_B)).toBe(1000) // 未設定のキーは既定
  })

  it('キー個別を「無制限（null）」にすると、既定の上限に縛られない', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 1, perKeyLimits: { [FP_A]: null } })
    const months = applyRecord({}, MONTH, FP_A, MODEL, 100_000_000, 0)
    expect(checkBeforeRequestOf(s, months, MONTH, FP_A).allowed).toBe(true)
  })

  it('個別設定が無ければ既定に戻る（hasOwnProperty 判定・「消す」＝キーを持たせない）', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 500 })
    expect(effectiveLimitOf(s, FP_A)).toBe(500)
  })

  it('キーごとに利用額が混ざらない', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 1 })
    const months = applyRecord({}, MONTH, FP_A, MODEL, 100_000_000, 0)
    expect(checkBeforeRequestOf(s, months, MONTH, FP_A).allowed).toBe(false)
    expect(checkBeforeRequestOf(s, months, MONTH, FP_B).allowed).toBe(true) // 別のキーは影響を受けない
    expect(computeUsageForKey(months, MONTH, FP_B).costYen).toBe(0)
  })

  it('生のキーは保存せず、指紋で記録する（キーの取り違えも起きない）', () => {
    const months = applyRecord({}, MONTH, FP_A, MODEL, 1000, 1000)
    const dump = JSON.stringify(months)
    expect(dump).not.toContain(KEY_A)  // 生のキーが残っていない
    expect(dump).toContain(FP_A)       // 指紋で入っている
    expect(hashKey(KEY_A)).not.toBe(hashKey(KEY_B))
  })
})

describe('利用量の記録（applyRecord）', () => {
  it('価格表どおりに課金額を積み上げる', () => {
    const price = priceFor(MODEL)
    const months = applyRecord({}, MONTH, FP_A, MODEL, 1_000_000, 1_000_000)
    expect(computeUsageForKey(months, MONTH, FP_A).costYen).toBeCloseTo(price.in + price.out, 6)
  })

  it('複数回の記録が足し合わされる', () => {
    let months: UsageStore = {}
    months = applyRecord(months, MONTH, FP_A, MODEL, 1000, 500)
    months = applyRecord(months, MONTH, FP_A, MODEL, 1000, 500)
    const u = computeUsageForKey(months, MONTH, FP_A)
    expect(u.promptTokens).toBe(2000)
    expect(u.completionTokens).toBe(1000)
  })

  it('価格表に無いモデルでも課金を0にしない（取りこぼしで上限が効かなくなるのを防ぐ）', () => {
    const months = applyRecord({}, MONTH, FP_A, '見たことのないモデル', 1_000_000, 1_000_000)
    expect(computeUsageForKey(months, MONTH, FP_A).costYen).toBeGreaterThan(0)
  })

  // 実装の穴（2026-08-05 修正）: トークン数は Math.max(0,…) で守られていたが、
  // 課金額の計算だけ生の値を使っていた。異常な応答で負の値が来ると**利用額が減り**、
  // 上限に達していたキーがまた使えてしまう。B'-3d-1b で shared へ移すときも退行させない。
  it('異常な値（負のトークン数）で利用額が減らない', () => {
    let months: UsageStore = {}
    months = applyRecord(months, MONTH, FP_A, MODEL, 1_000_000, 1_000_000)
    const before = computeUsageForKey(months, MONTH, FP_A).costYen
    months = applyRecord(months, MONTH, FP_A, MODEL, -10_000_000, -10_000_000)
    expect(computeUsageForKey(months, MONTH, FP_A).costYen).toBeGreaterThanOrEqual(before)
    expect(computeUsageForKey(months, MONTH, FP_A).promptTokens).toBeGreaterThanOrEqual(0)
  })

  it('NaN でも記録が壊れない', () => {
    let months: UsageStore = {}
    months = applyRecord(months, MONTH, FP_A, MODEL, 1000, 1000)
    months = applyRecord(months, MONTH, FP_A, MODEL, NaN, NaN)
    const u = computeUsageForKey(months, MONTH, FP_A)
    expect(Number.isFinite(u.costYen)).toBe(true)
    expect(Number.isFinite(u.promptTokens)).toBe(true)
  })

  it('今月分をリセットできる（月キーを消せば利用量は0に戻る）', () => {
    let months: UsageStore = {}
    months = applyRecord(months, MONTH, FP_A, MODEL, 1000, 1000)
    delete months[MONTH]
    expect(computeUsage(months, MONTH).costYen).toBe(0)
    expect(computeUsageForKey(months, MONTH, FP_A).costYen).toBe(0)
  })
})

describe('モデル別・全体集計（computeUsageByModel / computeUsage）', () => {
  it('モデル別に集計され、金額の大きい順に並ぶ', () => {
    const models = Object.keys(PRICING)
    let months: UsageStore = {}
    months = applyRecord(months, MONTH, FP_A, models[0], 1_000_000, 0) // 安いモデル寄りでも一応
    months = applyRecord(months, MONTH, FP_B, models[1], 1_000_000, 1_000_000)
    const rows = computeUsageByModel(months, MONTH)
    expect(rows.map(r => r.model).sort()).toEqual([models[0], models[1]].sort())
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].costYen).toBeGreaterThanOrEqual(rows[i].costYen)
  })
})

describe('保存データが壊れていても落ちない（サニタイザ）', () => {
  it('sanitizeMonths: 想定外の形（配列・文字列・null・undefined・数値）は空として扱う', () => {
    for (const bad of [['not', 'an', 'object'], 'これはJSONではない', null, undefined, 123]) {
      expect(() => sanitizeMonths(bad)).not.toThrow()
      expect(computeUsage(sanitizeMonths(bad), MONTH).costYen).toBe(0)
    }
  })

  it('sanitizeSettings: 想定外の形は既定値で動く', () => {
    const s = sanitizeSettings('これはJSONではない')
    expect(s.enforce).toBe(DEFAULT_SETTINGS.enforce)
    expect(s.monthlyLimitYen).toBe(DEFAULT_SETTINGS.monthlyLimitYen)
    expect(s.warnRatio).toBe(DEFAULT_SETTINGS.warnRatio)
    expect(s.perKeyLimits).toEqual({})
  })

  it('壊れていても checkBeforeRequestOf は通す側に倒れる（0円扱い）', () => {
    const months = sanitizeMonths('{壊れたJSON')
    const s = sanitizeSettings(undefined)
    expect(computeUsage(months, MONTH).costYen).toBe(0)
    expect(checkBeforeRequestOf(s, months, MONTH, FP_A).allowed).toBe(true)
  })

  it('sanitizeMonths: 月キーが "YYYY-MM" でないものは弾く', () => {
    const raw = { '2026-8': { keys: {} }, '2026-13': { keys: {} }, 'not-a-month': { keys: {} }, [MONTH]: { keys: {} } }
    expect(Object.keys(sanitizeMonths(raw))).toEqual([MONTH])
  })

  it('sanitizeMonths: カウンタは有限かつ0以上に丸める（非数・負値は0）', () => {
    const raw = JSON.parse(JSON.stringify({
      [MONTH]: { keys: { [FP_A]: { models: { [MODEL]: { promptTokens: -5, completionTokens: NaN, costYen: Infinity } } } } },
    }))
    const months = sanitizeMonths(raw)
    const u = months[MONTH].keys[FP_A].models[MODEL]
    expect(u).toEqual({ promptTokens: 0, completionTokens: 0, costYen: 0 })
  })

  it('sanitizeMonths: 旧 {models} 形式（normalizeMonth の移行元）も取り込める', () => {
    const raw = { [MONTH]: { models: { [MODEL]: { promptTokens: 10, completionTokens: 20, costYen: 1.5 } } } }
    const months = sanitizeMonths(raw)
    expect(computeUsage(months, MONTH)).toEqual({ month: MONTH, promptTokens: 10, completionTokens: 20, totalTokens: 30, costYen: 1.5 })
  })

  // プロトタイプ汚染の芽を摘む（src/shared/modelLearning.ts の sanitizeStore と同じ流儀）。
  // JSON.parse は "__proto__" を（特殊扱いされない）ただの own property として作るため、
  // Object.entries での読み取り自体は安全だが、その値を出力オブジェクトへ `out[key] = ...`
  // の形でブラケット代入すると、キーが実行時に "__proto__" だった場合は実プロトタイプを
  // 差し替えてしまう。UNSAFE_KEYS で弾いていることを、JSON.parse 経由の値で確認する。
  it('sanitizeSettings: perKeyLimits の危険なキー（__proto__ 等）は弾く・プロトタイプを汚染しない', () => {
    const raw = JSON.parse(`{"perKeyLimits": {"__proto__": 999, "constructor": 1, "prototype": 2, "${FP_A}": 10}}`)
    const s = sanitizeSettings(raw)
    expect(s.perKeyLimits).toEqual({ [FP_A]: 10 })
    expect(Object.getPrototypeOf(s.perKeyLimits)).toBe(Object.prototype) // 汚染されていない
  })

  it('sanitizeMonths: fp・モデルキーの危険なキー（__proto__ 等）は弾く', () => {
    const raw = JSON.parse(
      `{"${MONTH}": {"keys": {"__proto__": {"models": {}}, "${FP_A}": {"models": {"__proto__": {"promptTokens":1,"completionTokens":1,"costYen":1}, "${MODEL}": {"promptTokens":1,"completionTokens":1,"costYen":1}}}}}}`
    )
    const months = sanitizeMonths(raw)
    expect(Object.keys(months[MONTH].keys)).toEqual([FP_A])
    expect(Object.keys(months[MONTH].keys[FP_A].models)).toEqual([MODEL])
    expect(Object.getPrototypeOf(months[MONTH].keys)).toBe(Object.prototype)
    // ⚠️ models **自身**のプロトタイプも見る。ガードを外すと `models['__proto__'] = …` は
    // own property ではなく**プロトタイプの差し替え**になるため、Object.keys の確認（上の行）
    // だけでは素通りする（2026-08-30 のミューテーション試験で実際に素通りした）。
    expect(Object.getPrototypeOf(months[MONTH].keys[FP_A].models)).toBe(Object.prototype)
  })
})

describe('全体・キー別の状況（budgetStatusOf / budgetStatusForKeyOf）', () => {
  it('上限が無い（null・0以下）なら limit:null で warn/over は立たない', () => {
    const s = settings({ monthlyLimitYen: null })
    expect(budgetStatusOf(s, {}, MONTH)).toEqual({ limit: null, cost: 0, ratio: null, over: false, warn: false })
  })

  it('warnRatio を超えたら warn、上限に達したら over', () => {
    const s = settings({ monthlyLimitYen: 100, warnRatio: 0.8 })
    const price = priceFor(MODEL)
    const tokensFor90Yen = Math.ceil((90 / price.in) * 1_000_000)
    const months = applyRecord({}, MONTH, FP_A, MODEL, tokensFor90Yen, 0)
    const status = budgetStatusForKeyOf(s, months, MONTH, FP_A)
    expect(status.warn).toBe(true)
    expect(status.over).toBe(false)
  })
})

describe('トークン数の見積り（estimateTokens）', () => {
  it('日本語は1文字1トークン、英数字は4文字で1トークンの目安', () => {
    expect(estimateTokens('あいうえお')).toBe(5)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('')).toBe(0)
  })
})
