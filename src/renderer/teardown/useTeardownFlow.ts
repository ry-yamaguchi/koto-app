// teardown/useTeardownFlow.ts — 破棄（削除）の行・節が持つ画面の状態を、フックにしたもの。
//
// 段階0で作った部品（いまは3つの公開先〔共用型・HANAMII・専有型〕の入口がすべてこれを通る）。設計書: docs/teardown-unify-plan.md の 10.3.2 (6)。
// 3つの公開先の行・節が、このフックを使う（専有型の hooks/useDedicatedTeardown.ts は 0.6.22 段階3B-7 で消した）。
//
// 流れの本体は flow.ts の runTeardownFlow（確認 → 実行）。このフックが持つのは、画面の状態だけ
// （実行中か・進み具合・記録から読んだ「走っている／終わった」）。
//
// 作者の決定（2026-10-08・専有型で決めたもの）: 画面を閉じても破棄は最後まで進み、開き直すと続きが見える。
//   ・走っているあいだ: 記録（projectOps）の progress から、進み具合（段の名前・始まってからの時間・目安）を出す
//   ・終わっていて、まだ見られていない結果: 記録から読み戻して `onOutcome` へ渡す
//   ・この画面が始めた破棄の結果: その場の返り値を `onOutcome` へ渡し、出したあとで記録を「見た」にする（二重に出さない）
// 行は、破棄が成功すると（main が公開の記録を消すので）一覧から消えうる。**結果は行の外に出す**ために、
// 結果はこのフックの外（`onOutcome`）へ渡す。
//
// 公開の記録（publish.targets）は**ここでも画面でも消さない**。消すのは main の骨（teardownShell）の1か所だけにする
// （まだどの IPC もこの骨に載っていない。載るのは段階1の HANAMII から）。
//
// 使う React の機能は useState・useRef・useEffect だけ（useConfirmChoices の中の useCallback を含めても4つ。10.3.1。
// テストの React の代役が useMemo を差し替えていないため、useMemo は使わない）。
// 確認は useConfirmChoices（選択の無い確認と、選択つきの確認の両方を1つの ConfirmModal で出す。段階2・2b-1）。
// 選択を持つ仕様書（共用型の「コンテナレジストリも削除する」）は選択つきで、持たない仕様書（HANAMII）は今までどおりの確認を出す。
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useConfirmChoices } from '../useConfirmChoices'
import { resumedTeardownView, type TeardownView } from '../../shared/teardownResult'
import { runTeardownFlow, electronFlowDeps, teardownProgressText, notifyTeardownFinished } from './flow'
import { watchTeardownOps, resumedTeardownNote, type TeardownOpsWatch, type TeardownResumedNote, type TeardownRunningView } from './watch'
import type { TargetSpec } from './types'

/** 行の外に出す結果。 */
export type TeardownFlowOutcome = {
  view: TeardownView
  /** 閉じて開き直したあとの結果に添える知らせ（見逃してはいけない警告）。その場の結果には無い。 */
  notes: TeardownResumedNote[]
  /** 消すものが記録に無かった（`nothingToDoIsOk` の仕様書だけ）。失敗の枠でなく中立の知らせで出す。付くのは true のときだけ。 */
  nothingToDo?: true
}

export function useTeardownFlow<R, A, Res>(projectDir: string, spec: TargetSpec<R, A, Res>, opts: {
  /** キーが無いとき結果欄へ出す文（この入口の、キーを登録する場所の案内）。 */
  keyMissingMessage: string
  /** 結果が出た（この画面が始めたものも、閉じている間に終わった記録も）。 */
  onOutcome: (outcome: TeardownFlowOutcome) => void
  /** 終わった後（一覧を読み直す等）。結果を `onOutcome` に渡したあとで呼ぶ。 */
  onFinished?: () => void | Promise<void>
}): {
  tearingDown: boolean
  otherRunning: boolean
  progress: string | null
  running: boolean
  runningRecord: ProjectOpRecordShape | null
  nowMs: number
  start: () => Promise<void>
  confirmElement: ReactElement
} {
  const { confirm, confirmWithChoices, element: confirmElement } = useConfirmChoices()
  const [tearingDownLocal, setTearingDownLocal] = useState(false)
  const [progressLocal, setProgressLocal] = useState<string | null>(null)
  const [opsRunning, setOpsRunning] = useState<TeardownRunningView>({ running: null, other: null })
  const [nowMs, setNowMs] = useState(() => Date.now())
  const watchRef = useRef<TeardownOpsWatch | null>(null)
  /** 押してから終わるまでの二重押しを止める（state の更新を待たずに効く）。 */
  const startedRef = useRef(false)
  // コールバックと仕様書は最新のものを使う（effect を張り直さない）。
  const cb = useRef(opts)
  cb.current = opts
  const specRef = useRef(spec)
  specRef.current = spec

  // 破棄の進み具合のイベント（公開先が持っているときだけ。専有型は段が一覧から消えるまで待つ間、30秒ごとに1行）。
  // 実行中の行にだけ出す（掟11。届いた文は progressLocal に入るが、出すのは tearingDown のときだけ）。
  useEffect(() => {
    let unsubscribe = () => {}
    try { unsubscribe = specRef.current.subscribeProgress?.(msg => setProgressLocal(msg)) ?? unsubscribe } catch { /* preload が無い環境 */ }
    return () => { unsubscribe() }
  }, [spec])

  // 記録（projectOps）を読む・押し出しを受ける。この公開先の破棄だけを受け持つ（公開・作成の記録は、その持ち場の画面）。
  useEffect(() => {
    setOpsRunning({ running: null, other: null })
    let watch: TeardownOpsWatch | null = null
    try {
      watch = watchTeardownOps({
        api: window.electronAPI.projectOps,
        projectDir,
        target: spec.target,
        onRunning: setOpsRunning,
        onFinished: finished => {
          // 閉じている間に終わった破棄（古い順）。最新の結果を出し、知らせは全件を渡す。
          const latest = finished[finished.length - 1]
          const s = specRef.current
          cb.current.onOutcome({
            view: resumedTeardownView(s.target, latest.result),
            notes: finished.map(rec => resumedTeardownNote(s.words, rec)),
          })
          notifyTeardownFinished()
          void Promise.resolve(cb.current.onFinished?.()).catch(() => {})
        },
      })
    } catch { /* preload 未注入（テスト環境等）。記録が読めなくても、この画面が始めた破棄は従来どおり動く */ }
    watchRef.current = watch
    return () => { watch?.stop(); if (watchRef.current === watch) watchRef.current = null }
  }, [projectDir, spec.target]) // eslint-disable-line react-hooks/exhaustive-deps

  const running = opsRunning.running !== null
  const runningRecord = opsRunning.running
  const tearingDown = tearingDownLocal || running
  /**
   * 同じプロジェクトで、この破棄以外の操作（公開・作成・別の公開先の操作）が走っている。
   * 鍵（withProjectLock）が断るので消えはしないが、断られた結果が赤い警告になるだけなので、押せないようにする。
   */
  const otherRunning = opsRunning.other !== null

  // 走っているあいだだけ、「始まってから約N分」を進める。
  const runningStartedAt = runningRecord?.startedAt ?? null
  useEffect(() => {
    if (runningStartedAt === null) return
    setNowMs(Date.now())
    const id = window.setInterval(() => { setNowMs(Date.now()); watchRef.current?.refresh() }, 15000)
    return () => window.clearInterval(id)
  }, [runningStartedAt])

  /** 破棄を押したとき。確認 → 破棄（runTeardownFlow）→ 結果を行の外へ。 */
  const start = async () => {
    if (startedRef.current || tearingDown || otherRunning) return
    startedRef.current = true
    let view: TeardownView | null = null
    let nothingToDo = false
    try {
      const out = await runTeardownFlow(projectDir, spec, electronFlowDeps(projectDir, spec, {
        confirm,
        confirmWithChoices,
        keyMissingMessage: cb.current.keyMissingMessage,
        onStart: () => {
          setTearingDownLocal(true); setProgressLocal(null)
          // この画面が始めた破棄: 結果は下で自分が出すので、記録のほうを二重に出さない。
          watchRef.current?.beginLocal()
        },
      }))
      if (!out.cancelled) { view = spec.toView(out.result); nothingToDo = out.nothingToDo === true }
    } catch (e: any) {
      view = spec.toView(spec.failure(e?.message ?? String(e)))
    } finally {
      setTearingDownLocal(false)
      startedRef.current = false
    }
    if (!view) return
    cb.current.onOutcome(nothingToDo ? { view, notes: [], nothingToDo: true } : { view, notes: [] })
    // 結果を出し終えた。この画面が始めた記録を「見た」として伝える（行が消える前に。警告つきの記録は伝わらず、残る）。
    watchRef.current?.endLocal()
    notifyTeardownFinished()
    await Promise.resolve(cb.current.onFinished?.()).catch(() => {})
  }

  return {
    tearingDown,
    otherRunning,
    progress: teardownProgressText({ running, runningRecord, local: progressLocal }),
    running,
    runningRecord,
    nowMs,
    start,
    confirmElement,
  }
}
