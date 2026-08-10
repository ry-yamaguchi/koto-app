// チャットでのWebページ参照のための共通ロジック。
// ユーザーのメッセージ中のURLを検出し、ページ本文を取得してAIへの送信内容に添付する。
// （AI側からの参照は aiTools.ts の fetch_url ツールで行う）

const URL_RE = /https?:\/\/[^\s<>"'）)\]」】]+/g
const MAX_URLS_PER_MESSAGE = 3

/** メッセージ中のURLを抽出（重複除去・最大3件） */
export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? []
  return [...new Set(found)].slice(0, MAX_URLS_PER_MESSAGE)
}

/**
 * URL群のページ本文を取得し、AIに渡す添付ブロック文字列を作る。
 * 取得に失敗したURLはエラー内容を明記する（AIが状況を説明できるように）。
 */
export async function fetchPagesBlock(urls: string[]): Promise<string> {
  if (urls.length === 0) return ''
  const parts: string[] = []
  for (const url of urls) {
    try {
      const page = await window.electronAPI.web.fetchPage(url)
      parts.push(
        `--- 参照ページ: ${page.url}${page.title ? `（${page.title}）` : ''} ---\n` +
        page.content
      )
    } catch (e: any) {
      parts.push(`--- 参照ページ: ${url} ---\n（取得できませんでした: ${e?.message ?? e}）`)
    }
  }
  return (
    `\n\n# IDEが取得したWebページの内容（ユーザーには表示されない参考情報）\n` +
    parts.join('\n\n')
  )
}

export type WebSearchConfig = { provider: 'tavily' | 'brave'; key: string }

// 自動Web検索の起動条件（ユーザーが検索を望んでいそうなメッセージか）。
export function wantsWebSearch(text: string): boolean {
  return /(検索|調べ|ぐぐっ|ググっ|最新|時事|ニュース|相場|発売|リリース日|公式(サイト|情報|ページ)|現在の|今の)/.test(text)
}

// メッセージから検索クエリを抽出（「検索して」「表で」等の命令・体裁語を除いて要点を残す）。
export function searchQueryFromMessage(text: string): string {
  const q = text
    .replace(/(を|について)?(web|ウェブ)?(で)?(検索|調べ|ぐぐっ|ググっ)(て|して)?(ください|くれ|ほしい|みて)?/g, ' ')
    .replace(/(教えて|まとめて|出して|作って|一覧|表)(に|で)?(して)?(ください)?/g, ' ')
    .replace(/[。、！？\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return q || text.trim()
}

// 検索意図があり、キーがあり、メッセージにURLが無い場合に、IDEが検索を実行して結果ブロックを返す（モデル非依存）。
// URLがある場合は fetchPagesBlock 側に任せるため空文字を返す。
export async function autoSearchBlock(text: string, config: WebSearchConfig | null): Promise<string> {
  if (!config) return ''
  if (extractUrls(text).length > 0) return ''
  if (!wantsWebSearch(text)) return ''
  const query = searchQueryFromMessage(text)
  if (!query) return ''
  try {
    const results = await window.electronAPI.web.search(config.provider, config.key, query)
    if (!results.length) {
      return `\n\n# IDEが実行したWeb検索（クエリ: "${query}"・ユーザーには表示されない参考情報）\n（結果が見つかりませんでした。推測で創作せず、その旨を伝えてください）`
    }
    const body = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join('\n\n')
    return (
      `\n\n# IDEが実行したWeb検索の結果（クエリ: "${query}"・ユーザーには表示されない参考情報）\n` +
      body +
      `\n\nこの検索結果を根拠に回答してください。結果に無い事実は推測で創作しないこと。さらに詳しいページ本文が必要なら fetch_url（対応モデルのみ）で取得できます。`
    )
  } catch (e: any) {
    return `\n\n# IDEが実行したWeb検索（クエリ: "${query}"）\n（検索に失敗しました: ${e?.message ?? e}。推測で創作せず、その旨を伝えてください）`
  }
}
