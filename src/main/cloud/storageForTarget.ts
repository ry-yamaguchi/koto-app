// storageForTarget.ts — 「保存場所の設定」を、AppRun 以外の公開先にも渡す（main の IO）。
//
// ── なぜ要るか（2026-08-15）──────────────────────────────────────────
// データはオブジェクトストレージにあり、**計算（AppRun / HANAMII）とは別の場所**に
// 置かれている。にもかかわらず、鍵を発行して環境変数で渡す処理は
// `cloud/apply.ts`（AppRun の公開）の中にしか無かった。
// そのため「同じアプリを HANAMII へ公開する」と、**データだけが付いてこない**。
//
// ここは鍵の発行と受け渡しだけを担う。判断（名前・片づける対象）は
// shared/storageKeys.ts、環境変数の組み立ては shared/objectStorage.ts に集約する。
//
// ── 秘密の扱い（掟4）────────────────────────────────────────────────
// シークレットは**発行の応答でしか読めない**。ここで受け取り、呼び出し元が
// そのまま公開先へ渡し切る。**ディスクにも env.json にも書かない。**
// renderer には渡さない（main の中で完結させる）。

import fs from 'fs'
import path from 'path'
import type { CloudCredentials } from './auth'
import { loadCredentials } from './auth'
import { createStorageAdapter } from './storageAdapter'
import { teardownStorage } from './storageTeardown'
import { validateSpec } from './spec'
import { consentedBuckets, storageEnvVars, containsSecretEnv, STORAGE_ENV, type StoragePlacement } from '../../shared/objectStorage'
import { permissionNameFor, permissionsToCleanUp, permissionsForTarget, type StorageTarget } from '../../shared/storageKeys'

const CLOUD_DIR = '.sakura-cloud'
const CLOUD_ENV_FILE = 'env.json'

/** 公開先へ渡す環境変数（`secret` は「秘密として扱うべきか」）。 */
export type TargetEnv = { key: string; value: string; secret: boolean }

export type StorageEnvResult =
  | { ok: true; envs: TargetEnv[]; permissionId: string; bucket: string; prefix: string; projectName: string }
  /** `reason: 'none'` は「保存場所を使っていない」＝**失敗ではない**。 */
  | { ok: false; reason: 'none' | 'error'; message: string }

function readSpec(projectDir: string) {
  const envFile = path.join(projectDir, CLOUD_DIR, CLOUD_ENV_FILE)
  if (!fs.existsSync(envFile)) return null
  const result = validateSpec(JSON.parse(fs.readFileSync(envFile, 'utf-8')))
  return result.ok ? result.spec : null
}

/**
 * この公開先で使う保存場所の鍵を発行し、渡す環境変数を作る。
 *
 * **同意済みの保存場所が無ければ何もしない**（勝手にバケットを作らない＝勝手に課金しない）。
 */
export async function issueStorageEnvFor(opts: {
  projectDir: string
  target: StorageTarget
}): Promise<StorageEnvResult> {
  try {
    const spec = readSpec(opts.projectDir)
    const bucket = spec ? consentedBuckets(spec.persistence?.objectStorage)[0] : undefined
    if (!spec || !bucket) {
      return { ok: false, reason: 'none', message: 'このプロジェクトには保存場所が用意されていません。' }
    }
    const creds = loadCredentials()
    if (!creds) {
      return {
        ok: false, reason: 'error',
        message: 'このアプリはデータの保存を使いますが、さくらのクラウドのAPIキーが未登録のため'
          + '保存場所の設定を渡せません。「認証情報」でAPIキーを登録してください。',
      }
    }
    const storage = await createStorageAdapter(creds)
    try {
      const site = storage.siteInfo()
      const issued = await storage.issueKey(bucket.bucket, permissionNameFor(spec.name, opts.target))
      const publicVars = storageEnvVars({
        bucket: bucket.bucket,
        prefix: bucket.prefix ?? '',
        s3Endpoint: site.s3Endpoint,
        region: site.region,
        accessKey: issued.accessKey,
      })
      // **最後の砦**（apply.ts と同じ）。秘密でない側に秘密が紛れていないか
      if (containsSecretEnv(publicVars)) {
        return { ok: false, reason: 'error', message: '内部エラー: 秘密でない設定に秘密が混ざっています。公開を中止しました。' }
      }
      return {
        ok: true,
        envs: [
          ...publicVars.map(v => ({ key: v.name, value: v.value, secret: false })),
          { key: STORAGE_ENV.secretKey, value: issued.secretKey, secret: true },
        ],
        permissionId: issued.permissionId,
        bucket: bucket.bucket,
        prefix: bucket.prefix ?? '',
        projectName: spec.name,
      }
    } finally {
      // アダプタが自分用に発行した一時キーだけを片づける（アプリへ渡した鍵は残る）
      await storage.dispose()
    }
  } catch (e: any) {
    return { ok: false, reason: 'error', message: `保存場所の鍵を用意できませんでした: ${e?.message ?? e}` }
  }
}

/**
 * **いま発行したばかりの鍵だけ**を取り消す（2026-09-23 検分の指摘5・10）。
 *
 * 公開が途中で止まると、直前に発行した「バケットへ読み書きできる本物の鍵」が残る。
 * 片づけ（`cleanUpOldKeysFor`）は**成功した公開のときにしか走らない**ので、
 * ビルドが直らない間に何度も押した分だけ溜まっていく（実機で5件・storageKeys.ts 冒頭）。
 *
 * **消すのは引数の1件だけ。古い鍵には触れない**ので、動いているアプリが 403 で落ちる危険は無い。
 * **まだ誰も使っていないと分かっているときだけ呼ぶこと**（版が作られたあとに呼ぶと、
 * その版が動き出した瞬間に 403 になる。判断は `stageLeftNoVersion`）。
 */
export async function revokeIssuedKey(opts: { permissionId: string }): Promise<{ revoked: boolean }> {
  const creds = loadCredentials()
  if (!creds || !opts.permissionId) return { revoked: false }
  const storage = await createStorageAdapter(creds)
  try {
    await storage.deletePermission(opts.permissionId)
    return { revoked: true }
  } finally {
    await storage.dispose()
  }
}

/**
 * この公開先の古い鍵を片づける。**新しい版が動いたと確かめてから呼ぶこと。**
 *
 * デプロイの応答が返っても、新しいコンテナはまだ立ち上がっていない。その間に
 * 古い鍵を消すと、**いま動いているアプリが 403 で落ちる**（2026-08-14 実機）。
 *
 * `keepId` が分からないときは**何も消さない**（storageKeys.ts の規則）。
 */
export async function cleanUpOldKeysFor(opts: {
  projectName: string
  target: StorageTarget
  keepId: string | null
}): Promise<{ deleted: number }> {
  const creds = loadCredentials()
  if (!creds || !opts.keepId) return { deleted: 0 }
  const storage = await createStorageAdapter(creds)
  try {
    const all = await storage.listPermissions()
    const ids = permissionsToCleanUp({ all, projectName: opts.projectName, keepId: opts.keepId, target: opts.target })
    let deleted = 0
    for (const id of ids) {
      try { await storage.deletePermission(id); deleted++ } catch { /* 片づけの失敗で公開を失敗にしない */ }
    }
    return { deleted }
  } finally {
    await storage.dispose()
  }
}

/**
 * このプロジェクトの保存場所を読み、**置き場所（placement）を組み立てる**。
 *
 * ★ ここを間違えると**ほかのプロジェクトのデータを消す**（掟11）。
 * 共用型（`ipc/cloud.ts` の `storage:placement`）とまったく同じ組み立て方にしてある——
 * `prefix` はこのプロジェクトのものだけ、`shared` は**明示的に false のときだけ専用**
 * （不明なら共有＝バケットを消さない安全側へ倒す）。
 *
 * 同意済みの保存場所が無ければ null（＝このプロジェクトは保存場所を使っていない）。
 */
export function storagePlacementOf(projectDir: string): StoragePlacement | null {
  return storagePlacementsOf(projectDir)[0] ?? null
}

/**
 * 同意済みの保存場所を**全件**返す（2026-09-24 検分の指摘10）。
 *
 * 画面（③「保存場所を用意する」）は常に1件しか書かないが、env.json は手で編集できる。
 * 先頭の1件だけを片づけると、**2つ目のバケットが残って月額の課金が続く**——しかも
 * 確認ダイアログにもその名前は出ないので、利用者は「全部消えた」と受け取る。
 * 破棄はこちら（全件）を使う。
 */
export function storagePlacementsOf(projectDir: string): StoragePlacement[] {
  const spec = readSpec(projectDir)
  if (!spec) return []
  return consentedBuckets(spec.persistence?.objectStorage)
    .map(b => ({ bucket: b.bucket, prefix: b.prefix ?? '', shared: b.shared !== false }))
}

/** 片づけ終わった保存場所1件分（画面の「消しました」の行に使う）。 */
export type TorndownBucket = { bucket: string; deletedBucket: boolean; note: string }

export type ProjectStorageTeardownResult =
  /** 保存場所を使っていない＝何もしない（**失敗ではない**）。 */
  | { ok: true; reason: 'none' }
  | { ok: true; reason: 'done'; done: TorndownBucket[]; warnings: string[] }
  /**
   * どこかで失敗した。**途中まで起きたことは捨てない**（掟10）——`done` は片づけ終わった分、
   * `remainingBucket` は**いま残っているバケット**（画面の「残っています＝課金が続きます」に出す）。
   */
  | { ok: false; reason: 'failed'; message: string; done: TorndownBucket[]; remainingBucket: string; warnings: string[] }

/**
 * env.json の `persistence.objectStorage` から、**消し終わったバケットの記録を外す**
 * （2026-09-24 検分の指摘3・8）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────
 * バケットを消しても記録が残ると、画面は保存場所を「用意済み」として出し続け、次の⑧公開は
 * **消えたバケット宛ての鍵と環境変数を渡したまま成功扱いになる**（専有型の公開経路には
 * バケットを作る段が1つも無い＝共用型のような自己修復が効かない）。アプリのデータ保存だけが
 * 黙って失敗し続ける、いちばん気づけない形になる。記録を外せば③「保存場所を用意する」から
 * やり直す形に戻る。
 *
 * **バケットを消していないときは呼ばないこと**（prefix だけ消してバケットが残る＝共有）。
 * 生の JSON を読んで該当の要素だけを外す（validateSpec を通して書き戻すと、知らないキーを
 * 落としうる）。書けなければ false（破棄そのものは成立しているので、呼び出し側は止めない）。
 */
export function forgetDeletedBuckets(projectDir: string, buckets: string[]): boolean {
  if (buckets.length === 0) return false
  const gone = new Set(buckets)
  const envFile = path.join(projectDir, CLOUD_DIR, CLOUD_ENV_FILE)
  try {
    if (!fs.existsSync(envFile)) return false
    const raw = JSON.parse(fs.readFileSync(envFile, 'utf-8')) as any
    const list = raw?.persistence?.objectStorage
    if (!Array.isArray(list)) return false
    const next = list.filter((b: any) => !(b && typeof b.bucket === 'string' && gone.has(b.bucket)))
    if (next.length === list.length) return false
    raw.persistence = { ...raw.persistence, objectStorage: next }
    fs.writeFileSync(envFile, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
    return true
  } catch {
    return false
  }
}

/**
 * このプロジェクトの保存場所を片づける（破棄の一部）。
 *
 * 手順と守り（一覧できなければ中止する／判断は `teardownPlanFor` に任せる／鍵はバケットの
 * あとで無効にする）は **共用型とまったく同じもの**＝`cloud/storageTeardown.ts` を通る。
 * ここがやるのは「置き場所を組み立てて、つなぐ」だけで、**新しい判断は書かない**（掟10）。
 *
 * `permissionId` が無いときは鍵の無効化だけ飛ばす（古いプロジェクトは記録していない）。
 */
export async function teardownStorageForProject(opts: {
  creds: CloudCredentials
  projectDir: string
  permissionId?: string | null
  /**
   * この公開先の鍵を**まとめて**無効にするための指定（2026-09-24 検分の指摘6）。
   * 渡すと、保存場所を片づけ終わったあとに `listPermissions()` を引き、表示名が
   * `permissionNameFor(projectName, target)` と完全一致する鍵を**全部**無効にする。
   * **その公開先の資源をすべて消し終えたあとにだけ渡すこと**（現役の鍵が残っていると 403 で落ちる）。
   */
  sweepKeysFor?: StorageTarget | null
}): Promise<ProjectStorageTeardownResult> {
  const projectName = readSpec(opts.projectDir)?.name ?? null
  const placements = storagePlacementsOf(opts.projectDir)
  if (placements.length === 0) return { ok: true, reason: 'none' }
  let storage: Awaited<ReturnType<typeof createStorageAdapter>>
  try {
    storage = await createStorageAdapter(opts.creds)
  } catch (e: any) {
    // **中身を確かめられないなら消さない**（共用型 `cloud:teardown` と同じ言い方）。
    return {
      ok: false, reason: 'failed', done: [], remainingBucket: placements[0].bucket, warnings: [],
      message: `保存場所『${placements[0].bucket}』に接続できないため、削除を中止しました: ${e?.message ?? e}`,
    }
  }
  try {
    const done: TorndownBucket[] = []
    const warnings: string[] = []
    // 記録の鍵は1本しか無いので、最初の1件でだけ渡す（2件目に渡すと「もう無い」で警告が二重に出る）。
    let permissionId = opts.permissionId ?? null
    for (const placement of placements) {
      const outcome = await teardownStorage({ storage, placement, permissionId })
      if (!outcome.ok) {
        // **途中で止まっても、片づいた分は捨てない**（掟10）。残っているバケット名も返す。
        return { ok: false, reason: 'failed', message: outcome.message, done, remainingBucket: placement.bucket, warnings }
      }
      permissionId = null
      done.push({ bucket: placement.bucket, deletedBucket: outcome.deletedBucket, note: outcome.note })
      warnings.push(...outcome.warnings)
    }
    if (opts.sweepKeysFor && projectName) {
      warnings.push(...await sweepKeys(storage, { projectName, target: opts.sweepKeysFor }))
    }
    return { ok: true, reason: 'done', done, warnings }
  } finally {
    // アダプタが自分用に発行した一時キーを必ず片づける（残すと鍵だけが生き続ける）。
    await storage.dispose()
  }
}

/**
 * その公開先の鍵を**名前の完全一致で全部**無効にする（指摘6）。消せなかった件数は警告で返す
 * （**黙らない**）。一覧そのものが引けなかったときも警告1行で返し、破棄は失敗にしない——
 * 保存場所（月額のかかるもの）は既に片づいており、ここで ok:false にすると
 * 「残っています＝課金が続きます」という嘘になる。
 */
async function sweepKeys(
  storage: { listPermissions(): Promise<readonly { id: string; displayName: string }[]>; deletePermission(id: string): Promise<void> },
  target: { projectName: string; target: StorageTarget },
): Promise<string[]> {
  let all: readonly { id: string; displayName: string }[]
  try {
    all = await storage.listPermissions()
  } catch (e: any) {
    return [`保存場所の鍵の一覧を取得できなかったため、古い鍵が残っているかもしれません: ${e?.message ?? e}`]
  }
  const ids = permissionsForTarget({ all, projectName: target.projectName, target: target.target })
  let failed = 0
  for (const id of ids) {
    try { await storage.deletePermission(id) } catch { failed++ }
  }
  return failed > 0 ? [`保存場所の鍵を${failed}件、無効にできませんでした`] : []
}
