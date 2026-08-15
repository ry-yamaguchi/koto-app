// objectStorage.ts — さくらのオブジェクトストレージのAPIクライアント。
//
// ── 実測で確定した呼び順（2026-08-13 / scripts/probe-object-storage.mjs）──
//   0. GET  fed/v1/clusters                     … サイト一覧
//   1. POST {site}/v2/account                   … **サイトの利用開始＝課金の始まり**
//   2. PUT  fed/v1/buckets/{name}               … body に cluster_id と plan が要る
//   3. POST {site}/v2/permissions               … バケットへの読み書き権限
//   4. POST {site}/v2/permissions/{id}/keys     … **シークレットはここでしか読めない**
//
// 1 を飛ばすと 2 が 401 "Authenticated, but not initialized to use the cluster yet"
// で落ちる。判定に `/status` を使ってはいけない（サイト全体の稼働状態であり、
// アカウントの有無と無関係に 200 を返す）。正しくは `/account`。
//
// 認証は **さくらのクラウドAPIキー**（AppRun と同じもの）。利用者に新しく
// 登録してもらうものは無い。
//
// ── 削除について（今日の学び）──────────────────────────────────────────
// **消す前に必ず一覧して確かめる。** 何を消してよいかの判断は
// src/shared/objectStorage.ts に集約してあり（掟10）、ここは「一覧を渡して
// 判断を仰ぎ、その通りに実行する」だけにする。ここで判断を書くと二重になる。

import type { CloudCredentials } from './auth'
import { sigv4Authorization, canonicalQuery, sha256hex, amzDateOf } from '../../shared/sigv4'
import { parseListResponse } from '../../shared/objectStorage'
import { parsePermissions } from '../../shared/storageKeys'

/** オブジェクトストレージAPI のベースURL（ゾーンは固定。サイトはこの下で分岐）。 */
export function objectStorageBase(zone = 'is1a'): string {
  return `https://secure.sakura.ad.jp/cloud/zone/${encodeURIComponent(zone)}/api/objectstorage/1.0`
}

/** サイト（クラスタ）の情報。実測した応答の形。 */
export type StorageSite = {
  id: string
  display_name: string
  s3_endpoint: string
  region: string
  plan_family: 'standard' | 'archive' | string
}

/** 発行されたアクセスキー。**secret は発行の応答でしか読めない。** */
export type IssuedKey = { accessKey: string; secretKey: string; permissionId: string }

function basicAuth(c: CloudCredentials): string {
  return 'Basic ' + Buffer.from(`${c.token}:${c.secret}`).toString('base64')
}

export type ApiResult = { ok: boolean; status: number; data: unknown; text: string }

/**
 * さくらのクラウドAPI（オブジェクトストレージ）を叩く。
 *
 * mutating（POST/PUT/DELETE）は `dryRun` のとき実行しない。既定は安全側の true。
 */
export class ObjectStorageClient {
  readonly dryRun: boolean
  private readonly creds: CloudCredentials
  private readonly base: string

  constructor(opts: { credentials: CloudCredentials; dryRun?: boolean; zone?: string }) {
    this.creds = opts.credentials
    this.dryRun = opts.dryRun ?? true
    this.base = objectStorageBase(opts.zone)
  }

  private async api(method: string, path: string, body?: unknown): Promise<ApiResult> {
    if (this.dryRun && method !== 'GET') {
      return { ok: true, status: 0, data: { dryRun: true, method, path, body: body ?? null }, text: '' }
    }
    const res = await fetch(`${this.base}/${path.replace(/^\//, '')}`, {
      method,
      headers: {
        Authorization: basicAuth(this.creds),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    let data: unknown = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { ok: res.ok, status: res.status, data, text }
  }

  /** サイト一覧。**アーカイブプランは用途が違う**ので、選ぶのは呼び出し側。 */
  async listSites(): Promise<StorageSite[]> {
    const r = await this.api('GET', 'fed/v1/clusters')
    if (!r.ok) throw new Error(`サイト一覧を取得できませんでした（HTTP ${r.status}）`)
    return ((r.data as any)?.data ?? []) as StorageSite[]
  }

  /** 通常プランのサイトを選ぶ（既定は最初の standard）。 */
  async pickSite(preferId?: string): Promise<StorageSite> {
    const sites = await this.listSites()
    const site = sites.find(s => s.id === preferId) ?? sites.find(s => s.plan_family === 'standard') ?? sites[0]
    if (!site) throw new Error('利用できるサイトがありません。')
    return site
  }

  /**
   * このサイトの利用が始まっているか。
   * **`/status` ではなく `/account` で見る**（/status はサイト全体の稼働状態）。
   */
  async isSiteReady(siteId: string): Promise<boolean> {
    const r = await this.api('GET', `${siteId}/v2/account`)
    return r.ok
  }

  /**
   * サイトの利用を開始する。**これが月額課金の始まり。**
   * 呼ぶ前に必ず利用者の同意を取ること（AppRun のレジストリ作成と同じ扱い）。
   */
  async startSite(siteId: string): Promise<void> {
    const r = await this.api('POST', `${siteId}/v2/account`)
    if (!r.ok) throw new Error(`サイトの利用を開始できませんでした（HTTP ${r.status}）: ${r.text.slice(0, 200)}`)
  }

  /**
   * バケットの一覧。設定画面で「既存を使う／新しく作る」を選ばせるために要る。
   *
   * ⚠️ **作成・削除は `fed/v1`、一覧は `{site}/v2` とベースが違う。**
   * 公式SDK も Create/Delete は fedClient、List は siteClient を使っている。
   * `fed/v1/buckets` で一覧を取ろうとすると 403 が返る（2026-08-13 実機で確認）。
   */
  async listBuckets(siteId: string): Promise<{ name: string }[]> {
    const r = await this.api('GET', `${siteId}/v2/buckets`)
    if (!r.ok) {
      throw new Error(
        r.status === 403
          ? '保存場所の一覧を見る権限がありません。さくらのクラウドのAPIキーに「オブジェクトストレージ」の権限があるか確認してください。'
          : `保存場所の一覧を取得できませんでした（HTTP ${r.status}）`
      )
    }
    return (((r.data as any)?.data ?? []) as { name: string }[])
  }

  /**
   * バケットを作る。**body が要る**（無いと 400 Invalid argument）。
   *
   * ⚠️ **作れたかどうかは、この戻り値だけでは決まらない。**
   * 409 を「すでにある」と読んでいるが、同じ名前を消した直後など「作られていないのに
   * 409」もあり得る（2026-08-14 実機。一覧が0個なのに作成は成功扱いだった）。
   * 呼び出し側は**一覧で存在を確かめる**こと。そのとき原因を説明できるよう、
   * ここでは応答をそのまま返す。
   */
  async createBucket(siteId: string, bucket: string): Promise<{ status: number; text: string }> {
    const r = await this.api('PUT', `fed/v1/buckets/${encodeURIComponent(bucket)}`, {
      cluster_id: siteId,
      plan: { type: 'standard', service_class_path: `objectstorage/${siteId}/bucket` },
    })
    // 409 は「すでにある」ことが多い。共有バケットでは正常な経路なので通す
    if (!r.ok && r.status !== 409) {
      throw new Error(`保存場所を作れませんでした（HTTP ${r.status}）: ${r.text.slice(0, 200)}`)
    }
    return { status: r.status, text: r.text.slice(0, 300) }
  }

  /** バケットを消す。**呼ぶ前に必ず shared/objectStorage.ts の判断を通すこと。** */
  async deleteBucket(bucket: string): Promise<void> {
    const r = await this.api('DELETE', `fed/v1/buckets/${encodeURIComponent(bucket)}`)
    if (!r.ok) throw new Error(`保存場所を削除できませんでした（HTTP ${r.status}）: ${r.text.slice(0, 200)}`)
  }

  /** 読み書き用のキーを発行する。**secret はこの戻り値でしか読めない。** */
  async issueKey(siteId: string, bucket: string, displayName: string): Promise<IssuedKey> {
    const perm = await this.api('POST', `${siteId}/v2/permissions`, {
      display_name: displayName,
      bucket_controls: [{ bucket_name: bucket, can_read: true, can_write: true }],
    })
    if (!perm.ok) throw new Error(`権限を作れませんでした（HTTP ${perm.status}）: ${perm.text.slice(0, 200)}`)
    const permissionId = String((perm.data as any)?.data?.id ?? '')

    const key = await this.api('POST', `${siteId}/v2/permissions/${encodeURIComponent(permissionId)}/keys`)
    if (!key.ok) throw new Error(`アクセスキーを発行できませんでした（HTTP ${key.status}）: ${key.text.slice(0, 200)}`)
    const d = (key.data as any)?.data ?? {}
    if (!d.id || !d.secret) {
      throw new Error('アクセスキーの応答に必要な値がありません。')
    }
    return { accessKey: String(d.id), secretKey: String(d.secret), permissionId }
  }

  /**
   * 権限の一覧。**片づける対象を選ぶために要る。**
   *
   * 公開のたびに新しい鍵を発行するので、片づけないと溜まる。実機では5件たまり、
   * **消えたバケット向けのもの**まで残っていた（2026-08-14）。
   * 鍵が残るのは「消したはずの保存場所へ届く鍵が生き続ける」ということでもある。
   */
  async listPermissions(siteId: string): Promise<{ id: string; displayName: string }[]> {
    const r = await this.api('GET', `${siteId}/v2/permissions`)
    if (!r.ok) throw new Error(`鍵の一覧を取得できませんでした（HTTP ${r.status}）`)
    return parsePermissions(r.data)
  }

  /** 権限ごと削除する（キーも一緒に無効になる）。 */
  async deletePermission(siteId: string, permissionId: string): Promise<void> {
    const r = await this.api('DELETE', `${siteId}/v2/permissions/${encodeURIComponent(permissionId)}`)
    if (!r.ok && r.status !== 404) {
      throw new Error(`権限を削除できませんでした（HTTP ${r.status}）`)
    }
  }
}

// ── S3互換API（オブジェクトの読み書き） ────────────────────────────────

export type S3Auth = { host: string; region: string; accessKey: string; secretKey: string }

/**
 * S3 の一回の呼び出しに使う「パス・クエリ・URL」を組み立てる（純関数）。
 *
 * **署名に使う文字列と、実際に投げる URL は同じでなければならない。**
 * 別々に組み立てると片方だけ直されて食い違い、`403 SignatureDoesNotMatch` になる。
 * 実際そうなった（2026-08-14。クエリの末尾に `=` を足していたのと、並べ替えていなかった）。
 */
export function buildS3Request(opts: { host: string; bucket: string; key?: string; query?: Record<string, string> }): {
  canonicalUri: string
  query: string
  url: string
} {
  const rawKey = String(opts.key ?? '').replace(/^\/+/, '')
  const canonicalUri = '/' + [opts.bucket, rawKey].filter(Boolean).join('/')
  const query = canonicalQuery(opts.query ?? {})
  return { canonicalUri, query, url: `https://${opts.host}${canonicalUri}${query ? '?' + query : ''}` }
}

async function s3(
  auth: S3Auth,
  method: string,
  bucket: string,
  key: string,
  opts: { body?: string; query?: Record<string, string>; extra?: Record<string, string> } = {},
) {
  const amzDate = amzDateOf(new Date())
  const payload = opts.body ?? ''
  const payloadHash = sha256hex(payload)
  const req = buildS3Request({ host: auth.host, bucket, key, ...(opts.query ? { query: opts.query } : {}) })
  const headers: Record<string, string> = {
    host: auth.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(opts.extra ?? {}),
  }
  const { authorization } = sigv4Authorization({
    method, canonicalUri: req.canonicalUri, query: req.query, headers, payloadHash,
    accessKey: auth.accessKey, secretKey: auth.secretKey, region: auth.region, amzDate,
  })
  const res = await fetch(req.url, {
    method,
    headers: { ...headers, Authorization: authorization },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    signal: AbortSignal.timeout(60000),
  })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

/** オブジェクトを書く。`publicRead` にすると、キー無しのURLから読めるようになる。 */
export async function putObject(auth: S3Auth, bucket: string, key: string, body: string, opts: { contentType?: string; publicRead?: boolean } = {}) {
  const extra: Record<string, string> = {}
  if (opts.contentType) extra['content-type'] = opts.contentType
  if (opts.publicRead) extra['x-amz-acl'] = 'public-read'
  const r = await s3(auth, 'PUT', bucket, key, { body, extra })
  if (!r.ok) throw new Error(`保存できませんでした（HTTP ${r.status}）: ${r.text.slice(0, 200)}`)
}

/** オブジェクトを消す。 */
export async function deleteObject(auth: S3Auth, bucket: string, key: string) {
  const r = await s3(auth, 'DELETE', bucket, key)
  if (!r.ok && r.status !== 204 && r.status !== 404) {
    throw new Error(`削除できませんでした（HTTP ${r.status}）`)
  }
}

/**
 * バケットの中身をすべて一覧する（ページングを最後まで辿る）。
 *
 * **削除の判断はこの結果で行う。** 途中で打ち切ると「他に何も無い」と誤判断して
 * 利用者のデータを巻き込む恐れがあるので、**打ち切らない**。
 */
export async function listAllKeys(auth: S3Auth, bucket: string, prefix = ''): Promise<string[]> {
  const keys: string[] = []
  let token: string | null = null
  for (let page = 0; page < 1000; page++) {
    // **クエリは canonicalQuery に任せる。** 自分で並べたり繋いだりすると署名が合わない
    const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' }
    if (prefix) query.prefix = prefix
    if (token) query['continuation-token'] = token
    const r = await s3(auth, 'GET', bucket, '', { query })
    if (!r.ok) throw new Error(`中身を確認できませんでした（HTTP ${r.status}）`)
    // 解析は shared/objectStorage.ts（テスト済み）。ここで書くと二重になる
    const parsed = parseListResponse(r.text)
    keys.push(...parsed.keys)
    if (!parsed.truncated || !parsed.nextToken) return keys
    token = parsed.nextToken
  }
  // ここに来るのは異常。**「全部見た」と偽らない**（偽ると利用者のデータを消す）
  throw new Error('中身が多すぎて確認しきれませんでした。安全のため削除を中止します。')
}
