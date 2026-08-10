// newProjectAgent.ts — 新規プロジェクト作成（NewProjectModal.tsx）で「このあとチャットで作業するAI（頭脳）」の
// 既定選択とフォールバックを決める純粋関数（IO無し・Vitest対象）。
//
// 背景: これまで新規プロジェクト作成は常にさくらのAI Engine固定で雛形を生成しており、
// Claudeキーしか持たない利用者はAI生成を一切使えなかった。
//
// **2026-07-31 の方式変更に伴う意味の変化**: 雛形生成をモーダル内のAI呼び出しから
// 「チャットへ依頼する」方式に切り替えたため、ここで選んだ頭脳・モデルは**そのままチャットの
// 設定（claudeMode.ts の setClaudeMode / usage.ts の setDefaultModel）へ反映される**。
// 一問一答方式だった頃の「この作成のときだけ有効」ではなくなっている点に注意（実際の書き込みは
// NewProjectModal.tsx 側が行い、ここでは判定ロジックのみを持つ）。

export type CreationBrain = 'sakura' | 'claude'

export interface DefaultCreationBrainOpts {
  hasSakuraKey: boolean
  hasClaudeKey: boolean
  /** アプリ全体のClaude頭脳モード設定（claudeMode.ts の isClaudeModeEnabled()）。
   *  両方のキーがあるときだけ、どちらを既定にするかの判断材料に使う。 */
  claudeModeOn: boolean
  /** localStorage に保存済みの前回選択（'sakura' | 'claude' 以外・未保存は null/undefined）。 */
  saved?: string | null
}

/**
 * defaultCreationBrain — 新規プロジェクト作成画面を開いたときの「担当AI」の既定値を決める。
 * 優先順位:
 *  1. 保存済みの選択（saved）が今も使える（対応するキーがある）ならそれを優先する。
 *  2. 両方のキーがあるときは、アプリ全体のClaude頭脳モード設定（claudeModeOn）に合わせる。
 *  3. 片方だけキーがあるときはそちらに固定する。
 *  4. どちらのキーも無ければ null（呼び出し側は選択欄自体を出さず、ローカル雛形のみで作成する）。
 */
export function defaultCreationBrain(opts: DefaultCreationBrainOpts): CreationBrain | null {
  const { hasSakuraKey, hasClaudeKey, claudeModeOn, saved } = opts
  if (saved === 'sakura' && hasSakuraKey) return 'sakura'
  if (saved === 'claude' && hasClaudeKey) return 'claude'
  if (hasSakuraKey && hasClaudeKey) return claudeModeOn ? 'claude' : 'sakura'
  if (hasClaudeKey) return 'claude'
  if (hasSakuraKey) return 'sakura'
  return null
}

/**
 * pickSavedModel — 保存済みのモデル選択（saved）が提供中一覧（availableIds）にまだあればそれを使い、
 * 無ければ既定（fallback）へ、既定も一覧に無ければ一覧の先頭へフォールバックする
 * （claudeMode.ts の getClaudeModel() と同じフォールバック順）。
 * availableIds が空（一覧未取得）のときは saved も fallback も検証できないため fallback をそのまま返す。
 */
export function pickSavedModel(saved: string | null | undefined, availableIds: string[], fallback: string): string {
  if (saved && availableIds.includes(saved)) return saved
  if (availableIds.includes(fallback)) return fallback
  return availableIds[0] ?? fallback
}
