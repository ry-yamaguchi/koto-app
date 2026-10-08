import { describe, it, expect } from 'vitest'
import { isClaudeCostOverWarnUsd, claudeChatWarningText } from '../src/shared/usageBudget'

// ── W-53（2026-09-27決定・案2）: 「警告の目安額（USD・任意）」の警告は、この設定画面にしか
// 出ない ───────────────────────────────────────────────────────────
//
// 直す前は、目安額を超えたかどうかの ⚠️ が設定画面（⌘,）を開いたときにしか分からなかった
// （isOverClaudeWarnThreshold は claudeMode.ts にあり、設定画面の表示にしか使われていない）。
// 「警告」とあるので、使っている最中にも知らせてくれると期待して見落とす。
//
// ここでは「チャット欄にも出す」ための判定・文面を shared の純関数として固定する（送信は止めない・
// 実際にチャットへ表示する配線は useAiChat.ts／ChatPanel.tsx 側の担当。handoff 参照）。
//
// 境界（検分の指摘・2026-09-27）: claudeMode.ts の isOverClaudeWarnThreshold は
// `costUsdThisMonth > warnUsd`（ちょうど＝超過ではない）で、tests/claudeAgent.test.ts:669 が
// それを固定している。設定画面の ⚠️（SettingsModal.tsx）はそちらを使い続けるため、ここの境界も
// 揃える（掟10）。揃えないと「ちょうど目安額」のときにチャットだけ警告し、設定画面には出ない。

describe('W-53: isClaudeCostOverWarnUsd（目安額を超えたかの判定）', () => {
  it('目安額が未設定（null）なら、いくら使っていても超えない', () => {
    expect(isClaudeCostOverWarnUsd(1000, null)).toBe(false)
  })

  it('目安額ちょうど（境界）は超過ではない（claudeMode.ts の isOverClaudeWarnThreshold と揃える）', () => {
    expect(isClaudeCostOverWarnUsd(5, 5)).toBe(false)
  })

  it('目安額を1セントでも超えれば超える', () => {
    expect(isClaudeCostOverWarnUsd(5.01, 5)).toBe(true)
  })

  it('目安額未満なら超えない', () => {
    expect(isClaudeCostOverWarnUsd(4.99, 5)).toBe(false)
  })

  it('目安額が0以下・非有限なら常に false（壊れた設定値で誤警告しない）', () => {
    expect(isClaudeCostOverWarnUsd(100, 0)).toBe(false)
    expect(isClaudeCostOverWarnUsd(100, -1)).toBe(false)
    expect(isClaudeCostOverWarnUsd(100, NaN)).toBe(false)
  })
})

describe('W-53: claudeChatWarningText（超えたときにチャット欄へ出す注記）', () => {
  it('★ 超えていれば注記を返し、送信を止めない旨を含む', () => {
    const text = claudeChatWarningText(6, 5)
    expect(text).not.toBeNull()
    expect(text).toContain('⚠️')
    expect(text).toMatch(/\$/) // 金額を示す
    expect(text).toContain('止めていません') // 送信は止めない
  })

  it('★ 超えていなければ null（達していないのに知らせない）', () => {
    expect(claudeChatWarningText(1, 5)).toBeNull()
    expect(claudeChatWarningText(1, null)).toBeNull()
  })
})
