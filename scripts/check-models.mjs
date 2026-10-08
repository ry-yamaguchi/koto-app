#!/usr/bin/env node
/*
 * 定期メンテ用: さくらのAI Engine の「現在の提供モデル」と、アプリ側の固定設定
 * （src/shared/modelInfo.ts の MODELS / VISION_MODELS / DEFAULT_MODEL と、
 *   src/shared/usageBudget.ts の PRICING）を突き合わせ、更新が必要な差分を一覧表示する。
 *
 * 役割分担: こちらはキーが要り、API の提供モデル一覧（/v1/models）を見る。料金の値は
 * npm run check:pricing（キー不要・製品ページの公式料金表 × PRICING）が見る。
 * 固定設定の読み取りと NON_CHAT は scripts/lib/appConfig.mjs を両方で共用する（複製しない）。
 *
 * ⚠️ 2026-09-04: 読み先を usage.ts → shared へ修正した。B'-3d-1a（2026-08-29 ごろ）で
 * 一覧の実体が shared へ移った際、このスクリプトが追従しておらず「アプリ既知: 0件」と
 * 全モデルを新規扱いする誤診をしていた（Ryosuke の実行で発覚）。再発防止として、
 * 抽出が0件のときは差分を出さずエラーで止まる（沈黙の誤診をしない）。
 *
 * 使い方:
 *   SAKURA_API_KEY=<キー> npm run check:models
 *   または  node scripts/check-models.mjs <キー>
 *
 * 差分があれば終了コード 1（CI/リリース前ゲートにも使える）。
 * ※ 価格(PRICING)はAPIから取れないため自動更新はできない。本スクリプトは
 *   「何を見直すべきか」を示すだけ。実際の単価はさくらの公開情報で確認して反映する。
 */
// 固定設定の読み取り（抽出0件なら例外＝沈黙の誤診をしない）と NON_CHAT（renderer/usage.ts と一致・
// チャット用途でないモデルを除外）は lib に置き、check-pricing.mjs と共用する。
import { readAppConfig, NON_CHAT } from './lib/appConfig.mjs'

const MODELS_URL = 'https://api.ai.sakura.ad.jp/v1/models'

const key = process.env.SAKURA_API_KEY || process.argv[2]
if (!key) {
  console.error('APIキーが必要です。  SAKURA_API_KEY=<キー> npm run check:models  または  node scripts/check-models.mjs <キー>')
  process.exit(2)
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
  for (const line of [].concat(note ?? [])) console.log(`  ${line}`)
  for (const it of items) console.log(`    - ${it}`)
  return true
}

try {
  const cfg = readAppConfig()
  const liveAll = await fetchLiveModels()
  const liveChat = liveAll.filter((id) => !NON_CHAT.test(id))
  const known = [...new Set([...cfg.models, ...cfg.visionModels])]
  const pricingIds = Object.keys(cfg.pricing) // PRICING のキー（値は check:pricing が照合する）

  console.log('=== さくらのAI Engine 提供モデル × アプリ設定 の差分 ===')
  console.log(`提供モデル: ${liveAll.length}件（うちチャット候補 ${liveChat.length}件） / アプリ既知: ${known.length}件`)

  let needsUpdate = false
  // 1) 新規モデル（提供されているがアプリの一覧に無い）→ ラベル/価格/tools・vision の検討
  needsUpdate = section(
    '新規モデル（modelInfo.ts の MODELS/VISION_MODELS に追加検討）',
    diff(liveChat, known),
    'ラベルを付け、価格(PRICING)・画像対応(isVisionModel)・ツール対応(supportsTools)を確認すること。',
  ) || needsUpdate
  // 2) 提供終了（アプリの一覧にあるが、もう提供されていない）→ 削除候補
  needsUpdate = section(
    '提供終了モデル（modelInfo.ts / usageBudget.ts から削除検討）',
    diff(known, liveAll),
    '提供一覧に無い。MODELS/VISION_MODELS/PRICING から削除してよい（既定モデルなら DEFAULT_MODEL も見直し）。',
  ) || needsUpdate
  // 3) 価格未設定（提供中のチャットモデルだが PRICING に無い）→ 料金表でいちばん高い単価で見積もる＝実際の額とズレる
  needsUpdate = section(
    '価格未設定モデル（PRICING に追記推奨）',
    diff(liveChat, pricingIds),
    [
      '料金表でいちばん高い単価（src/shared/usageBudget.ts の DEFAULT_PRICE）で見積もるため、利用額表示が実際の料金と合わない（料金表のどれより高いモデルだと少なく数える）。公開単価を PRICING に追記すること。',
      '公開単価との照合と登録案は npm run check:pricing（キー不要・製品ページの公式料金表 × PRICING）で出せる。',
    ],
  ) || needsUpdate
  // 4) 価格表に残る提供終了エントリ
  needsUpdate = section(
    '不要な価格エントリ（PRICING から削除検討）',
    diff(pricingIds, liveAll),
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
  console.log('\n⚠️ 上記を src/shared/modelInfo.ts（一覧・既定モデル）と src/shared/usageBudget.ts（PRICING）に反映してください（価格はさくらの公開単価を確認）。')
  process.exit(1)
} catch (e) {
  console.error(`\n❌ ${e?.message ?? e}`)
  process.exit(2)
}
