#!/usr/bin/env node
// probe-import-apprun.mjs — AppRun で公開済みのものを「引き取れる」かを実測する。
//
// ── なぜ要るか（2026-08-22 Ryosuke 提案・dev-plan ④）─────────────────────
// PC の消失・プロジェクトの引き継ぎ・引っ越しでは、**手元にファイルが無い**。
// AppRun にあるのはコンテナイメージなので、そこから中身を取り出せるかを確かめる。
//
// 分かっているのはここまで:
//   ・アプリ一覧は GET /applications（client.ts の listApps と同じ）
//   ・認証は Basic（さくらのクラウド APIキー: token:secret）
//   ・**IDE 同梱の crane に `export`（イメージの中身を tar で取り出す）がある**
//     （`build/bin/crane --help` で確認済み・2026-08-22）
//
// **分かっていない＝これで測ること**:
//   ① アプリの詳細に**イメージ参照（レジストリ／リポジトリ／タグ）が入るか**
//      → 入らなければ `crane ls` でレジストリ側から辿ることになる
//   ② crane で認証して、そのイメージの中身を取り出せるか
//   ③ 取り出した中身から**公開物だけ**を選べるか（/usr/share/nginx/html 等）
//
// 応答の形は推測しない（掟1）。生の応答をそのまま出す。
//
// ── 使い方 ────────────────────────────────────────────────────────────
//   SAKURA_TOKEN=... SAKURA_SECRET=... node scripts/probe-import-apprun.mjs
//
//   ②③まで試すときは、レジストリの資格情報も渡す（Koto の「認証情報」と同じもの）:
//   SAKURA_TOKEN=... SAKURA_SECRET=... \
//   REGISTRY_NAME=... REGISTRY_USER=... REGISTRY_PASSWORD=... \
//     node scripts/probe-import-apprun.mjs
//
// **読み取りしか行わない**（アプリの作成・削除・デプロイはしない）。
// ⚠️ 資格情報は画面に出さない。**出力**を貼るのは安全。
// ⚠️ ただし**実行したコマンドそのものを貼らないこと**（環境変数に実物が入る）。
//    貼るのは区切り線から下の出力だけでよい。

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const API_BASE = 'https://secure.sakura.ad.jp/cloud/api/apprun/1.0/apprun/api/'
const TOKEN = process.env.SAKURA_TOKEN
const SECRET = process.env.SAKURA_SECRET
const REG = { name: process.env.REGISTRY_NAME, user: process.env.REGISTRY_USER, password: process.env.REGISTRY_PASSWORD }

if (!TOKEN || !SECRET) {
  console.error('SAKURA_TOKEN と SAKURA_SECRET が要ります。使い方はファイル冒頭のコメントを見てください。')
  process.exit(1)
}

const CRANE = path.join(process.cwd(), 'build/bin/crane')
const hasCrane = fs.existsSync(CRANE)

function line(s = '') { console.log(s) }
function head(s) { line(); line('━'.repeat(64)); line(s); line('━'.repeat(64)) }

async function api(p) {
  const t0 = Date.now()
  const res = await fetch(API_BASE.replace(/\/$/, '') + p, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${TOKEN}:${SECRET}`, 'utf-8').toString('base64') },
  })
  const text = await res.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* JSONでなければ生のまま */ }
  return { status: res.status, ms: Date.now() - t0, body, text }
}

// ── ① アプリ一覧と、その詳細にイメージ参照が入るか ─────────────────────
head('① アプリの一覧: GET /applications')
const list = await api('/applications')
line(`HTTP ${list.status}（${list.ms}ms）`)
if (list.status !== 200) { line('生の応答:'); line(list.text.slice(0, 800)); process.exit(1) }

const apps = list.body?.data ?? list.body?.applications ?? (Array.isArray(list.body) ? list.body : [])
line(`件数: ${apps.length}`)
line()
line('一覧の生の応答（1件目・項目名を確かめる）:')
line(JSON.stringify(apps[0] ?? list.body, null, 1).slice(0, 1200))

let imageRef = null
for (const app of apps.slice(0, 3)) {
  const id = app.id ?? app.uid
  if (!id) continue
  head(`① 詳細: ${app.name ?? ''}（${id}）`)
  const d = await api(`/applications/${encodeURIComponent(id)}`)
  line(`HTTP ${d.status}（${d.ms}ms）`)
  if (d.status !== 200) { line(d.text.slice(0, 400)); continue }
  line('生の応答:')
  line(JSON.stringify(d.body, null, 1).slice(0, 2000))

  // イメージ参照を探す（項目名は推測しない。見つけた場所をそのまま報告する）
  const found = []
  const walk = (o, at) => {
    if (!o || typeof o !== 'object') return
    for (const [k, v] of Object.entries(o)) {
      const p2 = at ? `${at}.${k}` : k
      if (typeof v === 'string' && /sakuracr\.jp|:latest|:v?\d|@sha256:/.test(v) && /image|registry|repo|tag|container/i.test(p2 + k)) found.push([p2, v])
      else if (typeof v === 'string' && /sakuracr\.jp/.test(v)) found.push([p2, v])
      else walk(v, p2)
    }
  }
  walk(d.body, '')
  line()
  line(`→ イメージ参照らしきもの: ${found.length ? '' : '（見つからない）'}`)
  for (const [k, v] of found) line(`   ${k} = ${v}`)
  if (!imageRef && found.length) imageRef = found[0][1]
}

// ── ②③ crane で中身を取り出せるか ────────────────────────────────────
head('②③ イメージの中身を取り出す（crane export）')
if (!hasCrane) {
  line(`⚠️ crane が見つかりません（${CRANE}）。npm run build 済みのリポジトリ直下で実行してください。`)
} else if (!REG.name || !REG.user || !REG.password) {
  line('⚠️ レジストリの資格情報が未指定のため、ここは試していません。')
  line('   REGISTRY_NAME / REGISTRY_USER / REGISTRY_PASSWORD を付けて再実行すると、②③まで測れます。')
} else {
  const server = `${REG.name}.sakuracr.jp`
  try {
    execFileSync(CRANE, ['auth', 'login', server, '-u', REG.user, '-p', REG.password], { stdio: 'pipe' })
    line(`✅ crane auth login 成功（${server}）`)
  } catch (e) {
    line(`❌ crane auth login 失敗: ${String(e.stderr ?? e).slice(0, 300)}`)
  }

  // レジストリにあるリポジトリとタグを見る（①でイメージ参照が取れなくても辿れるか）
  try {
    const repos = execFileSync(CRANE, ['catalog', server], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
    line(`✅ crane catalog: ${repos.length} 件`)
    for (const r of repos.slice(0, 10)) {
      let tags = []
      try { tags = execFileSync(CRANE, ['ls', `${server}/${r}`], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean) } catch { /* 取れなければ空 */ }
      line(`   ${r}  タグ: ${tags.slice(0, 5).join(', ')}${tags.length > 5 ? ` …ほか${tags.length - 5}件` : ''}`)
      if (!imageRef && tags.length) imageRef = `${server}/${r}:${tags[tags.length - 1]}`
    }
  } catch (e) {
    line(`❌ crane catalog 失敗: ${String(e.stderr ?? e).slice(0, 300)}`)
  }

  if (!imageRef) {
    line('→ 取り出せるイメージが特定できませんでした。')
  } else {
    line()
    line(`対象イメージ: ${imageRef}`)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-import-'))
    const tar = path.join(tmp, 'fs.tar')
    try {
      const t0 = Date.now()
      execFileSync(CRANE, ['export', imageRef, tar], { stdio: 'pipe' })
      const size = fs.statSync(tar).size
      line(`✅ crane export 成功（${Math.round((Date.now() - t0) / 1000)}秒 / ${(size / 1024 / 1024).toFixed(1)} MB）`)

      // 中身の一覧（公開物がどこに入っているかを見る）
      const names = execFileSync('tar', ['-tf', tar], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean)
      line(`   ファイル数: ${names.length}`)
      const interesting = names.filter(n => /^(usr\/share\/nginx\/html|app|srv|var\/www)\//.test(n))
      line(`   公開物らしき場所のファイル: ${interesting.length}`)
      for (const n of interesting.slice(0, 20)) line(`     ${n}`)
      if (!interesting.length) {
        line('   （見つからないので、上位の階層を出します）')
        const tops = [...new Set(names.map(n => n.split('/')[0]))].slice(0, 20)
        line(`     上位: ${tops.join(', ')}`)
      }
    } catch (e) {
      line(`❌ crane export 失敗: ${String(e.stderr ?? e).slice(0, 400)}`)
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 片づけ失敗は無視 */ }
      line('（一時ファイルは片づけました）')
    }
  }
}

head('まとめ')
line('この出力をそのまま Koto の開発チャットへ貼ってください。')
line('（トークン・パスワードは出力に含まれません）')
