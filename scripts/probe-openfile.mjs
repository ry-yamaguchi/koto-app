#!/usr/bin/env node
/*
 * roadmap C（測る・#15）「開いているファイルを毎回送るのをやめられるか」の実測スクリプト。
 *
 * ── 背景 ──────────────────────────────────────────────────────────────
 * ChatPanel.tsx の buildSystemPrompt（446-448行目）は、開いているファイルの中身
 * （先頭4000字）を「openFileBlock」として、毎メッセージのシステムプロンプトへ
 * 上乗せしている。AI は read_file / list_files / search_in_files ツールを持っているので、
 * 理屈のうえではこの上乗せ（毎回だいたい1000〜1300トークン）は無くても自分でファイルを
 * 読みに行けるはずである。だが「理屈のうえでは」を推測で終わらせず、実測する（掟1）。
 *
 * 見るのは「開いているファイルを指す依頼」（例:「このファイルの…」「12行目の…」）に対して、
 *   ① 往復（ラウンド）が増えるか
 *   ② 的外れ（別ファイルへの書き込み・失敗）になるか
 *   ③ 変わらないか
 * を、3条件で走らせて比べる:
 *   条件A（現状・中身4000字つきで注入）／条件B（やめる・注入なし）／
 *   条件C（ファイル名だけ・約20トークン。「どれを指しているか」だけ教えて中身は read_file に
 *   任せる折衷案——docs/measure-openfile.md の本命仮説）。
 *
 * ── 使い方 ────────────────────────────────────────────────────────────
 *   SAKURA_API_KEY=<キー> node scripts/probe-openfile.mjs <モデル名...>
 *   （モデル名は node scripts/probe-models.mjs の結果から選んでください。1個以上必須）
 *
 *   自己検証だけ行う場合（実APIを呼ばない・APIキー不要）:
 *     node scripts/probe-openfile.mjs --dry-run
 *
 * ── 消費量の目安 ──────────────────────────────────────────────────────
 * 1モデルにつき「3シナリオ×3条件」＝9ラン。1ランは最大8ラウンドの往復があるため、
 * 最悪ケースでは1モデルあたり数十リクエストになりうる。少数のモデルから試すこと。
 *
 * キー・個人パス（ホームディレクトリの絶対パス）は一切出力しない。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BASE = 'https://api.ai.sakura.ad.jp/v1'
const MAX_ROUNDS = 8
const MAX_TOKENS = 2048

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')

const USAGE =
  '使い方:\n' +
  '  SAKURA_API_KEY=<キー> node scripts/probe-openfile.mjs <モデル名...>\n\n' +
  'モデル名は1個以上、必須の引数です。node scripts/probe-models.mjs の結果から選んでください。\n' +
  '（トークンはチャットに貼らないこと）\n\n' +
  '自己検証だけ行う場合（実APIを呼ばない・APIキー不要）:\n' +
  '  node scripts/probe-openfile.mjs --dry-run\n'

// ホームディレクトリの絶対パスが出力に混ざらないようにする（掟: 個人パスを一切出力しない）。
// 想定外の場所（esbuildのエラー本文・fetch失敗の例外メッセージ等）に紛れても、必ずここを通す。
const HOME = os.homedir()
function sanitize(text) {
  const s = String(text ?? '')
  return HOME ? s.split(HOME).join('<home>') : s
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n)

// ============================================================================
// 実験の器（毎ラン作り直す使い捨てプロジェクト）
// ============================================================================

// 「開いているファイル」とする style.css。約40行。次を必ず含む:
//   - h1 { color: #ff0000; }
//   - 12行目がちょうど「/* 見出しまわりの調整はここ */」というコメント行
//   - .container { padding: 8px; }
const STYLE_LINES = [
  '/* style.css — 実験用の最小スタイル（probe-openfile.mjs が生成） */',
  '',
  '* {',
  '  box-sizing: border-box;',
  '}',
  '',
  'body {',
  '  margin: 0;',
  '  font-family: sans-serif;',
  '  background: #f5f5f5;',
  '}',
  '/* 見出しまわりの調整はここ */',
  'h1 {',
  '  color: #ff0000;',
  '  font-size: 2rem;',
  '  margin: 0 0 16px;',
  '}',
  '',
  '.container {',
  '  max-width: 800px;',
  '  margin: 0 auto;',
  '  padding: 8px;',
  '}',
  '',
  '.container p {',
  '  line-height: 1.6;',
  '}',
  '',
  'nav {',
  '  display: flex;',
  '  gap: 12px;',
  '}',
  '',
  'nav a {',
  '  color: #333333;',
  '  text-decoration: none;',
  '}',
  '',
  'footer {',
  '  text-align: center;',
  '  color: #666666;',
  '  font-size: 0.8rem;',
  '}',
]
// 12行目（1始まり）＝配列のindex 11。ずれたら実験そのものが成り立たないので、ここで自己点検する。
if (STYLE_LINES[11] !== '/* 見出しまわりの調整はここ */') {
  throw new Error('内部エラー: STYLE_LINES の12行目コメントがずれています（スクリプトの実装ミス）')
}
const STYLE_CSS = STYLE_LINES.join('\n') + '\n'

const INDEX_HTML =
  '<!doctype html>\n' +
  '<html lang="ja">\n' +
  '<head>\n' +
  '<meta charset="utf-8">\n' +
  '<title>実験用ページ</title>\n' +
  '<link rel="stylesheet" href="css/style.css">\n' +
  '</head>\n' +
  '<body>\n' +
  '<header>\n' +
  '<h1>実験用ページ</h1>\n' +
  '</header>\n' +
  '<div class="container">\n' +
  '<p>これは probe-openfile.mjs が生成した実験用のページです。</p>\n' +
  '</div>\n' +
  '<script src="js/main.js"></script>\n' +
  '</body>\n' +
  '</html>\n'

const MAIN_JS =
  '// main.js — 実験用の最小スクリプト（probe-openfile.mjs が生成）\n' +
  'document.addEventListener(\'DOMContentLoaded\', () => {\n' +
  '  const container = document.querySelector(\'.container\')\n' +
  '  if (!container) return\n' +
  '  const note = document.createElement(\'p\')\n' +
  '  note.textContent = \'読み込み完了\'\n' +
  '  container.appendChild(note)\n' +
  '})\n'

/** 使い捨てプロジェクトを1つ作る。projectDir（絶対パス）を返す。 */
function makeProject(tmpRoot, name) {
  const projectDir = path.join(tmpRoot, name)
  fs.mkdirSync(path.join(projectDir, 'public/css'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'public/js'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'public/index.html'), INDEX_HTML, 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'public/css/style.css'), STYLE_CSS, 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'public/js/main.js'), MAIN_JS, 'utf-8')
  return projectDir
}

// ============================================================================
// シナリオ・条件・判定ロジック
// ============================================================================

const SCENARIOS = [
  { id: 'S1', label: 'h1の文字色を#333333に', prompt: 'このファイルの h1 の文字色を #333333 に変えてください' },
  { id: 'S2', label: '12行目のコメント削除', prompt: '12行目のコメント行を削除してください' },
  { id: 'S3', label: '.containerのpaddingを2倍に', prompt: '.container の余白（padding）を、いまの値の2倍にしてください' },
]

const CONDITIONS = [
  { id: 'A', label: '現状（開いているファイルを注入）' },
  { id: 'B', label: 'やめる（注入なし）' },
  { id: 'C', label: 'ファイル相対パスだけ（中身なし）' },
]

// 「開いているファイル」の AI 相対パス（writeRoot=public/ から見た形。AI がツールに渡すべき形）。
// 第1・2回の実測で、basename（style.css）を見せる条件A/Cは**1手目に誤ったパスで
// read_file/edit_file を叩いて1往復無駄にする**ことが分かった（実物の activeFile.name も
// basename・App.tsx:543）。条件Cは「直すならこの形」を試す設計候補なので、相対パスへ改めた。
const OPEN_FILE_REL = 'css/style.css'

/** ChatPanel.tsx:446-448 の形をそのまま複製する。変えたら実験にならない。 */
function openFileBlock(activeFile) {
  return `\n\n# 開いているファイル: ${activeFile.name} (${activeFile.language})\n\`\`\`${activeFile.language}\n${activeFile.content.slice(0, 4000)}\n\`\`\``
}

/** 条件C: 見出し行だけ（中身の fence を落とし、名前は AI 相対パスで渡す）。 */
function nameOnlyBlock(activeFile) {
  return `\n\n# 開いているファイル: ${OPEN_FILE_REL} (${activeFile.language})`
}

/** 条件A/B/Cのシステムプロンプトを組み立てる（それ以外は完全に同一）。 */
function buildSystemPrompt(conditionId, activeFile, ideContext, nowContextFn) {
  const base = nowContextFn() + '\n\n' + ideContext
  if (conditionId === 'A') return base + openFileBlock(activeFile)
  if (conditionId === 'C') return base + nameOnlyBlock(activeFile)
  return base
}

/**
 * 単純なCSSパーサ（素朴な実装）。「セレクタ, セレクタ { 宣言 }」の列を返す。
 * まずコメント（/* ... * /）を取り除く——取り除かないと、ルールの直前にあるコメント
 * （例: 12行目の「/* 見出しまわりの調整はここ * /」）がセレクタ文字列に混ざり、
 * 「h1」のような単純な名前と一致しなくなる。
 */
function cssRules(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(stripped))) rules.push({ selector: m[1].trim(), body: m[2] })
  return rules
}

/** セレクタ名（例: 'h1', '.container'）を含むルールを1つ探す。 */
function ruleFor(css, selectorName) {
  const target = selectorName.toLowerCase()
  return cssRules(css).find((r) =>
    r.selector.split(',').map((s) => s.trim().toLowerCase()).includes(target)
  )
}

/** 判定は機械的に行う（人の目に頼らない）。changedFiles は diffHashes() の結果。 */
function judgeVerdict(scenarioId, cssContent, changedFiles) {
  if (!changedFiles || changedFiles.length === 0) return 'ng' // 何も変わっていない
  if (scenarioId === 'S1') {
    const rule = ruleFor(cssContent, 'h1')
    return rule && /color\s*:\s*#333333\b/i.test(rule.body) ? 'ok' : 'ng'
  }
  if (scenarioId === 'S2') {
    return cssContent.includes('見出しまわりの調整はここ') ? 'ng' : 'ok'
  }
  if (scenarioId === 'S3') {
    const rule = ruleFor(cssContent, '.container')
    return rule && /padding\s*:\s*16px\b/i.test(rule.body) ? 'ok' : 'ng'
  }
  return 'ng'
}

// ============================================================================
// fsベースの最小 io 実装
// ============================================================================

/** root配下の安全な絶対パスへ解決する。根の外へ出ようとしたら例外。 */
function resolveSafe(root, rel) {
  const full = path.normalize(path.join(root, rel))
  const rootNorm = path.normalize(root)
  if (full !== rootNorm && !full.startsWith(rootNorm + path.sep)) {
    throw new Error('プロジェクトの外は操作できません')
  }
  return full
}

/** root配下を再帰列挙し、root からの相対パス（'/'区切り）の一覧を返す。 */
function listFilesRecursive(root) {
  const out = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath)
      else out.push(relPath)
    }
  }
  walk(root, '')
  return out.sort()
}

/** '*' だけを特別扱いする単純なパターン一致（正規表現は使えない・素朴な実装）。 */
function matchesPattern(rel, pattern) {
  if (!pattern) return true
  if (pattern.includes('*')) {
    const escaped = pattern
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(escaped, 'i').test(rel)
  }
  return rel.toLowerCase().includes(pattern.toLowerCase())
}

/** 全テキストファイルを行で見る素朴な全文検索。 */
function searchNaive(root, query, pathPattern) {
  const MAX_MATCHES = 200
  const q = query.toLowerCase()
  const matches = []
  let truncated = false
  for (const rel of listFilesRecursive(root)) {
    if (!matchesPattern(rel, pathPattern)) continue
    let text
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf-8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue // バイナリらしきものは飛ばす
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true
          break
        }
        matches.push({ path: rel, line: i + 1, text: lines[i] })
      }
    }
    if (truncated) break
  }
  return { ok: true, matches, truncated }
}

/** ToolIo（toolExecCore.ts）の最小実装。この実験専用。 */
function makeIo() {
  return {
    async fetchPage() {
      throw new Error('この実験では使えません')
    },
    async webSearch() {
      throw new Error('この実験では使えません')
    },
    async ragSearch() {
      throw new Error('この実験では使えません')
    },
    async projectFiles(root) {
      return listFilesRecursive(root)
    },
    async readFileInProject(root, rel) {
      return fs.readFileSync(resolveSafe(root, rel), 'utf-8')
    },
    async writeFileInProject(root, rel, content) {
      const full = resolveSafe(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content, 'utf-8')
    },
    // applyFile はあえて渡さない（undefined）。writeFileInProject 側が使われる。
    async snapshotBeforeWrite() {
      return { ok: true, backedUp: false }
    },
    async runCommand() {
      return { code: null, stdout: '', stderr: 'この実験では run_command は使えません', timedOut: false }
    },
    async searchInProject(root, query, pathPattern) {
      return searchNaive(root, query, pathPattern)
    },
    async exists(p) {
      return fs.existsSync(p)
    },
    async openPath() {
      /* 何もしない */
    },
  }
}

// ============================================================================
// sha256差分
// ============================================================================

function hashTree(root) {
  const map = {}
  for (const rel of listFilesRecursive(root)) {
    const buf = fs.readFileSync(path.join(root, rel))
    map[rel] = crypto.createHash('sha256').update(buf).digest('hex')
  }
  return map
}

function diffHashes(before, after) {
  const changed = new Set()
  for (const [rel, hash] of Object.entries(after)) {
    if (before[rel] !== hash) changed.add(rel)
  }
  for (const rel of Object.keys(before)) {
    if (!(rel in after)) changed.add(rel) // 削除も差分として拾う
  }
  return [...changed].sort()
}

// ============================================================================
// 実物モジュールの束ね読み（複製を作らない・検証は実物のコードで）
// ============================================================================

/**
 * 実物の4モジュールを一時dirへesbuildで束ね、importして返す。
 * リポジトリの根はimport.meta.urlから導く。esbuildのcwdはリポジトリの根。
 */
async function bundleRealModules(tmpRoot) {
  const outDir = path.join(tmpRoot, 'bundle')
  const esbuildBin = path.join(REPO_ROOT, 'node_modules/.bin/esbuild')
  try {
    execFileSync(
      esbuildBin,
      [
        'src/renderer/aiContext.ts',
        'src/shared/aiToolsCore.ts',
        'src/shared/toolExecCore.ts',
        'src/shared/chatTime.ts',
        '--bundle',
        '--format=esm',
        '--platform=node',
        `--outdir=${outDir}`,
      ],
      { cwd: REPO_ROOT, stdio: 'pipe' }
    )
  } catch (e) {
    throw new Error(`実物モジュールの束ね読みに失敗しました（esbuild）: ${sanitize(e?.stderr?.toString?.() ?? e?.message ?? e)}`)
  }

  const load = async (rel) => import(pathToFileURL(path.join(outDir, rel)).href)
  const aiContext = await load('renderer/aiContext.js')
  const aiToolsCore = await load('shared/aiToolsCore.js')
  const toolExecCore = await load('shared/toolExecCore.js')
  const chatTime = await load('shared/chatTime.js')

  return {
    IDE_CONTEXT: aiContext.IDE_CONTEXT,
    toolsFor: aiToolsCore.toolsFor,
    isToolUnsupportedError: aiToolsCore.isToolUnsupportedError,
    executeToolCore: toolExecCore.executeToolCore,
    nowContext: chatTime.nowContext,
  }
}

// ============================================================================
// エージェントループ（1ラン = モデル×シナリオ×条件）
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 429（レート制限）は待って再試行する（最大5回・待ちは 20s→40s→60s→80s→100s。
// Retry-After ヘッダがあればそちらを優先）。2026-09-04 の第2回実測で
// preview/Kimi-K2.7-Code が連投により 429 で9ラン中7ランを落としたため追加。
// 測定の道具は速さより「最後まで測り切る」を優先する。
async function chat(authKey, body) {
  const t0 = Date.now()
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authKey}` },
      body: JSON.stringify(body),
    })
    if (res.status === 429 && attempt <= 5) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 20_000
      console.log(`    …レート制限（429）。${Math.round(waitMs / 1000)}秒待って再試行します（${attempt}/5）`)
      await res.text().catch(() => {}) // 応答は読み捨てて接続を返す
      await sleep(waitMs)
      continue
    }
    const ms = Date.now() - t0
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* JSONでない応答はそのまま raw に残す */
    }
    return { ok: res.ok, status: res.status, ms, json, raw: text }
  }
}

function extractArgPath(argsJson) {
  try {
    const args = JSON.parse(argsJson || '{}')
    return args.path ?? args.query ?? args.url ?? null
  } catch {
    return null
  }
}

/**
 * 1回の試行（最大8ラウンド）。tools対応なら useTools=true で呼び、
 * サーバーが「toolsに非対応」らしき400を返したら { toolsUnsupported: true } を返す
 * （呼び出し側が useTools=false でやり直す）。
 */
async function runAttempt(authKey, model, systemPrompt, userPrompt, ctx, io, tools, useTools, isToolUnsupportedError, executeToolCore) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
  const toolCallLog = []
  let completionTokens = 0
  let promptTokens = 0

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const body = {
      model,
      messages,
      max_tokens: MAX_TOKENS,
      ...(useTools ? { tools, tool_choice: 'auto' } : {}),
    }
    const r = await chat(authKey, body)

    if (!r.ok) {
      const msg = r.json?.error?.message ?? r.raw ?? ''
      if (useTools && isToolUnsupportedError(msg)) {
        return { toolsUnsupported: true }
      }
      return {
        toolsUnsupported: false,
        rounds: round,
        toolCallLog,
        completionTokens,
        promptTokens,
        finalContent: '',
        note: `APIエラー: HTTP ${r.status} ${msg}`.slice(0, 300),
      }
    }

    promptTokens += r.json?.usage?.prompt_tokens ?? 0
    completionTokens += r.json?.usage?.completion_tokens ?? 0
    const message = r.json?.choices?.[0]?.message ?? {}
    const toolCalls = message.tool_calls

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })
      for (const tc of toolCalls) {
        const name = tc?.function?.name ?? ''
        const argsJson = tc?.function?.arguments ?? '{}'
        toolCallLog.push({ round, name, path: extractArgPath(argsJson) })
        let result
        try {
          result = await executeToolCore(name, argsJson, ctx, io)
        } catch (e) {
          result = `エラー: ${e?.message ?? e}`
        }
        messages.push({ role: 'tool', tool_call_id: tc?.id ?? `${name}-${round}`, content: result })
      }
      continue // 次のラウンドへ
    }

    // 本文だけなら最終回答として終了
    return {
      toolsUnsupported: false,
      rounds: round,
      toolCallLog,
      completionTokens,
      promptTokens,
      finalContent: (message.content ?? '').trim(),
      note: null,
    }
  }

  // 8ラウンド使い切り（最終回答に到達しなかった）
  return {
    toolsUnsupported: false,
    rounds: MAX_ROUNDS,
    toolCallLog,
    completionTokens,
    promptTokens,
    finalContent: '',
    note: '8ラウンド使い切り（最終回答なし）',
  }
}

/** 1ラン = モデル×シナリオ×条件。使い捨てプロジェクトを作り、試行し、判定する。 */
async function runOne({ authKey, model, scenario, condition, tmpRoot, index, mods }) {
  const { IDE_CONTEXT, toolsFor, isToolUnsupportedError, executeToolCore, nowContext } = mods
  const t0 = Date.now()

  const projectDir = makeProject(tmpRoot, `run-${index}`)
  const writeRoot = path.join(projectDir, 'public')
  const before = hashTree(writeRoot)

  const activeFile = {
    name: 'style.css',
    language: 'css',
    content: fs.readFileSync(path.join(writeRoot, 'css/style.css'), 'utf-8'),
  }
  const systemPrompt = buildSystemPrompt(condition.id, activeFile, IDE_CONTEXT, nowContext)

  const ctx = { writeRoot, projectRoot: projectDir, snapshotId: 'probe', snapshotLabel: 'probe' }
  const io = makeIo()
  const tools = toolsFor(projectDir, false, false)

  let toolsSupported = true
  let result = await runAttempt(authKey, model, systemPrompt, scenario.prompt, ctx, io, tools, true, isToolUnsupportedError, executeToolCore)

  if (result.toolsUnsupported) {
    toolsSupported = false
    // tools無しでやり直す（未対応モデルにとって条件Bは中身への手段が無い、という事実も重要なデータ）。
    // 1回目の試行はtools付き最初のリクエストで即400になっているはずなので書き込みは走っていないが、
    // 念のためプロジェクトを作り直してから再試行する。
    fs.rmSync(projectDir, { recursive: true, force: true })
    const projectDir2 = makeProject(tmpRoot, `run-${index}-notools`)
    const writeRoot2 = path.join(projectDir2, 'public')
    const ctx2 = { writeRoot: writeRoot2, projectRoot: projectDir2, snapshotId: 'probe', snapshotLabel: 'probe' }
    const activeFile2 = {
      name: 'style.css',
      language: 'css',
      content: fs.readFileSync(path.join(writeRoot2, 'css/style.css'), 'utf-8'),
    }
    const systemPrompt2 = buildSystemPrompt(condition.id, activeFile2, IDE_CONTEXT, nowContext)
    result = await runAttempt(authKey, model, systemPrompt2, scenario.prompt, ctx2, io, tools, false, isToolUnsupportedError, executeToolCore)

    const after2 = hashTree(writeRoot2)
    const changedFiles2 = diffHashes(hashTree(writeRoot2) /* ==before相当だが分かりやすさのため再取得しない */, after2)
    // ↑ tools無しでは書き込み手段が無いので、実質 before===after（差分なし）になるはず。
    const styleContent2 = fs.readFileSync(path.join(writeRoot2, 'css/style.css'), 'utf-8')
    return {
      model,
      scenario: scenario.id,
      condition: condition.id,
      rounds: result.rounds ?? 0,
      toolCalls: result.toolCallLog ?? [],
      verdict: judgeVerdict(scenario.id, styleContent2, changedFiles2),
      wrongTarget: changedFiles2.some((f) => f !== 'css/style.css'),
      changedFiles: changedFiles2,
      completionTokens: result.completionTokens ?? 0,
      promptTokens: result.promptTokens ?? 0,
      wallMs: Date.now() - t0,
      toolsSupported: false,
      note: result.note ?? null,
      answerPreview: (result.finalContent ?? '').slice(0, 200),
    }
  }

  const after = hashTree(writeRoot)
  const changedFiles = diffHashes(before, after)
  const wrongTarget = changedFiles.some((f) => f !== 'css/style.css')
  const styleContent = fs.readFileSync(path.join(writeRoot, 'css/style.css'), 'utf-8')

  return {
    model,
    scenario: scenario.id,
    condition: condition.id,
    rounds: result.rounds ?? 0,
    toolCalls: result.toolCallLog ?? [],
    verdict: judgeVerdict(scenario.id, styleContent, changedFiles),
    wrongTarget,
    changedFiles,
    completionTokens: result.completionTokens ?? 0,
    promptTokens: result.promptTokens ?? 0,
    wallMs: Date.now() - t0,
    toolsSupported,
    note: result.note ?? null,
    answerPreview: (result.finalContent ?? '').slice(0, 200),
  }
}

// ============================================================================
// 表とサマリ
// ============================================================================

function printTable(results) {
  const models = [...new Set(results.map((r) => r.model))]
  for (const model of models) {
    console.log(`\n### ${model}`)
    console.log(
      pad('シナリオ', 8) + pad('条件', 6) + pad('verdict', 9) + pad('rounds', 8) + pad('tool呼出', 9) + 'tokens(prompt/completion)'
    )
    console.log('-'.repeat(70))
    for (const scenario of SCENARIOS) {
      for (const condition of CONDITIONS) {
        const r = results.find((x) => x.model === model && x.scenario === scenario.id && x.condition === condition.id)
        if (!r) continue
        console.log(
          pad(scenario.id, 8) +
            pad(condition.id, 6) +
            pad(r.verdict, 9) +
            pad(String(r.rounds), 8) +
            pad(String(r.toolCalls.length), 9) +
            `${r.promptTokens}/${r.completionTokens}`
        )
      }
    }
    console.log('  --- A→B / A→C サマリ ---')
    for (const scenario of SCENARIOS) {
      const a = results.find((x) => x.model === model && x.scenario === scenario.id && x.condition === 'A')
      if (!a) continue
      for (const condId of ['B', 'C']) {
        const x = results.find((r) => r.model === model && r.scenario === scenario.id && r.condition === condId)
        if (!x) continue
        const roundsDelta = x.rounds - a.rounds
        const verdictChange = a.verdict === x.verdict ? '変化なし' : `${a.verdict} → ${x.verdict}`
        console.log(
          `  [${scenario.id}] A→${condId} ラウンド増分: ${roundsDelta >= 0 ? '+' : ''}${roundsDelta}（A:${a.rounds}→${condId}:${x.rounds}） / verdict: ${verdictChange}`
        )
      }
    }
  }
}

// ============================================================================
// --dry-run 自己検証（実APIを呼ばない）
// ============================================================================

async function runDryRun(tmpRoot, mods) {
  const { IDE_CONTEXT, toolsFor, executeToolCore, nowContext } = mods
  const checks = []
  const check = (label, ok) => {
    checks.push({ label, ok })
    console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  }

  console.log('=== --dry-run 自己検証（実APIは呼びません） ===\n')

  console.log('[1] 実物モジュールの束ね読み')
  check('IDE_CONTEXT を読み込めた', typeof IDE_CONTEXT === 'string' && IDE_CONTEXT.length > 100)
  check('toolsFor を読み込めた', typeof toolsFor === 'function')
  check('executeToolCore を読み込めた', typeof executeToolCore === 'function')
  check('nowContext を読み込めた', typeof nowContext === 'function' && nowContext().includes('現在の日時'))

  console.log('\n[2] 使い捨てプロジェクトの生成')
  const projectDir = makeProject(tmpRoot, 'dry-run')
  const writeRoot = path.join(projectDir, 'public')
  check('public/index.html ができた', fs.existsSync(path.join(writeRoot, 'index.html')))
  check('public/css/style.css ができた', fs.existsSync(path.join(writeRoot, 'css/style.css')))
  check('public/js/main.js ができた', fs.existsSync(path.join(writeRoot, 'js/main.js')))
  const rawStyle = fs.readFileSync(path.join(writeRoot, 'css/style.css'), 'utf-8')
  const styleLine12 = rawStyle.split('\n')[11]
  check('style.cssの12行目がコメント行になっている', styleLine12 === '/* 見出しまわりの調整はここ */')
  check('style.cssにh1 { color: #ff0000; } がある', /h1\s*\{[^}]*#ff0000/i.test(rawStyle))
  check('style.cssに.container { padding: 8px; } がある', /\.container\s*\{[^}]*padding:\s*8px/i.test(rawStyle))

  console.log('\n[3] システムプロンプトの組み立て（条件A/B/C）')
  const activeFile = { name: 'style.css', language: 'css', content: rawStyle }
  const sysA = buildSystemPrompt('A', activeFile, IDE_CONTEXT, nowContext)
  const sysB = buildSystemPrompt('B', activeFile, IDE_CONTEXT, nowContext)
  const sysC = buildSystemPrompt('C', activeFile, IDE_CONTEXT, nowContext)
  check('条件A: 「開いているファイル」ブロックを含む', sysA.includes('# 開いているファイル: style.css (css)'))
  check('条件A: style.cssの中身を含む', sysA.includes('.container'))
  check('条件B: 「開いているファイル」ブロックを含まない', !sysB.includes('# 開いているファイル'))
  check('条件A: IDE_CONTEXTを含む', sysA.includes(IDE_CONTEXT))
  check('条件Aの方が条件Bより長い（openFileBlock分）', sysA.length > sysB.length)
  check('条件C: 見出し行を AI 相対パスで含む', sysC.includes('# 開いているファイル: css/style.css (css)'))
  check('条件C: 中身（fence）を含まない', !sysC.includes('```css'))
  check('条件Cの長さはBとAの間（B < C < A）', sysB.length < sysC.length && sysC.length < sysA.length)

  console.log('\n[4] io の疎通（executeToolCore経由・全関数を1回ずつ）')
  const ctx = { writeRoot, projectRoot: projectDir, snapshotId: 'probe', snapshotLabel: 'probe' }
  const io = makeIo()

  const listResult = await executeToolCore('list_files', '{}', ctx, io)
  check('list_files: 一覧にcss/style.cssが出る', listResult.includes('css/style.css'))

  const readResult = await executeToolCore('read_file', JSON.stringify({ path: 'css/style.css' }), ctx, io)
  check('read_file: style.cssの中身が読める', readResult.includes('.container') && readResult.includes('見出しまわりの調整'))

  const writeResult = await executeToolCore(
    'write_file',
    JSON.stringify({ path: 'js/dry-run-check.js', content: '// dry-run write test\n' }),
    ctx,
    io
  )
  const wroteOk = fs.existsSync(path.join(writeRoot, 'js/dry-run-check.js'))
  check('write_file: 保存できる（実際にファイルができる）', writeResult.startsWith('保存しました') && wroteOk)

  const searchResult = await executeToolCore(
    'search_in_files',
    JSON.stringify({ query: '見出しまわりの調整', path_pattern: '*.css' }),
    ctx,
    io
  )
  check('search_in_files: 該当箇所が見つかる', searchResult.includes('css/style.css') && !searchResult.includes('見つかりませんでした'))

  const runResult = await executeToolCore('run_command', JSON.stringify({ command: 'echo ok' }), ctx, io)
  check('run_command: 定型文を返す', runResult.includes('この実験では run_command は使えません'))

  const editResult = await executeToolCore(
    'edit_file',
    JSON.stringify({ path: 'css/style.css', old_string: '  padding: 8px;', new_string: '  padding: 16px;' }),
    ctx,
    io
  )
  const afterEdit = fs.readFileSync(path.join(writeRoot, 'css/style.css'), 'utf-8')
  check('edit_file: 部分置換できる', editResult.startsWith('編集しました') && afterEdit.includes('padding: 16px;'))

  const fetchResult = await executeToolCore('fetch_url', JSON.stringify({ url: 'https://example.com' }), ctx, io)
  check('fetch_url: 使えない旨を返す', fetchResult.includes('この実験では使えません'))

  const docsResult = await executeToolCore('search_docs', JSON.stringify({ query: 'テスト' }), ctx, io)
  check('search_docs: 使えない旨を返す', docsResult.includes('この実験では使えません'))

  const previewResult = await executeToolCore('open_preview', JSON.stringify({ path: 'index.html' }), ctx, io)
  check('open_preview: 開けたと返す', previewResult.includes('開きました'))
  console.log('  ※ search_web（io.webSearch）は、この実験ではhasSearch=false固定＝ctx.searchが常に無いため、' +
    '実際の実験と同じくexecuteToolCore経由では到達しません（未使用は意図どおり）')

  console.log('\n[5] 判定ロジック（judgeVerdict）の自己検証')
  const afterS1 = STYLE_CSS.replace('#ff0000', '#333333')
  const afterS2 = STYLE_LINES.filter((l) => l !== '/* 見出しまわりの調整はここ */').join('\n') + '\n'
  const afterS3 = STYLE_CSS.replace('  padding: 8px;', '  padding: 16px;')

  const t = (label, scenarioId, content, changedFiles, expected) => {
    check(`${label}`, judgeVerdict(scenarioId, content, changedFiles) === expected)
  }
  t('S1 未変更・差分なし → ng', 'S1', STYLE_CSS, [], 'ng')
  t('S1 別ファイルだけ変わった（h1は未変更）→ ng', 'S1', STYLE_CSS, ['css/style.css'], 'ng')
  t('S1 正しく#333333に変更 → ok', 'S1', afterS1, ['css/style.css'], 'ok')
  t('S2 未変更・差分なし → ng', 'S2', STYLE_CSS, [], 'ng')
  t('S2 コメント行が残ったまま → ng', 'S2', STYLE_CSS, ['css/style.css'], 'ng')
  t('S2 コメント行を削除済み → ok', 'S2', afterS2, ['css/style.css'], 'ok')
  t('S3 未変更・差分なし → ng', 'S3', STYLE_CSS, [], 'ng')
  t('S3 padding未変更 → ng', 'S3', STYLE_CSS, ['css/style.css'], 'ng')
  t('S3 paddingを16pxに変更 → ok', 'S3', afterS3, ['css/style.css'], 'ok')
  t('クロスチェック: S1の変更だけではS3はng', 'S3', afterS1, ['css/style.css'], 'ng')
  t('クロスチェック: S3の変更だけではS1はng', 'S1', afterS3, ['css/style.css'], 'ng')

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n=== 自己検証結果: ${checks.length - failed.length}/${checks.length} 件 合格 ===`)
  if (failed.length) {
    console.log('失敗した項目:')
    for (const f of failed) console.log(`  - ${f.label}`)
    process.exitCode = 1
  } else {
    console.log('✅ すべて合格しました。')
  }
}

// ============================================================================
// エントリポイント
// ============================================================================

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const models = argv.filter((a) => a !== '--dry-run' && !a.startsWith('-'))

if (!dryRun && (models.length === 0 || !process.env.SAKURA_API_KEY)) {
  console.error(USAGE)
  process.exit(2)
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-probe-openfile-'))
try {
  console.log('実物モジュール（aiContext / aiToolsCore / toolExecCore / chatTime）を束ねています…')
  const mods = await bundleRealModules(tmpRoot)
  console.log('束ね読み完了。\n')

  if (dryRun) {
    await runDryRun(tmpRoot, mods)
  } else {
    const authKey = process.env.SAKURA_API_KEY
    console.log(`=== 開いているファイル注入プローブ（${models.length}モデル × 3シナリオ × 2条件） ===`)
    const results = []
    let index = 0
    for (const model of models) {
      console.log(`\n=== ${model} ===`)
      for (const scenario of SCENARIOS) {
        for (const condition of CONDITIONS) {
          index++
          process.stdout.write(`  ${scenario.id} / 条件${condition.id}（${condition.label}） … `)
          const r = await runOne({ authKey, model, scenario, condition, tmpRoot, index, mods })
          results.push(r)
          console.log(`${r.verdict}（${r.rounds}ラウンド・tool呼出${r.toolCalls.length}回・${r.wallMs}ms${r.toolsSupported ? '' : '・tools未対応'}）`)
          if (r.wrongTarget) console.log(`    ⚠️ 想定外のファイルが変わりました: ${r.changedFiles.join(', ')}`)
          if (r.note) console.log(`    ↳ ${r.note}`)
        }
      }
    }

    console.log('\n\n========== 結果 ==========')
    printTable(results)

    console.log('\n--- 以下の JSON をそのまま共有してください（秘密情報は含みません） ---')
    console.log(JSON.stringify(results, null, 2))
  }
} catch (e) {
  console.error(`\n❌ ${sanitize(e?.message ?? String(e))}`)
  process.exitCode = 1
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 片づけ失敗は握りつぶす（本題ではない） */
  }
}
