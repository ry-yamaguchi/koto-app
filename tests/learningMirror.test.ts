import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getLearningMirror, setMirrorEntry, clearMirrorEntry, primeLearningMirror, resetLearningMirrorForTest,
} from '../src/renderer/learningMirror'

// B'-3d-1a: renderer 側の写し（ミラー）。main（learningStore.ts）が持ち主になった学習キャッシュ
// を、renderer が同期で読めるようにするためのモジュールレベル state。
// toolSupport.ts / visionSupport.ts の判定・record/forget はこのモジュール経由で行われる
// （tests/toolSupport.test.ts・tests/visionSupport.test.ts がそちら側から検証済み）。
// ここでは primeLearningMirror（初期化・購読・片道移行）自体の振る舞いを検証する。

beforeEach(() => {
  resetLearningMirrorForTest()
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

describe('primeLearningMirror: window が無い環境（node のテスト）では何もしない', () => {
  it('window 未定義でも例外を投げず、ミラーは空のまま', () => {
    expect(() => primeLearningMirror()).not.toThrow()
    expect(getLearningMirror()).toEqual({ toolSupport: {}, visionSupport: {} })
  })
})

describe('primeLearningMirror: learning:get で初期化する', () => {
  it('get() の結果でミラーが上書きされる', async () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    const get = vi.fn().mockResolvedValue({
      toolSupport: { modelA: { supported: true, at: 1000 } },
      visionSupport: {},
    })
    const migrate = vi.fn().mockResolvedValue(undefined)
    const onChanged = vi.fn()
    ;(globalThis as any).window = { electronAPI: { learning: { get, migrate, onChanged } } }

    primeLearningMirror()
    await new Promise((r) => setImmediate(r)) // get().then(...) の完了を待つ

    expect(getLearningMirror().toolSupport).toEqual({ modelA: { supported: true, at: 1000 } })
  })

  it('get() が失敗しても例外は外へ出ず、ミラーは空のまま続く', async () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    const get = vi.fn().mockRejectedValue(new Error('boom'))
    const migrate = vi.fn().mockResolvedValue(undefined)
    const onChanged = vi.fn()
    ;(globalThis as any).window = { electronAPI: { learning: { get, migrate, onChanged } } }

    expect(() => primeLearningMirror()).not.toThrow()
    await new Promise((r) => setImmediate(r))
    expect(getLearningMirror()).toEqual({ toolSupport: {}, visionSupport: {} })
  })

  it('2回呼んでも get は1回しか呼ばれない（起動時に1度だけの想定）', () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    const get = vi.fn().mockResolvedValue({ toolSupport: {}, visionSupport: {} })
    const migrate = vi.fn().mockResolvedValue(undefined)
    const onChanged = vi.fn()
    ;(globalThis as any).window = { electronAPI: { learning: { get, migrate, onChanged } } }

    primeLearningMirror()
    primeLearningMirror()
    expect(get).toHaveBeenCalledTimes(1)
  })
})

describe('primeLearningMirror: learning:changed を購読して更新する', () => {
  it('onChanged に渡したコールバックが呼ばれるとミラーが更新される', () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    const get = vi.fn().mockResolvedValue({ toolSupport: {}, visionSupport: {} })
    const migrate = vi.fn().mockResolvedValue(undefined)
    let onChangedCb: ((s: unknown) => void) | null = null
    const onChanged = vi.fn((cb: (s: unknown) => void) => { onChangedCb = cb; return () => {} })
    ;(globalThis as any).window = { electronAPI: { learning: { get, migrate, onChanged } } }

    primeLearningMirror()
    expect(onChangedCb).not.toBeNull()
    onChangedCb!({ toolSupport: {}, visionSupport: { modelZ: { supported: true, at: 5000 } } })

    expect(getLearningMirror().visionSupport).toEqual({ modelZ: { supported: true, at: 5000 } })
  })
})

describe('primeLearningMirror: 旧localStorageからの片道移行', () => {
  it('旧キーが無ければ migrate を呼ばない', () => {
    ;(globalThis as any).localStorage = memoryLocalStorage()
    const migrate = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = {
      electronAPI: { learning: { get: vi.fn().mockResolvedValue({ toolSupport: {}, visionSupport: {} }), migrate, onChanged: vi.fn() } },
    }
    primeLearningMirror()
    expect(migrate).not.toHaveBeenCalled()
  })

  it('旧キーがあれば、その中身をそのまま migrate へ送る（消さない）', () => {
    const ls = memoryLocalStorage()
    ls.setItem('sakura_model_tool_support', JSON.stringify({ modelA: { supported: true, at: 1000 } }))
    ;(globalThis as any).localStorage = ls
    const migrate = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = {
      electronAPI: { learning: { get: vi.fn().mockResolvedValue({ toolSupport: {}, visionSupport: {} }), migrate, onChanged: vi.fn() } },
    }

    primeLearningMirror()

    expect(migrate).toHaveBeenCalledWith({ toolSupport: { modelA: { supported: true, at: 1000 } }, visionSupport: undefined })
    expect(ls.getItem('sakura_model_tool_support')).not.toBeNull() // 消していない（戻せる保険）
  })

  it('壊れたJSONは無視され、migrate も呼ばれない（両方壊れている場合）', () => {
    const ls = memoryLocalStorage()
    ls.setItem('sakura_model_tool_support', '{not valid json')
    ;(globalThis as any).localStorage = ls
    const migrate = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = {
      electronAPI: { learning: { get: vi.fn().mockResolvedValue({ toolSupport: {}, visionSupport: {} }), migrate, onChanged: vi.fn() } },
    }
    expect(() => primeLearningMirror()).not.toThrow()
    expect(migrate).not.toHaveBeenCalled()
  })
})

describe('setMirrorEntry / clearMirrorEntry（楽観更新）', () => {
  it('setMirrorEntry は指定した kind だけを書き換える', () => {
    setMirrorEntry('tool', 'modelA', true, 1000)
    expect(getLearningMirror()).toEqual({ toolSupport: { modelA: { supported: true, at: 1000 } }, visionSupport: {} })
  })

  it('clearMirrorEntry(model指定) はそのモデルだけ消す', () => {
    setMirrorEntry('vision', 'modelA', true, 1000)
    setMirrorEntry('vision', 'modelB', false, 2000)
    clearMirrorEntry('vision', 'modelA')
    expect(getLearningMirror().visionSupport).toEqual({ modelB: { supported: false, at: 2000 } })
  })

  it('clearMirrorEntry(model省略) はその kind を全消去する', () => {
    setMirrorEntry('tool', 'modelA', true, 1000)
    clearMirrorEntry('tool')
    expect(getLearningMirror().toolSupport).toEqual({})
  })
})
