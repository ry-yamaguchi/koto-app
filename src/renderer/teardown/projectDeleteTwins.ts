// teardown/projectDeleteTwins.ts — プロジェクトの削除で、**覆う複製**（同じ親フォルダの別のフォルダで、自分の公開の記録をすべて持つもの。R2-d）がある公開先の扱い（純関数）。
//
// 0.6.24 I-3（作者の決定 K1）。projectDeletePlan.ts の planProjectDeleteTeardown が呼ぶ。window・React・IPC に触らない。
// 覆うかどうかの判断は main の `recordCoverFs`（cloud/recordTwins.ts。cloud:recordTwins がこの答えを返す）の1つ。一部だけを持つ複製（重なるが覆わない）は、ここに入らず破棄の対象に残る
// （main の破棄の骨が「重なる」で断り、手順が failed になってフォルダは移らない）。ここは、main の答え（facts.twins）をどう使うかだけを決める:
//   ・複製のある公開先は、先に破棄する公開先（plan.teardown）から外して twinned に入れる。破棄せずに、フォルダだけ移す（複製が同じ記録を持つので、記録を失わない）
//   ・**複製を読めなかった回（twins が null）・形の違う値は、何も外さない**（外すと、複製があるかも分からないまま破棄せずに移してしまう。外さなければ、
//     main の破棄の骨が複製を見つけて断り、step が failed になって移らない）
import { PUBLISH_TARGET_LABEL, type PublishTargetKind } from '../publishStatus'
import { folderNamesText } from '../../shared/objectStorage'

/** 複製を数える公開先（main の `TWIN_TARGETS`〔cloud/recordTwins.ts〕と同じ並び）。 */
export const TWIN_TARGETS = ['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'] as const
export type TwinTarget = (typeof TWIN_TARGETS)[number]
/** 公開先ごとの複製のフォルダ名（main の cloud:recordTwins の `twins` と同じ形）。 */
export type RecordTwinsFacts = Record<TwinTarget, readonly string[]>
/** 複製があるので、このプロジェクトの削除では破棄しない公開先と、その複製のフォルダ名。 */
export type TwinnedTarget = { target: PublishTargetKind; folders: readonly string[] }

/** 公開先の複製のフォルダ名。読めなかった（`twins` が null）・知らない公開先・形の違う値は、空（＝外さない）。 */
export function twinFoldersOf(twins: RecordTwinsFacts | null | undefined, target: PublishTargetKind): string[] {
  if (!twins || !(TWIN_TARGETS as readonly string[]).includes(target)) return []
  const v = twins[target as TwinTarget]
  return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && n !== '') : []
}

/** 先に破棄する公開先の並びを、複製のないもの（破棄する）と、あるもの（破棄しない）に分ける。並びは保つ。 */
export function splitByTwins(targets: readonly PublishTargetKind[], twins: RecordTwinsFacts | null | undefined): { teardown: PublishTargetKind[]; twinned: TwinnedTarget[] } {
  const teardown: PublishTargetKind[] = []
  const twinned: TwinnedTarget[] = []
  for (const t of targets) {
    const folders = twinFoldersOf(twins, t)
    if (folders.length === 0) teardown.push(t)
    else twinned.push({ target: t, folders })
  }
  return { teardown, twinned }
}

/** 複製があるので破棄しない公開先の、赤い箱へ出す文（止めない）。 */
export function twinnedNote(entry: TwinnedTarget): string {
  return `${PUBLISH_TARGET_LABEL[entry.target]}は破棄しません（${folderNamesText(entry.folders)}にも同じ公開の記録があります）。`
}
