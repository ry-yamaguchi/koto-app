/*
 * さくらのAI Engine の利用量・予算管理（クライアント側セーフガード）
 *
 * 注意: 実際の課金はさくらインターネットのアカウントで管理されます。
 * ここでは消費トークンを記録し、内蔵の料金表で利用額を推定して、
 * ユーザーが設定した月間上限に達したらリクエストを止めるための仕組みです。
 */

/** 利用可能なモデル（UI表示用ラベル付き） */
// ============================================================================
// 【メンテナンス】さくらのAI Engine の提供モデル・単価の変化に追従すること
//   1. 差分チェック:  SAKURA_API_KEY=<キー> npm run check:models
//      → 提供モデルと下記 MODELS/VISION_MODELS/PRICING を突き合わせ、
//        新規モデル／提供終了／価格未設定 を一覧表示する（scripts/check-models.mjs）
//   2. 公開単価はさくらの情報で確認（APIから取れないため手動）:
//      https://ai.sakura.ad.jp/sakura-ai/ai-engine/ ／ コントロールパネルの提供モデル
//   3. 差分を MODELS / VISION_MODELS / PRICING に反映し、DEFAULT_MODEL を
//      「その時点でコード作成に最も適したモデル」に見直す
//   最終確認: v0.1.0（2026-06 時点の最適は Qwen3-Coder-480B-A35B-Instruct-FP8）
// ============================================================================

// さくらのAI Engine のモデルID（「Qwen/」等のプレフィックスは付かない）
export const MODELS: { id: string; label: string }[] = [
  { id: 'Qwen3-Coder-480B-A35B-Instruct-FP8', label: 'Qwen3-Coder 480B' },
  { id: 'Qwen3-Coder-30B-A3B-Instruct', label: 'Qwen3-Coder 30B' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
  { id: 'llm-jp-3.1-8x13b-instruct4', label: 'llm-jp 3.1 8x13b（日本語）' },
  // 2026-07-14 ユーザー実測（probe-models.mjs）で tools=ok を確認しツール（ファイル参照）対応に昇格。
  { id: 'preview/Kimi-K2.6', label: 'Kimi K2.6（プレビュー）' },
]

/** マルチモーダル（画像入力）対応モデル（さくらのAI Engine パブリックプレビュー） */
export const VISION_MODELS: { id: string; label: string }[] = [
  { id: 'preview/Qwen3-VL-30B-A3B-Instruct', label: 'Qwen3-VL 30B（画像対応・プレビュー）' },
  { id: 'preview/Phi-4-multimodal-instruct', label: 'Phi-4 マルチモーダル（プレビュー）' },
]
const VISION_IDS = new Set(VISION_MODELS.map(m => m.id))

/** モデルが画像入力に対応しているか（ID命名からも推定）。
 *  kimi-k2.6: 2026-07-14 ユーザー実測（verify-vision.mjs）で画像を直接読めることを確認（content に回答）→
 *  画像添付時に2段階処理（Qwen3-VLで読み取り→本来モデルで実行）を挟まず、そのまま読ませる。
 *  ※ 提供終了した K2.5 と区別するためバージョンまで含めて判定する。 */
export function isVisionModel(id: string): boolean {
  return VISION_IDS.has(id) || /-VL-|multimodal|kimi-k2\.6/i.test(id)
}

// 画像送信時に既定で使うvisionモデル（コード理解も得意な Qwen3-VL を優先）
const DEFAULT_VISION_MODEL = 'preview/Qwen3-VL-30B-A3B-Instruct'

/** 画像を送るときに使うモデルを決める（提供一覧にある実IDを優先） */
export function getDefaultVisionModel(): string {
  const ids = getCachedModelIds()
  if (ids.includes(DEFAULT_VISION_MODEL)) return DEFAULT_VISION_MODEL
  return ids.find(isVisionModel) ?? DEFAULT_VISION_MODEL
}

export function modelLabel(id: string): string {
  return [...MODELS, ...VISION_MODELS].find(m => m.id === id)?.label ?? id
}

const MODELS_CACHE_KEY = 'sakura_models_cache'

// チャット用途でないモデル（音声・埋め込み・音声合成・リランク等）を除外するための簡易判定
const NON_CHAT = /whisper|embed|e5-|voicevox|tts|speech|rerank|transcrib/i

/** キャッシュ済みのモデルID一覧（無ければ既定のMODELS） */
export function getCachedModelIds(): string[] {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY)
    const ids = raw ? JSON.parse(raw) : null
    if (Array.isArray(ids) && ids.length) return ids
  } catch {}
  return MODELS.map(m => m.id)
}

/** さくらのAI Engine から利用可能なチャットモデルを取得してキャッシュする（メインプロセス経由） */
export async function fetchModels(apiKey: string): Promise<string[]> {
  const all = await window.electronAPI.sakura.models(apiKey)
  const ids = all.filter((id) => typeof id === 'string' && !NON_CHAT.test(id))
  if (ids.length) localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(ids))
  return ids
}

/** ¥ / 1,000,000 トークン（2026年時点の従量課金プランの公開単価を基にした概算） */
export const PRICING: Record<string, { in: number; out: number }> = {
  // ¥/1,000,000 tokens（公式ページ https://ai.sakura.ad.jp/sakura-ai/ai-engine/ の ¥/1万tok ×100）
  'Qwen3-Coder-480B-A35B-Instruct-FP8': { in: 30, out: 250 },  // 0.3 / 2.5 円（1万tok）
  'Qwen3-Coder-30B-A3B-Instruct': { in: 15, out: 75 },         // 0.15 / 0.75
  'gpt-oss-120b': { in: 15, out: 75 },                         // 0.15 / 0.75
  'llm-jp-3.1-8x13b-instruct4': { in: 15, out: 75 },           // 0.15 / 0.75
  'preview/Qwen3-VL-30B-A3B-Instruct': { in: 10, out: 30 },    // 0.1 / 0.3
  'preview/Phi-4-multimodal-instruct': { in: 10, out: 30 },    // 0.1 / 0.3
  'preview/Phi-4-mini-instruct-cpu': { in: 1, out: 3 },        // 0.01 / 0.03
  'preview/Qwen3-0.6B-cpu': { in: 1, out: 3 },                 // 0.01 / 0.03
  'preview/Qwen3.6-35B-A3B': { in: 30, out: 150 },             // 0.3 / 1.5
  'preview/Kimi-K2.6': { in: 60, out: 300 },                   // 0.6 / 3
}
const DEFAULT_PRICE = { in: 15, out: 75 }

export function priceFor(model: string) {
  return PRICING[model] ?? DEFAULT_PRICE
}

const LEGACY_MODEL_KEY = 'sakura_default_model' // 旧・共通設定（IDE/チャット共通だった頃）からの移行用
const MODEL_PREF_KEY = { ide: 'sakura_model_ide', chat: 'sakura_model_chat' } as const
export type ChatMode = 'ide' | 'chat'

// IDE（コード/エージェント）は品質重視、チャット（会話/調査）は速度重視を既定にする。
// ※ バージョンアップ時は npm run check:models / probe:models で見直すこと
const DEFAULT_MODEL = 'Qwen3-Coder-480B-A35B-Instruct-FP8'   // IDE 既定（コード最適）
const DEFAULT_CHAT_MODEL = 'Qwen3-Coder-30B-A3B-Instruct'    // チャット既定（高速）

export function getDefaultModel(mode: ChatMode = 'ide'): string {
  return localStorage.getItem(MODEL_PREF_KEY[mode])
    ?? localStorage.getItem(LEGACY_MODEL_KEY)                // 旧・共通設定からの移行
    ?? (mode === 'chat' ? DEFAULT_CHAT_MODEL : DEFAULT_MODEL)
}

/**
 * 提供中のモデル一覧から「コード作成に最適な」モデルを選ぶ。
 * 既定モデルが提供終了した場合のフォールバックに使う（Coder系 → Qwen3系 → 先頭）。
 */
export function pickBestModel(ids: string[]): string {
  if (!ids.length) return DEFAULT_MODEL
  return (
    ids.find(id => /coder/i.test(id) && /480/.test(id)) ??
    ids.find(id => /coder/i.test(id)) ??
    ids.find(id => /^qwen3/i.test(id)) ??
    ids[0]
  )
}

export function setDefaultModel(id: string, mode: ChatMode = 'ide') {
  localStorage.setItem(MODEL_PREF_KEY[mode], id)
  window.dispatchEvent(new Event('sakura-usage-changed'))
}

export interface BudgetSettings {
  monthlyLimitYen: number | null // 既定の月間上限（キー個別未設定時に適用。null = 無制限）
  enforce: boolean // 上限到達時にリクエストを停止する
  warnRatio: number // この割合で警告（0〜1）
  perKeyLimits: Record<string, number | null> // キー指紋 → 個別上限（null = 無制限）
}

export const DEFAULT_SETTINGS: BudgetSettings = {
  monthlyLimitYen: 500,
  enforce: true,
  warnRatio: 0.8,
  perKeyLimits: {},
}

const SETTINGS_KEY = 'sakura_budget_settings'
const USAGE_KEY = 'sakura_usage_by_month'

export function getSettings(): BudgetSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const s = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS }
    if (!s.perKeyLimits || typeof s.perKeyLimits !== 'object') s.perKeyLimits = {}
    return s
  } catch {
    return { ...DEFAULT_SETTINGS, perKeyLimits: {} }
  }
}

export function setSettings(s: BudgetSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  window.dispatchEvent(new Event('sakura-usage-changed'))
}

/** APIキーの安定した指紋（生のキーは保存しない）。FNV-1a。 */
export function hashKey(key: string): string {
  if (!key) return '(none)'
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'k' + (h >>> 0).toString(36)
}

// ── キー個別の上限 ─────────────────────────────
/** undefined = 未設定（既定を使う）, null = 無制限, number = 金額 */
export function getKeyLimit(apiKey: string): number | null | undefined {
  const s = getSettings()
  const fp = hashKey(apiKey)
  return Object.prototype.hasOwnProperty.call(s.perKeyLimits, fp) ? s.perKeyLimits[fp] : undefined
}

export function setKeyLimit(apiKey: string, limit: number | null | undefined) {
  if (!apiKey) return
  const s = getSettings()
  const fp = hashKey(apiKey)
  const perKeyLimits = { ...s.perKeyLimits }
  if (limit === undefined) delete perKeyLimits[fp]
  else perKeyLimits[fp] = limit
  setSettings({ ...s, perKeyLimits })
}

/** 実効上限（個別→既定の順に解決）。null = 無制限 */
export function effectiveLimit(apiKey: string): number | null {
  const explicit = getKeyLimit(apiKey)
  if (explicit !== undefined) return explicit
  return getSettings().monthlyLimitYen
}

// ── 利用量ストア（月 → キー → モデル） ─────────────
interface ModelUsage { promptTokens: number; completionTokens: number; costYen: number }
interface KeyBucket { models: Record<string, ModelUsage> }
interface MonthBucket { keys: Record<string, KeyBucket> }
type UsageStore = Record<string, MonthBucket>

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 旧フォーマット（{models}/{promptTokens}）も読み込めるよう正規化する。 */
function normalizeMonth(raw: any): MonthBucket {
  if (raw && raw.keys && typeof raw.keys === 'object') return raw as MonthBucket
  if (raw && raw.models && typeof raw.models === 'object') {
    return { keys: { '(以前の利用)': { models: raw.models } } }
  }
  return { keys: {} }
}

function readStore(): UsageStore {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    const out: UsageStore = {}
    for (const [month, bucket] of Object.entries(parsed)) out[month] = normalizeMonth(bucket)
    return out
  } catch {
    return {}
  }
}

function writeStore(s: UsageStore) {
  localStorage.setItem(USAGE_KEY, JSON.stringify(s))
  window.dispatchEvent(new Event('sakura-usage-changed'))
}

export interface MonthUsage {
  month: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costYen: number
}

export interface ModelUsageRow {
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costYen: number
}

function currentMonth(): MonthBucket {
  return readStore()[thisMonth()] ?? { keys: {} }
}

function sumModels(models: Record<string, ModelUsage>) {
  let p = 0, c = 0, cost = 0
  for (const u of Object.values(models)) { p += u.promptTokens; c += u.completionTokens; cost += u.costYen }
  return { promptTokens: p, completionTokens: c, costYen: cost }
}

/** 今月の全キー・全モデルの合計 */
export function getUsage(): MonthUsage {
  const month = currentMonth()
  let p = 0, c = 0, cost = 0
  for (const kb of Object.values(month.keys)) {
    const s = sumModels(kb.models)
    p += s.promptTokens; c += s.completionTokens; cost += s.costYen
  }
  return { month: thisMonth(), promptTokens: p, completionTokens: c, totalTokens: p + c, costYen: cost }
}

/** 今月のモデル別利用（全キー横断・金額の大きい順） */
export function getUsageByModel(): ModelUsageRow[] {
  const month = currentMonth()
  const agg: Record<string, ModelUsage> = {}
  for (const kb of Object.values(month.keys)) {
    for (const [model, u] of Object.entries(kb.models)) {
      const a = agg[model] ?? { promptTokens: 0, completionTokens: 0, costYen: 0 }
      a.promptTokens += u.promptTokens; a.completionTokens += u.completionTokens; a.costYen += u.costYen
      agg[model] = a
    }
  }
  return Object.entries(agg)
    .map(([model, u]) => ({ model, promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.promptTokens + u.completionTokens, costYen: u.costYen }))
    .sort((a, b) => b.costYen - a.costYen)
}

/** 指定キーの今月の利用 */
export function getUsageForKey(apiKey: string): MonthUsage {
  const fp = hashKey(apiKey)
  const kb = currentMonth().keys[fp] ?? { models: {} }
  const s = sumModels(kb.models)
  return { month: thisMonth(), promptTokens: s.promptTokens, completionTokens: s.completionTokens, totalTokens: s.promptTokens + s.completionTokens, costYen: s.costYen }
}

/** 1回のAPI利用を記録する（キー指紋＋モデル別）。 */
export function recordUsage(apiKey: string, model: string, promptTokens: number, completionTokens: number) {
  // トークン数と課金額は**同じ値から**計算する。以前はトークン数だけ Math.max(0,…) で守られ、
  // 課金額は生の値を使っていたため、異常な応答（負値）が来ると**利用額が減り**、
  // 上限に達したキーがまた使えてしまった（2026-08-05 修正・tests/usageBudget.test.ts）。
  const p = Number.isFinite(promptTokens) ? Math.max(0, Math.round(promptTokens)) : 0
  const c = Number.isFinite(completionTokens) ? Math.max(0, Math.round(completionTokens)) : 0
  const price = priceFor(model)
  const cost = (p / 1_000_000) * price.in + (c / 1_000_000) * price.out
  const store = readStore()
  const m = thisMonth()
  const fp = hashKey(apiKey)
  const month = store[m] ?? { keys: {} }
  const kb = month.keys[fp] ?? { models: {} }
  const u = kb.models[model] ?? { promptTokens: 0, completionTokens: 0, costYen: 0 }
  u.promptTokens += p
  u.completionTokens += c
  u.costYen += cost
  kb.models[model] = u
  month.keys[fp] = kb
  store[m] = month
  writeStore(store)
}

/** 今月分の利用量をリセット */
export function resetThisMonth() {
  const store = readStore()
  delete store[thisMonth()]
  writeStore(store)
}

/** 大まかなトークン見積り（APIがusageを返さない場合のフォールバック）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  for (const ch of text) tokens += ch.charCodeAt(0) > 0x7f ? 1 : 0.25
  return Math.ceil(tokens)
}

export interface BudgetStatus {
  limit: number | null
  cost: number
  ratio: number | null
  over: boolean
  warn: boolean
}

/** 全体の状況（合計コスト vs 既定上限）。設定画面のヘッドライン用。 */
export function budgetStatus(): BudgetStatus {
  const s = getSettings()
  const cost = getUsage().costYen
  const limit = s.monthlyLimitYen
  if (limit == null || limit <= 0) return { limit: null, cost, ratio: null, over: false, warn: false }
  const ratio = cost / limit
  return { limit, cost, ratio, over: ratio >= 1, warn: ratio >= s.warnRatio }
}

/** 指定キーの状況（キーのコスト vs 実効上限）。 */
export function budgetStatusForKey(apiKey: string): BudgetStatus {
  const s = getSettings()
  const cost = getUsageForKey(apiKey).costYen
  const limit = effectiveLimit(apiKey)
  if (limit == null || limit <= 0) return { limit: null, cost, ratio: null, over: false, warn: false }
  const ratio = cost / limit
  return { limit, cost, ratio, over: ratio >= 1, warn: ratio >= s.warnRatio }
}

/** リクエスト前のチェック（使用中キーの上限で判定）。 */
export function checkBeforeRequest(apiKey: string): { allowed: boolean; message?: string } {
  const s = getSettings()
  if (!s.enforce) return { allowed: true }
  const limit = effectiveLimit(apiKey)
  if (limit == null) return { allowed: true } // 無制限
  const cost = getUsageForKey(apiKey).costYen
  if (cost >= limit) {
    return {
      allowed: false,
      message:
        `このAPIキーの今月の利用額（推定 ¥${cost.toFixed(1)}）が上限 ¥${limit} に達しました。` +
        `認証情報（⇧⌘,）でこのキーの上限を変更するか、別のキーに切り替えてください。`,
    }
  }
  return { allowed: true }
}
