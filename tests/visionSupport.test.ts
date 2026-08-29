import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  VISION_SUPPORT_KEY, VISION_SUPPORT_TTL_MS,
  visionSupportOf, shouldTryImagesDirectly, recordVisionSupport, forgetVisionSupport,
  isImageUnsupportedError,
} from '../src/renderer/visionSupport'
import { resetLearningMirrorForTest, setMirrorEntry } from '../src/renderer/learningMirror'

// ── 2026-08-19 Ryosuke 提案 ─────────────────────────────────────────
// 「全体を他のモデルにすることは出来ないのか？　以前のように、初めての場合、
//   現在のモデルで出来るか確認し出来るなら記録してそのまま処理をする」
//
// 名前の一覧で決め打ちすると、**一覧に載っていない対応モデルは永久に二段構え**に
// なる（1回分よけいに時間と費用がかかる）。ツール対応（toolSupport.ts）で既に
// 解いてある問題なので、同じ形にする。
//
// B'-3d-1a: 学習キャッシュ（画像対応）の持ち主が main（src/main/learningStore.ts）へ移った。
// visionSupport.ts は、その写し（src/renderer/learningMirror.ts）を読み書きする薄い層になった
// （localStorage はもう読み書きしない）。判定ロジック自体（種・TTL）の回帰テストは
// tests/modelLearning.test.ts（src/shared/modelLearning.ts の純関数）へ移した。

beforeEach(() => {
  resetLearningMirrorForTest()
})
afterEach(() => {
  delete (globalThis as any).window
})

describe('公開API（キー・TTL）の値は変えていない', () => {
  it('VISION_SUPPORT_KEY', () => {
    expect(VISION_SUPPORT_KEY).toBe('sakura_model_vision_support')
  })
  it('VISION_SUPPORT_TTL_MS（30日）', () => {
    expect(VISION_SUPPORT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })
})

describe('未確認のモデルは、まずそのまま試す（ミラー経由）', () => {
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

describe('ミラーに入れた記録を読み戻せる（main からの learning:changed を想定した setMirrorEntry）', () => {
  it('対応と分かれば、次からそのまま渡す', () => {
    setMirrorEntry('vision', 'modelA', true, Date.now())
    expect(visionSupportOf('modelA')).toBe(true)
    expect(shouldTryImagesDirectly('modelA')).toBe(true)
  })

  it('★ 非対応と分かれば、次からは二段構えにする', () => {
    setMirrorEntry('vision', 'modelB', false, Date.now())
    expect(shouldTryImagesDirectly('modelB')).toBe(false)
  })

  it('古い記録は捨てて、確かめ直す（さくら側で変わることがある）', () => {
    const old = Date.now() - VISION_SUPPORT_TTL_MS - 1000
    setMirrorEntry('vision', 'modelC', false, old)
    expect(visionSupportOf('modelC')).toBeNull()
  })
})

describe('recordVisionSupport: ミラーを楽観更新してから main へ fire-and-forget で送る', () => {
  it('window（electronAPI）が無い環境でもミラー更新は行われ、例外を投げない', () => {
    expect(() => recordVisionSupport('modelA', true, 1000)).not.toThrow()
    expect(visionSupportOf('modelA', 1000)).toBe(true)
  })

  it('空文字のモデル名は無視する（元の実装と同じガード）', () => {
    const record = vi.fn()
    ;(globalThis as any).window = { electronAPI: { learning: { record } } }
    recordVisionSupport('', true)
    expect(record).not.toHaveBeenCalled()
  })

  it('window.electronAPI.learning.record が (kind, model, supported) で呼ばれる', () => {
    const record = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = { electronAPI: { learning: { record } } }
    recordVisionSupport('modelB', false, 2000)
    expect(record).toHaveBeenCalledWith('vision', 'modelB', false)
    expect(visionSupportOf('modelB', 2000)).toBe(false) // 楽観更新済み
  })

  it('IPC が失敗しても例外は外へ出ない', async () => {
    const record = vi.fn().mockRejectedValue(new Error('boom'))
    ;(globalThis as any).window = { electronAPI: { learning: { record } } }
    expect(() => recordVisionSupport('modelC', true)).not.toThrow()
    await new Promise((r) => setImmediate(r))
  })
})

describe('forgetVisionSupport: ミラーから消し、main へ fire-and-forget で送る', () => {
  it('モデル指定で該当モデルだけ消える', () => {
    setMirrorEntry('vision', 'modelA', true, Date.now())
    setMirrorEntry('vision', 'modelB', false, Date.now())
    forgetVisionSupport('modelA')
    expect(visionSupportOf('modelA')).toBeNull()
    expect(visionSupportOf('modelB')).toBe(false)
  })

  it('省略時は全消去される', () => {
    setMirrorEntry('vision', 'modelA', true, Date.now())
    forgetVisionSupport()
    expect(visionSupportOf('modelA')).toBeNull()
  })

  it('window.electronAPI.learning.forget が (kind, model) で呼ばれる', () => {
    const forget = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as any).window = { electronAPI: { learning: { forget } } }
    forgetVisionSupport('modelA')
    expect(forget).toHaveBeenCalledWith('vision', 'modelA')
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
  // B'-3a（2026-08-28）: この判定・エージェントループ本体は src/shared/chatTurn.ts へ移った
  // （ports.vision.shouldTryDirect / ports.vision.record 経由で同じ実体を呼ぶ）。
  const chatTurn = read('src/shared/chatTurn.ts')

  it('★ 名前の一覧ではなく、学習した記録で決める', () => {
    // B'-3b: ports.vision.shouldTryDirect が非同期にもなり得る形（T | Promise<T>）になったため
    // await が付いた（実装の判断はそのまま。読み取り方が変わっただけ）。
    expect(chatTurn).toMatch(/needsVisionHandoff = hasImages && !\(await ports\.vision\.shouldTryDirect\(model\)\)/)
  })

  it('★ 受け取れなかったら記録して、その場は視覚モデルへ回す', () => {
    expect(chatTurn).toMatch(/isImageUnsupportedError[\s\S]{0,200}vision\.record\(useModel, false\)/)
    expect(chatTurn).toContain('次からは最初からそうします')
  })

  it('★ 通ったら「対応」と記録する（次から二段構えを挟まない）', () => {
    expect(chatTurn).toMatch(/vision\.record\(useModel, true\)/)
  })

  it('説明も、いまのモデルで扱えるかどうかで出し分ける', () => {
    const panel = read('src/renderer/components/ChatPanel.tsx')
    expect(panel).toContain('shouldTryImagesDirectly(model)')
    expect(panel).toContain('は画像を扱えないため')
  })
})
