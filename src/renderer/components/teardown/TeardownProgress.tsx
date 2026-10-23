// TeardownProgress.tsx — 破棄（削除）の進み具合の見た目。公開先によらず、共通の1つ。
//
// 段階0で作った部品（いまは3つの公開先〔共用型・HANAMII・専有型〕の入口がすべてこれを通る）。設計書: docs/teardown-unify-plan.md の 10.3.2 (7)。
// 描くだけの部品（判断を持たない）。流れの本体は teardown/flow.ts・teardown/useTeardownFlow.ts。
//
// 破棄の記録しか見ない道なので `running: boolean`（teardownProgressText と同じ理由）。
// 「閉じても進む」の文の動詞は、公開先の言葉（words.verb: 破棄／削除）から作る（1回の流れの中で名前を変えない）。
import { PUBLISH_QUIT_STOPS } from '../../activity'
import { opElapsedText } from '../../projectOpsView'
import type { TeardownWords } from '../../teardown/types'
import StageEstimate from '../StageEstimate'

/**
 * 実行中の進み具合。**破棄が走っている間だけ**置く（呼び出し側が tearingDown のときだけ描く）。
 * 段は記録の progress.stage（内部名）で見分ける——文では見分けない。目安が無い段には何も出ない（StageEstimate）。
 */
export default function TeardownProgress({ words, progress, running, runningRecord, nowMs }: {
  words: TeardownWords
  /** 進み具合の文（teardownProgressText の結果）。 */
  progress: string | null
  /** 記録（projectOps）が「この公開先の破棄が走っている」と言っているか。 */
  running: boolean
  runningRecord: { startedAt: number; progress?: { stage?: string } } | null
  nowMs: number
}) {
  return (
    <>
      {/* 各段が一覧から消えるまで待つ間の進み具合（専有型は30秒ごとに1回届く）。 */}
      {progress && <p className="text-xs text-ink-secondary leading-relaxed select-text" data-teardown-progress>{progress}</p>}
      {/* 待っている段の目安。段は記録の progress.stage（内部名）で見分ける。文では見分けない。 */}
      {running && <StageEstimate stage={runningRecord?.progress?.stage} />}
      {/* 閉じて開き直したあとでも、いつから走っているか・閉じてよいかが分かるように。 */}
      {running && runningRecord && (
        <>
          <p className="text-[11px] text-ink-muted leading-relaxed">{opElapsedText(runningRecord.startedAt, nowMs)}</p>
          <p className="text-[11px] text-ink-muted leading-relaxed">この画面を閉じても、{words.verb}は最後まで進みます。{PUBLISH_QUIT_STOPS}</p>
        </>
      )}
    </>
  )
}
