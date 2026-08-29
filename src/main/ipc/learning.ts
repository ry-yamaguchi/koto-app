// learning.ts — モデルの「ツール対応」「画像対応」学習キャッシュ（learning:*）の IPC。
// 持ち主（メモリ・ファイルI/O・デバウンス保存）は src/main/learningStore.ts。ここは
// ipcMain.handle への薄い配線と、main → renderer への押し出し（learning:changed）の配線だけ
// （B'-3d-1a・掟6: main / preload.ts / renderer/global.d.ts の3点セットを必ず同時に更新する）。
//
// ── なぜ main へ持ち主を移したか ──────────────────────────────────────
// 今まで renderer の localStorage が持ち主で、main のループ（turnRunner.ts）からは ask
// （main→renderer の問い合わせ）で読み書きしていた。ask はウィンドウが生きていることが
// 前提なので、「窓を閉じても作業が続く」（B'-3d）を阻む ask 18本のうち6本がこれだった。
// main が直接ファイルへ読み書きすれば、その6本が要らなくなる（chatTurnRpc.ts の ASK_PATHS
// から削り、turnRunner.ts の buildMainPorts で learningStore を直呼びする）。
import { ipcMain, app } from 'electron'
import type { IpcDeps } from './types'
import {
  getLearning, recordLearning, forgetLearning, mergeMigration, flushLearningNow, setLearningListener,
  type LearningKind,
} from '../learningStore'
import { sendToWindow } from '../windowSend'

export function registerLearningHandlers(deps: IpcDeps): void {
  // main が学習記録を変えるたび（record/forget/migrate）renderer の写し（learningMirror.ts）を
  // 最新化する押し出し口。ipc/chatStore.ts の chat:applied（convStore.setApplyListener）と
  // 同じ作法（sendToWindow＝ウィンドウが閉じていれば黙って捨てる）。
  setLearningListener((snapshot) => {
    sendToWindow(deps.getMainWindow(), 'learning:changed', snapshot)
  })

  ipcMain.handle('learning:get', () => getLearning())

  ipcMain.handle('learning:record', (_, kind: LearningKind, model: string, supported: boolean) => {
    recordLearning(kind, model, supported)
  })

  ipcMain.handle('learning:forget', (_, kind: LearningKind, model?: string) => {
    forgetLearning(kind, model)
  })

  // 旧 renderer/localStorage からの片道移行（learningMirror.ts の primeLearningMirror が
  // 起動のたび呼ぶ）。mergeMigration 自身が「新しい at だけ勝つ」ため、何度呼ばれても安全。
  ipcMain.handle('learning:migrate', (_, payload: { toolSupport?: unknown; visionSupport?: unknown }) => {
    mergeMigration(payload)
  })

  // quit 時フラッシュ: デバウンス保存待ちの学習記録を、終了前に必ず書き切る
  // （ipc/chatStore.ts の convStore 用フラッシュと同じ理由。learningStore.ts 自身には
  // electron を持ち込まない＝node で直接テストするため、この薄い層で登録する）。
  app.on('before-quit', () => flushLearningNow())
}
