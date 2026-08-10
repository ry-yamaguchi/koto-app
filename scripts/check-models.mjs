#!/usr/bin/env node
/*
 * 定期メンテ用: さくらのAI Engine の「現在の提供モデル」と、アプリ側の固定設定
 * （src/renderer/usage.ts の MODELS / VISION_MODELS / PRICING / DEFAULT_MODEL）を
 * 突き合わせ、更新が必要な差分を一覧表示する。
 *
 * 使い方:
 *   SAKURA_API_KEY=<キー> npm run check:models
 *   または  node scripts/check-models.mjs <キー>
 *
 * 差分があれば終了コード 1（CI/リリース前ゲートにも使える）。
 * ※ 価格(PRICING)はAPIから取れないため自動更新はできない。本スクリプトは
 *   「何を見直すべきか」を示すだけ。実際の単価はさくらの公開情報で確認して反映する。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const MODELS_URL = 'https://api.ai.sakura.ad.jp/v1/models'
// usage.ts の NON_CHAT と一致させること（チャット用途でないモデルを除外）
const NON_CHAT = /whisper|embed|e5-|voicevox|tts|speech|rerank|transcrib/i

const here = dirname(fileURLToPath(import.meta.url))
const USAGE_PATH = resolve(here, '../src/renderer/usage.ts')

const key = process.env.SAKURA_API_KEY || process.argv[2]
if (!key) {
  console.error('APIキーが必要です。  SAKURA_API_KEY=<キー> npm run check:models  または  node scripts/check-models.mjs <キー>')
  process.exit(2)
}

// ── usage.ts から固定設定を抽出（データファイル化していないため正規表現で読む） ──
function readUsageConfig() {
  const src = readFileSync(USAGE_PATH, 'utf-8')
  const idsIn = (name) => {
    const block = src.match(new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`))
    return block ? [...block[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]) : []
  }
  const pricingKeys = (() => {
    const block = src.match(/export const PRICING[^=]*=\s*\{([\s\S]*?)\n\}/)
    return block ? [...block[1].matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]) : []
  })()
  const def = src.match(/const DEFAULT_MODEL\s*=\s*'([^']+)'/)
  return {
    models: idsIn('MODELS'),
    visionModels: idsIn('VISION_MODELS'),
    pricing: pricingKeys,
    defaultModel: def ? def[1] : null,
  }
}

async function fetchLiveModels() {
  const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${key}` } })
  if (res.status === 401 || res.status === 403) throw new Error('APIキーが無効です（401/403）')
  if (!res.ok) throw new Error(`モデル一覧の取得に失敗（HTTP ${res.status}）`)
  const data = await res.json()
  const ids = (data?.data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string')
  return ids
}

const diff = (a, b) => a.filter((x) => !b.includes(x))
const section = (title, items, note) => {
  if (!items.length) return false
  console.log(`\n● ${title}（${items.length}件）`)
  if (note) console.log(`  ${note}`)
  for (const it of items) console.log(`    - ${it}`)
  return true
}

try {
  const cfg = readUsageConfig()
  const liveAll = await fetchLiveModels()
  const liveChat = liveAll.filter((id) => !NON_CHAT.test(id))
  const known = [...new Set([...cfg.models, ...cfg.visionModels])]

  console.log('=== さくらのAI Engine 提供モデル × アプリ設定 の差分 ===')
  console.log(`提供モデル: ${liveAll.length}件（うちチャット候補 ${liveChat.length}件） / アプリ既知: ${known.length}件`)

  let needsUpdate = false
  // 1) 新規モデル（提供されているがアプリの一覧に無い）→ ラベル/価格/tools・vision の検討
  needsUpdate = section(
    '新規モデル（usage.ts の MODELS/VISION_MODELS に追加検討）',
    diff(liveChat, known),
    'ラベルを付け、価格(PRICING)・画像対応(isVisionModel)・ツール対応(supportsTools)を確認すること。',
  ) || needsUpdate
  // 2) 提供終了（アプリの一覧にあるが、もう提供されていない）→ 削除候補
  needsUpdate = section(
    '提供終了モデル（usage.ts から削除検討）',
    diff(known, liveAll),
    '提供一覧に無い。MODELS/VISION_MODELS/PRICING から削除してよい（既定モデルなら DEFAULT_MODEL も見直し）。',
  ) || needsUpdate
  // 3) 価格未設定（提供中のチャットモデルだが PRICING に無い）→ 既定単価で概算＝コストがズレる
  needsUpdate = section(
    '価格未設定モデル（PRICING に追記推奨）',
    diff(liveChat, cfg.pricing),
    '既定単価で概算されるため、利用額表示がズレる可能性あり。公開単価を PRICING に追記すること。',
  ) || needsUpdate
  // 4) 価格表に残る提供終了エントリ
  needsUpdate = section(
    '不要な価格エントリ（PRICING から削除検討）',
    diff(cfg.pricing, liveAll),
    '提供されていないモデルの価格が残っている。',
  ) || needsUpdate
  // 5) 既定モデルの健全性
  if (cfg.defaultModel && !liveAll.includes(cfg.defaultModel)) {
    needsUpdate = true
    console.log(`\n● 既定モデルが提供一覧に無い`)
    console.log(`    DEFAULT_MODEL = ${cfg.defaultModel}`)
    console.log('    実行時は pickBestModel でフォールバックするが、DEFAULT_MODEL の更新を推奨。')
  }

  if (!needsUpdate) {
    console.log('\n✅ 差分なし。MODELS / VISION_MODELS / PRICING / DEFAULT_MODEL は最新です。')
    process.exit(0)
  }
  console.log('\n⚠️ 上記を src/renderer/usage.ts に反映してください（価格はさくらの公開単価を確認）。')
  process.exit(1)
} catch (e) {
  console.error(`\n❌ ${e?.message ?? e}`)
  process.exit(2)
}
