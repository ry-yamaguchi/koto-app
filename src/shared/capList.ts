// capList.ts — 並べる件数の上限。超えた分は「ほかN件」の1つにまとめる（純関数）。
// 画面側（公開前チェック）と shared 側（書いた中身の点検）が同じ定義を使う。

/**
 * 名前一覧を先頭 n 件に切り、超過分は「ほかN件」の1行にまとめる（純関数）。
 * 上限以下ならそのまま返す（「ほか0件」のような無意味な注記は付けない）。
 */
export function capList(names: readonly string[], n: number): string[] {
  if (names.length <= n) return [...names]
  return [...names.slice(0, n), `ほか${names.length - n}件`]
}
