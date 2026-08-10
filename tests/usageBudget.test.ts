import { describe, it, expect, beforeEach } from 'vitest'

// 利用上限（お金）まわりの回帰テスト。2026-08-05 時点で専用テストが1件も無かった。
// ここが壊れると「上限を設定したのに課金が止まらない」「上限内なのに使えない」が起きる。
//
// vitest の環境は 'node' のため、localStorage と window を最小限だけ用意する
// （tests/toolSupport.test.ts と同じ流儀）。

const memoryStorage = () => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { store = {} },
  }
}
;(globalThis as any).localStorage = memoryStorage()
;(globalThis as any).window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} }

const {
  checkBeforeRequest, recordUsage, resetThisMonth, getUsageForKey, getUsage,
  setKeyLimit, getKeyLimit, effectiveLimit, setSettings, getSettings, DEFAULT_SETTINGS,
  hashKey, priceFor, estimateTokens, PRICING,
} = await import('../src/renderer/usage')

const KEY_A = 'sk-aaaaaaaaaaaaaaaa'
const KEY_B = 'sk-bbbbbbbbbbbbbbbb'
const MODEL = Object.keys(PRICING)[0] // 価格表にあるモデル

beforeEach(() => {
  localStorage.clear()
  setSettings({ ...DEFAULT_SETTINGS })
})

describe('上限の判定（checkBeforeRequest）', () => {
  it('上限の適用がオフなら、いくら使っていても通す', () => {
    setSettings({ ...getSettings(), enforce: false, monthlyLimitYen: 100 })
    recordUsage(KEY_A, MODEL, 100_000_000, 100_000_000) // 大量に使う
    expect(checkBeforeRequest(KEY_A).allowed).toBe(true)
  })

  it('上限が無制限（null）なら通す', () => {
    setSettings({ ...getSettings(), enforce: true, monthlyLimitYen: null })
    recordUsage(KEY_A, MODEL, 100_000_000, 100_000_000)
    expect(checkBeforeRequest(KEY_A).allowed).toBe(true)
  })

  it('上限未満なら通し、達したら止める（境界を含む）', () => {
    setSettings({ ...getSettings(), enforce: true, monthlyLimitYen: 100 })
    expect(checkBeforeRequest(KEY_A).allowed).toBe(true) // 未使用

    // 上限ちょうどまで使う
    const price = priceFor(MODEL)
    const tokensFor100Yen = Math.ceil((100 / price.in) * 1_000_000)
    recordUsage(KEY_A, MODEL, tokensFor100Yen, 0)
    const cost = getUsageForKey(KEY_A).costYen
    expect(cost).toBeGreaterThanOrEqual(100)

    const r = checkBeforeRequest(KEY_A)
    expect(r.allowed).toBe(false)          // 「達した」時点で止める
    expect(r.message).toContain('上限')     // 何が起きたか伝える
  })

  it('止めるときは、いくら使ったか・どうすれば解除できるかを伝える', () => {
    setSettings({ ...getSettings(), enforce: true, monthlyLimitYen: 1 })
    recordUsage(KEY_A, MODEL, 100_000_000, 0)
    const r = checkBeforeRequest(KEY_A)
    expect(r.allowed).toBe(false)
    expect(r.message).toMatch(/¥/)          // 金額を示す
    expect(r.message).toContain('認証情報')  // 解除の導線を示す
  })
})

describe('キーごとの上限', () => {
  it('キー個別の設定が既定より優先される', () => {
    setSettings({ ...getSettings(), enforce: true, monthlyLimitYen: 1000 })
    setKeyLimit(KEY_A, 10)
    expect(effectiveLimit(KEY_A)).toBe(10)
    expect(effectiveLimit(KEY_B)).toBe(1000) // 未設定のキーは既定
  })

  it('キー個別を「無制限（null）」にすると、既定の上限に縛られない', () => {
    setSettings({ ...getSettings(), enforce: true, monthlyLimitYen: 1 })
    setKeyLimit(KEY_A, null)
    recordUsage(KEY_A, MODEL, 100_000_000, 0)
    expect(checkBeforeRequest(KEY_A).allowed).toBe(true)
  })

  it('個別設定を消す（undefined）と既定に戻る', () => {
    setSettings({ ...getSettings(), enforce: true, monthlyLimitYen: 500 })
    setKeyLimit(KEY_A, 10)
    setKeyLimit(KEY_A, undefined)
    expect(getKeyLimit(KEY_A)).toBeUndefined()
    expect(effectiveLimit(KEY_A)).toBe(500)
  })

  it('キーごとに利用額が混ざらない', () => {
    setSettings({ ...getSettings(), enforce: true, monthlyLimitYen: 1 })
    recordUsage(KEY_A, MODEL, 100_000_000, 0)
    expect(checkBeforeRequest(KEY_A).allowed).toBe(false)
    expect(checkBeforeRequest(KEY_B).allowed).toBe(true) // 別のキーは影響を受けない
    expect(getUsageForKey(KEY_B).costYen).toBe(0)
  })

  it('生のキーは保存せず、指紋で記録する（キーの取り違えも起きない）', () => {
    recordUsage(KEY_A, MODEL, 1000, 1000)
    const dump = JSON.stringify(localStorage.getItem('sakura_usage_by_month'))
    expect(dump).not.toContain(KEY_A)          // 生のキーが残っていない
    expect(dump).toContain(hashKey(KEY_A))     // 指紋で入っている
    expect(hashKey(KEY_A)).not.toBe(hashKey(KEY_B))
  })
})

describe('利用量の記録（recordUsage）', () => {
  it('価格表どおりに課金額を積み上げる', () => {
    const price = priceFor(MODEL)
    recordUsage(KEY_A, MODEL, 1_000_000, 1_000_000)
    expect(getUsageForKey(KEY_A).costYen).toBeCloseTo(price.in + price.out, 6)
  })

  it('複数回の記録が足し合わされる', () => {
    recordUsage(KEY_A, MODEL, 1000, 500)
    recordUsage(KEY_A, MODEL, 1000, 500)
    const u = getUsageForKey(KEY_A)
    expect(u.promptTokens).toBe(2000)
    expect(u.completionTokens).toBe(1000)
  })

  it('価格表に無いモデルでも課金を0にしない（取りこぼしで上限が効かなくなるのを防ぐ）', () => {
    recordUsage(KEY_A, '見たことのないモデル', 1_000_000, 1_000_000)
    expect(getUsageForKey(KEY_A).costYen).toBeGreaterThan(0)
  })

  // 実装の穴（2026-08-05 修正）: トークン数は Math.max(0,…) で守られていたが、
  // 課金額の計算だけ生の値を使っていた。異常な応答で負の値が来ると**利用額が減り**、
  // 上限に達していたキーがまた使えてしまう。
  it('異常な値（負のトークン数）で利用額が減らない', () => {
    recordUsage(KEY_A, MODEL, 1_000_000, 1_000_000)
    const before = getUsageForKey(KEY_A).costYen
    recordUsage(KEY_A, MODEL, -10_000_000, -10_000_000)
    expect(getUsageForKey(KEY_A).costYen).toBeGreaterThanOrEqual(before)
    expect(getUsageForKey(KEY_A).promptTokens).toBeGreaterThanOrEqual(0)
  })

  it('NaN でも記録が壊れない', () => {
    recordUsage(KEY_A, MODEL, 1000, 1000)
    recordUsage(KEY_A, MODEL, NaN, NaN)
    const u = getUsageForKey(KEY_A)
    expect(Number.isFinite(u.costYen)).toBe(true)
    expect(Number.isFinite(u.promptTokens)).toBe(true)
  })

  it('今月分をリセットできる', () => {
    recordUsage(KEY_A, MODEL, 1000, 1000)
    resetThisMonth()
    expect(getUsage().costYen).toBe(0)
    expect(getUsageForKey(KEY_A).costYen).toBe(0)
  })
})

describe('保存データが壊れていても落ちない', () => {
  it('利用量のJSONが壊れていても 0 として扱う', () => {
    localStorage.setItem('sakura_usage_by_month', '{壊れたJSON')
    expect(getUsage().costYen).toBe(0)
    expect(checkBeforeRequest(KEY_A).allowed).toBe(true)
  })

  it('設定のJSONが壊れていても既定値で動く', () => {
    localStorage.setItem('sakura_budget_settings', 'これはJSONではない')
    expect(getSettings().enforce).toBe(DEFAULT_SETTINGS.enforce)
  })
})

describe('トークン数の見積り（estimateTokens）', () => {
  it('日本語は1文字1トークン、英数字は4文字で1トークンの目安', () => {
    expect(estimateTokens('あいうえお')).toBe(5)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('')).toBe(0)
  })
})
