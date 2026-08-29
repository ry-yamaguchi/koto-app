// toolSupport.ts — モデルごとの「ツール（Function Calling）対応」学習キャッシュの renderer 側API
// （B'-3d-1a）。
//
// ── 持ち主が main へ移った（この段の変更）─────────────────────────────
// 判定ロジック・TTL・種（seed）は src/shared/modelLearning.ts の純関数（store を引数に取る形）
// へ移した。記録の持ち主（読み書き・永続化）は main（src/main/learningStore.ts・
// userData/learning.json）へ移り、ここは①その写し（src/renderer/learningMirror.ts）を渡して
// 判定するだけ ②書き込みは写しを楽観更新してから main（learning:record 等）へ fire-and-forget
// で送るだけ、の薄い層になった。**localStorage はもう読み書きしない**。
//
// **公開シグネチャ（呼び出し側から見た形・関数名/引数/返り値）は移設前と変えていない。**
// 呼び出し側（renderer/hooks/useAiChat.ts の buildPorts・src/shared/chatTurn.ts の ports 経由）
// を直す必要が無いようにするため。
//
// ── なぜこの判定が要るか（元のコメント。判断は変えていないのでそのまま残す）───────────
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

import { getLearningMirror, setMirrorEntry, clearMirrorEntry } from './learningMirror'
import {
  toolSupportOf as toolSupportOfPure,
  shouldSendTools as shouldSendToolsPure,
  isKnownToolCapable as isKnownToolCapablePure,
  TOOL_SUPPORT_TTL_MS,
  type ToolSupport,
} from '../shared/modelLearning'

export { TOOL_SUPPORT_TTL_MS }
export type { ToolSupport }

/** 旧 localStorage のキー。もう読み書きしないが、learningMirror.ts の片道移行が同じ値を
 *  読むため、定数の値自体は変えずに残す（旧データがどのキーにあったかの記録）。 */
export const TOOL_SUPPORT_KEY = 'sakura_model_tool_support'

/**
 * モデルのツール対応状況を判定する。判定順:
 * 1. TTL内（30日）の実測キャッシュ
 * 2. 実測で確定している種（seed）
 * 3. null（未確認）
 */
export function toolSupportOf(model: string, now: number = Date.now()): ToolSupport {
  return toolSupportOfPure(getLearningMirror().toolSupport, model, now)
}

/** ツールを送るべきか。既知で非対応（false）の場合だけ送らない。未確認（null）は楽観的に送る。 */
export function shouldSendTools(model: string, now: number = Date.now()): boolean {
  return shouldSendToolsPure(getLearningMirror().toolSupport, model, now)
}

/** ツール対応が実測済み（true）のモデルか。切替先モデルを選ぶときに使う。 */
export function isKnownToolCapable(model: string, now: number = Date.now()): boolean {
  return isKnownToolCapablePure(getLearningMirror().toolSupport, model, now)
}

/**
 * 実測結果を記録する（上書き保存。at を現在時刻に更新）。
 * ミラーをその場で楽観更新してから、main（learning:record）へ fire-and-forget で送る。
 * main が唯一の持ち主なので、送信に失敗しても致命的ではない（次回また学習し直すだけ）。
 */
export function recordToolSupport(model: string, supported: boolean, now: number = Date.now()): void {
  setMirrorEntry('tool', model, supported, now)
  if (typeof window === 'undefined' || !window.electronAPI?.learning) return
  window.electronAPI.learning.record('tool', model, supported).catch(() => { /* 次回また学習し直すだけ */ })
}

/** 記録を消す。model省略時は全消去（設定UIからのリセットや不具合時の逃げ道用）。 */
export function forgetToolSupport(model?: string): void {
  clearMirrorEntry('tool', model)
  if (typeof window === 'undefined' || !window.electronAPI?.learning) return
  window.electronAPI.learning.forget('tool', model).catch(() => { /* noop */ })
}
