// koto-data.js — Koto が用意した「データの保存」。
//
// このファイルは Koto が置いたものです。**中身を書き換える必要はありません。**
// アプリからは下の4つだけを使ってください。
//
//   import { list, get, save, remove } from './koto-data.js'
//
//   await save('entries', { name: '山田', message: 'こんにちは' })  // 保存する
//   await list('entries')                                          // 全部読む
//   await get('entries', id)                                       // 1件読む
//   await remove('entries', id)                                    // 消す
//
// ── なぜこれを通すのか ────────────────────────────────────────────────
// ① **試すときと公開したときで、置き場所が変わる。**
//    手元で試すときは `.koto-data/` フォルダに、公開したあとはさくらの
//    オブジェクトストレージに保存します。この切り替えをここで吸収するので、
//    アプリのコードは何も変わりません。
//
// ② **同時に書いても壊れない。**
//    1件を1ファイルとして保存します。全件を1つのファイルにまとめると、
//    2人が同時に送信したときに片方が消えます。
//
// ③ **あとでデータベースに移せる。**
//    データが増えて検索や集計が必要になったら、**このファイルの中身だけ**を
//    データベース版に差し替えれば済みます。アプリ側は1行も変わりません。
//
// ── 向いていること・向いていないこと ──────────────────────────────────
// 問い合わせフォームの回答、投稿の一覧、簡単な記録には十分です。
// **数千件を超えると一覧の取得が遅くなります。** 検索や集計、大量のデータが
// 必要になったら、Koto に「データベースに変えたい」と伝えてください。

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const BUCKET = process.env.KOTO_STORAGE_BUCKET || ''
const ENDPOINT = (process.env.KOTO_STORAGE_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
const REGION = process.env.KOTO_STORAGE_REGION || ''
const PREFIX = process.env.KOTO_STORAGE_PREFIX || ''
const ACCESS_KEY = process.env.KOTO_STORAGE_ACCESS_KEY || ''
const SECRET_KEY = process.env.KOTO_STORAGE_SECRET_KEY || ''

/** クラウドに保存できる状態か。足りなければ手元のフォルダを使う。 */
const useCloud = Boolean(BUCKET && ENDPOINT && REGION && ACCESS_KEY && SECRET_KEY)

/** 手元で試すときの保存先。 */
const LOCAL_DIR = path.join(process.cwd(), '.koto-data')

/** いまどちらに保存しているか（画面に出したいとき用）。 */
export function storageMode() {
  return useCloud ? 'cloud' : 'local'
}

// ── 使う側の4つ ───────────────────────────────────────────────────────

/**
 * 1件保存する。`id` が無ければ自動で付ける。
 * 同じ `id` で呼ぶと上書き（更新）になる。
 */
export async function save(collection, data) {
  safeName(collection) // 入口で確かめる（下の try で握りつぶされないように）
  const record = { ...data }
  if (!record.id) record.id = newId()
  if (!record.createdAt) record.createdAt = new Date().toISOString()
  const body = JSON.stringify(record)
  if (useCloud) await s3Put(keyOf(collection, record.id), body)
  else await localPut(collection, record.id, body)
  return record
}

/** 1件読む。無ければ null。 */
export async function get(collection, id) {
  safeName(collection); safeName(id)
  const text = useCloud ? await s3Get(keyOf(collection, id)) : await localGet(collection, id)
  if (text == null) return null
  try { return JSON.parse(text) } catch { return null }
}

/**
 * 全部読む。新しい順に返す。
 * **数千件を超えると遅くなります**（1件ずつ読むため）。
 */
export async function list(collection) {
  safeName(collection)
  const ids = useCloud ? await s3ListIds(collection) : await localListIds(collection)
  const out = []
  // 一度に全部投げるとサーバに負荷がかかるので、少しずつ読む
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = await Promise.all(ids.slice(i, i + 20).map(id => get(collection, id)))
    for (const r of chunk) if (r) out.push(r)
  }
  out.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return out
}

/** 1件消す。 */
export async function remove(collection, id) {
  safeName(collection); safeName(id)
  if (useCloud) await s3Delete(keyOf(collection, id))
  else await localDelete(collection, id)
}

// ── ここから下は Koto の担当です（読まなくて構いません） ────────────────

function newId() {
  return crypto.randomUUID()
}

/**
 * 名前を検査する。**黙って書き換えず、おかしければ断る。**
 *
 * `../../etc` のような名前を黙って `etc` に直すと、**別の場所へ書いてしまい**、
 * しかもアプリからは成功したように見える。呼び出し側の間違いは、その場で気づける
 * ようにする（`/` や `..` を許すと保存先の外へ出る恐れもある）。
 */
function safeName(s) {
  const v = String(s ?? '')
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new Error(`保存先の名前に使えるのは英数字と _ - だけです: ${JSON.stringify(s)}`)
  }
  return v
}

function keyOf(collection, id) {
  return `${PREFIX}${safeName(collection)}/${safeName(id)}.json`
}

// ── 手元のフォルダ（試すとき） ────────────────────────────────────────

function localPath(collection, id) {
  return path.join(LOCAL_DIR, safeName(collection), `${safeName(id)}.json`)
}

async function localPut(collection, id, body) {
  const p = localPath(collection, id)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, body, 'utf8')
}

async function localGet(collection, id) {
  // 「無い」と「名前がおかしい」を区別するため、名前の検査は入口（get）で済ませてある。
  // ここで捕まえるのは「ファイルが無い」だけ
  try { return await fs.readFile(localPath(collection, id), 'utf8') } catch { return null }
}

async function localListIds(collection) {
  try {
    const names = await fs.readdir(path.join(LOCAL_DIR, safeName(collection)))
    return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5))
  } catch { return [] }
}

async function localDelete(collection, id) {
  try { await fs.unlink(localPath(collection, id)) } catch { /* 無ければ何もしない */ }
}

// ── さくらのオブジェクトストレージ（公開したとき） ──────────────────────

async function s3Put(key, body) {
  const r = await s3('PUT', key, body, { 'content-type': 'application/json' })
  if (!r.ok) throw new Error(`保存できませんでした（${r.status}）`)
}

async function s3Get(key) {
  const r = await s3('GET', key)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`読み込めませんでした（${r.status}）`)
  return r.text
}

async function s3Delete(key) {
  const r = await s3('DELETE', key)
  if (!r.ok && r.status !== 204 && r.status !== 404) throw new Error(`削除できませんでした（${r.status}）`)
}

async function s3ListIds(collection) {
  const prefix = `${PREFIX}${safeName(collection)}/`
  const ids = []
  let token = null
  for (let page = 0; page < 1000; page++) {
    // **SigV4 は「名前で並べた」クエリを要求する。** URLSearchParams は並べ替えないので、
    // continuation-token が付く2ページ目以降で署名が合わなくなる（403）。
    // 1ページ目はたまたま辞書順に並ぶため、少ないデータでは表に出ない（2026-08-14）。
    const params = { 'list-type': '2', 'max-keys': '1000', prefix }
    if (token) params['continuation-token'] = token
    const r = await s3('GET', '', undefined, {}, canonicalQuery(params))
    if (!r.ok) throw new Error(`一覧を取得できませんでした（${r.status}）`)
    for (const m of r.text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      const key = decodeEntities(m[1])
      if (key.startsWith(prefix) && key.endsWith('.json')) ids.push(key.slice(prefix.length, -5))
    }
    if (!/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(r.text)) break
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(r.text)
    if (!next) break
    token = decodeEntities(next[1])
  }
  return ids
}

/**
 * SigV4 が要求する形のクエリ文字列にする（名前で辞書順・RFC3986・空値も `=`）。
 *
 * `URLSearchParams.toString()` は**並べ替えない**ので、そのまま署名に使うと
 * 署名が合わず 403 になる。しかも 403 は「鍵が悪い」のか「署名が違う」のか
 * 区別がつかないので、原因に辿り着けない。
 */
function canonicalQuery(params) {
  const enc = v => encodeURIComponent(String(v ?? '')).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return Object.entries(params)
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function decodeEntities(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

async function s3(method, key, body, extraHeaders = {}, query = '') {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const payload = body ?? ''
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex')
  const canonicalUri = '/' + [BUCKET, key].filter(Boolean).join('/')
  const headers = { host: ENDPOINT, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extraHeaders }
  const authorization = sign({ method, canonicalUri, query, headers, payloadHash, amzDate })
  const res = await fetch(`https://${ENDPOINT}${canonicalUri}${query ? '?' + query : ''}`, {
    method,
    headers: { ...headers, Authorization: authorization },
    ...(body !== undefined ? { body } : {}),
  })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

/**
 * AWS Signature Version 4。
 * ※ Koto 本体（src/shared/sigv4.ts）と同じ計算をします。
 *   食い違うと 403 しか返らず原因が分からなくなるため、Koto 側のテストで
 *   両方が同じ署名を出すことを確かめています（tests/kotoDataTemplate.test.ts）。
 */
function sign({ method, canonicalUri, query, headers, payloadHash, amzDate }) {
  const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest()
  const dateStamp = amzDate.slice(0, 8)
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim()
  const names = Object.keys(lower).sort()
  const canonicalHeaders = names.map(k => `${k}:${lower[k]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  const kDate = hmac('AWS4' + SECRET_KEY, dateStamp)
  const signature = hmac(hmac(hmac(hmac(kDate, REGION), 's3'), 'aws4_request'), stringToSign).toString('hex')
  return `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}
