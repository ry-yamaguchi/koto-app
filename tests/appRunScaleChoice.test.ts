import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scaleChoice, scaleMinFor, scaleDisplay } from '../src/renderer/components/AppRunPanel'
import { scaleLabel } from '../src/shared/scaleDecision'

// roadmap #31（共用型 AppRun の最小スケール選択）。
//
// 原本 apprun-shared.json v1.5.0 の POST /applications で確認済み:
//   min_scale: integer / minimum 0 / maximum 10 / 既定 0
//   max_scale: integer / minimum 1 / maximum 10 / 既定 10（この機能では触らない）
//
// さくらの開発者の助言「コールドスタートが許容できなければ最小スケールを1以上に」を
// 受けた機能だが、**既定は 0（cold）のまま**——「新しいプロジェクトを作ったら課金が
// 始まることがあってはならない」という Koto の方針（defaultSpec）を優先する。

describe('scaleChoice: 0 は cold、1以上は warm（実際に呼ぶ）', () => {
  it('0 → cold', () => { expect(scaleChoice(0)).toBe('cold') })
  it('1 → warm', () => { expect(scaleChoice(1)).toBe('warm') })
  it('10（原本の最大） → warm', () => { expect(scaleChoice(10)).toBe('warm') })
  it('5 → warm', () => { expect(scaleChoice(5)).toBe('warm') })
})

describe('scaleChoice: 原本の範囲（0〜10）から外れる値は安全側（cold）に倒す', () => {
  it('負の値 → cold', () => { expect(scaleChoice(-1)).toBe('cold') })
  it('11（原本の最大を超える） → cold', () => { expect(scaleChoice(11)).toBe('cold') })
  it('非整数 → cold', () => { expect(scaleChoice(1.5)).toBe('cold') })
  it('NaN → cold', () => { expect(scaleChoice(NaN)).toBe('cold') })
})

describe('scaleMinFor: 選択状態から保存する min を決める（実際に呼ぶ）', () => {
  it("cold → 0", () => { expect(scaleMinFor('cold')).toBe(0) })
  it("warm → 1", () => { expect(scaleMinFor('warm')).toBe(1) })
})

// ── #31 の検分（2026-09-09）で見つかった【低】 ──────────────────────────
// scaleChoice は範囲外（例: min=11）を安全側の cold に倒す。**保存する値としては正しい**が、
// その cold をそのまま画面の文言に使うと「アクセスが無い間は止まり、課金されません」と
// 言い切ってしまう。min=11 は実際には常時11インスタンスが動いており、これは嘘になる。
// 表示用は3値（cold/warm/unknown）にし、unknown のときは断定しない。
describe('scaleDisplay: 表示用は3値。範囲外は unknown（cold と決めつけない・実際に呼ぶ）', () => {
  it('0 → cold、1〜10 → warm（scaleChoice と同じ）', () => {
    expect(scaleDisplay(0)).toBe('cold')
    expect(scaleDisplay(1)).toBe('warm')
    expect(scaleDisplay(10)).toBe('warm')
  })

  it('★ 範囲外（例: min=11）は unknown ── scaleChoice なら cold になる値', () => {
    expect(scaleChoice(11)).toBe('cold') // 保存用はこれまでどおり安全側
    expect(scaleDisplay(11)).toBe('unknown') // だが表示は「分からない」であって「cold」ではない
  })

  it('負の値・非整数・NaN も unknown', () => {
    expect(scaleDisplay(-1)).toBe('unknown')
    expect(scaleDisplay(1.5)).toBe('unknown')
    expect(scaleDisplay(NaN)).toBe('unknown')
  })
})

// 画面側の配線は、React を実レンダリングするテストインフラが無いため、
// apprunDedicatedWiring.test.ts / appRunRegionSelect.test.ts と同じ「ソーステキストを
// 固定する」流儀で確かめる。
const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')

describe('AppRunPanel.tsx: ②公開の設定に、最小スケールを選べる2択が出ている', () => {
  it('2つの選択肢の文言がある', () => {
    expect(panel).toContain('最初のアクセスが遅くてもよい（既定・安い）')
    expect(panel).toContain('すぐ返す（常時動かす）')
  })

  it('onSetScale は cold/warm の2値のみで呼ばれる（保存する値は今までどおり2値）', () => {
    expect(panel).toContain("onClick={() => onSetScale('cold')}")
    expect(panel).toContain("onClick={() => onSetScale('warm')}")
  })

  // 表示（ボタンのハイライト・説明文）は scaleDisplay（3値）の判定を使う。
  // scaleChoice のまま使うと、範囲外の値で「課金されません」と嘘をつく（下のdescribeで確認）。
  it('表示は const display = scaleDisplay(spec.service.scale.min) から作る', () => {
    expect(panel).toContain('const display = scaleDisplay(spec.service.scale.min)')
    expect(panel).toContain("display === 'cold'")
    expect(panel).toContain("display === 'warm'")
  })

  it('保存は既存の env.json 保存経路（cloud.saveEnv）を使い、新設していない', () => {
    const at = panel.indexOf('const setScale = async (choice: ScaleChoice) => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, at + 500)
    expect(block).toContain('window.electronAPI.cloud.saveEnv(projectDir, next)')
    expect(block).toContain('scaleMinFor(choice)')
    // max は触らない（既存の scale.max をそのまま展開で引き継ぐ）
    expect(block).toContain('...spec.service.scale')
  })

  it('「すぐ返す」を選ぶと、何が変わるかを1行で伝える（料金がかかることの明示）', () => {
    expect(panel).toContain('その分の料金がかかります')
    expect(panel).toContain('インスタンスが動き続けるため')
  })

  it('⚠️ 金額を書いていない（確かめていない数字を書かない・掟1）: warm選択時の説明ブロックに円建ての数字が無い', () => {
    const at = panel.indexOf("const display = scaleDisplay(spec.service.scale.min)")
    expect(at).toBeGreaterThan(0)
    const end = panel.indexOf('})()', at)
    expect(end).toBeGreaterThan(at)
    const block = panel.slice(at, end)
    expect(block).toContain('その分の料金がかかります')
    expect(block).not.toMatch(/[\d,]+\s*円/)
  })

  it('既定は0のまま変えていない（defaultSpec の scale.min は 0）', () => {
    const spec = readFileSync(join(__dirname, '..', 'src/main/cloud/spec.ts'), 'utf-8')
    expect(spec).toContain('scale: { min: 0, max: 1 }')
  })

  // ── #31 の検分（2026-09-09）で見つかった【低】: 範囲外の値を cold と言い切らない ──
  it('★ 範囲外（unknown）のときは「判断できません」と出し、断定しない', () => {
    const at = panel.indexOf("const display = scaleDisplay(spec.service.scale.min)")
    const end = panel.indexOf('})()', at)
    const block = panel.slice(at, end)
    // 3値の判定（cold/warm/unknown のどれかで文言を分けている）になっていること
    expect(block).toContain("display === 'warm'")
    expect(block).toContain("display === 'cold'")
    expect(block).toContain('いまの設定を判断できません')
    // cold の文言と unknown の文言は、同じ三項演算子の別の枝として出ていること
    const coldAt = block.indexOf("display === 'cold'")
    const coldBranch = block.slice(coldAt, block.indexOf('いまの設定を判断できません'))
    expect(coldBranch).toContain('アクセスが無い間は止まります')
  })

  // ── 判断4（利用者目線レビュー・2026-09-11）: 「起動のしかた」の説明を scaleLabel と揃える ──
  // 以前は cold のとき「課金されません」と言い切っていたが、止まっている間の実額を
  // 確かめたわけではないため、scaleLabel（src/shared/scaleDecision.ts）と同じ言い回し
  // （「最初のアクセスが遅くてもよい（安い）」）に統一した。
  it('★ cold の説明は scaleLabel(0) と同じ言い回しを使い、「課金されません」とは言い切らない', () => {
    const at = panel.indexOf("const display = scaleDisplay(spec.service.scale.min)")
    const end = panel.indexOf('})()', at)
    const block = panel.slice(at, end)
    const coldAt = block.indexOf("display === 'cold'")
    const coldBranch = block.slice(coldAt, block.indexOf('いまの設定を判断できません'))
    expect(coldBranch).toContain('scaleLabel(0)')
    expect(coldBranch).not.toContain('課金されません')
    expect(scaleLabel(0)).toBe('最初のアクセスが遅くてもよい（安い）')
  })

  // ── #31 の検分（2026-09-09）で見つかった【低】: リンク先とラベルの不一致 ──
  // targetProfiles の serviceUrl は AppRun の公式サイト（製品ページ）であって、料金だけの
  // ページではない。同じ URL を、この画面の別の場所では「公式サイトを見る」と呼んでいる。
  // ラベルと行き先を合わせる（推測で料金ページのURLを作らない・掟1）。
  it('★ 「すぐ返す」の説明にあるリンクは、行き先と同じ呼び方（公式サイトを見る）にする', () => {
    expect(panel).not.toContain('料金ページ ↗')
    const at = panel.indexOf("const display = scaleDisplay(spec.service.scale.min)")
    const end = panel.indexOf('})()', at)
    const block = panel.slice(at, end)
    expect(block).toContain('公式サイトを見る ↗')
  })
})
