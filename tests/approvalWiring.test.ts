import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { ASK_PATHS } from '../src/shared/chatTurnRpc'

// approvalWiring.test.ts — B'-3d-3: 承認（approveToolCall）の main 一元化＋駐機の配線を
// 固定する（tests/usageWiring.test.ts・tests/learningWiring.test.ts と同じ readCode 流儀）。
//
// ⚠️ コメントを外してから判定する（tests/untrustedBlockWiring.test.ts 冒頭が警告する「\n の罠」
// の確認込み: このテストファイル自身は `\n`（バックスラッシュ+n）を文字列リテラルとして
// 書いていないため、その罠には触れない）。各 must/mustNot は、実装直後に `grep -n` 相当で
// 対象ファイル内に実在すること／存在しないことを確認済み（掟10: 当て先が他の行に出ないか）。

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('turnRunner.ts: approveToolCall はもう bridge.ask ではない', () => {
  const src = readCode('src/main/chat/turnRunner.ts')

  it("bridge.ask('approveToolCall' が残っていない", () => {
    expect(src).not.toContain("bridge.ask('approveToolCall'")
  })

  it('shared/approvalPlan.ts（判定）と chat/approvalStore.ts（駐機）を直接呼んでいる', () => {
    expect(src).toContain(
      "import { planApproval, writeDenialMessage, runCommandDenialMessage, type WriteMode } from '../../shared/approvalPlan'",
    )
    expect(src).toContain("import { requestApproval } from './approvalStore'")
    expect(src).toContain('const plan = planApproval(name, argsJson, { writeMode, scopeDir, scopeRoot, deps })')
    expect(src).toContain('const approved = await requestApproval({ turnId, dir: scopeDir, label: plan.label })')
  })

  it('要否判定に使う writeMode は payload.spec.turnOpts から読む（送信時のスナップショット）', () => {
    expect(src).toContain(
      "const writeMode: WriteMode = (payload.spec.turnOpts as { writeMode?: string })?.writeMode === 'confirm' ? 'confirm' : 'auto'",
    )
  })

  it('拒否時の文面は runCommandDenialMessage / writeDenialMessage をそのまま返す', () => {
    expect(src).toContain("return name === 'run_command' ? runCommandDenialMessage(argsJson) : writeDenialMessage(name, argsJson)")
  })
})

describe('turnRunner.ts: getHistory は convStore 直読み（プロジェクト会話）／ask（ChatApp）の分岐', () => {
  const src = readCode('src/main/chat/turnRunner.ts')

  it('convStore.loadConversation を import している', () => {
    expect(src).toContain("import { applyConversationOps, loadConversation } from './convStore'")
  })

  it('toolsProjectDir があれば直読み、無ければ ask（ChatApp 専用）', () => {
    const start = src.indexOf('getHistory: () => {')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('buildSystemPrompt:', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('const dir = payload.spec.toolsProjectDir')
    expect(block).toContain("return dir ? (loadConversation(dir) ?? []) : (bridge.ask('getHistory', []) as any)")
  })
})

describe('shared/chatTurnRpc.ts: ASK_PATHS から approveToolCall が消え、7本になっている', () => {
  const src = readCode('src/shared/chatTurnRpc.ts')

  it("'approveToolCall' という要素が ASK_PATHS 配列に無い（getHistory は残る）", () => {
    const start = src.indexOf('export const ASK_PATHS = [')
    const end = src.indexOf('] as const', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const arrayLiteral = src.slice(start, end)
    expect(arrayLiteral).not.toContain("'approveToolCall'")
    expect(arrayLiteral).toContain("'getHistory'")
  })

  it('実体（ASK_PATHS）も7本で、内容が期待どおり', () => {
    expect(ASK_PATHS).toHaveLength(7)
    expect(ASK_PATHS).toEqual([
      'buildSystemPrompt', 'getHistory', 'onUserMessage',
      'buildRagBlock', 'getSearchConfig', 'fetchPagesBlock', 'autoSearchBlock',
    ])
  })

  it('TurnStartPayload.caps に approveToolCall が無い（main が承認を常に直接持つため）', () => {
    expect(src).not.toContain('approveToolCall: boolean')
    expect(src).toContain('caps: { onUserMessage: boolean; buildRagBlock: boolean }')
  })
})

describe('renderer/components/ChatPanel.tsx: 純UI化（判定を持たない）', () => {
  const src = readCode('src/renderer/components/ChatPanel.tsx')

  it('旧 approveToolCall クロージャ（判定・文面組み立て）が無い', () => {
    expect(src).not.toContain('approveToolCall: async (toolName, toolArgs, scope) => {')
    expect(src).not.toContain("getWriteMode() === 'confirm' || requiresConfirmation(cmd)")
  })

  it('buildExecuteOpts に writeMode: getWriteMode() のスナップショットがある（口ごと確認）', () => {
    const start = src.indexOf('buildExecuteOpts: () => ({')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf('buildRagBlock: ragEnabled ? (text: string) => autoRagBlock(text, apiKey, ragSettings) : undefined,', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('writeMode: getWriteMode(),')
  })

  it('approval:list / approval:answer / approval:changed を購読している（駐機の再提示・回答）', () => {
    expect(src).toContain('window.electronAPI.approval.list()')
    expect(src).toContain('window.electronAPI.approval.onChanged(')
    expect(src).toContain('window.electronAPI.approval.answer(id, approved)')
  })
})

describe('IPC 3点セット（approval:*・掟6）', () => {
  it('main/ipc/approval.ts が approval:list / approval:answer を handle し、approval:changed を push する', () => {
    const src = readCode('src/main/ipc/approval.ts')
    expect(src).toContain("ipcMain.handle('approval:list', () => listPending())")
    expect(src).toContain("ipcMain.handle('approval:answer', (_, id: string, approved: boolean) => answerApproval(id, approved))")
    expect(src).toContain("sendToWindow(deps.getMainWindow(), 'approval:changed', list)")
  })

  it('main/ipc/index.ts が registerApprovalHandlers を登録している', () => {
    const src = readCode('src/main/ipc/index.ts')
    expect(src).toContain("import { registerApprovalHandlers } from './approval'")
    expect(src).toContain('registerApprovalHandlers(deps)')
  })

  it('preload.ts が approval:* を invoke/on している', () => {
    const src = readCode('src/main/preload.ts')
    expect(src).toContain("list: () => ipcRenderer.invoke('approval:list')")
    expect(src).toContain("answer: (id: string, approved: boolean) => ipcRenderer.invoke('approval:answer', id, approved)")
    expect(src).toContain("ipcRenderer.on('approval:changed', handler)")
  })

  it('renderer/global.d.ts に approval の型宣言がある', () => {
    const src = readCode('src/renderer/global.d.ts')
    expect(src).toContain('approval: {')
    expect(src).toContain('list(): Promise<{ id: string; dir: string | null; label: string }[]>')
    expect(src).toContain('answer(id: string, approved: boolean): Promise<boolean>')
  })
})

// ── close ダイアログの実態合わせ（B'-3d-3 完了条件5）─────────────────────────
// AI応答（AI Engine・Claude 両経路）は main でターンが走り、窓を閉じても main は生き続けて
// 完走する（承認も main が駐機する・上のテスト群参照）。renderer で setBusy を張っているのは
// AI応答（useAiChat.ts）だけではなく、公開処理・VPS操作・プロジェクト作成にもある（beginActivity
// の呼び出し元・src/renderer/activity.ts）。それらは renderer 発の処理で、窓を閉じると本当に
// 中断される——AI応答だけを「閉じる前の確認ダイアログ」の対象から外し、他は従来どおりにする。
describe('close ダイアログの実態合わせ（AI応答は対象外・公開/VPS/プロジェクト作成は従来どおり）', () => {
  it('useAiChat.ts: AI応答の beginActivity は blocksClose: false を渡す', () => {
    const src = readCode('src/renderer/hooks/useAiChat.ts')
    expect(src).toContain("beginActivity('AIが応答中', { blocksClose: false })")
  })

  it('他の beginActivity 呼び出し（公開/VPS/プロジェクト作成）は blocksClose を渡さない（既定 true のまま）', () => {
    const files = [
      ['src/renderer/components/NewProjectModal.tsx', "beginActivity('プロジェクトの作成')"],
      ['src/renderer/components/ImportFromPublishedPanel.tsx', "beginActivity('公開しているもののインポート')"],
      ['src/renderer/components/HanamiiPanel.tsx', "beginActivity('公開処理')"],
      ['src/renderer/components/VercelPanel.tsx', "beginActivity('公開処理')"],
      ['src/renderer/components/VpsPanel.tsx', "beginActivity('VPSの処理')"],
    ] as const
    for (const [file, needle] of files) {
      const src = readCode(file)
      expect(src).toContain(needle)
    }
  })

  it('activity.ts: blocksClose: false は _blockingCount に数えない（_activeCount には数える）', () => {
    const src = readCode('src/renderer/activity.ts')
    expect(src).toContain('const blocksClose = opts?.blocksClose !== false')
    expect(src).toContain('if (blocksClose) { blockingCount++; blockingLabels.push(label) }')
  })

  it('main.ts: close ハンドラは closeBlockingBusy を見る（isBusy 全体ではない）', () => {
    const src = readCode('src/main/main.ts')
    const start = src.indexOf("mainWindow.on('close', async (e) => {")
    expect(start).toBeGreaterThan(-1)
    // readCode は // コメント行を丸ごと落とすので、境界は実コード（次の判定文）で取る
    const end = src.indexOf('if (!hasUnsavedChanges) return', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).toContain('if (closeBlockingBusy) {')
    expect(block).not.toContain('if (isBusy) {')
    expect(block).toContain('closeBlockingBusy = false')
  })

  it('main.ts: setBusy は4引数（busy/label は自動更新ゲート用・closeBlockingBusy/Label は close 用）を受け取る', () => {
    const src = readCode('src/main/main.ts')
    expect(src).toContain('setBusy: (busy: boolean, label: string, closeBlocking: boolean, closeBlockingLabelArg: string) => {')
    expect(src).toContain('isBusy = busy')
    expect(src).toContain('closeBlockingBusy = closeBlocking')
  })

  it('main.ts: 自動更新ゲート isBusy()/busyLabel() は従来どおり（AI応答も含めて見る）', () => {
    const src = readCode('src/main/main.ts')
    expect(src).toContain('isBusy: () => isBusy,')
    expect(src).toContain('busyLabel: () => busyLabel,')
  })

  it('IPC 3点セット: win:busy が4引数で通っている（ipc/window.ts・preload.ts・global.d.ts）', () => {
    const win = readCode('src/main/ipc/window.ts')
    expect(win).toContain("ipcMain.on('win:busy', (_, busy: boolean, label: string, closeBlockingBusy: boolean, closeBlockingLabel: string) => {")
    expect(win).toContain('deps.setBusy(busy, label, closeBlockingBusy, closeBlockingLabel)')

    const preload = readCode('src/main/preload.ts')
    expect(preload).toContain('setBusy: (busy: boolean, label: string, closeBlockingBusy: boolean, closeBlockingLabel: string) =>')
    expect(preload).toContain("ipcRenderer.send('win:busy', busy, label, closeBlockingBusy, closeBlockingLabel)")

    const dts = readCode('src/renderer/global.d.ts')
    expect(dts).toContain('setBusy(busy: boolean, label: string, closeBlockingBusy: boolean, closeBlockingLabel: string): void')
  })
})

// ── 実駆動: decideApproval（判定→駐機→回答→文面の一連の流れ）──────────────────
//
// なぜソース読みだけでは足りないか（2026-08-31 ミューテーション試験の実測）:
// 「plan を無視して常に null を返す」変異（`if (plan || !plan) return null`）は、
// planApproval / requestApproval の呼び出し文字列が残ったままなので、ソース読みの
// 固定を全部すり抜けた。承認は最重要の守りなので、実際に呼んで振る舞いで固定する
// （approvalStore はリスナー差し替えで electron 非依存のまま往復を試せる）。
import { decideApproval } from '../src/main/chat/turnRunner'
import {
  setApprovalListener, answerApproval, listPending, resetApprovalsForTest,
} from '../src/main/chat/approvalStore'
import { writeDenialMessage, runCommandDenialMessage } from '../src/shared/approvalPlan'

function payloadWith(writeMode: 'auto' | 'confirm'): any {
  return { turnId: 't-test', spec: { toolsProjectDir: '/tmp/proj-approval-test', turnOpts: { writeMode } } }
}

describe('実駆動: decideApproval', () => {
  beforeEach(() => { resetApprovalsForTest(); setApprovalListener(null) })

  it('★★ おまかせ（auto）の write_file は、駐機せず即 null（承認なしで実行）', async () => {
    const r = await decideApproval('write_file', JSON.stringify({ path: 'a.txt' }), { writeRoot: null }, payloadWith('auto'), 't-test')
    expect(r).toBeNull()
    expect(listPending()).toEqual([]) // 保留も作られていない
  })

  it('★★ confirm の write_file は駐機し、承認すると null（実行される）', async () => {
    const p = decideApproval('write_file', JSON.stringify({ path: 'a.txt' }), { writeRoot: null }, payloadWith('confirm'), 't-test')
    // 駐機が実際に積まれている（label は planApproval の文面）
    expect(listPending().length).toBe(1)
    expect(listPending()[0].label).toBe('a.txt')
    expect(answerApproval(listPending()[0].id, true)).toBe(true)
    expect(await p).toBeNull()
  })

  it('★★ confirm の write_file を拒否すると、拒否文面（現行と同一）が返る', async () => {
    const p = decideApproval('write_file', JSON.stringify({ path: 'a.txt' }), { writeRoot: null }, payloadWith('confirm'), 't-test')
    answerApproval(listPending()[0].id, false)
    expect(await p).toBe(writeDenialMessage('write_file', JSON.stringify({ path: 'a.txt' })))
  })

  it('★★ おまかせ（auto）でも危険コマンドは駐機する（守りの本丸）。拒否で run_command の文面', async () => {
    const args = JSON.stringify({ command: 'rm -rf /' })
    const p = decideApproval('run_command', args, { writeRoot: null }, payloadWith('auto'), 't-test')
    expect(listPending().length).toBe(1) // ← 変異（plan 無視で素通り）はここで落ちる
    expect(listPending()[0].label).toContain('コマンド実行: rm -rf /')
    answerApproval(listPending()[0].id, false)
    expect(await p).toBe(runCommandDenialMessage(args))
  })

  it('★ おまかせ（auto）の安全なコマンド（ls）は駐機しない', async () => {
    const r = await decideApproval('run_command', JSON.stringify({ command: 'ls' }), { writeRoot: null }, payloadWith('auto'), 't-test')
    expect(r).toBeNull()
    expect(listPending()).toEqual([])
  })
})
