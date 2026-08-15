#!/usr/bin/env node
// probe-app-storage.mjs — 公開したアプリが「どの鍵で・どの保存場所を」見ているかを調べる。
//
// ── なぜ要るか（2026-08-14）────────────────────────────────────────────
// 公開したアプリが `403` で保存場所を読めない。原因の候補が複数あり
// （鍵が消えている／別の保存場所を見ている／権限が足りない）、
// **推測で直すと今日のように何度も外す**。だから事実を1回で取る。
//
// 見るのは2つ:
//   ① アプリに渡っている環境変数（バケット名・プレフィックス・アクセスキーのID）
//   ② いま生きているパーミッション（鍵）の一覧
// この2つを突き合わせれば、どこが食い違っているかが確定する。
//
// ⚠️ **GET しか行わない。** 何も作らず、何も消さない。
// ⚠️ **シークレットは表示しない。** アクセスキーのIDも先頭数文字だけにする。
//
// 使い方:
//   SAKURA_TOKEN='...' SAKURA_SECRET='...' APP_ID='<アプリID>' node scripts/probe-app-storage.mjs

const ZONE = process.env.SAKURA_ZONE || 'is1a'
const APPRUN = 'https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api'
const OBJ = `https://secure.sakura.ad.jp/cloud/zone/${ZONE}/api/objectstorage/1.0`
const TOKEN = process.env.SAKURA_TOKEN || ''
const SECRET = process.env.SAKURA_SECRET || ''
const APP_ID = process.env.APP_ID || ''

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` }
const ok = s => console.log(`  ${c.g('✅')} ${s}`)
const ng = s => console.log(`  ${c.r('❌')} ${s}`)

/** 秘密を出さない。IDの先頭だけを見せる。 */
const mask = v => {
  const s = String(v ?? '')
  return s.length <= 6 ? '***' : `${s.slice(0, 6)}…（${s.length}文字）`
}

async function get(base, path) {
  const res = await fetch(`${base}/${path.replace(/^\//, '')}`, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${TOKEN}:${SECRET}`).toString('base64'),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data, text }
}

async function main() {
  if (!TOKEN || !SECRET || !APP_ID) {
    console.error('❌ SAKURA_TOKEN / SAKURA_SECRET / APP_ID を指定してください。')
    console.error("   例: SAKURA_TOKEN='...' SAKURA_SECRET='...' APP_ID='<アプリのID>' node scripts/probe-app-storage.mjs")
    process.exit(1)
  }
  console.log(c.d('※ GET しか行いません。シークレットは表示しません。'))

  console.log('\n① アプリに渡っている保存場所の設定')
  const app = await get(APPRUN, `applications/${APP_ID}`)
  if (!app.ok) { ng(`アプリを取得できません（HTTP ${app.status}）`); process.exit(1) }
  ok(`取得できました（resource_id=${app.data?.resource_id ?? '(無し)'}）`)
  const comps = Array.isArray(app.data?.components) ? app.data.components : []
  for (const comp of comps) {
    const env = Array.isArray(comp.env) ? comp.env : []
    const storage = env.filter(e => String(e.key ?? '').startsWith('KOTO_STORAGE_'))
    if (storage.length === 0) { ng('KOTO_STORAGE_* が1つも渡っていません（保存場所を使えません）'); continue }
    for (const e of storage) {
      const k = String(e.key)
      // シークレットは**絶対に出さない**
      const shown = /SECRET/.test(k) ? '（伏せます）' : /ACCESS_KEY/.test(k) ? mask(e.value) : String(e.value ?? '')
      console.log(`    ${k} = ${shown}`)
    }
  }

  console.log('\n② いま生きている鍵（パーミッション）の一覧')
  const clusters = await get(OBJ, 'fed/v1/clusters')
  if (!clusters.ok) { ng(`サイト一覧を取得できません（HTTP ${clusters.status}）`); process.exit(1) }
  const sites = clusters.data?.data ?? []
  const site = sites.find(s => s.plan_family === 'standard') ?? sites[0]
  if (!site) { ng('サイトがありません'); process.exit(1) }
  const perms = await get(OBJ, `${site.id}/v2/permissions`)
  if (!perms.ok) { ng(`パーミッションを取得できません（HTTP ${perms.status}）`); process.exit(1) }
  const list = perms.data?.data ?? []
  ok(`${list.length}件`)
  for (const p of list) {
    const buckets = (p.bucket_controls ?? []).map(b => `${b.bucket_name}(読${b.can_read ? '○' : '×'}/書${b.can_write ? '○' : '×'})`).join(' ')
    console.log(`    id=${p.id}  ${p.display_name ?? ''}  ${buckets}`)
  }

  console.log('\n②-b 各権限が持っている鍵（★アプリの鍵がどれかを突き合わせる）')
  console.log(c.d('   ①の KOTO_STORAGE_ACCESS_KEY と同じ先頭の鍵を探してください。'))
  for (const p of list) {
    const keys = await get(OBJ, `${site.id}/v2/permissions/${p.id}/keys`)
    if (!keys.ok) { console.log(`    id=${p.id} → 鍵を取得できません（HTTP ${keys.status}）`); continue }
    const ks = keys.data?.data ?? []
    const buckets = (p.bucket_controls ?? []).map(b => b.bucket_name).join('、') || c.y('（バケットの権限なし）')
    console.log(`    権限 id=${p.id}  対象: ${buckets}`)
    if (ks.length === 0) { console.log('      （鍵なし）'); continue }
    for (const k of ks) console.log(`      鍵 ${mask(k.id)}`)
  }

  console.log('\n③ バケットの一覧')
  const buckets = await get(OBJ, `${site.id}/v2/buckets`)
  buckets.ok ? ok((buckets.data?.data ?? []).map(b => b.name).join('、 ') || '（無し）')
             : ng(`取得できません（HTTP ${buckets.status}）`)

  console.log('\n────────────────────────────────')
  console.log('①の KOTO_STORAGE_ACCESS_KEY と同じ先頭の鍵が、②-b のどの権限にあるか。')
  console.log('その権限の「対象」が空、または別のバケットなら、それが 403 の原因です。')
}

if (process.argv[1] && process.argv[1].endsWith('probe-app-storage.mjs')) {
  main().catch(e => { console.error('\n❌ 途中で落ちました:', e?.message ?? e); process.exit(1) })
}
