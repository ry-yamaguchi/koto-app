// confirmedActions.ts — ChatPanel/ChatApp/EditorPanel/CredentialsModal の「元に戻せない操作」の
// confirm→実行ゲートを、React/DOM から切り離した純関数として持つ（掟10・rollbackSwitch.ts・
// apprunDedicatedActions.ts と同型）。
//
// UX-B2（8cb407b）で window.confirm を ConfirmModal（useConfirm）に置き換えた10箇所は、
// 「confirm が false なら実行しない」という歯止めがコンポーネントの中に
// `if (!ok) return` という**文字列**でしか存在せず、`if (false && !ok) return` に変異させても
// tests/confirmModalWiring.test.ts（文字列・順序しか見ていない）は素通りした（担当の申告・2026-09-11）。
// ここでは元に戻せない5箇所だけを対象に、confirm と「実際の実行」を deps として注入する形に切り出し、
// 偽の confirm/実行関数を渡した振る舞いテスト（tests/confirmedActions.test.ts）で
// 「confirm が false を返したら実行は一度も呼ばれない」ことを固定する（文字列一致ではない）。
//
// ゴミ箱への移動（Sidebar・AppRunPanel の古いイメージ・UnusedFilesSection）と
// WorkflowBar のツール導入は「戻せる／有益な操作」なので対象外（仕様書の判断のまま）。
//
// ── rollbackSwitch.ts / apprunDedicatedActions.ts との違い ─────────────────────
// あちらの ConfirmFn は `(message: string) => boolean`（同期）——main 側の他の歯止め
// （performRollback・apprunDedicatedApply）や activity.ts の begin/end と順序を厳密に揃える
// 必要があり、呼び出し元が「先に await confirm(...) で答えを得てから、確定済みの boolean を
// 返すだけの同期関数」を渡す形にしてある（useConfirm.tsx のコメント参照）。
// ここの5操作にはそのような追加の同期要件（activity 登録・main 側の別の歯止め）が無いため、
// ConfirmFn はそのまま非同期（`(message: string) => Promise<boolean>`）にし、各 runXxx は
// `await deps.confirm(message)` を直接待つ。呼び出し元（各コンポーネント）は
// `useConfirm().confirm`（ConfirmOptions を取る）をそのまま渡さず、
// `(message) => confirm({ title, body: message, confirmLabel, danger })` という薄いラッパーを
// deps.confirm として渡す。文言（body）は各コンポーネントが既存の文のまま組み立てて渡す。

export type ConfirmFn = (message: string) => Promise<boolean>

export type ActionOutcome<R> = { cancelled: true } | { cancelled: false; result: R }

async function gate<R>(message: string, confirm: ConfirmFn, execute: () => R | Promise<R>): Promise<ActionOutcome<R>> {
  const ok = await confirm(message)
  if (!ok) return { cancelled: true }
  const result = await execute()
  return { cancelled: false, result }
}

// ── ChatPanel.tsx: 会話の全削除 ──────────────────────────────────────────────

export interface RunClearConversationDeps {
  confirm: ConfirmFn
  clear: () => void
}

/**
 * confirm を通ったときだけ clear を呼ぶ。confirm が false（キャンセル）なら
 * clear には一切触れない（＝会話は消えない）。
 */
export async function runClearConversation(message: string, deps: RunClearConversationDeps): Promise<ActionOutcome<void>> {
  return gate(message, deps.confirm, () => deps.clear())
}

// ── ChatApp.tsx: 会話の削除 ──────────────────────────────────────────────────

export interface RunDeleteConversationDeps {
  confirm: ConfirmFn
  remove: (id: string) => void | Promise<void>
}

/**
 * confirm を通ったときだけ remove(id) を呼ぶ。confirm が false（キャンセル）なら
 * remove には一切触れない（＝会話もセッション記録も消えない）。
 */
export async function runDeleteConversation(id: string, message: string, deps: RunDeleteConversationDeps): Promise<ActionOutcome<void>> {
  return gate(message, deps.confirm, () => deps.remove(id))
}

// ── EditorPanel.tsx: 未保存の変更を破棄して閉じる ────────────────────────────

export interface RunCloseUnsavedDeps {
  confirm: ConfirmFn
  close: (path: string) => void
}

/**
 * confirm を通ったときだけ close(path) を呼ぶ。confirm が false（キャンセル）なら
 * close には一切触れない（＝未保存の変更は残ったまま、タブも閉じない）。
 */
export async function runCloseUnsaved(path: string, message: string, deps: RunCloseUnsavedDeps): Promise<ActionOutcome<void>> {
  return gate(message, deps.confirm, () => deps.close(path))
}

// ── CredentialsModal.tsx: 未保存の変更を破棄 ─────────────────────────────────

export interface RunDiscardCredentialEditsDeps {
  confirm: ConfirmFn
  discard: () => void
}

/**
 * confirm を通ったときだけ discard を呼ぶ（＝閉じる）。confirm が false（キャンセル）なら
 * discard には一切触れない（＝モーダルは開いたまま、未保存の変更も残る）。
 */
export async function runDiscardCredentialEdits(message: string, deps: RunDiscardCredentialEditsDeps): Promise<ActionOutcome<void>> {
  return gate(message, deps.confirm, () => deps.discard())
}

// ── CredentialsModal.tsx: VPS の鍵を消去 ─────────────────────────────────────

export interface RunEraseVpsKeyDeps {
  confirm: ConfirmFn
  erase: (entryId: string) => void | Promise<void>
}

/**
 * confirm を通ったときだけ erase(entryId) を呼ぶ。confirm が false（キャンセル）なら
 * erase には一切触れない（＝鍵は消えない）。
 */
export async function runEraseVpsKey(entryId: string, message: string, deps: RunEraseVpsKeyDeps): Promise<ActionOutcome<void>> {
  return gate(message, deps.confirm, () => deps.erase(entryId))
}
