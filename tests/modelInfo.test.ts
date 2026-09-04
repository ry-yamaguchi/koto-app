import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { MODELS, VISION_MODELS, DEFAULT_MODEL, pickBestModel, SYSTEM_ROLE_UNSUPPORTED, foldSystemForModel } from '../src/shared/modelInfo'

// 2026-09-04 世代交代の回帰テスト（Qwen3-Coder 系の提供終了に伴う一括更新）。
// 根拠: check:models 実測で Qwen3-Coder-480B-A35B-Instruct-FP8 / Qwen3-Coder-30B-A3B-Instruct が
// 提供終了（480B は実 API で「This model is not available」を確認）。
// probe-models 実測（Ryosuke 実行）: tools 対応 = Kimi-K2.7-Code / Qwen3.6-35B-A3B / gemma-4-31B-it。
// tools 非対応(400) = Phi-4-mini-instruct-cpu / Qwen3-0.6B-cpu。

describe('MODELS / VISION_MODELS / DEFAULT_MODEL（2026-09-04 世代交代）', () => {
  it('MODELS は8件、Qwen3-Coder系（旧世代）は含まれない', () => {
    expect(MODELS).toEqual([
      { id: 'preview/Kimi-K2.7-Code', label: 'Kimi K2.7 Code（プレビュー）' },
      { id: 'preview/Qwen3.6-35B-A3B', label: 'Qwen3.6 35B（プレビュー）' },
      { id: 'preview/gemma-4-31B-it', label: 'Gemma 4 31B（プレビュー）' },
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
      { id: 'llm-jp-3.1-8x13b-instruct4', label: 'llm-jp 3.1 8x13b（日本語）' },
      { id: 'preview/Kimi-K2.6', label: 'Kimi K2.6（プレビュー）' },
      { id: 'preview/Qwen3-0.6B-cpu', label: 'Qwen3 0.6B（CPU・プレビュー）' },
      { id: 'preview/Phi-4-mini-instruct-cpu', label: 'Phi-4 mini（CPU・プレビュー）' },
    ])
  })

  // ── 弱め禁止: 旧モデルIDが残っていないことを not.toContain で明示的に禁じる ─────
  it('★ 提供終了した Qwen3-Coder 系のIDが1つも残っていない', () => {
    const ids = MODELS.map(m => m.id)
    expect(ids).not.toContain('Qwen3-Coder-480B-A35B-Instruct-FP8')
    expect(ids).not.toContain('Qwen3-Coder-30B-A3B-Instruct')
    for (const id of ids) expect(id).not.toMatch(/qwen3-coder/i)
  })

  it('VISION_MODELS から提供終了した preview/Phi-4-multimodal-instruct が消えている（Qwen3-VL は残る）', () => {
    const ids = VISION_MODELS.map(m => m.id)
    expect(ids).not.toContain('preview/Phi-4-multimodal-instruct')
    expect(ids).toContain('preview/Qwen3-VL-30B-A3B-Instruct')
  })

  it('DEFAULT_MODEL は preview/Kimi-K2.7-Code（実測で tools ok のコード系）', () => {
    expect(DEFAULT_MODEL).toBe('preview/Kimi-K2.7-Code')
  })
})

describe('pickBestModel（フォールバック連鎖の2026-09-04見直し）', () => {
  it('① Kimi-K2.7-Code があれば最優先で選ぶ', () => {
    const ids = ['gpt-oss-120b', 'preview/Qwen3.6-35B-A3B', 'preview/Kimi-K2.7-Code']
    expect(pickBestModel(ids)).toBe('preview/Kimi-K2.7-Code')
  })

  it('② Kimi-K2.7-Code が無く coder 系があれば、それを選ぶ', () => {
    const ids = ['gpt-oss-120b', 'some-vendor-Coder-30B']
    expect(pickBestModel(ids)).toBe('some-vendor-Coder-30B')
  })

  it('③ qwen3 系のうち -cpu（小型CPU版）と VL（画像用）は選ばない（0.6B が既定に選ばれる事故を防ぐ）', () => {
    const ids = ['preview/Qwen3-0.6B-cpu', 'preview/Qwen3-VL-30B-A3B-Instruct', 'preview/Qwen3.6-35B-A3B']
    expect(pickBestModel(ids)).toBe('preview/Qwen3.6-35B-A3B')
  })

  it('④ どれにも一致しなければ一覧の先頭を選ぶ', () => {
    const ids = ['gpt-oss-120b', 'llm-jp-3.1-8x13b-instruct4']
    expect(pickBestModel(ids)).toBe('gpt-oss-120b')
  })

  it('一覧が空なら DEFAULT_MODEL を返す', () => {
    expect(pickBestModel([])).toBe(DEFAULT_MODEL)
  })
})

// ── roadmap #21: system が捨てられるモデルへの畳み込み（2026-09-04 実測で確定）──────────
// llm-jp の証跡は SYSTEM_ROLE_UNSUPPORTED のコメント参照（にゃテスト＋対の user ロール検証）。
describe('foldSystemForModel（#21・system の user 畳み込み）', () => {
  const sys = { role: 'system', content: '境界ガードの指示' }
  const user = { role: 'user', content: 'こんにちは' }

  it('SYSTEM_ROLE_UNSUPPORTED に llm-jp が入っている（実測の根拠つき）', () => {
    expect(SYSTEM_ROLE_UNSUPPORTED).toContain('llm-jp-3.1-8x13b-instruct4')
  })

  it('対象モデル: 先頭 system が「user（指示）→ assistant（了解）」の往復になり、後続は保たれる', () => {
    const out = foldSystemForModel('llm-jp-3.1-8x13b-instruct4', [sys, user])
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[0].content).toContain('境界ガードの指示')
    expect(out[0].content).toContain('Koto からの実行指示')
    expect(out[2]).toBe(user) // 後続メッセージは同一参照のまま（作り替えない）
  })

  it('対象外のモデル: 渡した配列をそのまま返す（複製もしない）', () => {
    const msgs = [sys, user]
    expect(foldSystemForModel('gpt-oss-120b', msgs)).toBe(msgs)
  })

  it('対象モデルでも system が無ければそのまま返す', () => {
    const msgs = [user]
    expect(foldSystemForModel('llm-jp-3.1-8x13b-instruct4', msgs)).toBe(msgs)
  })

  it('防御: 2つ目以降の system も user へ変換して落とさない（了解の相槌は最初の1回だけ）', () => {
    const out = foldSystemForModel('llm-jp-3.1-8x13b-instruct4', [sys, user, { role: 'system', content: '追加指示' }])
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(out[3].content).toContain('追加指示')
  })
})

describe('配線: main/sakura/engine.ts が畳み込みを両方の口で通している（掟10・呼び出しの形ごと）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/sakura/engine.ts'), 'utf-8')

  it('runSakuraChat / runSakuraStream の両方に foldSystemForModel(args.model, args.messages) がある', () => {
    expect(src).toContain("import { foldSystemForModel } from '../../shared/modelInfo'")
    const count = src.split('foldSystemForModel(args.model, args.messages)').length - 1
    expect(count).toBe(2)
    // 畳み込んだ結果を使わず素の args.messages を送る旧形へ戻っていない
    expect(src).not.toContain('messages: args.messages as any')
  })
})
