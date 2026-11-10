// acceptedMark.ts — HANAMII の「受け付けの印」の作り手（純関数。electron に依存しない）。
//
// 印の形と読み方は shared/publishMeta.ts（`HanamiiDeletionAcceptedMark`・`hanamiiDeletionAcceptedOf`）、書き手は publishMetaFs.ts の
// `writeHanamiiAcceptedMarkFs`。ここは「202 を受けた事実と、確認で見せた保存場所」から印の中身を組むだけ。
import { parseShownPlacements } from '../cloud/storageSelection'
import type { HanamiiDeletionAcceptedMark } from '../../shared/publishMeta'

/**
 * 印の中身を組む。`shown` は画面が運んだ「確認で見せた保存場所」の値で、形を信用しない
 * （`parseShownPlacements` を通し、形が違えば空＝続きの自動の確かめでは1件も消さない側に倒す）。
 */
export function buildHanamiiAcceptedMark(a: {
  projectId: string
  acceptedAt: Date
  shown: unknown
  requiresReview: boolean
  operationId: string | null
}): HanamiiDeletionAcceptedMark {
  return {
    projectId: a.projectId,
    acceptedAt: a.acceptedAt.toISOString(),
    shownPlacements: parseShownPlacements(a.shown) ?? [],
    requiresReview: a.requiresReview,
    ...(a.operationId ? { operationId: a.operationId } : {}),
  }
}
