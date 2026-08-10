// AIへ送る会話履歴の制限（表示は全件残し、送信だけ絞る）。
// 古い履歴を送り続けるとトークン費用が増え続け、いずれコンテキスト上限で壊れるため。

const MAX_MESSAGES = 20        // 直近10往復まで
const MAX_CHARS_PER_MSG = 4000 // 1メッセージあたりの上限（長いコード貼り付け等を切詰め）

export function limitHistory(msgs: { role: string; content: string }[]): { role: string; content: string }[] {
  const recent = msgs.slice(-MAX_MESSAGES)
  const omitted = msgs.length - recent.length
  const out = recent.map(m => ({
    role: m.role,
    content: m.content.length > MAX_CHARS_PER_MSG
      ? m.content.slice(0, MAX_CHARS_PER_MSG) + '\n…（長いため後半を省略）'
      : m.content,
  }))
  if (omitted > 0) {
    out.unshift({ role: 'system', content: `（注: これより前に${omitted}件の古いやり取りがありますが、送信を省略しています。必要なら read_file 等で現状を確認してください）` })
  }
  return out
}
