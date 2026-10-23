// useDedicatedOpsWatch.ts — 専有型パネル（AppRunDedicatedPanel）が手順5・6・8の「記録の見張り」を付け外しするフック。
//
// 段階3B の 3B-6a（K=1・10.12）。設計書: docs/teardown-unify-plan.md の 10.11.10・10.11.20 の K。
// AppRunDedicatedPanel.tsx（3,000行を超える巨大ファイル）の見張りの effect を、**振る舞いを変えずに**ここへ移した（3B-6a。
// 触った節は 400 行以下のモジュールへ。CLAUDE.md「調査のしかた」）。そのあとの見張りの直しは、部品の側（apprunDedicatedActions.ts）に入った:
// 窓の上限・この画面が始めた記録を「渡した」に数える（`localOpsWindow`。3B-3・V14。手順5・6・8の3種類とも）／手順6の知らせの見出し
// （共通の resumedTeardownNote。3B-6b・V8）。このフックは付け外しするだけで、どちらも持たない。
//
// 何のための部品か: 手順5の作成・手順6のすべて削除・手順8の公開の本体は main の1回の IPC で最後まで進み、記録も main が書く
// （withProjectLock）。パネルを閉じても処理は止まらない。失われていたのは画面の表示（進み具合・結果・警告）だけなので、
// 開いたとき main の記録（window.electronAPI.projectOps）を読み、走っていれば進み具合を、終わっていれば結果と警告を出す。
// 読み方・出し方の判断は watchDedicatedOps（apprunDedicatedActions.ts。振る舞いは tests/ops-dedicated-resume.test.ts が固定）が持つ。
// このフックは付け外しして、届いたものを state に置くだけ（掟10）。**別のプロジェクト・別の公開先の記録は出さない**（掟11）。
//
// パネルとの受け渡しの口は2つだけ:
//   ・走っているもの … このフックが持つ `opsRunning`（パネルは読むだけ）
//   ・終わった結果が届いたとき … 引数 `onFinished`（パネルが手順5・6・8それぞれの結果欄の state へ置く）
// 知らせ（警告）の集め方と、記録が変わったことを開いている画面へ知らせる処理は、このフックの中にある。
//
// ack（見た印）は部品の中の1か所だけ（watchDedicatedOps の sendAck）。ここでは呼ばない。
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import {
  watchDedicatedOps, addResumedNotes, resumedNoteOf,
  type DedicatedOpsWatch, type DedicatedRunningView, type DedicatedResumedNote, type DedicatedOpKind, type DedicatedFinished,
} from '../apprunDedicatedActions'

/** 操作ごとの知らせ（開き直したあとの結果に添える警告）。 */
export type DedicatedResumedNotes = Record<DedicatedOpKind, DedicatedResumedNote[]>

export function useDedicatedOpsWatch(
  projectDir: string,
  /** タブが目の前に出ているか。隠れている間は、結果を持っていても「見た」と伝えない。 */
  panelVisible: boolean,
  /** 終わって、まだ見られていない結果が届いた（古い順）。パネルが手順5・6・8それぞれの結果欄へ置く。 */
  onFinished: (finished: DedicatedFinished[]) => void,
): {
  opsRunning: DedicatedRunningView
  resumedNotes: DedicatedResumedNotes
  setResumedNotes: Dispatch<SetStateAction<DedicatedResumedNotes>>
  opsWatchRef: MutableRefObject<DedicatedOpsWatch | null>
} {
  const [opsRunning, setOpsRunning] = useState<DedicatedRunningView>({ running: null, other: null })
  const [resumedNotes, setResumedNotes] = useState<DedicatedResumedNotes>({ create: [], teardown: [], publish: [] })
  const opsWatchRef = useRef<DedicatedOpsWatch | null>(null)
  // 目の前に出ているか（見張りを張り直さずに、最新の値を読ませる）。
  const panelVisibleRef = useRef(panelVisible)
  panelVisibleRef.current = panelVisible
  // 結果の置き場は最新のものを使う（effect を張り直さない）。
  const finishedRef = useRef(onFinished)
  finishedRef.current = onFinished

  // 記録を読む・押し出しを受ける（開いたとき1回・開いている間は押し出し）。外すと何も届かない。
  useEffect(() => {
    setOpsRunning({ running: null, other: null })
    setResumedNotes({ create: [], teardown: [], publish: [] })
    let watch: DedicatedOpsWatch | null = null
    try {
      watch = watchDedicatedOps({
        api: window.electronAPI.projectOps,
        projectDir,
        onRunning: setOpsRunning,
        // 隠れているタブのパネルは、結果を持っていても「見た」と伝えない（目の前に出たら、visibilityChanged で伝える）。
        isVisible: () => panelVisibleRef.current,
        // 終わって、まだ見られていない結果。生きている結果と同じ欄で出し、警告は結果欄の上に集める。
        onFinished: finished => {
          finishedRef.current(finished)
          setResumedNotes(prev => addResumedNotes(prev, finished.map(resumedNoteOf)))
          // 記録（作られたもの・公開の記録）が変わっている。開いている画面（この画面・一覧・ステータスバー）へ知らせる。
          window.dispatchEvent(new Event('sakura-meta-changed'))
        },
      })
    } catch { /* preload 未注入（テスト環境等）。記録が読めなくても、この画面が始めた操作は従来どおり動く */ }
    opsWatchRef.current = watch
    return () => { watch?.stop(); if (opsWatchRef.current === watch) opsWatchRef.current = null }
  }, [projectDir])

  // タブが隠れた・また目の前に出た。出たら、隠れている間に画面へ渡した結果を、ここで「見た」と伝える。
  useEffect(() => { opsWatchRef.current?.visibilityChanged() }, [panelVisible])

  return { opsRunning, resumedNotes, setResumedNotes, opsWatchRef }
}
