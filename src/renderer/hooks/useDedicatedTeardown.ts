// useDedicatedTeardown.ts — 📡 公開したもの一覧の、専有型の行の「🗑 破棄」（＝専有型の「すべて削除」）の状態を持つフック。
//
// 流れの本体は **手順6と同じ** src/renderer/dedicatedTeardownFlow.ts の runDedicatedTeardown（確認 → 実行）。
// このフックが持つのは、その行の画面の状態だけ（実行中か・進み具合・記録から読んだ「走っている／終わった」）。
//
// 作者の決定（2026-10-08）: 一覧を閉じても削除は最後まで進み、開き直すと続きが見える。
//   ・走っているあいだ: 記録（projectOps）の progress から、進み具合（段の名前・始まってからの時間・目安）を出す
//   ・終わっていて、まだ見られていない結果: 記録から読み戻して `onOutcome` へ渡す（手順6の「開き直したとき」と同じ読み方）
//   ・この一覧が始めた削除の結果: その場の返り値を `onOutcome` へ渡し、出したあとで記録を「見た」にする（二重に出さない）
// 行は、削除が成功すると（main が公開の記録を消すので）一覧から消える。**結果は行の外（一覧の上）に出す**ために、
// 結果はこのフックの外（`onOutcome`）へ渡す。
//
// 公開の記録（publish.targets）は**ここでも画面でも消さない**。main の `apprunDedicated:teardown` が1か所で消す。
import { useEffect, useRef, useState } from 'react'
import { useConfirm } from '../useConfirm'
import {
  watchDedicatedOps, resumedTeardownResult, resumedNoteOf,
  type DedicatedRunningView, type DedicatedResumedNote, type DedicatedOpsWatch,
} from '../apprunDedicatedActions'
import {
  runDedicatedTeardown, electronTeardownDeps, teardownProgressText, notifyDedicatedTeardownFinished,
  type DedicatedTeardownResult,
} from '../dedicatedTeardownFlow'

/** 行の外（一覧の上）に出す結果。 */
export type DedicatedTeardownOutcome = {
  result: DedicatedTeardownResult
  /** 閉じて開き直したあとの結果に添える知らせ（見逃してはいけない警告）。その場の結果には無い。 */
  notes: DedicatedResumedNote[]
}

export function useDedicatedTeardown(projectDir: string, opts: {
  /** キーが無いとき結果欄へ出す文（この入口の、キーを登録する場所の案内）。 */
  keyMissingMessage: string
  /** 結果が出た（この一覧が始めたものも、閉じている間に終わった記録も）。 */
  onOutcome: (outcome: DedicatedTeardownOutcome) => void
  /** 終わった後（一覧を読み直す等）。結果を `onOutcome` に渡したあとで呼ぶ。 */
  onFinished?: () => void | Promise<void>
}) {
  const { confirm, element: confirmElement } = useConfirm()
  const [tearingDownLocal, setTearingDownLocal] = useState(false)
  const [progressLocal, setProgressLocal] = useState<string | null>(null)
  const [opsRunning, setOpsRunning] = useState<DedicatedRunningView>({ running: null, other: null })
  const [nowMs, setNowMs] = useState(() => Date.now())
  const watchRef = useRef<DedicatedOpsWatch | null>(null)
  /** 押してから終わるまでの二重押しを止める（state の更新を待たずに効く）。 */
  const startedRef = useRef(false)
  // コールバックは最新のものを使う（effect を張り直さない）。
  const cb = useRef(opts)
  cb.current = opts

  // #39: 削除の進み具合（段が一覧から消えるまで待つ間、30秒ごとに1行）。実行中の行にだけ出す（掟11）。
  useEffect(() => {
    let unsubscribe = () => {}
    try { unsubscribe = window.electronAPI.apprunDedicated.onTeardownProgress(msg => setProgressLocal(msg)) } catch { /* preload が無い環境 */ }
    return () => { unsubscribe() }
  }, [])

  // 記録（projectOps）を読む・押し出しを受ける。削除（teardown）だけを受け持つ（作成・公開の記録は、専有型タブの持ち場）。
  useEffect(() => {
    setOpsRunning({ running: null, other: null })
    let watch: DedicatedOpsWatch | null = null
    try {
      watch = watchDedicatedOps({
        api: window.electronAPI.projectOps,
        projectDir,
        kinds: ['teardown'],
        onRunning: setOpsRunning,
        onFinished: finished => {
          // 閉じている間に終わった削除（古い順）。最新の結果を出し、知らせは全件を渡す。
          const latest = finished[finished.length - 1]
          cb.current.onOutcome({ result: resumedTeardownResult(latest.record), notes: finished.map(resumedNoteOf) })
          notifyDedicatedTeardownFinished()
          void Promise.resolve(cb.current.onFinished?.()).catch(() => {})
        },
      })
    } catch { /* preload 未注入（テスト環境等）。記録が読めなくても、この一覧が始めた削除は従来どおり動く */ }
    watchRef.current = watch
    return () => { watch?.stop(); if (watchRef.current === watch) watchRef.current = null }
  }, [projectDir])

  const runningKind = opsRunning.running?.kind ?? null
  const runningRecord = opsRunning.running?.record ?? null
  const tearingDown = tearingDownLocal || runningKind === 'teardown'
  /**
   * 同じプロジェクトで、削除以外の操作（手順5の作成・手順8の公開・別の公開先の操作）が走っている。
   * 鍵（withProjectLock）が断るので消えはしないが、断られた結果が赤い警告になるだけなので、押せないようにする
   * （手順6が panelBusy で押せないのと同じ。2026-10-08 検分）。
   */
  const otherRunning = opsRunning.other !== null

  // 走っているあいだだけ、「始まってから約N分」を進める（手順6と同じ）。
  const runningStartedAt = runningRecord?.startedAt ?? null
  useEffect(() => {
    if (runningStartedAt === null) return
    setNowMs(Date.now())
    const id = window.setInterval(() => { setNowMs(Date.now()); watchRef.current?.refresh() }, 15000)
    return () => window.clearInterval(id)
  }, [runningStartedAt])

  /** 🗑 を押したとき。確認 → 削除（手順6と同じ runDedicatedTeardown）→ 結果を行の外へ。 */
  const start = async () => {
    if (startedRef.current || tearingDown || otherRunning) return
    startedRef.current = true
    let result: DedicatedTeardownResult | null = null
    try {
      const out = await runDedicatedTeardown(projectDir, electronTeardownDeps(projectDir, {
        confirm,
        keyMissingMessage: cb.current.keyMissingMessage,
        onStart: () => {
          setTearingDownLocal(true); setProgressLocal(null)
          // この一覧が始めた削除: 結果は下で自分が出すので、記録のほうを二重に出さない。
          watchRef.current?.beginLocal('teardown')
        },
      }))
      if (!out.cancelled) result = out.result
    } catch (e: any) {
      result = { ok: false, executed: [], message: e?.message ?? String(e), remaining: {} }
    } finally {
      setTearingDownLocal(false)
      startedRef.current = false
    }
    if (!result) return
    cb.current.onOutcome({ result, notes: [] })
    // 結果を出し終えた。この一覧が始めた記録を「見た」として伝える（行が消える前に。警告つきの記録は伝わらず、残る）。
    watchRef.current?.endLocal('teardown')
    notifyDedicatedTeardownFinished()
    await Promise.resolve(cb.current.onFinished?.()).catch(() => {})
  }

  return {
    tearingDown,
    otherRunning,
    progress: teardownProgressText({ runningKind, runningRecord, local: progressLocal }),
    runningKind,
    runningRecord,
    nowMs,
    start,
    confirmElement,
  }
}
