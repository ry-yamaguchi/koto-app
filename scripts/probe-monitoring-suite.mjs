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
//
// ⚠️ 資格情報は画面に出さない。**出力**を貼るのは安全。
// ⚠️ ただし**実行したコマンドそのものを貼らないこと**（環境変数に実物が入る）。
//    貼るのは区切り線から下の出力だけでよい。

const ZONE = process.env.SAKURA_ZONE || 'is1a'
const API = `https://secure.sakura.ad.jp/cloud/zone/${ZONE}/api/monitoring/1.0`
const TOKEN = process.env.SAKURA_TOKEN || process.env.SAKURA_CLOUD_TOKEN || ''
const SECRET = process.env.SAKURA_SECRET || process.env.SAKURA_CLOUD_SECRET || ''

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

// T（2026-09-10 レビューの修理・バッチ3）: このスクリプトは生の応答を丸ごと出す（③④⑤が核心の
// 検証のため、形を削ると意味が無い）。ただし account_id / resource_id / id は他人に見せる可能性
// のある出力に実アカウントの値のまま載ってしまうため、**値だけ**を下4桁以外 `*` に伏せる
// （キー・件数・配列の長さなど「形」は一切削らない。probe-registry-zone.mjs の
// 「件数とIDの下4桁だけを出す」と同じ考え方）。
function maskTail(s) {
  return s.length <= 4 ? '*'.repeat(s.length) : '*'.repeat(s.length - 4) + s.slice(-4)
}
const ID_KEY_RE = /^(account_id|resource_id|id)$/i
function redactIds(value) {
  if (Array.isArray(value)) return value.map(redactIds)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = ID_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number') ? maskTail(String(v)) : redactIds(v)
    }
    return out
  }
  return value
}

function dump(label, r) {
  console.log(`  ${c.d(label)} → HTTP ${r.status}`)
  const redacted = typeof r.data === 'string' ? r.data : redactIds(r.data)
  const body = typeof redacted === 'string' ? redacted : JSON.stringify(redacted, null, 2)
  console.log((body ?? '').split('\n').map(l => '    ' + l).join('\n').slice(0, 3000))
}

async function main() {
  if (!TOKEN || !SECRET) {
    console.error('❌ SAKURA_TOKEN と SAKURA_SECRET（または SAKURA_CLOUD_TOKEN と SAKURA_CLOUD_SECRET）を指定してください。')
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

  // ── ここから 2026-09-08 追加（roadmap #30・メトリクスを有効にできるか）──────────
  // さくらの開発者から「ログとメトリクスは有効にしてて欲しい」と助言があった。
  // 原本（monitoring-suite-api.json v1.3.0）を見ると、メトリクスはログと**まったく同じ形**:
  //   GET/POST /metrics/storages/  … 置き場
  //   GET/POST /metrics/routings/  … { metrics_storage_id, publisher_code, variant, resource_id }
  // ログ側は variant='applicationlog' と分かっているが、**メトリクスの variant 名は未知**。
  // 推測せず、`GET /publishers/{code}/` が返す variants から実測する（掟1）。
  console.log('\n④ パブリッシャ apprun が持つ variant（★メトリクスの variant 名を推測せず知るため）')
  const pub = await get('publishers/apprun/')
  pub.ok ? ok('取得できました') : ng(`取得できません（HTTP ${pub.status}）`)
  dump('publishers/apprun', pub)

  console.log('\n⑤ メトリクスの置き場とルーティング（★作らない。あるかどうかを見るだけ）')
  const mStorages = await get('metrics/storages/')
  mStorages.ok ? ok('置き場の一覧を取得できました') : ng(`取得できません（HTTP ${mStorages.status}）`)
  dump('metrics/storages', mStorages)
  const mRoutings = await get('metrics/routings/')
  mRoutings.ok ? ok('ルーティングの一覧を取得できました') : ng(`取得できません（HTTP ${mRoutings.status}）`)
  dump('metrics/routings', mRoutings)

  // ── 2026-09-10 追加（専有型のログ・メトリクス設定・実機確認で判明）──────────────
  // 専有型のマニュアル（apprun-dedicated/operation.html「ログ・メトリクスの設定」）によると、
  // 専有型もモニタリングスイートの置き場を使い、種類は「エージェントログ／コンテナログ／
  // ロードバランサアクセスログ」と各メトリクス。専有型 API（v1.4.0）にはログの設定口が無いので、
  // 設定はモニタリングスイートのルーティング（publisher_code + variant + 任意の resource_id）で
  // 行うはず。**専有型の publisher コードと variant 名は未知**なので、全パブリッシャの一覧から
  // 実測する（掟1・推測しない）。GET のみ。
  console.log('\n⑥ 全パブリッシャの一覧（★専有型の publisher コードと variant 名を推測せず知るため）')
  const pubs = await get('publishers/')
  pubs.ok ? ok('取得できました') : ng(`取得できません（HTTP ${pubs.status}）`)
  dump('publishers', pubs)

  console.log('\n────────────────────────────────')
  console.log('この結果を共有してください。')
  console.log(' ・⑥に専有型らしいコード（apprun-dedicated 等）と variants が出ていれば、専有型のログ設定も Koto から作れます')
  console.log(' ・コンパネで専有型のログ・メトリクス設定を保存したあとに実行すると、③⑤にその実物のルーティング行が出ます')
  console.log(' ・③に AppRun のルーティングが出ていれば、ログは Koto から同じものを作れます')
  console.log(' ・④の variants に metrics 用の名前が出ていれば、メトリクスも同じ形で作れます')
  console.log(' ・①の provisioning/state には logs と metrics の両方が入っています（初期化の要否）')
}

if (process.argv[1] && process.argv[1].endsWith('probe-monitoring-suite.mjs')) {
  main().catch(e => {
    console.error('\n❌ 途中で落ちました:', e?.message ?? e)
    process.exit(1)
  })
}
