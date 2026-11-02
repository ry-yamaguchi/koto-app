// teardown/headline.ts — 破棄（削除）の結果の見出しの選び。純関数（React に依存しない）。
//
// 結果を描く入口（【公開】の3つの節・📡 の行・プロジェクトの削除）は、すべて TeardownResultView（components/teardown）を通り、
// 見出しはそこがこの関数を呼んで決める。入口ごとに見出しを選ばない（1つの入口だけ古い見出しに戻る、を作らない）。
// 見出しが指すのは「その破棄で何が消えたか」。何も消さなかった回（`keptOnly`）に「破棄しました」とは言わない。
import type { TeardownView } from '../../shared/teardownResult'
import type { TeardownWords } from './types'
import type { ProjectDeleteStep } from './projectDeletePlan'

/** 見出しの色。緑＝済んだ・黄＝途中、または何も消していないが月額などが続く・赤＝できなかった。 */
export type TeardownHeadlineTone = 'green' | 'yellow' | 'red'

/**
 * 結果の見出し。
 *  ・失敗・途中 … その公開先の言葉のまま（`failedHeadline`・`inProgressHeadline`）。`keptOnly`・`keptStorage` は読まない（成否が先）。
 *  ・済んだ（state が done）
 *      - `keptOnly` が真 … `keptHeadline`（黄。月額が続くので緑にしない）。
 *      - 保存場所を残した（`keptStorage` が真）で、その公開先が専用の見出し（`doneKeptStorageHeadline`）を持つ … それ。
 *      - それ以外 … `doneHeadline`。
 */
export function teardownHeadlineOf(
  view: Pick<TeardownView, 'state' | 'keptOnly' | 'keptStorage'>,
  words: TeardownWords,
): { text: string; tone: TeardownHeadlineTone } {
  if (view.state === 'inProgress') return { text: words.inProgressHeadline, tone: 'yellow' }
  if (view.state !== 'done') return { text: words.failedHeadline, tone: 'red' }
  if (view.keptOnly === true) return { text: words.keptHeadline, tone: 'yellow' }
  if (view.keptStorage === true && words.doneKeptStorageHeadline) return { text: words.doneKeptStorageHeadline, tone: 'green' }
  return { text: words.doneHeadline, tone: 'green' }
}

type DoneStep = Extract<ProjectDeleteStep, { kind: 'done' }>

/**
 * プロジェクトの削除で、済んだ段がすべて「何も消さなかった」か（`keptOnly`）。済んだ段が1つも無い回は偽。
 * 真のとき、結果欄は総括「破棄は済みましたが、残ったものがあります。」を出さない（段の見出しが言う）。
 * 1つでも何かを消した段（HANAMII の破棄など）が混じる回は偽で、総括を出す。済んでいない段（消すものが無い・やめた・失敗）は数えない。
 */
export function everyDoneStepKeptOnly(steps: ReadonlyArray<ProjectDeleteStep>): boolean {
  const done = steps.filter((s): s is DoneStep => s.kind === 'done')
  return done.length > 0 && done.every(s => s.view.keptOnly === true)
}
