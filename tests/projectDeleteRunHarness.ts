// 押し直しの流れ（projectDelete.ts の runProjectDelete・moveProjectToTrash・pressProjectDelete）を偽の deps で呼ぶテストの共通の道具。
// 使うテスト: tests/projectDeleteRun.test.ts（流れの場合分け）・tests/projectDeleteRunNotices.test.ts（破棄が済まなかった直後の読み直し・増えた注意を見せてから移す）。
// 偽の deps は、呼ばれた順の一覧 calls を残す（掟10。ソースの文字列ではなく、呼ばれた順で見る）。

import { TwinsGoneError, type ProjectDeleteRunDeps } from '../src/renderer/teardown/projectDelete'
import type { ProjectDeleteFacts, ProjectDeletePlan, ProjectDeleteStep } from '../src/renderer/teardown/projectDeletePlan'
import type { RunningOpEntry } from '../src/renderer/projectMeta'
import { SHARED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/shared'
import type { TeardownView } from '../src/shared/teardownResult'
import type { PublishTargetKind } from '../src/renderer/publishStatus'

export const DIR = '/work/myapp'
export const view = (warnings: string[] = []): TeardownView => ({ ok: true, state: 'done', appDeleted: true, executed: [], message: '', remaining: [], inProgress: [], warnings, stageTimings: null })
export const done = (target: PublishTargetKind, warnings: string[] = []): ProjectDeleteStep => ({ target, kind: 'done', view: view(warnings), words: SHARED_TEARDOWN_WORDS })
export const nothing = (target: PublishTargetKind): ProjectDeleteStep => ({ target, kind: 'nothingToDo', message: '公開されていないため、破棄するものはありません。' })
export const failed = (target: PublishTargetKind): ProjectDeleteStep => ({ target, kind: 'failed', line: `${target}: 失敗（テスト）`, view: null, words: null })
export const cancelled = (target: PublishTargetKind): ProjectDeleteStep => ({ target, kind: 'cancelled', line: `${target}: 破棄をキャンセルしました` })
export const facts = (over: Partial<ProjectDeleteFacts> = {}): ProjectDeleteFacts =>
  ({ targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null, ...over })
export const plan = (teardown: PublishTargetKind[], block: ProjectDeletePlan['block'] = null, twinned: ProjectDeletePlan['twinned'] = []): ProjectDeletePlan => ({ block, teardown, twinned })
export const kinds = (steps: readonly ProjectDeleteStep[]) => steps.map(s => `${s.target}:${s.kind}`)

/** 偽の deps。calls は呼ばれた順。teardown は targets ごとに outcome の step を返す（既定は done）。 */
export function harness(init: {
  outcome?: Partial<Record<PublishTargetKind, ProjectDeleteStep | ((t: PublishTargetKind) => ProjectDeleteStep)>>
  running?: RunningOpEntry | null | 'throws'
  exists?: boolean
  trashThrows?: string
  /** main の fs:trashProject が「覆う複製が見つからなくなった」と断る（TwinsGoneError を投げる）。回数分だけ（既定は断らない）。 */
  trashTwinsGone?: number
  nextFacts?: ProjectDeleteFacts
} = {}) {
  const h = { calls: [] as string[], teardownTargets: [] as PublishTargetKind[][], trashed: [] as string[], skipped: [] as PublishTargetKind[][], twinsGoneLeft: init.trashTwinsGone ?? 0, dirs: [] as string[], outcome: init.outcome ?? {}, running: init.running ?? null, exists: init.exists ?? true, trashThrows: init.trashThrows, nextFacts: init.nextFacts ?? facts(), teardownThrows: false }
  const deps: ProjectDeleteRunDeps = {
    readFacts: async (d) => { h.calls.push('readFacts'); h.dirs.push(d); return h.nextFacts },
    teardown: async (d, targets) => {
      h.calls.push('teardown'); h.dirs.push(d); h.teardownTargets.push([...targets])
      if (h.teardownThrows) throw new Error('破棄が投げた（テスト）')
      return targets.map(t => { const o = h.outcome[t]; return typeof o === 'function' ? o(t) : o ?? done(t) })
    },
    runningOp: async () => { h.calls.push('runningOp'); if (h.running === 'throws') throw new Error('聞けない（テスト）'); return h.running },
    exists: async () => { h.calls.push('exists'); return h.exists },
    trash: async (p, skippedForTwins) => {
      h.calls.push('trash'); h.skipped.push([...skippedForTwins])
      if (h.twinsGoneLeft > 0) { h.twinsGoneLeft--; throw new TwinsGoneError(TWINS_GONE_MESSAGE) }
      if (h.trashThrows) throw new Error(h.trashThrows)
      h.trashed.push(p)
    },
  }
  return { h, deps }
}
export const TRASH = ['runningOp', 'exists', 'trash']
/** main の断りの文（fs:trashProject の twinsGone）そのまま。 */
export const TWINS_GONE_MESSAGE = '同じ公開の記録を持つフォルダが見つからなくなったため、移していません。もう一度「ゴミ箱に移動」を押すと、破棄から始めます。'
/** いま走っている操作（publishMeta:runningOp の戻り）。公開先の既定は HANAMII。 */
export const RUNNING = (op: RunningOpEntry['op'], target: RunningOpEntry['target'] = 'hanamii'): RunningOpEntry => ({ op, target })
