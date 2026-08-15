// storageAdapter.ts — `ObjectStorageClient` を `applyPlan` が受け取れる形に包む。
//
// ── なぜこのファイルが要るのか（2026-08-14）────────────────────────────
// apply が求める `StorageClientLike` と、実クライアントの形は一致していない。
//   ・実クライアントは呼び出しごとに `siteId` を要る（apply は知らない）
//   ・中身の一覧・書き込み・削除は **S3互換API** なので、
//     さくらのクラウドAPIキーではなく**アクセスキーが要る**（発行しないと触れない）
// その差を埋めるのがここ。**判断は一切しない**（消してよいかは
// src/shared/objectStorage.ts、いつ消すかは apply.ts）。ここは手足だけ。
//
// ── 一時キーの扱い ─────────────────────────────────────────────────────
// S3操作のために権限＋アクセスキーを発行する。**使い終わったら必ず消す**
// （`dispose`）。残すと、消したはずの保存場所へ届く鍵が生き続ける。

import type { StorageClientLike } from './apply'
import type { CloudCredentials } from './auth'
import { ObjectStorageClient, putObject, deleteObject, listAllKeys, type S3Auth, type StorageSite, type IssuedKey } from './objectStorage'

/** 使い終わったら片づける必要があるストレージ操作。 */
export type StorageAdapter = StorageClientLike & {
  /** 一時的に発行した鍵をすべて無効にする。**必ず finally で呼ぶこと。** */
  dispose(): Promise<void>
}

/** 組み立てに要るクラウドAPI操作（テストで差し替えられるように形だけ切っておく）。 */
export type StorageApiLike = {
  isSiteReady(siteId: string): Promise<boolean>
  createBucket(siteId: string, bucket: string): Promise<{ status: number; text: string }>
  /** バケットの一覧。**作れたかどうかを確かめる**のに使う。 */
  listBuckets(siteId: string): Promise<{ name: string }[]>
  deleteBucket(bucket: string): Promise<void>
  issueKey(siteId: string, bucket: string, displayName: string): Promise<IssuedKey>
  deletePermission(siteId: string, permissionId: string): Promise<void>
  listPermissions(siteId: string): Promise<{ id: string; displayName: string }[]>
}

/** 組み立てに要る S3 操作（同上）。 */
export type S3Like = {
  putObject(auth: S3Auth, bucket: string, key: string, body: string, opts?: { contentType?: string; publicRead?: boolean }): Promise<void>
  deleteObject(auth: S3Auth, bucket: string, key: string): Promise<void>
  listAllKeys(auth: S3Auth, bucket: string, prefix?: string): Promise<string[]>
}

const realS3: S3Like = { putObject, deleteObject, listAllKeys }

/**
 * apply に渡せるストレージ操作を作る。
 *
 * サイトの解決（`pickSite`）だけは先に済ませる。`siteInfo()` が同期のため
 * （公開のたびにアプリへ渡すエンドポイントは、その場で分かっている必要がある）。
 */
export async function createStorageAdapter(creds: CloudCredentials, opts: { zone?: string } = {}): Promise<StorageAdapter> {
  const client = new ObjectStorageClient({ credentials: creds, dryRun: false, ...(opts.zone ? { zone: opts.zone } : {}) })
  const site: StorageSite = await client.pickSite()
  return makeStorageAdapter(client, site)
}

/**
 * 解決済みのサイトと API 操作から、apply に渡す形を組み立てる（IOの実体は注入）。
 *
 * **一時キーの片づけをここで守る。** 残すと、消したはずの保存場所へ届く鍵が生き続ける。
 */
export function makeStorageAdapter(
  client: StorageApiLike,
  site: StorageSite,
  s3: S3Like = realS3,
  /** 403 のときの待ち時間（ミリ秒）。テストでは短くする。 */
  retryWaitsMs: readonly number[] = [700, 1500, 3000],
): StorageAdapter {
  // バケットごとの一時キー。**発行はできるだけ遅らせる**（要らなければ作らない）。
  const temp = new Map<string, { auth: S3Auth; permissionId: string }>()
  const host = String(site.s3_endpoint || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')

  const authFor = async (bucket: string): Promise<S3Auth> => {
    const found = temp.get(bucket)
    if (found) return found.auth
    const issued = await client.issueKey(site.id, bucket, `koto-ide-tmp-${Date.now()}`)
    const auth: S3Auth = { host, region: site.region, accessKey: issued.accessKey, secretKey: issued.secretKey }
    temp.set(bucket, { auth, permissionId: issued.permissionId })
    return auth
  }

  /**
   * 発行したばかりの鍵で S3 を叩く。**すぐには効かないことがある**ので少し待って試し直す。
   *
   * 2026-08-14、バケットを作った直後に目印を書こうとして `403 AccessDenied`。
   * 鍵も権限も正しいのに、行き渡るまでの間だけ弾かれる。**何度でも粘るのは違う**
   * （本当に権限が無いときに、ただ遅くなるだけになる）ので、短く数回で打ち切る。
   */
  const withNewKeyRetry = async <T>(run: () => Promise<T>): Promise<T> => {
    const waits = retryWaitsMs
    for (let i = 0; ; i++) {
      try {
        return await run()
      } catch (e: any) {
        const forbidden = /HTTP 403/.test(String(e?.message ?? ''))
        if (!forbidden || i >= waits.length) throw e
        await new Promise(r => setTimeout(r, waits[i]))
      }
    }
  }

  /** そのバケット用の一時キーを先に片づける（バケットを消す前に必要）。 */
  const releaseTemp = async (bucket: string): Promise<void> => {
    const found = temp.get(bucket)
    if (!found) return
    temp.delete(bucket)
    try { await client.deletePermission(site.id, found.permissionId) } catch { /* 消せなくても続行（dispose で再試行しない） */ }
  }

  return {
    async isSiteReady() { return client.isSiteReady(site.id) },

    async ensureBucket(bucket) {
      const created = await client.createBucket(site.id, bucket)
      // **作れたと決めつけない（2026-08-14）。**
      // 作成APIは 409 を返すことがあり、それを「もうあるので大丈夫」と読んでいる。
      // だが同じ名前を消した直後は「名前がまだ解放されていない」でも 409 になり得る。
      // その場合バケットは無いので、あとで書き込むと `403 AccessDenied` になり、
      // **原因の分からないエラーだけが残る**。だから一覧で存在を確かめる。
      const names = (await client.listBuckets(site.id)).map(b => b.name)
      if (!names.includes(bucket)) {
        // **応答をそのまま添える。** これが無いと、次に同じことが起きたときも
        // 「なぜ作られないのか」が誰にも分からない（2026-08-14 の教訓）
        throw new Error(
          `保存場所『${bucket}』を作成しましたが、一覧に現れません。`
          + '同じ名前の保存場所を削除した直後は、名前が解放されるまで作り直せないことがあります。'
          + 'しばらく待ってからお試しいただくか、設定の「データの保存」で別の名前の保存場所を作ってください。'
          + `（作成の応答: HTTP ${created.status}${created.text ? ' ' + created.text : ''}／`
          + `いまある保存場所: ${names.length > 0 ? names.join('、 ') : 'なし'}）`,
        )
      }
    },

    async listAllKeys(bucket) {
      const auth = await authFor(bucket)
      return withNewKeyRetry(() => s3.listAllKeys(auth, bucket))
    },

    async putMarker(bucket, key) {
      // 目印は中身の無い印。公開しない（バケットの既定のまま）
      const auth = await authFor(bucket)
      await withNewKeyRetry(() => s3.putObject(auth, bucket, key, '', { contentType: 'text/plain' }))
    },

    async deleteKeys(bucket, keys) {
      const auth = await authFor(bucket)
      // まとめて消すAPI（DeleteObjects）は使わない。1件ずつのほうが、
      // どれが消えなかったかが分かる。件数は多くない前提
      for (const k of keys) await s3.deleteObject(auth, bucket, k)
    },

    async deleteBucket(bucket) {
      // **先に一時キーを消す。** 権限がバケットを参照しているため
      await releaseTemp(bucket)
      await client.deleteBucket(bucket)
    },

    async issueKey(bucket, displayName) { return client.issueKey(site.id, bucket, displayName) },

    async deletePermission(permissionId) { await client.deletePermission(site.id, permissionId) },

    async listPermissions() { return client.listPermissions(site.id) },

    siteInfo() { return { s3Endpoint: site.s3_endpoint, region: site.region } },

    async dispose() {
      const all = Array.from(temp.entries())
      temp.clear()
      for (const [, v] of all) {
        try { await client.deletePermission(site.id, v.permissionId) } catch { /* 片づけの失敗で公開を失敗にしない */ }
      }
    },
  }
}
