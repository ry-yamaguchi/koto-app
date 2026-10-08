// プロジェクトごとの「いま走っている操作」と「終わった操作」の記録を renderer へ渡す IPC（projectOps:*）。
//
// 持ち主は src/main/projectOps.ts（メモリ上の記録。withProjectLock が始まり・終わりを自動で書く）。
// ここは ipcMain.handle への薄い配線と、main → renderer の押し出し（projectOps:changed）だけ
// （掟6: main／preload.ts／renderer/global.d.ts の3点セットを同時に更新する）。
//
// 使い方（画面）:
//   ・ダイアログを開いたとき `get(projectDir)` → `running` があれば「いま進んでいます」と進み具合を出す。
//     `last`（と `earlier`）があれば、終わった結果と警告を出す。出したら `ack(projectDir, last.startedAt)`。
//   ・開いている間は `onChanged` で最新化する（進み具合・終わった知らせが押し出される）。
//     **別のプロジェクトの知らせは無視する**（掟11）。
import { ipcMain } from 'electron'
import * as path from 'path'
import type { IpcDeps } from './types'
import { getOps, ackOps, setProjectOpsListener } from '../projectOps'
import { sendToWindow } from '../windowSend'

function isProjectDir(x: unknown): x is string {
  return typeof x === 'string' && x !== '' && path.isAbsolute(x)
}

export function registerProjectOpsHandlers(deps: IpcDeps): void {
  // 記録が変わるたび（始まった・進んだ・終わった・見たことにした）renderer へ押し出す。
  // ipc/appSessions.ts と同じ作法（sendToWindow＝ウィンドウが閉じていれば黙って捨てる）。
  // 押し出しは「いま」を知らせるだけ。閉じていた間の分は、開き直したときの `get` が返す。
  setProjectOpsListener((projectDir, snapshot) => {
    sendToWindow(deps.getMainWindow(), 'projectOps:changed', { projectDir, ...snapshot })
  })

  // { running, last, earlier }。何も無ければ { running: null, last: null, earlier: [] }。
  ipcMain.handle('projectOps:get', (_, projectDir: unknown) => {
    if (!isProjectDir(projectDir)) return { running: null, last: null, earlier: [] }
    return getOps(projectDir)
  })

  // 結果を見せたと伝える。`upToStartedAt`（見せた記録の startedAt）を渡すと、その記録までだけ見たことにする
  // ——見せている間に次の操作が終わっても、その結果を消さない。省略すると、いま見られていない記録すべて。
  ipcMain.handle('projectOps:ack', (_, projectDir: unknown, upToStartedAt?: unknown) => {
    if (!isProjectDir(projectDir)) return { ok: false as const, message: 'プロジェクトフォルダが不正です' }
    const upTo = typeof upToStartedAt === 'number' ? upToStartedAt : undefined
    return { ok: true as const, acked: ackOps(projectDir, upTo) }
  })
}
