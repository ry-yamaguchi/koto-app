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
 * B'-3d-1a で main 化した toolSupport.* / vision.* の6メンバー、
 * B'-3d-1b で main 化した usage.check / usage.record / compactWarnOnce の3メンバー、
 * B'-3d-2b で main 化した executeTool）
 * **以外**の全メンバーがここに載っている（tests/chatTurnRpc.test.ts が突き合わせて固定する）。
 *
 * ── B'-3d-1a（2026-08-29）: toolSupport.* / vision.* を main が直接持つように ─────────
 * 学習キャッシュ（ツール対応・画像対応）の持ち主が renderer の localStorage から main の
 * ファイル（src/main/learningStore.ts・userData/learning.json）へ移った。main のループ
 * （turnRunner.ts）はもう renderer へ ask せず、learningStore と shared/modelLearning.ts の
 * 純関数を直接呼ぶ。ask が6本減った（「窓を閉じても作業が続く」＝B'-3d の一部）。
 *
 * ── B'-3d-1b（2026-08-30）: usage.check / usage.record / compactWarnOnce を main が直接持つように ──
 * 予算設定・利用実績（sakura_budget_settings・sakura_usage_by_month）の持ち主が renderer の
 * localStorage から main のファイル（src/main/usageStore.ts・userData/usage.json）へ移った。
 * main のループ（turnRunner.ts）はもう renderer へ ask せず、usageStore と
 * shared/usageBudget.ts の純関数を直接呼ぶ。compactWarnOnce（「まとめ失敗の警告は1度だけ」の印）
 * も main のモジュール内 Set で直接持つようになった（会話キー別・詳しくは turnRunner.ts の
 * コメント参照）。ask が3本減った（ASK_PATHS は 12本 → 9本）。
 *
 * ── B'-3d-2b（2026-08-30）: executeTool を main が直接持つように ─────────────────
 * AIツール実行（fetch_url / read_file / write_file / run_command 等）の本体
 * （shared/toolExecCore.ts の executeToolCore・B'-3d-2a で切り出し済み）を main が直接呼ぶ。
 * main のループ（turnRunner.ts）はもう renderer へ ask せず、各 main 実装（ipc/fs.ts・
 * ipc/shell.ts・ipc/web.ts・backup/store.ts・rag/client.ts）を io（buildMainIo）として直接
 * 組み立てて渡す。「窓を閉じても作業が続く」（B'-3d）の最大の一歩（ask が1本減って ASK_PATHS
 * は 9本 → 8本）。ファイル保存後のエディタ反映は renderer が引き続き担う（新 ChatEvent
 * 'aiFileWritten' 経由・掟11: いま見ているプロジェクトの分だけ）。
 *
 * ── B'-3d-3（2026-08-30）: approveToolCall を main が直接持つように ─────────────────
 * 「人が要る ask」のうち承認だけは、ask（bridge.ask('approveToolCall', ...)）を完全に
 * やめた。要否判定・文面組み立て（write/edit の confirm モード・run_command の
 * requiresConfirmation・install の package.json 読み・commandScopeNote）を main
 * （turnRunner.ts）が shared/approvalPlan.ts の純関数で行い、承認そのものは main の専用
 * マネージャ（src/main/chat/approvalStore.ts・メモリのみ）が持つ。ask と違い**タイムアウトせず、
 * 窓が閉じていても答えが来るまで待ち続ける**（駐機）——「窓を閉じても作業が続く」（B'-3d）の
 * 最後の一歩。renderer には approval:list（画面が（再）起動したときの取りこぼし回収）・
 * approval:answer（回答）・approval:changed（push）という別枠の IPC がある（chatTurn:* の
 * 外・turnId に紐づかない）。ASK_PATHS は 8本 → 7本。
 */
export const ASK_PATHS = [
  'buildSystemPrompt', 'getHistory', 'onUserMessage',
  'buildRagBlock', 'getSearchConfig', 'fetchPagesBlock', 'autoSearchBlock',
] as const

export type AskPath = typeof ASK_PATHS[number]

/** turnRunner が renderer から受け取る、直列化できる開始要求。 */
export type TurnStartPayload = {
  turnId: string
  /** turnOpts は関数を落とした直列化可能な形（renderer 側の仕事・その2）。
   *  B'-3d-3: ChatPanel の buildExecuteOpts() が `writeMode: 'auto' | 'confirm'` を
   *  スナップショットとして乗せる（承認の要否判定に使う。送信時点の値に固定される）。 */
  spec: EngineTurnSpec
  /** optional な ports を renderer が持っているか（無いのに ask すると挙動が変わるため明示する）。
   *  B'-3d-3: approveToolCall は main が直接持つようになり、renderer の対応可否に関係なく
   *  常に main 側で判定・駐機するため、ここから外した（caps の食い違いという概念自体が無い）。 */
  caps: { onUserMessage: boolean; buildRagBlock: boolean }
}

/** main → renderer への1回の問い合わせ。 */
export type TurnAsk = { callId: string; path: AskPath; args: unknown[] }

/** renderer → main への回答。 */
export type TurnAnswer = { turnId: string; callId: string; ok: boolean; result?: unknown; error?: string }

/** main → renderer への出来事（emit・停滞判定リセット）。 */
export type TurnEvent = { type: 'emit'; ev: unknown } | { type: 'activity' }
