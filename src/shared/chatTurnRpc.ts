// chatTurnRpc.ts — main と renderer が chatTurn:start（1ターンの実行）をやり取りするための
// 型と、ask（main → renderer への問い合わせ）の名前表。
//
// ── なぜここに置くか（B'-3b）─────────────────────────────────────────
// 次の段（その1・本ファイル）で AI Engine 経路のループ（shared/chatTurn.ts の runEngineTurn）を
// main プロセスで動かす。main が持たない副作用（ツール実行・承認・学習記録・システムプロンプト
// 組み立て等）は renderer へ「問い合わせ」（ask）て、今のコードをそのまま使う。
//
// **ASK_PATHS はこの1箇所だけに定義し、main（turnRunner.ts）・renderer（その2）の両方が
// これだけを見る。** 片方だけに新しい path 文字列を足すと、もう片方は黙って null 落ちする
// （タイプミスや足し忘れで実際に起きる事故の形）。文字列の集合を1箇所にまとめることで、
// 「main は ask したのに renderer に受け口が無い」「renderer は答えられるのに main が
// その名前で ask していない」をこの型（AskPath）だけで防ぐ。

import type { EngineTurnSpec } from './chatTurn'

/**
 * main → renderer への問い合わせ（ask）の種類。**両側ともこの表だけを使う**。
 *
 * chatTurn.ts の EngineTurnPorts のうち、main が直接持つもの
 * （emit / setAbort / notifyActivity / chatStream / chatOnce / usage.estimate / h、
 * および B'-3d-1a で main 化した toolSupport.* / vision.* の6メンバー）**以外**
 * の全メンバーがここに載っている（tests/chatTurnRpc.test.ts が突き合わせて固定する）。
 *
 * ── B'-3d-1a（2026-08-29）: toolSupport.* / vision.* を main が直接持つように ─────────
 * 学習キャッシュ（ツール対応・画像対応）の持ち主が renderer の localStorage から main の
 * ファイル（src/main/learningStore.ts・userData/learning.json）へ移った。main のループ
 * （turnRunner.ts）はもう renderer へ ask せず、learningStore と shared/modelLearning.ts の
 * 純関数を直接呼ぶ。ask が6本減った（「窓を閉じても作業が続く」＝B'-3d の一部）。
 */
export const ASK_PATHS = [
  'executeTool', 'approveToolCall', 'buildSystemPrompt', 'getHistory', 'onUserMessage',
  'buildRagBlock', 'getSearchConfig', 'fetchPagesBlock', 'autoSearchBlock',
  'usage.check', 'usage.record',
  'compactWarnOnce',
] as const

export type AskPath = typeof ASK_PATHS[number]

/** turnRunner が renderer から受け取る、直列化できる開始要求。 */
export type TurnStartPayload = {
  turnId: string
  /** turnOpts は関数を落とした直列化可能な形（renderer 側の仕事・その2）。 */
  spec: EngineTurnSpec
  /** optional な ports を renderer が持っているか（無いのに ask すると挙動が変わるため明示する）。 */
  caps: { approveToolCall: boolean; onUserMessage: boolean; buildRagBlock: boolean }
}

/** main → renderer への1回の問い合わせ。 */
export type TurnAsk = { callId: string; path: AskPath; args: unknown[] }

/** renderer → main への回答。 */
export type TurnAnswer = { turnId: string; callId: string; ok: boolean; result?: unknown; error?: string }

/** main → renderer への出来事（emit・停滞判定リセット）。 */
export type TurnEvent = { type: 'emit'; ev: unknown } | { type: 'activity' }
