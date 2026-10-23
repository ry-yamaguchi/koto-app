// StageTimingDetails.tsx — 結果の下に置く「かかった時間を見る」（折りたたみ）。
//
// 開いたときだけ、段ごとの時間（分と秒）と合計を出す（作者の決定 2026-10-07）。専有型の手順5・6・8の結果と、
// 📡 公開したもの一覧・公開ダイアログ上部の「終わった操作」の枠が、**同じこの部品**を使う（その場で終わった結果も、
// ダイアログを閉じて開き直したときに projectOps の記録から出す結果も、`StageTimings` を渡すだけ＝双子）。
//
// 並べる行・時間の言い方・段の名前は shared/stageTiming.ts の `stageTimingView`（純関数・テストで固定）。ここは描くだけ。
// 時間が無い（段を渡さなかった・早く止まった）ときは何も描かない。
// 途中で止まった回があるとき（`earlierRuns`。設計書 10.13）は、止まった回ごとの見出しと行・「今回」の見出しと行・合計を、
// 1つの一覧に並べる。止まった回が無いときの描き方は、それを足す前と同じ。
import { Fragment } from 'react'
import type { StageTimings } from '../../shared/stageTiming'
import { stageTimingView } from '../../shared/stageTiming'

const HEADING_CLASS = 'pt-1 font-semibold text-ink-secondary'

export default function StageTimingDetails({ timings }: { timings?: StageTimings | null }) {
  if (!timings || !Array.isArray(timings.stages) || timings.stages.length === 0) return null
  const v = stageTimingView(timings)
  const grouped = !!v.earlier
  const row = (r: { stage: string; label: string; text: string }, key: string) => (
    <li key={key} className={`flex items-baseline justify-between gap-3${grouped ? ' pl-3' : ''}`}>
      <span>{r.label}</span>
      <span className="font-mono tabular-nums">{r.text}</span>
    </li>
  )
  return (
    <details className="text-[11px] text-ink-muted" data-stage-timing-details>
      <summary className="cursor-pointer select-none hover:text-ink">{v.summary}</summary>
      <ul className="mt-1 space-y-0.5 select-text">
        {v.earlier?.map((run, i) => (
          <Fragment key={`earlier-${i}`}>
            <li className={HEADING_CLASS}>{run.heading}</li>
            {run.rows.map((r, j) => row(r, `earlier-${i}-${j}-${r.stage}`))}
          </Fragment>
        ))}
        {v.thisRunHeading && <li className={HEADING_CLASS}>{v.thisRunHeading}</li>}
        {v.rows.map(r => row(r, r.stage))}
        <li className="flex items-baseline justify-between gap-3 border-t border-line pt-0.5 font-semibold text-ink-secondary">
          <span>{v.total.label}</span>
          <span className="font-mono tabular-nums">{v.total.text}</span>
        </li>
      </ul>
    </details>
  )
}
