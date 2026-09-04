// usageBudget.ts — さくらのAI Engine の利用量・予算管理（判定・計算の純関数）。
//
// ── なぜここにあるか（B'-3d-1b）─────────────────────────────────────
// 予算設定（sakura_budget_settings）と利用実績（sakura_usage_by_month）は、これまで renderer の
// localStorage が持ち主だった。main のループ（turnRunner.ts）からは ask（main→renderer の
// 問い合わせ）で読み書きしており、ウィンドウが閉じるとターンが止まる原因の一部だった
// （B'-3d「窓を閉じても作業が続く」）。ここでは「store（設定・実績）をどう判定・計算へ使うか」
// だけを純関数として切り出す（electron / window / localStorage に一切触れない）。
// store の持ち主（読み書き・永続化）は main（src/main/usageStore.ts・userData/usage.json）へ
// 移し、renderer はその写し（src/renderer/usageMirror.ts）を読むだけにする。
//
// **数式・判定順序・メッセージ文言は、移設前の renderer/usage.ts から一切変えていない**
// （振る舞い不変。旧実装のコメントも資産なのでそのまま引き継ぐ）。
//
// ── 課金データであることの注意（学習キャッシュ＝B'-3d-1a との違い）───────────
// 学習キャッシュ（modelLearning.ts）は「新しい at だけ勝つ」形の移行で何度呼んでも安全だったが、
// 利用実績はタイムスタンプの無い**加算カウンタ**なので、同じやり方は使えない
// （2度混ぜると二重計上になる）。移行は1度きり（持ち主側＝usageStore.ts の mergeMigration が
// migrated フラグで縛る。ここ＝shared 側は「1度だけ」の判断そのものには関与しない）。

/** APIキーの安定した指紋（生のキーは保存しない）。FNV-1a。
 *  ⚠️ 互換の要: 1文字も変えない（過去に記録した指紋と一致しなくなる）。 */
export function hashKey(key: string): string {
  if (!key) return '(none)'
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'k' + (h >>> 0).toString(36)
}

/** ¥ / 1,000,000 トークン（2026年時点の従量課金プランの公開単価を基にした概算） */
export const PRICING: Record<string, { in: number; out: number }> = {
  // ¥/1,000,000 tokens（公式ページ https://ai.sakura.ad.jp/sakura-ai/ai-engine/ の ¥/1万tok ×100）
  // 2026-09-04: 旧コード特化モデル（480B/30B）/ preview/Phi-4-multimodal-instruct は
  // 提供終了のため削除。
  'gpt-oss-120b': { in: 15, out: 75 },                         // 0.15 / 0.75
  'llm-jp-3.1-8x13b-instruct4': { in: 15, out: 75 },           // 0.15 / 0.75
  'preview/Qwen3-VL-30B-A3B-Instruct': { in: 10, out: 30 },    // 0.1 / 0.3
  'preview/Phi-4-mini-instruct-cpu': { in: 1, out: 3 },        // 0.01 / 0.03
  'preview/Qwen3-0.6B-cpu': { in: 1, out: 3 },                 // 0.01 / 0.03
  'preview/Qwen3.6-35B-A3B': { in: 30, out: 150 },             // 0.3 / 1.5
  'preview/Kimi-K2.6': { in: 60, out: 300 },                   // 0.6 / 3
  'preview/Kimi-K2.7-Code': { in: 52, out: 504 },  // 0.52 / 5.04 円（1万tok）2026-09-04 公式ページ
  'preview/gemma-4-31B-it': { in: 24, out: 96 },   // 0.24 / 0.96
}
export const DEFAULT_PRICE = { in: 15, out: 75 }

export function priceFor(model: string): { in: number; out: number } {
  return PRICING[model] ?? DEFAULT_PRICE
}

// ── 予算設定 ────────────────────────────────────────────────────
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

// ── 利用量ストア（月 → キー → モデル） ─────────────
export interface ModelUsage { promptTokens: number; completionTokens: number; costYen: number }
export interface KeyBucket { models: Record<string, ModelUsage> }
export interface MonthBucket { keys: Record<string, KeyBucket> }
export type UsageStore = Record<string, MonthBucket>

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

export interface BudgetStatus {
  limit: number | null
  cost: number
  ratio: number | null
  over: boolean
  warn: boolean
}

/** 現在の年月キー（"YYYY-MM"）。テストのため now を差し込めるが、既定は移設前と同じ `new Date()`。 */
export function thisMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** 旧フォーマット（{models}/{promptTokens}）も読み込めるよう正規化する（移行元・renderer/usage.ts から移設）。 */
export function normalizeMonth(raw: any): MonthBucket {
  if (raw && raw.keys && typeof raw.keys === 'object') return raw as MonthBucket
  if (raw && raw.models && typeof raw.models === 'object') {
    return { keys: { '(以前の利用)': { models: raw.models } } }
  }
  return { keys: {} }
}

// ── サニタイザ（IPC 越し・ファイルから来る値を課金データとして守る）────────────
// src/shared/modelLearning.ts の sanitizeStore / UNSAFE_KEYS と同じ流儀:
// 壊れた・想定外の形は既定/空として扱い、例外を投げない。プロトタイプ汚染の芽
// （`out['__proto__'] = ...` のようなキー）は先に弾く。

/** キーとして受け付けないもの（perKeyLimits の指紋キー・months のモデルキー共通）。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 未検証の値（learning.json 相当の usage.json・IPC の setSettings/migrate 引数）を
 * BudgetSettings として使ってよい形へ絞る。不正な値は既定へ倒す。
 * perKeyLimits は文字列キーのみ・UNSAFE_KEYS を弾く・値は有限数か null のみ受け付ける。
 */
export function sanitizeSettings(raw: unknown): BudgetSettings {
  const r = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {}
  const monthlyLimitYen =
    r.monthlyLimitYen === null ? null
      : isFiniteNumber(r.monthlyLimitYen) ? r.monthlyLimitYen
        : DEFAULT_SETTINGS.monthlyLimitYen
  const enforce = typeof r.enforce === 'boolean' ? r.enforce : DEFAULT_SETTINGS.enforce
  const warnRatio = isFiniteNumber(r.warnRatio) ? r.warnRatio : DEFAULT_SETTINGS.warnRatio

  const perKeyLimits: Record<string, number | null> = {}
  const rawLimits = r.perKeyLimits
  if (rawLimits && typeof rawLimits === 'object') {
    for (const [fp, v] of Object.entries(rawLimits as Record<string, unknown>)) {
      if (UNSAFE_KEYS.has(fp)) continue
      if (v === null) { perKeyLimits[fp] = null; continue }
      if (isFiniteNumber(v)) { perKeyLimits[fp] = v; continue }
      // 型が壊れているエントリだけ無視する（そのキー以外は生かす）
    }
  }

  return { monthlyLimitYen, enforce, warnRatio, perKeyLimits }
}

/** カウンタ（トークン数・円）を「有限かつ0以上」に丸める。非数・負値は0（NaN汚染の防止）。 */
function sanitizeCounter(v: unknown): number {
  if (!isFiniteNumber(v)) return 0
  return v < 0 ? 0 : v
}

/**
 * 未検証の値を UsageStore として使ってよい形へ絞る。
 * 月キーは "YYYY-MM" のみ、fp/モデルキーは UNSAFE_KEYS を弾き、カウンタは sanitizeCounter を通す。
 * 旧 {models} 形式のバケットは normalizeMonth で正規化してから検証する（片道移行で使う経路）。
 */
export function sanitizeMonths(raw: unknown): UsageStore {
  if (!raw || typeof raw !== 'object') return {}
  const out: UsageStore = {}
  for (const [month, bucketRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!MONTH_KEY_RE.test(month)) continue
    const bucket = normalizeMonth(bucketRaw)
    if (!bucket.keys || typeof bucket.keys !== 'object') continue
    const keys: Record<string, KeyBucket> = {}
    for (const [fp, kbRaw] of Object.entries(bucket.keys)) {
      if (UNSAFE_KEYS.has(fp)) continue
      const kb = kbRaw as { models?: unknown } | null
      if (!kb || typeof kb !== 'object' || !kb.models || typeof kb.models !== 'object') continue
      const models: Record<string, ModelUsage> = {}
      for (const [model, muRaw] of Object.entries(kb.models as Record<string, unknown>)) {
        if (UNSAFE_KEYS.has(model)) continue
        const mu = muRaw as Record<string, unknown> | null
        models[model] = {
          promptTokens: sanitizeCounter(mu?.promptTokens),
          completionTokens: sanitizeCounter(mu?.completionTokens),
          costYen: sanitizeCounter(mu?.costYen),
        }
      }
      keys[fp] = { models }
    }
    out[month] = { keys }
  }
  return out
}

// ── 判定・計算（store を引数に取る純関数）──────────────────────────────

function monthBucketOf(months: UsageStore, month: string): MonthBucket {
  return months[month] ?? { keys: {} }
}

function sumModels(models: Record<string, ModelUsage>): { promptTokens: number; completionTokens: number; costYen: number } {
  let p = 0, c = 0, cost = 0
  for (const u of Object.values(models)) { p += u.promptTokens; c += u.completionTokens; cost += u.costYen }
  return { promptTokens: p, completionTokens: c, costYen: cost }
}

/** 指定月の全キー・全モデルの合計 */
export function computeUsage(months: UsageStore, month: string): MonthUsage {
  const bucket = monthBucketOf(months, month)
  let p = 0, c = 0, cost = 0
  for (const kb of Object.values(bucket.keys)) {
    const s = sumModels(kb.models)
    p += s.promptTokens; c += s.completionTokens; cost += s.costYen
  }
  return { month, promptTokens: p, completionTokens: c, totalTokens: p + c, costYen: cost }
}

/** 指定月のモデル別利用（全キー横断・金額の大きい順） */
export function computeUsageByModel(months: UsageStore, month: string): ModelUsageRow[] {
  const bucket = monthBucketOf(months, month)
  const agg: Record<string, ModelUsage> = {}
  for (const kb of Object.values(bucket.keys)) {
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

/** 指定キー・指定月の利用 */
export function computeUsageForKey(months: UsageStore, month: string, fp: string): MonthUsage {
  const kb = monthBucketOf(months, month).keys[fp] ?? { models: {} }
  const s = sumModels(kb.models)
  return { month, promptTokens: s.promptTokens, completionTokens: s.completionTokens, totalTokens: s.promptTokens + s.completionTokens, costYen: s.costYen }
}

/** 実効上限（個別→既定の順に解決。getKeyLimit 相当の hasOwnProperty 判定込み）。null = 無制限 */
export function effectiveLimitOf(settings: BudgetSettings, fp: string): number | null {
  const explicit = Object.prototype.hasOwnProperty.call(settings.perKeyLimits, fp) ? settings.perKeyLimits[fp] : undefined
  if (explicit !== undefined) return explicit
  return settings.monthlyLimitYen
}

/** 全体の状況（合計コスト vs 既定上限）。設定画面のヘッドライン用。 */
export function budgetStatusOf(settings: BudgetSettings, months: UsageStore, month: string): BudgetStatus {
  const cost = computeUsage(months, month).costYen
  const limit = settings.monthlyLimitYen
  if (limit == null || limit <= 0) return { limit: null, cost, ratio: null, over: false, warn: false }
  const ratio = cost / limit
  return { limit, cost, ratio, over: ratio >= 1, warn: ratio >= settings.warnRatio }
}

/** 指定キーの状況（キーのコスト vs 実効上限）。 */
export function budgetStatusForKeyOf(settings: BudgetSettings, months: UsageStore, month: string, fp: string): BudgetStatus {
  const cost = computeUsageForKey(months, month, fp).costYen
  const limit = effectiveLimitOf(settings, fp)
  if (limit == null || limit <= 0) return { limit: null, cost, ratio: null, over: false, warn: false }
  const ratio = cost / limit
  return { limit, cost, ratio, over: ratio >= 1, warn: ratio >= settings.warnRatio }
}

/** リクエスト前のチェック（使用中キーの上限で判定）。メッセージ文言は移設前と一字一句同じ。 */
export function checkBeforeRequestOf(settings: BudgetSettings, months: UsageStore, month: string, fp: string): { allowed: boolean; message?: string } {
  if (!settings.enforce) return { allowed: true }
  const limit = effectiveLimitOf(settings, fp)
  if (limit == null) return { allowed: true } // 無制限
  const cost = computeUsageForKey(months, month, fp).costYen
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

/**
 * 1回のAPI利用を記録する（キー指紋＋モデル別）。**渡された months を直接書き換えて返す**
 * （純関数だが不変ではない＝呼び出し側が own する store に対してのみ使うこと。
 * 呼び出し側が別オブジェクトへ差し替えたいとき＝楽観更新の「新オブジェクトを作って差し替え」は、
 * 呼ぶ前に自分で複製してから渡す）。
 *
 * 数式は移設前の renderer/usage.ts recordUsage から一切変えていない: トークン数と課金額は
 * **同じ値から**計算する。以前はトークン数だけ Math.max(0,…) で守られ、課金額は生の値を
 * 使っていたため、異常な応答（負値）が来ると**利用額が減り**、上限に達したキーがまた
 * 使えてしまった（2026-08-05 修正・退行させない）。
 */
export function applyRecord(
  months: UsageStore,
  month: string,
  fp: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): UsageStore {
  const p = Number.isFinite(promptTokens) ? Math.max(0, Math.round(promptTokens)) : 0
  const c = Number.isFinite(completionTokens) ? Math.max(0, Math.round(completionTokens)) : 0
  const price = priceFor(model)
  const cost = (p / 1_000_000) * price.in + (c / 1_000_000) * price.out
  const bucket = months[month] ?? { keys: {} }
  const kb = bucket.keys[fp] ?? { models: {} }
  const u = kb.models[model] ?? { promptTokens: 0, completionTokens: 0, costYen: 0 }
  u.promptTokens += p
  u.completionTokens += c
  u.costYen += cost
  kb.models[model] = u
  bucket.keys[fp] = kb
  months[month] = bucket
  return months
}
