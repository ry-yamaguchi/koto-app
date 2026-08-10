#!/usr/bin/env node
// さくらのAI Engine が OpenAI互換の Function Calling (tools) に対応しているかの検証スクリプト。
//
// 使い方:
//   cd ~/sakura-ide && node scripts/verify-function-calling.mjs
//   （APIキーを聞かれたら貼り付けてEnter。環境変数 SAKURA_API_KEY でも可）
//
// 検証内容:
//   1. tools を渡してモデルが tool_calls を返すか（基本のFunction Calling）
//   2. tool結果を返して最終回答が得られるか（ループ1周）
//   3. ストリーミングでも tool_calls が取れるか（Sakura IDEはストリーミング利用のため）

import { createInterface } from 'node:readline/promises'

const BASE = 'https://api.ai.sakura.ad.jp/v1'
const MODEL = process.env.SAKURA_MODEL || 'Qwen3-Coder-480B-A35B-Instruct-FP8'

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '指定した都市の現在の天気を取得する',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '都市名（例: 大阪）' } },
        required: ['city'],
      },
    },
  },
]

async function getKey() {
  if (process.env.SAKURA_API_KEY) return process.env.SAKURA_API_KEY.trim()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const key = (await rl.question('さくらのAI Engine のAPIキーを入力: ')).trim()
  rl.close()
  return key
}

async function chat(key, body) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, ...body }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res
}

let pass = 0, fail = 0
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}: ${label}${detail ? `\n         ${detail}` : ''}`)
  cond ? pass++ : fail++
  return cond
}

const key = await getKey()
if (!key) { console.error('キーが空です'); process.exit(1) }
console.log(`\nモデル: ${MODEL}\n`)

// ── 1) 基本のFunction Calling ──
let toolCall = null
try {
  const res = await chat(key, {
    messages: [{ role: 'user', content: '大阪の天気を教えて' }],
    tools: TOOLS,
    max_tokens: 500,
  })
  const data = await res.json()
  const msg = data.choices?.[0]?.message
  toolCall = msg?.tool_calls?.[0] ?? null
  const args = toolCall ? JSON.parse(toolCall.function.arguments) : null
  ok(
    'tools指定でtool_callsが返る',
    !!toolCall && toolCall.function?.name === 'get_weather' && typeof args?.city === 'string',
    toolCall ? `name=${toolCall.function.name} args=${toolCall.function.arguments}` : `tool_calls無し。content=${(msg?.content ?? '').slice(0, 120)}`,
  )
} catch (e) {
  ok('tools指定でtool_callsが返る', false, e.message)
}

// ── 2) tool結果を返して最終回答を得る ──
if (toolCall) {
  try {
    const res = await chat(key, {
      messages: [
        { role: 'user', content: '大阪の天気を教えて' },
        { role: 'assistant', tool_calls: [toolCall], content: '' },
        { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ weather: '晴れ', temp_c: 24 }) },
      ],
      tools: TOOLS,
      max_tokens: 500,
    })
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? ''
    ok('tool結果→最終回答（ループ1周）', content.includes('晴') || content.includes('24'), `回答=${content.slice(0, 120)}`)
  } catch (e) {
    ok('tool結果→最終回答（ループ1周）', false, e.message)
  }
} else {
  ok('tool結果→最終回答（ループ1周）', false, '前段が失敗のためスキップ')
}

// ── 3) ストリーミングでのtool_calls ──
try {
  const res = await chat(key, {
    messages: [{ role: 'user', content: '札幌の天気を教えて' }],
    tools: TOOLS,
    stream: true,
    max_tokens: 500,
  })
  let sawToolCall = false
  let buf = ''
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf-8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue
      try {
        const j = JSON.parse(line.slice(5))
        if (j.choices?.[0]?.delta?.tool_calls) sawToolCall = true
      } catch {}
    }
  }
  ok('ストリーミングでもtool_callsが返る', sawToolCall)
} catch (e) {
  ok('ストリーミングでもtool_callsが返る', false, e.message)
}

console.log(`\n結果: ${pass} PASS / ${fail} FAIL`)
console.log(fail === 0
  ? '→ Function Calling 完全対応。マーカー方式を正式なツール呼び出しに置き換え可能です。'
  : pass > 0
    ? '→ 部分的に対応。対応範囲に合わせた実装方針を検討します。'
    : '→ 未対応の可能性が高いです。現行のマーカー方式を継続します。')
