#!/usr/bin/env node
/*
 * ゾーン一覧（GET /zone）の疎通と応答の形を確かめる。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────
 * AppRun 専有型でオートスケーリンググループを作るには `zone` が必須だが、
 * 専有型の OpenAPI 原本には**許容値の一覧が無い**（example に "tk1b" があるだけ）。
 * そのため Koto は今のところ自由入力にしている。
 *
 * 2026-09-07 の再調査で、さくらのクラウド API v1.1 の「設備関連API」に
 * **GET /zone（ゾーン一覧を取得）** があり、**通常のクラウドAPIキーで叩ける**ことが
 * 公式ドキュメントで確認できた（https://manual.sakura.ad.jp/cloud-api/1.1/ の設備関連API）。
 * これを使えば②の自由入力を選択式にできる。
 *
 * ただし**応答の形は未確認**。2026-09-07 に「応答の形を推測して読み、実APIで全滅した」
 * 事故を起こしている（docs/apprun-dedicated-plan.md 5-8）。同じ轍を踏まないよう、
 * **実測した生の応答から形を決める**。このスクリプトはそのための道具。
 *
 * ── 安全性 ────────────────────────────────────────────────────────────
 * **GET しか行わない。** 何も作らない・何も消さない・何も変更しない。
 * キーとシークレットは環境変数からのみ受け取り、出力には一切含めない。
 *
 * ── 使い方 ────────────────────────────────────────────────────────────
 *   SAKURA_CLOUD_TOKEN=<アクセストークン> SAKURA_CLOUD_SECRET=<シークレット> \
 *     node scripts/probe-zones.mjs
 *
 *   ネットワークを使わず、組み立てる URL だけ確認する（キー不要）:
 *     node scripts/probe-zones.mjs --dry-run
 */

// 公式ドキュメントの curl サンプルと同じ形。URL 自体にゾーンを含むが、
// どのゾーンのURLからでも一覧は引ける（サンプルは is1a）。
const BASE = 'https://secure.sakura.ad.jp/cloud/zone/is1a/api/cloud/1.1/'
const DRY = process.argv.includes('--dry-run')
const TOKEN = process.env.SAKURA_CLOUD_TOKEN ?? ''
const SECRET = process.env.SAKURA_CLOUD_SECRET ?? ''

const line = (s = '') => console.log(s)
const head = (s) => { line(); line('─'.repeat(70)); line(s); line('─'.repeat(70)) }

if (!DRY && (!TOKEN || !SECRET)) {
  line('環境変数 SAKURA_CLOUD_TOKEN と SAKURA_CLOUD_SECRET を指定してください。')
  line('（URLの確認だけなら --dry-run を付けてください）')
  process.exit(2)
}

const auth = 'Basic ' + Buffer.from(`${TOKEN}:${SECRET}`).toString('base64')

async function get(path) {
  const url = BASE + path
  if (DRY) return { url, dry: true }
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = null }
    return { url, status: res.status, ok: res.ok, ms: Date.now() - t0, text, body }
  } catch (e) {
    return { url, error: e?.message ?? String(e), ms: Date.now() - t0 }
  }
}

head('GET /zone（ゾーン一覧）')
const r = await get('zone')
line(`URL: ${r.url}`)
if (r.dry) {
  line('（--dry-run のためリクエストは送っていません）')
  process.exit(0)
}
line(`HTTP ${r.status ?? '(通信失敗)'}（${r.ms}ms）`)
if (r.error) {
  line(`  ❌ ${r.error}`)
} else if (!r.ok) {
  line('  ⚠️ 想定外の応答です。生の応答:')
  line(`  ${r.text.slice(0, 800)}`)
} else if (r.body === null) {
  line('  ⚠️ JSON として解釈できませんでした。生の応答:')
  line(`  ${r.text.slice(0, 800)}`)
} else {
  // **形を決め打ちしない。** 応答をそのまま出し、これを見てから実装する。
  line()
  line('生の応答（そのまま。これを見て読み取り方を決めます）:')
  line(JSON.stringify(r.body, null, 2).slice(0, 4000))
}

head('まとめ')
line('上の「生の応答」をそのまま共有してください。')
line('（アクセストークン・シークレットは出力に含まれません）')
