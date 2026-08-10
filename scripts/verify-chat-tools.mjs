#!/usr/bin/env node
// チャットモードの「検索→最終回答が空になる」問題の再現・診断スクリプト。
// アプリ本体と同じ CHAT_CONTEXT・ツール定義・エージェントループをAPI上で再現し、
// 各周回の content / tool_calls / reasoning の有無を表示する。
//
// 使い方:
//   cd ~/sakura-ide && node scripts/verify-chat-tools.mjs
//   （APIキーを聞かれたら貼り付けてEnter。環境変数 SAKURA_API_KEY でも可）

import { createInterface } from 'node:readline/promises'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const BASE = 'https://api.ai.sakura.ad.jp/v1'
const MODELS = ['gpt-oss-120b', 'Qwen3-Coder-480B-A35B-Instruct-FP8']

// アプリ本体のTSモジュールを読み込む（実装と同じ定義でテストする）
function loadTs(relPath) {
  const esbuild = require('esbuild')
  const src = readFileSync(new URL(relPath, import.meta.url), 'utf-8')
  const { code } = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' })
  const dir = mkdtempSync(join(tmpdir(), 'sakura-vt-'))
  const file = join(dir, 'mod.cjs')
  writeFileSync(file, code)
  const mod = require(file)
  rmSync(dir, { recursive: true, force: true })
  return mod
}
const { CHAT_CONTEXT } = loadTs('../src/renderer/aiContext.ts')
const { toolsFor, supportsTools } = loadTs('../src/renderer/aiTools.ts')

// ツールはスタブで応答（表示問題の再現に実際の検索は不要）
function stubTool(name) {
  if (name === 'search_web') {
    return '「卵 栄養」の検索結果:\n\n1. 卵の栄養成分 | 食品成分表\n   https://example.com/egg\n   卵はたんぱく質・ビタミン・ミネラルが豊富。\n\n（詳細が必要なページは fetch_url で本文を取得できます）'
  }
  if (name === 'fetch_url') {
    return 'ページ: https://example.com/egg（卵の栄養成分）\n\n卵100gあたり: たんぱく質12.2g、脂質10.2g、ビタミンA・D・B群、コリンを含む。'
  }
  return 'エラー: 未対応のツール'
}

async function getKey() {
  if (process.env.SAKURA_API_KEY) return process.env.SAKURA_API_KEY.trim()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const key = (await rl.question('さくらのAI Engine のAPIキーを入力: ')).trim()
  rl.close()
  return key
}

// アプリと同じ：ストリーミングで content / tool_calls を集める（reasoningの有無も記録）
async function streamOnce(key, model, messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, messages, max_tokens: 2048, stream: true,
      stream_options: { include_usage: true },
      // アプリと同じ：ツール非対応モデル（gpt-oss系）にはtoolsを渡さない
      ...(supportsTools(model) ? { tools: toolsFor(null, true) } : {}),
    }),
    signal: AbortSignal.timeout(90000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  let content = ''
  let reasoningText = ''
  let sawReasoning = false
  const toolCalls = []
  let finish = null
  let buf = ''
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf-8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue
      let j; try { j = JSON.parse(line.slice(5)) } catch { continue }
      const c = j.choices?.[0]
      if (!c) continue
      if (c.finish_reason) finish = c.finish_reason
      const d = c.delta ?? {}
      if (d.content) content += d.content
      if (typeof d.reasoning_content === 'string') { reasoningText += d.reasoning_content; sawReasoning = true }
      else if (typeof d.reasoning === 'string') { reasoningText += d.reasoning; sawReasoning = true }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const k = tc.index ?? 0
          if (!toolCalls[k]) toolCalls[k] = { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (tc.id) toolCalls[k].id = tc.id
          if (tc.function?.name) toolCalls[k].function.name += tc.function.name
          if (tc.function?.arguments) toolCalls[k].function.arguments += tc.function.arguments
        }
      }
    }
  }
  return { content, reasoningText, toolCalls: toolCalls.filter(Boolean), sawReasoning, finish }
}

const key = await getKey()
if (!key) { console.error('キーが空です'); process.exit(1) }

let anyFail = false
for (const model of MODELS) {
  console.log(`\n========== モデル: ${model} ==========`)
  let messages = [
    { role: 'system', content: CHAT_CONTEXT },
    { role: 'user', content: '卵の栄養性について調べて要約して' },
  ]
  try {
    let finalContent = ''
    for (let round = 0; round <= 3; round++) {
      const r = await streamOnce(key, model, messages)
      console.log(
        `[round ${round}] content: ${r.content.trim().length}文字 / tool_calls: ${r.toolCalls.map(t => t.function.name).join(',') || 'なし'}` +
        ` / finish: ${r.finish} / reasoningフィールド: ${r.sawReasoning ? 'あり⚠️' : 'なし'}`
      )
      // アプリと同じフォールバック：本文が空でツール無し→reasoningを本文として使う
      finalContent = (!r.content.trim() && !r.toolCalls.length && r.reasoningText.trim()) ? r.reasoningText : r.content
      if (!r.toolCalls.length || round === 3) break
      messages = [
        ...messages,
        { role: 'assistant', content: r.content ?? '', tool_calls: r.toolCalls },
        ...r.toolCalls.map(tc => ({ role: 'tool', tool_call_id: tc.id, content: stubTool(tc.function.name) })),
      ]
    }
    const ok = finalContent.trim().length > 50
    console.log(ok ? `✅ PASS: 最終回答あり（先頭: ${finalContent.trim().slice(0, 60)}…）` : `❌ FAIL: 最終回答が空（アプリの「空の吹き出し」を再現）`)
    if (!ok) anyFail = true
  } catch (e) {
    console.log(`❌ FAIL: ${e.message}`)
    anyFail = true
  }
}
console.log('\n→ この出力を貼り付けてもらえれば、原因を特定して修正します。')
process.exit(anyFail ? 1 : 0)
