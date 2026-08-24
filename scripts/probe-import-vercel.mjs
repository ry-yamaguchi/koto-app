#!/usr/bin/env node
// probe-import-vercel.mjs — Vercel で公開済みのものを「引き取れる」かを実測する。
//
// ── なぜ要るか（2026-08-22 Ryosuke 提案・dev-plan ④）─────────────────────
// PC の消失・プロジェクトの引き継ぎ・引っ越しでは、**手元にファイルが無い**。
// 公開されたものから中身を取り戻せれば、新規プロジェクトとして受け入れられる。
//
// 公式リファレンス（2026-08-22 取得）で分かっているのはここまで:
//   ・GET /v6/deployments/{id}/files … 「**CLI か、API に files キーを渡して作った**
//     デプロイなら、取得可能なファイルツリーを持つ」と明記。404 File tree not found あり
//   ・GET /v8/deployments/{id}/files/{fileId} … 中身を **base64** で返す
//     （query の path は「**Git デプロイのときだけ**」）
//   ・GET /v13/deployments/{id}?withGitRepoInfo=true … **gitSource**（リポジトリ・
//     ブランチ・コミットSHA）が返る
//   ・応答の source フィールドは「推測にすぎず権威ある値ではない。
//     **これを使って動作を分岐させるな**」と明記 → 判定には使わない
//
// **分かっていない＝これで測ること**:
//   ① Koto が公開したデプロイで、ファイルツリーが実際に返るか（形は？）
//   ② 中身（base64）を復元したものが原本と一致するか
//   ③ Git 連携のデプロイでは何が返るか（404 か、別の形か）
//   ④ gitSource の有無で Git 由来を判定できるか
//   ⑤ ファイル数・合計サイズ・所要時間（画面の待ち時間の設計に要る）
//
// 応答の形は推測しない（掟1）。生の応答をそのまま出す。
//
// ── 使い方 ────────────────────────────────────────────────────────────
//   VERCEL_TOKEN=... node scripts/probe-import-vercel.mjs
//   VERCEL_TOKEN=... VERCEL_TEAM_ID=... node scripts/probe-import-vercel.mjs
//
// トークンは Vercel のアカウント設定 → Tokens。Koto の「認証情報」に登録している
// ものと同じで構わない。**読み取りしか行わない**（作成・削除・デプロイはしない）。
//
// ⚠️ このスクリプトはトークンを画面に出さない。**出力**を貼るのは安全。
// ⚠️ ただし**実行したコマンドそのものを貼らないこと**（`VERCEL_TOKEN=...` に実物が入る）。
//    貼るのは区切り線から下の出力だけでよい。

const BASE = 'https://api.vercel.com'
const TOKEN = process.env.VERCEL_TOKEN
const TEAM = process.env.VERCEL_TEAM_ID || ''

if (!TOKEN) {
  console.error('VERCEL_TOKEN が要ります。使い方: VERCEL_TOKEN=... node scripts/probe-import-vercel.mjs')
  process.exit(1)
}

async function api(path, { raw = false } = {}) {
  const t0 = Date.now()
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const ms = Date.now() - t0
  const text = await res.text()
  let body = text
  if (!raw) { try { body = JSON.parse(text) } catch { /* JSONでなければ生のまま */ } }
  return { status: res.status, ms, body, text }
}

function line(s = '') { console.log(s) }
function head(s) { line(); line('━'.repeat(64)); line(s); line('━'.repeat(64)) }

// ── ⓪ 誰として見えているか（2026-08-22: 0件だった原因を切り分けるために追加）──
// 「HTTP 200・0件」は API の失敗ではないので、**個人とチームのどちらを見ているか**を
// 先に確かめる。チーム所属のトークンは teamId を付けないと個人分しか見えない。
head('⓪ このトークンは誰として見えているか')
const me = await api('/v2/user')
line(`GET /v2/user: HTTP ${me.status}（${me.ms}ms）`)
if (me.status === 200) {
  const u = me.body?.user ?? me.body
  line(`  ユーザー: ${u?.username ?? u?.name ?? '(不明)'} / uid=${u?.id ?? u?.uid ?? '?'}`)
} else {
  line(`  生の応答: ${me.text.slice(0, 300)}`)
  if (me.status === 401 || me.status === 403) {
    line('  ⚠️ トークンが受け付けられていません。**範囲（スコープ）が狭い**か、削除済み・期限切れの可能性があります。')
  }
}

const teams = await api('/v2/teams')
line(`GET /v2/teams: HTTP ${teams.status}（${teams.ms}ms）`)
const teamList = teams.status === 200 ? (teams.body?.teams ?? []) : []
line(`  所属チーム: ${teamList.length}件`)
for (const tm of teamList) line(`    - ${tm.name ?? tm.slug ?? '?'}（id=${tm.id}）`)

// ── ① デプロイの一覧（引き取り候補の見せ方を決める材料）────────────────
// 個人 → 各チームの順に探し、**最初に見つかったところ**を対象にする。
head('① デプロイの一覧: GET /v6/deployments')
const scopes = [
  { label: '個人アカウント', teamId: TEAM || '' },
  ...(TEAM ? [] : teamList.map(tm => ({ label: `チーム ${tm.name ?? tm.slug}`, teamId: tm.id }))),
]

let deployments = []
let foundScope = null
let anyOk = me.status === 200 // ⓪で本人確認が通っていれば、トークン自体は受理されている
for (const sc of scopes) {
  const suffix = sc.teamId ? `&teamId=${encodeURIComponent(sc.teamId)}` : ''
  const r = await api(`/v6/deployments?limit=20${suffix}`)
  const n = (r.body?.deployments ?? []).length
  line(`${sc.label}: HTTP ${r.status}（${r.ms}ms）… ${n}件`)
  if (r.status !== 200) { line(`  生の応答: ${r.text.slice(0, 300)}`) }
  else anyOk = true
  if (n > 0 && !foundScope) { deployments = r.body.deployments; foundScope = sc }
}

// ── 「0件」と「そもそも拒否された」を混ぜない（2026-08-22 実測でこのバグが出た）──
// 403 が返っているのに「HTTP 200 が返っています」と書いており、**原因の切り分けを誤らせた**。
// 結論は、実際に受け取った status から書く。
if (!anyOk) {
  head('結論: トークンが受け付けられていません（デプロイの有無以前の問題）')
  line('すべての問い合わせが拒否されました（401 / 403）。次のどれかです:')
  line('  ・トークンの**範囲（スコープ）が狭い**。特定のプロジェクトだけに絞ると、')
  line('    アカウント情報（/v2/user）やデプロイ一覧を読めないことがあります')
  line('    → 作り直すときは **Full Account**（アカウント全体）を選ぶ')
  line('  ・トークンが削除・期限切れになっている')
  line('  ・貼り付けが途中で切れている（前後の空白・改行が混ざった）')
  line()
  line('→ vercel.com/account/tokens で作り直してから、もう一度実行してください。')
  process.exit(0)
}

if (!foundScope) {
  head('結論: 引き取れるデプロイが1件も見つかりませんでした')
  line('問い合わせ自体は通っています（トークンは有効）。次のどれかです:')
  line('  ・このトークンから見える範囲に、Vercel のデプロイがまだ無い')
  line('  ・別のチームに属している（上の「所属チーム」を確認）')
  line('  ・過去のデプロイが削除されている')
  line()
  line('→ 測るには、Koto から landingTEST を **1度 Vercel へ公開**してから、')
  line('   このスクリプトを実行し直してください（Hobby プランなら無料の範囲です）。')
  process.exit(0)
}

line()
line(`→ ${foundScope.label} のデプロイを対象にします`)
// 以降の個別取得でも同じ範囲を見る
const SCOPE = foundScope.teamId
line(`件数: ${deployments.length}`)
line()
line('一覧に出せそうな項目（先頭10件）:')
for (const d of deployments.slice(0, 10)) {
  const when = d.created ? new Date(d.created).toLocaleString('ja-JP') : '?'
  line(`  - ${d.name ?? '(名前なし)'} / ${d.url ?? '?'} / ${when} / state=${d.state ?? d.readyState ?? '?'} / uid=${d.uid ?? d.id ?? '?'}`)
}
line()
line('1件目の生の応答（項目名を確かめる）:')
line(JSON.stringify(deployments[0] ?? {}, null, 1).slice(0, 1200))

// ── ② 1件ずつ「引き取れるか」を確かめる ────────────────────────────────
const targets = deployments.slice(0, 5)
for (const d of targets) {
  const id = d.uid ?? d.id
  if (!id) continue
  head(`② ${d.name ?? ''} / ${d.url ?? ''}（${id}）`)

  // Git 由来かどうか（判定は gitSource の有無で行う。source フィールドは使わない）
  const detail = await api(`/v13/deployments/${encodeURIComponent(id)}?withGitRepoInfo=true${SCOPE ? '&teamId=' + encodeURIComponent(SCOPE) : ''}`)
  const gs = detail.body?.gitSource
  line(`詳細: HTTP ${detail.status}（${detail.ms}ms）`)
  line(`  gitSource: ${gs ? JSON.stringify(gs) : '（なし）'}`)
  line(`  source（参考・判定には使わない）: ${detail.body?.source ?? '(なし)'}`)
  line(`  → 判定: ${gs ? 'Git 由来（GitHub 等から取るべき）' : 'ファイル直接アップロード（Vercel から取れるはず）'}`)

  // ファイルツリー
  const tree = await api(`/v6/deployments/${encodeURIComponent(id)}/files${SCOPE ? '?teamId=' + encodeURIComponent(SCOPE) : ''}`)
  line(`ファイルツリー: HTTP ${tree.status}（${tree.ms}ms）`)
  if (tree.status !== 200) {
    line(`  生の応答: ${tree.text.slice(0, 300)}`)
    line('  → このデプロイからは中身を取れない（想定どおりかを確認する）')
    continue
  }

  // 平坦化して数える
  const files = []
  const walk = (nodes, prefix) => {
    for (const n of nodes ?? []) {
      const p = prefix ? `${prefix}/${n.name}` : n.name
      if (n.type === 'directory') walk(n.children, p)
      else files.push({ path: p, uid: n.uid, type: n.type, contentType: n.contentType })
    }
  }
  walk(Array.isArray(tree.body) ? tree.body : tree.body?.files, '')
  line(`  ファイル数: ${files.length}`)
  line(`  種類の内訳: ${JSON.stringify(files.reduce((a, f) => { a[f.type] = (a[f.type] ?? 0) + 1; return a }, {}))}`)
  line('  先頭10件:')
  for (const f of files.slice(0, 10)) line(`    ${f.path}  (${f.type}, uid=${f.uid ? 'あり' : 'なし'})`)
  line()
  line('  ツリーの生の応答（先頭）:')
  line('  ' + JSON.stringify(Array.isArray(tree.body) ? tree.body[0] : tree.body, null, 1).slice(0, 600).replace(/\n/g, '\n  '))

  // 中身を1つ取ってみる（テキストらしいものを選ぶ）
  const one = files.find(f => f.uid && /\.(html?|css|js|json|txt|md)$/i.test(f.path)) ?? files.find(f => f.uid)
  if (!one) { line('  → uid を持つファイルが無い（取得を試せない）'); continue }
  const t0 = Date.now()
  const content = await api(`/v8/deployments/${encodeURIComponent(id)}/files/${encodeURIComponent(one.uid)}${SCOPE ? '?teamId=' + encodeURIComponent(SCOPE) : ''}`)
  line()
  line(`  中身の取得（${one.path}）: HTTP ${content.status}（${Date.now() - t0}ms）`)
  if (content.status === 200) {
    const b = content.body
    const raw = typeof b === 'string' ? b : (b?.data ?? b?.content ?? '')
    let decoded = ''
    try { decoded = Buffer.from(raw, 'base64').toString('utf-8') } catch { /* base64 でないかも */ }
    line(`    応答の形: ${typeof b === 'string' ? '文字列' : 'オブジェクト（キー: ' + Object.keys(b ?? {}).join(', ') + '）'}`)
    line(`    base64 として読めたか: ${decoded && /[\x20-\x7e]/.test(decoded) ? 'はい' : 'いいえ（生のまま?）'}`)
    line(`    先頭200文字:`)
    line('    ' + (decoded || String(raw)).slice(0, 200).replace(/\n/g, '\n    '))
  } else {
    line(`    生の応答: ${content.text.slice(0, 300)}`)
  }

  // 全部取るとどれくらいかかるか（小さいものだけ実測して見積もる）
  if (files.length && files.every(f => f.uid)) {
    const sample = files.slice(0, Math.min(5, files.length))
    const s0 = Date.now()
    let bytes = 0
    for (const f of sample) {
      const r = await api(`/v8/deployments/${encodeURIComponent(id)}/files/${encodeURIComponent(f.uid)}${SCOPE ? '?teamId=' + encodeURIComponent(SCOPE) : ''}`)
      bytes += r.text.length
    }
    const per = (Date.now() - s0) / sample.length
    line()
    line(`  ⑤ 見積もり: 1ファイルあたり約 ${Math.round(per)}ms → ${files.length}件で約 ${Math.round(per * files.length / 1000)}秒`)
    line(`     （標本 ${sample.length}件の応答サイズ合計 ${bytes} バイト）`)
  }
}

head('まとめ')
line('この出力をそのまま Koto の開発チャットへ貼ってください。')
line('（トークンは出力に含まれません）')
