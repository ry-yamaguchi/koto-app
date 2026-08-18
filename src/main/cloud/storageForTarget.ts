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
import { loadCredentials } from './auth'
import { createStorageAdapter } from './storageAdapter'
import { validateSpec } from './spec'
import { consentedBuckets, storageEnvVars, containsSecretEnv, STORAGE_ENV } from '../../shared/objectStorage'
import { permissionNameFor, permissionsToCleanUp, type StorageTarget } from '../../shared/storageKeys'

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
