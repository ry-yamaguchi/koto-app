#!/usr/bin/env node
// チャットモードのAIが「存在しないUI（② 試す等）を案内せず、IDEモードへ誘導するか」の検証。
// アプリ本体と同じ CHAT_CONTEXT（src/renderer/aiContext.ts）を実APIに送って応答を判定する。
//
// 使い方:
//   node scripts/verify-chat-context.mjs
//   （APIキーを聞かれたら貼り付けてEnter。環境変数 SAKURA_API_KEY でも可）

import { createInterface } from 'node:readline/promises'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ── アプリ本体の aiContext.ts から CHAT_CONTEXT を読み込む（二重管理を避ける） ──
function loadContexts() {
  const esbuild = require('esbuild')
  const src = readFileSync(new URL('../src/renderer/aiContext.ts', import.meta.url), 'utf-8')
  const { code } = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' })
  const dir = mkdtempSync(join(tmpdir(), 'sakura-ctx-'))
  const file = join(dir, 'aiContext.cjs')
  writeFileSync(file, code)
  const mod = require(file)
  rmSync(dir, { recursive: true, force: true })
  return { CHAT_CONTEXT: mod.CHAT_CONTEXT, IDE_CONTEXT: mod.IDE_CONTEXT }
}

const BASE = 'https://api.ai.sakura.ad.jp/v1'
const MODEL = process.env.SAKURA_MODEL || 'Qwen3-Coder-480B-A35B-Instruct-FP8'

async function getKey() {
  if (process.env.SAKURA_API_KEY) return process.env.SAKURA_API_KEY.trim()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const key = (await rl.question('さくらのAI Engine のAPIキーを入力: ')).trim()
  rl.close()
  return key
}

async function ask(key, system, user) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

const { CHAT_CONTEXT, IDE_CONTEXT } = loadContexts()

// 静的チェック（API不要）
let pass = 0, fail = 0
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}: ${label}${detail ? `\n         ${detail}` : ''}`)
  cond ? pass++ : fail++
}
ok('CHAT_CONTEXT が読み込める', typeof CHAT_CONTEXT === 'string' && CHAT_CONTEXT.length > 100)
ok('CHAT_CONTEXT にUI非存在の明示がある', CHAT_CONTEXT.includes('ありません'))
ok('CHAT_CONTEXT にIDEモードへの誘導指示がある', CHAT_CONTEXT.includes('IDE モード') || CHAT_CONTEXT.includes('IDEモード'))
ok('IDE_CONTEXT は従来どおり【② 試す】へ誘導する', IDE_CONTEXT.includes('② 試す'))

// 実APIチェック：問題が起きたのと同じシナリオを再現
const key = await getKey()
if (!key) { console.error('キーが空です'); process.exit(1) }
console.log(`\nモデル: ${MODEL}（チャットモードの実シナリオを再現中…）\n`)

try {
  const reply = await ask(
    key,
    CHAT_CONTEXT,
    '卵の栄養について調べてもらった内容、とても良かったです。これを簡単なWebサイトにまとめたいです。どうすればいいですか？',
  )
  console.log('--- AIの応答 ---\n' + reply + '\n----------------\n')
  ok('応答がIDEモードへ誘導している', /IDE\s*モード|IDEに切り替え|IDE に切り替え/.test(reply))
  ok('「② 試す」ボタンの操作を指示していない', !/【?②\s*試す】?(ボタン)?で/.test(reply))
  ok('「③ 公開」ボタンの操作を指示していない', !/【?③\s*公開】?(ボタン)?で/.test(reply) || /IDEモードでは/.test(reply))
} catch (e) {
  ok('実APIでの応答確認', false, e.message)
}

console.log(`\n結果: ${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
