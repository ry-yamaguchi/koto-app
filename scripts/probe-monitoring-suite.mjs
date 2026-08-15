#!/usr/bin/env node
// probe-monitoring-suite.mjs — AppRun のログを Koto から自動で有効にできるかを実測する。
//
// ── なぜ要るか（2026-08-14 Ryosuke 提案）────────────────────────────────
// 公開したアプリが動かないとき、原因はログにしかない。だが AppRun のログは
// **既定では無効**で、有効にするにはモニタリングスイートのログストレージへ
// ルーティングを作る必要がある。非エンジニアにこの設定はできない。
//
// → **アプリを作るときに Koto が自動で有効にできないか**、という提案。
//
// ── 分かっていること（公式ライブラリ sacloud/monitoring-suite-api-go で確認）──
//   GET/POST /logs/storages/   … ログストレージ（作ると月額の基本料金。日割なし）
//   GET/POST /logs/routings/   … ルーティング。作成の body は
//     { resource_id, publisher_code, variant, log_storage_id }
//   GET      /management/provisioning/state/ … 初期化済みか
//
// ── 分かっていない＝これで測ること ────────────────────────────────────
//   ① AppRun を表す `publisher_code` と `variant` の**実際の値**
//   ② `resource_id` に入るのは何か（AppRun 画面の「リソースID」か）
//   ③ ログストレージが既にあるか・プラン・保存日数
//
// **推測しない（掟1）。** Ryosuke が既にコントロールパネルで設定済みなので、
// それを読めば実値が分かる。
//
// ── 使い方 ────────────────────────────────────────────────────────────
//   SAKURA_TOKEN='...' SAKURA_SECRET='...' node scripts/probe-monitoring-suite.mjs
//
// ⚠️ **このスクリプトは GET しか行わない。** 何も作らず、何も変えず、課金も発生しない。

const ZONE = process.env.SAKURA_ZONE || 'is1a'
const API = `https://secure.sakura.ad.jp/cloud/zone/${ZONE}/api/monitoring/1.0`
const TOKEN = process.env.SAKURA_TOKEN || ''
const SECRET = process.env.SAKURA_SECRET || ''

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` }
const ok = s => console.log(`  ${c.g('✅')} ${s}`)
const ng = s => console.log(`  ${c.r('❌')} ${s}`)
const info = s => console.log(`  ${c.d(s)}`)

/** GET だけを行う。**書き込み系は意図的に実装していない**（誤って課金しないため）。 */
async function get(path) {
  const res = await fetch(`${API}/${path.replace(/^\//, '')}`, {
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

function dump(label, r) {
  console.log(`  ${c.d(label)} → HTTP ${r.status}`)
  const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)
  console.log((body ?? '').split('\n').map(l => '    ' + l).join('\n').slice(0, 3000))
}

async function main() {
  if (!TOKEN || !SECRET) {
    console.error('❌ SAKURA_TOKEN と SAKURA_SECRET を指定してください。')
    console.error("   例: SAKURA_TOKEN='...' SAKURA_SECRET='...' node scripts/probe-monitoring-suite.mjs")
    console.error('   （値は引用符で囲んでください。記号がシェルに解釈されて切れることがあります）')
    process.exit(1)
  }
  console.log(c.d('※ このスクリプトは GET しか行いません。何も作らず、課金も発生しません。'))

  console.log('\n① モニタリングスイートが初期化されているか')
  const state = await get('management/provisioning/state/')
  if (!state.ok) {
    dump('GET management/provisioning/state/', state)
    if (state.status === 401) {
      ng('キーが受け付けられませんでした（HTTP 401）。')
      console.log('     ・Koto の「認証情報」で使用中のキーと同じか')
      console.log(`     ・トークン ${TOKEN.length}文字 / シークレット ${SECRET.length}文字 として読み込みました`)
    } else if (state.status === 403) {
      ng('権限がありません（HTTP 403）。APIキーの権限をご確認ください。')
    } else {
      ng('状態を取得できませんでした。')
    }
    process.exit(1)
  }
  ok('取得できました')
  dump('provisioning/state', state)

  console.log('\n② ログストレージの一覧（★作らない。あるかどうかを見るだけ）')
  const storages = await get('logs/storages/')
  storages.ok ? ok('取得できました') : ng(`取得できません（HTTP ${storages.status}）`)
  dump('logs/storages', storages)

  console.log('\n③ ログのルーティング一覧（★この検証の核心）')
  console.log(c.d('   コンパネで AppRun のログを「利用する」にしてあるはずなので、'))
  console.log(c.d('   その設定が publisher_code / variant / resource_id として見えるはずです。'))
  const routings = await get('logs/routings/')
  routings.ok ? ok('取得できました') : ng(`取得できません（HTTP ${routings.status}）`)
  dump('logs/routings', routings)

  console.log('\n────────────────────────────────')
  console.log('この結果を共有してください。③に AppRun のルーティングが出ていれば、')
  console.log('Koto から同じものを作れます（publisher_code と variant の実値が分かるため）。')
}

if (process.argv[1] && process.argv[1].endsWith('probe-monitoring-suite.mjs')) {
  main().catch(e => {
    console.error('\n❌ 途中で落ちました:', e?.message ?? e)
    process.exit(1)
  })
}
