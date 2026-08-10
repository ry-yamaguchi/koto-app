// edit_file ツール（部分編集）の置換ロジック。UI/IPCに依存しない純粋関数として切り出し、単体テスト可能にする。
// old_string は正規表現ではなく単純なリテラル文字列として扱う（特殊文字をエスケープせずそのまま一致させる）。
// 実際のツール実行（executeTool の edit_file 分岐）はこの関数の結果を使って保存処理を行うだけにする。

export type ApplyEditResult =
  | { ok: true; next: string; count: number }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'empty-old' | 'no-change'; count: number }

/**
 * content 内の oldString（リテラル文字列一致）を newString に置換する。
 * - oldString が空、または oldString === newString はエラー扱い（呼び出し側の意図ミスの可能性が高いため）。
 * - 一致が0件は not-found。
 * - 一致が2件以上かつ replaceAll=false は ambiguous（意図しない箇所を誤って書き換えないための安全策）。
 * - 一致が2件以上かつ replaceAll=true は全件を置換する。
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): ApplyEditResult {
  if (oldString === '') return { ok: false, reason: 'empty-old', count: 0 }
  if (oldString === newString) return { ok: false, reason: 'no-change', count: 0 }

  const count = countOccurrences(content, oldString)
  if (count === 0) return { ok: false, reason: 'not-found', count: 0 }
  if (count > 1 && !replaceAll) return { ok: false, reason: 'ambiguous', count }

  const next = replaceAll ? content.split(oldString).join(newString) : replaceFirst(content, oldString, newString)
  return { ok: true, next, count: replaceAll ? count : 1 }
}

/** needle の出現回数を数える（リテラル一致・正規表現ではない）。 */
function countOccurrences(content: string, needle: string): number {
  let count = 0
  let idx = 0
  for (;;) {
    const found = content.indexOf(needle, idx)
    if (found === -1) break
    count++
    idx = found + needle.length
  }
  return count
}

/** 最初の1件だけをリテラル置換する。 */
function replaceFirst(content: string, oldString: string, newString: string): string {
  const idx = content.indexOf(oldString)
  if (idx === -1) return content
  return content.slice(0, idx) + newString + content.slice(idx + oldString.length)
}
