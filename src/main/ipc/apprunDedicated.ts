// AppRun 専有型「下調べ画面」の IPC（apprunDedicated:*。roadmap #23 段階①）。
// GET のみ（clusters/plans/limits）。クラスタもアプリも作らない。
// 掟4（方式B）: 認証情報は renderer から引数で受け取るだけで、main には保存しない
// （src/main/cloud/apprunDedicated.ts と同じ方針）。
import { ipcMain } from 'electron'
import { getLimits, getWorkerClasses, getLbClasses, listClusters, type ApprunDedicatedResult } from '../cloud/apprunDedicated'
import type { CloudCredentials } from '../cloud/auth'
import type { IpcDeps } from './types'

/** renderer から渡された値が使える認証情報の形か（token/secretが非空の文字列か）。 */
function isCreds(v: unknown): v is CloudCredentials {
  const c = v as any
  return !!c && typeof c.token === 'string' && typeof c.secret === 'string' && !!c.token && !!c.secret
}

const NO_KEY: ApprunDedicatedResult = { ok: false, message: 'クラウドのAPIキーが未登録です' }

export function registerApprunDedicatedHandlers(_deps: IpcDeps) {
  // GET /limits（このプランの上限）
  ipcMain.handle('apprunDedicated:limits', async (_, auth: unknown) => {
    if (!isCreds(auth)) return NO_KEY
    return getLimits(auth)
  })

  // ワーカとロードバランサのプランをまとめて返す（画面側は1回のボタンで両方表示するため）。
  ipcMain.handle('apprunDedicated:plans', async (_, auth: unknown) => {
    if (!isCreds(auth)) return { worker: NO_KEY, lb: NO_KEY }
    const [worker, lb] = await Promise.all([getWorkerClasses(auth), getLbClasses(auth)])
    return { worker, lb }
  })

  // GET /clusters?maxItems=20（既存クラスタの件数を見るためだけに使う）
  ipcMain.handle('apprunDedicated:clusters', async (_, auth: unknown) => {
    if (!isCreds(auth)) return NO_KEY
    return listClusters(auth)
  })
}
