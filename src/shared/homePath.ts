// homePath.ts — 診断の記録に書く文から、ホームのパス（利用者名）を `~` に置き換える（純関数）。
//
// 記録（crash.log など）は利用者が作者へ送る前提で、貼り付け先が公開の場所のこともある。エラーの文とスタックには
// `/Users/<利用者名>/…` の絶対パスが入るので、書く前に落とす。秘密の除去（redactSecrets）とは別の話で、
// どちらも書く直前に通す。置き換えるのは利用者名までで、その下のフォルダ名（プロジェクトの場所）は調べるのに要るので残す。

/** 正規表現の特別な字を無害にする。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** パスの切れ目（この字が続くとき、ホームのパスは別の名前の一部ではない）。 */
const PATH_END = String.raw`(?=[/\\\s'"\x60:;,)\]}>]|$)`

/**
 * ホームのパスを `~` に置き換える。`home`（`os.homedir()`）が分かればその文字列を、分からなくても macOS の
 * `/Users/<名前>` を置き換える。URL の途中の `/Users/`（`https://example.com/Users/…`）は当てない。
 * もう一度かけても結果は変わらない。
 */
export function maskHomePath(text: string, home?: string): string {
  let out = String(text ?? '')
  const h = typeof home === 'string' ? home.replace(/[/\\]+$/, '') : ''
  if (h.length > 1) out = out.replace(new RegExp(`${escapeRe(h)}${PATH_END}`, 'g'), '~')
  return out.replace(/(?<![\w.:-])\/Users\/(?!Shared(?=[/\s'"`:;,)\]}>]|$))[^/\s'"`:;,)\]}>]+/g, '~')
}
