// AppRun 専有型の IPC（apprunDedicated:*）。
// 段階(1)（下調べ画面。GET のみ）に加え、段階(2)「作る」＋(4)「破棄」を持つ。
// 掟4（方式B）: 認証情報は renderer から引数で受け取るだけで、main には保存しない
// （src/main/cloud/apprunDedicated.ts と同じ方針）。
import { ipcMain } from 'electron'
import { getLimits, getWorkerClasses, getLbClasses, listClusters, getCluster, type ApprunDedicatedResult } from '../cloud/apprunDedicated'
import { getZones } from '../cloud/zones'
import { createClusterFlow, type ApprunDedicatedClusterSpec } from '../cloud/apprunDedicatedApply'
import { publishAppFlow } from '../cloud/apprunDedicatedAppApply'
// D-5（2026-09-16）: 手順8「🔄 IP を取り直す」。上の import 行は tests/apprunDedicatedIpcWiring.test.ts が
// 文字列で固定しているため、別行で足す（AppRunDedicatedPanel.tsx の runPublishApp と同じ理由）。
import { refreshLbAddresses } from '../cloud/apprunDedicatedAppApply'
// O-1（2026-09-17）: 手順8「🔎 公開先と https を確かめる」。手順8の verify（DNS を向ける前に走る）には
// 足せないので、別の口にする（理由は cloud/dedicatedSiteCheck.ts 冒頭）。
import { checkDedicatedSite } from '../cloud/dedicatedSiteCheck'
import { prepareAppImage } from '../cloud/imagePublish'
import { loadCloudSpec, loadCloudState } from '../cloud/specStore'
import type { EnvSpec } from '../cloud/spec'
import { fetchDedicatedTelemetryStatus, enableDedicatedTelemetry } from '../cloud/monitoring'
import { withProjectLock, projectBusyMessage } from '../projectLock'
// 進捗の送り口は1つ（記録の更新と renderer への通知を兼ねる）。2026-09-29・projectOps.ts
import { progressReporter } from '../projectOps'
// 2026-10-07: どこにどれくらい時間がかかったかを残す。段の切り替わりの送り口（stageReporter）と、段の内部名（定義は
// shared/stageTiming.ts の1か所）。上の import 行はテストが文字列で固定しているため、別行で足す。
import { stageReporter } from '../projectOps'
import { STAGE, UNMEASURED, type StageTimings } from '../../shared/stageTiming'
import { readApprunDedicatedFs, markPendingFs, clearPendingFs, writePublishRecordFs } from '../publishMetaFs'
import { readHasLetsEncryptEmail } from '../../shared/apprunDedicatedShapes'
import { deriveApplicationName } from '../../shared/apprunDedicatedApp'
// 2026-09-23: 専有型にも「保存場所の鍵」を渡す。発行・片づけの実体は共用型・HANAMII と同じ関数
// （公開先を引数に取る形になっている）。ここで新しく書かない（掟10「一元定義」）。
// 上の import 行は tests/apprunDedicatedIpcWiring.test.ts が文字列で固定しているため、
// 環境変数の上限は別行で足す（refreshLbAddresses と同じ理由）。
import { MAX_ENV_COUNT } from '../../shared/apprunDedicatedApp'
import { issueStorageEnvFor, cleanUpOldKeysFor, revokeIssuedKey, type StorageEnvResult } from '../cloud/storageForTarget'
// 2026-09-24（Ryosuke 決定）: 手順6の破棄で保存場所も片づける。その削除の節は 2026-10（0.6.22 段階3B-1）に
// ipc/apprunDedicatedTeardown.ts へ移した（共通の骨 cloud/teardownShell.ts に載る）。
// 記録の書き戻しは publishMetaFs の既存関数（上の import 行はテストが文字列で固定しているため別行で足す）。
import { writeApprunDedicatedRecordFs } from '../publishMetaFs'
// 2026-09-23 検分: 片づけの門（応答を確かめられたか）・件数の事前確認・途中で止まったときの後始末。
// **どれも新しい判定を書かず、既にある純関数を使う**（掟10「一元定義」）。
import { dedicatedVerifySettled } from '../../shared/publishVerify'
import { consentedBuckets, STORAGE_ENV } from '../../shared/objectStorage'
import { stageLeftNoVersion } from '../cloud/apprunDedicatedAppApply'
import { SakuraCloudClient, apiErrorMessage } from '../cloud/client'
import { checkBilling, type ConnCheck } from '../cloud/connectionCheck'
import { isTelemetryKind, DEDICATED_VARIANTS } from '../../shared/appLog'
// 2026-09-25 検分: 公開の直前に koto-data を置く（ほか4経路と同じ約束）。置く実体も、
// 差し替えを知らせる文も**既にあるもの**を使う（掟10）。上の import 行は
// tests/apprunDedicatedIpcWiring.test.ts が文字列で固定しているため、別行で足す
// （refreshLbAddresses と同じ理由）。
import { ensureDataLayer } from '../dataLayer'
import { resolvePublishRoot } from '../publishRootFs'
import { dataLayerUpdateLine } from '../../shared/storageNoticeText'
import type { IpcDeps } from './types'
// 2026-10（0.6.22 段階3B-1）: 削除は ipc/apprunDedicatedTeardown.ts へ移した。isCreds・recordedZone は作成・公開も使うので
// 3つ目の小さなファイルに置く（互いに require し合う循環を作らない。理由は apprunDedicatedCommon.ts 冒頭）。
import { isCreds, recordedZone } from './apprunDedicatedCommon'
import { registerApprunDedicatedTeardownHandler } from './apprunDedicatedTeardown'
// 確認の印の読み方（`confirmed === true` のときだけ true）は破棄の骨の1つ。作成・公開もこれを使う（同じ中身を2つ持たない）。
import { isConfirmed } from '../cloud/teardownShell'

// 請求（コスト）参照はアカウント単位（どのゾーン経由でも可）。共用型 cloud:testConnection と同じゾーン。
const BILLING_ZONE = 'is1a'

const NO_KEY: ApprunDedicatedResult = { ok: false, message: 'クラウドのAPIキーが未登録です' }

/**
 * その場の結果（IPC の返り値）に、段ごとの所要時間を載せる（2026-10-07）。時間は鍵の中で測っているので、
 * 結果を返す直前（鍵を放したあと）に足す。**記録（projectOps の結果の extra.stageTimings）と同じ値**——
 * ダイアログを閉じて開き直したときは記録から、その場で終わったときはここから、同じ「かかった時間を見る」を出す（双子）。
 * 段を渡さなかった・早く止まった（時間が無い）ときは、返り値をそのまま返す。
 */
function withStageTimings<T extends object>(value: T, stageTimings: StageTimings | undefined): T & { stageTimings?: StageTimings } {
  return stageTimings ? { ...value, stageTimings } : value
}

/**
 * 公開が途中で止まったときに、**いま発行したばかりの鍵だけ**を取り消す（2026-09-23 検分の指摘5・10）。
 *
 * 片づけ（cleanUpOldKeysFor）は成功した公開でしか走らないので、ここで取り消さないと
 * 「バケットへ読み書きできる本物の鍵」が、押した回数だけ溜まる（実機で5件・storageKeys.ts 冒頭）。
 * **古い鍵には触れない**ので、動いているアプリが 403 で落ちる危険は無い。
 * **まだどの版にも載っていないと分かるときだけ呼ぶこと**（判断は stageLeftNoVersion）。
 * 後始末の失敗で公開の結果を変えない（共用型・HANAMII の片づけと同じ扱い）。
 */
async function revokeJustIssuedKey(storage: StorageEnvResult): Promise<void> {
  if (!storage.ok) return
  try { await revokeIssuedKey({ permissionId: storage.permissionId }) } catch { /* 後始末の失敗で結果を変えない */ }
}

/** renderer から渡された値が createClusterFlow に渡せる形か（最低限の型チェック）。 */
function isClusterSpec(v: unknown): v is ApprunDedicatedClusterSpec {
  const s = v as any
  return !!s && typeof s.name === 'string' && Array.isArray(s.ports) && typeof s.servicePrincipalID === 'string'
    && typeof s.zone === 'string' && typeof s.workerServiceClassPath === 'string' && typeof s.lbServiceClassPath === 'string'
    && typeof s.minNodes === 'number' && typeof s.maxNodes === 'number'
}

/**
 * 手順8「アプリを公開する」の入力（画面の入力欄そのまま・D-4）。preload が type import する。
 * 値の範囲（cpu 100〜64000 等）はここでは見ない——publishAppFlow 内の validateAppSpec が最後の砦
 * （同じ検証を二重に書かない・掟10）。ここは「形」だけ。
 */
export type AppPublishInput = {
  /** 独自ドメインのホスト名（小文字）。 */
  host: string
  cpu: number
  memory: number
  fixedScale: number
  /** 無ければ env.json の service.probePath を使う。 */
  healthCheckPath?: string
  /** クラスタに Let's Encrypt のメールが未設定のときだけ要る。 */
  letsEncryptEmail?: string
}

/** renderer から渡された値が publishApp に渡せる形か（最低限の型チェック。isClusterSpec と同じ役割）。 */
function isAppPublishInput(v: unknown): v is AppPublishInput {
  const s = v as any
  return !!s && typeof s === 'object'
    && typeof s.host === 'string'
    && Number.isInteger(s.cpu) && Number.isInteger(s.memory) && Number.isInteger(s.fixedScale)
    && (s.healthCheckPath === undefined || typeof s.healthCheckPath === 'string')
    && (s.letsEncryptEmail === undefined || typeof s.letsEncryptEmail === 'string')
}

/**
 * `opts.consented === true` のときだけ true（#38。共用型 cloud:enableTelemetry と同じ最後の砦）。
 * renderer から渡された値の形は信用しない（不正な形なら false＝同意なし扱いの安全側）。
 */
function isTelemetryConsented(opts: unknown): boolean {
  return !!opts && typeof opts === 'object' && (opts as any).consented === true
}

export function registerApprunDedicatedHandlers(_deps: IpcDeps) {
  // 接続テスト（roadmap #35）＝共用型 cloud:testConnection と同じ「チェックリスト」の形に揃える。
  // (1) 専有型API 参照（制限・プラン。GET /limits） (2) コンテナレジストリ 一覧（GET） (3) 請求（コスト）参照。
  // どれも GET のみ（読み取り専用・何も作らない）。
  // W-38（2026-09-27 決定・案2）: 専有型はすでに手順8でアプリを公開でき、公開にはレジストリの
  // 権限が要る（共用型 cloud:testConnection の (2) と同じ確認）。「まだ確認しない」という
  // 前提はもう食い違っているため、共用型と同じチェックを足し、画面側の注記（もう公開できるのに
  // 「まだ対応していません」と読める文）は削除する。請求チェックは共用型と同じ関数を呼ぶ
  // （判断・表示を複製しない・掟10）。
  ipcMain.handle('apprunDedicated:testConnection', async (_, auth: unknown) => {
    if (!isCreds(auth)) {
      const ng: ConnCheck = { ok: false, message: 'クラウドのAPIキーが未登録です' }
      return { ok: false, checks: { api: ng, registry: ng, billing: ng } }
    }
    const limits = await getLimits(auth)
    const api: ConnCheck = limits.ok ? { ok: true } : { ok: false, message: limits.message }

    const client = new SakuraCloudClient({ credentials: auth, dryRun: true })

    // (2) コンテナレジストリ 一覧（IaaS CommonServiceItem の GET）。共用型 cloud:testConnection と
    // まったく同じ判定（複製ではなく、同じ形をここにも書く——client 自体は共通の SakuraCloudClient）。
    let registry: ConnCheck
    try {
      const r = await client.listContainerRegistries(BILLING_ZONE)
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

    const billing = await checkBilling(client, BILLING_ZONE)

    return { ok: api.ok && registry.ok && billing.ok, checks: { api, registry, billing } }
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

  // GET /zone（さくらのクラウド API v1.1 設備関連API・roadmap #28）。手順5のゾーン選択式化に使う。
  // GETのみ・src/main/cloud/zones.ts に一元化（ここではキー確認と委譲だけ）。
  ipcMain.handle('apprunDedicated:zones', async (_, auth: unknown) => {
    if (!isCreds(auth)) return NO_KEY
    return getZones(auth)
  })

  // 段階(2)「作る」: クラスタ→ASG→LB の順で作り、各段の成功直後に .sakuraide.json へ記録する。
  // 同意（consentedAt）が記録に無ければ createClusterFlow 自身が API を一度も呼ばずに中止する。
  // opts.confirmed（第4引数）は今回の確認ダイアログを通ったかの印（2026-09-10 レビューの修理・A）。
  ipcMain.handle('apprunDedicated:create', async (_, projectDir: unknown, auth: unknown, spec: unknown, opts: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, stage: 'consent', message: 'プロジェクトフォルダが不正です' }
    if (!isCreds(auth)) return { ok: false, stage: 'consent', message: 'クラウドのAPIキーが未登録です' }
    if (!isClusterSpec(spec)) return { ok: false, stage: 'consent', message: '入力が不正です' }
    // 作成は数個のAPIを順に呼ぶだけで待ちが無い（createClusterFlow は進捗を出さない）ので、
    // 記録には「いま作っています」の1文だけを置く。閉じて開き直した画面が結果を読めるのが目的。
    const progress = progressReporter(projectDir)
    // 段（クラスタ → ASG → LB）の切り替わりだけを記録に渡す。画面に出す文は上の1つのまま（2026-10-07）。
    const onStage = stageReporter(projectDir)
    // H-1: 同じプロジェクトで作成・削除・公開を同時に走らせない（src/main/projectLock.ts）。
    const r = await withProjectLock(projectDir, '作成', () => {
      progress('🏗 クラスタ・オートスケーリンググループ・ロードバランサを作っています…')
      return createClusterFlow(auth, projectDir, spec, { confirmed: isConfirmed(opts), onStage })
    }, { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:create', secrets: [auth.token, auth.secret], zone: spec.zone })
    return r.busy ? { ok: false, stage: 'consent', message: projectBusyMessage(r.running, r.runningTarget) } : withStageTimings(r.value, r.stageTimings)
  })

  // 段階(4)「破棄」（apprunDedicated:teardown）は ipc/apprunDedicatedTeardown.ts（共通の骨 cloud/teardownShell.ts に載る）。
  // 手順6も 📡 の 🗑 も、この1つを通る。
  registerApprunDedicatedTeardownHandler()

  // 現在の記録（何が作られているか）を返す。API を呼ばない、ただのファイル読み取り。
  ipcMain.handle('apprunDedicated:state', async (_, projectDir: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return {}
    return readApprunDedicatedFs(projectDir)
  })

  // ── 手順8「アプリを公開する」（D-4）──────────────────────────────────────────
  // 前提を1回で返す: 記録（クラスタ・アプリ）／env.json の有無・ポート・環境変数の数／
  // クラスタに Let's Encrypt のメールが設定済みか。GET のみ・何も作らない。
  // hasLetsEncryptEmail は記録に clusterID があり auth が使えるときだけ GET /clusters/{id} で確かめ、
  // 取れなければ null（「分からない」を true にも false にも倒さない・掟10。画面は null を false と同じに
  // 扱ってメール欄を出す側に倒す＝publishAppFlow の lets-encrypt 段と同じ方針）。
  // env.json が壊れている（validateSpec 不合格）ときは loadCloudSpec が throw するので ok:false で返す。
  ipcMain.handle('apprunDedicated:appStatus', async (_, projectDir: unknown, auth: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, message: 'プロジェクトフォルダが不正です' }
    const record = readApprunDedicatedFs(projectDir)
    let spec: EnvSpec | null
    try {
      spec = loadCloudSpec(projectDir)
    } catch (e: any) {
      return { ok: false, message: `公開の設定を読めませんでした: ${e?.message ?? String(e)}` }
    }
    let hasLetsEncryptEmail: boolean | null = null
    if (record.clusterID && isCreds(auth)) {
      const r = await getCluster(auth, record.clusterID)
      hasLetsEncryptEmail = r.ok ? readHasLetsEncryptEmail(r.data) : null
    }
    return {
      ok: true,
      hasLetsEncryptEmail,
      envReady: !!spec,
      port: spec?.service.port ?? null,
      envCount: spec?.service.env.length ?? 0,
      record,
    }
  })

  // 手順8「🔄 IP を取り直す」（D-5・2026-09-16）: 記録の clusterID/asgID/loadBalancerID で LB ノードの一覧を
  // 1 回引き、素の IP（bareIp・`IP/24` の `/` より前）を記録（lbAddresses）して返す。GET と記録の書き込みだけ・
  // 何も作らない・待たない（待つのは publishAppFlow の lb-address 段）。判断は cloud/apprunDedicatedAppApply.ts の
  // refreshLbAddresses に一元化してあり、ここは「形の検査と委譲」だけ（掟10）。
  ipcMain.handle('apprunDedicated:lbAddresses', async (_, projectDir: unknown, auth: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, message: 'プロジェクトフォルダが不正です' }
    if (!isCreds(auth)) return { ok: false, message: 'クラウドのAPIキーが未登録です' }
    return refreshLbAddresses(auth, projectDir)
  })

  // 手順8「🔎 公開先と https を確かめる」（O-1・2026-09-17）: 記録のホスト名とロードバランサの IP で、
  // ドメインの向き先・証明書・ブラウザで開けるか・アプリの応答の4つを1回だけ調べて、画面に出す行を返す。
  // **何も作らず・何も変えない**（読むだけ）ので、同意も確認ダイアログも要らない。さくらの API も
  // 呼ばない（証明書の状態を読む手段が無い）ので auth も取らない——**要らない鍵を渡さない**（掟4）。
  // 判断は shared/publishVerify.ts の純関数に一元化してあり、ここは「形の検査と委譲」だけ（掟10）。
  ipcMain.handle('apprunDedicated:checkSite', async (_, projectDir: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, message: 'プロジェクトフォルダが不正です' }
    return checkDedicatedSite(projectDir)
  })

  // 記録済みのクラスタの上に、このプロジェクトのアプリを公開する。
  //   形の検査 → 公開開始マーカー → env.json → イメージの組み立て・push（prepareAppImage・共用型と同じ関数）
  //   → publishAppFlow（アプリ/バージョン作成・有効化・古い世代の掃除・LBアドレス） → 公開記録。
  // 掟4（方式B）: creds は引数 auth（main には保存しない。共用型 cloud:apply の loadCredentials は真似しない）。
  // opts.confirmed（第5引数）は今回の確認ダイアログを通ったかの印。**通っていなければ、イメージの組み立て
  // （レジストリへの push＝書き込み）にも入らない**——publishAppFlow 自身の consent 段は最後の砦として残す。
  // 進捗は 'apprunDedicated:publish-progress' で逐次通知する（teardown-progress と同じ形）。
  // 失敗の形は publishAppFlow の PublishAppResult に揃える（stage:'image' はイメージの段の失敗。
  // hint:'reset-registry' は「レジストリの接続情報が古い」の印。専有型パネルには共用型のような
  // 「↻ レジストリを設定し直す」ボタン自体は無いため、画面側はこの hint を見て、共用型タブの
  // そのボタンへ誘導する案内文だけを出す（publishFailureHintText・src/shared/publishLabels.ts）。
  ipcMain.handle('apprunDedicated:publishApp', async (event, projectDir: unknown, auth: unknown, input: unknown, opts: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, stage: 'invalid', message: 'プロジェクトフォルダが不正です' }
    if (!isCreds(auth)) return { ok: false, stage: 'invalid', message: 'クラウドのAPIキーが未登録です' }
    if (!isAppPublishInput(input)) return { ok: false, stage: 'invalid', message: '入力が不正です' }
    if (!isConfirmed(opts)) return { ok: false, stage: 'consent', message: '確認ダイアログを通っていません' }
    // 送り口は projectOps.ts の1つ（progressReporter）: 処理の記録も更新するので、手順8のダイアログを
    // 閉じて開き直した画面も、いまの進み具合を続きから読める（2026-09-29）。
    const progress = progressReporter(projectDir, msg => event.sender.send('apprunDedicated:publish-progress', msg))
    // 段の切り替わり（準備 → イメージ → 確認 → アプリ → … → 古いアクセスキーの削除）。文は変えない（2026-10-07）。
    // 準備とイメージと古いアクセスキーの段はここで、確認〜コンテナの段は publishAppFlow が同じ口へ渡す。
    const onStage = stageReporter(projectDir)
    // koto-data を新しい版へ差し替えたときの1行（下の ensureDataLayer で入る。何もしていなければ空）。
    let dataLayerLine = ''
    /**
     * 公開の結果に「koto-data を差し替えた」の1行を**必ず**載せる（2026-09-25 検分）。
     *
     * 差し替えは利用者のファイルを書き換える操作なので、**黙って済ませない**。
     * 成功したときは warnings（画面が黄色で出す）、失敗したときはメッセージの末尾に足す
     * （失敗の画面は message しか出さないため）。Vercel の同じ守りと形を揃えてある。
     */
    const withDataLayerNote = <T extends { ok: boolean; message?: string; warnings?: string[] }>(r: T): T => {
      if (!dataLayerLine) return r
      return r.ok
        ? { ...r, warnings: [...(r.warnings ?? []), dataLayerLine] }
        : { ...r, message: [r.message, dataLayerLine].filter(Boolean).join('\n') }
    }
    // H-1: 破棄と同時に走らせない（記録が交錯して、消せない資源が残る）。
    // 破棄は実測で約9分かかるので、窓は広い。画面のフラグは窓の再読み込みで消えるため、ここにも置く。
    const locked = await withProjectLock(projectDir, '公開', async () => {
    // 公開開始マーカー（途中で中断・失敗しても後から検知できるようにする）。成功/失敗いずれでも finally で消す（roadmap #20）。
    markPendingFs(projectDir, 'sakura-apprun-dedicated')
    try {
      onStage(STAGE.publishPrepare) // 操作の始まりから、保存場所のアクセスキー・koto-data まで
      const spec = loadCloudSpec(projectDir)
      // W-36（2026-09-27 決定・案1）: 利用者はファイルを意識していない。「env.json を確認」と
      // 言われても、どこで何を見ればよいか分からない。画面では「公開の設定」とだけ言う。
      if (!spec) return { ok: false, stage: 'invalid', message: '公開の設定がありません。手順8の「公開の設定を作る」を押してから、もう一度お試しください' }
      const state = loadCloudState(projectDir, spec)

      // prepareAppImage は「Koto が組み立てる」（source.type !== 'image'）のときだけ呼べる（imagePublish.ts の前提）。
      // image 型（手で env.json を書いた場合だけ起きる。scaffoldEnv は常に dockerfile 型を書く）は、
      // レジストリ資格情報の出所が決まっていないので、ここで断る（推測で別のレジストリの資格情報を送らない）。
      if (spec.service.source.type === 'image') {
        return {
          ok: false, stage: 'image',
          message: '公開の設定の service.source が image 型です。専有型への公開は dockerfile 型（Koto がビルドするイメージ）にだけ対応しています。service.source を dockerfile 型に変えてから、もう一度お試しください',
        }
      }
      // ── データの保存を持っていく（2026-09-23 検分で発覚）──────────────────
      // 【公開】は「保存場所を用意すると、データが残るようになります」と約束している。
      // ところが鍵を渡していたのは HANAMII と AppRun 共用型だけで、**専有型は0件**だった。
      // 専有型もコンテナなので、渡さなければ**再公開のたびに中身ごと作り直され、データが消える**。
      // 利用者は「残る」と思って使うので、これは黙って失わせる形になる。
      //
      // **イメージの組み立て（レジストリへの push＝書き込み）より前に呼ぶ。**
      // 渡せないと分かったときに止めるなら、まだ何も書き込んでいないうちに止める。
      // シークレットは main の中で受け取り、そのまま公開の本文へ渡し切る——
      // **env.json にも、ほかのどのファイルにも書かない**（掟4・共用型と同じ）。
      //
      // ── 件数の確認は「発行より前」（2026-09-23 検分の指摘4・10）──────────────
      // 上限を超えるかどうかは**宣言済みの件数だけで前もって分かる**（保存場所の分は必ず
      // STORAGE_ENV の6件）。発行してから止めると、**バケットへ読み書きできる本物の鍵**が
      // 残る。片づけは成功した公開でしか走らないので、env.json を直すまで押すたびに1本ずつ増える。
      const willIssueStorageKey = consentedBuckets(spec.persistence?.objectStorage).length > 0
      const plannedStorageCount = willIssueStorageKey ? Object.keys(STORAGE_ENV).length : 0
      const storageKeyNames = new Set<string>(Object.values(STORAGE_ENV))
      // 手で書かれた KOTO_STORAGE_* は、鍵を渡すときだけ「いま発行した分」に置き換わる（下の env と同じ数え方）
      const declaredCount = willIssueStorageKey
        ? spec.service.env.filter(e => !storageKeyNames.has(e.name)).length
        : spec.service.env.length
      const plannedEnvCount = declaredCount + plannedStorageCount
      // 足した結果、上限を超えることがある。**黙って切り落とさない**（切り落とすと、
      // どれが落ちたか分からないまま「データが残らない」「設定が効かない」が起きる）。
      if (plannedEnvCount > MAX_ENV_COUNT) {
        // 保存場所を使っていない人に「データの保存に使う設定（0件）」と言わない（検分の指摘6・8・11）。
        return {
          ok: false, stage: 'invalid',
          message: '環境変数が多すぎます。'
            + (plannedStorageCount > 0
              ? `データの保存に使う設定（${plannedStorageCount}件）を合わせると${plannedEnvCount}件になり、`
              : `${plannedEnvCount}件あり、`)
            + `この公開先で指定できる上限（${MAX_ENV_COUNT}件）を超えます。`
            + `公開の設定の環境変数を${plannedEnvCount - MAX_ENV_COUNT}件減らしてから、もう一度お試しください`,
        }
      }

      // 鍵の発行はさくらへの要求（認証情報の復号とアダプタの接続を含む）で、数秒止まることがある。
      // **押したのに何も起きない時間を作らない**（検分の指摘13・各段の頭で1回ずつ出すのと同じ形）。
      if (willIssueStorageKey) progress('🔑 保存場所のアクセスキーを用意しています…')
      const storage = await issueStorageEnvFor({ projectDir, target: 'apprun-dedicated' })
      if (!storage.ok && storage.reason === 'error') {
        // reason:'none'（保存場所を用意していない）は失敗ではない＝何も足さずに公開を続ける
        // （勝手にバケットを作らない＝勝手に課金しない）。止めるのは 'error' だけ。
        return {
          ok: false, stage: 'storage',
          message: `${storage.message}\nこのまま公開すると、アプリに入力されたデータが公開のたびに消えてしまうため、公開を中止しました。`,
        }
      }
      const storageEnv = storage.ok ? storage.envs : []
      // 同じ名前を env.json に手で書いていても、**いま発行した鍵を優先する**（HANAMII と同じ。
      // 手で書かれた値は古い可能性があり、古い鍵は片づけで無効になる）。
      const storageNames = new Set(storageEnv.map(e => e.key))
      const env = [
        ...spec.service.env.filter(e => !storageNames.has(e.name)).map(e => ({ key: e.name, value: e.value, secret: false })),
        ...storageEnv,
      ]

      // ── 公開の直前に koto-data を置く（2026-09-25 検分。ほか4経路と同じ約束）───────
      // AI への説明文（aiContext.ts の DATA_RULE）は「『試す』『公開』を押した直前に
      // Koto が置きます」と言い切っており、共用型（cloud.ts）・HANAMII・Vercel・レンタルサーバは
      // 全部そうしている。**専有型の手順8だけが通っていなかった**ので、AI が約束どおり書いた
      // `require('./koto-data.cjs')` の読み込み先がイメージに入らず、コンテナが
      // `Cannot find module` で起動しない（2026-09-23 に共用型・HANAMII で起きた形のまま）。
      //
      // **組み立てる前に置く。** あとで置いても、像の中には入らない。
      // ensureDataLayer は「印があって版が古いもの」を新しい版へ差し替える唯一の自動経路でも
      // あるので、専有型に公開したアプリにだけ koto-data の直しが届かない問題もここで閉じる。
      // **差し替えたときは黙らない**（withDataLayerNote で公開の結果に必ず載せる）——
      // 公開ボタンを押しただけで利用者のファイルが変わるのを、黙って済ませない。
      try {
        const layer = ensureDataLayer(resolvePublishRoot(projectDir), projectDir)
        if (layer.replaced) dataLayerLine = dataLayerUpdateLine({ ok: true, file: layer.file, replaced: true })
      } catch { /* 置けなくても公開は続ける（ほか4経路と同じ） */ }

      // イメージのビルドとプッシュ（内蔵ビルダー crane は両方を1つのプロセスで行うので、外から分けられない＝1段・2026-10-07）。
      onStage(STAGE.publishImage)
      const img = await prepareAppImage({ projectDir, spec, state, creds: auth, progress })
      if (!img.ok) {
        // ここで止まると、いま発行した鍵を**誰も使わないまま**残す（検分の指摘5・10）。
        // まだどの版にも載せていないので、取り消しても動いているアプリには触れない。
        await revokeJustIssuedKey(storage)
        return withDataLayerNote({
          ok: false, stage: 'image', message: img.message,
          ...(img.detail ? { detail: img.detail } : {}),
          ...(img.hint ? { hint: img.hint } : {}),
        })
      }

      const result = await publishAppFlow(auth, projectDir, {
        spec: {
          name: deriveApplicationName(spec.name),
          host: input.host,
          port: spec.service.port,
          cpu: input.cpu,
          memory: input.memory,
          fixedScale: input.fixedScale,
          // 宣言された環境変数＋保存場所の鍵（上で組み立てたもの）。**どちらも落とさない。**
          env,
          healthCheckPath: input.healthCheckPath ?? spec.service.probePath,
        },
        imageRef: img.ref,
        registry: { username: img.registryAuth.username, password: img.registryAuth.password },
        letsEncryptEmail: input.letsEncryptEmail ?? null,
        // D-7: verify 段（公開のあと、アプリが本当に応答しているか）の材料。
        // buildTag は像に焼き込んだ目印（.koto-build）の中身＝ imageBuild.ts の tagOfRef(ref) と同じ値、
        // runtimeKind は像の種類（静的配信のときだけ目印が公開物の直下に出る）。
        // **渡し忘れると確認が黙ってとばされる**ので、tests/apprunDedicatedWiring.test.ts が
        // この2行を固定している（掟10「任意の引数で機能を繋ぐと、渡し忘れても誰も気づかない」）。
        buildTag: img.tag,
        runtimeKind: img.runtimeKind,
      }, { confirmed: isConfirmed(opts), progress, onStage })
      // 公開記録を main 側で残す（renderer が閉じても失われない・roadmap #20。他の公開先と同じ publish.targets）。
      if (result.ok) {
        writePublishRecordFs(projectDir, 'sakura-apprun-dedicated', { publishedAt: new Date().toISOString(), url: result.url ?? null })
        // 2026-09-24: 手順6の破棄で鍵を無効にできるよう、**いま渡した鍵のIDだけ**を記録する
        // （共用型の state.meta.storagePermissionId に当たるもの）。
        // **secretKey は書かない**（掟4。秘密は main の中で公開の本文へ渡し切る）。
        // 記録するのは公開が成立したときだけ——途中で止まった鍵はこのあと取り消され、
        // そのとき記録を書き換えると**いま動いているアプリの鍵**を見失う。
        if (storage.ok) writeApprunDedicatedRecordFs(projectDir, { storagePermissionId: storage.permissionId })
        // 古い鍵の片づけは、**新しい版が応答したと確かめてからだけ**（掟10「切り替わる前に、
        // 古いほうの足元を外さない」）。デプロイの応答が返っても古いコンテナはまだ動いており、
        // その場で鍵を消すと**動いているアプリが 403 で落ちる**（2026-08-14 に共用型で実際に起き、
        // 原因の分からない 403 を1時間以上追う事故になった）。
        //
        // **`result.ok` は「動いた」の証拠ではない**（2026-09-23 検分の指摘1・2・3）。
        // publishAppFlow は verify 段が `no-backend`(503)・`error-status`(404/502)・`unreachable`、
        // さらに確認自体をとばしたとき（LBのIPが無い・ホスト名が無い＝ verify が付かない）でも
        // `ok:true, stage:'done'` を返す（apprunDedicatedAppApply.ts の 12・13 のコメント）。
        // 2026-09-16 の実機事故（LB が『no available server』を返し続け、コンテナが EACCES で
        // 再起動を繰り返していた）は、まさにその形だった。**確かめられたときだけ消す。**
        // 判断は既にある純関数 dedicatedVerifySettled（'ok' と 'responding' だけ true）に任せ、
        // ここで新しい判定を書かない。消さなかった鍵は、次に応答を確かめられた公開で片づく。
        //
        // 消すのは専有型の名前（`permissionNameFor(name, 'apprun-dedicated')`）の鍵だけで、
        // 共用型・HANAMII・他のプロジェクトの鍵には触れない（掟11・permissionsToCleanUp）。
        //
        // ⚠️ 片づけが走るのは**保存場所を使っている公開だけ**（storage.ok）。いちど保存場所つきで
        // 公開したあと env.json から保存場所が消えると（同意の取り消し・バケットの削除）、
        // 以前の鍵は誰にも片づけられないまま残る（検分の指摘7）。**保存場所をやめる操作の側で
        // 公開先ごとの鍵を無効にする**のが筋で、docs/roadmap.md に宿題として残してある。
        if (storage.ok && result.verify && dedicatedVerifySettled(result.verify)) {
          // W-5（2026-09-27 決定）: 「鍵」とだけ言うと、ガイドで「APIキー＝鍵」と教わった利用者が
          // 自分の登録したAPIキーが消されていると受け取りかねない。実際に消しているのは保存場所
          // （オブジェクトストレージ）の権限なので「保存場所の鍵」と言う（語順は「古い保存場所の鍵」
          // ＝「古い保存場所」の鍵、と読めないよう「保存場所の古い鍵」にする）。
          onStage(STAGE.publishKeyCleanup)
          progress('🧹 保存場所の古いアクセスキーを削除しています…')
          try {
            const cleaned = await cleanUpOldKeysFor({ projectName: storage.projectName, target: 'apprun-dedicated', keepId: storage.permissionId })
            // 1件ずつの失敗は中で飲み込まれるので、件数で見る（一部でも失敗した回の時間は保存しない・2026-10-07 検分2巡目）
            if ((cleaned?.failed ?? 0) > 0) onStage(STAGE.publishKeyCleanup, UNMEASURED)
          } catch {
            /* 片づけに失敗しても公開は成立している（共用型・HANAMII と同じ） */
            onStage(STAGE.publishKeyCleanup, UNMEASURED) // 失敗した片づけの時間は、保存しない（2026-10-07 検分）
          }
        }
      } else if (stageLeftNoVersion(result.stage)) {
        // 版が1つも作られていないと言い切れるときだけ、いま発行した鍵を取り消す（検分の指摘5・10）。
        // version-create 以降は**後から有効になりうる**ので触らない（消すと 403 になる）。
        await revokeJustIssuedKey(storage)
      }
      // 目印（.koto-keep）を置けなかった知らせ（issueStorageEnvFor が置き直す）。公開が成功した回の結果に、ほかの知らせと並べて載せる
      const markerNote = storage.ok ? storage.markerNote : undefined
      return withDataLayerNote(result.ok && markerNote ? { ...result, warnings: [...(result.warnings ?? []), markerNote] } : result)
    } catch (e: any) {
      progress('⚠️ 失敗しました')
      return withDataLayerNote({ ok: false, stage: 'invalid', message: e?.message ?? String(e) })
    } finally {
      clearPendingFs(projectDir)
    }
    }, { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:publishApp', secrets: [auth.token, auth.secret], zone: recordedZone(projectDir) })
    return locked.busy
      ? { ok: false, stage: 'consent', message: projectBusyMessage(locked.running, locked.runningTarget) }
      : withStageTimings(locked.value, locked.stageTimings)
  })

  // #38「手順7 ログ・メトリクス」: 専有型はクラスタ単位ではなくプロジェクト単位（resource_id
  // を送らない・5-12実測）。判断・GET/POSTの実装は共用型と共通の
  // src/main/cloud/monitoring.ts（fetchDedicatedTelemetryStatus/enableDedicatedTelemetry）に
  // 一元化してあり、ここは「呼ぶだけ」（掟10）。**何も作らない**（GETのみ）。
  ipcMain.handle('apprunDedicated:telemetryStatus', async (_, auth: unknown) => {
    if (!isCreds(auth)) return { ok: false, message: 'クラウドのAPIキーが未登録です' }
    return fetchDedicatedTelemetryStatus(auth)
  })

  // opts.consented（第3引数）は「費用に同意する」ボタンを押したときだけ true
  // （TelemetryNotice.tsx と同じ約束）。置き場が無ければ、同意が無い限り
  // 課金の始まる初期化は一度も呼ばれない（decideEnableTelemetry・enableDedicatedTelemetry）。
  // renderer は kind だけを渡す（どの variant が未接続かは main 側が一覧から判断する）。
  ipcMain.handle('apprunDedicated:enableTelemetry', async (_, auth: unknown, kind: unknown, opts: unknown) => {
    if (!isCreds(auth)) return { ok: false, message: 'クラウドのAPIキーが未登録です' }
    if (!isTelemetryKind(kind)) return { ok: false, message: '種類が不正です' }
    const variants = DEDICATED_VARIANTS.filter(v => v.kind === kind).map(v => v.name)
    return enableDedicatedTelemetry(auth, kind, variants, { consented: isTelemetryConsented(opts) })
  })
}
