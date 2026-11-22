#!/usr/bin/env node
/*
 * 「AI の確認」の返事の形の確かめ: さくらのAI Engine のモデルに、見本のファイルを読ませ、
 * 返事から指摘の JSON を取り出して検証できるかを実測する。
 *
 * 使い方（キーは端末の中だけ。チャットに貼らない。出力にも出さない）:
 *   node scripts/probe-seccheck-json.mjs [モデル名の一部…]
 *     → 「キーを貼り付けて Return」と聞かれるので、さくらのAI Engine のキーを貼る（文字は表示されない）。
 *   環境変数 SAKURA_API_KEY があれば、聞かずにそれを使う。
 *   モデルを指定しなければ、src/shared/modelInfo.ts の DEFAULT_MODEL の1つだけ。
 *   通信せずに依頼文だけ確かめる:  node scripts/probe-seccheck-json.mjs --dry-run
 *
 * 1モデルにつき1回の要求（max_tokens 4096・temperature 0.2）を送る。AI の利用量を少し使う。
 *
 * 依頼文の組み立てと返事の検証は、src の実物のコードを呼ぶ（esbuild で1つにまとめて読み込む）。
 * 送るのはこの道具の中にある見本のファイルだけで、利用者のプロジェクトは読まない。
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const BASE = 'https://api.ai.sakura.ad.jp/v1'
const MAX_TOKENS = 4096
const TEMPERATURE = 0.2

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const onlyModels = args.filter((a) => !a.startsWith('-'))
const askOnly = args.includes('--ask-only') // キーの受け取りだけを確かめる（通信しない・キーは出さない）

// ── キーの受け取り ─────────────────────────────────────────────────────
// 貼り付けた文字に、キーのあとの説明の文（半角でない文字）や空白が付いていても動くようにする。
// 先頭から、半角の印字できる文字が続く所までをキーとして使い、そこから後ろは使わない。
function cleanKey(raw) {
  const s = String(raw ?? '').replace(/\x1b\[20[01]~/g, '').replace(/^\s+/, '')
  const m = /^[\x21-\x7e]+/.exec(s)
  const key = m ? m[0] : ''
  return { key, dropped: Array.from(s.slice(key.length).trim()).length }
}

// 文字を画面に出さずに1行受け取る。貼り付けに続きの行があっても、あとで端末に流れ込まないよう読み捨てる。
function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let buf = ''
    let done = false
    const finish = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
      resolve(buf)
    }
    const onData = (d) => {
      if (done) return // 1行目のあとの続きは読み捨てる
      for (const ch of d) {
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130) }
        if (ch === '\r' || ch === '\n') { done = true; setTimeout(finish, 300); return }
        if (ch === '\u007f' || ch === '\b') { buf = Array.from(buf).slice(0, -1).join(''); continue }
        buf += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function getKey() {
  let raw = process.env.SAKURA_API_KEY
  if (!raw) {
    if (!process.stdin.isTTY) return ''
    raw = await askHidden('さくらのAI Engine のキーを貼り付けて Return を押してください（文字は表示されません）: ')
  }
  const { key, dropped } = cleanKey(raw)
  if (dropped > 0) {
    console.error(`ℹ️ キーのあとに、半角の英数字・記号でない文字が${dropped}文字付いていたので、そこから後ろは使いませんでした。`)
    console.error('   キーを写すとき、説明の文まで一緒に写っていないかを確かめてください（このまま進めます。キーが違えば HTTP 401 になります）。')
  }
  return key
}

const authKey = dryRun ? '' : await getKey()

// 共有する出力に、キーそのものが混ざらないようにする（相手のエラーの文がキーを写して返す場合の備え）
const noKey = (s) => (authKey ? String(s).split(authKey).join('***') : String(s))

if (!dryRun && !authKey) {
  console.error('APIキーが必要です。  node scripts/probe-seccheck-json.mjs [モデル名の一部…]  を実行し、聞かれたらキーを貼り付けてください（キーはチャットに貼らないこと）')
  console.error('通信せずに依頼文だけ確かめるときは --dry-run を付けます。')
  process.exit(2)
}
if (askOnly) {
  console.log(`キーを受け取りました（${authKey.length}文字。中身は出しません）。--ask-only なので、通信せずに終わります。`)
  process.exit(0)
}

// ── 実物のコードを1つにまとめて読み込む ───────────────────────────────
async function loadCode() {
  const esbuild = require('esbuild')
  const srcDir = fileURLToPath(new URL('../src/shared/', import.meta.url))
  const entry = [
    `export * from './aiCheckPrompt'`,
    `export * from './aiCheckReply'`,
    `export * from './aiCheckFindings'`,
    `export { maskSecretShapes } from './secretShapes'`,
    `export { DEFAULT_MODEL } from './modelInfo'`,
  ].join('\n')
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: srcDir, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  })
  const dir = mkdtempSync(join(tmpdir(), 'seccheck-probe-'))
  const file = join(dir, 'bundle.mjs')
  writeFileSync(file, built.outputFiles[0].text)
  try {
    return await import(pathToFileURL(file).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── 見本のファイル（見本のキーは連結で作る） ───────────────────────────
function sampleFiles(mask) {
  const sampleKey = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const raw = [
    { file: 'server.js', served: false, text: [
      "const http = require('http')",
      "const { exec } = require('child_process')",
      'http.createServer((req, res) => {',
      "  const url = new URL(req.url, 'http://localhost')",
      "  exec('ping -c 1 ' + url.searchParams.get('host'), (err, out) => res.end(out))",
      '}).listen(3000)',
      '',
    ].join('\n') },
    { file: 'public/app.js', served: true, text: [
      "const box = document.getElementById('greeting')",
      'box.innerHTML = location.hash.slice(1)',
      '',
    ].join('\n') },
    { file: 'public/config.js', served: true, text: [
      'window.APP_CONFIG = {',
      "  apiBase: '/api',",
      `  githubToken: '${sampleKey}',`,
      '}',
      '',
    ].join('\n') },
    { file: 'public/index.html', served: true, text: [
      '<!doctype html>',
      '<html><head><meta charset="utf-8"><title>見本</title></head>',
      '<body><h1>こんにちは</h1><div id="greeting"></div>',
      '<script src="app.js"></script></body></html>',
      '',
    ].join('\n') },
  ]
  return raw.map((f) => ({ ...f, text: mask(f.text) }))
}

const CHECKS = [
  { label: 'server.js のコマンド', file: 'server.js', kind: 'input-to-command' },
  { label: 'app.js の HTML', file: 'public/app.js', kind: 'input-to-html' },
  { label: 'config.js の秘密', file: 'public/config.js', kind: 'secret-exposed' },
]

async function chat(model, system, user) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    }),
    signal: AbortSignal.timeout(180000),
  })
  const ms = Date.now() - t0
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { ok: res.ok, status: res.status, ms, json, raw: text }
}

async function listModels() {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${authKey}` } })
  if (!res.ok) throw new Error(`モデル一覧の取得に失敗（HTTP ${res.status}）`)
  const data = await res.json()
  return (data?.data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string')
}

const code = await loadCode()
const files = sampleFiles(code.maskSecretShapes)
const pieces = files.map((f) => ({ file: f.file, part: 1, total: 1, startLine: 1, text: f.text }))
const prompt = code.buildAiCheckPrompt({
  mode: 'node',
  entry: 'server.js',
  split: false,
  secretFiles: [],
  others: ['backup.sql'],
  pieces,
})
const sent = {
  pieces: files.map((f) => ({ file: f.file, startLine: 1, lines: f.text.split('\n'), served: f.served })),
  names: [{ file: 'backup.sql', served: true }],
}

if (dryRun) {
  console.log(`依頼文の長さ: ${prompt.length}字 / system: ${code.AI_CHECK_SYSTEM.length}字`)
  console.log('--- 依頼文の先頭 400字 ---')
  console.log(prompt.slice(0, 400))
  process.exit(0)
}

function head(s, n) { return s.slice(0, n) }
function tail(s, n) { return s.length > n ? s.slice(s.length - n) : s }

async function probe(model) {
  const out = { model, status: null, ms: null, finish: null, usage: null, replyChars: 0, parsed: false, counts: null, expected: {}, notes: [] }
  let r
  try {
    r = await chat(model, code.AI_CHECK_SYSTEM, prompt)
  } catch (e) {
    out.notes.push(`通信に失敗: ${noKey(String(e?.message ?? e).slice(0, 120))}`)
    return { out, reply: '' }
  }
  out.status = r.status
  out.ms = r.ms
  if (!r.ok) {
    out.notes.push(noKey(String(r.json?.error?.message ?? r.raw ?? '').slice(0, 160)))
    return { out, reply: '' }
  }
  const choice = r.json?.choices?.[0]
  out.finish = choice?.finish_reason ?? null
  out.usage = r.json?.usage ?? null
  const msg = choice?.message ?? {}
  const reply = typeof msg.content === 'string' && msg.content.trim() ? msg.content : String(msg.reasoning_content ?? msg.reasoning ?? '')
  out.replyChars = reply.length
  const parsed = code.parseAiReply(reply, sent)
  out.parsed = parsed.state === 'ok'
  if (parsed.state === 'ok') {
    out.counts = {
      findings: parsed.findings.length,
      ai: parsed.findings.filter((f) => f.certainty === 'ai').length,
      unverified: parsed.findings.filter((f) => f.certainty === 'unverified').length,
      malformed: parsed.malformed,
      cut: parsed.cut,
    }
    out.lines = parsed.findings.map((f) => ({ line: code.aiFindingLine(f), note: f.note }))
    for (const c of CHECKS) out.expected[c.label] = parsed.findings.some((f) => f.file === c.file && f.kind === c.kind)
  } else {
    for (const c of CHECKS) out.expected[c.label] = false
  }
  return { out, reply }
}

try {
  let ids
  if (onlyModels.length) {
    ids = (await listModels()).filter((id) => onlyModels.some((m) => id.includes(m)))
  } else {
    ids = [code.DEFAULT_MODEL]
  }
  if (!ids.length) { console.error('対象モデルがありません'); process.exit(1) }

  console.log(`=== AI の確認: 返事の形の確かめ（${ids.length}モデル・各1リクエスト）===\n`)
  const results = []
  for (const id of ids) {
    const { out, reply } = await probe(id)
    results.push(out)
    console.log(`## ${id}`)
    console.log(`HTTP: ${out.status ?? '-'} / ${out.ms ?? '-'}ms / finish_reason: ${out.finish ?? '-'} / usage: ${JSON.stringify(out.usage)}`)
    console.log(`返事の長さ: ${out.replyChars}字 / JSON を採れたか: ${out.parsed ? 'はい' : 'いいえ'}`)
    if (out.counts) console.log(`指摘: ${out.counts.findings}件（ai ${out.counts.ai} / unverified ${out.counts.unverified} / malformed ${out.counts.malformed} / cut ${out.counts.cut}）`)
    for (const l of out.lines ?? []) console.log(`  ・${l.line}\n      ${l.note}`)
    for (const c of CHECKS) console.log(`期待した指摘（${c.label}）: ${out.expected[c.label] ? '見つけた' : '見つからず'}`)
    if (out.notes.length) console.log(`メモ: ${out.notes.join(' / ')}`)
    if (reply) {
      console.log(`--- 返事の先頭 300字 ---\n${noKey(head(reply, 300))}`)
      console.log(`--- 返事の末尾 300字 ---\n${noKey(tail(reply, 300))}`)
    }
    console.log('')
  }
  console.log('--- 以下の JSON をそのまま共有してください（キーは含みません） ---')
  console.log(JSON.stringify(results, null, 2))
} catch (e) {
  console.error(`\n❌ ${e?.message ?? e}`)
  process.exit(2)
}
