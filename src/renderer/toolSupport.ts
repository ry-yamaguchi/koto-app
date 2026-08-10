// モデルごとの「ツール（Function Calling）対応」を実測から学習して記憶する。
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

export const TOOL_SUPPORT_KEY = 'sakura_model_tool_support'
/** 記録の有効期限。さくら側が後からtool-call-parserを有効化する等、判定が変わることがあるため、
 *  古い判定は捨てて再確認する（30日）。 */
export const TOOL_SUPPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** true=対応, false=非対応, null=未確認（まだ一度も試していない） */
export type ToolSupport = boolean | null

interface StoredEntry { supported: boolean; at: number }
type ToolSupportStore = Record<string, StoredEntry>

/** localStorage から記録済みストアを読む。壊れたJSON・想定外の形は空オブジェクトとして扱う。 */
export function readToolSupportStore(): ToolSupportStore {
  try {
    const raw = localStorage.getItem(TOOL_SUPPORT_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: ToolSupportStore = {}
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

/** 実測結果を記録する（上書き保存。at を現在時刻に更新）。 */
export function recordToolSupport(model: string, supported: boolean, now: number = Date.now()): void {
  const store = readToolSupportStore()
  store[model] = { supported, at: now }
  try {
    localStorage.setItem(TOOL_SUPPORT_KEY, JSON.stringify(store))
  } catch { /* 保存できなくても致命的ではない（次回また学習し直すだけ） */ }
}

/** 記録を消す。model省略時は全消去（設定UIからのリセットや不具合時の逃げ道用）。 */
export function forgetToolSupport(model?: string): void {
  if (model === undefined) {
    try { localStorage.removeItem(TOOL_SUPPORT_KEY) } catch { /* noop */ }
    return
  }
  const store = readToolSupportStore()
  delete store[model]
  try {
    localStorage.setItem(TOOL_SUPPORT_KEY, JSON.stringify(store))
  } catch { /* noop */ }
}

// 実測で確定している「種」。ここに載っていないモデルは全て null（未確認）として扱い、
// 実際に試した結果から学習する（旧ブロックリストの preview\/|-VL-|multimodal|kimi|gpt-oss は
// 「未確認」に含まれる＝今回の誤判定の原因だったため種から外した）。
const SEED_TRUE = /kimi-k2\.6|gpt-oss-120b/i // 2026-07-14/16 ユーザー実測（probe-models.mjs）: tools=ok
const SEED_FALSE = /llm-jp/i // 2026-07-14 実測: サーバー側がツール非対応で400

/**
 * モデルのツール対応状況を判定する。判定順:
 * 1. TTL内（30日）の実測キャッシュ
 * 2. 実測で確定している種（seed）
 * 3. null（未確認）
 */
export function toolSupportOf(model: string, now: number = Date.now()): ToolSupport {
  const cached = readToolSupportStore()[model]
  if (cached && now - cached.at < TOOL_SUPPORT_TTL_MS) return cached.supported
  if (SEED_TRUE.test(model)) return true
  if (SEED_FALSE.test(model)) return false
  return null
}

/** ツールを送るべきか。既知で非対応（false）の場合だけ送らない。未確認（null）は楽観的に送る。 */
export function shouldSendTools(model: string, now: number = Date.now()): boolean {
  return toolSupportOf(model, now) !== false
}

/** ツール対応が実測済み（true）のモデルか。切替先モデルを選ぶときに使う。 */
export function isKnownToolCapable(model: string, now: number = Date.now()): boolean {
  return toolSupportOf(model, now) === true
}
