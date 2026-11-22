import { AiText } from './AiMessage'
import { reportParts, type ReportPart } from '../securityCheck'

/**
 * 公開前セキュリティチェックの結果の本文（SecurityCheckSection の問題なし側・要確認側が同じものを使う）。
 *
 * 結果の行は Koto が組み立てたもの（ai: false）で、文字のまま出す（plain）。
 * ファイル名や AI の説明の中の ** や ` を解釈すると、太字・コードになり、実在しない名前に見える。
 * fold の付いた行は、続くものをまとめて閉じた <details> に入れ、fold の文を <summary> に出す。
 * 外側の見た目（大きさ・色・select-text・高さ）は、ここで1回だけ決める。
 */
type Block = { fold?: string; parts: ReportPart[] }

function blocksOf(parts: readonly ReportPart[]): Block[] {
  const blocks: Block[] = []
  for (const p of parts) {
    const last = blocks[blocks.length - 1]
    if (last && last.fold === p.fold) last.parts.push(p)
    else blocks.push({ fold: p.fold, parts: [p] })
  }
  return blocks
}

export default function SecurityReportBody({ result }: { result: { report: string; parts?: readonly ReportPart[] } }) {
  return (
    <div className="text-xs text-ink-secondary select-text max-h-52 overflow-y-auto space-y-2">
      {blocksOf(reportParts(result)).map((b, i) => {
        const items = b.parts.map((p, j) => <AiText key={j} content={p.text} plain={!p.ai} />)
        return b.fold
          ? (
            <details key={i} className="rounded-lg border border-line p-2">
              <summary className="cursor-pointer select-none text-xs font-semibold text-ink">{b.fold}</summary>
              <div className="mt-2 space-y-2">{items}</div>
            </details>
          )
          : <div key={i} className="space-y-2">{items}</div>
      })}
    </div>
  )
}
