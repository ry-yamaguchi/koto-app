// 使っていない画像をゴミ箱へ移したあとに残す一文（0.6.26）。
// 移せなかった画像は alert で別に出さず、同じ帯に一覧で足す（先頭5件まで）。

const SHOWN_FAILED = 5

/** `total` 件のうち `failed`（相対パス）が移せなかったときの帯の文。 */
export function imageTrashNote(total: number, failed: string[]): string {
  const moved = total - failed.length
  const head = moved > 0
    ? `🗑 ${moved}件をゴミ箱へ移しました（Finder のゴミ箱から戻せます）。指摘もそのぶん減ります。`
    : '⚠️ ゴミ箱へ移せませんでした。'
  if (failed.length === 0) return head
  const list = failed.slice(0, SHOWN_FAILED).map(f => `・${f}`).join('\n')
  const more = failed.length > SHOWN_FAILED ? `\n・ほか ${failed.length - SHOWN_FAILED} 件` : ''
  return `${head}\n⚠️ ${failed.length} 件はゴミ箱へ移せませんでした:\n${list}${more}`
}
