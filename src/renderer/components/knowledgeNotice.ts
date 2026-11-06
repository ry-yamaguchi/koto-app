// 資料の窓で、操作が失敗したことを帯に出す文（0.6.26）。
// 原因が空のとき「…に失敗しました: 」で途切れないよう、原因があるときだけ「: 原因」を足す。
import { wrapFailureText, joinFailureDetail } from '../../shared/failureDetail'
import { classifyFailure, failureText, failureDetailOf } from '../../shared/failureText'

/** 「更新に失敗しました: 原因」。原因が空・空白だけなら「更新に失敗しました」で終える。 */
export function knowledgeFailureNotice(action: '追加' | '更新' | '削除', error: string | null | undefined): string {
  const cause = (error ?? '').trim()
  // 原因の末尾の「詳細: 原文」は、前置きの外（文の最後の行）に残す
  return cause ? wrapFailureText(cause, t => `${action}に失敗しました: ${t}`) : `${action}に失敗しました`
}

/** 出典の元ページを取りに行って失敗したときの文。回線・時間切れ・証明書は理由の文にし、見分けられない失敗は今の固定文に原文を添える。 */
export function sourcePageFailureText(e: unknown): string {
  if (classifyFailure(e).kind !== 'unknown') return failureText(e, { readOnly: true })
  return joinFailureDetail('元のページを取得できませんでした', failureDetailOf(e))
}
