// TeardownRow.tsx — 📡 公開したもの一覧の、1行ぶんの 🗑（ボタンの名前は言葉の rowButton。共用型・HANAMII は「🗑 破棄」、専有型は「🗑 削除」）と、破棄中の進み具合。公開先によらず、共通の1つ。
//
// 段階0で作った部品（いまは3つの公開先〔共用型・HANAMII・専有型〕の入口がすべてこれを通る）。設計書: docs/teardown-unify-plan.md の 10.3.2 (9)。
// 3つの公開先の行は、これだけ（専有型の DedicatedTeardownRow.tsx は 0.6.22 段階3B-7 で消した）。
//
// 確認の文・実行・閉じるときの警告・進み具合・結果は、公開先ごとの仕様書（TargetSpec）と共通の流れ（teardown/flow.ts）から作る。
// この行は押せる場所と状態の持ち主なだけ。行の見た目（名前・URL・「サイトを開く」など）は一覧側が1つだけ持つ（`render`）。
// 結果は**行の外**（一覧の上）に出す——破棄が成功すると main が公開の記録を消し、行が一覧から消えるため（`onOutcome`）。
import { useEffect, useRef, type ReactNode } from 'react'
import type { PublishedEntry } from '../../publishedIndex'
import { useTeardownFlow, type TeardownFlowOutcome } from '../../teardown/useTeardownFlow'
import type { TargetSpec } from '../../teardown/types'
import TeardownProgress from './TeardownProgress'

export default function TeardownRow<R, A, Res>({ spec, entry, keyMissingMessage, blocked, onBusyChange, onOutcome, onFinished, render }: {
  spec: TargetSpec<R, A, Res>
  entry: PublishedEntry
  /** 📡 の 🗑 でキーが無かったとき（入口ごとに、キーを登録する場所の案内が違う）。 */
  keyMissingMessage: string
  /** ほかの行の破棄が走っていて、この行の 🗑 を止めるか。 */
  blocked: boolean
  /** この行の破棄が走っている／終わった（一覧が、ほかの 🗑 を止める・前の結果を片づけるのに使う）。 */
  onBusyChange: (busy: boolean) => void
  /** 結果（この一覧が始めたものも、閉じている間に終わった記録も）。一覧の上に出す。 */
  onOutcome: (entry: PublishedEntry, outcome: TeardownFlowOutcome) => void
  /** 終わった後（一覧を読み直す）。 */
  onFinished: () => void | Promise<void>
  /**
   * 行の本体。🗑 のボタンと、行の下に出すものを受け取る。`busy` はこの行の破棄が走っているか
   * （一覧が「一覧から削除」を止めるのに使う——破棄の最中に公開の記録だけを消すと、途中で止まったとき 🗑 で押し直せなくなる）。
   */
  render: (parts: { button: ReactNode; below: ReactNode; busy: boolean }) => ReactNode
}) {
  const t = useTeardownFlow(entry.dir, spec, {
    keyMissingMessage,
    onOutcome: o => onOutcome(entry, o),
    onFinished,
  })
  useEffect(() => { onBusyChange(t.tearingDown) }, [t.tearingDown]) // eslint-disable-line react-hooks/exhaustive-deps
  // この行が一覧から消えたとき（破棄が成功して main が公開の記録を外した・「一覧から削除」）は、実行中の印を必ず下ろす。
  // 下ろさないと、一覧を閉じるまでほかのすべての 🗑 が押せないままになる。
  const busyChangeRef = useRef(onBusyChange)
  busyChangeRef.current = onBusyChange
  useEffect(() => () => { busyChangeRef.current(false) }, [])

  const { words } = spec
  const button = (
    <button
      onClick={() => { void t.start() }}
      disabled={blocked || t.tearingDown || t.otherRunning}
      className="text-[11px] border border-brand-red/60 rounded-md px-1.5 py-0.5 text-brand-red hover:bg-brand-red/10 disabled:opacity-40 whitespace-nowrap"
      title={t.otherRunning
        ? 'このプロジェクトで別の操作（作成・公開など）が実行中です。終わってからお試しください'
        : `公開を止めて、作られたものをすべて${words.verb}します`}
    >{t.tearingDown ? words.running : words.rowButton}</button>
  )
  const below = t.tearingDown ? (
    <div className="rounded-lg border border-sakura bg-overlay p-3 space-y-1" role="status" data-teardown-row-progress>
      <p className="text-xs font-semibold text-ink leading-relaxed">{words.running}</p>
      <TeardownProgress words={words} progress={t.progress} running={t.running} runningRecord={t.runningRecord} nowMs={t.nowMs} />
    </div>
  ) : null

  return <>{render({ button, below, busy: t.tearingDown })}{t.confirmElement}</>
}
