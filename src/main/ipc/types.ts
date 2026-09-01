// IPC 分割の共有型。main.ts が持つ状態（mainWindow・hasUnsavedChanges 等）を
// 各 registerXxxHandlers(deps) へ注入するための deps 型をここに1箇所で定義する。
// 循環 import を避けるため、ipc/ 配下からは main.ts を import しない。

import type { BrowserWindow } from 'electron'

export interface IpcDeps {
  /** 現在のメインウィンドウ（起動直後や再生成のタイミングでは null になり得る）。 */
  getMainWindow: () => BrowserWindow | null
  /** レンダラからの未保存通知（win:dirty）を反映する。 */
  setHasUnsavedChanges: (dirty: boolean) => void
  /** 保存済みで終了してよい状態にし、ウィンドウを閉じる（win:quit-after-save）。 */
  requestQuitAfterSave: () => void
  /**
   * レンダラからの実行中通知（win:busy）を反映する。
   *
   * ── busy/label と closeBlockingBusy/closeBlockingLabel の違い（B'-3d-3）─────────
   * busy/label は「何かしら実行中か」（AI応答・公開処理・VPS操作・プロジェクト作成すべて含む。
   * 自動更新の再起動ゲート `isBusy()`/`busyLabel()` はアプリごと終了するので、これを見る）。
   * closeBlockingBusy/closeBlockingLabel は「窓を閉じると本当に中断されるか」だけ（公開処理・
   * VPS操作・プロジェクト作成。AI応答は main でターンが完走するため対象外・終了確認ダイアログが見る）。
   */
  setBusy: (busy: boolean, label: string, closeBlockingBusy: boolean, closeBlockingLabel: string) => void

  // ── 読み取り側（2026-08-10 自動更新のために追加）──────────────────────
  // 「いま再起動して更新を適用してよいか」の判定に要る。書き込みだけ用意して
  // 読み取りが無かったため、判定側から状態を見られなかった。
  /** 未保存の変更があるか。 */
  hasUnsavedChanges: () => boolean
  /** 処理を実行中か（AI応答・公開処理・VPS操作・プロジェクト作成。自動更新の再起動ゲート用）。 */
  isBusy: () => boolean
  /** 実行中の処理名（利用者へ「〜が進行中です」と伝えるため）。 */
  busyLabel: () => string
}
