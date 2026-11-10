// deleteReply.ts — HANAMII の DELETE の応答の読み方（D7）。**「消えた」と読むのはここ1か所**（破棄の本体も、削除を待つ側も、これを通る）。
//
// 原本（https://hanamii.jp/docs/api の「プロジェクトを削除」）: 200＝物理削除済み（`deleted=true`・`deletion=completed`）、
// 202＝削除受付済み（`deleted=false`・`deletion=accepted`・`operationId`・`requiresReview`。外部リソースの削除が続くとき）、403＝権限不足、
// 404＝プロジェクトが存在しない**または参照できない**、429＝レート制限。削除の途中に押し直したときの応答は原本に無い。
// 以前はハンドラが `r.ok || r.status === 404` だけを見て、202 も「消えた」と読んでいた。
// electron に依存しない。
import type { HanamiiResult } from './client'

export type HanamiiDeleteReading = 'deleted' | 'not-found' | 'accepted' | 'failed'

/** DELETE の応答を読む（純関数）。`deleted === true` と 404 だけが「消えた」側（呼び手が保存場所へ進んでよい）。 */
export function readHanamiiDeleteReply(r: Pick<HanamiiResult, 'ok' | 'status' | 'data'>): HanamiiDeleteReading {
  if (r.status === 404) return 'not-found'
  if (!r.ok) return 'failed'
  const project = (r.data as { project?: unknown } | null | undefined)?.project
  const deleted = project && typeof project === 'object' ? (project as { deleted?: unknown }).deleted : undefined
  return deleted === true ? 'deleted' : 'accepted'
}

/**
 * 受け付けた応答（202 など）の本文から、`requiresReview` と `operationId` を読む（純関数）。
 * **`requiresReview` は真偽値の `true` のときだけ真**（`'true'` の文字列・項目の欠落は偽。待つ側に倒す: 待つ間は保存場所に触れないので安全）。
 * `operationId` は空でない文字列のときだけ（無ければ null）。
 */
export function readHanamiiAccepted(r: Pick<HanamiiResult, 'data'>): { requiresReview: boolean; operationId: string | null } {
  const project = (r.data as { project?: unknown } | null | undefined)?.project
  const p = project && typeof project === 'object' ? project as { requiresReview?: unknown; operationId?: unknown } : {}
  return {
    requiresReview: p.requiresReview === true,
    operationId: typeof p.operationId === 'string' && p.operationId !== '' ? p.operationId : null,
  }
}
