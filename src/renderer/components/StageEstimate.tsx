// StageEstimate.tsx — 待っている段（いまの段）の横に出す「目安」の一文。
//
// 「目安 約8分（この Mac での最近3回の中央値）」「目安 約9分（開発時の実測・2026-09-10）」（作者の決定 2026-10-07）。
// **目安が無い段には何も出さない**（測っていない段に目安を作らない）。段は main の記録の progress.stage（段の内部名）で
// 見分ける——**画面に出す文では見分けない**（文を直しても目安が外れない）。
//
// 目安の決め方・文は shared/stageEstimate.ts（純関数・テストで固定）。ここは IPC で一覧を読んで描くだけ。
// 以前は進み具合の文に「実測ではおよそ9分でした（目安です）」を焼き込んでいたが、この部品に一本化した（同じ数字を2か所に持たない）。
import { useEffect, useState } from 'react'
import { estimateLineFor } from '../../shared/stageEstimate'

export default function StageEstimate({ stage }: { stage?: string | null }) {
  const [estimates, setEstimates] = useState<unknown>(null)
  // 段が変わるたびに読み直す（直前の操作で記録が増えて、目安が変わっていることがある）。読み取りだけ・失敗しても画面は動く。
  useEffect(() => {
    if (!stage) return
    let alive = true
    try {
      void Promise.resolve(window.electronAPI.stageTiming.estimates())
        .then(r => { if (alive) setEstimates(r) })
        .catch(() => {})
    } catch { /* preload が無い環境（テスト等）では目安を出さない */ }
    return () => { alive = false }
  }, [stage])
  const line = estimateLineFor(stage, estimates)
  if (!line) return null
  return <p className="text-[11px] text-ink-muted leading-relaxed select-text" data-stage-estimate>{line}</p>
}
