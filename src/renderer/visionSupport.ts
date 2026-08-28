// visionSupport.ts — モデルごとの「画像入力の対応」を実測から学習して記憶する。
//
// ── なぜ要るか（2026-08-19 Ryosuke 提案）──────────────────────────────
// これまでは名前の一覧（`isVisionModel`）で決め打ちし、載っていないモデルには
// **必ず二段構え**（視覚モデルが読み取り → 本来のモデルが実行）を挟んでいた。
// だが「実は画像を直接読めるモデル」は一覧に載らない限り永久に二段構えのままで、
// **1回分よけいに時間と費用がかかる**。
//
// ツール対応（toolSupport.ts）で既に同じ問題を解いてある。**同じ形にする**:
//   未確認のモデルは、まず**そのまま画像を渡して試す** → 結果から学習する。
//   専用の確認リクエストは足さない（実際の送信そのものが確認になる）。
//
// **「対応と思ったら非対応」は 400 で救済できるが、「非対応と思ったら実は対応」は
// 発見する経路が無い。** その非対称性を、ここでも解消する（掟1: 推測で決めない）。

// 実体は shared へ移した（B'-3b）。isImageUnsupportedError は src/shared/modelInfo.ts を参照。
import { isImageUnsupportedError } from '../shared/modelInfo'
export { isImageUnsupportedError }

export const VISION_SUPPORT_KEY = 'sakura_model_vision_support'

/** 記録の有効期限。さくら側でモデルが更新されることがあるので、古い判定は捨てて再確認する。 */
export const VISION_SUPPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** true=対応, false=非対応, null=未確認（まだ一度も試していない） */
export type VisionSupport = boolean | null

interface StoredEntry { supported: boolean; at: number }
type VisionSupportStore = Record<string, StoredEntry>

export function readVisionSupportStore(): VisionSupportStore {
  try {
    const raw = localStorage.getItem(VISION_SUPPORT_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: VisionSupportStore = {}
    for (const [model, entry] of Object.entries(parsed as Record<string, any>)) {
      if (entry && typeof entry.supported === 'boolean' && typeof entry.at === 'number') {
        out[model] = { supported: entry.supported, at: entry.at }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 実測結果を記録する（上書き保存）。 */
export function recordVisionSupport(model: string, supported: boolean, now: number = Date.now()): void {
  if (!model) return
  const store = readVisionSupportStore()
  store[model] = { supported, at: now }
  try {
    localStorage.setItem(VISION_SUPPORT_KEY, JSON.stringify(store))
  } catch { /* 保存できなくても致命的ではない（次回また学習し直すだけ） */ }
}

/** 記録を消す。model 省略時は全消去。 */
export function forgetVisionSupport(model?: string): void {
  if (model === undefined) {
    try { localStorage.removeItem(VISION_SUPPORT_KEY) } catch { /* noop */ }
    return
  }
  const store = readVisionSupportStore()
  delete store[model]
  try { localStorage.setItem(VISION_SUPPORT_KEY, JSON.stringify(store)) } catch { /* noop */ }
}

/**
 * 画像入力の対応状況を判定する（純関数・記録を読むだけ）。判定順:
 * 1. TTL内（30日）の実測キャッシュ
 * 2. 実測で確定している種（seed）
 * 3. null（未確認）
 */
export function visionSupportOf(model: string, now: number = Date.now()): VisionSupport {
  const cached = readVisionSupportStore()[model]
  if (cached && now - cached.at < VISION_SUPPORT_TTL_MS) return cached.supported
  // 実測で確定している種。`-VL-` / `multimodal` は画像専用として提供されているもの、
  // kimi-k2.6 は 2026-07-14 のユーザー実測（verify-vision.mjs）で直接読めることを確認済み。
  if (/-VL-|multimodal|kimi-k2\.6/i.test(model)) return true
  return null
}

/**
 * 画像をそのまま渡して試すべきか。
 *
 * **既知で非対応（false）のときだけ二段構えにする。未確認（null）は楽観的に試す。**
 * ツール対応と同じ考え方（`shouldSendTools`）。
 */
export function shouldTryImagesDirectly(model: string, now: number = Date.now()): boolean {
  return visionSupportOf(model, now) !== false
}
