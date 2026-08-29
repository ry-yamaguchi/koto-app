import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { defaultVisionModelFor } from '../src/main/chat/turnRunner'

// B'-3d-1a: 学習キャッシュ（ツール対応・画像対応）の持ち主が renderer の localStorage から
// main の src/main/learningStore.ts へ移った配線を固定する（tests/chatTurnRegistryWiring.test.ts
// と同じ readCode 流儀）。
//
// ⚠️ コメントを外してから判定する（2026-08-20 に自分の説明コメントにテストが当たって落ちた事故の
// 再発防止。他の readCode テストと同じ流儀）。当て先が他の行に出ないことは、この判定式を
// 書く前に `grep -n` で実際のソースを確認してある（掟10）。

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('turnRunner.ts: toolSupport.*/vision.* はもう bridge.ask ではない', () => {
  const src = readCode('src/main/chat/turnRunner.ts')

  it('bridge.ask(\'toolSupport / bridge.ask(\'vision が残っていない', () => {
    expect(src).not.toContain("bridge.ask('toolSupport")
    expect(src).not.toContain("bridge.ask('vision")
  })

  it('学習キャッシュを learningStore（main）+ shared/modelLearning（純関数）から直接呼んでいる', () => {
    expect(src).toContain("import { shouldSendTools, isKnownToolCapable, shouldTryImagesDirectly } from '../../shared/modelLearning'")
    expect(src).toContain("import { getLearning, recordLearning } from '../learningStore'")
    expect(src).toContain('shouldSendTools: (model) => shouldSendTools(getLearning().toolSupport, model)')
    expect(src).toContain('isKnownToolCapable: (model) => isKnownToolCapable(getLearning().toolSupport, model)')
    expect(src).toContain("record: (model, supported) => recordLearning('tool', model, supported)")
    expect(src).toContain('shouldTryDirect: (model) => shouldTryImagesDirectly(getLearning().visionSupport, model)')
    expect(src).toContain("record: (model, supported) => recordLearning('vision', model, supported)")
    expect(src).toContain('defaultModel: () => defaultVisionModelFor(payload.spec.models)')
  })
})

describe('renderer/toolSupport.ts・renderer/visionSupport.ts: localStorage を読み書きしていない', () => {
  for (const rel of ['src/renderer/toolSupport.ts', 'src/renderer/visionSupport.ts']) {
    it(`${rel} に localStorage が出てこない（main が唯一の持ち主）`, () => {
      const src = readCode(rel)
      expect(src).not.toContain('localStorage')
    })
  }
})

describe('shared/chatTurnRpc.ts: ASK_PATHS から toolSupport.*/vision.* が消えている', () => {
  const src = readCode('src/shared/chatTurnRpc.ts')

  it('6つの ask path 文字列がどれも残っていない', () => {
    expect(src).not.toContain("'toolSupport.shouldSendTools'")
    expect(src).not.toContain("'toolSupport.isKnownToolCapable'")
    expect(src).not.toContain("'toolSupport.record'")
    expect(src).not.toContain("'vision.shouldTryDirect'")
    expect(src).not.toContain("'vision.record'")
    expect(src).not.toContain("'vision.defaultModel'")
  })
})

describe('renderer/chatTurnBridge.ts: dispatchAsk に toolSupport.*/vision.* の case が無い', () => {
  const src = readCode('src/renderer/chatTurnBridge.ts')

  it("case 'toolSupport / case 'vision. が残っていない", () => {
    expect(src).not.toContain("case 'toolSupport")
    expect(src).not.toContain("case 'vision.")
  })
})

// defaultVisionModelFor: renderer/usage.ts の getDefaultVisionModel（29行目付近）と
// 同じアルゴリズムを main で複製したもの（今回 usage.ts 自体は触っていない）。
// usage.ts 側のこのアルゴリズムには元々テストが無かったため（tests/ 配下に
// getDefaultVisionModel の参照が無いことを確認済み）、main 側の複製はここで初めて検証する。
describe('turnRunner.ts: defaultVisionModelFor（renderer/usage.ts の getDefaultVisionModel と同じアルゴリズム）', () => {
  it('既定モデル（Qwen3-VL）が一覧にあれば、それを使う', () => {
    const models = [{ id: 'gpt-oss-120b' }, { id: 'preview/Qwen3-VL-30B-A3B-Instruct' }]
    expect(defaultVisionModelFor(models)).toBe('preview/Qwen3-VL-30B-A3B-Instruct')
  })

  it('★ 既定モデルは、一覧の並び順に関わらず最優先で選ばれる（find() の順序に頼っていない）', () => {
    // Phi-4 の方が先に並んでいても、既定モデル（Qwen3-VL）が一覧にあればそちらを使う。
    const models = [{ id: 'preview/Phi-4-multimodal-instruct' }, { id: 'preview/Qwen3-VL-30B-A3B-Instruct' }]
    expect(defaultVisionModelFor(models)).toBe('preview/Qwen3-VL-30B-A3B-Instruct')
  })

  it('既定モデルが無ければ、一覧から画像対応モデル（VISION_MODELS一致）を探す', () => {
    const models = [{ id: 'gpt-oss-120b' }, { id: 'preview/Phi-4-multimodal-instruct' }]
    expect(defaultVisionModelFor(models)).toBe('preview/Phi-4-multimodal-instruct')
  })

  it('VISION_MODELS一覧に無くても、命名パターン（-VL-/multimodal/kimi-k2.6）で見つける', () => {
    expect(defaultVisionModelFor([{ id: 'some-brand-new-VL-model' }])).toBe('some-brand-new-VL-model')
    expect(defaultVisionModelFor([{ id: 'preview/Kimi-K2.6' }])).toBe('preview/Kimi-K2.6')
  })

  it('一覧の並び順で最初に一致したものを使う', () => {
    const models = [{ id: 'first-multimodal' }, { id: 'second-multimodal' }]
    expect(defaultVisionModelFor(models)).toBe('first-multimodal')
  })

  it('画像対応モデルが1つも無ければ、既定モデル（一覧に無くても）にフォールバックする', () => {
    expect(defaultVisionModelFor([{ id: 'gpt-oss-120b' }, { id: 'llm-jp-3.1-8x13b-instruct4' }]))
      .toBe('preview/Qwen3-VL-30B-A3B-Instruct')
  })

  it('空の一覧でも既定モデルにフォールバックする', () => {
    expect(defaultVisionModelFor([])).toBe('preview/Qwen3-VL-30B-A3B-Instruct')
  })
})

describe('renderer/hooks/useAiChat.ts: main への ask 橋渡し（handlers）に学習系6項目が無い', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')

  it('toolSupportShouldSendTools 等の6プロパティが handlers に渡されていない', () => {
    for (const key of [
      'toolSupportShouldSendTools', 'toolSupportIsKnownToolCapable', 'toolSupportRecord',
      'visionShouldTryDirect', 'visionRecord', 'visionDefaultModel',
    ]) {
      expect(src).not.toContain(`${key}:`)
    }
  })

  it('buildPorts の toolSupport / vision メンバー自体は残っている（compactNow が使う）', () => {
    expect(src).toContain('toolSupport: {')
    expect(src).toContain('vision: {')
    expect(src).toContain('shouldTryDirect: shouldTryImagesDirectly,')
  })
})
