#!/usr/bin/env node
// probe-app-s3.mjs — 公開したアプリと**まったく同じ鍵・同じ署名**で保存場所を叩き、
// さくらが何と答えるかをそのまま見る。
//
// ── なぜ要るか（2026-08-14）────────────────────────────────────────────
// アプリが 403 で落ちるが、`koto-data.js` は **数字しか記録していない**ので
// 「なぜ 403 なのか」が分からない。S3互換APIは理由を XML で返す:
//   SignatureDoesNotMatch → 署名の組み立てが違う
//   AccessDenied          → 権限が足りない
//   InvalidAccessKeyId    → その鍵が存在しない
//   NoSuchBucket          → バケットが無い
// **この3文字を見ないと直す場所が決まらない。** 推測で2回外している。
//
// 鍵はアプリの環境変数から取る（`GET /applications/{id}`）。
// ⚠️ **シークレットは画面に出さない。** 署名に使うだけ。
// ⚠️ **GET しか行わない。** 何も作らず、何も消さない。
//
// 使い方:
//   SAKURA_TOKEN='...' SAKURA_SECRET='...' APP_ID='...' node scripts/probe-app-s3.mjs

import crypto from 'node:crypto'

const APPRUN = 'https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api'
const TOKEN = process.env.SAKURA_TOKEN || ''
const SECRET = process.env.SAKURA_SECRET || ''
const APP_ID = process.env.APP_ID || ''

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` }
const ok = s => console.log(`  ${c.g('✅')} ${s}`)
const ng = s => console.log(`  ${c.r('❌')} ${s}`)

// 署名は**アプリと同じ実装**を使う（複製すると食い違って、確かめたことにならない）
const { sigv4Authorization, canonicalQuery, sha256hex, amzDateOf } = await (async () => {
  try { return await import('../dist/shared/sigv4.js') } catch {
    console.error('❌ 先に `npm run build` を実行してください。')
    process.exit(1)
  }
})()

async function s3(auth, method, bucket, key, query) {
  const amzDate = amzDateOf(new Date())
  const payloadHash = sha256hex('')
  const rawKey = String(key ?? '').replace(/^\/+/, '')
  const canonicalUri = '/' + [bucket, rawKey].filter(Boolean).join('/')
  const q = canonicalQuery(query ?? {})
  const headers = { host: auth.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  const { authorization } = sigv4Authorization({
    method, canonicalUri, query: q, headers, payloadHash,
    accessKey: auth.accessKey, secretKey: auth.secretKey, region: auth.region, amzDate,
  })
  const url = `https://${auth.host}${canonicalUri}${q ? '?' + q : ''}`
  const res = await fetch(url, { method, headers: { ...headers, Authorization: authorization } })
  return { ok: res.ok, status: res.status, text: await res.text(), url }
}

/** XML から <Code> と <Message> を取り出す（**理由はここにしかない**）。 */
function reason(text) {
  const code = /<Code>([\s\S]*?)<\/Code>/.exec(text)?.[1] ?? ''
  const msg = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1] ?? ''
  return code ? `${code}${msg ? ' — ' + msg : ''}` : (text || '').slice(0, 200)
}

async function main() {
  if (!TOKEN || !SECRET || !APP_ID) {
    console.error("❌ SAKURA_TOKEN / SAKURA_SECRET / APP_ID を指定してください（値は引用符で囲む）。")
    process.exit(1)
  }
  console.log(c.d('※ GET しか行いません。シークレットは表示しません（署名に使うだけ）。'))

  const res = await fetch(`${APPRUN}/applications/${APP_ID}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${TOKEN}:${SECRET}`).toString('base64'), Accept: 'application/json' },
  })
  if (!res.ok) { ng(`アプリを取得できません（HTTP ${res.status}）`); process.exit(1) }
  const app = await res.json()
  const env = {}
  for (const comp of app.components ?? []) for (const e of comp.env ?? []) env[e.key] = e.value

  const need = ['KOTO_STORAGE_BUCKET', 'KOTO_STORAGE_ENDPOINT', 'KOTO_STORAGE_REGION', 'KOTO_STORAGE_ACCESS_KEY', 'KOTO_STORAGE_SECRET_KEY']
  for (const k of need) if (!env[k]) { ng(`${k} がアプリに渡っていません`); process.exit(1) }

  const auth = {
    host: String(env.KOTO_STORAGE_ENDPOINT).replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    region: env.KOTO_STORAGE_REGION,
    accessKey: env.KOTO_STORAGE_ACCESS_KEY,
    secretKey: env.KOTO_STORAGE_SECRET_KEY,
  }
  const bucket = env.KOTO_STORAGE_BUCKET
  const prefix = env.KOTO_STORAGE_PREFIX ?? ''
  console.log(`\n  対象: ${auth.host} / ${bucket} / ${prefix} / region=${auth.region}`)

  console.log('\n① バケットの中身を一覧（アプリがやっていること）')
  const r1 = await s3(auth, 'GET', bucket, '', { 'list-type': '2', 'max-keys': '10', prefix })
  r1.ok ? ok(`読めました（${(r1.text.match(/<Key>/g) ?? []).length}件）`) : ng(`HTTP ${r1.status}: ${c.y(reason(r1.text))}`)

  console.log('\n② プレフィックス無しで一覧（範囲の問題かを見る）')
  const r2 = await s3(auth, 'GET', bucket, '', { 'list-type': '2', 'max-keys': '10' })
  r2.ok ? ok('読めました') : ng(`HTTP ${r2.status}: ${c.y(reason(r2.text))}`)

  console.log('\n③ 目印のファイルを1つ読む（クエリ無しの経路）')
  const r3 = await s3(auth, 'GET', bucket, `${prefix}.koto-keep`)
  r3.ok ? ok('読めました') : ng(`HTTP ${r3.status}: ${c.y(reason(r3.text))}`)

  console.log('\n────────────────────────────────')
  console.log('SignatureDoesNotMatch なら署名の組み立て、AccessDenied なら権限、')
  console.log('InvalidAccessKeyId なら鍵が届いていない、が原因です。')
}

if (process.argv[1] && process.argv[1].endsWith('probe-app-s3.mjs')) {
  main().catch(e => { console.error('\n❌ 途中で落ちました:', e?.message ?? e); process.exit(1) })
}
