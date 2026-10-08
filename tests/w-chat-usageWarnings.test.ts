// tests/w-chat-usageWarnings.test.ts — 受け渡し（handoff）固定: W-21・W-53 をチャット欄へ配線する。
//
// この受け渡しの判定・文面そのもの（checkBeforeRequestOf の warning／isClaudeCostOverWarnUsd／
// claudeChatWarningText）は shared/usageBudget.ts の担当（tests/w-settings-warn-when-enforce-off.test.ts・
// tests/w-settings-claude-warn-chat.test.ts が固定済み）。ここで固定するのは「チャット担当」が
// 引き受けた残り: それを実際にチャットへ表示する配線（useAiChat.ts／ChatPanel.tsx）。
//
// ── なぜ readCode（ソース文字列）で固定するか ─────────────────────────────
// vitest.config.ts のとおりテスト環境は 'node'（DOM非依存の純粋ロジックのみ対象）で、useAiChat.ts
// は React の useCallback の中に配線があり、window.electronAPI 等の大きなモックなしにはフックとして
// 直接実行できない。同じ制約の下で書かれた既存の tests/usageWiring.test.ts と同じ流儀
// （コメントを外してから toContain/not.toContain で当てる）を踏襲する。掟10の「当て先が他の行に
// 出ないか」を守るため、変数名（delegateBudget・budgetWarning・claudeWarning）を含む具体的な行を
// 狙い撃ちし、実装直後に grep 相当で一意なことを確認済み。
//
// W-0.3（claudeMode.ts の isOverClaudeWarnThreshold → shared/usageBudget.ts への一元化）は
// 純関数の境界を直接比較できるので、こちらは本物の振る舞いテスト（readCode を使わない）。

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { isOverClaudeWarnThreshold } from '../src/renderer/claudeMode'
import { isClaudeCostOverWarnUsd } from '../src/shared/usageBudget'

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('W-0.3: claudeMode.ts の isOverClaudeWarnThreshold は shared/usageBudget.ts へ一元化されている（振る舞い）', () => {
  it('名前・引数・境界（`>`）は移設前のまま（tests/claudeAgent.test.ts と同じ値で確認）', () => {
    expect(isOverClaudeWarnThreshold(5, 5)).toBe(false) // ちょうど＝超過ではない
    expect(isOverClaudeWarnThreshold(5.01, 5)).toBe(true)
    expect(isOverClaudeWarnThreshold(100, null)).toBe(false)
  })

  it('★ 実体は shared/usageBudget.ts の isClaudeCostOverWarnUsd と常に同じ値を返す（二重定義に戻していない）', () => {
    const cases: Array<[number, number | null]> = [
      [0, null], [0, 5], [5, 5], [5.0001, 5], [4.9999, 5], [1000, 0.01], [-1, 5], [NaN, 5], [5, NaN], [5, -1],
    ]
    for (const [cost, warn] of cases) {
      expect(isOverClaudeWarnThreshold(cost, warn)).toBe(isClaudeCostOverWarnUsd(cost, warn))
    }
  })

  it('claudeMode.ts が shared/usageBudget.ts から isClaudeCostOverWarnUsd を import している（再実装に戻していない）', () => {
    const src = readCode('src/renderer/claudeMode.ts')
    expect(src).toContain("import { isClaudeCostOverWarnUsd } from '../shared/usageBudget'")
    expect(src).toContain('return isClaudeCostOverWarnUsd(costUsdThisMonth, warnUsd)')
  })
})

describe('W-21: useAiChat.ts の Claude頭脳モード委譲チェックが、warning を吹き出しで出す（配線）', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')

  it('delegateKey が使えるとき（allowed）でも、budget.warning があれば appendBubble する', () => {
    expect(src).toContain('const delegateBudget = checkBeforeRequest(delegateKey)')
    expect(src).toContain('} else if (delegateBudget.warning) {')
    expect(src).toContain('appendBubble({ role: \'assistant\', toolNote: true, content: delegateBudget.warning })')
  })

  it('止める分岐（!delegateBudget.allowed）は warning を出さず、これまでどおり案内文で delegateKey を null にする', () => {
    expect(src).toContain('if (!delegateBudget.allowed) {')
    expect(src).toContain('delegateKey = null')
  })

  it('直す前の形（budget を控えず即 checkBeforeRequest(delegateKey).allowed だけを見る）には戻っていない', () => {
    expect(src).not.toContain('if (delegateKey && !checkBeforeRequest(delegateKey).allowed) {')
  })
})

describe('W-53: useAiChat.ts の Claude結果ハンドラが、目安額超過の⚠️をチャットへ出す（配線）', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')

  it('claudeChatWarningText / getClaudeCostThisMonth / getClaudeWarnUsd を import している', () => {
    expect(src).toContain("import { claudeChatWarningText } from '../../shared/usageBudget'")
    expect(src).toContain('getClaudeCostThisMonth')
    expect(src).toContain('getClaudeWarnUsd')
  })

  it('★ result ハンドラで、記録後に claudeChatWarningText(今月のClaude利用額, 目安額) を吹き出しに出す', () => {
    expect(src).toContain('const claudeWarning = claudeChatWarningText(getClaudeCostThisMonth(), getClaudeWarnUsd())')
    expect(src).toContain('if (claudeWarning) appendBubble({ role: \'assistant\', content: claudeWarning, toolNote: true })')
    // 順序: 利用額を先に記録してから判定する（記録前の古い額で判定しない）
    expect(src.indexOf('recordClaudeCost(ev.costUsd)')).toBeLessThan(src.indexOf('const claudeWarning ='))
  })
})

describe('W-21: ChatPanel.tsx の最初のあいさつ（greet）が、warning を吹き出しで出す（配線）', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')

  it('budget.warning を控えておき、finally で末尾に付け足す（途中の replaceAll に消されない位置）', () => {
    expect(src).toContain('const budgetWarning = budget.warning')
    expect(src).toContain("if (budgetWarning) applyOp({ kind: 'append', msg: { role: 'assistant', toolNote: true, content: budgetWarning } })")
  })

  it('★ warning の付け足しは finally ブロックの中（setGreetLoading(false) の後）に置かれている', () => {
    const finallyIdx = src.indexOf('greetAbortRef.current = null')
    const setLoadingFalseIdx = src.indexOf('setGreetLoading(false)')
    const appendIdx = src.indexOf("if (budgetWarning) applyOp({ kind: 'append'")
    expect(finallyIdx).toBeGreaterThan(-1)
    expect(setLoadingFalseIdx).toBeGreaterThan(finallyIdx)
    expect(appendIdx).toBeGreaterThan(setLoadingFalseIdx) // finally の中・setGreetLoading(false) より後
  })

  it('budgetWarning を控える行は、あいさつ本体を差し替える最初の replaceAll より前にある', () => {
    const captureIdx = src.indexOf('const budgetWarning = budget.warning')
    const firstReplaceAllIdx = src.indexOf("applyOp({ kind: 'replaceAll', messages: [{ role: 'user', content: kickoff")
    expect(captureIdx).toBeGreaterThan(-1)
    expect(firstReplaceAllIdx).toBeGreaterThan(captureIdx)
  })
})
