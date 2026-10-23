import { AiText } from './AiMessage'

/**
 * 検索の結果。**回答だけでなく、どの資料のどこが当たったかまで持つ**
 * （2026-08-25 Ryosuke と設計）。応答は前からこれを返していたのに、
 * **画面が資料名しか使わずに捨てていた**。
 */
export interface KnowledgeAnswerData {
  text: string
  hits: { name: string; where: string; excerpt: string }[]
}

/** 「資料に聞く」手順3の結果の枠（回答の文＋見つかったところ）。KnowledgeModal から切り出した。 */
export default function KnowledgeAnswer({ answer }: { answer: KnowledgeAnswerData }) {
  return (
    <div className="bg-elevated border border-line rounded-lg p-3 space-y-3">
      {answer.text && (
        <AiText content={answer.text} className="text-sm text-ink select-text" />
      )}
      {answer.hits.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-ink-secondary">見つかったところ</p>
          {answer.hits.map((h, i) => (
            <div key={i} className="border-l-2 border-line pl-2.5 space-y-1">
              <p className="text-[11px] text-ink-secondary">
                📄 {h.name}{h.where ? ` ・ ${h.where}` : ''}
              </p>
              <p className="text-[11px] text-ink-muted whitespace-pre-wrap select-text leading-relaxed">{h.excerpt}</p>
            </div>
          ))}
        </div>
      ) : (
        // **見つからなかったことを、はっきり言う**（回答だけ出すと効いたように見える）
        <p className="text-[11px] text-ink-muted">
          当てはまる資料は見つかりませんでした。言葉を変えて試すか、資料が登録されているか確かめてください。
        </p>
      )}
    </div>
  )
}
