// visionSupport.ts — モデルごとの「画像入力の対応」学習キャッシュの renderer 側API（B'-3d-1a）。
//
// ── 持ち主が main へ移った（この段の変更）─────────────────────────────
// 判定ロジック・TTL・種（seed）は src/shared/modelLearning.ts の純関数（store を引数に取る形）
// へ移した。記録の持ち主（読み書き・永続化）は main（src/main/learningStore.ts・
// userData/learning.json）へ移り、ここは①その写し（src/renderer/learningMirror.ts）を渡して
// 判定するだけ ②書き込みは写しを楽観更新してから main（learning:record 等）へ fire-and-forget
// で送るだけ、の薄い層になった。**localStorage はもう読み書きしない**。
//
// **公開シグネチャ（呼び出し側から見た形）は移設前と変えていない。** ChatPanel.tsx の
// 表示ヒント（shouldTryImagesDirectly を render 中に同期で呼ぶ）・useAiChat.ts の buildPorts・
// shared/chatTurn.ts の ports 経由の呼び出しを直す必要が無いようにするため。
//
// ── なぜ要るか（元のコメント。判断は変えていないのでそのまま残す・2026-08-19 Ryosuke 提案）───
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

// isImageUnsupportedError の実体は shared にある（B'-3b）。従来どおり re-export で維持する。
import { isImageUnsupportedError } from '../shared/modelInfo'
export { isImageUnsupportedError }

import { getLearningMirror, setMirrorEntry, clearMirrorEntry } from './learningMirror'
import {
  visionSupportOf as visionSupportOfPure,
  shouldTryImagesDirectly as shouldTryImagesDirectlyPure,
  VISION_SUPPORT_TTL_MS,
  type ToolSupport as VisionSupport,
} from '../shared/modelLearning'

export { VISION_SUPPORT_TTL_MS }
export type { VisionSupport }

/** 旧 localStorage のキー。もう読み書きしないが、learningMirror.ts の片道移行が同じ値を
 *  読むため、定数の値自体は変えずに残す（旧データがどのキーにあったかの記録）。 */
export const VISION_SUPPORT_KEY = 'sakura_model_vision_support'

/**
 * 画像入力の対応状況を判定する（記録を読むだけ）。判定順:
 * 1. TTL内（30日）の実測キャッシュ
 * 2. 実測で確定している種（seed）
 * 3. null（未確認）
 */
export function visionSupportOf(model: string, now: number = Date.now()): VisionSupport {
  return visionSupportOfPure(getLearningMirror().visionSupport, model, now)
}

/**
 * 画像をそのまま渡して試すべきか。
 *
 * **既知で非対応（false）のときだけ二段構えにする。未確認（null）は楽観的に試す。**
 * ツール対応と同じ考え方（`shouldSendTools`）。
 */
export function shouldTryImagesDirectly(model: string, now: number = Date.now()): boolean {
  return shouldTryImagesDirectlyPure(getLearningMirror().visionSupport, model, now)
}

/**
 * 実測結果を記録する（上書き保存）。
 * ミラーをその場で楽観更新してから、main（learning:record）へ fire-and-forget で送る。
 * main が唯一の持ち主なので、送信に失敗しても致命的ではない（次回また学習し直すだけ）。
 */
export function recordVisionSupport(model: string, supported: boolean, now: number = Date.now()): void {
  if (!model) return
  setMirrorEntry('vision', model, supported, now)
  if (typeof window === 'undefined' || !window.electronAPI?.learning) return
  window.electronAPI.learning.record('vision', model, supported).catch(() => { /* 次回また学習し直すだけ */ })
}

/** 記録を消す。model 省略時は全消去。 */
export function forgetVisionSupport(model?: string): void {
  clearMirrorEntry('vision', model)
  if (typeof window === 'undefined' || !window.electronAPI?.learning) return
  window.electronAPI.learning.forget('vision', model).catch(() => { /* noop */ })
}
