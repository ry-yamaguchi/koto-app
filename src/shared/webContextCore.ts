// webContextCore.ts — チャットでのWebページ参照のうち、window/electron に依存しない
// 純粋な部分（renderer の webContext.ts から実体を移した）。
//
// なぜ shared にあるか（B'-3b）: 次の段で main プロセスで動くループ（chatTurn.ts）の
// ports.h を、renderer からも main からも同じ実装で組み立てられるようにするため。

const URL_RE = /https?:\/\/[^\s<>"'）)\]」】]+/g
const MAX_URLS_PER_MESSAGE = 3

/** メッセージ中のURLを抽出（重複除去・最大3件） */
export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? []
  return [...new Set(found)].slice(0, MAX_URLS_PER_MESSAGE)
}

// 自動Web検索の起動条件（ユーザーが検索を望んでいそうなメッセージか）。
export function wantsWebSearch(text: string): boolean {
  return /(検索|調べ|ぐぐっ|ググっ|最新|時事|ニュース|相場|発売|リリース日|公式(サイト|情報|ページ)|現在の|今の)/.test(text)
}
