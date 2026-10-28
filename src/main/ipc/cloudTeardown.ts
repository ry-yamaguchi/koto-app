// cloudTeardown.ts — 共用型 AppRun の破棄（cloud:teardown）と、確認の材料の口（cloud:teardownRecord）、複製の有無を読む口（cloud:recordTwins）。
// cloud.ts から切り出した（設計書 docs/teardown-unify-plan.md 10.7.4）。
//
// ── 呼び形 ───────────────────────────────────────────────────────────────────
//   cloud:teardown       (projectDir, { heldByMain: true }, { confirmed, deleteRegistry, registryName, shownPlacements })
//   cloud:teardownRecord (projectDir)   … 読むだけ。外部へ要求を出さない。同じフォルダの兄弟プロジェクトの記録も読む（同じレジストリを使うプロジェクトを数える。cloud/registryUsers.ts）
//   cloud:recordTwins   (projectDir)   … 読むだけ。外部へ要求を出さない。自分の公開の記録（破棄で消すものの事実）をすべて持つ、同じ親フォルダの別のフォルダ（覆う複製）を、3つの公開先ごとに返す（cloud/recordTwins.ts の recordCoverFs。0.6.24 I-3・R2-d）
// 順序は共通の骨（cloud/teardownShell.ts）が持つ: projectDir → 確認の印 → 認証の形 → 鍵（同時に1つだけ）→ run → 公開の記録の削除。
// 断った回（確認の印が無い・認証の形が違う・別の操作が走っている）は、さくらのクラウドへも保存場所へも1本も要求を出さず、処理の記録も作らない。
//
// ── run の順序（アプリ → コンテナレジストリ → 保存場所）────────────────────────────
// 専有型・HANAMII と同じく保存場所は最後。まだ動いているアプリの足元のデータと鍵を先に消すと、アプリが 403 で落ちる（2026-08-14）。
// アプリを消せなかった回は、レジストリにも保存場所にも触れない。
// 消す保存場所の候補は `sharedTeardownRecordOf` が決める（env.json の同意済み全件 + state にだけある保存場所）。確認の材料（cloud:teardownRecord）と
// run は同じこの関数を通る（P5）。run が実際に消すのは、そのうち確認で見せた保存場所（名前と prefix の組）だけ。見せていないものは消さず、残して ok:false（0.6.24 F）。
//
// ── 掟 ───────────────────────────────────────────────────────────────────────
// ・保存した記録（state.json）は、失敗した回も `stateToSave` を通して残す（2026-08-14: 消えたアプリが記録に残り、次の公開が 404 になった）
// ・レジストリを消すのは `deleteRegistry === true` で、確認のときの名前が記録と一致するときだけ（P7・掟11）
// ・保存場所の判断は cloud/storageTeardown.ts → shared/objectStorage.ts の1つ。ここに条件を書かない（掟10）
import * as fs from 'fs'
import { ipcMain } from 'electron'
import { applyPlan } from '../cloud/apply'
import { loadCredentials } from '../cloud/auth'
import { SakuraCloudClient, pickContainerRegistries } from '../cloud/client'
import { loadRegistryCredentials, clearRegistryCredentials } from '../cloud/registry-auth'
import { CLOUD_STATE_FILE, cloudFilePath, loadCloudSpec, loadCloudState, saveCloudState } from '../cloud/specStore'
import { registryDeletionTarget, stateToSave, type EnvState } from '../cloud/state'
import type { EnvSpec } from '../cloud/spec'
import { deleteDescription, type Plan } from '../cloud/planner'
import { recordTwinsFs, readRecordTwins } from '../cloud/recordTwins'
import { runTeardownShell, BAD_PROJECT_DIR_MESSAGE, type TeardownShellCtx, type TeardownShellSpec } from '../cloud/teardownShell'
import { forgetPublishTargetFs } from '../publishMetaFs'
import { consentedPlacementsOf, type StoragePlacement } from '../../shared/objectStorage'
import { keyRevokeGuide } from '../../shared/storageKeys'
import { registryOriginOf, type RegistryOrigin } from '../../shared/cloudCost'
import { otherProjectsUsingRegistry, keptRegistryFacts } from '../cloud/registryUsers'
import { runStorageStage, storageFailureFields, SAVE_FAILED_NOTE } from './cloudTeardownStorage'

/** 記録（env.json・state.json）だけから決まる、このプロジェクトの破棄の材料。run も同じものを使う。 */
export type SharedTeardownBase = {
  /** state の apprun-app の名前。 */
  appNames: string[]
  registryName: string | null
  /** そのレジストリを、このプロジェクトのために Koto が作ったか（owned）・借りたか（adopted）・分からないか（unknown）。既定の選びがこれで決まる。 */
  registryOrigin: RegistryOrigin
  /** 消す保存場所の候補の全件 = env.json の同意済み + state にだけある保存場所（後ろ）。run が消すのは、確認で見せたものだけ（0.6.24 F）。 */
  placements: StoragePlacement[]
  /** placements のうち、env.json に無く state にだけあるもの（確認が「設定から外した保存場所」と言い分ける）。 */
  stateOnlyBuckets: string[]
}

/**
 * 画面（確認）が見る、このプロジェクトの破棄の材料 = 記録から決まるもの + 同じコンテナレジストリを使うほかのプロジェクト。
 * 後者は同じフォルダの兄弟プロジェクトの記録を**読んで**決める（読むだけ・外へ要求しない）ので、確認の材料を作る口（readSharedTeardownRecord）でだけ足す。
 * run（消す側）は記録から決まる部分しか使わない。
 */
export type SharedTeardownRecord = SharedTeardownBase & {
  /** このレジストリを使っている、ほかのプロジェクトの名前（フォルダ名・名前順）。1件でもあれば、作った側でも既定でレジストリを消さない。 */
  registryUsers: string[]
}

export type SharedTeardownResult = {
  ok: boolean
  appDeleted?: boolean
  executed?: string[]
  skipped?: string[]
  remainingBucket?: string
  remainingBuckets?: string[]
  /** 確認で見せていないため消さなかった保存場所（0.6.24 F。`remainingBuckets` にも入る）。 */
  skippedBuckets?: string[]
  keptBucketName?: string | null
  keptBucketNames?: string[]
  /** 残した保存場所の理由（ほかのプロジェクトも使っている／Koto が作ったのではないファイルがある。`teardownPlanFor` の `keptReasons`）。結果の警告が「後で消す場合は削除して」と言ってよいかを決める。 */
  keptBucketsUsedByOthers?: string[]; keptBucketsWithOwnFiles?: string[]
  keptRegistryName?: string
  /** 残したレジストリの由来と、使っているほかのプロジェクト（調べられなかった回は後者が無い＝「分からない」）。`cloud/registryUsers.ts` の `keptRegistryFacts`。 */
  keptRegistryOrigin?: RegistryOrigin; keptRegistryUsers?: string[]
  keptRegistryUnnamed?: boolean
  message?: string
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const nameFromRef = (r: EnvState['resources'][number]): string => (r.key.startsWith(`${r.kind}:`) ? r.key.slice(r.kind.length + 1) : r.id)

/**
 * 確認の材料と run が同じに読む、このプロジェクトの破棄の材料（純関数）。
 * 保存場所は `consentedPlacementsOf`（env.json の同意済み全件）に、state にだけある保存場所を足す。
 * 後者は利用者が設定から外した保存場所で、Koto が作ったもの。残すと月額が黙って続くので、確認で言って消す。
 */
export function sharedTeardownRecordOf(spec: EnvSpec, state: EnvState): SharedTeardownBase {
  const fromEnv: StoragePlacement[] = consentedPlacementsOf(spec.persistence?.objectStorage).map(({ bucket, prefix, shared }) => ({ bucket, prefix, shared }))
  const known = new Set(fromEnv.map(p => p.bucket))
  const stateOnly: StoragePlacement[] = []
  for (const r of state.resources) {
    if (r.kind !== 'bucket' || typeof r.id !== 'string' || !r.id || known.has(r.id)) continue
    known.add(r.id)
    stateOnly.push({ bucket: r.id, prefix: r.prefix ?? '', shared: true }) // 共有に倒す: ほかが使っていればバケットは残る
  }
  const name = state.meta?.registryName
  return {
    appNames: state.resources.filter(r => r.kind === 'apprun-app').map(nameFromRef),
    registryName: typeof name === 'string' && name ? name : null,
    registryOrigin: registryOriginOf(state.meta?.registryAdopted),
    placements: [...fromEnv, ...stateOnly],
    stateOnlyBuckets: stateOnly.map(p => p.bucket),
  }
}

/**
 * env.json が無いとき、破棄するものが本当に記録に無いか（state.json も無い・何も記録していない）。
 * state.json に何かあれば false（run は env.json が無いと進めない。確認を出さず、読めなかったと言って止める）。読めない記録も false。
 */
function nothingRecordedWithoutSpec(projectDir: string): boolean {
  const file = cloudFilePath(projectDir, CLOUD_STATE_FILE)
  if (!fs.existsSync(file)) return true
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const meta = parsed?.meta && typeof parsed.meta === 'object' ? parsed.meta : {}
    return !(Array.isArray(parsed?.resources) && parsed.resources.length > 0) && !meta.registryName && !meta.storagePermissionId
  } catch {
    return false
  }
}

/**
 * `cloud:teardownRecord` の本体。読めなければ投げずに `ok:false`（画面は確認を出さない）。
 * 公開の設定（env.json）がまだ無いプロジェクトで、記録も何も無いときは、読めないのではなく「破棄するものが無い」。空の記録を返す
 * （画面は失敗の枠でなく「破棄するものはありません」と中立に知らせる。親の判断 2026-10-10 の 4）。
 */
export function readSharedTeardownRecord(projectDir: unknown): { ok: true; record: SharedTeardownRecord } | { ok: false; message: string } {
  if (typeof projectDir !== 'string' || !projectDir) return { ok: false, message: BAD_PROJECT_DIR_MESSAGE }
  try {
    const spec = loadCloudSpec(projectDir)
    if (!spec) {
      return nothingRecordedWithoutSpec(projectDir)
        ? { ok: true, record: { appNames: [], registryName: null, registryOrigin: 'unknown', placements: [], stateOnlyBuckets: [], registryUsers: [] } }
        : { ok: false, message: 'env.json がありません' }
    }
    const base = sharedTeardownRecordOf(spec, loadCloudState(projectDir, spec))
    // ほかのプロジェクトが同じレジストリを使っているか。親フォルダの一覧を読めなければ投げる（空に倒すと「使い手なし」と読んで既定オンになる）
    const registryUsers = base.registryName ? otherProjectsUsingRegistry(projectDir, base.registryName) : []
    return { ok: true, record: { ...base, registryUsers } }
  } catch (e) {
    return { ok: false, message: msgOf(e) }
  }
}

/**
 * コンテナレジストリの一覧を読む（読めなかったときは `null`）。
 * `pickContainerRegistries` は形が読めない応答でも `[]` を返す＝「読めなかった」と「0件」を区別できない。
 * 破棄でこれを「一覧に無い＝削除済み」と読むと、読めていないのに記録から名前を落として二度と見つけられなくなる（2026-09-16 の検分 B-2）。
 */
export function readContainerRegistryList(data: unknown): Array<{ id: string; subdomainLabel: string }> | null {
  const items = (data as any)?.CommonServiceItems ?? (data as any)?.commonserviceitems
  if (!Array.isArray(items)) return null
  return pickContainerRegistries(data)
}

/**
 * 破棄でレジストリを削除する（2026-09-16 の検分 B）。一覧の取得が失敗しても・例外が起きても黙らず、必ず1行返す。
 * 破棄の成否（result.ok）は変えない: ここが失敗しても「アプリは削除済み」という判断は正しいが、黙ってよい理由にはならない。
 */
export async function teardownRegistry(
  client: Pick<SakuraCloudClient, 'listContainerRegistries' | 'deleteContainerRegistry'>,
  region: string,
  name: string,
): Promise<{ registryDeleted: boolean; note: string | null }> {
  const cannotConfirm = (reason: string): { registryDeleted: boolean; note: string | null } => ({
    registryDeleted: false,
    note: `※ レジストリ『${name}』を削除できたか確認できませんでした（${reason}）。`
      + 'さくらのクラウドのコントロールパネルで確認し、不要なら削除してください（月額220円がかかり続けます）。',
  })
  try {
    const listed = await client.listContainerRegistries(region)
    if (listed.dryRun !== false) return { registryDeleted: false, note: null } // dry-run は従来どおり何もしない
    if (!listed.ok) return cannotConfirm(`一覧の取得に失敗・HTTP ${listed.status}`)
    const rows = readContainerRegistryList(listed.data)
    if (rows === null) return cannotConfirm('一覧の応答を読み取れませんでした')
    const found = rows.find(r => r.subdomainLabel === name)
    if (!found) return { registryDeleted: true, note: null } // 一覧に無い＝既に削除済み（読めたうえでの判断）
    const del = await client.deleteContainerRegistry(region, found.id)
    if (del.dryRun === false && del.ok) return { registryDeleted: true, note: `コンテナレジストリ『${name}』を削除（ユーザー・イメージごと）` }
    if (del.dryRun === false) return { registryDeleted: false, note: `※ レジストリ『${name}』の削除に失敗（HTTP ${del.status}）。コンパネで削除してください` }
    return { registryDeleted: false, note: null }
  } catch (e: any) {
    return cannotConfirm(`一覧の取得または削除でエラーが発生・${e?.message ?? String(e)}`)
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

const NO_KEY_MESSAGE = 'APIキー未登録（先にアクセストークン/シークレットを登録してください）'
const REGISTRY_UNKNOWN_NOTE = '※ このプロジェクトがどのコンテナレジストリを使っていたかの記録がないため、レジストリは削除していません。'
  + 'さくらのクラウドのコントロールパネルで確認し、不要なら削除してください（月額220円がかかり続けます）。'
const REGISTRY_CHANGED_NOTE = '※ 確認のあとで、記録にあるコンテナレジストリが変わったため、レジストリは削除していません。もう一度破棄を押して確かめてください。'

/** state の apprun-app など、バケット以外を削除するプラン。保存場所は applyPlan に渡さず、あとで teardownStorageForProject が消す。実行内容の言い方は planner の deleteDescription（種類名を画面に出さない）。 */
function deletePlanWithoutBuckets(state: EnvState): Plan {
  const actions: Plan['actions'] = state.resources
    .filter(r => r.kind !== 'bucket')
    .map(r => ({ type: 'delete' as const, kind: r.kind, name: nameFromRef(r), stateful: r.stateful, destructive: true, description: deleteDescription(r.kind, nameFromRef(r), r.stateful) }))
  return { actions, hasDestructive: actions.length > 0, hasStatefulDelete: false }
}

/** 記録の保存。**必ず stateToSave を通す**。無効にできなかった鍵の ID は、成功の回に落ちる meta へ足し直す。 */
function persist(projectDir: string, cur: EnvState, o: { ok: boolean; registryDeleted: boolean; keyKept: string | null }): string | null {
  try {
    const saved = stateToSave({ ok: o.ok, state: cur, kind: 'teardown', registryDeleted: o.registryDeleted })
    saveCloudState(projectDir, o.ok && o.keyKept ? { ...saved, meta: { ...saved.meta, storagePermissionId: o.keyKept } } : saved)
    return null
  } catch (e) {
    return msgOf(e)
  }
}

function withoutRegistryMeta(state: EnvState): EnvState {
  const { registryName: _n, registryAdopted: _a, ...rest } = state.meta ?? {}
  const { meta: _m, ...base } = state
  return Object.keys(rest).length > 0 ? { ...base, meta: rest } : base
}

async function runSharedTeardown(ctx: TeardownShellCtx<{ heldByMain: true }>): Promise<SharedTeardownResult> {
  try {
    return await runStages(ctx)
  } catch (e) {
    return { ok: false, message: msgOf(e) } // 最後の防波堤。投げ直さない
  }
}

async function runStages(ctx: TeardownShellCtx<{ heldByMain: true }>): Promise<SharedTeardownResult> {
  const { projectDir, progress } = ctx
  const wantDelete = ctx.opts.deleteRegistry === true
  const askedName = typeof ctx.opts.registryName === 'string' && ctx.opts.registryName ? ctx.opts.registryName : null

  const creds = loadCredentials()
  if (!creds) return { ok: false, message: NO_KEY_MESSAGE }
  let spec: EnvSpec | null
  let state: EnvState
  try {
    spec = loadCloudSpec(projectDir)
    if (!spec) return { ok: false, message: 'env.json がありません' }
    state = loadCloudState(projectDir, spec)
  } catch (e) {
    return { ok: false, message: msgOf(e) }
  }
  const record = sharedTeardownRecordOf(spec, state)
  const hadApp = record.appNames.length > 0
  const recordedKey = state.meta?.storagePermissionId || null
  /** 鍵を無効にできなかった行に添える案内。名前は読んだ env.json の spec.name（保存場所を消す前に決まる）。 */
  const keyGuide = keyRevokeGuide(spec.name || null, 'apprun')
  let keepsRegistry = !wantDelete
  /** 残すレジストリの事実。警告は選択ではなくこの事実から作る（その場も開き直しも同じ）。名前に、由来と借り手を添える（結果の警告が「後で消す場合は」と言ってよいかの材料）。 */
  const keptRegistry = () => !keepsRegistry ? {}
    : record.registryName ? keptRegistryFacts(projectDir, record.registryName, record.registryOrigin)
    : hadApp ? { keptRegistryUnnamed: true } : {}

  // 1. アプリ。0件でも空のプランで applyPlan を呼ぶ。保存場所は渡さない（消すのは3で、env.json と state の和）
  progress('🗑 公開したものを破棄しています…')
  let result: Awaited<ReturnType<typeof applyPlan>>
  try {
    result = await applyPlan({ plan: deletePlanWithoutBuckets(state), spec, state, client: new SakuraCloudClient({ credentials: creds, dryRun: false }), confirmed: true, projectDir })
  } catch (e) {
    return { ok: false, message: `公開したものを削除できませんでした: ${msgOf(e)}` } // 記録は読んだまま。消せていれば押し直しの 404 を「無い」として進む
  }
  let cur = result.state
  if (!result.ok) {
    const failed = persist(projectDir, cur, { ok: false, registryDeleted: false, keyKept: null })
    return {
      ok: false, appDeleted: false, executed: result.executed, skipped: result.skipped, ...keptRegistry(),
      message: [result.message, failed && SAVE_FAILED_NOTE].filter(Boolean).join('\n') || undefined,
    }
  }
  const executed: string[] = [...result.executed]

  // 2. コンテナレジストリ。選んだときだけ。確認のときの名前が記録と食い違えば消さない
  let registryDeleted = false
  if (wantDelete) {
    try {
      const target = registryDeletionTarget(state, true)
      if ('skipped' in target) {
        executed.push(REGISTRY_UNKNOWN_NOTE)
      } else if (askedName !== target.name) {
        executed.push(REGISTRY_CHANGED_NOTE)
        keepsRegistry = true
      } else {
        progress('🗑 コンテナレジストリを削除しています…')
        const outcome = await teardownRegistry(new SakuraCloudClient({ credentials: creds, dryRun: false }), spec.region || 'is1a', target.name)
        registryDeleted = outcome.registryDeleted
        if (outcome.note) executed.push(outcome.note)
        // 共通の資格情報は、いま消した（＝既に無いと確かめた）レジストリを指しているときだけクリアする（別プロジェクトのものを消さない）
        if (registryDeleted && loadRegistryCredentials()?.name === target.name) clearRegistryCredentials()
        if (registryDeleted) cur = withoutRegistryMeta(cur) // このあと保存場所で止まっても、消えたレジストリを記録に残さない
      }
    } catch { /* レジストリの失敗は致命ではない（アプリは削除済み）。teardownRegistry は投げないので、ここは判定が壊れたときだけ */ }
  }

  // 3. 保存場所。候補は env.json の同意済み全件 + state にだけあるもの。消すのは確認で見せたものだけ。最後に消す（段の中身は ./cloudTeardownStorage.ts）
  const stage = await runStorageStage({
    creds, projectDir, placements: record.placements, stateOnlyBuckets: record.stateOnlyBuckets, hadApp, cur, recordedKey, keyGuide,
    shown: ctx.opts.shownPlacements, progress,
  })
  cur = stage.cur
  executed.push(...stage.lines)
  const { kept, keptWhy, dataDeleted, keyKept, failure } = stage

  // 4. 記録を保存して返す
  progress('📝 記録を更新しています…')
  const saveError = persist(projectDir, cur, { ok: failure === null, registryDeleted, keyKept })
  const base = {
    appDeleted: true, executed, skipped: result.skipped,
    keptBucketName: kept[0] ?? null, ...(kept.length > 0 ? { keptBucketNames: kept } : {}), ...keptWhy, ...keptRegistry(),
  }
  if (failure) {
    return { ok: false, ...base, ...storageFailureFields(failure, { registryRemains: !!cur.meta?.registryName, saveFailed: !!saveError }) }
  }
  if (saveError) return { ok: false, ...base, message: SAVE_FAILED_NOTE }
  return { ok: true, ...base, ...(dataDeleted ? { message: '保存場所にあった、このプロジェクトのデータを削除しました。' } : {}) }
}

/** 共用型の破棄を骨に載せる定義。公開の記録を消すのは、保存場所まで済んだ（ok）回だけ。 */
export const SHARED_TEARDOWN_SHELL: TeardownShellSpec<{ heldByMain: true }, SharedTeardownResult> = {
  target: 'sakura-apprun',
  handler: 'cloud:teardown',
  // ちょうど { heldByMain: true } だけを通す（heldByMain が true 以外・ほかのキーがある・配列・null は断る）。鍵は main が持つので秘密は渡らない
  parseAuth(auth) {
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null
    const keys = Object.keys(auth)
    return keys.length === 1 && keys[0] === 'heldByMain' && (auth as { heldByMain?: unknown }).heldByMain === true ? { heldByMain: true } : null
  },
  authMissingMessage: '破棄の呼び出しが正しくありません。',
  secretsOf: () => [],
  twinsOf: dir => recordTwinsFs(dir, 'sakura-apprun'), // 同じ apprun-app の id を持つ兄弟（重なる）があれば断る（0.6.24 I-2。断るのは何も消さない側なので、覆うより広い recordTwinsFs）
  run: runSharedTeardown,
  shouldForgetRecord: ({ result }) => result.ok === true,
  forgetRecord: ctx => forgetPublishTargetFs(ctx.projectDir, 'sakura-apprun'),
  refused: message => ({ ok: false, message }),
}

/** cloud:teardown・cloud:teardownRecord・cloud:recordTwins を登録する（registerCloudHandlers から呼ぶ）。 */
export function registerCloudTeardownHandlers(): void {
  ipcMain.handle('cloud:teardown', (_event, projectDir: unknown, auth: unknown, opts: unknown) =>
    runTeardownShell(SHARED_TEARDOWN_SHELL, { projectDir, auth, opts }))
  ipcMain.handle('cloud:teardownRecord', (_event, projectDir: unknown) => readSharedTeardownRecord(projectDir))
  // プロジェクトの削除の画面が、覆う複製のある公開先を破棄から外すために読む（読むだけ。「覆う」の判断は recordCoverFs。破棄の骨の twinsOf は、より広い「重なる」の recordTwinsFs。0.6.24 I-3・R2-d）
  ipcMain.handle('cloud:recordTwins', (_event, projectDir: unknown) => readRecordTwins(projectDir))
}
