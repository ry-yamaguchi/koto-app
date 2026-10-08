// appConfig.mjs — Koto の固定設定を読む（check-models.mjs と check-pricing.mjs が共用する・掟10: 複製しない）。
// NON_CHAT は probe-models.mjs も使う（scripts/ の中に複製を持たない）。
//
// 読むもの:
//   src/shared/modelInfo.ts   … MODELS / VISION_MODELS の id、DEFAULT_MODEL
//   src/shared/usageBudget.ts … PRICING（キーと値。¥/100万トークン の { in, out }）
// データファイル化していないため、ソースを正規表現で読む。
//
// ⚠️ 沈黙の誤診をしない（2026-09-04 実発）:
//   一覧の実体が shared へ移ったとき check-models.mjs が追従しておらず、抽出が0件のまま
//   「アプリ既知: 0件」と全モデルを新規扱いした。抽出0件は「モデルが無い」ではなく
//   「読み先がずれた」と見なし、例外で止める。PRICING の値が読めない行が1つでもあるときも止める
//   （読めた分だけで照合すると、読めなかったモデルを「Koto に無い」と言ってしまう）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const MODEL_INFO_PATH = resolve(here, '../../src/shared/modelInfo.ts')     // MODELS / VISION_MODELS / DEFAULT_MODEL
export const USAGE_BUDGET_PATH = resolve(here, '../../src/shared/usageBudget.ts') // PRICING

// チャット用途でないモデル（音声認識・埋め込み・音声合成・リランク等）を外す判定。
// src/renderer/usage.ts の NON_CHAT と一致させること（tests/checkPricing.test.ts が照合している）。
export const NON_CHAT = /whisper|embed|e5-|voicevox|tts|speech|rerank|transcrib/i

const NUM = String.raw`(\d+(?:\.\d+)?)`

/** 配列定義（export const NAME ... = [ ... ]）の中の id: '...' を順に拾う */
function idsIn(src, name) {
  const block = src.match(new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`))
  return block ? [...block[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]) : []
}

/**
 * PRICING のキーと値を読む。
 * 返り値: { prices: { id: { in, out } }, unreadable: [id...] }
 * キーらしき行（'id': ...）はすべて拾い、値が { in: 数, out: 数 } の形で読めなかったものは unreadable へ。
 */
function readPricing(src) {
  const block = src.match(/export const PRICING[^=]*=\s*\{([\s\S]*?)\n\}/)
  const prices = {}
  const unreadable = []
  if (!block) return { prices, unreadable }
  const valueRe = new RegExp(String.raw`^\{\s*in:\s*${NUM}\s*,\s*out:\s*${NUM}\s*\}`)
  for (const m of block[1].matchAll(/^\s*(['"])([^'"]+)\1\s*:\s*(.*)$/gm)) {
    const id = m[2]
    const v = m[3].match(valueRe)
    if (!v) { unreadable.push(id); continue }
    prices[id] = { in: Number(v[1]), out: Number(v[2]) }
  }
  return { prices, unreadable }
}

/**
 * ソースの文字列から固定設定を取り出す（純関数・テスト用に分けてある）。
 * 抽出0件・値の読めない PRICING 行があれば例外（沈黙の誤診をしない）。
 * @param {string} modelInfo   src/shared/modelInfo.ts の中身
 * @param {string} usageBudget src/shared/usageBudget.ts の中身
 * @param {{ modelInfo?: string, usageBudget?: string }} [where] エラー文に出す読み先の名前
 * @returns {{ models: string[], visionModels: string[], pricing: Record<string, {in:number,out:number}>, defaultModel: string }}
 */
export function parseAppConfig(modelInfo, usageBudget, where = {}) {
  const miName = where.modelInfo ?? 'src/shared/modelInfo.ts'
  const ubName = where.usageBudget ?? 'src/shared/usageBudget.ts'
  const { prices, unreadable } = readPricing(usageBudget)
  const def = modelInfo.match(/const DEFAULT_MODEL\s*=\s*'([^']+)'/)
  const cfg = {
    models: idsIn(modelInfo, 'MODELS'),
    visionModels: idsIn(modelInfo, 'VISION_MODELS'),
    pricing: prices,
    defaultModel: def ? def[1] : null,
  }
  const pricingCount = Object.keys(prices).length
  if (!cfg.models.length || !pricingCount || !cfg.defaultModel) {
    throw new Error(
      '固定設定を読み取れませんでした。定義が移動していないか確認してください: '
      + `MODELS=${cfg.models.length}件(${miName}) / PRICING=${pricingCount}件(${ubName}) / DEFAULT_MODEL=${cfg.defaultModel ?? '無し'}`,
    )
  }
  if (unreadable.length) {
    throw new Error(
      `PRICING の値を読み取れない行があります（{ in: 数, out: 数 } の形で書かれていない）: ${unreadable.join(', ')}（${ubName}）`,
    )
  }
  return cfg
}

/** Koto のソースから固定設定を読む（ファイル読み込み付き）。 */
export function readAppConfig(paths = {}) {
  const miPath = paths.modelInfo ?? MODEL_INFO_PATH
  const ubPath = paths.usageBudget ?? USAGE_BUDGET_PATH
  return parseAppConfig(readFileSync(miPath, 'utf-8'), readFileSync(ubPath, 'utf-8'), {
    modelInfo: miPath,
    usageBudget: ubPath,
  })
}
