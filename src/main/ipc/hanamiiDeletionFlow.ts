// hanamiiDeletionFlow.ts — HANAMII が削除を受け付けた（202）あとの流れ（hanamii:teardown の `accepted` の枝と、hanamii:resumeTeardown が通る1つ）。
//
//   受け付けの印を書く（呼び手）→ requiresReview なら止める → 待つ（deletionWait.ts）→ gone なら `onGone`（保存場所の段）、
//   待ち切れなかった・確かめられなかった・確認が要る回は、保存場所にも記録にも触れずに「まだ済んでいない」を返す（印は残る）。
//
// **「消えた」と読むのは deleteReply.ts の1か所**（待つ側は DELETE の読みだけで gone を決める）。判断を足さない。
// 最初の破棄（DELETE を送ったあと）も、次に開いたときの自動の続き（GET から始める）も、この関数を通る。
// 型は hanamiiTeardown.ts から `import type` だけ（実行時の循環を作らない）。
import type { HanamiiClient } from '../hanamii/client'
import { waitForHanamiiDeletion } from '../hanamii/deletionWait'
import type { TeardownShellCtx } from '../cloud/teardownShell'
import type { HanamiiTeardownResult } from './hanamiiTeardown'
import type { HanamiiDeletionAcceptedMark } from '../../shared/publishMeta'
import { HANAMII_DELETION_ACCEPTED_WARNING, HANAMII_DELETION_REVIEW_WARNING, HANAMII_ACCEPTED_MARK_FAILED_LINE } from '../../shared/teardownResult'
import { joinFailureDetail } from '../../shared/failureDetail'

/** 削除がまだ済んでいない回の結果。確認が要る印（requiresReview）の回は、その文。`detail` は確かめられなかった回の原文。 */
export function pendingDeletionResult(
  mark: Pick<HanamiiDeletionAcceptedMark, 'requiresReview' | 'operationId'>,
  extra: { detail?: string; markFailure?: string | null } = {},
): HanamiiTeardownResult {
  const base = mark.requiresReview ? HANAMII_DELETION_REVIEW_WARNING : HANAMII_DELETION_ACCEPTED_WARNING
  const detail = extra.detail ? (mark.operationId ? `${extra.detail}（operationId: ${mark.operationId}）` : extra.detail) : ''
  return {
    ok: false, appDeleted: false, deletionAccepted: true,
    ...(mark.requiresReview ? { deletionReview: true } : {}),
    message: joinFailureDetail(base, detail),
    // 印を書けなかった回だけ、続きの自動の確かめが効かないことを言う（原因は最後）。
    ...(extra.markFailure ? { executed: [`${HANAMII_ACCEPTED_MARK_FAILED_LINE}: ${extra.markFailure}`] } : {}),
  }
}

export async function continueAcceptedDeletion<A extends { token: string }>(args: {
  ctx: TeardownShellCtx<A>
  client: HanamiiClient
  projectId: string
  mark: HanamiiDeletionAcceptedMark
  /** 呼び手が、待ち始める直前に DELETE を送った（最初の破棄）。続きの回は false（GET から始める）。 */
  deleteJustSent: boolean
  /** 上限の直前の確かめの DELETE を送るか。最初の破棄は true。続きの回は false（起動のたびに DELETE を送り直さない）。 */
  finalConfirm: boolean
  /** 最初の破棄の回: 確認が要る印なら、待たずに止める（GET も DELETE も出さない）。続きの回は false（GET が 404 になるまで待つ）。 */
  stopOnReview: boolean
  /** 印を書けなかった理由（書けたら null）。 */
  markFailure: string | null
  /** 削除が済んだと確かめたあと: 保存場所の段（呼び手の持ち物）。 */
  onGone: () => Promise<HanamiiTeardownResult>
}): Promise<HanamiiTeardownResult> {
  const { ctx, client, projectId, mark } = args
  if (args.stopOnReview && mark.requiresReview) return pendingDeletionResult(mark, { markFailure: args.markFailure })
  const waited = await waitForHanamiiDeletion({
    getProject: () => client.getProject(projectId),
    deleteProject: () => client.deleteProject(projectId),
    deleteJustSent: args.deleteJustSent,
    finalConfirm: args.finalConfirm,
    onProgress: (label, detail) => ctx.progress(label, { detail }),
  })
  if (waited.kind === 'gone') return args.onGone()
  return pendingDeletionResult(mark, {
    markFailure: args.markFailure,
    ...(waited.kind === 'unconfirmed' ? { detail: waited.detail } : {}),
  })
}
