import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  visionSupportOf, shouldTryImagesDirectly, recordVisionSupport, forgetVisionSupport,
  isImageUnsupportedError, VISION_SUPPORT_TTL_MS,
} from '../src/renderer/visionSupport'

// ── 2026-08-19 Ryosuke 提案 ─────────────────────────────────────────
// 「全体を他のモデルにすることは出来ないのか？　以前のように、初めての場合、
//   現在のモデルで出来るか確認し出来るなら記録してそのまま処理をする」
//
// 名前の一覧で決め打ちすると、**一覧に載っていない対応モデルは永久に二段構え**に
// なる（1回分よけいに時間と費用がかかる）。ツール対応（toolSupport.ts）で既に
// 解いてある問題なので、同じ形にする。

// localStorage の代わり（vitest は node 環境）
const mem: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
}

beforeEach(() => forgetVisionSupport())

describe('未確認のモデルは、まずそのまま試す', () => {
  it('★ 未確認は null（決めつけない）', () => {
    expect(visionSupportOf('preview/Kimi-K2.7-Code')).toBeNull()
  })

  it('★ 未確認でも、画像はそのまま渡して試す', () => {
    expect(shouldTryImagesDirectly('preview/Kimi-K2.7-Code')).toBe(true)
  })

  it('実測で確定しているものは、最初から対応として扱う', () => {
    expect(visionSupportOf('preview/Qwen3-VL-30B-A3B-Instruct')).toBe(true)
    expect(visionSupportOf('preview/Phi-4-multimodal-instruct')).toBe(true)
  })
})

describe('試した結果を覚える', () => {
  it('対応と分かれば、次からそのまま渡す', () => {
    recordVisionSupport('modelA', true)
    expect(visionSupportOf('modelA')).toBe(true)
    expect(shouldTryImagesDirectly('modelA')).toBe(true)
  })

  it('★ 非対応と分かれば、次からは二段構えにする', () => {
    recordVisionSupport('modelB', false)
    expect(shouldTryImagesDirectly('modelB')).toBe(false)
  })

  it('古い記録は捨てて、確かめ直す（さくら側で変わることがある）', () => {
    const old = Date.now() - VISION_SUPPORT_TTL_MS - 1000
    recordVisionSupport('modelC', false, old)
    expect(visionSupportOf('modelC')).toBeNull()
  })

  it('壊れた記録でも落ちない', () => {
    ;(globalThis as any).localStorage.setItem('sakura_model_vision_support', 'こわれている')
    expect(visionSupportOf('modelD')).toBeNull()
  })
})

describe('サーバーの返事を見分ける', () => {
  it('画像を受け付けないという返事は見分ける', () => {
    expect(isImageUnsupportedError('400 this model does not support image input')).toBe(true)
    expect(isImageUnsupportedError('invalid content type: image_url')).toBe(true)
  })

  it('★ 混雑や通信の失敗を「非対応」と決めつけない', () => {
    // ここで記録してしまうと、**対応しているモデルが二段構えのまま固定される**
    expect(isImageUnsupportedError('429 Too Many Requests')).toBe(false)
    expect(isImageUnsupportedError('503 Service Unavailable')).toBe(false)
    expect(isImageUnsupportedError('network timeout')).toBe(false)
    // ★ ここが本当に危ない形: **両方の言葉が入っている**返事。
    //   混雑を「非対応」と記録すると、対応しているモデルが二段構えのまま固定される
    expect(isImageUnsupportedError('503 Service Unavailable: image service is busy')).toBe(false)
    expect(isImageUnsupportedError('429 rate limited on vision endpoint')).toBe(false)
  })

  it('関係のないエラーは見分けない', () => {
    expect(isImageUnsupportedError('401 Unauthorized')).toBe(false)
    expect(isImageUnsupportedError('')).toBe(false)
  })
})

// ── 配線（判断だけ正しくても、実際に試されなければ意味がない）──────────────
describe('まず今のモデルで試す配線', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')
  const chat = read('src/renderer/hooks/useAiChat.ts')

  it('★ 名前の一覧ではなく、学習した記録で決める', () => {
    expect(chat).toMatch(/needsVisionHandoff = hasImages && !shouldTryImagesDirectly\(model\)/)
  })

  it('★ 受け取れなかったら記録して、その場は視覚モデルへ回す', () => {
    expect(chat).toMatch(/isImageUnsupportedError[\s\S]{0,200}recordVisionSupport\(useModel, false\)/)
    expect(chat).toContain('次からは最初からそうします')
  })

  it('★ 通ったら「対応」と記録する（次から二段構えを挟まない）', () => {
    expect(chat).toMatch(/recordVisionSupport\(useModel, true\)/)
  })

  it('説明も、いまのモデルで扱えるかどうかで出し分ける', () => {
    const panel = read('src/renderer/components/ChatPanel.tsx')
    expect(panel).toContain('shouldTryImagesDirectly(model)')
    expect(panel).toContain('は画像を扱えないため')
  })
})
