#!/usr/bin/env node
/*
 * モデル能力プローブ: さくらのAI Engine の各チャットモデルを実測し、
 * Koto を最適設定にするための「能力一覧」を出力する。
 *
 * 使い方（トークンは端末内のみ。チャットに貼らないこと）:
 *   SAKURA_API_KEY=<キー> node scripts/probe-models.mjs
 *   特定モデルだけ:  SAKURA_API_KEY=<キー> node scripts/probe-models.mjs Qwen3-32B gpt-oss-120b
 *
 * 出力は人間可読の表 ＋ 末尾に JSON。JSON 部分をそのまま共有してもらえれば、
 * supportsTools / 既定モデル / 推論表示 / Web検索の扱い などを実測ベースで調整する。
 *
 * 各モデルにつき少量のトークンを消費する（基本/ツール/文脈追従の3リクエスト。
 * 上限512トークン×3なので最悪でも1モデルあたり約1,500トークン）。
 * 秘密情報（APIキー）は一切出力しない。
 *
 * 2026-07-16 測定条件の改良: max_tokens 30/80/40 → 一律512。
 * 旧条件では推論型モデル（Kimi・gpt-oss等）が「思考」でトークンを使い切り、
 * 答える前に打ち切られて empty/ng になっていた（能力が無いのではなく測れていなかった）。
 * あわせて各テストの completion トークン消費量を記録する（推論の重さの目安になる）。
 */
const MAX_TOKENS = 512
const BASE = 'https://api.ai.sakura.ad.jp/v1'
const NON_CHAT = /whisper|embed|e5-|voicevox|tts|speech|rerank|transcrib/i

const authKey = process.env.SAKURA_API_KEY
if (!authKey) {
  console.error('APIキーが必要です。  SAKURA_API_KEY=<キー> node scripts/probe-models.mjs  （トークンはチャットに貼らないこと）')
  process.exit(2)
}
// 引数があれば、その文字列を含むモデルだけに絞る（例: node scripts/probe-models.mjs Qwen3-32B）
const onlyModels = process.argv.slice(2).filter((a) => !a.startsWith('-'))

async function chat(body) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authKey}` },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - t0
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { ok: res.ok, status: res.status, ms, json, raw: text }
}

const TIME_TOOL = [{
  type: 'function',
  function: { name: 'get_current_time', description: '現在時刻を返す', parameters: { type: 'object', properties: {}, required: [] } },
}]

async function listModels() {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${authKey}` } })
  if (res.status === 401 || res.status === 403) throw new Error('APIキーが無効です（401/403）')
  if (!res.ok) throw new Error(`モデル一覧の取得に失敗（HTTP ${res.status}）`)
  const data = await res.json()
  return (data?.data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string')
}

function bodyMsg(json) {
  const m = json?.choices?.[0]?.message ?? {}
  const content = (m.content ?? '').trim()
  const reasoning = (m.reasoning_content ?? m.reasoning ?? '').trim?.() ?? ''
  const toolCalls = m.tool_calls ?? null
  return { content, reasoning, toolCalls }
}

async function probe(model) {
  const out = { model, basic: '', reasoning: false, tools: '', faithful: '', latencyMs: null, usedTokens: {}, notes: [] }
  // usage.completion_tokens を記録（推論型はここが大きい＝思考の重さの目安）
  const used = (r) => r.json?.usage?.completion_tokens ?? null

  // 1) 基本応答＋推論判定＋レイテンシ
  try {
    const r = await chat({ model, messages: [{ role: 'user', content: '「OK」とだけ返答してください。' }], max_tokens: MAX_TOKENS, temperature: 0.7, top_p: 0.8 })
    out.latencyMs = r.ms
    out.usedTokens.basic = used(r)
    if (!r.ok) { out.basic = `error(${r.status})`; out.notes.push((r.json?.error?.message ?? r.raw ?? '').slice(0, 120)) }
    else {
      const { content, reasoning } = bodyMsg(r.json)
      out.reasoning = !!reasoning
      out.basic = content ? 'ok' : (reasoning ? 'empty(reasoningのみ)' : 'empty')
      // 512与えても使い切って空 → 思考が終わらないモデル。測定条件でなく実運用上も問題になる
      if (!content && used(r) >= MAX_TOKENS) out.notes.push(`basic: ${MAX_TOKENS}tokでも打ち切り（思考が長すぎる）`)
    }
  } catch (e) { out.basic = 'fetch-fail'; out.notes.push(String(e?.message ?? e).slice(0, 120)) }

  // 2) ツール対応（tool_call を出すか / 400 / reasoningへ流れて空）
  try {
    const r = await chat({
      model, max_tokens: MAX_TOKENS, temperature: 0.7, top_p: 0.8,
      tools: TIME_TOOL, tool_choice: 'auto',
      messages: [{ role: 'user', content: '今の時刻を get_current_time ツールで取得して教えてください。' }],
    })
    if (!r.ok) {
      const msg = (r.json?.error?.message ?? r.raw ?? '')
      out.tools = /tool[-_ ]?call[-_ ]?parser|enable[-_ ]?auto[-_ ]?tool[-_ ]?choice|tool[-_ ]?choice/i.test(msg) ? `400(ツール非対応)` : `error(${r.status})`
      if (out.tools.startsWith('error')) out.notes.push(msg.slice(0, 120))
    } else {
      const { content, toolCalls } = bodyMsg(r.json)
      out.usedTokens.tools = used(r)
      out.tools = toolCalls?.length ? 'ok(tool_call)' : (content ? 'no-call(本文で応答)' : 'empty(呼ばず空)')
    }
  } catch (e) { out.tools = 'fetch-fail'; out.notes.push(String(e?.message ?? e).slice(0, 120)) }

  // 3) 注入文脈の追従（＝Web検索結果を使うか）。
  // 実在とわざと食い違う「意味のある数値」を与え、それを答えれば「与えた情報を使う」と判定。
  // 数字なので小モデルでも複写しやすく、ランダム英数字より偽陰性が少ない（ゆるい一致）。
  try {
    const planted = '7392'
    const r = await chat({
      model, max_tokens: MAX_TOKENS, temperature: 0.2, top_p: 0.8,
      messages: [
        { role: 'system', content: `次の参考情報だけを根拠に、推測や一般知識を使わず答えること。参考情報: 富士山の高さは ${planted} メートル。` },
        { role: 'user', content: '富士山の高さは何メートルですか？数字だけ答えてください。' },
      ],
    })
    if (!r.ok) out.faithful = `error(${r.status})`
    else {
      const { content, reasoning } = bodyMsg(r.json)
      out.usedTokens.faithful = used(r)
      // 判定は本文のみ（reasoning は「検討したが採用しなかった」場合も含むため根拠にしない）。
      // 本文が空のまま打ち切られた場合は ng と区別して「測定不能」を明示する
      if (!content && (used(r) ?? 0) >= MAX_TOKENS) out.faithful = 'inconclusive(打ち切り)'
      else out.faithful = content.replace(/[, ]/g, '').includes(planted) ? 'ok(文脈を使う)'
        : (content + reasoning).replace(/[, ]/g, '').includes(planted) ? 'weak(reasoningのみ)' : 'ng(文脈を無視)'
    }
  } catch (e) { out.faithful = 'fetch-fail' }

  return out
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n)

try {
  let ids = await listModels()
  ids = ids.filter((id) => !NON_CHAT.test(id))
  if (onlyModels.length) ids = ids.filter((id) => onlyModels.some((m) => id.includes(m)))
  if (!ids.length) { console.error('対象モデルがありません'); process.exit(1) }

  console.log(`=== モデル能力プローブ（${ids.length}件・各3リクエスト） ===\n`)
  console.log(`${pad('model', 40)} ${pad('basic', 18)} ${pad('reasoning', 10)} ${pad('tools', 18)} ${pad('文脈追従', 22)} latency`)
  console.log('-'.repeat(126))
  const results = []
  for (const id of ids) {
    const r = await probe(id)
    results.push(r)
    console.log(`${pad(id, 40)} ${pad(r.basic, 18)} ${pad(r.reasoning ? 'あり' : 'なし', 10)} ${pad(r.tools, 18)} ${pad(r.faithful, 22)} ${r.latencyMs ?? '-'}ms`)
    if (r.notes.length) console.log(`    ↳ ${r.notes.join(' / ')}`)
  }

  console.log('\n--- 以下の JSON をそのまま共有してください（秘密情報は含みません） ---')
  console.log(JSON.stringify(results, null, 2))
} catch (e) {
  console.error(`\n❌ ${e?.message ?? e}`)
  process.exit(2)
}
