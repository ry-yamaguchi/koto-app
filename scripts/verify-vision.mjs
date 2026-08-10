#!/usr/bin/env node
// 画像添付時に「切替の表示だけ出て回答が来ない」問題の診断スクリプト。
// アプリと同じ条件（visionモデル・tools無し・マルチモーダルcontent）で実APIを呼び、
// 応答が content / reasoning / それ以外 のどこに出るかを表示する。
//
// 使い方:
//   cd ~/sakura-ide && node scripts/verify-vision.mjs
//   モデルを指定:  SAKURA_API_KEY=<キー> node scripts/verify-vision.mjs preview/Kimi-K2.6
//   （引数を省略すると既定の一覧を検証する）

import { createInterface } from 'node:readline/promises'

const BASE = 'https://api.ai.sakura.ad.jp/v1'
// アプリが画像添付時に自動選択するモデル（usage.ts の DEFAULT_VISION_MODEL と同じ）。
// 引数でモデルIDを渡せばそれを検証する（例: Kimi-K2.6 の画像入力可否の実測）。
// ※ Kimi-K2.5 は提供終了（2026-06実測: not available）。K2.6 は 2026-07-14 時点で画像入力が未実測。
const DEFAULT_VISION_MODELS = ['preview/Qwen3-VL-30B-A3B-Instruct']
const VISION_MODELS = process.argv.slice(2).filter(a => !a.startsWith('-'))
VISION_MODELS.length || VISION_MODELS.push(...DEFAULT_VISION_MODELS)

// 1x1の赤いPNG（有効な最小画像）
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function getKey() {
  if (process.env.SAKURA_API_KEY) return process.env.SAKURA_API_KEY.trim()
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const key = (await rl.question('さくらのAI Engine のAPIキーを入力: ')).trim()
  rl.close()
  return key
}

// アプリと同じストリーミング処理（tools無し）
async function streamVision(key, model, messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, max_tokens: 1024, stream: true, stream_options: { include_usage: true } }),
    signal: AbortSignal.timeout(90000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  let content = ''
  let reasoning = ''
  let finish = null
  const otherKeys = new Set()
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
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content
      else if (typeof d.reasoning === 'string') reasoning += d.reasoning
      for (const k of Object.keys(d)) if (!['content', 'role', 'reasoning_content', 'reasoning', 'tool_calls'].includes(k)) otherKeys.add(k)
    }
  }
  return { content, reasoning, finish, otherKeys: [...otherKeys] }
}

const key = await getKey()
if (!key) { console.error('キーが空です'); process.exit(1) }

// アプリのIDEパネルと同等のメッセージ（system + マルチモーダルuser）
const messages = [
  { role: 'system', content: 'あなたはIDEのAIアシスタントです。回答は日本語で簡潔に。' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'この画像には何が写っていますか？一言で答えてください。' },
      { type: 'image_url', image_url: { url: TINY_PNG } },
    ],
  },
]

let anyFail = false
for (const model of VISION_MODELS) {
  console.log(`\n========== モデル: ${model} ==========`)
  try {
    const r = await streamVision(key, model, messages)
    console.log(`content: ${r.content.trim().length}文字 / reasoning: ${r.reasoning.trim().length}文字 / finish: ${r.finish}` +
      (r.otherKeys.length ? ` / その他のdeltaフィールド: ${r.otherKeys.join(',')}` : ''))
    if (r.content.trim()) {
      console.log(`✅ PASS: contentに回答あり（${r.content.trim().slice(0, 60)}…）`)
    } else if (r.reasoning.trim()) {
      console.log(`⚠️ 回答がreasoningに出ている（アプリのフォールバックで表示可能）: ${r.reasoning.trim().slice(0, 60)}…`)
    } else {
      console.log('❌ FAIL: content・reasoningとも空（アプリの「回答なし」を再現）')
      anyFail = true
    }
  } catch (e) {
    console.log(`❌ FAIL: ${e.message}`)
    anyFail = true
  }
}
console.log('\n→ この出力を貼り付けてください。あわせて、アプリを⌘Qで完全終了→再起動済みかも教えてください。')
process.exit(anyFail ? 1 : 0)
