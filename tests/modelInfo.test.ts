import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  MODELS, VISION_MODELS, DEFAULT_MODEL, pickBestModel, SYSTEM_ROLE_UNSUPPORTED, foldSystemForModel,
  MODEL_PURPOSE, purposeLabel, orderModelsForPicker, modelPickerText, modelLabel,
} from '../src/shared/modelInfo'
import ModelSelect, { pickerTooltip } from '../src/renderer/components/ModelSelect'
import { CLAUDE_MODELS } from '../src/renderer/claudeMode'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

// ── UX-A・判断1（2026-09-11 利用者目線レビュー推奨①）: モデル選択を目的ベースのラベルに ──────
// 技術名（preview/Kimi-K2.7-Code 等）が3画面にそのまま並んでいたのを、目的ベースの短い文へ。
// 根拠は README「モデルごとの対応状況」表（2026-09-10 実測）と MODELS/VISION_MODELS の各コメント。
describe('purposeLabel（表示の元は MODEL_PURPOSE の1箇所だけ）', () => {
  it('MODEL_PURPOSE にある9モデルすべてで、README根拠どおりの目的ラベルを返す', () => {
    expect(purposeLabel('preview/Kimi-K2.7-Code')).toBe('標準（おすすめ・コードが得意）')
    expect(purposeLabel('preview/gemma-4-31B-it')).toBe('高速・軽い（相談向け）')
    expect(purposeLabel('gpt-oss-120b')).toBe('推論型')
    expect(purposeLabel('preview/Qwen3.6-35B-A3B')).toBe('推論型（長い応答は途中で切れることあり）')
    expect(purposeLabel('preview/Kimi-K2.6')).toBe('画像も読める（推論型）')
    expect(purposeLabel('preview/Qwen3-VL-30B-A3B-Instruct')).toBe('画像読み取り用（ツール非対応）')
    expect(purposeLabel('llm-jp-3.1-8x13b-instruct4')).toBe('日本語特化（ツール非対応・文脈を無視することあり）')
    expect(purposeLabel('preview/Qwen3-0.6B-cpu')).toBe('小型（ツール非対応）')
    expect(purposeLabel('preview/Phi-4-mini-instruct-cpu')).toBe('小型（ツール非対応）')
  })

  it('MODELS・VISION_MODELS の全idが MODEL_PURPOSE でカバーされている（載せ忘れがない）', () => {
    const ids = [...MODELS, ...VISION_MODELS].map(m => m.id)
    for (const id of ids) expect(MODEL_PURPOSE[id], `MODEL_PURPOSE に ${id} が無い`).toBeDefined()
  })

  // ★ 変異試験(a): 「未知の id にも目的を付ける」（推測で目的を付ける）バグを検知する砦。
  it('★ 表に無い未知の id は、推測で目的を付けず技術名（modelLabel）のまま返す', () => {
    // MODELS/VISION_MODELS にも無い、まったく未知の id → modelLabel が id をそのまま返す
    expect(purposeLabel('some-brand-new-model-2027')).toBe('some-brand-new-model-2027')
    // 対照: MODEL_PURPOSE にある既知の id は、技術名ではなく目的ラベルを返す（id そのままにならない）
    expect(purposeLabel('preview/Kimi-K2.7-Code')).not.toBe('preview/Kimi-K2.7-Code')
  })
})

// ── UX-A2（2026-09-15 Ryosuke さん実機判断）: 表示を逆に。見える文字はモデル名、目的の説明はマウスオーバー ──
describe('modelPickerText（見える文字＝モデル名・説明＝目的。表示の元はここ1つ）', () => {
  it('表にある id → name はモデル名（modelLabel）、description は目的ラベル（purposeLabel）', () => {
    expect(modelPickerText('preview/Kimi-K2.7-Code')).toEqual({
      name: 'Kimi K2.7 Code（プレビュー）',
      description: '標準（おすすめ・コードが得意）',
    })
    expect(modelPickerText('preview/gemma-4-31B-it')).toEqual({
      name: 'Gemma 4 31B（プレビュー）',
      description: '高速・軽い（相談向け）',
    })
    expect(modelPickerText('preview/Qwen3-VL-30B-A3B-Instruct')).toEqual({
      name: 'Qwen3-VL 30B（画像対応・プレビュー）',
      description: '画像読み取り用（ツール非対応）',
    })
    expect(modelPickerText('gpt-oss-120b')).toEqual({ name: 'GPT-OSS 120B', description: '推論型' })
  })

  it('MODEL_PURPOSE にある全モデルで name=modelLabel・description=purposeLabel、かつ name と description が同じ文にならない（二重に出さない）', () => {
    for (const id of Object.keys(MODEL_PURPOSE)) {
      const t = modelPickerText(id)
      expect(t.name, id).toBe(modelLabel(id))
      expect(t.description, id).toBe(purposeLabel(id))
      expect(t.description, id).not.toBe('')
      expect(t.description, id).not.toBe(t.name)
    }
  })

  // ★ 変異試験(c): 「未知の id で description に name（or 技術名）を返す」バグを検知する砦。
  it('★ 表に無い未知の id → name は id そのまま・description は空（推測しない。name を二重に出さない）', () => {
    const t = modelPickerText('some-brand-new-model-2027')
    expect(t.name).toBe('some-brand-new-model-2027')
    expect(t.description).toBe('')
    // 直す前の形（purposeLabel は未知の id に技術名を返す）に戻っていない
    expect(t.description).not.toBe(purposeLabel('some-brand-new-model-2027'))
  })

  // ── 2026-09-15 検分で発覚: Claude 頭脳モードの一覧（claudeMode.ts の label）は さくらの表に無いため、
  //    name=modelLabel(id) だけでは「claude-sonnet-5」のような技術 id が見えていた（v0.6.18 から）。
  //    一覧が持つ label を第2引数で渡せるようにし、渡されればそれを name にする。
  it('Claude 一覧の label を渡せば name はその label（技術 id を見せない）・description は空（表に無いので推測しない）', () => {
    expect(CLAUDE_MODELS.length).toBeGreaterThan(0)
    for (const m of CLAUDE_MODELS) {
      const t = modelPickerText(m.id, m.label)
      expect(t.name, m.id).toBe(m.label)
      expect(t.name, m.id).not.toBe(m.id)
      expect(t.description, m.id).toBe('')
    }
    // ライブ取得で表に無い新モデル（label は API の displayName）も同じ
    expect(modelPickerText('claude-new-model', 'Claude New Model')).toEqual({ name: 'Claude New Model', description: '' })
  })

  it('★ label を渡さない Claude の id は技術 id のまま（＝渡し忘れると劣化が再発する。配線テストで渡す形を固定）', () => {
    expect(modelPickerText('claude-sonnet-5').name).toBe('claude-sonnet-5')
    expect(modelPickerText('claude-sonnet-5', 'Claude Sonnet 5（バランス）').name).toBe('Claude Sonnet 5（バランス）')
  })

  it('さくらの一覧の label（useModels は modelLabel(id) を label にする）を渡しても、渡さない場合と同じ結果', () => {
    for (const id of Object.keys(MODEL_PURPOSE)) {
      expect(modelPickerText(id, modelLabel(id)), id).toEqual(modelPickerText(id))
    }
  })

  it('★ label を渡しても description は id で引く（label の括弧書きを説明に流用しない・表にある id の説明を消さない）', () => {
    const t = modelPickerText('preview/Kimi-K2.7-Code', '別の表示名')
    expect(t.name).toBe('別の表示名')
    expect(t.description).toBe('標準（おすすめ・コードが得意）')
  })

  it('label が空文字なら modelLabel へフォールバック（空の名前を出さない）', () => {
    expect(modelPickerText('preview/Kimi-K2.7-Code', '').name).toBe('Kimi K2.7 Code（プレビュー）')
    expect(modelPickerText('claude-x', '').name).toBe('claude-x')
  })
})

describe('pickerTooltip（ModelSelect のマウスオーバー判断・純関数）', () => {
  it('表にある id → description をそのまま返す', () => {
    expect(pickerTooltip('preview/Kimi-K2.7-Code')).toBe('標準（おすすめ・コードが得意）')
    expect(pickerTooltip('llm-jp-3.1-8x13b-instruct4')).toBe('日本語特化（ツール非対応・文脈を無視することあり）')
  })

  it('★ 表に無い未知の id → null（ツールチップを出さない。空文字や技術名を返さない）', () => {
    expect(pickerTooltip('some-brand-new-model-2027')).toBeNull()
    expect(pickerTooltip('claude-x')).toBeNull()
  })
})

describe('orderModelsForPicker（一覧の並び: 既定モデルを先頭に・UX-A判断1）', () => {
  it('既定モデルが一覧にあれば先頭へ出し、残りは元の順序のまま', () => {
    const ids = ['gpt-oss-120b', 'preview/Kimi-K2.7-Code', 'preview/gemma-4-31B-it']
    expect(orderModelsForPicker(ids, 'preview/gemma-4-31B-it')).toEqual([
      'preview/gemma-4-31B-it', 'gpt-oss-120b', 'preview/Kimi-K2.7-Code',
    ])
  })

  // ★ 変異試験(b): 「既定を先頭にしない」バグを検知する砦。
  it('★ DEFAULT_MODEL を一覧の途中に混ぜても、先頭に出てくる', () => {
    const ids = ['a', 'b', DEFAULT_MODEL, 'c']
    expect(orderModelsForPicker(ids, DEFAULT_MODEL)[0]).toBe(DEFAULT_MODEL)
  })

  it('既定モデルが一覧に無ければ、並びを変えない（Claudeモデル一覧にさくらの既定idを渡した場合など）', () => {
    const ids = ['claude-x', 'claude-y']
    expect(orderModelsForPicker(ids, DEFAULT_MODEL)).toEqual(['claude-x', 'claude-y'])
  })

  it('重複を1つにまとめる', () => {
    const ids = ['a', 'b', 'a', DEFAULT_MODEL, 'b']
    expect(orderModelsForPicker(ids, DEFAULT_MODEL)).toEqual([DEFAULT_MODEL, 'a', 'b'])
  })

  it('未知の id も落とさない', () => {
    const ids = ['unknown-1', DEFAULT_MODEL, 'unknown-2']
    expect(orderModelsForPicker(ids, DEFAULT_MODEL)).toEqual([DEFAULT_MODEL, 'unknown-1', 'unknown-2'])
  })
})

describe('配線: モデル選択UI3か所（チャット欄ヘッダー／新規プロジェクト画面／設定）が modelPickerText( を使っている（掟10・呼び出しの形ごと・UX-A2）', () => {
  const modelSelectSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/ModelSelect.tsx'), 'utf-8')
  const chatAppSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/ChatApp.tsx'), 'utf-8')
  const chatPanelSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')
  const newProjectSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/NewProjectModal.tsx'), 'utf-8')
  const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/SettingsModal.tsx'), 'utf-8')
  const lines = (src: string) => src.split('\n')

  it('① ModelSelect.tsx: ボタン・一覧の見える文字が modelPickerText(id, label).name（モデル名。一覧の label を渡す）', () => {
    expect(modelSelectSrc).toContain("import { modelPickerText, orderModelsForPicker } from '../../shared/modelInfo'")
    // ボタン: value → 一覧から label を引いて name を <span className="truncate"> に出す（受け渡しの形ごと）
    expect(modelSelectSrc).toContain('const current = models.find(m => m.id === value)')
    expect(modelSelectSrc).toContain('const currentName = value ? modelPickerText(value, current?.label).name : \'\'')
    expect(modelSelectSrc).toContain('<span className="truncate">{currentName}</span>')
    // 一覧の各行: m.id + m.label → name（✓ の直後）
    expect(modelSelectSrc).toContain("{selected ? '✓ ' : ''}{modelPickerText(m.id, m.label).name}")
    // ★ 2026-09-15 検分の砦: label を渡さない形（Claude 一覧で技術 id が見える）へ戻っていない
    expect(modelSelectSrc).not.toContain('modelPickerText(value).name')
    expect(modelSelectSrc).not.toContain('modelPickerText(m.id).name')
    // ★ 変異(a)の砦: 直す前の形（purposeLabel を見える文字に）へ戻っていない
    expect(modelSelectSrc).not.toContain('purposeLabel(')
  })

  it('① ModelSelect（描画）: Claude 一覧を渡すとボタンに claudeMode.ts の名前が出て、技術 id は見えない', () => {
    // 閉じた状態のボタンだけを描画（useEffect は動かない・ホバー無しなのでツールチップも出ない）
    const html = renderToStaticMarkup(createElement(ModelSelect, { models: CLAUDE_MODELS, value: 'claude-sonnet-5', onChange: () => {} }))
    expect(html).toContain('<span class="truncate">Claude Sonnet 5（バランス）</span>')
    expect(html).not.toContain('>claude-sonnet-5<')
    // ライブ取得で表に無い新モデル（label は API の displayName）も名前で出る
    const html2 = renderToStaticMarkup(createElement(ModelSelect, { models: [{ id: 'claude-new-model', label: 'Claude New Model' }], value: 'claude-new-model', onChange: () => {} }))
    expect(html2).toContain('<span class="truncate">Claude New Model</span>')
    expect(html2).not.toContain('>claude-new-model<')
    // 対照: さくらの一覧（useModels と同じ形）はこれまでどおり modelLabel の名前
    const sakura = MODELS.map(m => ({ id: m.id, label: modelLabel(m.id) }))
    const html3 = renderToStaticMarkup(createElement(ModelSelect, { models: sakura, value: DEFAULT_MODEL, onChange: () => {}, defaultId: DEFAULT_MODEL }))
    expect(html3).toContain('<span class="truncate">Kimi K2.7 Code（プレビュー）</span>')
    expect(html3).not.toContain('>preview/Kimi-K2.7-Code<')
  })

  it('Claude 頭脳モードの経路: ChatPanel / NewProjectModal が useClaudeModels の一覧（label 付き）を ModelSelect へ渡している', () => {
    expect(chatPanelSrc).toContain('const claudeModels = useClaudeModels(claudeKey)')
    expect(chatPanelSrc).toContain('models={claudeActive ? claudeModels : models}')
    expect(newProjectSrc).toContain('const claudeModels = useClaudeModels(claudeKey)')
    expect(newProjectSrc).toContain("models={brain === 'claude' ? claudeModels : sakuraModels}")
  })

  it('① ModelSelect.tsx: 説明は pickerTooltip（= modelPickerText(id).description・空なら null）を通し、ボタン直下と一覧枠の最下段の2か所に text-sm で出す', () => {
    // 判断の純関数（本体は上の pickerTooltip の振る舞いテストで固定）
    expect(modelSelectSrc).toContain('export function pickerTooltip(id: string): string | null')
    expect(modelSelectSrc).toContain('const description = modelPickerText(id).description')
    // ボタンのマウスオーバー → value の説明。開いている間は出さない
    expect(modelSelectSrc).toContain('const buttonTip = !open && buttonHover && value ? pickerTooltip(value) : null')
    // 一覧の行のマウスオーバー → その行の説明（行から外れたら hoverId が null → 消える）
    expect(modelSelectSrc).toContain('const listTip = hoverId ? pickerTooltip(hoverId) : null')
    expect(modelSelectSrc).toContain('onMouseEnter={() => setHoverId(m.id)}')
    expect(modelSelectSrc).toContain('onMouseLeave={() => setHoverId(null)}')
    // ★ 変異(b)の砦: ツールチップ2か所の文字は text-sm（一覧の text-xs より大きい）。当て先は描画行そのもの
    const tipLines = lines(modelSelectSrc).filter(l => l.includes('{buttonTip}</div>') || l.includes('{listTip}</div>'))
    expect(tipLines.length).toBe(2)
    for (const l of tipLines) {
      expect(l).toContain('text-sm')
      expect(l).not.toContain('text-xs')
    }
    // ボタン直下: 仕様の見た目（bg-elevated border border-line rounded-md px-2 py-1 shadow-lg z-40）・ボタンの直下（top-full）
    const buttonTipLine = tipLines.find(l => l.includes('{buttonTip}</div>'))!
    for (const cls of ['top-full', 'z-40', 'bg-elevated', 'border border-line', 'rounded-md', 'px-2 py-1', 'shadow-lg']) expect(buttonTipLine).toContain(cls)
    // 一覧の説明欄はスクロール領域（overflow-y-auto の div）の外＝枠の最下段。描画順で固定する
    const scrollAt = modelSelectSrc.indexOf('<div className="max-h-[60vh] overflow-y-auto py-1">')
    const listTipAt = modelSelectSrc.indexOf('{listTip}</div>')
    expect(scrollAt).toBeGreaterThan(0)
    expect(listTipAt).toBeGreaterThan(scrollAt)
    // 直す前の形（外側の枠自体が overflow-y-auto）へ戻っていない
    expect(modelSelectSrc).not.toContain('min-w-full max-h-[60vh] overflow-y-auto')
  })

  it('① ModelSelect.tsx: ネイティブの title に modelLabel( を使っていない（文字の大きさを変えられないため自前ツールチップに統一）', () => {
    expect(modelSelectSrc).not.toContain('modelLabel(')
    for (const l of lines(modelSelectSrc)) if (l.includes('title={')) expect(l).not.toContain('modelLabel(')
    // 直す前の形（技術名＋id を title に）へ戻っていない
    expect(modelSelectSrc).not.toContain('`${modelLabel(value)}（${value}）`')
    expect(modelSelectSrc).not.toContain('`${modelLabel(m.id)}（${m.id}）`')
    expect(modelSelectSrc).not.toContain('title={currentTitle}')
  })

  it('チャット欄ヘッダー（ChatApp.tsx＝チャットモード）が ModelSelect に defaultId={DEFAULT_CHAT_MODEL} を渡している', () => {
    expect(chatAppSrc).toContain('defaultId={DEFAULT_CHAT_MODEL}')
  })

  it('チャット欄ヘッダー（ChatPanel.tsx＝IDEモード）が ModelSelect に defaultId={claudeActive ? undefined : DEFAULT_MODEL} を渡している', () => {
    expect(chatPanelSrc).toContain('defaultId={claudeActive ? undefined : DEFAULT_MODEL}')
  })

  it('② 新規プロジェクト画面（NewProjectModal.tsx）が ModelSelect に defaultId={brain === \'claude\' ? undefined : DEFAULT_MODEL} を渡している', () => {
    expect(newProjectSrc).toContain("defaultId={brain === 'claude' ? undefined : DEFAULT_MODEL}")
  })

  it('③ 設定（SettingsModal.tsx）の「IDEで使うモデル」「チャットで使うモデル」の2つの select: option の見える文字が modelPickerText(id).name（＋単価）', () => {
    expect(settingsSrc).toContain('IDEで使うモデル')
    expect(settingsSrc).toContain('チャットで使うモデル')
    // option の本文の形ごと（名前＋単価）。2つの select で2回
    const count = settingsSrc.split('{modelPickerText(id).name}（入力¥{p.in} / 出力¥{p.out} ・100万トークン）').length - 1
    expect(count).toBe(2)
    // ★ 変異(a)の砦: 直す前の形（purposeLabel を見える文字に）へ戻っていない
    expect(settingsSrc).not.toContain('purposeLabel(')
    // 技術名＋id を option の title に出す旧形も残っていない
    expect(settingsSrc).not.toContain('title={`${modelLabel(id)}（${id}）`}')
  })

  it('③ 設定: 各 select の直下に、選択中モデルの description を text-sm で1行出す（title も description）', () => {
    expect(settingsSrc).toContain('const ideDesc = modelPickerText(ideModel).description')
    expect(settingsSrc).toContain('const chatDesc = modelPickerText(chatModel).description')
    expect(settingsSrc).toContain('title={ideDesc || undefined}')
    expect(settingsSrc).toContain('title={chatDesc || undefined}')
    // 「直下」を描画順で固定: </select> の次の行が description の <p>（間に他の行が無い）
    const ls = lines(settingsSrc)
    const closers = ls.map((l, i) => (l.trim() === '</select>' ? i : -1)).filter(i => i >= 0)
    expect(closers.length).toBe(2)
    expect(ls[closers[0] + 1].trim()).toBe('{ideDesc && <p className="mt-1 text-sm text-ink-secondary">{ideDesc}</p>}')
    expect(ls[closers[1] + 1].trim()).toBe('{chatDesc && <p className="mt-1 text-sm text-ink-secondary">{chatDesc}</p>}')
  })

  it('設定の一覧も orderModelsForPicker で既定を先頭に並べている（IDE=DEFAULT_MODEL・チャット=DEFAULT_CHAT_MODEL）', () => {
    expect(settingsSrc).toContain('orderModelsForPicker(models.map(m => m.id), DEFAULT_MODEL)')
    expect(settingsSrc).toContain('orderModelsForPicker(models.map(m => m.id), DEFAULT_CHAT_MODEL)')
  })
})
