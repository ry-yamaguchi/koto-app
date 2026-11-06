// 🕘 履歴の窓で、戻せなかったことを知らせる文（react に依存しない）。
// 原因（権限・空き・見つからない・回線）の文と詳細は main が作る。ここは前置きに埋め込むだけで、詳細は文の最後の行に残す。
import { wrapFailureText } from '../shared/failureDetail'

/** 復元そのものが失敗したときの文。原因が空なら前置きだけ。 */
export function restoreFailedNotice(message: string | null | undefined): string {
  const cause = (message ?? '').trim()
  return cause ? wrapFailureText(cause, t => `⚠️ 復元できませんでした: ${t}`) : '⚠️ 復元できませんでした'
}

/** 復元はできたが、一部のファイルだけ戻せなかったときの1行（成功の文のあとに足す）。理由が無ければ、理由を言わずに名前だけ並べる。 */
export function restorePartialLine(failed: readonly string[], reason: string | null | undefined): string {
  const names = failed.join('、')
  const cause = (reason ?? '').trim()
  return cause
    ? wrapFailureText(cause, t => `⚠️ ただし次のファイルは戻せませんでした: ${names}。${t}`)
    : `⚠️ ただし次のファイルは戻せませんでした: ${names}`
}
