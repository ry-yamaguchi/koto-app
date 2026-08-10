import { describe, it, expect, beforeEach } from 'vitest'
import {
  TOOL_SUPPORT_KEY, TOOL_SUPPORT_TTL_MS,
  readToolSupportStore, recordToolSupport, forgetToolSupport,
  toolSupportOf, shouldSendTools, isKnownToolCapable,
} from '../src/renderer/toolSupport'

// vitest.config.ts のテスト環境は 'node'（DOM非依存の純粋ロジックのみ対象）で、Node組込みの
// localStorage は既定では未初期化のため、tests/claudeAgent.test.ts と同様の最小インメモリ実装を用意する。
;(globalThis as any).localStorage = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { store = {} },
  }
})()

// 背景（2026-07-30）: preview/Kimi-K2.7-Code が旧・正規表現ハードコードの判定で
// 「preview/」「kimi」に一致して非対応と誤判定され、対応モデルなのに毎回旧モデルへ
// 切り替わってしまった。本テストは「未確認のモデルは null（楽観的に送る）」という
// 修正後の挙動の回帰テスト。

describe('toolSupportOf（実測の種＋TTL付きキャッシュ）', () => {
  beforeEach(() => localStorage.clear())

  it('種: preview/Kimi-K2.6 は実測でツール対応(true)', () => {
    expect(toolSupportOf('preview/Kimi-K2.6')).toBe(true)
  })

  it('種: llm-jp系は実測で非対応(false)', () => {
    expect(toolSupportOf('llm-jp-3.1-8x13b-instruct4')).toBe(false)
  })

  it('回帰: preview/Kimi-K2.7-Code は種に含まれず未確認(null)（今回の不具合の原因だった誤判定の修正確認）', () => {
    expect(toolSupportOf('preview/Kimi-K2.7-Code')).toBeNull()
  })

  it('旧ブロックリストにあった preview/・vision系・gpt-oss（120b以外）も、種から外れたため未確認(null)', () => {
    expect(toolSupportOf('preview/Qwen3-VL-30B-A3B-Instruct')).toBeNull()
    expect(toolSupportOf('preview/Phi-4-multimodal-instruct')).toBeNull()
    expect(toolSupportOf('gpt-oss-20b')).toBeNull()
  })

  it('未知のモデル名は未確認(null)', () => {
    expect(toolSupportOf('some-brand-new-model')).toBeNull()
  })
})

describe('shouldSendTools（未確認は楽観的に送る）', () => {
  beforeEach(() => localStorage.clear())

  it('未確認のモデルは true（ツールを送って試す）', () => {
    expect(shouldSendTools('preview/Kimi-K2.7-Code')).toBe(true)
  })

  it('既知で対応(true)のモデルは true', () => {
    expect(shouldSendTools('preview/Kimi-K2.6')).toBe(true)
  })

  it('既知で非対応(false)のモデルは false', () => {
    expect(shouldSendTools('llm-jp-3.1-8x13b-instruct4')).toBe(false)
  })
})

describe('isKnownToolCapable（実測済みtrueのみ）', () => {
  beforeEach(() => localStorage.clear())

  it('未確認のモデルは false（切替先の第一候補にはしない）', () => {
    expect(isKnownToolCapable('preview/Kimi-K2.7-Code')).toBe(false)
  })

  it('既知で対応(true)のモデルは true', () => {
    expect(isKnownToolCapable('preview/Kimi-K2.6')).toBe(true)
  })

  it('既知で非対応(false)のモデルは false', () => {
    expect(isKnownToolCapable('llm-jp-3.1-8x13b-instruct4')).toBe(false)
  })
})

describe('recordToolSupport ⇄ toolSupportOf（記録の往復）', () => {
  beforeEach(() => localStorage.clear())

  it('true を記録すると読み戻せる（未確認モデルが実測で対応と判明したケース）', () => {
    expect(toolSupportOf('preview/Kimi-K2.7-Code')).toBeNull()
    recordToolSupport('preview/Kimi-K2.7-Code', true)
    expect(toolSupportOf('preview/Kimi-K2.7-Code')).toBe(true)
    expect(shouldSendTools('preview/Kimi-K2.7-Code')).toBe(true)
    expect(isKnownToolCapable('preview/Kimi-K2.7-Code')).toBe(true)
  })

  it('false を記録すると読み戻せる（実測で400＝非対応と判明したケース）', () => {
    recordToolSupport('some-new-model', false)
    expect(toolSupportOf('some-new-model')).toBe(false)
    expect(shouldSendTools('some-new-model')).toBe(false)
    expect(isKnownToolCapable('some-new-model')).toBe(false)
  })

  it('上書き保存できる（記録済みの判定が後から覆るケース）', () => {
    recordToolSupport('flip-flop-model', false)
    expect(toolSupportOf('flip-flop-model')).toBe(false)
    recordToolSupport('flip-flop-model', true)
    expect(toolSupportOf('flip-flop-model')).toBe(true)
  })
})

describe('TTL（30日）', () => {
  beforeEach(() => localStorage.clear())

  it('TTL内の記録はそのまま使われる', () => {
    const now = Date.now()
    recordToolSupport('recent-model', true, now)
    expect(toolSupportOf('recent-model', now + TOOL_SUPPORT_TTL_MS - 1)).toBe(true)
  })

  it('31日前の記録は無視され、種またはnullに戻る', () => {
    const now = Date.now()
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000
    // 種に一致しないモデル名 → 期限切れ後は null に戻る
    recordToolSupport('stale-unknown-model', true, now - THIRTY_ONE_DAYS)
    expect(toolSupportOf('stale-unknown-model', now)).toBeNull()
    // 種(false)に一致するモデル名で、キャッシュがそれと矛盾するtrueだったケース → 期限切れ後は種のfalseに戻る
    recordToolSupport('llm-jp-3.1-8x13b-instruct4', true, now - THIRTY_ONE_DAYS)
    expect(toolSupportOf('llm-jp-3.1-8x13b-instruct4', now)).toBe(false)
  })
})

describe('readToolSupportStore（破損耐性）', () => {
  beforeEach(() => localStorage.clear())

  it('未保存なら空オブジェクト', () => {
    expect(readToolSupportStore()).toEqual({})
  })

  it('壊れたJSONでも例外を投げず空オブジェクトを返す', () => {
    localStorage.setItem(TOOL_SUPPORT_KEY, '{not valid json')
    expect(() => readToolSupportStore()).not.toThrow()
    expect(readToolSupportStore()).toEqual({})
  })

  it('想定外の形（配列や文字列）でも空オブジェクトを返す', () => {
    localStorage.setItem(TOOL_SUPPORT_KEY, JSON.stringify(['not', 'a', 'record']))
    expect(readToolSupportStore()).toEqual({})
    localStorage.setItem(TOOL_SUPPORT_KEY, JSON.stringify('just a string'))
    expect(readToolSupportStore()).toEqual({})
  })

  it('エントリの形が壊れていれば、そのモデルだけ無視する', () => {
    localStorage.setItem(TOOL_SUPPORT_KEY, JSON.stringify({
      'good-model': { supported: true, at: 1000 },
      'bad-model': { supported: 'yes', at: 1000 }, // supported が boolean でない
      'bad-model-2': { at: 1000 }, // supported 欠落
    }))
    const store = readToolSupportStore()
    expect(store['good-model']).toEqual({ supported: true, at: 1000 })
    expect(store['bad-model']).toBeUndefined()
    expect(store['bad-model-2']).toBeUndefined()
  })
})

describe('forgetToolSupport（消去）', () => {
  beforeEach(() => localStorage.clear())

  it('モデル指定で該当モデルだけ消える', () => {
    recordToolSupport('model-a', true)
    recordToolSupport('model-b', false)
    forgetToolSupport('model-a')
    expect(toolSupportOf('model-a')).toBeNull()
    expect(toolSupportOf('model-b')).toBe(false)
  })

  it('省略時は全消去される', () => {
    recordToolSupport('model-a', true)
    recordToolSupport('model-b', false)
    forgetToolSupport()
    expect(readToolSupportStore()).toEqual({})
    expect(toolSupportOf('model-a')).toBeNull()
  })
})
