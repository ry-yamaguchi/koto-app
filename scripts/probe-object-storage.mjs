#!/usr/bin/env node
// probe-object-storage.mjs — さくらのオブジェクトストレージが Koto から自動化できるかを実測する。
//
// ── なぜ要るか（2026-08-12）────────────────────────────────────────────
// AppRun / Vercel / HANAMII はどれもコンテナ・サーバーレスで、**単体では
// 永続データを持てない**。そこへ「データを保存できる」を足すために、
// さくらのオブジェクトストレージを使えるかを確かめる（roadmap S-1）。
//
// 公式ドキュメントを読んで分かっているのはここまで:
//   ・S3互換API では **バケットの作成/削除ができない**
//   ・代わりに専用の「さくらのオブジェクトストレージAPI」があり、
//     コンパネと同等の操作（バケット作成を含む）ができる
//   ・認証は **さくらのクラウドAPIキー**（Koto が AppRun 用に既に持っている）
//   ・オブジェクトは Public read にすればキー無しの URL で読める
//
// **分かっていない＝これで測ること**:
//   ① パーミッション作成のレスポンスで **シークレットキーが取れるか**
//      → 取れなければ「コンパネで控えてください」に後退し、ワンクリックは崩れる
//   ② 実際に書き込み、公開URLで読めるか
//   ③ 後片付け（バケット・パーミッションの削除）がAPIでできるか
//
// リクエスト/レスポンスの形は**推測しない**（掟1）。生の応答をそのまま出す。
//
// ── 使い方 ────────────────────────────────────────────────────────────
//   SAKURA_TOKEN=... SAKURA_SECRET=... node scripts/probe-object-storage.mjs
//
// キーは「さくらのクラウド」のAPIキー（コントロールパネル → APIキー）。
// Koto の「認証情報」に登録しているものと同じ。
//
// ⚠️ **このスクリプトは課金の発生するリソースを作る。**（下の警告を参照）

import readline from 'node:readline'

// ── 設定 ──────────────────────────────────────────────────────────────
const ZONE = process.env.SAKURA_ZONE || 'is1a'
const API = `https://secure.sakura.ad.jp/cloud/zone/${ZONE}/api/objectstorage/1.0`
const TOKEN = process.env.SAKURA_TOKEN || ''
const SECRET = process.env.SAKURA_SECRET || ''
const STAMP = Date.now().toString(36)
const BUCKET = `koto-probe-${STAMP}`
const PERM_NAME = `koto-probe-${STAMP}`
const OBJECT_KEY = 'koto-probe.json'

/** 作ったものを控える。途中で落ちても後片付けできるように。 */
const made = { bucket: null, permissionId: null, keyId: null, siteId: null, accountCreated: false }

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` }
const ok = s => console.log(`  ${c.g('✅')} ${s}`)
const ng = s => console.log(`  ${c.r('❌')} ${s}`)
const info = s => console.log(`  ${c.d(s)}`)

/** さくらのクラウドAPI（Basic 認証）。生の応答を返す。 */
async function api(method, path, body) {
  const url = path.startsWith('http') ? path : `${API}/${path.replace(/^\//, '')}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${TOKEN}:${SECRET}`).toString('base64'),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* JSON でないこともある */ }
  return { status: res.status, ok: res.ok, text, json }
}

/** 応答を読みやすく出す。**秘密は出さない。** */
function dump(label, r) {
  console.log(`  ${c.d(`${label} → HTTP ${r.status}`)}`)
  const body = r.json ? JSON.stringify(r.json, null, 2) : r.text
  if (!body) return
  const redacted = String(body).replace(/("(?:secret|secret_access_key|secretAccessKey)"\s*:\s*")([^"]{4})[^"]*"/gi, '$1$2…（伏せ字）"')
  console.log(redacted.split('\n').map(l => '    ' + l).join('\n').slice(0, 2000))
}

// ── S3互換API ─────────────────────────────────────────────────────────
// **実装は src/main/cloud/objectStorage.ts に1つだけ。**（掟10）
// ここに複製した s3() を置いていたせいで、**アプリ側だけ 403 になる不具合を
// この検証が見逃した**（2026-08-14）。署名の食い違いは 403 としか出ないので、
// 検証が実物と違う道を通っていると、いつまでも原因に辿り着けない。
// electron に依存しないモジュールなので、ビルド済みの dist からそのまま読める。
const { putObject, deleteObject, listAllKeys } = await (async () => {
  try {
    return await import('../dist/main/cloud/objectStorage.js')
  } catch (e) {
    console.error('❌ 先に `npm run build` を実行してください（dist/main/cloud/objectStorage.js が要ります）。')
    console.error('  ', e?.message ?? e)
    process.exit(1)
  }
})()

// ── 後片付け ──────────────────────────────────────────────────────────
async function cleanup() {
  console.log('\n🧹 後片付け')
  if (made.keyId && made.permissionId && made.siteId) {
    const r = await api('DELETE', `${made.siteId}/v2/permissions/${made.permissionId}/keys/${made.keyId}`)
    r.ok ? ok('アクセスキーを削除しました') : ng(`アクセスキーを削除できません（HTTP ${r.status}）`)
  }
  if (made.permissionId && made.siteId) {
    const r = await api('DELETE', `${made.siteId}/v2/permissions/${made.permissionId}`)
    r.ok ? ok(`パーミッションを削除しました（id=${made.permissionId}）`)
         : ng(`パーミッションを削除できません（HTTP ${r.status}）→ コンパネで消してください`)
  }
  if (made.bucket) {
    const r = await api('DELETE', `fed/v1/buckets/${made.bucket}`)
    r.ok ? ok(`バケットを削除しました（${made.bucket}）`)
         : ng(`バケットを削除できません（HTTP ${r.status}）→ ${c.y('課金が続くのでコンパネで必ず消してください')}: ${made.bucket}`)
  }
  if (made.accountCreated) {
    // **既定では消さない。** アカウント削除はバケット削除より影響が大きく、
    // 同じサイトに他の用途があれば巻き込む。判断は人に委ねる。
    if (process.argv.includes('--delete-account')) {
      const r = await api('DELETE', `${made.siteId}/v2/account`)
      r.ok ? ok('サイトの利用を停止しました') : ng(`利用を停止できません（HTTP ${r.status}）→ コンパネで確認してください`)
    } else {
      console.log(`  ${c.y('⚠️ このスクリプトがサイトの利用を開始しました。')}`)
      console.log('     使い続けないなら、コントロールパネルで削除してください:')
      console.log('     https://secure.sakura.ad.jp/objectstorage/')
      console.log('     （--delete-account を付けて実行すると自動で停止します）')
    }
  }
}

async function confirm() {
  console.log(c.y('\n⚠️  このスクリプトは課金の発生するリソースを作ります。'))
  console.log('   さくらのオブジェクトストレージは ' + c.y('月額495円・日割なし・無料枠なし') + ' です。')
  console.log('   バケットを1つ作って最後に消しますが、' + c.y('作った時点でその月の課金対象になり得ます') + '。')
  console.log('   （既にオブジェクトストレージを使っているなら、追加の固定費は増えません）\n')
  if (process.argv.includes('--yes')) return true
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const a = await new Promise(r => rl.question('   続けますか？ (yes と入力) > ', r))
  rl.close()
  return a.trim().toLowerCase() === 'yes'
}

// ── 本体 ──────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN || !SECRET) {
    console.error('❌ SAKURA_TOKEN と SAKURA_SECRET を指定してください。')
    console.error('   例: SAKURA_TOKEN=... SAKURA_SECRET=... node scripts/probe-object-storage.mjs')
    process.exit(1)
  }
  if (!(await confirm())) { console.log('中止しました。'); process.exit(0) }

  console.log('\n① サイト（クラスタ）一覧')
  const clusters = await api('GET', 'fed/v1/clusters')
  if (!clusters.ok) {
    dump('GET fed/v1/clusters', clusters)
    // **ここで落ちた時点では、課金の発生するものは何も作っていない。**
    // 401 は「認証が通らない」。原因はだいたい次のどれか（2026-08-14）
    if (clusters.status === 401) {
      ng('キーが受け付けられませんでした（HTTP 401）。次を確かめてください:')
      console.log('     ・Koto の「認証情報」で使用中のキーと同じか（別のキーだと通りません）')
      console.log("     ・値を引用符で囲んだか（例: SAKURA_TOKEN='...' SAKURA_SECRET='...'）")
      console.log('       囲まないと、記号がシェルに解釈されて途中で切れることがあります')
      console.log(`     ・トークン ${TOKEN.length}文字 / シークレット ${SECRET.length}文字 として読み込みました`)
      console.log('       （さくらのクラウドのAPIキーは、通常どちらも数十文字あります）')
    } else if (clusters.status === 403) {
      ng('権限がありません（HTTP 403）。APIキーに「オブジェクトストレージ」の権限があるか確認してください。')
    } else {
      ng('一覧が取れません。キーとゾーンを確認してください。')
    }
    console.log(`  ${c.d('※ ここまでで課金の発生するものは作っていません。')}`)
    process.exit(1)
  }
  const sites = clusters.json?.data ?? []
  for (const s of sites) info(`${s.id}  ${s.display_name_ja ?? s.display_name}  ${s.s3_endpoint}  ${s.region}  (${s.plan_family})`)
  // アーカイブプランは用途が違う（取り出しに時間と費用がかかる）ので standard を選ぶ
  const site = sites.find(s => s.id === process.env.SAKURA_SITE) ?? sites.find(s => s.plan_family === 'standard') ?? sites[0]
  if (!site) { ng('サイトが1つも返りませんでした。'); process.exit(1) }
  const { id: siteId, s3_endpoint: s3Host, region } = site
  made.siteId = siteId
  ok(`使うサイト: ${siteId} / ${s3Host} / ${region}`)

  console.log('\n⓪ サイトの利用が始まっているか')
  // 2026-08-12 実測: 未初期化のまま バケットを作ると
  //   401 "Authenticated, but not initialized to use the cluster yet"
  // が返る。**サイトごとに「利用開始」が要る**（コンパネの「サイトを作成」に相当）。
  //
  // ⚠️ 判定に `/status` を使ってはいけない。あれは**サイト全体の稼働状態**で、
  //    アカウントの有無とは無関係に 200 を返す。最初それで判定して
  //    「利用開始済み」と誤表示し、次の行で同じ 401 に落ちた（2026-08-12）。
  //    正しくは `/account`（仕様の説明は「サイトアカウントの取得」）。
  const status = await api('GET', `${siteId}/v2/account`)
  if (status.ok) {
    ok('このサイトは利用開始済みです（追加の固定費は増えません）')
  } else if (status.status === 401 || status.status === 404) {
    console.log(c.y('  このサイトはまだ利用開始されていません。'))
    console.log(c.y('  続けるには「サイトの利用開始」が要りますが、これが月額課金の始まりです。'))
    console.log('  ' + c.y('→ 実行するとその月の495円が発生します（日割なし）'))
    if (!process.argv.includes('--yes')) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const a = await new Promise(r => rl.question('  利用を開始しますか？ (start と入力) > ', r))
      rl.close()
      if (a.trim().toLowerCase() !== 'start') { console.log('  中止しました。何も作っていません。'); process.exit(0) }
    }
    const acc = await api('POST', `${siteId}/v2/account`)
    if (!acc.ok) { dump(`POST ${siteId}/v2/account`, acc); ng('利用開始できませんでした。'); process.exit(1) }
    made.accountCreated = true
    ok('利用を開始しました')
  } else {
    dump(`GET ${siteId}/v2/status`, status)
    ng('状態を確認できませんでした。')
    process.exit(1)
  }

  console.log('\n② バケットを作る（← S3互換APIではできない操作）')
  // ボディの形は公式SDK（sacloud/object-storage-api-go の buckets.go）と
  // openapi.json から取った。**推測していない**（掟1）
  const bucketBody = {
    cluster_id: siteId,
    plan: { type: 'standard', service_class_path: `objectstorage/${siteId}/bucket` },
  }
  const bucket = await api('PUT', `fed/v1/buckets/${BUCKET}`, bucketBody)
  if (!bucket.ok) { dump(`PUT fed/v1/buckets/${BUCKET}`, bucket); ng('バケットを作れませんでした。'); process.exit(1) }
  made.bucket = BUCKET
  ok(`作れました（${BUCKET}）— Koto から自動でバケットを用意できます`)

  console.log('\n③ パーミッションを作る')
  const perm = await api('POST', `${siteId}/v2/permissions`, {
    display_name: PERM_NAME,
    bucket_controls: [{ bucket_name: BUCKET, can_read: true, can_write: true }],
  })
  if (!perm.ok) { dump(`POST ${siteId}/v2/permissions`, perm); ng('パーミッションを作れませんでした。'); await cleanup(); process.exit(1) }
  made.permissionId = perm.json?.data?.id
  ok(`作れました（id=${made.permissionId}）`)

  console.log('\n④ アクセスキーを発行する（★この検証の核心）')
  // 仕様上、secret は**発行の応答でしか読めない**（openapi.json の例が
  // "/NOTICE==EXISTS+ONLY+WHEN+JUST+CREATED/"、SDK も「Secretはこの戻り値でのみ参照可能」）
  const key = await api('POST', `${siteId}/v2/permissions/${made.permissionId}/keys`)
  dump(`POST ${siteId}/v2/permissions/${made.permissionId}/keys`, key)
  if (!key.ok) { ng('アクセスキーを発行できませんでした。'); await cleanup(); process.exit(1) }
  const accessKey = key.json?.data?.id
  const secretKey = key.json?.data?.secret
  made.keyId = accessKey

  if (accessKey && secretKey) {
    ok(c.g('★ アクセスキーとシークレットが取れました → Koto から完全自動化できます'))
    info(`アクセスキー: ${String(accessKey).slice(0, 6)}… / シークレット: ${String(secretKey).slice(0, 4)}…（以降は伏せます）`)
  } else {
    ng(c.y('★ シークレットが取れませんでした（上の応答を確認してください）'))
    await cleanup(); process.exit(1)
  }

  const auth = { host: s3Host, region, accessKey, secretKey }

  console.log('\n⑤ S3互換APIで書き込む')
  const payload = JSON.stringify({ hello: 'koto', at: new Date().toISOString() })
  let wrote = false
  try {
    await putObject(auth, BUCKET, OBJECT_KEY, payload, { contentType: 'application/json', publicRead: true })
    ok(`書き込めました（${OBJECT_KEY}）`)
    wrote = true
  } catch (e) {
    ng(`書き込めません: ${String(e?.message ?? e).slice(0, 300)}`)
  }

  if (wrote) {
    console.log('\n⑥ 公開読み取り（キー無しのURLで読めるか）')
    const publicUrl = `https://${s3Host}/${BUCKET}/${OBJECT_KEY}`
    const anon = await fetch(publicUrl)
    anon.ok
      ? ok(`キー無しで読めました → ${publicUrl}`)
      : ng(`キー無しでは読めません（HTTP ${anon.status}）。読み取りにもキーが要ります。`)

    // ★ 2026-08-14 に足した段。**ここが無かったせいで 403 を見逃した。**
    // 破棄は「中身を一覧して、消してよいか判断する」ので、一覧が通らないと
    // **保存場所を消せなくなる**（課金が止められない）。書き込みと違って
    // クエリ文字列を使うため、署名の組み立てが別の道を通る。
    console.log('\n⑦ 中身を一覧する（★破棄の判断に使う。クエリ付きの署名）')
    try {
      const keys = await listAllKeys(auth, BUCKET)
      ok(`一覧できました（${keys.length}件）: ${keys.slice(0, 5).join('、 ') || '（空）'}`)
      if (!keys.includes(OBJECT_KEY)) ng(`いま書いた ${OBJECT_KEY} が一覧に出ません`)
    } catch (e) {
      ng(`一覧できません: ${String(e?.message ?? e).slice(0, 300)}`)
      ng(c.y('★ これが失敗すると、保存場所を Koto から削除できません（課金が止まりません）'))
    }

    // プレフィックス付きの一覧も確かめる（共有バケットではこちらを使う）
    console.log('\n⑧ プレフィックスを指定して一覧する')
    try {
      const some = await listAllKeys(auth, BUCKET, 'koto-')
      ok(`絞り込めました（${some.length}件）`)
    } catch (e) {
      ng(`絞り込めません: ${String(e?.message ?? e).slice(0, 300)}`)
    }

    console.log('\n⑨ オブジェクトを消す')
    try {
      await deleteObject(auth, BUCKET, OBJECT_KEY)
      ok('消せました')
    } catch (e) {
      ng(`消せません: ${String(e?.message ?? e).slice(0, 300)}`)
    }
  }

  await cleanup()
  console.log('\n────────────────────────────────')
  console.log('この結果を共有してください。④の ★ と ⑦ が要点です。')
}

// 直接実行されたときだけ走らせる。**テストから import しても動き出さないように**
// （課金の発生する操作なので、うっかり走ることが絶対にあってはならない）。
if (process.argv[1] && process.argv[1].endsWith('probe-object-storage.mjs')) {
  main().catch(async e => {
    console.error('\n❌ 途中で落ちました:', e?.message ?? e)
    await cleanup().catch(() => {})
    process.exit(1)
  })
}
