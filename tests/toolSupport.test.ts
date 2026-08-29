import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  TOOL_SUPPORT_KEY, TOOL_SUPPORT_TTL_MS,
  toolSupportOf, shouldSendTools, isKnownToolCapable,
  recordToolSupport, forgetToolSupport,
} from '../src/renderer/toolSupport'
import { resetLearningMirrorForTest, setMirrorEntry } from '../src/renderer/learningMirror'

// B'-3d-1a: 学習キャッシュ（ツール対応）の持ち主が main（src/main/learningStore.ts）へ移った。
// toolSupport.ts は、その写し（src/renderer/learningMirror.ts）を読み書きする薄い層になった
// （localStorage はもう読み書きしない）。判定ロジック自体（種・TTL）の回帰テストは
// tests/modelLearning.test.ts（src/shared/modelLearning.ts の純関数）へ移した。ここでは
// 「ミラー経由で判定できること」「record/forget がミラーを楽観更新し、main へ IPC を送ること」
// を検証する（旧: localStorage の読み書きだったもの）。

beforeEach(() => {
  resetLearningMirrorForTest()
})
afterEach(() => {
  delete (globalThis as any).window
})

describe('公開API（キー・TTL）の値は変えていない', () => {
  it('TOOL_SUPPORT_KEY', () => {
    expect(TOOL_SUPPORT_KEY).toBe('sakura_model_tool_support')
  })
  it('TOOL_SUPPORT_TTL_MS（30日）', () => {
    expect(TOOL_SUPPORT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})

describe('toolSupportOf/shouldSendTools/isKnownToolCapable はミラーを読む', () => {
  it('ミラーが空でも、種（seed）の判定は効く', () => {
    expect(toolSupportOf('preview/Kimi-K2.6')).toBe(true)
    expect(toolSupportOf('llm-jp-3.1-8x13b-instruct4')).toBe(false)
    expect(toolSupportOf('some-brand-new-model')).toBeNull()
  })

  it('ミラーに入れた記録を読み戻せる（main からの learning:changed を想定した setMirrorEntry）', () => {
    setMirrorEntry('tool', 'preview/Kimi-K2.7-Code', true, Date.now())
    expect(toolSupportOf('preview/Kimi-K2.7-Code')).toBe(true)
    expect(shouldSendTools('preview/Kimi-K2.7-Code')).toBe(true)
    expect(isKnownToolCapable('preview/Kimi-K2.7-Code')).toBe(true)
  })

  it('未確認は楽観的に送る・実測済み以外は切替候補にしない', () => {
    expect(shouldSendTools('preview/Kimi-K2.7-Code')).toBe(true)
    expect(isKnownToolCapable('preview/Kimi-K2.7-Code')).toBe(false)
  })

  it('TTL: 31日前の記録は無視され、種またはnullに戻る', () => {
    const now = Date.now()
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000
    setMirrorEntry('tool', 'stale-unknown-model', true, now - THIRTY_ONE_DAYS)
    expect(toolSupportOf('stale-unknown-model', now)).toBeNull()
  })
})

describe('recordToolSupport: ミラーを楽観更新してから main へ fire-and-forget で送る', () => {
  it('window（electronAPI）が無い環境でもミラー更新は行われ、例外を投げない', () => {
    expect(() => recordToolSupport('model-a', true, 1000)).not.toThrow()
    expect(toolSupportOf('model-a', 1000)).toBe(true)
  })

  it('window.electronAPI.learning.record が (kind, model, supported) で呼ばれる', () => {
    const record = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = { electronAPI: { learning: { record } } }
    recordToolSupport('model-b', false, 2000)
    expect(record).toHaveBeenCalledWith('tool', 'model-b', false)
    expect(toolSupportOf('model-b', 2000)).toBe(false) // ミラーは IPC の返事を待たずに更新済み（楽観更新）
  })

  it('IPC が失敗しても例外は外へ出ない（次回また学習し直すだけ）', async () => {
    const record = vi.fn().mockRejectedValue(new Error('boom'))
    ;(globalThis as any).window = { electronAPI: { learning: { record } } }
    expect(() => recordToolSupport('model-c', true)).not.toThrow()
    await new Promise((r) => setImmediate(r)) // catch() が rejection を消費するのを待つ
  })

  it('上書きできる（記録済みの判定が後から覆るケース）', () => {
    recordToolSupport('flip-flop-model', false, 1000)
    expect(toolSupportOf('flip-flop-model', 1000)).toBe(false)
    recordToolSupport('flip-flop-model', true, 2000)
    expect(toolSupportOf('flip-flop-model', 2000)).toBe(true)
  })
})

describe('forgetToolSupport: ミラーから消し、main へ fire-and-forget で送る', () => {
  it('モデル指定で該当モデルだけ消える', () => {
    setMirrorEntry('tool', 'model-a', true, Date.now())
    setMirrorEntry('tool', 'model-b', false, Date.now())
    forgetToolSupport('model-a')
    expect(toolSupportOf('model-a')).toBeNull()
    expect(toolSupportOf('model-b')).toBe(false)
  })

  it('省略時は全消去される', () => {
    setMirrorEntry('tool', 'model-a', true, Date.now())
    setMirrorEntry('tool', 'model-b', false, Date.now())
    forgetToolSupport()
    expect(toolSupportOf('model-a')).toBeNull()
    expect(toolSupportOf('model-b')).toBeNull() // 記録が消えたので、種にも無いモデル名は未確認(null)に戻る
  })

  it('window.electronAPI.learning.forget が (kind, model) で呼ばれる', () => {
    const forget = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = { electronAPI: { learning: { forget } } }
    forgetToolSupport('model-a')
    expect(forget).toHaveBeenCalledWith('tool', 'model-a')
  })

  it('省略時は forget(kind, undefined) で呼ばれる', () => {
    const forget = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = { electronAPI: { learning: { forget } } }
    forgetToolSupport()
    expect(forget).toHaveBeenCalledWith('tool', undefined)
  })
})
