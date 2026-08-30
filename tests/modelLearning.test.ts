import { describe, it, expect } from 'vitest'
import {
  TOOL_SUPPORT_TTL_MS, VISION_SUPPORT_TTL_MS,
  toolSupportOf, shouldSendTools, isKnownToolCapable,
  visionSupportOf, shouldTryImagesDirectly,
  sanitizeStore,
  type LearnStore,
} from '../src/shared/modelLearning'

// B'-3d-1a: renderer/toolSupport.ts・renderer/visionSupport.ts にあった判定ロジックを、
// store を引数に取る純関数として src/shared/modelLearning.ts へ移した（振る舞い不変）。
// このファイルは旧 tests/toolSupport.test.ts・tests/visionSupport.test.ts の純ロジック部分を
// 「store を明示的に組み立てて渡す」形へ書き換えて移植したもの（localStorage は登場しない）。

// ── ツール（Function Calling）対応 ─────────────────────────────────────
// 背景（2026-07-30）: 旧 aiTools.ts の判定関数はモデル名の正規表現によるハードコードで、
// 新モデル preview/Kimi-K2.7-Code が「preview/」「kimi」に一致して非対応と誤判定され、
// 実際はツール対応なのに毎回「ツールが必要なため古いモデルに切り替えます」と表示されていた。
// 本テストは「未確認のモデルは null（楽観的に送る）」という修正後の挙動の回帰テスト。

describe('toolSupportOf（実測の種＋TTL付きキャッシュ）', () => {
  const empty: LearnStore = {}

  it('種: preview/Kimi-K2.6 は実測でツール対応(true)', () => {
    expect(toolSupportOf(empty, 'preview/Kimi-K2.6')).toBe(true)
  })

  it('種: llm-jp系は実測で非対応(false)', () => {
    expect(toolSupportOf(empty, 'llm-jp-3.1-8x13b-instruct4')).toBe(false)
  })

  it('回帰: preview/Kimi-K2.7-Code は種に含まれず未確認(null)（今回の不具合の原因だった誤判定の修正確認）', () => {
    expect(toolSupportOf(empty, 'preview/Kimi-K2.7-Code')).toBeNull()
  })

  it('旧ブロックリストにあった preview/・vision系・gpt-oss（120b以外）も、種から外れたため未確認(null)', () => {
    expect(toolSupportOf(empty, 'preview/Qwen3-VL-30B-A3B-Instruct')).toBeNull()
    expect(toolSupportOf(empty, 'preview/Phi-4-multimodal-instruct')).toBeNull()
    expect(toolSupportOf(empty, 'gpt-oss-20b')).toBeNull()
  })

  it('未知のモデル名は未確認(null)', () => {
    expect(toolSupportOf(empty, 'some-brand-new-model')).toBeNull()
  })
})

describe('shouldSendTools（未確認は楽観的に送る）', () => {
  const empty: LearnStore = {}

  it('未確認のモデルは true（ツールを送って試す）', () => {
    expect(shouldSendTools(empty, 'preview/Kimi-K2.7-Code')).toBe(true)
  })

  it('既知で対応(true)のモデルは true', () => {
    expect(shouldSendTools(empty, 'preview/Kimi-K2.6')).toBe(true)
  })

  it('既知で非対応(false)のモデルは false', () => {
    expect(shouldSendTools(empty, 'llm-jp-3.1-8x13b-instruct4')).toBe(false)
  })
})

describe('isKnownToolCapable（実測済みtrueのみ）', () => {
  const empty: LearnStore = {}

  it('未確認のモデルは false（切替先の第一候補にはしない）', () => {
    expect(isKnownToolCapable(empty, 'preview/Kimi-K2.7-Code')).toBe(false)
  })

  it('既知で対応(true)のモデルは true', () => {
    expect(isKnownToolCapable(empty, 'preview/Kimi-K2.6')).toBe(true)
  })

  it('既知で非対応(false)のモデルは false', () => {
    expect(isKnownToolCapable(empty, 'llm-jp-3.1-8x13b-instruct4')).toBe(false)
  })
})

describe('toolSupportOf: 記録との往復', () => {
  it('true の記録が読み戻せる（未確認モデルが実測で対応と判明したケース）', () => {
    const store: LearnStore = {}
    expect(toolSupportOf(store, 'preview/Kimi-K2.7-Code')).toBeNull()
    store['preview/Kimi-K2.7-Code'] = { supported: true, at: Date.now() }
    expect(toolSupportOf(store, 'preview/Kimi-K2.7-Code')).toBe(true)
    expect(shouldSendTools(store, 'preview/Kimi-K2.7-Code')).toBe(true)
    expect(isKnownToolCapable(store, 'preview/Kimi-K2.7-Code')).toBe(true)
  })

  it('false の記録が読み戻せる（実測で400＝非対応と判明したケース）', () => {
    const store: LearnStore = { 'some-new-model': { supported: false, at: Date.now() } }
    expect(toolSupportOf(store, 'some-new-model')).toBe(false)
    expect(shouldSendTools(store, 'some-new-model')).toBe(false)
    expect(isKnownToolCapable(store, 'some-new-model')).toBe(false)
  })

  it('上書きできる（記録済みの判定が後から覆るケース）', () => {
    const store: LearnStore = { 'flip-flop-model': { supported: false, at: Date.now() } }
    expect(toolSupportOf(store, 'flip-flop-model')).toBe(false)
    store['flip-flop-model'] = { supported: true, at: Date.now() }
    expect(toolSupportOf(store, 'flip-flop-model')).toBe(true)
  })
})

describe('ツール対応: TTL（30日）', () => {
  it('TTL内の記録はそのまま使われる', () => {
    const now = Date.now()
    const store: LearnStore = { 'recent-model': { supported: true, at: now } }
    expect(toolSupportOf(store, 'recent-model', now + TOOL_SUPPORT_TTL_MS - 1)).toBe(true)
  })

  it('31日前の記録は無視され、種またはnullに戻る', () => {
    const now = Date.now()
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000
    const store: LearnStore = {
      // 種に一致しないモデル名 → 期限切れ後は null に戻る
      'stale-unknown-model': { supported: true, at: now - THIRTY_ONE_DAYS },
      // 種(false)に一致するモデル名で、キャッシュがそれと矛盾するtrueだったケース → 期限切れ後は種のfalseに戻る
      'llm-jp-3.1-8x13b-instruct4': { supported: true, at: now - THIRTY_ONE_DAYS },
    }
    expect(toolSupportOf(store, 'stale-unknown-model', now)).toBeNull()
    expect(toolSupportOf(store, 'llm-jp-3.1-8x13b-instruct4', now)).toBe(false)
  })
})

// ── 画像入力の対応 ───────────────────────────────────────────────
// ── 2026-08-19 Ryosuke 提案 ─────────────────────────────────────────
// 「全体を他のモデルにすることは出来ないのか？　以前のように、初めての場合、
//   現在のモデルで出来るか確認し出来るなら記録してそのまま処理をする」
// 名前の一覧で決め打ちすると、一覧に載っていない対応モデルは永久に二段構えになる
// （1回分よけいに時間と費用がかかる）。ツール対応で解いてある問題と同じ形にする。

describe('visionSupportOf: 未確認のモデルは、まずそのまま試す', () => {
  const empty: LearnStore = {}

  it('★ 未確認は null（決めつけない）', () => {
    expect(visionSupportOf(empty, 'preview/Kimi-K2.7-Code')).toBeNull()
  })

  it('★ 未確認でも、画像はそのまま渡して試す', () => {
    expect(shouldTryImagesDirectly(empty, 'preview/Kimi-K2.7-Code')).toBe(true)
  })

  it('実測で確定しているものは、最初から対応として扱う', () => {
    expect(visionSupportOf(empty, 'preview/Qwen3-VL-30B-A3B-Instruct')).toBe(true)
    expect(visionSupportOf(empty, 'preview/Phi-4-multimodal-instruct')).toBe(true)
  })
})

describe('visionSupportOf: 試した結果を覚える（記録との往復）', () => {
  it('対応と分かれば、次からそのまま渡す', () => {
    const store: LearnStore = { modelA: { supported: true, at: Date.now() } }
    expect(visionSupportOf(store, 'modelA')).toBe(true)
    expect(shouldTryImagesDirectly(store, 'modelA')).toBe(true)
  })

  it('★ 非対応と分かれば、次からは二段構えにする', () => {
    const store: LearnStore = { modelB: { supported: false, at: Date.now() } }
    expect(shouldTryImagesDirectly(store, 'modelB')).toBe(false)
  })

  it('古い記録は捨てて、確かめ直す（さくら側で変わることがある）', () => {
    const old = Date.now() - VISION_SUPPORT_TTL_MS - 1000
    const store: LearnStore = { modelC: { supported: false, at: old } }
    expect(visionSupportOf(store, 'modelC')).toBeNull()
  })
})

// ── 検証（tool/vision共通・sanitizeStore）──────────────────────────────
// 旧 readToolSupportStore・readVisionSupportStore（localStorage を直接読んでいた）にあった
// 検証部を共通化したもの。main の learningStore.ts（ファイルから読む）・renderer の
// learningMirror.ts（IPC/旧localStorageの中身を受け取る）の両方がここを通す。

describe('sanitizeStore（破損耐性）', () => {
  it('undefined・null は空オブジェクト', () => {
    expect(sanitizeStore(undefined)).toEqual({})
    expect(sanitizeStore(null)).toEqual({})
  })

  it('想定外の形（配列や文字列・数値）でも空オブジェクトを返す', () => {
    expect(sanitizeStore(['not', 'a', 'record'])).toEqual({})
    expect(sanitizeStore('just a string')).toEqual({})
    expect(sanitizeStore(42)).toEqual({})
  })

  it('例外を投げない（壊れたJSONをparseした結果を渡しても）', () => {
    expect(() => sanitizeStore(JSON.parse('{"a": 1}'))).not.toThrow()
  })

  it('エントリの形が壊れていれば、そのモデルだけ無視する', () => {
    const out = sanitizeStore({
      'good-model': { supported: true, at: 1000 },
      'bad-model': { supported: 'yes', at: 1000 }, // supported が boolean でない
      'bad-model-2': { at: 1000 }, // supported 欠落
      'bad-model-3': { supported: true }, // at 欠落
      'bad-model-4': null, // エントリ自体が無い
    })
    expect(out).toEqual({ 'good-model': { supported: true, at: 1000 } })
  })

  it('サニタイズ後の store をそのまま toolSupportOf/visionSupportOf に渡せる', () => {
    const store = sanitizeStore({ 'preview/Kimi-K2.7-Code': { supported: true, at: Date.now() } })
    expect(toolSupportOf(store, 'preview/Kimi-K2.7-Code')).toBe(true)
  })

  // ── プロトタイプ汚染の芽を摘む（2026-08-30 セキュリティ点検）───────────────
  // learning.json / 移行ペイロードは外部由来ではないが、入力パースの関門では安全側に倒す。
  // `out['__proto__'] = {...}` は out 自身の prototype を差し替えるため、危険なキーは弾く。
  it('__proto__ / constructor / prototype をキーにしたエントリは取り込まない', () => {
    const out = sanitizeStore({
      '__proto__': { supported: true, at: 1000 },
      'constructor': { supported: true, at: 1000 },
      'prototype': { supported: true, at: 1000 },
      'safe-model': { supported: true, at: 1000 },
    })
    expect(out).toEqual({ 'safe-model': { supported: true, at: 1000 } })
    // out の prototype が差し替わっていない（素の Object.prototype のまま）
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(('supported' in out) && (out as any).supported).toBeFalsy()
  })
})
