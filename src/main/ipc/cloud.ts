// さくらのクラウド連携（実行系）の IPC（cloud:plan/apply/teardown/env/cost/accessLimit 等。キー系は cloudKeys.ts）。
// env.json / state.json の読み書きヘルパもここに移動。deps は使わない（認証情報は cloud/auth から読む）。
import { ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { randomBytes } from 'crypto'
import { validateSpec, defaultSpec, normalizeSpecName, type EnvSpec } from '../cloud/spec'
import { computePlan, type Plan } from '../cloud/planner'
import { emptyState, isExpired, registryDeletionTarget, registryLookupNames, resolvePushRegistry, stateToSave, type EnvState } from '../cloud/state'
import { loadCredentials, type CloudCredentials } from '../cloud/auth'
import {
  hasRegistryCredentials,
  saveRegistryCredentials,
  loadRegistryCredentials,
  clearRegistryCredentials,
  registryServer,
} from '../cloud/registry-auth'
import { SakuraCloudClient, pickContainerRegistries, extractRegistryId, extractAppUrl, extractLatestBill, extractAccountId, apiErrorMessage } from '../cloud/client'
import { applyPlan } from '../cloud/apply'
import { createStorageAdapter, type StorageAdapter } from '../cloud/storageAdapter'
import { buildRef, dockerAvailable, buildImage, loginRegistry, pushImage } from '../cloud/docker'
import { builderAvailable, buildAndPush } from '../cloud/imageBuild'
import { detectRuntime, type RuntimeChoice } from '../../shared/runtimeDetect'
import { planDependencies, installTimeNote } from '../../shared/deps'
import type { IpcDeps } from './types'

// ── さくらのクラウド連携（段階1＝基盤）。cloud: 名前空間 ──
// env.json / state.json は プロジェクト内 `.sakura-cloud/` に置く。
// state.json はユーザー非編集（IDEが作成済みリソースを記録する内部ファイル）。
const CLOUD_DIR = '.sakura-cloud'
const CLOUD_ENV_FILE = 'env.json'
const CLOUD_STATE_FILE = 'state.json'

/** projectDir 内の .sakura-cloud/<file> の絶対パスを返す（プロジェクト外への脱出を防ぐ）。 */
function cloudFilePath(projectDir: string, file: string): string {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    throw new Error('プロジェクトフォルダのパスが不正です')
  }
  const full = path.normalize(path.join(projectDir, CLOUD_DIR, file))
  const base = path.normalize(path.join(projectDir, CLOUD_DIR))
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('不正なパスです（プロジェクトの外は操作できません）')
  }
  return full
}

// ── 段階2a: 構築/破棄の実行層（メインプロセス） ──

/** projectDir の state.json を読む（無ければ空state）。env.json の name/backend を既定に使う。 */
function loadCloudState(projectDir: string, spec: EnvSpec): EnvState {
  const stateFile = cloudFilePath(projectDir, CLOUD_STATE_FILE)
  if (!fs.existsSync(stateFile)) return emptyState(spec.name, spec.backend)
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
  return {
    name: typeof parsed?.name === 'string' ? parsed.name : spec.name,
    backend: typeof parsed?.backend === 'string' ? parsed.backend : spec.backend,
    resources: Array.isArray(parsed?.resources) ? parsed.resources : [],
    ...(parsed?.meta && typeof parsed.meta === 'object' ? { meta: parsed.meta } : {}),
  }
}

/** state.json を書き込む（.sakura-cloud を作成）。 */
function saveCloudState(projectDir: string, state: EnvState): void {
  const stateFile = cloudFilePath(projectDir, CLOUD_STATE_FILE)
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

/** env.json を読んで検証済み spec を返す（無ければ null・不正なら throw）。 */
function loadCloudSpec(projectDir: string): EnvSpec | null {
  const envFile = cloudFilePath(projectDir, CLOUD_ENV_FILE)
  if (!fs.existsSync(envFile)) return null
  const result = validateSpec(JSON.parse(fs.readFileSync(envFile, 'utf-8')))
  if (!result.ok) throw new Error(result.errors.join(' / '))
  return result.spec
}

/**
 * dockerfile ソースのビルドコンテキスト絶対パスを、プロジェクト内に閉じ込めて解決する。
 * context が絶対パスや .. でプロジェクト外を指す場合は throw（confineToProject 相当）。
 */
function resolveBuildContext(projectDir: string, context: string): string {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    throw new Error('プロジェクトフォルダのパスが不正です')
  }
  if (typeof context !== 'string' || context.length === 0) {
    throw new Error('ビルドコンテキストが不正です')
  }
  if (path.isAbsolute(context)) {
    throw new Error('ビルドコンテキストに絶対パスは指定できません')
  }
  const full = path.normalize(path.join(projectDir, context))
  if (full !== projectDir && !full.startsWith(projectDir + path.sep)) {
    throw new Error('不正なビルドコンテキストです（プロジェクトの外は指定できません）')
  }
  return full
}

/**
 * プロジェクトを見て、何で動かすかを決める（IO はここだけ。判断は shared）。
 * package.json が壊れていても落ちない（読めなければ「無い」として扱う）。
 */
function detectRuntimeFor(contextAbs: string): RuntimeChoice {
  let packageJson: unknown = null
  try {
    const p = path.join(contextAbs, 'package.json')
    if (fs.existsSync(p)) packageJson = JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    // 壊れた package.json は「無い」とはしない。**静的だと決めつけると
    // ソースが丸見えになる**ので、直してもらうよう伝える
    return { kind: 'unsupported', reason: 'package.json を読み取れませんでした。書式（JSON）が正しいか確認してください。' }
  }
  let fileNames: string[] = []
  try {
    fileNames = fs.readdirSync(contextAbs, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name)
  } catch { fileNames = [] }
  return detectRuntime({ packageJson, fileNames })
}

/** プロジェクト直下の package.json を読む（無い・壊れていれば null）。 */
function readProjectPackageJson(contextAbs: string): unknown {
  try {
    const p = path.join(contextAbs, 'package.json')
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null
  } catch {
    return null
  }
}

/**
 * アプリが動き出すまで待つ（IO はここ。判断は shared/appHealth.ts）。
 *
 * さくらは公開の直後しばらく `Deploying` を返す。**待たずに聞くと、失敗も成功も
 * 分からない。** かといって無限には待てないので、上限を決めて打ち切り、
 * 打ち切ったことを利用者に伝える（黙って成功にしない）。
 */
async function waitForHealthy(
  client: SakuraCloudClient,
  appId: string,
  progress: (m: string) => void,
): Promise<AppHealth> {
  const waits = [3000, 5000, 8000, 12000, 20000] // 合計48秒まで
  let last = judgeAppHealth({ status: 'Unknown' })
  for (let i = 0; i <= waits.length; i++) {
    const res = await client.getAppStatus(appId)
    if (res.dryRun === false && res.ok) {
      const { status, message } = parseAppStatus(res.data)
      last = judgeAppHealth({ status, message, timedOut: i === waits.length })
      if (!last.pending) return last
    } else if (res.dryRun === false && !res.ok) {
      // 状態を取れないだけでアプリは動いているかもしれない。**失敗とは言い切らない**
      return judgeAppHealth({ status: 'Unknown' })
    }
    if (i < waits.length) {
      progress('🩺 まだ準備中です…')
      await new Promise(r => setTimeout(r, waits[i]))
    }
  }
  return last
}

/**
 * このアプリのログが残るようにする（IO はここ。判断は shared/appLog.ts）。
 *
 * **ここで失敗しても公開は失敗にしない。** ログは「動かなかったときに助かるもの」
 * であって、公開そのものの成否とは別。止めると、本題（アプリを公開する）が
 * 巻き添えになる。
 *
 * 費用の発生する操作（ログ領域の作成）はここでは行わない。**同意が要る**ので、
 * それは別の導線（設定または案内）に回し、ここは「既にあるなら繋ぐ」だけにする。
 */
async function ensureAppLogRouting(
  creds: CloudCredentials,
  appId: string,
  progress: (m: string) => void,
): Promise<void> {
  const client = new SakuraCloudClient({ credentials: creds, dryRun: false })
  const app = await client.getApp(appId)
  if (app.dryRun !== false || !app.ok) return
  const resourceId = String((app.data as any)?.resource_id ?? '')
  if (!resourceId) return

  const mon = new MonitoringClient({ credentials: creds, dryRun: false })
  const [state, storages, routings] = await Promise.all([
    mon.provisioningState(), mon.listStorages(), mon.listRoutings(),
  ])
  if (!state.ok || !storages.ok || !routings.ok) return

  const action = decideLogAction({
    storageReady: parseProvisioningState(state.data),
    storageId: pickLogStorageId(storages.data),
    alreadyRouted: hasAppLogRouting(routings.data, resourceId),
  })
  if (action.kind !== 'route') return // 'ask'（費用が要る）はここでは行わない

  progress('📋 ログを残す設定をしています…')
  await mon.createRouting({
    resourceId,
    publisherCode: APPRUN_LOG_PUBLISHER,
    variant: APPRUN_LOG_VARIANT,
    logStorageId: action.storageId,
  })
}

/**
 * このプロジェクトの古い鍵を片づける（IO はここ。判断は shared/storageKeys.ts）。
 *
 * **公開が終わっただけでは消さない。アプリが動いたと確かめてから。**
 * 実機では、デプロイ直後に消したせいで、まだ動いていた古いコンテナが 403 で落ちた。
 *
 * 片づけないと鍵が溜まる。実機では5件たまり、**消えたバケット向けのもの**まで
 * 残っていた。鍵が残るのは「消したはずの保存場所へ届く鍵が生き続ける」ことでもある。
 */
async function cleanUpOldKeys(
  storage: StorageAdapter,
  projectName: string,
  keepId: string | null,
  progress: (m: string) => void,
): Promise<void> {
  if (!keepId) return // 現役が分からないときは何もしない（いちばん危ない）
  const all = await storage.listPermissions()
  const targets = permissionsToCleanUp({ all, projectName, keepId })
  if (targets.length === 0) return
  progress('🧹 古い鍵を片づけています…')
  for (const id of targets) {
    try { await storage.deletePermission(id) } catch { /* 1つ失敗しても続ける */ }
  }
}

/** plan に apprun-app の create または update が含まれるか。 */
function planTouchesApp(plan: Plan): boolean {
  return plan.actions.some(
    a => a.kind === 'apprun-app' && (a.type === 'create' || a.type === 'update'),
  )
}

import { scanDataUsage, ensureDataLayer } from '../dataLayer'
import { ObjectStorageClient } from '../cloud/objectStorage'
import { BUCKET_MONTHLY_YEN } from '../../shared/cloudCost'
import { looksLikeRegistryProblem } from '../../shared/registryTrouble'
import { parseAppStatus, judgeAppHealth, judgeRecheck, appLogUrl, askAiAboutFailure, type AppHealth } from '../../shared/appHealth'
import { MonitoringClient } from '../cloud/monitoring'
import { decideLogAction, parseProvisioningState, pickLogStorageId, hasAppLogRouting, APPRUN_LOG_PUBLISHER, APPRUN_LOG_VARIANT } from '../../shared/appLog'
import { permissionsToCleanUp } from '../../shared/storageKeys'
import { summarizePreflight, sortChecks, type PreflightCheck } from '../../shared/preflight'
import { sharedBucketName, isValidBucketName, consentedBuckets, keepStorageFromDisk, resolvePlacement, prefixForProject, storageCostNote, KOTO_ROOT, type BucketMode } from '../../shared/objectStorage'

export function registerCloudHandlers(_deps: IpcDeps) {
  // 接続テスト＝APIキーの権限を 3 点で非破壊チェックする。
  //  (1) AppRun 参照 / (2) コンテナレジストリ 一覧 / (3) 請求（コスト）参照。
  //  いずれも GET（読み取り専用）。「作成」権限は実際に作成するまで確認できないため、
  //  ここでは参照・一覧の可否のみを確認する。
  ipcMain.handle('cloud:testConnection', async () => {
    // 各チェック結果の形（成否・HTTPステータス・失敗時メッセージ）。
    type Check = { ok: boolean; status?: number; message?: string }
    const creds = loadCredentials()
    if (!creds) {
      const ng: Check = { ok: false, message: 'クラウドのAPIキーが未登録です' }
      return { ok: false, checks: { apprun: ng, registry: ng, billing: ng }, message: '認証情報が保存されていません' }
    }
    // ドライランは mutating のみに効く。各チェックは GET なので実行される。
    const client = new SakuraCloudClient({ credentials: creds, dryRun: true })
    const zone = 'is1a' // 請求はアカウント単位（どのゾーン経由でも可）。cost ハンドラと同じ。

    // (1) AppRun 参照。testConnection() が既に必要な形を返すのでそのまま使う。
    const apprun: Check = await client.testConnection()

    // (2) コンテナレジストリ 一覧（IaaS CommonServiceItem の GET）。
    let registry: Check
    try {
      const r = await client.listContainerRegistries(zone)
      if (r.dryRun === false && r.ok) {
        registry = { ok: true, status: r.status }
      } else if (r.dryRun === false) {
        registry = {
          ok: false,
          status: r.status,
          message:
            r.status === 401 || r.status === 403
              ? '権限不足または認証失敗（コンテナレジストリ）'
              : `取得失敗 HTTP ${r.status}${apiErrorMessage(r.data) ? ' — ' + apiErrorMessage(r.data) : ''}`,
        }
      } else {
        registry = { ok: false, message: 'GETがドライラン扱いになりました（想定外）' }
      }
    } catch (e: any) {
      registry = { ok: false, message: e?.message ?? String(e) }
    }

    // (3) 請求（コスト）参照。auth-status → accountId → bill の順に GET。
    let billing: Check
    try {
      const st = await client.getAuthStatus(zone)
      if (st.dryRun === false && !st.ok) {
        billing = { ok: false, status: st.status, message: `アカウント情報の取得に失敗（HTTP ${st.status}）` }
      } else {
        const accountId = st.dryRun === false ? extractAccountId(st.data) : null
        if (!accountId) {
          billing = { ok: false, message: 'アカウントIDを取得できませんでした' }
        } else {
          const b = await client.getBillByContract(zone, accountId)
          if (b.dryRun === false && b.ok) {
            billing = { ok: true, status: b.status }
          } else {
            billing = {
              ok: false,
              status: b.dryRun === false ? b.status : undefined,
              message: `請求の取得に失敗 HTTP ${b.dryRun === false ? b.status : '?'}`,
            }
          }
        }
      }
    } catch (e: any) {
      billing = { ok: false, message: e?.message ?? String(e) }
    }

    return { ok: apprun.ok && registry.ok && billing.ok, checks: { apprun, registry, billing } }
  })

  // env.json の読み込み（無ければ null）
  ipcMain.handle('cloud:loadEnv', (_, projectDir: string) => {
    try {
      const file = cloudFilePath(projectDir, CLOUD_ENV_FILE)
      if (!fs.existsSync(file)) return { ok: true, spec: null }
      const raw = fs.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(raw)
      const result = validateSpec(parsed)
      if (!result.ok) return { ok: false, errors: result.errors }
      return { ok: true, spec: result.spec }
    } catch (e: any) {
      return { ok: false, errors: [e?.message ?? String(e)] }
    }
  })

  // env.json の書き込み（書き込み前に validateSpec を通し、不正なら error を返す）
  ipcMain.handle('cloud:saveEnv', (_, projectDir: string, spec: unknown) => {
    try {
      const result = validateSpec(spec)
      if (!result.ok) return { ok: false, errors: result.errors }
      // **保存場所の記録だけは、画面からの写しで上書きしない。**
      // 画面は開いた時点の spec を丸ごと書き戻すので、開いたあとに用意した
      // 保存場所が消える（2026-08-14 実機で発覚）。判断は shared に集約。
      let disk: EnvSpec | null = null
      try { disk = loadCloudSpec(projectDir) } catch { disk = null }
      result.spec = keepStorageFromDisk(result.spec, disk)
      const file = cloudFilePath(projectDir, CLOUD_ENV_FILE)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(result.spec, null, 2) + '\n', 'utf-8')
      return { ok: true, spec: result.spec }
    } catch (e: any) {
      return { ok: false, errors: [e?.message ?? String(e)] }
    }
  })

  // 既定スペックを生成して env.json に書き込む（プロジェクトに Dockerfile があるか自動判定）
  ipcMain.handle('cloud:scaffoldEnv', (_, projectDir: string, name: string) => {
    try {
      if (typeof name !== 'string') return { ok: false, errors: ['名前が不正です'] }
      const hasDockerfile =
        path.isAbsolute(projectDir) && fs.existsSync(path.join(projectDir, 'Dockerfile'))
      const spec = defaultSpec({ name, hasDockerfile })
      // 念のため自前の既定スペックも検証してから保存する。
      const result = validateSpec(spec)
      if (!result.ok) return { ok: false, errors: result.errors }
      const file = cloudFilePath(projectDir, CLOUD_ENV_FILE)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(result.spec, null, 2) + '\n', 'utf-8')
      return { ok: true, spec: result.spec }
    } catch (e: any) {
      return { ok: false, errors: [e?.message ?? String(e)] }
    }
  })

  // コンテナレジストリを自動作成（無ければ作成・あれば再利用）し、push用ユーザーを用意して
  // 認証情報（registry-credentials.enc）に保存する。これでコンパネでのレジストリ作成が不要になる。
  // ※実APIの形は client.ts に「要確認」として集約。実キーでの検証で確定する。
  ipcMain.handle('cloud:ensureRegistry', async (_, projectDir: string) => {
    try {
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'クラウドのAPIキーが未登録です（認証情報で登録してください）' }

      // env.json から region と name を得る（無ければ既定）。
      let region = 'is1a'
      let baseName = (typeof projectDir === 'string' ? projectDir.split('/').pop() : '') || 'app'
      try {
        const file = cloudFilePath(projectDir, CLOUD_ENV_FILE)
        if (fs.existsSync(file)) {
          const spec = JSON.parse(fs.readFileSync(file, 'utf-8'))
          if (typeof spec?.region === 'string' && spec.region) region = spec.region
          if (typeof spec?.name === 'string' && spec.name) baseName = spec.name
        }
      } catch { /* env 無し/不正は既定で続行 */ }

      // サブドメインラベル: 英小数字とハイフンのみ、先頭英数字、3〜32文字程度に整形。
      let label = baseName.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 28)
      if (label.length < 3) label = ('ide' + label).slice(0, 28)
      if (!/^[a-z0-9]/.test(label)) label = 'a' + label
      // 衝突回避用に短い乱英数を付与（同名レジストリがあれば再利用するので必須ではないが安全側）。

      const client = new SakuraCloudClient({ credentials: creds, dryRun: false })

      // push 用ユーザーの資格情報。ユーザー名は固定（増殖防止・英数字のみ）。パスワードは英数字のみ（記号で弾かれるのを回避）。
      const username = 'sakuraide'
      const password = randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) + 'Aa1'

      // 既存レジストリを探す。**このプロジェクトが記録している名前を先に試す**（registryLookupNames）。
      // 基本ラベルだけで探すと、削除直後の名前予約でサフィックス付きを作った後に見つけられず、
      // 公開や「ユーザー再設定」のたびに新しいレジストリが増えてしまう（1つにつき月220円）。
      let registryId: string | null = null
      let created = false
      const recordedState = (() => {
        try {
          const sp = loadCloudSpec(projectDir)
          return sp ? loadCloudState(projectDir, sp) : null
        } catch { return null }
      })()
      const listed = await client.listContainerRegistries(region)
      if (listed.dryRun === false && listed.ok) {
        const all = pickContainerRegistries(listed.data)
        for (const candidate of registryLookupNames(recordedState ?? {}, label)) {
          const existing = all.find(r => r.subdomainLabel === candidate)
          if (existing) {
            registryId = existing.id
            label = candidate // 以後の保存・push先も、実際に見つかった名前に揃える
            break
          }
        }
      } else if (listed.dryRun === false && (listed.status === 401 || listed.status === 403)) {
        return { ok: false, message: '認証に失敗しました（クラウドのアクセストークン/シークレットを確認してください）' }
      }

      if (!registryId) {
        // 無ければ作成。サブドメイン名が予約済み（直前に削除した等）の場合はサフィックスを付けて再試行する。
        let r = await client.createContainerRegistry(region, { name: label, subdomainLabel: label })
        if (r.dryRun === false && !r.ok && /利用されて|exist|重複|conflict/i.test(apiErrorMessage(r.data))) {
          // 例: flatearth が予約中 → flatearth-a1b2 で作り直す（削除後の名前再利用クールダウン回避）。
          label = (label.slice(0, 22).replace(/-+$/, '')) + '-' + randomBytes(2).toString('hex')
          r = await client.createContainerRegistry(region, { name: label, subdomainLabel: label })
        }
        if (r.dryRun === false && r.ok) {
          registryId = extractRegistryId(r.data)
          created = true
        } else {
          const detail = r.dryRun === false ? apiErrorMessage(r.data) : ''
          const msg = r.dryRun === false
            ? `レジストリ作成に失敗しました（HTTP ${r.status}）${detail ? ' — ' + detail : ''}`
            : '予期しないドライラン応答'
          return { ok: false, message: msg }
        }
      }
      if (!registryId) return { ok: false, message: 'レジストリのIDを取得できませんでした（レスポンス形を要確認）' }

      // push 用ユーザーを作成（POST、権限 readwrite）。既に存在する場合は PUT でパスワード更新（冪等）。
      const add = await client.addRegistryUser(region, registryId, { username, password, permission: 'readwrite' })
      if (add.dryRun === false && !add.ok) {
        // 400/409 は「ユーザーが既に存在」のことが多い（APIは明示しない）。PUT更新でパスワードを再設定する。
        const looksExists = add.status === 400 || add.status === 409 ||
          /exist|既に|重複|duplicat|conflict|利用されて/i.test(apiErrorMessage(add.data))
        if (looksExists) {
          const upd = await client.updateRegistryUser(region, registryId, { username, password, permission: 'readwrite' })
          if (upd.dryRun === false && !upd.ok) {
            return { ok: false, message: `レジストリのユーザー更新に失敗しました（HTTP ${upd.status}）${apiErrorMessage(upd.data) ? ' — ' + apiErrorMessage(upd.data) : ''}` }
          }
        } else {
          return { ok: false, message: `レジストリのユーザー作成に失敗しました（HTTP ${add.status}）${apiErrorMessage(add.data) ? ' — ' + apiErrorMessage(add.data) : ''}` }
        }
      }

      // crane の push 認証に使われる資格情報として保存（**アプリ共通に1つだけ**。最後に公開した
      // プロジェクトの内容で上書きされる）。
      saveRegistryCredentials({ name: label, user: username, password })

      // どのレジストリを使っているかは**プロジェクトごと**に記録する。
      // 破棄はこちらだけを見る（共通の資格情報を見ると、別プロジェクトのレジストリを消してしまう。
      // 2026-08-06 に実害が発生: NewProject-2 の破棄で yamada のレジストリが削除された）。
      try {
        const spec = loadCloudSpec(projectDir)
        if (spec) {
          const st = loadCloudState(projectDir, spec)
          saveCloudState(projectDir, { ...st, meta: { ...st.meta, registryName: label } })
        }
      } catch { /* 記録できなくても公開は続行（破棄時に「対象不明」として安全側に倒れる） */ }

      return { ok: true, server: registryServer(label), created }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // ビルド方式を切り替える（標準=builtin / エキスパート=docker）。env.json の service.source.builder を更新。
  ipcMain.handle('cloud:setBuilderMode', (_, projectDir: string, mode: 'builtin' | 'docker') => {
    try {
      if (mode !== 'builtin' && mode !== 'docker') return { ok: false, message: '不正なモードです' }
      const file = cloudFilePath(projectDir, CLOUD_ENV_FILE)
      if (!fs.existsSync(file)) return { ok: false, message: '環境スペック（env.json）がありません' }
      const spec = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (spec?.service?.source?.type !== 'dockerfile') {
        return { ok: false, message: 'ビルド方式を切り替えられるのは「プロジェクトからビルド」する場合のみです' }
      }
      spec.service.source.builder = mode
      const result = validateSpec(spec)
      if (!result.ok) return { ok: false, message: result.errors.join(' / ') }
      fs.writeFileSync(file, JSON.stringify(result.spec, null, 2) + '\n', 'utf-8')
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 当月の利用額（コスト実額）を請求APIから取得する。※エンドポイント/レスポンス形は client.ts に要確認集約。
  ipcMain.handle('cloud:cost', async () => {
    try {
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'クラウドのAPIキーが未登録です' }
      const client = new SakuraCloudClient({ credentials: creds, dryRun: false })
      const zone = 'is1a' // 請求はアカウント単位（どのゾーン経由でも可）

      // 1. アカウントID（契約ID）を取得（auth/status）。
      const st = await client.getAuthStatus(zone)
      if (st.dryRun === false && (st.status === 401 || st.status === 403)) {
        return { ok: false, message: '認証に失敗しました（クラウドのAPIキーを確認してください）' }
      }
      if (st.dryRun === false && !st.ok) {
        return { ok: false, message: `アカウント情報の取得に失敗しました（HTTP ${st.status}）${apiErrorMessage(st.data) ? ' — ' + apiErrorMessage(st.data) : ''}` }
      }
      const accountId = st.dryRun === false ? extractAccountId(st.data) : null
      if (!accountId) return { ok: false, message: 'アカウントIDを取得できませんでした（auth/status のレスポンス形を要確認）' }

      // 2. 契約の請求一覧から直近の確定請求額を取得。
      const r = await client.getBillByContract(zone, accountId)
      if (r.dryRun === false && r.ok) {
        const bill = extractLatestBill(r.data)
        if (bill != null) {
          // 請求日(YYYY-MM-...) → 「YYYY年M月」表記に。読めなければ asOf 省略。
          let asOf: string | undefined
          if (bill.date) {
            const t = new Date(bill.date)
            if (!isNaN(t.getTime())) asOf = `${t.getFullYear()}年${t.getMonth() + 1}月`
          }
          return { ok: true, amountYen: bill.amountYen, asOf }
        }
        return { ok: false, message: '請求レスポンスから金額を読み取れませんでした（レスポンス形を要確認）' }
      }
      return { ok: false, message: r.dryRun === false ? `コスト取得に失敗しました（HTTP ${r.status}）${apiErrorMessage(r.data) ? ' — ' + apiErrorMessage(r.data) : ''}` : '予期しない応答' }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // デプロイ済み AppRun アプリの公開URLを取得する（state の apprun-app ID → getApp → URL取り出し）。
  // ※URLフィールド名は client.ts の extractAppUrl に「要確認」として集約。
  ipcMain.handle('cloud:appUrl', async (_, projectDir: string) => {
    try {
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'クラウドのAPIキーが未登録です' }
      const spec = loadCloudSpec(projectDir)
      if (!spec) return { ok: true, url: null } // 環境未作成
      const state = loadCloudState(projectDir, spec)
      const app = state.resources.find(r => r.kind === 'apprun-app')
      if (!app) return { ok: true, url: null } // まだデプロイされていない
      const client = new SakuraCloudClient({ credentials: creds, dryRun: false })
      const r = await client.getApp(app.id)
      if (r.dryRun === false && r.ok) return { ok: true, url: extractAppUrl(r.data) }
      if (r.dryRun === false && (r.status === 401 || r.status === 403)) {
        return { ok: false, message: '認証に失敗しました（クラウドのAPIキーを確認してください）' }
      }
      return { ok: false, message: r.dryRun === false ? `URLの取得に失敗しました（HTTP ${r.status}）` : '予期しない応答' }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  /**
   * いま動いているかを、もう一度聞く（2026-08-14 Ryosuke 提案）。
   *
   * **何も作らず、何も変えない。** 状態を1回聞くだけ。
   *
   * 公開の直後に待つのは48秒までで、それを超えて起動したアプリは
   * 「まだ準備中です」の警告が出たまま残っていた。消す手立てが
   * 「もう一度公開する」しか無く、**確かめるためだけにイメージを
   * 作り直させていた**（実機でサイトは開けていた）。
   *
   * `ok` は「聞けたか」、`healthy` は「動いているか」。混ぜない。
   */
  ipcMain.handle('cloud:appHealth', async (_, projectDir: string) => {
    try {
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'クラウドのAPIキーが未登録です' }
      const spec = loadCloudSpec(projectDir)
      if (!spec) return { ok: false, message: 'このプロジェクトはまだ公開されていません' }
      const state = loadCloudState(projectDir, spec)
      const app = state.resources.find(r => r.kind === 'apprun-app')
      if (!app) return { ok: false, message: 'このプロジェクトはまだ公開されていません' }
      const client = new SakuraCloudClient({ credentials: creds, dryRun: false })
      const res = await client.getAppStatus(app.id)
      if (res.dryRun !== false || !res.ok) {
        const status = res.dryRun === false ? res.status : 0
        if (status === 401 || status === 403) {
          return { ok: false, message: '認証に失敗しました（クラウドのAPIキーを確認してください）' }
        }
        return { ok: false, message: status ? `状態を確認できませんでした（HTTP ${status}）` : '予期しない応答' }
      }
      const { status, message } = parseAppStatus(res.data)
      const health = judgeRecheck({ status, message })
      return {
        ok: true,
        healthy: health.ok,
        pending: health.pending,
        note: health.note,
        ...(health.detail ? { detail: health.detail } : {}),
        logUrl: appLogUrl(app.id),
        askAi: askAiAboutFailure({ note: health.note, ...(health.detail ? { detail: health.detail } : {}) }),
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 限定公開（アクセス制限＝パケットフィルタ）。デプロイ済みアプリの許可IPを読み書きする。
  ipcMain.handle('cloud:getAccessLimit', async (_, projectDir: string) => {
    try {
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'クラウドのAPIキーが未登録です' }
      const spec = loadCloudSpec(projectDir)
      if (!spec) return { ok: true, deployed: false }
      const state = loadCloudState(projectDir, spec)
      const app = state.resources.find(r => r.kind === 'apprun-app')
      if (!app) return { ok: true, deployed: false }
      const client = new SakuraCloudClient({ credentials: creds, dryRun: false })
      const r = await client.getPacketFilter(app.id)
      if (r.dryRun === false && r.ok) {
        const data: any = r.data ?? {}
        const settings = Array.isArray(data.settings) ? data.settings : []
        return {
          ok: true, deployed: true,
          isEnabled: data.is_enabled === true,
          ips: settings.map((s: any) => ({ ip: String(s.from_ip ?? ''), prefix: Number(s.from_ip_prefix_length ?? 32) })),
        }
      }
      if (r.dryRun === false && r.status === 404) return { ok: true, deployed: true, isEnabled: false, ips: [] }
      if (r.dryRun === false && (r.status === 401 || r.status === 403)) return { ok: false, message: '認証に失敗しました（クラウドのAPIキーを確認してください）' }
      return { ok: false, message: r.dryRun === false ? `取得に失敗しました（HTTP ${r.status}）` : '予期しない応答' }
    } catch (e: any) { return { ok: false, message: e?.message ?? String(e) } }
  })

  ipcMain.handle('cloud:setAccessLimit', async (_, projectDir: string, payload: { isEnabled: boolean; ips: Array<{ ip: string; prefix: number }> }) => {
    try {
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'クラウドのAPIキーが未登録です' }
      const spec = loadCloudSpec(projectDir)
      if (!spec) return { ok: false, message: '公開の設定がありません' }
      const state = loadCloudState(projectDir, spec)
      const app = state.resources.find(r => r.kind === 'apprun-app')
      if (!app) return { ok: false, message: 'まだ公開されていません（先に公開してください）' }
      const settings = (payload?.ips ?? []).map(e => ({ from_ip: e.ip, from_ip_prefix_length: e.prefix }))
      const body = { is_enabled: payload?.isEnabled === true, settings }
      const client = new SakuraCloudClient({ credentials: creds, dryRun: false })
      const r = await client.patchPacketFilter(app.id, body)
      if (r.dryRun === false && r.ok) return { ok: true }
      if (r.dryRun === false && (r.status === 401 || r.status === 403)) return { ok: false, message: '認証に失敗しました（クラウドのAPIキーを確認してください）' }
      return { ok: false, message: r.dryRun === false ? `保存に失敗しました（HTTP ${r.status}）` : '予期しない応答' }
    } catch (e: any) { return { ok: false, message: e?.message ?? String(e) } }
  })

  ipcMain.handle('cloud:myIp', async () => {
    try {
      const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return { ok: false, message: `IPの取得に失敗しました（HTTP ${res.status}）` }
      const data: any = await res.json()
      const ip = typeof data?.ip === 'string' ? data.ip : null
      return ip ? { ok: true, ip } : { ok: false, message: 'IPを取得できませんでした' }
    } catch (e: any) { return { ok: false, message: e?.message ?? String(e) } }
  })

  // 差分プラン算出（ドライラン・API呼び出し無し）。env.json と state.json を読んで computePlan する。
  ipcMain.handle('cloud:plan', (_, projectDir: string) => {
    try {
      const envFile = cloudFilePath(projectDir, CLOUD_ENV_FILE)
      if (!fs.existsSync(envFile)) {
        return { ok: false, errors: ['env.json がありません（先に環境スペックを作成してください）'] }
      }
      const specResult = validateSpec(JSON.parse(fs.readFileSync(envFile, 'utf-8')))
      if (!specResult.ok) return { ok: false, errors: specResult.errors }
      const spec: EnvSpec = specResult.spec

      // state.json が無ければ空stateとして全create扱い。
      const stateFile = cloudFilePath(projectDir, CLOUD_STATE_FILE)
      let state: EnvState
      if (fs.existsSync(stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
        state = {
          name: typeof parsed?.name === 'string' ? parsed.name : spec.name,
          backend: typeof parsed?.backend === 'string' ? parsed.backend : spec.backend,
          resources: Array.isArray(parsed?.resources) ? parsed.resources : [],
        }
      } else {
        state = emptyState(spec.name, spec.backend)
      }

      const plan = computePlan(spec, state)
      return { ok: true, plan }
    } catch (e: any) {
      return { ok: false, errors: [e?.message ?? String(e)] }
    }
  })

  // 構築: env.json+state.json → computePlan →（dockerfile なら build/login/push して image ソースへ差し替え）
  //      → 実クライアント（dryRun=false）→ applyPlan → 成功なら state 保存
  // 進捗は event.sender へ 'cloud:apply-progress' で逐次通知する。
  ipcMain.handle('cloud:apply', async (event, projectDir: string, opts?: { confirmed?: boolean }) => {
    const progress = (msg: string) => {
      try { event.sender.send('cloud:apply-progress', msg) } catch { /* ウィンドウ破棄時は無視 */ }
    }
    try {
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'APIキー未登録（先にアクセストークン/シークレットを登録してください）' }

      const spec = loadCloudSpec(projectDir)
      if (!spec) return { ok: false, message: 'env.json がありません（先に環境スペックを作成してください）' }

      const state = loadCloudState(projectDir, spec)
      let plan = computePlan(spec, state)

      // 適用に使う spec（dockerfile の場合はビルド後に image ソースへ差し替える）。
      let resolvedSpec = spec
      let registryAuth: { server: string; username: string; password: string } | undefined

      // ── image 以外のソース かつ プランがアプリの create/update を含むなら、
      //    同梱の crane で「公開ベース＋ファイル層＋起動設定」を組み立ててレジストリへ push する。
      //    （Docker デーモン不要。Dockerfile も不要。）
      if (spec.service.source.type !== 'image' && planTouchesApp(plan)) {
        const source = spec.service.source
        const builderMode = source.builder ?? 'builtin' // 既定は内蔵（Docker不要）

        // 1. 共通の前提: レジストリ認証情報。
        const regCreds = loadRegistryCredentials()
        if (!hasRegistryCredentials() || !regCreds) {
          return { ok: false, message: 'コンテナレジストリの認証情報が未登録です（認証情報で登録、または「レジストリを自動作成」してください）' }
        }

        // 1b. push 先が**このプロジェクトのレジストリ**かを確かめる。
        // 接続情報はアプリ共通に1つだけで、最後に「↻ ユーザー再設定」を押したプロジェクトの
        // もので上書きされる。突き合わせないと、別プロジェクトのレジストリへ push してしまい、
        // 向こうを破棄したときにこちらのイメージが消える（2026-08-09 の実機検証で発覚）。
        const push = resolvePushRegistry(state.meta?.registryName, regCreds.name)
        if ('error' in push) {
          if (push.error === 'no-credentials') {
            return { ok: false, message: 'コンテナレジストリの認証情報が未登録です（「🛠 レジストリを自動作成」を押してください）' }
          }
          return {
            ok: false,
            // renderer はこの印を見て「レジストリを設定し直す」ボタンを出す。
            // 平常時にそのボタンを常設すると誤爆の元になるため、必要なときだけ出す（2026-08-09）。
            hint: 'reset-registry' as const,
            message: `このプロジェクトはコンテナレジストリ『${push.recorded}』を使う設定ですが、`
              + `いまは別のレジストリ『${push.credential}』の接続情報が入っています`
              + `（別のプロジェクトで公開の準備をしたためです）。`
              + `下の「レジストリを設定し直す」を押してから、もう一度公開してください。`
              + `このまま公開すると、別のプロジェクトのレジストリにこのアプリのイメージが入ってしまいます。`,
          }
        }
        // 記録が無いプロジェクトは、いま使っているレジストリを自分のものとして記録する
        // （次回からは上の突き合わせが効く）。
        if (push.adopt) {
          try {
            saveCloudState(projectDir, { ...state, meta: { ...state.meta, registryName: push.use } })
            state.meta = { ...state.meta, registryName: push.use }
          } catch { /* 記録できなくても公開は続行（次回また採用を試みる） */ }
        }

        // 1c. **記録があることと、実在することは別。**（2026-08-14 実機）
        // コントロールパネルでレジストリを削除すると、Koto は手元の認証情報だけを見て
        // 「レジストリ登録 ✓」と表示し、組み立ての最後で push に失敗する。
        // 原因が画面に出ないうえ、回復のボタンも出ないので袋小路になる。
        try {
          const probe = new SakuraCloudClient({ credentials: creds, dryRun: false })
          const listedNow = await probe.listContainerRegistries(spec.region)
          if (listedNow.dryRun === false && listedNow.ok) {
            const names = pickContainerRegistries(listedNow.data).map(r => r.subdomainLabel)
            if (names.length > 0 && !names.includes(push.use)) {
              return {
                ok: false,
                hint: 'reset-registry' as const,
                message: `このプロジェクトが使うコンテナレジストリ『${push.use}』が見つかりません`
                  + '（コントロールパネルで削除された可能性があります）。'
                  + '下の「レジストリを設定し直す」を押してから、もう一度公開してください。',
              }
            }
          }
        } catch { /* 確認できなくても公開は試す（本当の失敗は下で拾う） */ }

        let contextAbs: string
        try {
          contextAbs = resolveBuildContext(projectDir, source.context)
        } catch (e: any) {
          return { ok: false, message: e?.message ?? String(e) }
        }
        if (!source.image || !source.tag) {
          return { ok: false, message: 'env.json の service.source に image と tag を設定してください（イメージのビルドに必要です）' }
        }

        // 2. レジストリサーバ＋image＋tag から完全な参照を組み立てる（検証込み）。
        const server = registryServer(regCreds.name)
        let ref: string
        try {
          ref = buildRef(server, source.image, source.tag)
        } catch (e: any) {
          return { ok: false, message: e?.message ?? String(e) }
        }

        // 3. ビルド方式で分岐。
        if (builderMode === 'docker') {
          // ── エキスパート: ユーザーのDockerfileを Docker でビルド（Docker導入が必要・任意のRUN可） ──
          if (!(await dockerAvailable())) {
            return { ok: false, message: 'Docker が見つかりません（エキスパートモードには Docker のインストールが必要です。標準モードなら Docker は不要です）' }
          }
          if (!fs.existsSync(path.join(contextAbs, 'Dockerfile'))) {
            return { ok: false, message: 'Dockerfile が見つかりません（エキスパートモードはビルドコンテキストに Dockerfile が必要です）' }
          }
          progress('🐳 Dockerfile からイメージをビルドしています…')
          const b = await buildImage(contextAbs, ref)
          // 所見12: 生ログの行き止まりを避け、主文は「原因の見当＋次の行動」に。生ログは detail へ
          // （renderer 側が折りたたみ「詳細を見る」で表示。原因究明に役立つ実績があるため捨てない）。
          if (!b.ok) {
            return {
              ok: false,
              message: 'アプリの組み立て（Dockerビルド）に失敗しました。よくある原因: Dockerfile の記述ミス、存在しないライブラリ名、対応していないベースイメージ。チャットでAIにエラー内容を貼って相談することもできます。',
              detail: b.log,
            }
          }
          progress('🔑 レジストリにログインしています…')
          const lg = await loginRegistry(server, regCreds.user, regCreds.password)
          if (!lg.ok) {
            return {
              ok: false,
              hint: 'reset-registry' as const,
              message: 'レジストリへのログインに失敗しました。下の「レジストリを設定し直す」で push 用のパスワードを作り直してから、もう一度お試しください。',
              detail: lg.message ?? '',
            }
          }
          progress('📤 レジストリへプッシュしています…')
          const ps = await pushImage(ref)
          if (!ps.ok) {
            return {
              ok: false,
              message: 'レジストリへの反映（プッシュ）に失敗しました。インターネット接続を確認して、もう一度お試しください。',
              detail: ps.log,
            }
          }
          progress('📤 レジストリへ反映しました')
        } else {
          // ── 標準: 同梱 crane で「公開ベース＋ファイル層＋起動設定」を組み立てて push（Docker不要） ──
          if (!builderAvailable()) {
            return { ok: false, message: '内蔵ビルダーが見つかりません（再インストールしてください）' }
          }
          // **何で動かすかを決める。** 長らく static 決め打ちで、Node のアプリを
          // 公開してもソースの一覧が出るだけだった（2026-08-14 実機で発覚）。
          // 判断は shared/runtimeDetect.ts に集約（掟10）。
          const choice = detectRuntimeFor(contextAbs)
          if (choice.kind === 'unsupported') {
            // **黙って static で公開しない。** 動かないうえにソースが丸見えになる
            return { ok: false, message: choice.reason }
          }
          progress(choice.kind === 'node' ? `📦 イメージを組み立てています…（${choice.entry} で起動）` : '📦 イメージを組み立てています…')
          const built = await buildAndPush({
            contextAbs,
            ref,
            port: spec.service.port,
            runtime: choice.kind,
            ...(choice.kind === 'node' ? { entry: choice.entry } : {}),
            registryAuth: { server, user: regCreds.user, password: regCreds.password },
            // ライブラリの用意は数分かかることがある。**黙って待たせない**
            onProgress: progress,
          })
          // 所見12: 生ログ（stderr要約）の行き止まりを避け、主文は「原因の見当＋次の行動」に。
          // 生ログは detail へ（renderer 側が折りたたみ「詳細を見る」で表示）。
          if (!built.ok) {
            const detail = [built.message, built.log].filter(Boolean).join('\n')
            // **回復の導線を、この経路にも出す。**（2026-08-14）
            // これまで印を付けていたのは Docker の経路だけで、既定の使い方をしている
            // 人だけが「直し方の分からない失敗」に取り残されていた
            const registryTrouble = looksLikeRegistryProblem(detail)
            return {
              ok: false,
              ...(registryTrouble ? { hint: 'reset-registry' as const } : {}),
              message: registryTrouble
                ? 'イメージの置き場（コンテナレジストリ）へ反映できませんでした。'
                  + '削除された、または接続情報が古い可能性があります。'
                  + '下の「レジストリを設定し直す」を押してから、もう一度お試しください。'
                : 'アプリの組み立てに失敗しました。よくある原因: package.json の記述ミス、存在しないライブラリ名、対応していないベースイメージ。チャットでAIにエラー内容を貼って相談することもできます。',
              detail,
            }
          }
          progress('📤 レジストリへ反映しました')
        }

        // 4. 成功。spec を複製して source を image ソースへ差し替え、レジストリ認証を用意する。
        resolvedSpec = {
          ...spec,
          service: { ...spec.service, source: { type: 'image', ref } },
        }
        registryAuth = { server, username: regCreds.user, password: regCreds.password }

        // 差し替え後の spec でプランを再算出（source 差し替えでも apprun-app の差分は不変だが安全側で再計算）。
        plan = computePlan(resolvedSpec, state)
      }

      // ── 保存場所（永続データ）──
      // **同意済みのバケットがあるときだけ**用意する。無ければ何も渡さない
      // （渡さなければ apply はバケットに触れない）。2026-08-14 まで、ここで
      // 渡し忘れていたため、公開してもバケットが作られなかった。
      let storage: StorageAdapter | undefined
      if (consentedBuckets(resolvedSpec.persistence?.objectStorage).length > 0) {
        try {
          progress('💾 保存場所を確認しています…')
          storage = await createStorageAdapter(creds)
        } catch (e: any) {
          // 保存場所を使うと決めたアプリなので、**黙って進めない**。
          // ここで進めると、データの消えるアプリが公開される
          return { ok: false, message: `保存場所に接続できませんでした: ${e?.message ?? e}` }
        }
      }

      // ── AppRun へ反映 ──
      progress('🚀 AppRun に反映しています…')
      const client = new SakuraCloudClient({ credentials: creds, dryRun: false })
      let result: Awaited<ReturnType<typeof applyPlan>>
      try {
        result = await applyPlan({
          plan,
          spec: resolvedSpec,
          state,
          client,
          confirmed: opts?.confirmed === true,
          ...(storage ? { storage } : {}),
          ...(registryAuth ? { registryAuth } : {}),
        })
      } finally {
        // 一時的に発行した鍵は必ず片づける（失敗しても公開の結果は変えない）
        if (storage) await storage.dispose()
      }

      // **失敗しても記録する。** 途中まで実行された分（作られたアプリ等）を捨てると、
      // Koto から見つけられないまま課金が続く。何を残すかの判断は state.ts に集約
      // （初回の構築なら作成メタを付ける。meta は差し替えず必ずマージする）。
      saveCloudState(projectDir, stateToSave({
        ok: result.ok, state: result.state, kind: 'apply',
        ttlHours: spec.guardrails.ttlHours, now: new Date(),
      }))
      // ── 本当に動いているかを確かめる（2026-08-14）──────────────────────
      // **デプロイのAPIが 200 を返したことは、アプリが動いた証拠にならない。**
      // 実機で「✅ 完了しました」と出しながら、アプリは
      // `Component is exited: ExitCode1` で起動に失敗していた。
      // 利用者は公開URLを開いて初めて気づき、原因はコンパネのログにしか無い。
      let health: AppHealth | undefined
      let appId: string | undefined
      if (result.ok) {
        appId = result.state.resources.find(r => r.kind === 'apprun-app')?.id
        if (appId) {
          // ── ログを残せるようにする（2026-08-14 Ryosuke 提案）────────────
          // AppRun のログは**既定では残らない**。動かなかったときに原因を
          // 調べられるよう、公開のついでに繋いでおく。
          // **費用が増えるのはログ領域を作るときだけ**なので、既にあるときは
          // 黙って繋ぐ（意味の分からない同意を増やさない）。判断は shared に集約。
          try { await ensureAppLogRouting(creds, appId, progress) } catch { /* ログが無くても公開は成立する */ }

          progress('🩺 アプリが動いているか確かめています…')
          health = await waitForHealthy(client, appId, progress)

          // ── 古い鍵は「動いた」と確かめてから片づける（2026-08-14 実機）──────
          // デプロイのAPIが 200 を返しても、新しいコンテナはまだ立ち上がっていない。
          // その間に古い鍵を消すと、**いま動いているアプリが 403 で落ちる**。
          // 起動に失敗したときは**消さない**（古い版が動き続けられるように）。
          if (health.ok && storage) {
            try { await cleanUpOldKeys(storage, resolvedSpec.name, result.state.meta?.storagePermissionId ?? null, progress) }
            catch { /* 片づけの失敗で公開を失敗にしない */ }
          }
        }
      }

      const finallyOk = result.ok && (health ? health.ok : true)
      progress(finallyOk ? '✅ 完了' : health?.pending ? '⏳ 起動を確認できていません' : '⚠️ 失敗しました')
      return {
        ok: finallyOk,
        executed: result.executed,
        skipped: result.skipped,
        message: health && !health.ok ? health.note : result.message,
        ...(health?.detail ? { detail: health.detail } : {}),
        // 起動に失敗したときだけ、ログの場所とAIへの相談を出せるようにする
        ...(health && !health.ok && appId
          ? { hint: 'app-unhealthy' as const, pending: health.pending, logUrl: appLogUrl(appId), askAi: askAiAboutFailure({ note: health.note, ...(health.detail ? { detail: health.detail } : {}) }) }
          : {}),
      }
    } catch (e: any) {
      progress('⚠️ 失敗しました')
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 前提チェック: image 以外のソースの構築に必要な「内蔵ビルダー」「レジストリ認証」の有無を返す。
  // env.json が無ければ sourceType:null。image ソースなら build 不要のため両方 true 扱い。
  // （内蔵 crane で組み立てるため Docker・Dockerfile は不要＝チェックしない。）
  ipcMain.handle('cloud:checkPrereqs', async (_, projectDir: string) => {
    try {
      let spec: EnvSpec | null
      try {
        spec = loadCloudSpec(projectDir)
      } catch {
        // 不正な env.json はソース不明として扱う（UIは「再読み込み」で詳細を出す）。
        spec = null
      }
      if (!spec) {
        return { sourceType: null, builderMode: 'builtin' as const, builder: builderAvailable(), registry: false }
      }
      const source = spec.service.source
      if (source.type === 'image') {
        // image ソースはビルド前提が不要。前提を満たしているものとして扱う。
        return { sourceType: 'image' as const, builderMode: 'builtin' as const, builder: true, registry: true }
      }
      const registry = hasRegistryCredentials()
      const builderMode = source.builder ?? 'builtin'
      if (builderMode === 'docker') {
        // エキスパート: Docker 導入 ＋ Dockerfile ＋ レジストリ認証。
        let dockerfile = false
        try { dockerfile = fs.existsSync(path.join(resolveBuildContext(projectDir, source.context), 'Dockerfile')) } catch { dockerfile = false }
        return { sourceType: 'dockerfile' as const, builderMode, docker: await dockerAvailable(), dockerfile, registry }
      }
      // 標準: 内蔵ビルダー（同梱 crane・常時可）＋ レジストリ認証。Docker/Dockerfile 不要。
      return { sourceType: 'dockerfile' as const, builderMode, builder: builderAvailable(), registry }
    } catch (e: any) {
      return { sourceType: null, builderMode: 'builtin' as const, builder: builderAvailable(), registry: false, message: e?.message ?? String(e) }
    }
  })

  // 破棄: 現在の state の全リソースを削除するプラン（空spec相当）を作って applyPlan（confirmed 必須）
  ipcMain.handle('cloud:teardown', async (_, projectDir: string, opts?: { confirmed?: boolean; deleteRegistry?: boolean }) => {
    try {
      const creds = loadCredentials()
      if (!creds) return { ok: false, message: 'APIキー未登録（先にアクセストークン/シークレットを登録してください）' }

      const spec = loadCloudSpec(projectDir)
      if (!spec) return { ok: false, message: 'env.json がありません' }

      const state = loadCloudState(projectDir, spec)

      // 破棄プラン: 現在の state の全リソースを delete にする（空spec相当＝要求リソース無し）。
      // computePlan は spec.name の apprun-app を必ず「要求」するため、全state資源を確実に
      // delete 対象にするには state ベースで直接 delete プランを組むのが安全（apprun-app も含む）。
      const nameFromRef = (r: EnvState['resources'][number]): string =>
        r.key.startsWith(`${r.kind}:`) ? r.key.slice(r.kind.length + 1) : r.id
      const plan: Plan = {
        actions: state.resources.map(r => ({
          type: 'delete' as const,
          kind: r.kind,
          name: nameFromRef(r),
          stateful: r.stateful,
          destructive: true,
          description: r.stateful
            ? `バケット『${nameFromRef(r)}』を削除（データが消えます）`
            : `${r.kind}『${nameFromRef(r)}』を削除`,
        })),
        hasDestructive: state.resources.length > 0,
        hasStatefulDelete: state.resources.some(r => r.stateful),
      }

      // 保存場所は **state に載っているときだけ**触る（載っていない＝作っていない）。
      // ここで渡し忘れると、バケットだけが残って課金が続く
      let storage: StorageAdapter | undefined
      if (state.resources.some(r => r.kind === 'bucket')) {
        try {
          storage = await createStorageAdapter(creds)
        } catch (e: any) {
          // **中身を確かめられないなら消さない。** 破棄そのものを中止する
          return { ok: false, message: `保存場所に接続できないため、破棄を中止しました: ${e?.message ?? e}` }
        }
      }

      const client = new SakuraCloudClient({ credentials: creds, dryRun: false })
      let result: Awaited<ReturnType<typeof applyPlan>>
      try {
        result = await applyPlan({ plan, spec, state, client, confirmed: opts?.confirmed === true, ...(storage ? { storage } : {}) })
      } finally {
        if (storage) await storage.dispose()
      }

      const extraExecuted: string[] = []
      if (result.ok) {
        // state の保存は**レジストリの処理が終わってから**行う（下の saveCloudState）。
        // レジストリを残したときは registryName を記録に残す必要があり、その判断には
        // 削除できたかどうかが要るため（2026-08-09）。
        let registryDeleted = false

        // ── 完全クリーンアップ: IDEが作成したコンテナレジストリ（＋push用ユーザー＋イメージ）も削除する。 ──
        // レジストリは env state に載らない（ensureRegistry で別管理）ため、ここで明示的に破棄する。
        // 保存済み資格情報の registry 名から対象を特定し、見つかれば DELETE → 資格情報もクリア。
        // deleteRegistry が false のときは残す（ユーザーがチェックを外した＝月額課金を承知で残す判断）。
        // 未指定は従来どおり削除する（呼び出し漏れで課金が残り続けるより、消す側を既定にする）。
        try {
          // 対象は**このプロジェクトが記録しているレジストリ名だけ**。
          // 以前は共通の資格情報（registry-credentials.enc＝最後に公開したプロジェクトのもの）を
          // 見ていたため、別プロジェクトのレジストリを削除する事故が起きた（2026-08-06）。
          // 記録が無い（v0.2.94以前に公開した等）ときは**何も削除しない**で、その旨を伝える。
          const target = registryDeletionTarget(state, opts?.deleteRegistry !== false)
          const registryName = 'name' in target ? target.name : null
          if ('skipped' in target && target.skipped === 'unknown' && opts?.confirmed === true) {
            extraExecuted.push(
              '※ このプロジェクトがどのコンテナレジストリを使っていたかの記録がないため、レジストリは削除していません。'
              + 'さくらのクラウドのコントロールパネルで確認し、不要なら削除してください（月額220円がかかり続けます）。'
            )
          }
          const regCreds = registryName ? { name: registryName } : null
          if (regCreds?.name && opts?.confirmed === true && opts?.deleteRegistry !== false) {
            const region = (typeof spec.region === 'string' && spec.region) ? spec.region : 'is1a'
            const listed = await client.listContainerRegistries(region)
            if (listed.dryRun === false && listed.ok) {
              const found = pickContainerRegistries(listed.data).find(r => r.subdomainLabel === regCreds.name)
              if (found) {
                const del = await client.deleteContainerRegistry(region, found.id)
                if (del.dryRun === false && del.ok) {
                  registryDeleted = true
                  extraExecuted.push(`コンテナレジストリ『${regCreds.name}』を削除（ユーザー・イメージごと）`)
                  // 共通の資格情報は、いま消したレジストリを指しているときだけクリアする
                  // （別プロジェクトのものを指している場合に消すと、そのプロジェクトの push 設定を壊す）。
                  if (loadRegistryCredentials()?.name === regCreds.name) clearRegistryCredentials()
                } else if (del.dryRun === false) {
                  extraExecuted.push(`※ レジストリ『${regCreds.name}』の削除に失敗（HTTP ${del.status}）。コンパネで削除してください`)
                }
              } else {
                // 一覧に無い＝既に削除済み。記録も落とす（存在しない名前を残すと次の公開で使ってしまう）。
                registryDeleted = true
                // 共通資格情報がこのレジストリを指しているときだけ掃除する。
                if (loadRegistryCredentials()?.name === regCreds.name) clearRegistryCredentials()
              }
            }
          }
        } catch { /* レジストリ削除失敗は致命ではない（アプリは削除済み） */ }

        // 資源を空にした state を保存する。**レジストリを残したときは registryName を残す**
        // （消すと、残したレジストリを Koto が二度と見つけられず・消せなくなる）。
        saveCloudState(projectDir, stateToSave({ ok: true, state: result.state, kind: 'teardown', registryDeleted }))
      } else {
        // **失敗しても記録する。** 2026-08-14、保存場所の削除が 403 で落ちたとき、
        // 既に消えていたアプリが記録に残り続け、次の公開が 404 になった
        saveCloudState(projectDir, stateToSave({ ok: false, state: result.state, kind: 'teardown' }))
      }
      // **保存場所が残ったかどうかは、結果でしか分からない。**
      // 3段構え（ほかのプロジェクトが使っている・利用者のファイルがある）で残ることがあり、
      // 残ったなら月額も続く。env.json は破棄しても変わらないので判断材料にならない。
      // apply はバケットを実際に消したときだけ state から取り除くので、そこを見る。
      const keptBucketName = plan.actions.some(a => a.kind === 'bucket' && a.type === 'delete')
        ? (result.state.resources.find(r => r.kind === 'bucket')?.id ?? null)
        : null

      return {
        ok: result.ok,
        executed: [...result.executed, ...extraExecuted],
        skipped: result.skipped,
        keptBucketName,
        // ステートフル（bucket）削除を含む場合は明示する。
        message:
          result.message ??
          (plan.hasStatefulDelete ? 'ステートフル資源（バケット）の削除を含みます。データは失われます。' : undefined),
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 破棄画面で「どのレジストリを消すか」を名前で見せるために使う（保存済み資格情報の名前だけを返す）。
  // パスワードは返さない（方式B: 秘密は画面に出さない）。
  ipcMain.handle('cloud:registryName', (_, projectDir: string) => {
    try {
      // **このプロジェクトの記録**を返す。アプリ共通の資格情報（＝最後に「↻ ユーザー再設定」を
      // 押したプロジェクトのもの）を返してはいけない。破棄の確認画面はこの名前を出すため、
      // 別プロジェクトの名前が出ると「心当たりの無い名前ならチェックを外す」という
      // 安全装置が逆に働く（2026-08-09 の実機検証で、A の画面に B の名前が出ていた）。
      if (typeof projectDir !== 'string' || !projectDir) return { ok: true, name: null }
      const spec = loadCloudSpec(projectDir)
      if (!spec) return { ok: true, name: null }
      return { ok: true, name: loadCloudState(projectDir, spec).meta?.registryName ?? null }
    } catch {
      return { ok: true, name: null }
    }
  })

  // TTL確認: state を読み isExpired で TTL 超過を返す
  ipcMain.handle('cloud:checkExpiry', (_, projectDir: string) => {
    try {
      const spec = loadCloudSpec(projectDir)
      // spec が無くても state 単体で判定できるよう、name/backend は state 優先で読む。
      const fallbackName = spec?.name ?? ''
      const fallbackBackend = spec?.backend ?? 'apprun'
      const stateFile = cloudFilePath(projectDir, CLOUD_STATE_FILE)
      if (!fs.existsSync(stateFile)) {
        return { ok: true, expired: false, createdAt: null, ttlHours: null }
      }
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      const state: EnvState = {
        name: typeof parsed?.name === 'string' ? parsed.name : fallbackName,
        backend: typeof parsed?.backend === 'string' ? parsed.backend : fallbackBackend,
        resources: Array.isArray(parsed?.resources) ? parsed.resources : [],
        ...(parsed?.meta && typeof parsed.meta === 'object' ? { meta: parsed.meta } : {}),
      }
      const expired = isExpired(state, new Date())
      return {
        ok: true,
        expired,
        createdAt: state.meta?.createdAt ?? null,
        ttlHours: state.meta?.ttlHours ?? null,
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // このプロジェクトが既に AppRun へ公開済みか（state.json に apprun-app リソースがあるか）を返す。
  // API呼び出しやAPIキーを必要としない軽量チェック（公開名の変更時に「新しいアプリになる」旨の
  // 確認ダイアログを出すかどうかの判定に使う）。
  ipcMain.handle('cloud:isPublished', (_, projectDir: string) => {
    try {
      const stateFile = cloudFilePath(projectDir, CLOUD_STATE_FILE)
      if (!fs.existsSync(stateFile)) return { ok: true, published: false }
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      const resources = Array.isArray(parsed?.resources) ? parsed.resources : []
      const published = resources.some((r: any) => r?.kind === 'apprun-app')
      return { ok: true, published }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })
  /**
   * プロジェクトのデータの扱いを調べる（③公開で保存場所の要否を出すため）。
   * 値は読まず、**どのファイルがどう扱っているか**だけを返す。
   */
  ipcMain.handle('storage:scan', (_e, projectDir: string) => {
    try {
      const scan = scanDataUsage(String(projectDir || ''))
      return { ok: true, usesDataLayer: scan.usedBy.length > 0, usedBy: scan.usedBy, writesFiles: scan.writesFiles }
    } catch (e: any) {
      return { ok: false, usesDataLayer: false, usedBy: [], writesFiles: [], message: e?.message ?? String(e) }
    }
  })

  /** koto-data.js が要るなら置く（既にあれば触らない）。 */
  ipcMain.handle('storage:ensureLayer', (_e, projectDir: string) => {
    try { return { ok: true, placed: ensureDataLayer(String(projectDir || '')) } }
    catch (e: any) { return { ok: false, placed: false, message: e?.message ?? String(e) } }
  })

  /**
   * 保存場所の状況（設定画面用）。
   *
   * **費用の判断材料をまとめて返す。** サイトの利用が始まっているか（＝月額が
   * 発生しているか）、保存場所がいくつあるか（**バケット単位で課金**）。
   */
  ipcMain.handle('storage:status', async () => {
    const creds = loadCredentials()
    if (!creds) return { ok: false, message: 'さくらのクラウドのAPIキーが未登録です', siteReady: false, buckets: [] }
    try {
      const client = new ObjectStorageClient({ credentials: creds, dryRun: false })
      const site = await client.pickSite()
      const siteReady = await client.isSiteReady(site.id)
      // 利用開始前はバケットも無い。無駄に問い合わせない
      const buckets = siteReady ? await client.listBuckets(site.id) : []
      return {
        ok: true,
        siteId: site.id,
        siteName: site.display_name,
        s3Endpoint: site.s3_endpoint,
        siteReady,
        buckets,
        suggested: sharedBucketName(creds.token),
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e), siteReady: false, buckets: [] }
    }
  })

  /**
   * 保存場所を新しく作る（設定画面から）。
   *
   * ⚠️ **バケット単位で月額が発生する。** 呼び出し側で必ず費用を示し、
   * 同意を得てから呼ぶこと（AppRun のレジストリ作成と同じ扱い）。
   * サイトの利用開始も同様なので、ここでまとめて行う。
   */
  /**
   * 公開する前に「本当に通るか」をまとめて確かめる（改善案 1-2）。
   *
   * ── なぜ要るか（2026-08-14 の実機検証）────────────────────────────
   * この日、公開は10回以上失敗した。そのうち**4件は押す前に分かったはず**だった:
   *   ・レジストリが消えているのに「登録済み ✓」と出ていた
   *   ・保存場所が作られていないのに「ある」と誤読していた
   *   ・公開名が、記録に無い孤児のアプリと衝突していた
   *   ・Node で動かせない作り（依存ライブラリ）だった
   * どれも「押す → 数分待つ → 分からないエラー」で返ってきた。
   * **押す前に、まとめて確かめて、まとめて伝える。**
   *
   * ⚠️ **何も作らない・何も変えない。** 見るだけ。
   */
  ipcMain.handle('cloud:preflight', async (_e, projectDir: string) => {
    const checks: PreflightCheck[] = []
    const add = (id: string, label: string, status: PreflightCheck['status'], note: string, fix?: PreflightCheck['fix']) =>
      checks.push({ id, label, status, note, ...(fix ? { fix } : {}) })

    try {
      const creds = loadCredentials()
      if (!creds) {
        add('key', 'APIキー', 'ng', 'さくらのクラウドのAPIキーが登録されていません。「① APIキー」から登録してください。')
        return { ok: true, ...summarizePreflight(sortChecks(checks)) }
      }
      add('key', 'APIキー', 'ok', '登録されています。')

      let spec: EnvSpec | null = null
      try { spec = loadCloudSpec(projectDir) } catch (e: any) {
        add('spec', '公開の設定', 'ng', `公開の設定（env.json）を読み取れません: ${e?.message ?? e}`)
      }
      if (!spec) {
        if (checks.every(c => c.id !== 'spec')) {
          add('spec', '公開の設定', 'ng', '公開の設定がまだありません。「② 公開の設定」で作成してください。')
        }
        return { ok: true, ...summarizePreflight(sortChecks(checks)) }
      }
      add('spec', '公開の設定', 'ok', `公開名『${spec.name}』で公開します。`)

      // 起動できる作りか（判断は shared/runtimeDetect.ts）
      if (spec.service.source.type !== 'image') {
        let contextAbs = projectDir
        try { contextAbs = resolveBuildContext(projectDir, spec.service.source.context) } catch { /* 既定のまま */ }
        const choice = detectRuntimeFor(contextAbs)
        // コードを直せば通るので、AIに相談できるようにする
        if (choice.kind === 'unsupported') add('runtime', 'アプリの作り', 'ng', choice.reason, 'ask-ai')
        else if (choice.kind === 'node') {
          // 依存ライブラリがあると、公開のたびに手元で用意する（数分かかることがある）。
          // **待たされる理由を先に伝える**（改善案 1-5・2026-08-18）
          const deps = planDependencies(readProjectPackageJson(contextAbs))
          add('runtime', 'アプリの作り', 'ok',
            `Node で ${choice.entry} を起動します。`
            + (deps.kind === 'install'
              ? `ライブラリ ${deps.names.length}件（${deps.names.slice(0, 3).join('、')}${deps.names.length > 3 ? ' ほか' : ''}）も一緒に用意します。${installTimeNote(deps.names.length)}。`
              : ''))
        }
        else add('runtime', 'アプリの作り', 'ok', 'ファイルをそのまま配信します（HTML など）。')
      }

      const client = new SakuraCloudClient({ credentials: creds, dryRun: false })
      const state = loadCloudState(projectDir, spec)

      // イメージの置き場が**実在するか**（手元の認証情報だけを信じない）
      try {
        const listed = await client.listContainerRegistries(spec.region)
        if (listed.dryRun === false && listed.ok) {
          const names = pickContainerRegistries(listed.data).map(r => r.subdomainLabel)
          const recorded = state.meta?.registryName
          if (!recorded) add('registry', 'イメージの置き場', 'ok', '公開のときに用意します。')
          else if (names.includes(recorded)) add('registry', 'イメージの置き場', 'ok', `『${recorded}』が使えます。`)
          // **直し方が分かっているなら、その場で押せるようにする**（2026-08-14 Ryosuke 指摘）
          else add('registry', 'イメージの置き場', 'ng', `『${recorded}』が見つかりません（削除された可能性があります）。下のボタンで作り直せます。`, 'reset-registry')
        } else {
          add('registry', 'イメージの置き場', 'warn', '確認できませんでした（公開はできます）。')
        }
      } catch { add('registry', 'イメージの置き場', 'warn', '確認できませんでした（公開はできます）。') }

      // 公開名が空いているか（**自分のアプリなら衝突ではない**）
      try {
        const apps = await client.listApps()
        if (apps.dryRun === false && apps.ok) {
          const rows: any[] = (apps.data as any)?.data ?? []
          const mine = state.resources.find(r => r.kind === 'apprun-app')?.id
          const hit = rows.find(a => String(a?.name ?? '') === spec.name)
          if (!hit) add('name', '公開名', 'ok', `『${spec.name}』は使えます。`)
          else if (mine && String(hit.id) === String(mine)) add('name', '公開名', 'ok', `『${spec.name}』は、このプロジェクトが公開済みのものです（更新になります）。`)
          else add('name', '公開名', 'ng', `『${spec.name}』は、Koto の記録に無い別のアプリが使っています。公開名を変えるか、さくらのコントロールパネルでそのアプリを削除してください。`)
        } else {
          add('name', '公開名', 'warn', '確認できませんでした（公開はできます）。')
        }
      } catch { add('name', '公開名', 'warn', '確認できませんでした（公開はできます）。') }

      // 保存場所が**実在するか**（409 を「ある」と読んだ失敗の再発防止）
      const bucket = consentedBuckets(spec.persistence?.objectStorage)[0]
      if (bucket) {
        try {
          const os = new ObjectStorageClient({ credentials: creds, dryRun: false })
          const site = await os.pickSite()
          if (!(await os.isSiteReady(site.id))) {
            add('storage', 'データの保存場所', 'ng', '保存場所の利用がまだ始まっていません。「③公開」の案内から用意してください。')
          } else {
            const names = (await os.listBuckets(site.id)).map(b => b.name)
            if (names.includes(bucket.bucket)) add('storage', 'データの保存場所', 'ok', `『${bucket.bucket}』が使えます。`)
            else add('storage', 'データの保存場所', 'ng', `『${bucket.bucket}』が見つかりません。「③公開」の案内から選び直してください。`)
          }
        } catch { add('storage', 'データの保存場所', 'warn', '確認できませんでした（公開はできます）。') }
      }

      return { ok: true, ...summarizePreflight(sortChecks(checks)) }
    } catch (e: any) {
      return { ok: false, canPublish: true, summary: '確認できませんでした', checks, message: e?.message ?? String(e) }
    }
  })

  /**
   * このプロジェクトの保存場所の設定を読む（③公開の案内が「用意済みか」を出すため）。
   * env.json の persistence から、**同意済みのもの**だけを返す。
   */
  ipcMain.handle('storage:placement', (_e, projectDir: string) => {
    try {
      const spec = loadCloudSpec(String(projectDir || ''))
      const b = spec ? consentedBuckets(spec.persistence?.objectStorage)[0] : undefined
      if (!b) return { ok: true, placement: null }
      return { ok: true, placement: { bucket: b.bucket, prefix: b.prefix ?? '', shared: b.shared !== false, consentedAt: b.consentedAt ?? '' } }
    } catch (e: any) {
      return { ok: false, placement: null, message: e?.message ?? String(e) }
    }
  })

  /**
   * 保存場所を用意する（③公開の案内から。**費用の同意を得てから呼ぶこと**）。
   *
   * ここで行うのは3つ。**どれも課金に直結する**ので、まとめて1回の同意で済ませる:
   *   1. サイトの利用開始（`POST /account`）… まだなら
   *   2. バケットの作成（**1つにつき月額**）… 既にあれば使い回す（409 は正常）
   *   3. env.json への記録（`consentedAt` 付き）… これが無いと公開で用意されない
   *
   * `bucket` を指定すると、**既にある保存場所に相乗り**する（費用は増えない）。
   * 指定が無ければ共有／専用の既定に従って名前を決める。
   */
  ipcMain.handle('storage:prepare', async (_e, projectDir: string, opts?: { mode?: BucketMode; bucket?: string }) => {
    const creds = loadCredentials()
    if (!creds) return { ok: false, message: 'さくらのクラウドのAPIキーが未登録です' }
    const dir = String(projectDir || '')
    if (!path.isAbsolute(dir)) return { ok: false, message: 'プロジェクトフォルダのパスが不正です' }

    try {
      // 1. 記録先の spec を用意する（まだ公開の設定が無ければ既定から作る）
      let spec = loadCloudSpec(dir)
      if (!spec) {
        const hasDockerfile = fs.existsSync(path.join(dir, 'Dockerfile'))
        spec = defaultSpec({ name: normalizeSpecName(path.basename(dir)), hasDockerfile })
      }

      // 2. 置き場所を決める。**プロジェクト名ではなく spec.name で分ける**
      //    （フォルダ名を変えても、公開済みのデータの置き場所が変わらないように）
      const mode: BucketMode = opts?.mode === 'dedicated' ? 'dedicated' : 'shared'
      const chosen = String(opts?.bucket || '').trim()
      if (chosen && !isValidBucketName(chosen)) {
        return { ok: false, message: '保存場所の名前は、英字で始まる小文字の英数字とハイフン（3〜63文字）にしてください。' }
      }
      const placement = chosen
        ? { bucket: chosen, prefix: prefixForProject(spec.name), shared: mode !== 'dedicated' }
        : resolvePlacement({ projectName: spec.name, mode, sharedBucket: sharedBucketName(creds.token) })

      // 3. **課金の前に、記録できることを確かめる。** 順番が逆だと「バケットは
      //    作られた（＝課金された）のに env.json に書けなかった」が起こりうる。
      //    バケット名の長さの上限が spec 側（40字）のほうが厳しく、専用モードで
      //    プロジェクト名が長いと、ここで初めて弾かれる
      spec.persistence = {
        objectStorage: [{
          bucket: placement.bucket,
          prefix: placement.prefix,
          shared: placement.shared,
          consentedAt: new Date().toISOString(),
        }],
      }
      const validated = validateSpec(spec)
      if (!validated.ok) {
        return { ok: false, message: `保存場所の設定を作れませんでした（費用は発生していません）: ${validated.errors.join(' / ')}` }
      }

      // 4. サイトの利用開始とバケットの作成。**ここが課金の始まり**
      const client = new ObjectStorageClient({ credentials: creds, dryRun: false })
      const site = await client.pickSite()
      const started = !(await client.isSiteReady(site.id))
      if (started) await client.startSite(site.id)
      const created = await client.createBucket(site.id, placement.bucket)
      // **作れたと決めつけない。** 作成APIは 409 を返すことがあり、それを
      // 「もうある」と読んでいる。同じ名前を消した直後は名前が解放されておらず、
      // 作られていないのに 409 になり得る（2026-08-14）
      const names = (await client.listBuckets(site.id)).map(b => b.name)
      if (!names.includes(placement.bucket)) {
        return {
          ok: false,
          message: `保存場所『${placement.bucket}』を作成しましたが、一覧に現れません。`
            + '同じ名前の保存場所を削除した直後は、名前が解放されるまで作り直せないことがあります。'
            + 'しばらく待ってからお試しください。'
            + `（作成の応答: HTTP ${created.status}${created.text ? ' ' + created.text : ''}）`,
        }
      }

      // 5. env.json に記録する。**consentedAt がここで付く**（これが無いと
      //    planner が要求せず、公開しても用意されない）
      const file = cloudFilePath(dir, CLOUD_ENV_FILE)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(validated.spec, null, 2) + '\n', 'utf-8')

      // 6. データ層も置いておく（既にあれば触らない）。これが無いと、
      //    AI に書き直してもらった import 先が存在しない
      let placed = false
      try { placed = ensureDataLayer(dir) } catch { /* 置けなくても保存場所の用意は成立する */ }

      return {
        ok: true,
        placement: { bucket: placement.bucket, prefix: placement.prefix, shared: placement.shared },
        siteName: site.display_name,
        startedSite: started,
        dataLayerPlaced: placed,
        note: storageCostNote(mode, BUCKET_MONTHLY_YEN),
      }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle('storage:createBucket', async (_e, name: string) => {
    const creds = loadCredentials()
    if (!creds) return { ok: false, message: 'さくらのクラウドのAPIキーが未登録です' }
    const bucket = String(name || '').trim()
    if (!isValidBucketName(bucket)) {
      return { ok: false, message: '保存場所の名前は、英字で始まる小文字の英数字とハイフン（3〜63文字）にしてください。' }
    }
    try {
      const client = new ObjectStorageClient({ credentials: creds, dryRun: false })
      const site = await client.pickSite()
      if (!(await client.isSiteReady(site.id))) await client.startSite(site.id)
      const created = await client.createBucket(site.id, bucket)
      // **作れたと決めつけない**（apply・prepare と同じ守り。2026-08-14）
      const names = (await client.listBuckets(site.id)).map(b => b.name)
      if (!names.includes(bucket)) {
        return {
          ok: false,
          message: `保存場所『${bucket}』を作成しましたが、一覧に現れません。`
            + 'その名前は使えないか、削除した直後で名前が解放されていない可能性があります。別の名前でお試しください。'
            + `（作成の応答: HTTP ${created.status}${created.text ? ' ' + created.text : ''}）`,
        }
      }
      return { ok: true, bucket }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

}
