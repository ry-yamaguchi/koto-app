// approvalPlan.ts — ツール実行の承認（approveToolCall）の要否判定・ダイアログ文面・
// 拒否時にAIへ返す文面（B'-3d-3）。
//
// ── なぜここにあるか ──────────────────────────────────────────────────
// 承認は「ユーザーの資産を守る最後の砦」（掟10）。これまでは renderer
// （ChatPanel.tsx の approveToolCall クロージャ）だけが持っていた判定を、main
// （src/main/chat/turnRunner.ts）へ一元化する。判定・文面組み立ては window/electron に
// 依存しない純関数なので shared に置き、main が直接呼ぶ。renderer は「main が組み立てた
// 文面を出して答えるだけ」の純UI（ChatPanel.tsx の承認ダイアログ）になる。
//
// 判定・文面は、B'-3d-3 直前の ChatPanel.tsx の approveToolCall クロージャと**一字一句同じ**
// （tests/planApproval.test.ts が「止めるべき例・通すべき例」の対で固定する・掟10）。

import { requiresConfirmation, confirmReason } from './aiToolsCore'
import { commandScopeNote } from './commandGuard'

/** AIによるファイル保存の権限モード（'auto'=おまかせで自動保存 / 'confirm'=毎回確認）。 */
export type WriteMode = 'auto' | 'confirm'

export type PlanApprovalOpts = {
  writeMode: WriteMode
  /** このターンが縛られているプロジェクト（🕘 履歴・install の package.json 読み取りに使う）。 */
  scopeDir?: string | null
  /** 実際に実行される根（write_file 等の書き込み先）。commandScopeNote の「実行先」に使う。 */
  scopeRoot?: string | null
  /** install 系コマンドで package.json から読めた依存名（読めなければ空・呼び出し側が渡す）。 */
  deps?: string[]
}

/** 承認要のときにダイアログへ出す文面。 */
export type ApprovalRequest = { label: string }

/**
 * このツール呼び出しに承認が要るか、要るならダイアログに出す文面を判定する（純関数）。
 *
 * 戻り値: `null` = 承認不要（そのまま実行）／`{ label }` = 承認要（label をダイアログに出す）。
 *
 * 判定は write_file/edit_file（confirm モードのときだけ）と run_command（confirm モード、
 * または requiresConfirmation が真のとき）の2種類。それ以外のツールは常に null（承認不要）。
 */
export function planApproval(toolName: string, toolArgsJson: string, opts: PlanApprovalOpts): ApprovalRequest | null {
  // 「毎回確認」モードでは、ファイル保存（全文上書き／部分編集）の前にユーザーの許可を取る。
  // edit_file も write_file と同じくファイルを書き換える破壊的操作のため、同じ扱いにする。
  if ((toolName === 'write_file' || toolName === 'edit_file') && opts.writeMode === 'confirm') {
    let relPath = ''
    try { relPath = JSON.parse(toolArgsJson || '{}').path ?? '' } catch { /* パス不明でも確認は出す */ }
    const isEdit = toolName === 'edit_file'
    return { label: `${relPath || '(不明なファイル)'}${isEdit ? '（部分編集）' : ''}` }
  }
  // コマンド実行：危険なコマンドは常に、また「毎回確認」モードでは全コマンドで許可を取る
  if (toolName === 'run_command') {
    let cmd = ''
    try { cmd = JSON.parse(toolArgsJson || '{}').command ?? '' } catch { /* 不明でも確認は出す */ }
    if (opts.writeMode === 'confirm' || requiresConfirmation(cmd)) {
      const reason = requiresConfirmation(cmd) ? `\n理由: ${confirmReason(cmd, { dependencies: opts.deps ?? [] })}` : ''
      // **いつもと違う場所なら、そのことだけを名前で伝える**（2026-08-24 の実害）。
      const scopeNote = commandScopeNote(opts.scopeDir, opts.scopeRoot)
      return { label: `コマンド実行: ${cmd || '(不明)'}${scopeNote}${reason}` }
    }
  }
  return null // 許可不要
}

/** write_file/edit_file が拒否されたとき、AIへ返す文面（現行 ChatPanel.tsx と同一）。 */
export function writeDenialMessage(toolName: string, toolArgsJson: string): string {
  let relPath = ''
  try { relPath = JSON.parse(toolArgsJson || '{}').path ?? '' } catch { /* パス不明でも文面は返す */ }
  const isEdit = toolName === 'edit_file'
  const action = isEdit ? '編集' : '保存'
  return `ユーザーが ${relPath || 'このファイル'} の${action}を許可しませんでした。${action}せずに、どう進めるべきかユーザーに確認してください。`
}

/** run_command が拒否されたとき、AIへ返す文面（現行 ChatPanel.tsx と同一）。 */
export function runCommandDenialMessage(toolArgsJson: string): string {
  let cmd = ''
  try { cmd = JSON.parse(toolArgsJson || '{}').command ?? '' } catch { /* 不明でも文面は返す */ }
  return `ユーザーがコマンド「${cmd}」の実行を許可しませんでした。実行せずに、どう進めるべきかユーザーに確認してください。`
}
