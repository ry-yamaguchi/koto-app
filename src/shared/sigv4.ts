// sigv4.ts — AWS Signature Version 4 の署名（S3互換API用）。
//
// ── なぜ自前で書くか ──────────────────────────────────────────────────
// さくらのオブジェクトストレージは S3互換APIを持つが、そのために aws-sdk を
// 同梱すると配布物が数MB増える。**配布サイズは更新のダウンロード量に直結する**
// （docs/update-plan.md）。要るのは署名だけなので、ここに置く。
//
// ── なぜ「守り」なのか（掟10）──────────────────────────────────────────
// **署名が違っても `403 SignatureDoesNotMatch` としか返らない。** キーが悪いのか、
// 権限が足りないのか、署名の組み立てが違うのか、利用者にも実装者にも区別がつかない。
// だから**AWS 公式のテストベクタ**で固定してある（tests/sigv4.test.ts）。
//
// この実装は scripts/probe-object-storage.mjs（実測に使った検証スクリプト）からも
// 参照される。**定義はここ1箇所。** 複製すると片方だけ直されて食い違う。

import crypto from 'node:crypto'

function hmac(key: crypto.BinaryLike | Buffer, msg: string): Buffer {
  return crypto.createHmac('sha256', key).update(msg).digest()
}

/** 本文の SHA256（16進）。S3 は本文が無いときも空文字のハッシュを要求する。 */
export function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/** `x-amz-date` の形式（20130524T000000Z）にする。 */
export function amzDateOf(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

/**
 * クエリ文字列を SigV4 の「正規化された形」にする（純関数）。
 *
 * ── なぜ要るか（2026-08-14 実機で 403）────────────────────────────────
 * 呼び出し側が `URLSearchParams.toString()` の結果をそのまま渡し、さらに末尾へ
 * `=` を足していた。**署名が合わず、一覧が HTTP 403 で落ちた。**
 * その結果「中身を確認できないので削除を中止」となり、保存場所が消せなくなった。
 *
 * 仕様は3つ。どれを外しても 403 になる:
 *   ① **名前で辞書順に並べる**（`URLSearchParams` は並べ替えない）
 *   ② **RFC3986 でエンコードする**（空白は `+` ではなく `%20`。`!'()*` も対象）
 *   ③ **値が空でも `=` を付ける**（`acl=` のような旗）
 *
 * URL に使う文字列と、署名に使う文字列は**同じものでなければならない**。
 * だから片方だけを組み立てる関数にせず、ここが返した文字列を両方に使う。
 */
export function canonicalQuery(params: Record<string, string>): string {
  const enc = (v: string): string =>
    encodeURIComponent(String(v ?? '')).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return Object.entries(params ?? {})
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

export type Sigv4Input = {
  method: string
  /** `/バケット名/キー` の形。**URLエンコード前の生のパス**を渡す。 */
  canonicalUri: string
  /**
   * 正規化済みのクエリ文字列。**必ず `canonicalQuery()` が返したものを渡す**
   * （並び順・エンコード・空値の `=` が仕様どおりでないと 403 になる）。無ければ空文字。
   */
  query?: string
  /** 署名に含めるヘッダ。`host` と `x-amz-date` は必須。 */
  headers: Record<string, string>
  payloadHash: string
  accessKey: string
  secretKey: string
  /** さくらは `jp-north-1`（石狩）/ `jp-east-1`（東京）。**間違うと弾かれる。** */
  region: string
  service?: string
  amzDate: string
}

/** SigV4 の Authorization ヘッダを組み立てる（純関数）。 */
export function sigv4Authorization(input: Sigv4Input): {
  authorization: string
  signedHeaders: string
  signature: string
} {
  const { method, canonicalUri, query = '', headers, payloadHash, accessKey, secretKey, region, amzDate } = input
  const service = input.service ?? 's3'
  const dateStamp = amzDate.slice(0, 8)

  // ヘッダ名は小文字・辞書順。値は前後の空白を落とす（仕様）
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim()
  const names = Object.keys(lower).sort()
  const canonicalHeaders = names.map(k => `${k}:${lower[k]}\n`).join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')

  const kDate = hmac('AWS4' + secretKey, dateStamp)
  const signature = hmac(hmac(hmac(hmac(kDate, region), service), 'aws4_request'), stringToSign).toString('hex')

  return {
    signature,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
