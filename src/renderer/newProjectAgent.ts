// newProjectAgent.ts — 新規プロジェクト作成（NewProjectModal.tsx）で「このあとチャットで作業するAI」の
// 既定選択とフォールバックを決める純粋関数（IO無し・Vitest対象）。
//
// 背景: これまで新規プロジェクト作成は常にさくらのAI Engine固定で雛形を生成しており、
// Claudeキーしか持たない利用者はAI生成を一切使えなかった。
//
// 雛形生成は「チャットへ依頼する」方式なので、ここで選んだ AI とモデルは、作ったプロジェクトで
// 使うものとして**そのプロジェクトの記憶**になる（creationProjectAi → projectAi.ts。書くのは
// NewProjectModal.tsx）。設定の既定（使う AI・モデル）は変えない。ここでは判定ロジックのみを持つ。

import type { ProjectAiMemory } from './projectAi'

export type CreationBrain = 'sakura' | 'claude'

export interface DefaultCreationBrainOpts {
  hasSakuraKey: boolean
  hasClaudeKey: boolean
  /** 設定の既定の AI（claudeMode.ts の isClaudeModeEnabled()。「既定の AI」の意味）。
   *  両方のキーがあるときだけ、どちらを既定にするかの判断材料に使う。 */
  claudeModeOn: boolean
  /** localStorage に保存済みの前回選択（'sakura' | 'claude' 以外・未保存は null/undefined）。 */
  saved?: string | null
}

/**
 * defaultCreationBrain — 新規プロジェクト作成画面を開いたときの「担当AI」の既定値を決める。
 * 優先順位:
 *  1. 保存済みの選択（saved）が今も使える（対応するキーがある）ならそれを優先する。
 *  2. 両方のキーがあるときは、設定の既定の AI（claudeModeOn）に合わせる。
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

/**
 * creationProjectAi — 新規作成で選んだ AI とモデルを、作成先のプロジェクトの記憶にする形へ直す（純関数）。
 * 設定の既定は書き換えない。AI を選べない（null）ときは記憶を作らない。
 */
export function creationProjectAi(o: { brain: CreationBrain | null; claudeModelId: string; sakuraModelId: string }): ProjectAiMemory | null {
  if (o.brain === 'claude') return { brain: 'claude', claudeModel: o.claudeModelId }
  if (o.brain === 'sakura') return { brain: 'sakura', sakuraModel: o.sakuraModelId }
  return null
}
