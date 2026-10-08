#!/usr/bin/env node
/*
 * 定期メンテ用（キー不要）: さくらのAI Engine 製品ページの「提供モデルと料金」の表と、
 * Koto の PRICING（src/shared/usageBudget.ts・100万トークンあたり円）を突き合わせる。
 *
 * 役割分担:
 *   npm run check:pricing … キー不要。公式の料金表 × PRICING（料金の一致・新顔・料金を読めなかった行・Koto にだけある）
 *   npm run check:models  … キーが要る。API の提供モデル一覧（/v1/models）× MODELS / PRICING
 *
 * 使い方:
 *   npm run check:pricing
 *
 * 終了コード:
 *   0 … チャット用モデルの料金がすべて一致
 *   1 … 食い違い・新顔・料金を読めなかった行・Koto にだけある のどれかがある（新顔にはそのまま貼れる登録案を出す）
 *       料金を読めなかった行 … 通常・プレビューの表にあるチャット用の行で、料金を Input/Output の形で読めないもの
 *       （黙って捨てると、既存の行が一致しているだけで「差分なし」になるため）
 *   2 … ページを取れない／ページの形が変わって読めない／Koto の設定を読めない
 *       （読み違いのまま「全部一致」と言わないよう、差分を出さずに止める）
 *
 * ※ 新顔の API 名は「区分から導いた候補」。実在は check:models（キーが要る）かお知らせで確かめる。
 */
import { readAppConfig } from './lib/appConfig.mjs'
import {
  PRICING_PAGE_URL, parsePricingPage, comparePricing, formatReport, exitCodeFor,
} from './lib/pricingPage.mjs'

const FETCH_TIMEOUT_MS = 30_000

function todayLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function fetchPage() {
  let res
  try {
    res = await fetch(PRICING_PAGE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' })
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `${FETCH_TIMEOUT_MS / 1000}秒で応答がありませんでした` : (e?.cause?.message ?? e?.message ?? String(e))
    throw new Error(`製品ページを取得できませんでした（${why}）: ${PRICING_PAGE_URL}`)
  }
  if (!res.ok) throw new Error(`製品ページを取得できませんでした（HTTP ${res.status}）: ${PRICING_PAGE_URL}`)
  return await res.text()
}

let cfg
try {
  cfg = readAppConfig()
} catch (e) {
  console.error(`❌ ${e?.message ?? e}`)
  process.exit(2)
}

let html
try {
  html = await fetchPage()
} catch (e) {
  console.error(`❌ ${e?.message ?? e}`)
  process.exit(2)
}

let result
try {
  result = comparePricing(parsePricingPage(html), cfg.pricing)
} catch (e) {
  console.error(`❌ ${e?.message ?? e}`)
  console.error('   差分は出していません。ページ（提供モデルと料金）を目で確かめてください: ' + PRICING_PAGE_URL)
  process.exit(2)
}

const lines = formatReport(result, { today: todayLocal(), knownModelIds: [...cfg.models, ...cfg.visionModels] })
console.log(lines.join('\n'))
process.exit(exitCodeFor(result))
