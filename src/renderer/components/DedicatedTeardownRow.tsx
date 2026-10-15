// DedicatedTeardownRow.tsx — 📡 公開したもの一覧の、専有型の行の「🗑 破棄」と、削除中の進み具合。
//
// 作者の決定（2026-10-08）: 専有型の 🗑 は、専有型タブの手順6「すべて削除する」と**同じ「すべて削除」**
// （アプリ → ロードバランサ → オートスケーリンググループ → クラスタ ＋ 保存場所の片づけ）。
// 確認の文・実行・閉じるときの警告・進み具合・結果・公開の記録の片づけは、手順6と同じ部品を使う
// （src/renderer/dedicatedTeardownFlow.ts・DedicatedTeardownView.tsx。この行は押せる場所と状態の持ち主なだけ）。
//
// 行の見た目（名前・URL・「サイトを開く」など）は一覧側が1つだけ持つ（`render`）。ここは 🗑 のボタンと、
// 行の下に出す進み具合を渡す。結果は**行の外**（一覧の上）に出す——削除が成功すると main が公開の記録を消し、
// 行が一覧から消えるため（`onOutcome`）。
import { useEffect, useRef, type ReactNode } from 'react'
import type { PublishedEntry } from '../publishedIndex'
import { useDedicatedTeardown, type DedicatedTeardownOutcome } from '../hooks/useDedicatedTeardown'
import { DedicatedTeardownProgress } from './DedicatedTeardownView'

/** 📡 の 🗑 でキーが無かったとき（入口ごとに、キーを登録する場所の案内が違う）。 */
export const LIST_KEY_MISSING_MESSAGE = 'さくらのクラウドの API キーが未登録です。「認証情報」で登録してから、もう一度お試しください。'

export default function DedicatedTeardownRow({ entry, blocked, onBusyChange, onOutcome, onFinished, render }: {
  entry: PublishedEntry
  /** ほかの行の破棄が走っていて、この行の 🗑 を止めるか。 */
  blocked: boolean
  /** この行の削除が走っている／終わった（一覧が、ほかの 🗑 を止める・前の結果を片づけるのに使う）。 */
  onBusyChange: (busy: boolean) => void
  /** 結果（この一覧が始めたものも、閉じている間に終わった記録も）。一覧の上に出す。 */
  onOutcome: (entry: PublishedEntry, outcome: DedicatedTeardownOutcome) => void
  /** 終わった後（一覧を読み直す）。 */
  onFinished: () => void | Promise<void>
  /**
   * 行の本体。🗑 のボタンと、行の下に出すものを受け取る。`busy` はこの行の削除が走っているか
   * （一覧が「一覧から削除」を止めるのに使う——削除の最中に公開の記録だけを消すと、途中で止まったとき 🗑 で押し直せなくなる）。
   */
  render: (parts: { button: ReactNode; below: ReactNode; busy: boolean }) => ReactNode
}) {
  const t = useDedicatedTeardown(entry.dir, {
    keyMissingMessage: LIST_KEY_MISSING_MESSAGE,
    onOutcome: o => onOutcome(entry, o),
    onFinished,
  })
  useEffect(() => { onBusyChange(t.tearingDown) }, [t.tearingDown]) // eslint-disable-line react-hooks/exhaustive-deps
  // この行が一覧から消えたとき（削除が成功して main が公開の記録を外した・「一覧から削除」）は、実行中の印を必ず下ろす。
  // 下ろさないと、一覧を閉じるまでほかのすべての 🗑 が押せないままになる（2026-10-08 検分）。
  const busyChangeRef = useRef(onBusyChange)
  busyChangeRef.current = onBusyChange
  useEffect(() => () => { busyChangeRef.current(false) }, [])

  const button = (
    <button
      onClick={() => { void t.start() }}
      disabled={blocked || t.tearingDown || t.otherRunning}
      className="text-[11px] border border-brand-red/60 rounded-md px-1.5 py-0.5 text-brand-red hover:bg-brand-red/10 disabled:opacity-40 whitespace-nowrap"
      title={t.otherRunning
        ? 'このプロジェクトで別の操作（作成・公開など）が実行中です。終わってからお試しください'
        : '公開を止めて、作られたものをすべて削除します（アプリ・ロードバランサ・オートスケーリンググループ・クラスタ）'}
    >{t.tearingDown ? '削除しています…' : '🗑 破棄'}</button>
  )
  const below = t.tearingDown ? (
    <div className="rounded-lg border border-sakura bg-overlay p-3 space-y-1" role="status" data-dedicated-teardown-progress>
      <p className="text-xs font-semibold text-ink leading-relaxed">削除しています…</p>
      <DedicatedTeardownProgress progress={t.progress} runningKind={t.runningKind} runningRecord={t.runningRecord} nowMs={t.nowMs} />
    </div>
  ) : null

  return <>{render({ button, below, busy: t.tearingDown })}{t.confirmElement}</>
}
