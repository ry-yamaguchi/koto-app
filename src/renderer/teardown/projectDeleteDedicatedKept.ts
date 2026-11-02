// teardown/projectDeleteDedicatedKept.ts — 専有型で、残っている保存場所（印）が全部「消さずに残す」ため、プロジェクトの削除が止めなかった回の、plan に載せる保存場所と、赤い箱の 💾 の1行（純関数）。
//
// 判断（止めるか）は shared/teardownSupport.ts の dedicatedLeftoverAllKept の1つで、projectDeletePlan.ts の projectDeleteBlockOf が使う。ここは、止めずに外した回の
// 「どの保存場所が残るか」を plan に載せる関数と、その文の作り手。window・React・IPC に触らない。
// 文は teardownDataNoteForAll の答えそのもの（新しい文は作らない。確認・赤い箱・手順6の行と同じ作り手）。

import type { ProjectDeleteFacts, ProjectDeleteBlock } from './projectDeletePlan'
import { dedicatedLeftoverAllKept, dedicatedLeftoverMarkNames, dedicatedTeardownHasWork, teardownDataNoteForAll } from '../../shared/teardownSupport'

/** plan に載せる保存場所1件（印の名前に当たる facts.placements の要素。`keep` 付き）。 */
export type DedicatedKeptPlacement = ProjectDeleteFacts['placements'][number]

/** 保存場所を、名前と prefix の組で見分ける鍵（同じバケットの別の prefix は別の保存場所）。 */
const pairKey = (p: { bucket: string; prefix: string }): string => `${p.bucket}|${p.prefix}`

/**
 * 「保存場所が全部残す側」を理由に止めなかった回だけ、残す保存場所を返す（それ以外は null。plan にはキーごと載せない）。
 * その回とは、専有型の行か残りの印があり、資源の ID が無く、印の保存場所が全部残す側（dedicatedLeftoverAllKept）で、
 * 止める理由が無い（block が null）うえに、覆う複製で外した回でもないとき。
 * 覆う複製で外した回は載せない（その回は、専有型を破棄しないことを複製の文が言う。保存場所が残ることは、共用型の記録を読めた回だけ段なしの注意が言う）。
 */
export function dedicatedKeptOf(facts: ProjectDeleteFacts, dedicatedTwinned: boolean, block: ProjectDeleteBlock): DedicatedKeptPlacement[] | null {
  if (block !== null || dedicatedTwinned) return null
  if (!facts.targets.includes('sakura-apprun-dedicated') && !dedicatedTeardownHasWork(facts.dedicated)) return null
  if (!dedicatedLeftoverAllKept(facts.dedicated, facts.placements)) return null
  const names = new Set(dedicatedLeftoverMarkNames(facts.dedicated) ?? [])
  const kept = facts.placements.filter(p => names.has(p.bucket))
  return kept.length > 0 ? kept : null
}

/** いま画面に出ている 💾 の行（専有型の行のほかのもの）。真の行が、保存場所を名指ししている。 */
export type NotesOnScreen = {
  /** 公開先の行（rowStorageNotesOf）。facts.placements の全件を名指しする。 */
  rowNotes: boolean
  /** 残りの段の行（leftoverStorageNoteLine）。facts.sharedLeftover.placements を名指しする。 */
  leftoverLine: boolean
  /** チェックを外したときの行（keptStorageNoteOf）。facts.sharedLeftover.placements と facts.placements の全件を名指しする。 */
  keptNote: boolean
  /** 段を足さなかった残りの注意（unsteppedLeftoverNote）。facts.sharedLeftover.placements を名指しする。 */
  leftoverNote: boolean
}

/**
 * 赤い箱に出す専有型の 💾 の1行（`dedicatedKept` が plan に載った回だけ。無い回は空）。
 * 専有型の保存場所も共用型と同じ env.json の同意済みの保存場所なので、共用型の記録を読めた回は、ほかの 💾 の行が同じ保存場所をすでに「残ります」と言う。
 * すでに名指しされた保存場所（名前と prefix の組）は除き、残りが無ければ空（出さない）。ほかの行が名指ししない回（共用型の記録を読めなかった回など）だけ、この行が言う。
 */
export function dedicatedKeptNoteOf(
  plan: { dedicatedKept?: readonly DedicatedKeptPlacement[] },
  facts: Pick<ProjectDeleteFacts, 'sharedLeftover' | 'placements'>,
  shown: NotesOnScreen,
): string {
  const kept = plan.dedicatedKept
  if (!kept || kept.length === 0) return ''
  const named = new Set<string>()
  const shared = facts.sharedLeftover?.placements ?? []
  if (shown.rowNotes || shown.keptNote) for (const p of facts.placements) named.add(pairKey(p))
  if (shown.leftoverLine || shown.keptNote || shown.leftoverNote) for (const p of shared) named.add(pairKey(p))
  const rest = kept.filter(p => !named.has(pairKey(p)))
  return rest.length === 0 ? '' : teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', placements: [...rest] })
}
