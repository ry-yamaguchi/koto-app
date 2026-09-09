#!/usr/bin/env node
/*
 * コンテナレジストリは「ゾーンに属する」のか「全ゾーン共通」なのかを実測する。
 *
 * ── なぜ要るか（2026-09-08・検分の指摘）────────────────────────────────
 * Koto のコードに、正反対の断定が2つ同居している:
 *   (a) src/renderer/components/AppRunPanel.tsx
 *       「createContainerRegistry(spec.region, …) がレジストリの置き場所を決める」
 *   (b) src/main/ipc/cloud.ts
 *       「レジストリは全ゾーン共通（グローバル資源）。既定のゾーンで引く」
 *       （棚卸し cloud:inventory は is1a だけを引いている）
 * **どちらも実測記録が無い。** どちらが本当かで結論が正反対になる:
 *   (a) なら → is1a 以外に作ったレジストリを棚卸しが拾えない。
 *              月220円の取り残しを見つける唯一の網に穴が開く
 *   (b) なら → ゾーンを選ばせる意味が無く、注意書きの根拠も消える
 *
 * ── 何をするか ────────────────────────────────────────────────────────
 * 複数のゾーンで `GET /commonserviceitem` を引き、**同じレジストリが返るか**を比べる。
 *   同じ → 全ゾーン共通（グローバル資源）
 *   違う → ゾーンに属する
 *
 * ── 安全性 ────────────────────────────────────────────────────────────
 * **GET しか行わない。** 何も作らず、何も消さず、何も変えない。課金も発生しない。
 * キーは環境変数からのみ受け取り、出力に含めない。
 * レジストリの**名前は出さず**、件数と ID の下4桁だけを出す（他人に見せる可能性のある出力のため）。
 *
 * ── 使い方 ────────────────────────────────────────────────────────────
 *   SAKURA_CLOUD_TOKEN=<アクセストークン> SAKURA_CLOUD_SECRET=<シークレット> \
 *     node scripts/probe-registry-zone.mjs
 *
 *   ネットワークを使わず URL だけ確認する（キー不要）:
 *     node scripts/probe-registry-zone.mjs --dry-run
 */

const ZONES = ['is1a', 'tk1a', 'tk1b', 'is1b']
const DRY = process.argv.includes('--dry-run')
const TOKEN = process.env.SAKURA_CLOUD_TOKEN ?? ''
const SECRET = process.env.SAKURA_CLOUD_SECRET ?? ''
const line = (s = '') => console.log(s)

if (!DRY && (!TOKEN || !SECRET)) {
  line('環境変数 SAKURA_CLOUD_TOKEN と SAKURA_CLOUD_SECRET を指定してください。')
  line('（URLの確認だけなら --dry-run を付けてください）')
  process.exit(2)
}
const auth = 'Basic ' + Buffer.from(`${TOKEN}:${SECRET}`).toString('base64')

async function listRegistries(zone) {
  const url = `https://secure.sakura.ad.jp/cloud/zone/${zone}/api/cloud/1.1/commonserviceitem`
  if (DRY) return { zone, url, dry: true }
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* そのまま */ }
    if (!res.ok) return { zone, url, status: res.status, ok: false, raw: text.slice(0, 400) }
    const items = Array.isArray(body?.CommonServiceItems) ? body.CommonServiceItems : []
    // レジストリだけに絞る。名前は出さない（IDの下4桁だけ）。
    const found = items.filter(i => String(i?.Provider?.Class ?? '') === 'containerregistry')
    const regs = found.map(i => String(i?.ID ?? '').slice(-4)).sort()
    // 2026-09-09 追加（roadmap #36）: 「さくら側で分類できるようにする」ために、
    // レジストリが Tags / Description / Icon を持てるのかを確かめたい。
    // **値は出さない**（名前や説明が他人の目に触れうるため）。**キーの有無と型だけ**を出す。
    const shape = found.length === 0 ? null : (() => {
      const i = found[0]
      const k = (name) => {
        if (!(name in i)) return 'キーなし'
        const v = i[name]
        if (v === null) return 'null'
        if (Array.isArray(v)) return `配列(${v.length}件)`
        return typeof v
      }
      return { Name: k('Name'), Description: k('Description'), Tags: k('Tags'), Icon: k('Icon') }
    })()
    return { zone, url, status: res.status, ok: true, total: items.length, registries: regs, shape }
  } catch (e) {
    return { zone, url, error: e?.message ?? String(e) }
  }
}

line('─'.repeat(70))
line('コンテナレジストリは「ゾーンに属する」か「全ゾーン共通」か')
line('─'.repeat(70))
line('※ GET しか行いません。何も作らず、何も消しません。')
line('※ レジストリ名は出力しません（IDの下4桁のみ）。')
line()

const results = []
for (const z of ZONES) {
  const r = await listRegistries(z)
  results.push(r)
  if (r.dry) { line(`  ${z}: ${r.url}`); continue }
  if (r.error) { line(`  ${z}: ❌ ${r.error}`); continue }
  if (!r.ok) { line(`  ${z}: ⚠️ HTTP ${r.status} / 生の応答: ${r.raw}`); continue }
  line(`  ${z}: HTTP ${r.status} / 全アイテム ${r.total}件 / レジストリ ${r.registries.length}件 [${r.registries.join(', ')}]`)
  if (r.shape) line(`      分類に使える項目（値は出しません）: ${JSON.stringify(r.shape)}`)
}
if (DRY) process.exit(0)

line()
line('─'.repeat(70))
const okz = results.filter(r => r.ok)
if (okz.length < 2) {
  line('2つ以上のゾーンから取れなかったため、判定できません。上の生の応答をご確認ください。')
} else {
  const sets = okz.map(r => r.registries.join('|'))
  const allSame = sets.every(s => s === sets[0])
  line(allSame
    ? '✅ どのゾーンでも同じ一覧でした → **全ゾーン共通（グローバル資源）**の可能性が高い'
    : '⚠️ ゾーンごとに一覧が違いました → **ゾーンに属する**。棚卸しが is1a しか見ていないのは穴')
  line()
  line('この結果をそのまま共有してください。これで、ゾーンを選ばせるべきか／')
  line('棚卸しを全ゾーンに広げるべきかが決まります。')
}
