// appSessions.ts — 単独チャット（ChatApp）のセッション索引（appSessions:*）の IPC。
// 持ち主（メモリ・ファイルI/O・デバウンス保存・一度きりの移行）は src/main/appSessionsStore.ts。
// ここは ipcMain.handle への薄い配線と、main → renderer への押し出し（appSessions:changed）の
// 配線だけ（B'-3e-a・掟6: main / preload.ts / renderer/global.d.ts の3点セットを必ず同時に更新する）。
import { ipcMain, app } from 'electron'
import type { IpcDeps } from './types'
import {
  listSessions, createSession, renameSession, setSessionModel, deleteSession,
  flushAppSessions, setAppSessionsListener, ensureSessionProject, type AppSessionMeta,
} from '../appSessionsStore'
import { sendToWindow } from '../windowSend'

export function registerAppSessionsHandlers(deps: IpcDeps): void {
  // main が索引を変えるたび（create/rename/setModel/delete）renderer へ押し出す口
  // （ipc/learning.ts の learning:changed と同じ作法。sendToWindow＝ウィンドウが閉じていれば黙って捨てる）。
  setAppSessionsListener((workspaceDir, sessions) => {
    sendToWindow(deps.getMainWindow(), 'appSessions:changed', { workspaceDir, sessions })
  })

  // 一覧（初回呼び出し時、索引ファイルがまだ無ければ main 側で一度きりの移行を行う）。
  ipcMain.handle('appSessions:list', (_, workspaceDir: string) => listSessions(workspaceDir))

  ipcMain.handle('appSessions:create', (_, workspaceDir: string, meta: AppSessionMeta) => {
    createSession(workspaceDir, meta)
  })

  ipcMain.handle('appSessions:rename', (_, workspaceDir: string, id: string, title: string) => {
    renameSession(workspaceDir, id, title)
  })

  ipcMain.handle('appSessions:setModel', (_, workspaceDir: string, id: string, model: string) => {
    setSessionModel(workspaceDir, id, model)
  })

  ipcMain.handle('appSessions:delete', (_, workspaceDir: string, id: string) => {
    deleteSession(workspaceDir, id)
  })

  // その会話専用のプロジェクトを用意する（2026-09-04・掟11: チャットからの保存を無関係な
  // プロジェクトへ流し込ませないための修正。src/main/appSessionsStore.ts の ensureSessionProject）。
  ipcMain.handle('appSessions:ensureProject', (_, workspaceDir: string, id: string, projectWorkspaceDir: string, title: string) =>
    ensureSessionProject(workspaceDir, id, projectWorkspaceDir, title))

  // quit 時フラッシュ: デバウンス保存待ちの索引を、終了前に必ず書き切る
  // （ipc/learning.ts・ipc/chatStore.ts と同じ理由。appSessionsStore.ts 自身には electron を
  // 持ち込まない＝node で直接テストするため、この薄い層で登録する）。
  app.on('before-quit', () => flushAppSessions())
}
