import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getUsageMirror, applyRecordToMirror, setSettingsInMirror, setKeyLimitInMirror, resetMonthInMirror,
  primeUsageMirror, resetUsageMirrorForTest,
} from '../src/renderer/usageMirror'
import { DEFAULT_SETTINGS, hashKey, thisMonth } from '../src/shared/usageBudget'

// B'-3d-1b: renderer 側の写し（ミラー）。main（usageStore.ts）が持ち主になった予算設定・
// 利用実績を、renderer が同期で読めるようにするためのモジュールレベル state
// （tests/learningMirror.test.ts と同じ流儀）。renderer/usage.ts の判定・記録はこのモジュール
// 経由で行われる（tests/usageBudget.test.ts が判定・計算の純関数側を検証済み）。
// ここでは primeUsageMirror（初期化・購読・片道移行）と楽観更新ヘルパーを検証する。
//
// ⚠️ learningMirror.ts と違い、usageMirror.ts の楽観更新ヘルパー・applySnapshot は**必ず**
// window.dispatchEvent('sakura-usage-changed') を呼ぶ（既存UI＝SettingsModal 等の購読を
// 生かすための仕様）。そのためここの fake window には常に dispatchEvent を持たせる
// （無いと「window.dispatchEvent is not a function」で落ちる）。

beforeEach(() => {
  resetUsageMirrorForTest()
})
afterEach(() => {
  delete (globalThis as any).window
  ;(globalThis as any).localStorage = undefined
})

function memoryLocalStorage(): Storage {
  const mem: Record<string, string> = {}
  return {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = String(v) },
    removeItem: (k: string) => { delete mem[k] },
    clear: () => { for (const k of Object.keys(mem)) delete mem[k] },
    key: () => null,
    length: 0,
  } as unknown as Storage
}

/** fake window.electronAPI.usage（onChanged 未指定時は vi.fn()）。dispatchEvent は常に持たせる。 */
function makeWindow(usage: Partial<{
  get: ReturnType<typeof vi.fn>
  migrate: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
}>, onDispatch?: (type: string) => void) {
  return {
    electronAPI: {
      usage: {
        get: usage.get ?? vi.fn().mockResolvedValue({ settings: DEFAULT_SETTINGS, months: {} }),
        migrate: usage.migrate ?? vi.fn().mockResolvedValue(undefined),
        onChanged: usage.onChanged ?? vi.fn(),
        record: vi.fn(), setSettings: vi.fn(), setKeyLimit: vi.fn(), reset: vi.fn(),
      },
    },
    dispatchEvent: (ev: Event) => { onDispatch?.(ev.type); return true },
  }
}

const FP_A = hashKey('sk-aaaaaaaaaaaaaaaa')

describe('primeUsageMirror: window が無い環境（node のテスト）では何もしない', () => {
  it('window 未定義でも例外を投げず、ミラーは既定値のまま', () => {
    expect(() => primeUsageMirror()).not.toThrow()
    expect(getUsageMirror()).toEqual({ settings: { ...DEFAULT_SETTINGS, perKeyLimits: {} }, months: {} })
  })
})

describe('primeUsageMirror: usage:get で初期化する', () => {
  it('get() の結果でミラーが上書きされる', async () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    const get = vi.fn().mockResolvedValue({
      settings: { ...DEFAULT_SETTINGS, monthlyLimitYen: 42 },
      months: { '2026-08': { keys: { [FP_A]: { models: {} } } } },
    })
    ;(globalThis as any).window = makeWindow({ get })

    primeUsageMirror()
    await new Promise((r) => setImmediate(r)) // get().then(...) の完了を待つ

    expect(getUsageMirror().settings.monthlyLimitYen).toBe(42)
    expect(getUsageMirror().months['2026-08'].keys[FP_A]).toEqual({ models: {} })
  })

  it('get() が失敗しても例外は外へ出ず、ミラーは既定値のまま続く', async () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    const get = vi.fn().mockRejectedValue(new Error('boom'))
    ;(globalThis as any).window = makeWindow({ get })

    expect(() => primeUsageMirror()).not.toThrow()
    await new Promise((r) => setImmediate(r))
    expect(getUsageMirror()).toEqual({ settings: { ...DEFAULT_SETTINGS, perKeyLimits: {} }, months: {} })
  })

  it('2回呼んでも get は1回しか呼ばれない（起動時に1度だけの想定）', () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    const get = vi.fn().mockResolvedValue({ settings: DEFAULT_SETTINGS, months: {} })
    ;(globalThis as any).window = makeWindow({ get })

    primeUsageMirror()
    primeUsageMirror()
    expect(get).toHaveBeenCalledTimes(1)
  })
})

describe('primeUsageMirror: usage:changed を購読して更新する', () => {
  it('onChanged に渡したコールバックが呼ばれるとミラーが更新される', () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    let onChangedCb: ((s: unknown) => void) | null = null
    const onChanged = vi.fn((cb: (s: unknown) => void) => { onChangedCb = cb; return () => {} })
    ;(globalThis as any).window = makeWindow({ onChanged })

    primeUsageMirror()
    expect(onChangedCb).not.toBeNull()
    onChangedCb!({ settings: { ...DEFAULT_SETTINGS, monthlyLimitYen: 7 }, months: {} })

    expect(getUsageMirror().settings.monthlyLimitYen).toBe(7)
  })

  it('sakura-usage-changed イベントが発火する（既存UIの購読を生かすため）', () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    let onChangedCb: ((s: unknown) => void) | null = null
    const onChanged = vi.fn((cb: (s: unknown) => void) => { onChangedCb = cb; return () => {} })
    const events: string[] = []
    ;(globalThis as any).window = makeWindow({ onChanged }, (type) => events.push(type))

    primeUsageMirror()
    onChangedCb!({ settings: DEFAULT_SETTINGS, months: {} })
    expect(events).toContain('sakura-usage-changed')
  })
})

describe('primeUsageMirror: 旧localStorageからの片道移行', () => {
  it('旧キーが無ければ migrate を呼ばない', () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    const migrate = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = makeWindow({ migrate })
    primeUsageMirror()
    expect(migrate).not.toHaveBeenCalled()
  })

  it('旧キーがあれば、その中身をそのまま migrate へ送る（消さない）', () => {
    const ls = memoryLocalStorage()
    ls.setItem('sakura_budget_settings', JSON.stringify({ monthlyLimitYen: 123 }))
    ls.setItem('sakura_usage_by_month', JSON.stringify({ '2026-08': { keys: {} } }))
    ;(globalThis as any).localStorage = ls
    const migrate = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = makeWindow({ migrate })

    primeUsageMirror()

    expect(migrate).toHaveBeenCalledWith({ settings: { monthlyLimitYen: 123 }, months: { '2026-08': { keys: {} } } })
    expect(ls.getItem('sakura_budget_settings')).not.toBeNull() // 消していない（戻せる保険）
    expect(ls.getItem('sakura_usage_by_month')).not.toBeNull()
  })

  it('壊れたJSONは無視され、migrate も呼ばれない（両方壊れている場合）', () => {
    const ls = memoryLocalStorage()
    ls.setItem('sakura_budget_settings', '{not valid json')
    ls.setItem('sakura_usage_by_month', '{not valid json')
    ;(globalThis as any).localStorage = ls
    const migrate = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = makeWindow({ migrate })
    expect(() => primeUsageMirror()).not.toThrow()
    expect(migrate).not.toHaveBeenCalled()
  })
})

describe('楽観更新（applyRecordToMirror / setSettingsInMirror / setKeyLimitInMirror / resetMonthInMirror）', () => {
  // primeUsageMirror を経由しない直呼びのテスト。ヘルパーは常に window.dispatchEvent を
  // 呼ぶため、electronAPI が無い最小限の window だけ用意する。
  beforeEach(() => {
    ;(globalThis as any).window = { dispatchEvent: () => true }
  })

  it('applyRecordToMirror: read-after-write（記録した直後に反映が見える）', () => {
    applyRecordToMirror(FP_A, 'model-x', 1000, 500)
    const m = getUsageMirror()
    const month = thisMonth()
    expect(m.months[month].keys[FP_A].models['model-x']).toEqual(expect.objectContaining({ promptTokens: 1000, completionTokens: 500 }))
  })

  it('applyRecordToMirror: 既存の months を直接書き換えず新オブジェクトへ差し替える', () => {
    applyRecordToMirror(FP_A, 'model-x', 1000, 500)
    const before = getUsageMirror().months
    applyRecordToMirror(FP_A, 'model-y', 1, 1)
    const after = getUsageMirror().months
    expect(after).not.toBe(before) // 参照が変わっている
    // 元の写しは書き換わっていない（deep copy されている）
    expect(Object.keys(before[thisMonth()].keys[FP_A].models)).toEqual(['model-x'])
  })

  it('setSettingsInMirror: read-after-write', () => {
    setSettingsInMirror({ ...DEFAULT_SETTINGS, monthlyLimitYen: 999 })
    expect(getUsageMirror().settings.monthlyLimitYen).toBe(999)
  })

  it('setSettingsInMirror: 不正な値は sanitizeSettings で既定へ倒れる', () => {
    setSettingsInMirror('not-an-object')
    expect(getUsageMirror().settings).toEqual({ ...DEFAULT_SETTINGS, perKeyLimits: {} })
  })

  it('setKeyLimitInMirror: read-after-write（数値・null・undefined=消す）', () => {
    setKeyLimitInMirror(FP_A, 10)
    expect(getUsageMirror().settings.perKeyLimits[FP_A]).toBe(10)
    setKeyLimitInMirror(FP_A, null)
    expect(getUsageMirror().settings.perKeyLimits[FP_A]).toBeNull()
    setKeyLimitInMirror(FP_A, undefined)
    expect(Object.prototype.hasOwnProperty.call(getUsageMirror().settings.perKeyLimits, FP_A)).toBe(false)
  })

  it('resetMonthInMirror: 今月分だけ消える', () => {
    applyRecordToMirror(FP_A, 'model-x', 1000, 500)
    resetMonthInMirror()
    expect(getUsageMirror().months).toEqual({})
  })

  it('各ヘルパーが sakura-usage-changed を発火する', () => {
    const events: string[] = []
    ;(globalThis as any).window = { dispatchEvent: (ev: Event) => { events.push(ev.type); return true } }
    applyRecordToMirror(FP_A, 'm', 1, 1)
    setSettingsInMirror(DEFAULT_SETTINGS)
    setKeyLimitInMirror(FP_A, 1)
    resetMonthInMirror()
    expect(events).toEqual(['sakura-usage-changed', 'sakura-usage-changed', 'sakura-usage-changed', 'sakura-usage-changed'])
  })
})
