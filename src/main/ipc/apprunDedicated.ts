// AppRun 専有型の IPC（apprunDedicated:*）。
// 段階①（下調べ画面。GET のみ）に加え、段階②「作る」＋④「破棄」を持つ。
// 掟4（方式B）: 認証情報は renderer から引数で受け取るだけで、main には保存しない
// （src/main/cloud/apprunDedicated.ts と同じ方針）。
import { ipcMain } from 'electron'
import { getLimits, getWorkerClasses, getLbClasses, listClusters, getCluster, type ApprunDedicatedResult } from '../cloud/apprunDedicated'
import { getZones } from '../cloud/zones'
import { createClusterFlow, teardownFlow, shouldForgetPublishRecord, type ApprunDedicatedClusterSpec } from '../cloud/apprunDedicatedApply'
import type { TeardownFlowResult } from '../cloud/apprunDedicatedApply'
import { publishAppFlow } from '../cloud/apprunDedicatedAppApply'
// D-5（2026-09-16）: ⑧「🔄 IP を取り直す」。上の import 行は tests/apprunDedicatedIpcWiring.test.ts が
// 文字列で固定しているため、別行で足す（AppRunDedicatedPanel.tsx の runPublishApp と同じ理由）。
import { refreshLbAddresses } from '../cloud/apprunDedicatedAppApply'
// O-1（2026-09-17）: ⑧「🔎 公開先と https を確かめる」。⑧の verify（DNS を向ける前に走る）には
// 足せないので、別の口にする（理由は cloud/dedicatedSiteCheck.ts 冒頭）。
import { checkDedicatedSite } from '../cloud/dedicatedSiteCheck'
import { prepareAppImage } from '../cloud/imagePublish'
import { loadCloudSpec, loadCloudState } from '../cloud/specStore'
import type { EnvSpec } from '../cloud/spec'
import { fetchDedicatedTelemetryStatus, enableDedicatedTelemetry } from '../cloud/monitoring'
import { withProjectLock, projectBusyMessage } from '../projectLock'
// 進捗の送り口は1つ（記録の更新と renderer への通知を兼ねる）。2026-09-29・projectOps.ts
import { progressReporter } from '../projectOps'
import { readApprunDedicatedFs, markPendingFs, clearPendingFs, writePublishRecordFs } from '../publishMetaFs'
import { readHasLetsEncryptEmail } from '../../shared/apprunDedicatedShapes'
import { deriveApplicationName } from '../../shared/apprunDedicatedApp'
// 2026-09-23: 専有型にも「保存場所の鍵」を渡す。発行・片づけの実体は共用型・HANAMII と同じ関数
// （公開先を引数に取る形になっている）。ここで新しく書かない（掟10「一元定義」）。
// 上の import 行は tests/apprunDedicatedIpcWiring.test.ts が文字列で固定しているため、
// 環境変数の上限は別行で足す（refreshLbAddresses と同じ理由）。
import { MAX_ENV_COUNT } from '../../shared/apprunDedicatedApp'
import { issueStorageEnvFor, cleanUpOldKeysFor, revokeIssuedKey, type StorageEnvResult } from '../cloud/storageForTarget'
// 2026-09-24（Ryosuke 決定「①は案2・一貫性が重要」）: ⑥の破棄で保存場所も片づける。
// 手順と守りは共用型とまったく同じ1つ（cloud/storageTeardown.ts）を通る。ここでは新しい判断を書かない。
// 記録の書き戻しは publishMetaFs の既存関数（上の import 行はテストが文字列で固定しているため別行で足す）。
import { storagePlacementsOf, teardownStorageForProject, forgetDeletedBuckets } from '../cloud/storageForTarget'
import { writeApprunDedicatedRecordFs } from '../publishMetaFs'
// 2026-09-29: ⑥の後始末（公開記録を消す）を main へ移した（窓を閉じても最後まで済ませるため）。上の import 行は
// tests/apprunDedicatedIpcWiring.test.ts が文字列で固定しているため、別行で足す。
import { forgetPublishTargetFs } from '../publishMetaFs'
// 2026-09-23 検分: 片づけの門（応答を確かめられたか）・件数の事前確認・途中で止まったときの後始末。
// **どれも新しい判定を書かず、既にある純関数を使う**（掟10「一元定義」）。
import { dedicatedVerifySettled } from '../../shared/publishVerify'
import { consentedBuckets, STORAGE_ENV } from '../../shared/objectStorage'
import { stageLeftNoVersion } from '../cloud/apprunDedicatedAppApply'
import type { CloudCredentials } from '../cloud/auth'
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

// 請求（コスト）参照はアカウント単位（どのゾーン経由でも可）。共用型 cloud:testConnection と同じゾーン。
const BILLING_ZONE = 'is1a'

/** renderer から渡された値が使える認証情報の形か（token/secretが非空の文字列か）。 */
function isCreds(v: unknown): v is CloudCredentials {
  const c = v as any
  return !!c && typeof c.token === 'string' && typeof c.secret === 'string' && !!c.token && !!c.secret
}

const NO_KEY: ApprunDedicatedResult = { ok: false, message: 'クラウドのAPIキーが未登録です' }

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

/**
 * ⑥「すべて削除する」の最後に、**保存場所も片づける**（2026-09-24 Ryosuke 決定「①は案2・
 * 一貫性が重要」＝共用型と同じにする）。
 *
 * ── なぜ⑥の最後なのか ────────────────────────────────────────────────
 * アプリ→LB→ASG→クラスタが消えてからにする。先に鍵とデータを消すと、**まだ動いている
 * アプリが 403 で落ちる**（2026-08-14 に共用型で実際に起きた形）。逆に、保存場所が
 * 片づかないことを理由に計算資源の削除を止めると、**月額の課金だけが残る**——だから
 * 計算資源を先に消し切り、保存場所はそのあとで片づける。
 *
 * ── ここに判断を書かないこと（掟10）──────────────────────────────────
 * 「一覧できなければ中止する」「バケットごと消してよいか（teardownPlanFor）」「鍵は
 * バケットのあと」は、すべて cloud/storageTeardown.ts の1つに集めてある。ここは
 * 「記録から鍵のIDを読んで渡し、結果を画面の言葉に直す」だけ。
 *
 * **📡 公開したもの一覧の『アプリだけ破棄』（teardownApp・appOnly）からは呼ばない。**
 * あちらはクラスタもデータもわざと残す操作で、利用者にもそう約束している。
 */
async function teardownProjectStorage(
  auth: CloudCredentials, projectDir: string, res: TeardownFlowResult, progress: (msg: string) => void,
): Promise<TeardownFlowResult> {
  // ここへ来た時点で計算資源は消し切れている（呼び出し側が res.ok のときだけ呼ぶ）。
  // 以降どう転んでも、**アプリは消えた**という事実は落とさない（検分の指摘4・9・13）。
  const done: TeardownFlowResult = { ...res, appDeleted: true }
  // ── env.json が壊れていても、計算資源の削除結果を例外で捨てない（検分の指摘12・14・15）───
  // storagePlacementsOf → readSpec は JSON.parse を素で呼ぶので、壊れた env.json では throw する。
  // IPC ハンドラにも withProjectLock にも catch が無いため、そのまま renderer まで飛び、画面は
  // 「⚠️ 削除できませんでした」＋空の executed に落とす——**全部消せているのに**。
  let placements: ReturnType<typeof storagePlacementsOf>
  try {
    placements = storagePlacementsOf(projectDir)
  } catch (e: any) {
    return {
      ...done, ok: false,
      message: `保存場所の設定を読めないため、保存場所は片づけていません: ${e?.message ?? String(e)}`,
    }
  }
  // 保存場所を使っていないプロジェクトでは、何も言わない・何も呼ばない。
  if (placements.length === 0) {
    // 前回の破棄でバケットが残っていた印が立っていれば、もう残っていないので下ろす。
    if (readApprunDedicatedFs(projectDir).storageLeftoverBucket) {
      writeApprunDedicatedRecordFs(projectDir, { storageLeftoverBucket: null })
    }
    return done
  }
  // 記録が無い（2026-09-23 より前に公開した）ときは null＝**鍵の無効化だけ飛ばして片づけは続ける**。
  const permissionId = readApprunDedicatedFs(projectDir).storagePermissionId ?? null
  progress('🗄️ 保存場所を片づけています…')
  let st: Awaited<ReturnType<typeof teardownStorageForProject>>
  try {
    // 鍵は記録の1件だけでなく、**この公開先の名前の鍵を全部**無効にする（検分の指摘6）。
    // ⑥の時点でこのプロジェクトの専有型は全部消えている＝現役の鍵は存在しないので、
    // storageKeys.ts の「現役が分からないときは消さない」規則とは矛盾しない。
    st = await teardownStorageForProject({ creds: auth, projectDir, permissionId, sweepKeysFor: 'apprun-dedicated' })
  } catch (e: any) {
    return { ...done, ok: false, message: `保存場所を片づけられませんでした: ${e?.message ?? String(e)}` }
  }
  if (st.reason === 'none') return done
  // バケットごとは消さなかった保存場所（残れば月額も続く）。executed の1行だけでは警告にならないので、事実として返す。
  const keptBuckets = st.done.filter(b => !b.deletedBucket).map(b => b.bucket)
  const kept: Pick<TeardownFlowResult, 'keptBucketName' | 'keptBucketNames'> =
    keptBuckets.length > 0 ? { keptBucketName: keptBuckets[0], keptBucketNames: keptBuckets } : {}
  const executed = [
    ...res.executed,
    ...st.done.map(b => `保存場所『${b.bucket}』を片づけました — ${b.note}`),
    ...st.warnings.map(w => `⚠️ ${w}`),
  ]
  // **バケットごと消したものは、env.json の記録からも外す**（検分の指摘3・8）。
  // 残すと画面は「用意済み」のまま、次の⑧公開が**消えたバケット宛ての鍵**を渡して成功扱いになる。
  const deletedBuckets = st.done.filter(b => b.deletedBucket).map(b => b.bucket)
  if (deletedBuckets.length > 0 && !forgetDeletedBuckets(projectDir, deletedBuckets)) {
    // 外せなかったら**黙らない**。記録が残ったままだと、画面は保存場所を「用意済み」として
    // 出し続け、次の⑧公開が消えたバケット宛ての鍵を渡して「成功」してしまう。
    executed.push('⚠️ 保存場所の記録（公開の設定）は残しています。次に公開する前に、③「保存場所を用意する」からやり直してください')
  }
  if (!st.ok) {
    // 計算資源は消えている（＝そのぶんの課金は止まった）が、保存場所は残った。**黙らない。**
    // ① 残っているバケット名を一覧に出す（指摘5） ② 記録に印を残して⑥を押し直せるようにする（指摘1）。
    writeApprunDedicatedRecordFs(projectDir, { storageLeftoverBucket: st.remainingBucket })
    return {
      ...done, ok: false, executed, ...kept,
      message: st.message,
      remaining: { ...res.remaining, storageBucket: st.remainingBucket },
    }
  }
  // 鍵を無効にできたときだけ、記録から外す。消せていないのに記録を消すと、
  // **どこにも辿れない鍵**が保存場所へ届き続ける。
  writeApprunDedicatedRecordFs(projectDir, {
    ...(permissionId && st.warnings.length === 0 ? { storagePermissionId: null } : {}),
    storageLeftoverBucket: null,
  })
  return { ...done, executed, ...kept }
}

/** renderer から渡された値が createClusterFlow に渡せる形か（最低限の型チェック）。 */
function isClusterSpec(v: unknown): v is ApprunDedicatedClusterSpec {
  const s = v as any
  return !!s && typeof s.name === 'string' && Array.isArray(s.ports) && typeof s.servicePrincipalID === 'string'
    && typeof s.zone === 'string' && typeof s.workerServiceClassPath === 'string' && typeof s.lbServiceClassPath === 'string'
    && typeof s.minNodes === 'number' && typeof s.maxNodes === 'number'
}

/**
 * ⑧「アプリを公開する」の入力（画面の入力欄そのまま・D-4）。preload が type import する。
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
 * `opts.confirmed === true` のときだけ true（2026-09-10 レビューの修理・A・掟10の3点セット）。
 * renderer から渡された値の形は信用しない（不正な形なら false＝未確認扱いの安全側）。
 */
function isConfirmed(opts: unknown): boolean {
  return !!opts && typeof opts === 'object' && (opts as any).confirmed === true
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
  // W-38（2026-09-27 決定・案2）: 専有型はすでに⑧でアプリを公開でき、公開にはレジストリの
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

  // GET /zone（さくらのクラウド API v1.1 設備関連API・roadmap #28）。⑤のゾーン選択式化に使う。
  // GETのみ・src/main/cloud/zones.ts に一元化（ここではキー確認と委譲だけ）。
  ipcMain.handle('apprunDedicated:zones', async (_, auth: unknown) => {
    if (!isCreds(auth)) return NO_KEY
    return getZones(auth)
  })

  // 段階②「作る」: クラスタ→ASG→LB の順で作り、各段の成功直後に .sakuraide.json へ記録する。
  // 同意（consentedAt）が記録に無ければ createClusterFlow 自身が API を一度も呼ばずに中止する。
  // opts.confirmed（第4引数）は今回の確認ダイアログを通ったかの印（2026-09-10 レビューの修理・A）。
  ipcMain.handle('apprunDedicated:create', async (_, projectDir: unknown, auth: unknown, spec: unknown, opts: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, stage: 'consent', message: 'プロジェクトフォルダが不正です' }
    if (!isCreds(auth)) return { ok: false, stage: 'consent', message: 'クラウドのAPIキーが未登録です' }
    if (!isClusterSpec(spec)) return { ok: false, stage: 'consent', message: '入力が不正です' }
    // 作成は数個のAPIを順に呼ぶだけで待ちが無い（createClusterFlow は進捗を出さない）ので、
    // 記録には「いま作っています」の1文だけを置く。閉じて開き直した画面が結果を読めるのが目的。
    const progress = progressReporter(projectDir)
    // H-1: 同じプロジェクトで作成・削除・公開を同時に走らせない（src/main/projectLock.ts）。
    const r = await withProjectLock(projectDir, '作成', () => {
      progress('🏗 クラスタ・オートスケーリンググループ・ロードバランサを作っています…')
      return createClusterFlow(auth, projectDir, spec, { confirmed: isConfirmed(opts) })
    }, { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:create', secrets: [auth.token, auth.secret] })
    return r.busy ? { ok: false, stage: 'consent', message: projectBusyMessage(r.running) } : r.value
  })

  // 段階④「破棄」: 記録にある ID だけを LB→ASG→クラスタ の順で削除する。
  // opts.confirmed（第3引数）は今回の確認ダイアログを通ったかの印（2026-09-10 レビューの修理・A）。
  // #39: 各段は一覧から消えるまで待つため、進捗を 'apprunDedicated:teardown-progress' で
  // 逐次通知する（cloud:apply-progress と同じ形。event.sender.send）。
  ipcMain.handle('apprunDedicated:teardown', async (event, projectDir: unknown, auth: unknown, opts: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, executed: [], message: 'プロジェクトフォルダが不正です', remaining: {} }
    if (!isCreds(auth)) return { ok: false, executed: [], message: 'クラウドのAPIキーが未登録です', remaining: {} }
    // 送り口は projectOps.ts の1つ（progressReporter）: 処理の記録も更新するので、⑥のダイアログを
    // 閉じて開き直した画面も、いまの進み具合（約9分かかる削除の待ち）を続きから読める（2026-09-29）。
    const progress = progressReporter(projectDir, msg => event.sender.send('apprunDedicated:teardown-progress', msg))
    // H-1: 公開と同時に走らせない（記録が交錯して、消せない資源が残る）。
    // 保存場所の片づけも**同じ鍵の中**で行う（外へ出すと、片づけ中に公開が始まって
    // 「いま渡したばかりの鍵」を消しうる）。
    const r = await withProjectLock(projectDir, '削除', async () => {
      // 公開記録（📡 一覧が読む publish.targets）を片づけるかの材料は、**破棄の前に**読む
      // （アプリを消すと記録の applicationID も外れるため、あとからは「公開していたか」が分からない）。
      const hadApplicationID = !!readApprunDedicatedFs(projectDir).applicationID
      const res = await teardownFlow(auth, projectDir, { confirmed: isConfirmed(opts), progress })
      // 途中で止まったなら保存場所には触らない（アプリがまだ動いている可能性がある）。
      const done = res.ok ? await teardownProjectStorage(auth, projectDir, res, progress) : res
      // 2026-09-29: 公開記録の片づけは**ここ（main）で済ませる**。以前は画面（doTeardown）だけが行っており、
      // ⑥のダイアログを閉じても破棄は最後まで進むのに、この後始末だけが走らず、存在しないアプリが
      // 📡 公開したもの一覧に出続けた（URL は 404）。画面の後始末は残す（同じ記録を二度消しても害は無い）。
      // 規則は画面の shouldClearPublishRecord と同じ（shouldForgetPublishRecord。真理値表テストで一致を固定）。
      if (shouldForgetPublishRecord({ hadApplicationID, result: done })) {
        try { forgetPublishTargetFs(projectDir, 'sakura-apprun-dedicated') } catch { /* 後始末の失敗で破棄の結果を変えない */ }
      }
      return done
    }, { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', secrets: [auth.token, auth.secret] })
    return r.busy ? { ok: false, executed: [], message: projectBusyMessage(r.running), remaining: {} } : r.value
  })

  // 現在の記録（何が作られているか）を返す。API を呼ばない、ただのファイル読み取り。
  ipcMain.handle('apprunDedicated:state', async (_, projectDir: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return {}
    return readApprunDedicatedFs(projectDir)
  })

  // ── ⑧「アプリを公開する」（D-4）──────────────────────────────────────────
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

  // ⑧「🔄 IP を取り直す」（D-5・2026-09-16）: 記録の clusterID/asgID/loadBalancerID で LB ノードの一覧を
  // 1 回引き、素の IP（bareIp・`IP/24` の `/` より前）を記録（lbAddresses）して返す。GET と記録の書き込みだけ・
  // 何も作らない・待たない（待つのは publishAppFlow の lb-address 段）。判断は cloud/apprunDedicatedAppApply.ts の
  // refreshLbAddresses に一元化してあり、ここは「形の検査と委譲」だけ（掟10）。
  ipcMain.handle('apprunDedicated:lbAddresses', async (_, projectDir: unknown, auth: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, message: 'プロジェクトフォルダが不正です' }
    if (!isCreds(auth)) return { ok: false, message: 'クラウドのAPIキーが未登録です' }
    return refreshLbAddresses(auth, projectDir)
  })

  // ⑧「🔎 公開先と https を確かめる」（O-1・2026-09-17）: 記録のホスト名とロードバランサの IP で、
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
    // 送り口は projectOps.ts の1つ（progressReporter）: 処理の記録も更新するので、⑧のダイアログを
    // 閉じて開き直した画面も、いまの進み具合を続きから読める（2026-09-29）。
    const progress = progressReporter(projectDir, msg => event.sender.send('apprunDedicated:publish-progress', msg))
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
      const spec = loadCloudSpec(projectDir)
      // W-36（2026-09-27 決定・案1）: 利用者はファイルを意識していない。「env.json を確認」と
      // 言われても、どこで何を見ればよいか分からない。画面では「公開の設定」とだけ言う。
      if (!spec) return { ok: false, stage: 'invalid', message: '公開の設定がありません。⑧の「公開の設定を作る」を押してから、もう一度お試しください' }
      const state = loadCloudState(projectDir, spec)

      // prepareAppImage は「Koto が組み立てる」（source.type !== 'image'）のときだけ呼べる（imagePublish.ts の前提）。
      // image 型（手で env.json を書いた場合だけ起きる。scaffoldEnv は常に dockerfile 型を書く）は、
      // レジストリ資格情報の出所が決まっていないので、ここで断る（推測で別のレジストリの資格情報を送らない）。
      if (spec.service.source.type === 'image') {
        return {
          ok: false, stage: 'image',
          message: '公開の設定の service.source が image 型です。専有型への公開は、Koto が組み立てるイメージ（source.type が dockerfile）にだけ対応しています。公開の設定の service.source を dockerfile 型にしてから、もう一度お試しください',
        }
      }
      // ── データの保存を持っていく（2026-09-23 検分で発覚）──────────────────
      // ③公開は「保存場所を用意すると、データが残るようになります」と約束している。
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
      if (willIssueStorageKey) progress('🔑 保存場所の鍵を用意しています…')
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
      // AI への説明文（aiContext.ts の DATA_RULE）は「『② 試す』『③ 公開』を押した直前に
      // Koto が置きます」と言い切っており、共用型（cloud.ts）・HANAMII・Vercel・レンタルサーバは
      // 全部そうしている。**専有型の⑧だけが通っていなかった**ので、AI が約束どおり書いた
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
      }, { confirmed: isConfirmed(opts), progress })
      // 公開記録を main 側で残す（renderer が閉じても失われない・roadmap #20。他の公開先と同じ publish.targets）。
      if (result.ok) {
        writePublishRecordFs(projectDir, 'sakura-apprun-dedicated', { publishedAt: new Date().toISOString(), url: result.url ?? null })
        // 2026-09-24: ⑥の破棄で鍵を無効にできるよう、**いま渡した鍵のIDだけ**を記録する
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
          progress('🧹 保存場所の古い鍵を片づけています…')
          try {
            await cleanUpOldKeysFor({ projectName: storage.projectName, target: 'apprun-dedicated', keepId: storage.permissionId })
          } catch { /* 片づけに失敗しても公開は成立している（共用型・HANAMII と同じ） */ }
        }
      } else if (stageLeftNoVersion(result.stage)) {
        // 版が1つも作られていないと言い切れるときだけ、いま発行した鍵を取り消す（検分の指摘5・10）。
        // version-create 以降は**後から有効になりうる**ので触らない（消すと 403 になる）。
        await revokeJustIssuedKey(storage)
      }
      return withDataLayerNote(result)
    } catch (e: any) {
      progress('⚠️ 失敗しました')
      return withDataLayerNote({ ok: false, stage: 'invalid', message: e?.message ?? String(e) })
    } finally {
      clearPendingFs(projectDir)
    }
    }, { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:publishApp', secrets: [auth.token, auth.secret] })
    return locked.busy
      ? { ok: false, stage: 'consent', message: projectBusyMessage(locked.running) }
      : locked.value
  })

  // 📡 一覧の「破棄」: 専有型の**アプリ（全バージョン）だけ**を消す（LB/ASG/クラスタには触らない＝
  // teardownFlow の appOnly。⑥の全部破棄は上の apprunDedicated:teardown）。
  // opts.confirmed（第3引数）は今回の確認ダイアログを通ったかの印。進捗は teardown と同じチャンネルに流す
  // （「〜の削除を待っています」の意味が同じ。専有型パネルは tearingDown 中しか表示しないので混線しない）。
  // 公開記録（publish.targets['sakura-apprun-dedicated']）は main では消さない——共用型と同じ手
  // （cloud:teardown も記録を消さず、📡 一覧が r.ok のあとに clearPublishRecord(e.dir, e.target) で消す）。
  ipcMain.handle('apprunDedicated:teardownApp', async (event, projectDir: unknown, auth: unknown, opts: unknown) => {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, executed: [], message: 'プロジェクトフォルダが不正です', remaining: {} }
    if (!isCreds(auth)) return { ok: false, executed: [], message: 'クラウドのAPIキーが未登録です', remaining: {} }
    const progress = progressReporter(projectDir, msg => event.sender.send('apprunDedicated:teardown-progress', msg))
    // H-1: 公開と同時に走らせない（同上）。
    const r = await withProjectLock(projectDir, '削除', () =>
      teardownFlow(auth, projectDir, { confirmed: isConfirmed(opts), progress, appOnly: true }),
    { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardownApp', secrets: [auth.token, auth.secret] })
    return r.busy ? { ok: false, executed: [], message: projectBusyMessage(r.running), remaining: {} } : r.value
  })

  // #38「⑦ ログ・メトリクス」: 専有型はクラスタ単位ではなくプロジェクト単位（resource_id
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
