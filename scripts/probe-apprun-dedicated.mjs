#!/usr/bin/env node
/*
 * AppRun 専有型（apprun-dedicated）疎通プローブ。
 *
 * ── なぜ要るか（掟1: 推測で実装しない・調査ステップを先に置く）───────────────
 * 専有型は共用の AppRun（scripts/probe-import-apprun.mjs が使っている
 * apprun/1.0 系）とは別の API を持つ。本実装（公開先の追加など）に入る前に、
 * 実キーで「読み取りだけ」の疎通を確かめる。確かめたいのは3点だけ:
 *   ① Koto が既に持つさくらのクラウド APIキーでそのまま認証できるか
 *   ② 制限値（GET /limits）と料金プラン（GET /service_classes/{worker,lb}）を
 *      実測で取れるか
 *   ③ 既存のクラスタ一覧（GET /clusters）が読めるか
 *   ④ **省力化の可否**（2026-09-07 Ryosuke 指示）: サービスプリンシパルは公式手順では
 *      コントロールパネルでの作成のみと書かれているが、**IAM API**（別のベースURL）には
 *      `GET /projects` と `GET /service-principals` があり、作成（POST）も定義されている。
 *      ただし認証は `ServicePrincipalAuth` とされ、**通常のAPIキー（BasicAuth）で叩けるかは
 *      ドキュメントに明記が無い**。ここが通れば Koto から自動化でき、通らなければ
 *      「コンパネで一度だけ作る」導線を用意することになる。**推測せず実測で決める**（掟1）。
 * 応答の形は推測しない。実測した生の値をもとに、次の設計判断（本実装の要否・
 * 項目名）を行う。詳しい経緯は docs/apprun-dedicated-plan.md を参照。
 *
 * ── 事実（公式ドキュメントで確認済み）───────────────────────────────────
 *   ベースURL: https://secure.sakura.ad.jp/cloud/api/apprun-dedicated/1.0/
 *   認証: BasicAuth（ユーザ名＝アクセストークン／パスワード＝アクセストークン
 *         シークレット）
 *   参考: https://manual.sakura.ad.jp/api/cloud/portal/apprun-dedicated-api/index.html
 *
 * ── 安全性 ────────────────────────────────────────────────────────────
 * **このスクリプトは GET しか行わない。** POST/PUT/PATCH/DELETE は1つも
 * 書いていない（読み取り専用の4エンドポイントを順に叩くだけ）。
 * 何も作らない・何も消さない。
 *
 * キー・シークレットは環境変数からのみ受け取り、出力には一切含めない。
 * クラスタの名前・IDも出力しない（件数のみ。他人に見せる可能性がある出力のため）。
 * os.homedir() の値もこのスクリプトのソース・出力のどちらにも登場しない
 * （2026-09-07 に公開リポジトリへ絶対パスを混入させた事故があったため。
 *   scripts/ は公開対象＝ここに書いたものはそのまま外部の目に触れる）。
 *
 * ── 使い方 ────────────────────────────────────────────────────────────
 *   SAKURA_CLOUD_TOKEN=<アクセストークン> SAKURA_CLOUD_SECRET=<アクセストークンシークレット> \
 *     node scripts/probe-apprun-dedicated.mjs
 *
 *   ネットワークを使わず、組み立てる URL や出力の書式だけを確認する（キー不要）:
 *     node scripts/probe-apprun-dedicated.mjs --dry-run
 *
 * 出力は人間可読の表 ＋ 末尾に JSON。JSON にも秘密情報とクラスタ名/IDは含めない。
 */

const BASE = 'https://secure.sakura.ad.jp/cloud/api/apprun-dedicated/1.0/'
// IAM API は**別のベースURL**（サービスプリンシパルとプロジェクトを扱う）。
// ここを通常のAPIキーで叩けるかどうかが、手動作業を省けるかの分かれ目（上の目的④）。
const IAM_BASE = 'https://secure.sakura.ad.jp/cloud/api/iam/1.0/'

// 叩く順（掟に明記された順番のとおり）
const ENDPOINTS = [
  { key: 'limits', base: BASE, path: 'limits', label: 'GET /limits（制限値）' },
  { key: 'worker', base: BASE, path: 'service_classes/worker', label: 'GET /service_classes/worker（ワーカプラン）' },
  { key: 'lb', base: BASE, path: 'service_classes/lb', label: 'GET /service_classes/lb（ロードバランサプラン）' },
  // maxItems は**仕様どおり必須**（OpenAPI v1.4.0 原本で required:true・min5/max30/default20 を確認）。
  // 付け忘れると 400: operation ListClusters: … query parameter "maxItems" not set
  // ⚠️ 一時「ドキュメントは任意と書いている」と誤記したが、それは**ページ要約の読み違い**だった
  //   （2026-09-07・原本を見て訂正）。一覧系は8本すべて maxItems 必須で、最小値は
  //   エンドポイントごとに 1／2／5 と違う。20 なら全部の範囲に収まる。
  { key: 'clusters', base: BASE, path: 'clusters?maxItems=20', label: 'GET /clusters?maxItems=20（既存クラスタ）' },
  // ④ 省力化の可否（IAM API・別ベースURL）。読み取りのみ。
  { key: 'iamProjects', base: IAM_BASE, path: 'projects', label: 'GET /projects（IAM: プロジェクト一覧）' },
  { key: 'iamSps', base: IAM_BASE, path: 'service-principals', label: 'GET /service-principals（IAM: サービスプリンシパル一覧）' },
]

const isDryRun = process.argv.slice(2).includes('--dry-run')

function line(s = '') { console.log(s) }
function head(s) { line(); line('─'.repeat(70)); line(s); line('─'.repeat(70)) }

// ── --dry-run: ネットワークもキーも使わず、組み立てだけを確認する ─────────
if (isDryRun) {
  head('--dry-run: 組み立てる内容の確認（ネットワーク未使用・キー不要）')
  line()
  line('組み立てる URL:')
  for (const e of ENDPOINTS) line(`  GET ${e.base}${e.path}`)
  line()
  line('認証ヘッダの形（値は伏せ字。実際の中身は絶対に出力しません）:')
  line('  Authorization: Basic base64(<アクセストークン>:<アクセストークンシークレット>)')
  line()
  line('出力の書式（実行時にはこの順で表示されます）:')
  line('  1. 制限値の表（GET /limits の各項目をキー/値で列挙）')
  line('  2. ワーカプランの一覧（name と path。項目名が想定と違えば生データも添える）')
  line('  3. ロードバランサプランの一覧（同上）')
  line('  4. 既存クラスタの件数のみ（名前・IDは出しません）')
  line('  5. IAM API が通常のAPIキーで読めるか（省力化の可否。件数のみ・名前/IDは出しません）')
  line('  6. 末尾に JSON（秘密情報・クラスタ名/IDを含みません）')
  line()
  line('（実際に叩くには SAKURA_CLOUD_TOKEN と SAKURA_CLOUD_SECRET を指定してください）')
  process.exit(0)
}

const TOKEN = process.env.SAKURA_CLOUD_TOKEN
const SECRET = process.env.SAKURA_CLOUD_SECRET

if (!TOKEN || !SECRET) {
  console.error('使い方:')
  console.error('  SAKURA_CLOUD_TOKEN=<アクセストークン> SAKURA_CLOUD_SECRET=<アクセストークンシークレット> \\')
  console.error('    node scripts/probe-apprun-dedicated.mjs')
  console.error()
  console.error('  ネットワークを使わず組み立てだけ確認する場合（キー不要）:')
  console.error('    node scripts/probe-apprun-dedicated.mjs --dry-run')
  process.exit(2)
}

const authHeader = 'Basic ' + Buffer.from(`${TOKEN}:${SECRET}`, 'utf-8').toString('base64')

async function apiGet(pathStr, base = BASE) {
  const url = base + pathStr
  const t0 = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', headers: { Authorization: authHeader } })
    const ms = Date.now() - t0
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* JSONでなければ生のまま扱う */ }
    return { status: res.status, ok: res.ok, ms, body, text }
  } catch (e) {
    return { status: null, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) }
  }
}

/**
 * 失敗した応答の中身を、そのまま見せる（2026-09-07 の実測で必要になった）。
 *
 * ── なぜ（掟10「確かめられないときは生の応答をメッセージに載せる」）─────────
 * 初版は !ok のときステータスの説明しか出さず、**GET /clusters が 400 を返した理由が
 * 分からないまま**だった。エラー本文には原因が書かれていることが多い。
 * 秘密情報（トークン）はリクエスト側にしか無く、エラー本文には出ない。長すぎる場合だけ切る。
 */
function showErrorBody(r) {
  const raw = (r.text ?? '').trim()
  if (!raw) return
  line('  応答の中身（原因の手がかり）:')
  const shown = raw.length > 500 ? raw.slice(0, 500) + ' …（以下略）' : raw
  for (const l of shown.split('\n')) line('    ' + l)
}

/** ステータスから、分かる範囲での日本語の説明を返す（推測で「成功」に見せない）。 */
function explainStatus(status) {
  if (status === 401 || status === 403) return 'キーが無効か、権限が足りません（IAMロールの確認を）'
  if (status === 404) return 'このエンドポイントは提供されていない可能性があります'
  return null
}

/** オブジェクトを dot 記法でキー/値に平らにする（応答の形を推測せず、そのまま列挙するため）。 */
function flatten(obj, prefix = '') {
  const rows = []
  if (obj === null || obj === undefined) return rows
  if (typeof obj !== 'object') {
    rows.push([prefix || '(値)', String(obj)])
    return rows
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => rows.push(...flatten(v, prefix ? `${prefix}[${i}]` : `[${i}]`)))
    return rows
  }
  for (const [k, v] of Object.entries(obj)) {
    rows.push(...flatten(v, prefix ? `${prefix}.${k}` : k))
  }
  return rows
}

function printTable(rows) {
  if (!rows.length) { line('  （項目なし）'); return }
  const w = Math.min(48, Math.max(...rows.map(([k]) => k.length)))
  for (const [k, v] of rows) line(`  ${String(k).padEnd(w)} : ${v}`)
}

/** 応答からリストらしきものを取り出す（項目名を決め打ちせず、よくある置き場所を順に見る）。 */
function unwrapList(body) {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') {
    for (const k of ['data', 'service_classes', 'plans', 'worker', 'lb', 'items', 'clusters', 'workerServiceClasses', 'lbServiceClasses']) {
      if (Array.isArray(body[k])) return body[k]
    }
  }
  return null
}

function extractNamePath(item) {
  const name = item?.name ?? item?.Name ?? item?.plan_name ?? null
  const path = item?.path ?? item?.Path ?? item?.id ?? item?.Id ?? null
  return { name, path }
}

const results = {}

// ── ① /limits ────────────────────────────────────────────────────────
head(ENDPOINTS[0].label)
{
  const r = await apiGet(ENDPOINTS[0].path)
  results.limits = r
  line(`HTTP ${r.status ?? '(通信失敗)'}（${r.ms}ms）`)
  if (r.error) { line(`  ❌ ${r.error}`); }
  else if (!r.ok) {
    const note = explainStatus(r.status)
    line(note ? `  ⚠️ ${note}` : '  ⚠️ 想定外の応答です')
    line(`  生の応答: ${r.text.slice(0, 300)}`)
  } else if (r.body === null) {
    line('  ⚠️ JSON として解釈できませんでした。生の応答:')
    line(`  ${r.text.slice(0, 300)}`)
  } else {
    line()
    line('制限値:')
    printTable(flatten(r.body))
  }
}

// ── ②-a /service_classes/worker ─────────────────────────────────────
head(ENDPOINTS[1].label)
{
  const r = await apiGet(ENDPOINTS[1].path)
  results.worker = r
  line(`HTTP ${r.status ?? '(通信失敗)'}（${r.ms}ms）`)
  if (r.error) { line(`  ❌ ${r.error}`) }
  else if (!r.ok) {
    const note = explainStatus(r.status)
    line(note ? `  ⚠️ ${note}` : '  ⚠️ 想定外の応答です')
    line(`  生の応答: ${r.text.slice(0, 300)}`)
  } else {
    const list = unwrapList(r.body)
    if (list === null) {
      line('  ⚠️ 一覧の置き場所が想定と違います。生の応答をそのまま出します:')
      line(`  ${JSON.stringify(r.body, null, 1).slice(0, 1200)}`)
    } else {
      line(`件数: ${list.length}`)
      for (const item of list) {
        const { name, path } = extractNamePath(item)
        if (name !== null || path !== null) {
          line(`  name: ${name ?? '(不明)'}  /  path: ${path ?? '(不明)'}`)
        } else {
          line(`  ⚠️ name/path が見つからないため生データ: ${JSON.stringify(item).slice(0, 200)}`)
        }
      }
    }
  }
}

// ── ②-b /service_classes/lb ─────────────────────────────────────────
head(ENDPOINTS[2].label)
{
  const r = await apiGet(ENDPOINTS[2].path)
  results.lb = r
  line(`HTTP ${r.status ?? '(通信失敗)'}（${r.ms}ms）`)
  if (r.error) { line(`  ❌ ${r.error}`) }
  else if (!r.ok) {
    const note = explainStatus(r.status)
    line(note ? `  ⚠️ ${note}` : '  ⚠️ 想定外の応答です')
    line(`  生の応答: ${r.text.slice(0, 300)}`)
  } else {
    const list = unwrapList(r.body)
    if (list === null) {
      line('  ⚠️ 一覧の置き場所が想定と違います。生の応答をそのまま出します:')
      line(`  ${JSON.stringify(r.body, null, 1).slice(0, 1200)}`)
    } else {
      line(`件数: ${list.length}`)
      for (const item of list) {
        const { name, path } = extractNamePath(item)
        if (name !== null || path !== null) {
          line(`  name: ${name ?? '(不明)'}  /  path: ${path ?? '(不明)'}`)
        } else {
          line(`  ⚠️ name/path が見つからないため生データ: ${JSON.stringify(item).slice(0, 200)}`)
        }
      }
    }
  }
}

// ── ③ /clusters（名前・IDは出さない。件数のみ）──────────────────────────
head(ENDPOINTS[3].label)
{
  const r = await apiGet(ENDPOINTS[3].path)
  // 生の応答（クラスタ名/IDを含みうる）は results に残さない。件数だけ記録する。
  line(`HTTP ${r.status ?? '(通信失敗)'}（${r.ms}ms）`)
  if (r.error) {
    line(`  ❌ ${r.error}`)
    results.clusters = { status: r.status, ok: false, ms: r.ms, error: r.error }
  } else if (!r.ok) {
    const note = explainStatus(r.status)
    line(note ? `  ⚠️ ${note}` : '  ⚠️ 想定外の応答です')
    showErrorBody(r)
    results.clusters = { status: r.status, ok: false, ms: r.ms, body: r.text ? String(r.text).slice(0, 500) : undefined }
    // 400 のときは、ページングのパラメータを明示して**もう一度だけ**試す。
    // ドキュメントでは maxItems は任意（既定20）だが、実装が要求している可能性がある
    // （2026-09-07 実測で 400 が返り、原因が特定できなかったため）。GET なので安全。
    if (r.status === 400) {
      line('  → maxItems を明示して、もう一度だけ試します（GET のみ）')
      const r2 = await apiGet(ENDPOINTS[3].path + '?maxItems=20')
      line(`  HTTP ${r2.status ?? '(通信失敗)'}（${r2.ms}ms・maxItems=20 付き）`)
      if (r2.ok) {
        const list2 = unwrapList(r2.body)
        line(`  ✅ パラメータを付けると読めました（件数: ${list2 === null ? '不明' : list2.length}）`)
        results.clustersWithParams = { status: r2.status, ok: true, ms: r2.ms, count: list2 === null ? null : list2.length }
      } else {
        showErrorBody(r2)
        results.clustersWithParams = { status: r2.status, ok: false, ms: r2.ms, body: r2.text ? String(r2.text).slice(0, 500) : undefined }
      }
    }
  } else {
    const list = unwrapList(r.body)
    if (list === null) {
      line('  ⚠️ 一覧の置き場所が想定と違うため件数を特定できません（名前/IDは出しません）')
      results.clusters = { status: r.status, ok: true, ms: r.ms, count: null }
    } else {
      line(`件数: ${list.length}${list.length > 0 ? '（1件以上あります）' : ''}`)
      results.clusters = { status: r.status, ok: true, ms: r.ms, count: list.length }
    }
  }
}

// ── ④ IAM API（省力化の可否・別ベースURL）────────────────────────────
// ここが通常のAPIキーで通れば、サービスプリンシパルの用意まで Koto から自動化できる。
// 通らなければ「コンパネで一度だけ作ってもらう」導線が要る。**推測せず、結果をそのまま出す。**
// 名前・IDは出さない（クラスタと同じ扱い）。件数と、判定に必要なことだけ。
for (const key of ['iamProjects', 'iamSps']) {
  const e = ENDPOINTS.find(x => x.key === key)
  head(e.label)
  const r = await apiGet(e.path, e.base)
  line(`HTTP ${r.status ?? '(通信失敗)'}（${r.ms}ms）`)
  if (r.error) {
    line(`  ❌ ${r.error}`)
    results[key] = { status: r.status, ok: false, ms: r.ms, error: r.error }
  } else if (!r.ok) {
    const note = explainStatus(r.status)
    line(note ? `  ⚠️ ${note}` : '  ⚠️ 想定外の応答です')
    showErrorBody(r)
    line('  → このAPIは通常のAPIキーでは使えない可能性が高い（手動の用意が必要）')
    results[key] = { status: r.status, ok: false, ms: r.ms }
  } else {
    const list = unwrapList(r.body)
    line(list === null ? '  一覧の置き場所は想定と違いますが、応答は返りました' : `件数: ${list.length}`)
    line('  ✅ 通常のAPIキーで読めました（自動化できる可能性があります）')
    results[key] = { status: r.status, ok: true, ms: r.ms, count: list === null ? null : list.length }
  }
}

// ── まとめ（JSON。秘密情報とクラスタ名/IDは含めない）─────────────────────
head('まとめ')
line('この JSON をそのまま共有してもらえれば、本実装の要否・項目名を判断します。')
line('（アクセストークン・シークレット・クラスタの名前や ID は含まれません）')
line()

const summary = {
  baseUrl: BASE,
  iamBaseUrl: IAM_BASE,
  // ④ 省力化の可否: 通常のAPIキーで IAM API を読めたか（名前・IDは含めない）
  iam: {
    projects: results.iamProjects ?? null,
    servicePrincipals: results.iamSps ?? null,
  },
  clustersWithParams: results.clustersWithParams ?? null,
  limits: results.limits.error
    ? { status: results.limits.status, ok: false, ms: results.limits.ms, error: results.limits.error }
    : { status: results.limits.status, ok: results.limits.ok, ms: results.limits.ms, body: results.limits.ok ? results.limits.body : undefined },
  serviceClasses: {
    worker: results.worker.error
      ? { status: results.worker.status, ok: false, ms: results.worker.ms, error: results.worker.error }
      : { status: results.worker.status, ok: results.worker.ok, ms: results.worker.ms, body: results.worker.ok ? results.worker.body : undefined },
    lb: results.lb.error
      ? { status: results.lb.status, ok: false, ms: results.lb.ms, error: results.lb.error }
      : { status: results.lb.status, ok: results.lb.ok, ms: results.lb.ms, body: results.lb.ok ? results.lb.body : undefined },
  },
  clusters: results.clusters, // 件数のみ（上で組み立て済み。名前/IDは含まない）
}

console.log(JSON.stringify(summary, null, 2))
