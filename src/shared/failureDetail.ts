// 置き換えた失敗の文に添える「詳細」（原文）の運び方（純関数のみ・electron 非依存）。
//
// 日本語の1文に置き換えた失敗では、原文（例: getaddrinfo ENOTFOUND <ホスト>・CERT_HAS_EXPIRED）を捨てない。
// 問い合わせ（さくら・Anthropic・作者）で原因を見分けるのに要るため。画面では文のすぐ下に小さく出し、
// 📋 コピーには文・詳細・Koto の版・日時を入れる。
//
// 文の形は `<日本語の文>\n詳細: <原文>`。詳細はいつも最後の1行（改行は作るときに空白へまとめる）。
// 描く側は splitFailureDetail で分けて、詳細の行だけを小さく描く（FailureLines）。
// 別の文に埋め込むときは wrapFailureText を通す（詳細を文の途中に挟まない）。
// 詳細を作るのは failureText.ts の failureDetailOf の1か所（秘密の形とホームのパスはそこで伏せる）。

import { maskSecretShapes } from './secretShapes'
import { maskHomePath } from './homePath'

export const FAILURE_DETAIL_LABEL = '詳細: '
const SEP = `\n${FAILURE_DETAIL_LABEL}`
/** 文の最後の行が「詳細: …」のときだけ詳細とみなす（途中にあるものは詳細ではない）。 */
const TRAILING_DETAIL = /\n詳細: ([^\n]*)$/

/** 文と詳細に分ける。詳細が無ければ detail は ''（文はそのまま）。 */
export function splitFailureDetail(shown: string): { text: string; detail: string } {
  const s = String(shown ?? '')
  const m = TRAILING_DETAIL.exec(s)
  if (!m || m[1].trim() === '') return { text: s, detail: '' }
  return { text: s.slice(0, m.index), detail: m[1] }
}

/** 文に詳細を添える。詳細が空なら文のまま。文がすでに詳細を持っていれば、新しい詳細で置き換えない（先に付いたほうが本物の原文）。 */
export function joinFailureDetail(text: string, detail: string): string {
  const d = String(detail ?? '').replace(/\s+/g, ' ').trim()
  if (!d) return text
  if (splitFailureDetail(text).detail) return text
  return `${text}${SEP}${d}`
}

/** 詳細つきの文を、別の文に埋め込む。埋め込むのは日本語の文だけで、詳細は外側の文の最後に移す。
 *  例: wrapFailureText(failureText(e), t => `チェックに失敗しました（${t.replace(/。$/, '')}）。`) */
export function wrapFailureText(shown: string, wrap: (text: string) => string): string {
  const { text, detail } = splitFailureDetail(shown)
  return joinFailureDetail(wrap(text), detail)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 2026-11-05 00:36 の形（その機械の時刻）。 */
export function formatCopyStamp(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}

/** 📋 コピーで写す文。文・詳細・Koto の版・日時（コピーした時刻）。問い合わせや公開の投稿に貼られうるので、
 *  秘密の形とホームのパスを伏せてから返す（詳細は作るときにも伏せてあるが、文の側〔見分けられない失敗の原文など〕も伏せる）。 */
export function failureCopyText(shown: string, meta: { version?: string; at: Date }): string {
  const { text, detail } = splitFailureDetail(shown)
  const lines = [text.trimEnd()]
  if (detail) lines.push(`${FAILURE_DETAIL_LABEL}${detail}`)
  lines.push(`Koto ${meta.version?.trim() || '不明'}・${formatCopyStamp(meta.at)}`)
  return maskHomePath(maskSecretShapes(lines.join('\n')))
}
