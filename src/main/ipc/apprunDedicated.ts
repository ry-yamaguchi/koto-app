// AppRun 専有型の IPC（apprunDedicated:*）。
// 段階①（下調べ画面。GET のみ）に加え、段階②「作る」＋④「破棄」を持つ。
// 掟4（方式B）: 認証情報は renderer から引数で受け取るだけで、main には保存しない
// （src/main/cloud/apprunDedicated.ts と同じ方針）。
import { ipcMain } from 'electron'
import { getLimits, getWorkerClasses, getLbClasses, listClusters, type ApprunDedicatedResult } from '../cloud/apprunDedicated'
import { getZones } from '../cloud/zones'
import { createClusterFlow, teardownFlow, type ApprunDedicatedClusterSpec } from '../cloud/apprunDedicatedApply'
import { readApprunDedicatedFs } from '../publishMetaFs'
import type { CloudCredentials } from '../cloud/auth'
import { SakuraCloudClient } from '../cloud/client'
import { checkBilling, type ConnCheck } from '../cloud/connectionCheck'
import type { IpcDeps } from './types'

// 請求（コスト）参照はアカウント単位（どのゾーン経由でも可）。共用型 cloud:testConnection と同じゾーン。
const BILLING_ZONE = 'is1a'

/** renderer から渡された値が使える認証情報の形か（token/secretが非空の文字列か）。 */
function isCreds(v: unknown): v is CloudCredentials {
  const c = v as any
  return !!c && typeof c.token === 'string' && typeof c.secret === 'string' && !!c.token && !!c.secret
}

const NO_KEY: ApprunDedicatedResult = { ok: false, message: 'クラウドのAPIキーが未登録です' }

/** renderer から渡された値が createClusterFlow に渡せる形か（最低限の型チェック）。 */
function isClusterSpec(v: unknown): v is ApprunDedicatedClusterSpec {
  const s = v as any
  return !!s && typeof s.name === 'string' && Array.isArray(s.ports) && typeof s.servicePrincipalID === 'string'
    && typeof s.zone === 'string' && typeof s.workerServiceClassPath === 'string' && typeof s.lbServiceClassPath === 'string'
    && typeof s.minNodes === 'number' && typeof s.maxNodes === 'number'
}

export function registerApprunDedicatedHandlers(_deps: IpcDeps) {
  // 接続テスト（roadmap #35）＝共用型 cloud:testConnection と同じ「チェックリスト」の形に揃える。
  // (1) 専有型API 参照（制限・プラン。GET /limits） (2) 請求（コスト）参照。
  // どちらも GET のみ（読み取り専用・何も作らない）。
  // レジストリはまだ専有型からのアプリ公開に対応していないため、今日の時点では確認しない
  // （画面側の注記で案内する）。請求チェックは共用型と同じ関数を呼ぶ（判断・表示を複製しない・掟10）。
  ipcMain.handle('apprunDedicated:testConnection', async (_, auth: unknown) => {
    if (!isCreds(auth)) {
      const ng: ConnCheck = { ok: false, message: 'クラウドのAPIキーが未登録です' }
      return { ok: false, checks: { api: ng, billing: ng } }
    }
    const limits = await getLimits(auth)
    const api: ConnCheck = limits.ok ? { ok: true } : { ok: false, message: limits.message }

    const client = new SakuraCloudClient({ credentials: auth, dryRun: true })
    const billing = await checkBilling(client, BILLING_ZONE)

    return { ok: api.ok && billing.ok, checks: { api, billing } }
  })

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

  // GET /zone（さくらのクラウド API v1.1 設備関連API・roadmap #28）。⑤のゾーン選択式化に使う。
  // GETのみ・src/main/cloud/zones.ts に一元化（ここではキー確認と委譲だけ）。
  ipcMain.handle('apprunDedicated:zones', async (_, auth: unknown) => {
    if (!isCreds(auth)) return NO_KEY
    return getZones(auth)
  })

  // 段階②「作る」: クラスタ→ASG→LB の順で作り、各段の成功直後に .sakuraide.json へ記録する。
  // 同意（consentedAt）が記録に無ければ createClusterFlow 自身が API を一度も呼ばずに中止する。
  ipcMain.handle('apprunDedicated:create', async (_, projectDir: unknown, auth: unknown, spec: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, stage: 'consent', message: 'プロジェクトフォルダが不正です' }
    if (!isCreds(auth)) return { ok: false, stage: 'consent', message: 'クラウドのAPIキーが未登録です' }
    if (!isClusterSpec(spec)) return { ok: false, stage: 'consent', message: '入力が不正です' }
    return createClusterFlow(auth, projectDir, spec)
  })

  // 段階④「破棄」: 記録にある ID だけを LB→ASG→クラスタ の順で削除する。
  ipcMain.handle('apprunDedicated:teardown', async (_, projectDir: unknown, auth: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, executed: [], message: 'プロジェクトフォルダが不正です', remaining: {} }
    if (!isCreds(auth)) return { ok: false, executed: [], message: 'クラウドのAPIキーが未登録です', remaining: {} }
    return teardownFlow(auth, projectDir)
  })

  // 現在の記録（何が作られているか）を返す。API を呼ばない、ただのファイル読み取り。
  ipcMain.handle('apprunDedicated:state', async (_, projectDir: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return {}
    return readApprunDedicatedFs(projectDir)
  })
}
