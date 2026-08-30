// modelLearning.ts — モデルごとの「ツール（Function Calling）対応」「画像入力の対応」を
// 実測から学習して記憶する判定ロジック（store を引数に取る純関数）。
//
// ── なぜここにあるか（B'-3d-1a）─────────────────────────────────────
// 今まではこの判定（renderer/toolSupport.ts・renderer/visionSupport.ts）が localStorage を
// 直接読み書きしており、記録の持ち主も renderer だった。main のループ（turnRunner.ts）から
// 使うには ask（main→renderer の問い合わせ）で renderer へ往復するしかなく、ウィンドウが
// 閉じるとターンが止まる原因の一部になっていた（B'-3d「窓を閉じても作業が続く」）。
//
// ここでは「記録（store）をどう判定へ使うか」だけを純関数として切り出す。store の持ち主
// （読み書き・永続化）は main（src/main/learningStore.ts）へ移し、renderer はその写し
// （src/renderer/learningMirror.ts）を読むだけにする。**判定ロジック・TTL・種（seed）は
// 移設前の renderer/toolSupport.ts・renderer/visionSupport.ts から一切変えていない**
// （振る舞い不変。コメントも資産なのでそのまま移す）。

/** 記録1件（対応/非対応の実測結果と、記録した時刻）。 */
export interface StoredEntry { supported: boolean; at: number }

/** モデル名 → 記録、のストア（tool用・vision用で同じ形を使う）。 */
export type LearnStore = Record<string, StoredEntry>

/** true=対応, false=非対応, null=未確認（まだ一度も試していない）。tool/vision共通の形。 */
export type ToolSupport = boolean | null

// ── ツール（Function Calling）対応 ───────────────────────────────────
// 元は renderer/toolSupport.ts の説明（移設）:
//
// 方針: モデル名の正規表現で決め打ちしない。未確認のモデルはまずツール付きで楽観的に試し、
// 結果（構造化 tool_calls が返った／400で非対応と判明した）から学習して次回以降に活かす。
// 専用のプローブ用リクエストは足さない（実際の送信そのものが確認になる。400はトークンを
// 消費しないため追加コストは実質ゼロ）。
//
// 背景（2026-07-30）: 旧 aiTools.ts の判定関数はモデル名の正規表現によるハードコードで、
// 新モデル preview/Kimi-K2.7-Code が「preview/」「kimi」に一致して非対応と誤判定され、
// 実際はツール対応なのに毎回「ツールが必要なため古いモデルに切り替えます」と表示されていた。
// 「対応と思ったら非対応」は実行時に400を検知して救済できるが、「非対応と思ったら実は対応」
// だったケースは発見する経路が無かった。本モジュールはその非対称性を解消する。

/** 記録の有効期限。さくら側が後からtool-call-parserを有効化する等、判定が変わることがあるため、
 *  古い判定は捨てて再確認する（30日）。vision と同じ値だが、意味の違いが分かるよう定数は別名で持つ。 */
export const TOOL_SUPPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000

// 実測で確定している「種」。ここに載っていないモデルは全て null（未確認）として扱い、
// 実際に試した結果から学習する（旧ブロックリストの preview\/|-VL-|multimodal|kimi|gpt-oss は
// 「未確認」に含まれる＝今回の誤判定の原因だったため種から外した）。
const TOOL_SEED_TRUE = /kimi-k2\.6|gpt-oss-120b/i // 2026-07-14/16 ユーザー実測（probe-models.mjs）: tools=ok
const TOOL_SEED_FALSE = /llm-jp/i // 2026-07-14 実測: サーバー側がツール非対応で400

/**
 * モデルのツール対応状況を判定する。判定順:
 * 1. TTL内（30日）の実測キャッシュ
 * 2. 実測で確定している種（seed）
 * 3. null（未確認）
 */
export function toolSupportOf(store: LearnStore, model: string, now: number = Date.now()): ToolSupport {
  const cached = store[model]
  if (cached && now - cached.at < TOOL_SUPPORT_TTL_MS) return cached.supported
  if (TOOL_SEED_TRUE.test(model)) return true
  if (TOOL_SEED_FALSE.test(model)) return false
  return null
}

/** ツールを送るべきか。既知で非対応（false）の場合だけ送らない。未確認（null）は楽観的に送る。 */
export function shouldSendTools(store: LearnStore, model: string, now: number = Date.now()): boolean {
  return toolSupportOf(store, model, now) !== false
}

/** ツール対応が実測済み（true）のモデルか。切替先モデルを選ぶときに使う。 */
export function isKnownToolCapable(store: LearnStore, model: string, now: number = Date.now()): boolean {
  return toolSupportOf(store, model, now) === true
}

// ── 画像入力の対応 ───────────────────────────────────────────────
// 元は renderer/visionSupport.ts の説明（移設）:
//
// これまでは名前の一覧（`isVisionModel`）で決め打ちし、載っていないモデルには
// **必ず二段構え**（視覚モデルが読み取り → 本来のモデルが実行）を挟んでいた。
// だが「実は画像を直接読めるモデル」は一覧に載らない限り永久に二段構えのままで、
// **1回分よけいに時間と費用がかかる**。
//
// ツール対応（toolSupportOf 系）で既に同じ問題を解いてある。**同じ形にする**:
//   未確認のモデルは、まず**そのまま画像を渡して試す** → 結果から学習する。
//   専用の確認リクエストは足さない（実際の送信そのものが確認になる）。
//
// **「対応と思ったら非対応」は 400 で救済できるが、「非対応と思ったら実は対応」は
// 発見する経路が無い。** その非対称性を、ここでも解消する（掟1: 推測で決めない）。

/** 記録の有効期限。さくら側でモデルが更新されることがあるので、古い判定は捨てて再確認する。
 *  tool と同じ値だが、意味の違いが分かるよう定数は別名で持つ。 */
export const VISION_SUPPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000

// 実測で確定している種。`-VL-` / `multimodal` は画像専用として提供されているもの、
// kimi-k2.6 は 2026-07-14 のユーザー実測（verify-vision.mjs）で直接読めることを確認済み。
// （vision には「非対応と確定している種」は無い＝すべて未確認から始まり、実測で学習する。）
const VISION_SEED_TRUE = /-VL-|multimodal|kimi-k2\.6/i

/**
 * 画像入力の対応状況を判定する（純関数・記録を読むだけ）。判定順:
 * 1. TTL内（30日）の実測キャッシュ
 * 2. 実測で確定している種（seed）
 * 3. null（未確認）
 */
export function visionSupportOf(store: LearnStore, model: string, now: number = Date.now()): ToolSupport {
  const cached = store[model]
  if (cached && now - cached.at < VISION_SUPPORT_TTL_MS) return cached.supported
  if (VISION_SEED_TRUE.test(model)) return true
  return null
}

/**
 * 画像をそのまま渡して試すべきか。
 *
 * **既知で非対応（false）のときだけ二段構えにする。未確認（null）は楽観的に試す。**
 * ツール対応と同じ考え方（shouldSendTools）。
 */
export function shouldTryImagesDirectly(store: LearnStore, model: string, now: number = Date.now()): boolean {
  return visionSupportOf(store, model, now) !== false
}

// ── 検証（tool/vision共通）────────────────────────────────────────

/**
 * 未検証の値（JSON.parse の結果・IPCで届いた値など）を LearnStore として使ってよい形へ絞る。
 * 壊れたJSON・想定外の形は空オブジェクトとして扱う。エントリの形が壊れていれば、
 * そのモデルだけ無視する（supported が boolean・at が number のエントリだけ通す）。
 *
 * 旧 renderer/toolSupport.ts の readToolSupportStore・renderer/visionSupport.ts の
 * readVisionSupportStore にあった検証部を、tool/vision で共通化したもの
 * （main の learningStore.ts・renderer の learningMirror.ts の両方から使う）。
 */
/** キーとして受け付けないモデル名（プロトタイプ汚染の芽を摘む）。
 *  learning.json や移行ペイロードは外部由来ではないが、入力パースの関門では
 *  安全側に倒す（`out['__proto__'] = ...` は out 自身の prototype を差し替える）。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function sanitizeStore(raw: unknown): LearnStore {
  if (!raw || typeof raw !== 'object') return {}
  const out: LearnStore = {}
  for (const [model, entry] of Object.entries(raw as Record<string, any>)) {
    if (UNSAFE_KEYS.has(model)) continue
    if (entry && typeof entry.supported === 'boolean' && typeof entry.at === 'number') {
      out[model] = { supported: entry.supported, at: entry.at }
    }
  }
  return out
}
