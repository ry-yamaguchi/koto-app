import { AiText } from './AiMessage'
import { reportParts, type ReportPart } from '../securityCheck'

/**
 * 公開前セキュリティチェックの結果の本文（SecurityCheckSection の問題なし側・要確認側が同じものを使う）。
 *
 * 結果には AI が書いた行と、Koto が組み立てた行（確認しなかったファイル名の一覧など）が混ざる。
 * AI の行だけを太字・箇条書きに描き（AiText）、Koto の行は文字のまま出す（plain）。
 * Koto の行をそのまま解釈すると、ファイル名の中の ** や ` が太字・コードになり、実在しない名前に見える。
 * 外側の見た目（大きさ・色・select-text・高さ）は、ここで1回だけ決める。
 */
export default function SecurityReportBody({ result }: { result: { report: string; parts?: readonly ReportPart[] } }) {
  return (
    <div className="text-xs text-ink-secondary select-text max-h-52 overflow-y-auto space-y-2">
      {reportParts(result).map((p, i) => <AiText key={i} content={p.text} plain={!p.ai} />)}
    </div>
  )
}
