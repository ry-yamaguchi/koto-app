// tests/w-chat-claudeApproval.test.ts — W-18固定: 「✋ 毎回確認」にしても Claude 経路
// （src/main/claude/agent.ts の makeCanUseTool）は writeMode を見ておらず、確認なしで
// ファイルを保存していた。さくらのAI Engine 経路（chat/approvalStore.ts の requestApproval・
// shared/approvalPlan.ts の planApproval）と**同じ仕組みを使い回した**ことを、実際に呼んで固定する
// （tests/approvalWiring.test.ts の「実駆動: decideApproval」と同じ流儀・掟10:
//  ソースの文字列を grep するテストは「plan を無視して素通りする」変異を見逃す）。
//
// ⚠️ 既存テストは書き換えない方針のため、このファイルは新規。makeCanUseTool は
// approvalStore.ts（electron非依存の純粋ロジック）を直接呼ぶので、Electron 抜きでも
// request→answer の往復をそのまま試せる。

import { describe, it, expect, beforeEach } from 'vitest'
import { makeCanUseTool, claudeToolGatingOptions } from '../src/main/claude/agent'
import {
  setApprovalListener, answerApproval, listPending, resetApprovalsForTest, cancelApprovalsForTurn,
} from '../src/main/chat/approvalStore'
import { writeDenialMessage, runCommandDenialMessage } from '../src/shared/approvalPlan'

const SCOPE_DIR = '/tmp/w-chat-claude-approval-test-project'
const WRITE_ROOT = SCOPE_DIR // public/ が無いプロジェクト＝プロジェクト直下がそのまま作業フォルダ

describe('W-18: makeCanUseTool（Claude経路）は writeMode を見て承認を求める', () => {
  beforeEach(() => { resetApprovalsForTest(); setApprovalListener(null) })

  it('★★ おまかせ（auto）の Write は、駐機せず即 allow（承認なしで実行）', async () => {
    const canUseTool = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'auto', 't-1')
    const result = await canUseTool('Write', { file_path: `${WRITE_ROOT}/index.html`, content: '<html></html>' }, {} as any)
    expect(result).toEqual({ behavior: 'allow' })
    expect(listPending()).toEqual([]) // 保留も作られていない
  })

  it('★★ 毎回確認（confirm）の Write は駐機し、許可すると allow（実行される）', async () => {
    const canUseTool = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'confirm', 't-2')
    const p = canUseTool('Write', { file_path: `${WRITE_ROOT}/index.html`, content: '<html></html>' }, {} as any)
    // 駐機が実際に積まれている（label は approvalPlan.ts の planApproval の文面・W-41）。
    expect(listPending().length).toBe(1)
    expect(listPending()[0].label).toBe('✏️ ファイルの保存（index.html）')
    expect(listPending()[0].dir).toBe(SCOPE_DIR) // ChatPanel.tsx の pendingApprovals は dir===projectDir で絞り込む
    expect(answerApproval(listPending()[0].id, true)).toBe(true)
    expect(await p).toEqual({ behavior: 'allow' })
  })

  it('★★ 毎回確認（confirm）の Write を拒否すると deny（さくらのAI Engine経路と同じ拒否文面）', async () => {
    const canUseTool = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'confirm', 't-3')
    const p = canUseTool('Write', { file_path: `${WRITE_ROOT}/index.html`, content: 'x' }, {} as any)
    answerApproval(listPending()[0].id, false)
    const result = await p
    expect(result.behavior).toBe('deny')
    expect((result as any).message).toBe(writeDenialMessage('write_file', JSON.stringify({ path: 'index.html' })))
  })

  it('毎回確認（confirm）の Edit は「✏️ ファイルの編集」の文面で駐機する', async () => {
    const canUseTool = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'confirm', 't-4')
    const p = canUseTool('Edit', { file_path: `${WRITE_ROOT}/app.js`, old_string: 'a', new_string: 'b' }, {} as any)
    expect(listPending()[0].label).toBe('✏️ ファイルの編集（app.js）')
    answerApproval(listPending()[0].id, true)
    await p
  })

  it('Koto の管理領域（.git/hooks）への書き込みは、毎回確認かどうかに関わらず駐機せず即 deny', async () => {
    const canUseTool = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'confirm', 't-5')
    const result = await canUseTool('Write', { file_path: `${WRITE_ROOT}/.git/hooks/pre-commit`, content: 'x' }, {} as any)
    expect(result.behavior).toBe('deny')
    expect(listPending()).toEqual([]) // 承認では守れない領域なので、聞くことさえしない
  })

  it('★★ おまかせ（auto）でも危険コマンド（rm -rf /）は実行前に拒否される（従来どおり・承認では解除できない）', async () => {
    const canUseTool = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'auto', 't-6')
    const result = await canUseTool('Bash', { command: 'rm -rf /' }, {} as any)
    expect(result.behavior).toBe('deny')
    expect(listPending()).toEqual([])
  })

  it('★ おまかせ（auto）でも「確認が要る」コマンド（curl）は駐機する（さくらのAI Engine経路と同じ守り）', async () => {
    const canUseTool = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'auto', 't-7')
    const args = JSON.stringify({ command: 'curl https://example.com' })
    const p = canUseTool('Bash', { command: 'curl https://example.com' }, {} as any)
    expect(listPending().length).toBe(1)
    expect(listPending()[0].label).toContain('コマンド実行: curl https://example.com')
    answerApproval(listPending()[0].id, false)
    const result = await p
    expect(result.behavior).toBe('deny')
    expect((result as any).message).toBe(runCommandDenialMessage(args))
  })

  it('おまかせ（auto）の安全なコマンド（ls）は駐機しない', async () => {
    const canUseTool = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'auto', 't-8')
    const result = await canUseTool('Bash', { command: 'ls' }, {} as any)
    expect(result).toEqual({ behavior: 'allow' })
    expect(listPending()).toEqual([])
  })

  it('★ ⏹ 相当（cancelApprovalsForTurn）で、承認待ちの Write が「拒否」として解ける（2026-09-23の教訓・承認待ちで固まらない）', async () => {
    const canUseTool = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'confirm', 't-9')
    const p = canUseTool('Write', { file_path: `${WRITE_ROOT}/index.html`, content: 'x' }, {} as any)
    expect(listPending().length).toBe(1)
    const cancelled = cancelApprovalsForTurn('t-9')
    expect(cancelled).toBe(1)
    const result = await p
    expect(result.behavior).toBe('deny') // 承認したことにはしない（拒否として解く）
    expect(listPending()).toEqual([])
  })

  it('⏹（cancelApprovalsForTurn）は他のターンの承認待ちには触らない（掟11: 環境の独立）', async () => {
    const a = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'confirm', 't-10a')
    const b = makeCanUseTool(SCOPE_DIR, WRITE_ROOT, 'confirm', 't-10b')
    const pa = a('Write', { file_path: `${WRITE_ROOT}/a.html`, content: 'x' }, {} as any)
    const pb = b('Write', { file_path: `${WRITE_ROOT}/b.html`, content: 'x' }, {} as any)
    expect(listPending().length).toBe(2)
    cancelApprovalsForTurn('t-10a')
    expect(listPending().length).toBe(1) // b の分だけ残る
    expect((await pa).behavior).toBe('deny')
    answerApproval(listPending()[0].id, true)
    expect((await pb).behavior).toBe('allow')
  })
})

// ── 配線そのものの固定（検分の指摘1・2026-09-27）───────────────────────────
// 上のテストはすべて makeCanUseTool を「直接」呼んでいる。だが実際の startClaudeChat は
// makeCanUseTool を SDK の query() の canUseTool オプションとして渡すだけで、
// SDK 自身がそれを呼ぶかどうかは options.allowedTools / permissionMode 次第である。
//
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs は起動時に実際にこう警告する
// （grep -o '.\{80\}Bare allowedTools entries auto-approve.\{300\}' sdk.mjs で確認済み）:
//   "canUseTool will not be invoked for: <bare names>. Bare allowedTools entries
//    auto-approve the whole tool before the callback is consulted. ... or remove the
//    bare names from allowedTools so they fall through to canUseTool."
// つまり Edit/Write/Bash を options.allowedTools に**名前だけ**で渡すと、上のテストが
// 固定している makeCanUseTool の判定（承認・保護パス・危険コマンド）は、実機では
// 一度も呼ばれない。以前の実装はまさにこの形（allowedTools に BUILTIN_TOOL_NAMES を
// 丸ごと渡し、かつ permissionMode: 'acceptEdits'＝Edit/Write の自動許可）だった。
//
// ⚠️ 下の2件が見ているのは claudeToolGatingOptions() の**返り値だけ**。それが query() へ実際に
// 渡っていること（展開の1行を消す・後ろのキーで上書きする変異）は、ここでは捕まらない。
// 渡った先の検査は tests/claudeQueryOptionsWiring.test.ts（偽の SDK が受け取った options を見る）。
describe('W-18: query() へ渡す配線（allowedTools / permissionMode）が canUseTool を迂回しない', () => {
  it('★★★ allowedTools に Edit/Write/Bash を名前だけで含まない（含めると SDK が canUseTool を呼ばずに全許可する）', () => {
    const { allowedTools } = claudeToolGatingOptions()
    expect(allowedTools).not.toContain('Edit')
    expect(allowedTools).not.toContain('Write')
    expect(allowedTools).not.toContain('Bash')
    // 読み取り専用（危険が無い）は確認なしのままでよい
    expect(allowedTools).toContain('Read')
    expect(allowedTools).toContain('Glob')
    expect(allowedTools).toContain('Grep')
  })

  it('★★★ permissionMode は acceptEdits ではない（acceptEdits は Edit/Write を canUseTool より先に自動許可しうる）', () => {
    expect(claudeToolGatingOptions().permissionMode).not.toBe('acceptEdits')
    expect(claudeToolGatingOptions().permissionMode).not.toBe('bypassPermissions')
  })
})
