// useProjectOpsView.ts — main の処理の記録（src/main/projectOps.ts）を、**1つの公開先の画面**（HANAMII・Vercel）が出す形にするフック。
//
// 読み方・古い応答の扱い・別のプロジェクトの無視・「どこまで見たと伝えてよいか」は、共通の1か所
// （src/renderer/projectOpsView.ts の watchProjectOps／ackUpToFor）を通る（掟10・2026-09-30 検分の指摘2）。
// ここに書くのは、**この持ち場に固有の判断だけ**:
//   ・自分の公開先の記録（`isOwn`）と、別の公開先の記録（走っているときだけ1行で知らせる・掟11）の仕分け
//   ・自分の記録を**出したら**「見た」と伝える（出した直後）。別の公開先の、まだ見られていない結果より
//     新しいものは伝えない（ackUpToFor が止める）。**警告つきの記録も伝えない**（同じく ackUpToFor が止める）:
//     結果は公開ボタンのずっと下に出るので、出しただけでは利用者が見たことにならない。警告つきの記録は、
//     上部の「結果を確認しました」（PublishModal）を押したときにだけ見たことになる（2026-09-30 検分）
//   ・終わった記録を**初めて**見たとき `onOwnFinished` を呼ぶ
//
// ⚠️ `onOwnFinished` は**再生される**: 閉じて開き直すと、まだ見られていない古い記録を、この画面はもう一度
// 「初めて見た」と扱う（別の公開先の結果が先に挟まっていると、自分の記録は見たことにされず残るため）。
// だから `onOwnFinished` の中でやってよいのは、**再生されても無害なこと**（いまの状態を読み直して表示を決める）だけ。
// ディスクの記録（.sakuraide.json）を書き換える後始末は main が操作の中（鍵の中）で1回だけ行う
// （HANAMII の破棄後の記録の片づけ＝src/main/publishMetaFs.ts の settleHanamiiTeardownFs）。

import { useState, useEffect, useRef } from 'react'
import { watchProjectOps, unseenOf, ackUpToFor, sendAck, type OpsWatch } from '../projectOpsView'

/**
 * @param isOwn 自分の公開先の記録か（違うもの＝同じプロジェクトの別の公開先の操作は、進み具合・結果・警告を出さず、
 *   走っているときだけ1行で知らせる）
 * @param onOwnFinished 自分の公開先の操作が終わった記録を**初めて**見たとき（この画面が頼んだものも、閉じている間に終わった
 *   ものも）。再生されても無害なことだけを行う（上の説明）。
 *
 * 戻り値:
 *   ownRunning / foreignRunning … いま走っている操作（自分の公開先か・別か）
 *   shown … 出している結果（古い順）。**出したものは main へ「見た」と伝えてある**
 *   sync() … 記録を読み直す（自分が頼んだ操作の返り値のあとに呼ぶ）
 *   didFinishSince(handler, ms) … その時刻以降に始まった、その IPC の結果を、この画面が出したか
 *   clearShown() … 出している結果を片づける（次の操作を始めるとき）
 */
export function useProjectOpsView(
  projectDir: string,
  isOwn: (r: ProjectOpRecordShape) => boolean,
  onOwnFinished?: (r: ProjectOpRecordShape) => void,
) {
  const [running, setRunning] = useState<ProjectOpRecordShape | null>(null)
  const [shown, setShown] = useState<ProjectOpRecordShape[]>([])
  /** この画面が結果を出した記録（startedAt → handler）。二重に出さない・自分の操作の記録が残ったかの判定に使う。 */
  const handled = useRef<Map<number, string>>(new Map())
  /** いま開いているか（閉じたあとの応答で、表示も ack もしない。見せていないものを見たことにしない）。 */
  const alive = useRef(false)
  const watch = useRef<OpsWatch | null>(null)
  const onFinished = useRef(onOwnFinished)
  onFinished.current = onOwnFinished

  /** 届いた写し（get の応答・onChanged の中身）を画面へ当てる。 */
  const apply = (snap: ProjectOpsSnapshotShape) => {
    if (!alive.current) return
    setRunning(snap.running && typeof snap.running === 'object' ? snap.running : null)
    // 終わったが、まだ見られていない記録（古い順）。前の結果を、次の結果で上書きして見逃さない。
    const finished = unseenOf(snap)
    const own = finished.filter(isOwn)
    const newlyShown = own.filter(r => !handled.current.has(r.startedAt))
    if (newlyShown.length > 0) {
      for (const r of newlyShown) handled.current.set(r.startedAt, r.handler)
      setShown(prev => [...prev, ...newlyShown].sort((a, b) => a.startedAt - b.startedAt))
      for (const r of newlyShown) {
        try { void Promise.resolve(onFinished.current?.(r)).catch(() => {}) } catch { /* 後始末の失敗で表示を止めない */ }
      }
    }
    // 出した結果を「見た」と伝える。**別の公開先の、まだ見られていない結果より新しいものは伝えない**（ackUpToFor が止める。
    // 伝えると、別の公開先の画面が出すはずの警告が消える）。伝えなかった分は、次に開いたとき同じ結果をもう一度出す
    // （見逃すより、二度見えるほうを選ぶ）。
    // 自分の記録は、上で（初めてのものは出し、すでに出したものは前に出して）すべて出している。
    // ただし**警告つきの記録も ackUpToFor が止める**（出しただけでは見たことにならない。上の説明）。
    const upTo = ackUpToFor(finished, isOwn)
    if (upTo !== null) {
      try { sendAck(window.electronAPI.projectOps, projectDir, upTo) } catch { /* ack の失敗は表示に影響させない */ }
    }
  }

  useEffect(() => {
    alive.current = true
    handled.current = new Map()
    setRunning(null); setShown([])
    try {
      // 開いたとき1回・開いている間は押し出し。別のプロジェクトの知らせは無視し、古い応答は捨てる（watchProjectOps）。
      watch.current = watchProjectOps(window.electronAPI.projectOps, projectDir, apply)
    } catch { /* 記録が読めなくても、画面は動く */ }
    return () => { alive.current = false; watch.current?.stop(); watch.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  const sync = async (): Promise<void> => { await watch.current?.refresh() }
  const didFinishSince = (handler: string, sinceMs: number): boolean =>
    Array.from(handled.current.entries()).some(([startedAt, h]) => h === handler && startedAt >= sinceMs)
  const clearShown = () => { setShown([]) }

  return {
    running,
    ownRunning: running && isOwn(running) ? running : null,
    foreignRunning: running && !isOwn(running) ? running : null,
    shown,
    sync,
    didFinishSince,
    clearShown,
  }
}
