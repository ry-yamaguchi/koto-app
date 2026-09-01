// approval.ts — 承認（approveToolCall）の IPC（approval:*）。B'-3d-3。
// 持ち主（メモリ・帳簿）は src/main/chat/approvalStore.ts。ここは ipcMain.handle への薄い配線と、
// main → renderer への押し出し（approval:changed）の配線だけ（掟6・learning.ts と同じ作法）。
//
// ── なぜ IPC を分けたか ─────────────────────────────────────────────
// 承認はもう chatTurn:ask（askBridge 経由の問い合わせ）を通らない（turnRunner.ts が
// approvalStore.ts を直接呼ぶ）。renderer 側は「いま何が承認待ちか」を知る必要があり、
// それは特定の turnId に紐づかない（窓の再作成・リロード後も引き続き見えるべき）ため、
// chatTurn:* の枠の外に独立した IPC を持つ。
import { ipcMain } from 'electron'
import type { IpcDeps } from './types'
import { listPending, answerApproval, setApprovalListener } from '../chat/approvalStore'
import { sendToWindow } from '../windowSend'

export function registerApprovalHandlers(deps: IpcDeps): void {
  // 承認待ち一覧が変わるたび（requestApproval で増える・answerApproval で減る）renderer へ
  // 最新の一覧を push する（ipc/learning.ts の setLearningListener と同じ作法）。
  setApprovalListener((list) => {
    sendToWindow(deps.getMainWindow(), 'approval:changed', list)
  })

  // 画面が（再）起動したときの取りこぼし回収（駐機の再提示）に使う。
  ipcMain.handle('approval:list', () => listPending())

  // renderer からの回答（許可=true／拒否=false）。知らない id・二重回答は false が返る
  // （approvalStore.ts の answerApproval 参照）。
  ipcMain.handle('approval:answer', (_, id: string, approved: boolean) => answerApproval(id, approved))
}
