/*
 * さくらのAI Engine の利用量・予算管理（クライアント側セーフガード）
 *
 * 注意: 実際の課金はさくらインターネットのアカウントで管理されます。
 * ここでは消費トークンを記録し、内蔵の料金表で利用額を推定して、
 * ユーザーが設定した月間上限に達したらリクエストを止めるための仕組みです。
 *
 * ── B'-3d-1b: 予算設定・利用実績の持ち主が main へ移った ──────────────────
 * 判定・計算の実体（型・数式・メッセージ文言）は src/shared/usageBudget.ts の純関数へ移した。
 * 記録そのものの持ち主は main（src/main/usageStore.ts・userData/usage.json）で、ここは
 * 起動時に写す（src/renderer/usageMirror.ts）＋楽観更新＋ IPC fire-and-forget で読み書きする
 * だけになった。**この呼び出し側の公開シグネチャは1文字も変えていない**（SettingsModal.tsx・
 * CredentialsModal.tsx・ChatPanel.tsx・securityCheck.ts・useAiChat.ts は無修正のまま動く）。
 */

// 実体は shared へ移した（B'-3b）。MODELS / VISION_MODELS / modelLabel / pickBestModel /
// estimateTokens は src/shared/modelInfo.ts を参照。ここでは他の関数が使うぶんを import し、
// 従来どおりの公開API（MODELS 等）は re-export で維持する。
import { MODELS, VISION_MODELS, DEFAULT_MODEL, modelLabel, pickBestModel, estimateTokens } from '../shared/modelInfo'
export { MODELS, VISION_MODELS, modelLabel, pickBestModel, estimateTokens }

// isVisionModel / DEFAULT_VISION_MODEL は B'-3d-1a で shared/modelInfo.ts へ移した
// （main のターン実行と両方が使うため。複製しない＝掟10）。ここは従来の呼び出し側のために re-export する。
export { isVisionModel, DEFAULT_VISION_MODEL } from '../shared/modelInfo'
import { isVisionModel, DEFAULT_VISION_MODEL } from '../shared/modelInfo'

// 予算・利用実績の型・定数・判定/計算の純関数は shared へ移した（B'-3d-1b）。
// hashKey / PRICING / priceFor / DEFAULT_SETTINGS / 型は互換のため re-export する。
import {
  hashKey, priceFor, DEFAULT_SETTINGS, thisMonth,
  computeUsage, computeUsageByModel, computeUsageForKey,
  budgetStatusOf, budgetStatusForKeyOf, checkBeforeRequestOf,
  type BudgetSettings, type MonthUsage, type ModelUsageRow, type BudgetStatus,
} from '../shared/usageBudget'
export { hashKey, PRICING, priceFor, DEFAULT_SETTINGS } from '../shared/usageBudget'
export type { BudgetSettings, MonthUsage, ModelUsageRow, BudgetStatus } from '../shared/usageBudget'
import {
  getUsageMirror, applyRecordToMirror, setSettingsInMirror, setKeyLimitInMirror, resetMonthInMirror,
} from './usageMirror'

/** window / electronAPI.usage が無い環境（node のテスト等）では IPC 送信をスキップする
 *  （楽観更新＝ミラーの書き換えだけ効く。primeUsageMirror と同じガード）。 */
function hasUsageApi(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.usage
}

/** 画像を送るときに使うモデルを決める（提供一覧にある実IDを優先） */
export function getDefaultVisionModel(): string {
  const ids = getCachedModelIds()
  if (ids.includes(DEFAULT_VISION_MODEL)) return DEFAULT_VISION_MODEL
  return ids.find(isVisionModel) ?? DEFAULT_VISION_MODEL
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

const LEGACY_MODEL_KEY = 'sakura_default_model' // 旧・共通設定（IDE/チャット共通だった頃）からの移行用
const MODEL_PREF_KEY = { ide: 'sakura_model_ide', chat: 'sakura_model_chat' } as const
export type ChatMode = 'ide' | 'chat'

// IDE（コード/エージェント）は品質重視、チャット（会話/調査）は速度重視を既定にする。
// ※ バージョンアップ時は npm run check:models / probe:models で見直すこと
// （DEFAULT_MODEL 本体は pickBestModel と一緒に src/shared/modelInfo.ts へ移した。B'-3b）
const DEFAULT_CHAT_MODEL = 'preview/gemma-4-31B-it'    // チャット既定（高速）。2026-09-04 実測 478ms・tools ok

export function getDefaultModel(mode: ChatMode = 'ide'): string {
  return localStorage.getItem(MODEL_PREF_KEY[mode])
    ?? localStorage.getItem(LEGACY_MODEL_KEY)                // 旧・共通設定からの移行
    ?? (mode === 'chat' ? DEFAULT_CHAT_MODEL : DEFAULT_MODEL)
}

export function setDefaultModel(id: string, mode: ChatMode = 'ide') {
  localStorage.setItem(MODEL_PREF_KEY[mode], id)
  window.dispatchEvent(new Event('sakura-usage-changed'))
}

// ── 予算設定 ────────────────────────────────────────────────────

/** ミラー（usageMirror.ts）から読む。コピーを返す（現行も毎回 parse し直していたのと同じ意味）。 */
export function getSettings(): BudgetSettings {
  const s = getUsageMirror().settings
  return { ...s, perKeyLimits: { ...s.perKeyLimits } }
}

export function setSettings(s: BudgetSettings): void {
  setSettingsInMirror(s) // 楽観更新（sanitizeSettings を通ったうえで即座に写しへ反映・イベント発火まで含む）
  if (hasUsageApi()) void window.electronAPI.usage.setSettings(s).catch(() => { /* 次の get/onChanged で復元される */ })
}

// ── キー個別の上限 ─────────────────────────────
/** undefined = 未設定（既定を使う）, null = 無制限, number = 金額 */
export function getKeyLimit(apiKey: string): number | null | undefined {
  const s = getSettings()
  const fp = hashKey(apiKey)
  return Object.prototype.hasOwnProperty.call(s.perKeyLimits, fp) ? s.perKeyLimits[fp] : undefined
}

export function setKeyLimit(apiKey: string, limit: number | null | undefined): void {
  if (!apiKey) return
  const fp = hashKey(apiKey)
  setKeyLimitInMirror(fp, limit) // 楽観更新
  // main 側は undefined を扱えない（IPC 越しでは「省略」と区別しにくいため）ので { clear: true } に変換する。
  if (hasUsageApi()) void window.electronAPI.usage.setKeyLimit(fp, limit === undefined ? { clear: true } : limit).catch(() => {})
}

/** 実効上限（個別→既定の順に解決）。null = 無制限 */
export function effectiveLimit(apiKey: string): number | null {
  const explicit = getKeyLimit(apiKey)
  if (explicit !== undefined) return explicit
  return getSettings().monthlyLimitYen
}

// ── 利用量（ミラーに対して shared/usageBudget.ts の純関数を呼ぶだけ）───────────

/** 今月の全キー・全モデルの合計 */
export function getUsage(): MonthUsage {
  return computeUsage(getUsageMirror().months, thisMonth())
}

/** 今月のモデル別利用（全キー横断・金額の大きい順） */
export function getUsageByModel(): ModelUsageRow[] {
  return computeUsageByModel(getUsageMirror().months, thisMonth())
}

/** 指定キーの今月の利用 */
export function getUsageForKey(apiKey: string): MonthUsage {
  return computeUsageForKey(getUsageMirror().months, thisMonth(), hashKey(apiKey))
}

/** 1回のAPI利用を記録する（キー指紋＋モデル別）。楽観更新＋ main への fire-and-forget。 */
export function recordUsage(apiKey: string, model: string, promptTokens: number, completionTokens: number): void {
  const fp = hashKey(apiKey)
  applyRecordToMirror(fp, model, promptTokens, completionTokens) // 楽観更新
  if (hasUsageApi()) void window.electronAPI.usage.record(fp, model, promptTokens, completionTokens).catch(() => {})
}

/** 今月分の利用量をリセット */
export function resetThisMonth(): void {
  resetMonthInMirror() // 楽観更新
  if (hasUsageApi()) void window.electronAPI.usage.reset().catch(() => {})
}

/** 全体の状況（合計コスト vs 既定上限）。設定画面のヘッドライン用。 */
export function budgetStatus(): BudgetStatus {
  const m = getUsageMirror()
  return budgetStatusOf(m.settings, m.months, thisMonth())
}

/** 指定キーの状況（キーのコスト vs 実効上限）。 */
export function budgetStatusForKey(apiKey: string): BudgetStatus {
  const m = getUsageMirror()
  return budgetStatusForKeyOf(m.settings, m.months, thisMonth(), hashKey(apiKey))
}

/** リクエスト前のチェック（使用中キーの上限で判定）。ミラーに対して同期で判定できる
 *  （main のターン側は usageStore.ts の checkBeforeRequest を直接呼ぶ・こちらは IPC を経由しない）。 */
export function checkBeforeRequest(apiKey: string): { allowed: boolean; message?: string } {
  const m = getUsageMirror()
  return checkBeforeRequestOf(m.settings, m.months, thisMonth(), hashKey(apiKey))
}
