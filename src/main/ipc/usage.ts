// usage.ts — 予算設定・利用実績（usage:*）の IPC。持ち主（メモリ・ファイルI/O・デバウンス保存）は
// src/main/usageStore.ts。ここは ipcMain.handle への薄い配線と、main → renderer への押し出し
// （usage:changed）の配線だけ（B'-3d-1b・掟6: main / preload.ts / renderer/global.d.ts の3点セットを
// 必ず同時に更新する）。
//
// ── なぜ main へ持ち主を移したか ──────────────────────────────────────
// 今まで renderer の localStorage が持ち主で、main のループ（turnRunner.ts）からは ask
// （main→renderer の問い合わせ）で読み書きしていた（usage.check・usage.record）。ask は
// ウィンドウが生きていることが前提なので、「窓を閉じても作業が続く」（B'-3d）を阻む ask のうち
// 2本がこれだった。main が直接ファイルへ読み書きすれば、その2本が要らなくなる
// （chatTurnRpc.ts の ASK_PATHS から削り、turnRunner.ts の buildMainPorts で usageStore を直呼びする）。
//
// ⚠️ usage:check に対応する IPC ハンドラは無い。main のターン（turnRunner.ts）は usageStore の
// checkBeforeRequest を直接呼ぶので不要。renderer 側の判定（renderer/usage.ts の
// checkBeforeRequest）も IPC を経由せず、写し（usageMirror.ts）に対して shared の
// checkBeforeRequestOf を直接呼ぶ（同期で読める必要があるため）。
import { ipcMain, app } from 'electron'
import type { IpcDeps } from './types'
import {
  getUsageSnapshot, recordUsage, setSettings, setKeyLimit, resetThisMonth, mergeMigration,
  flushUsageNow, setUsageListener,
} from '../usageStore'
import { sendToWindow } from '../windowSend'

export function registerUsageHandlers(deps: IpcDeps): void {
  // main が利用実績・設定を変えるたび（record/setSettings/setKeyLimit/reset/migrate）
  // renderer の写し（usageMirror.ts）を最新化する押し出し口。ipc/learning.ts と同じ作法
  // （sendToWindow＝ウィンドウが閉じていれば黙って捨てる）。
  setUsageListener((snapshot) => {
    sendToWindow(deps.getMainWindow(), 'usage:changed', snapshot)
  })

  ipcMain.handle('usage:get', () => getUsageSnapshot())

  ipcMain.handle('usage:record', (_, fp: string, model: string, promptTokens: number, completionTokens: number) => {
    recordUsage(fp, model, promptTokens, completionTokens)
  })

  ipcMain.handle('usage:setSettings', (_, raw: unknown) => {
    setSettings(raw)
  })

  // limit の undefined は IPC 越しでは「省略」と区別しにくいため使わない。「消す」は
  // 明示的に { clear: true } を渡す形にする（usageStore.ts の setKeyLimit の注記）。
  ipcMain.handle('usage:setKeyLimit', (_, fp: string, limit: number | null | { clear: true }) => {
    setKeyLimit(fp, limit)
  })

  ipcMain.handle('usage:reset', () => {
    resetThisMonth()
  })

  // 旧 renderer/localStorage からの片道移行（usageMirror.ts の primeUsageMirror が起動のたび
  // 呼ぶ）。mergeMigration 自身が「migrated なら何もしない」ため、何度呼ばれても二重計上しない。
  ipcMain.handle('usage:migrate', (_, payload: { settings?: unknown; months?: unknown }) => {
    mergeMigration(payload)
  })

  // quit 時フラッシュ: デバウンス保存待ちの利用実績・設定を、終了前に必ず書き切る
  // （ipc/learning.ts と同じ理由。usageStore.ts 自身には electron を持ち込まない＝node で
  // 直接テストするため、この薄い層で登録する）。
  app.on('before-quit', () => flushUsageNow())
}
