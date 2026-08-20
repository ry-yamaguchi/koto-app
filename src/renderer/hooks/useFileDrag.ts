// useFileDrag.ts — 「ここに落とせます」の表示を、**必ず消えるように**持つ。
//
// 受け口ごとに真偽値を置くと、消す条件を書き忘れた場所が残り続ける
// （2026-08-19 実機: 画面全体の受け口だけが消えなくなった）。
// 表示の持ち方をここに一本化し、使う側は貼るだけにする。

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { isFileDrag, leftWindow, leftReceiver, endsDrag } from '../../shared/dragState'

export interface FileDrag {
  /** いま受け口の上にファイルが重なっているか。 */
  over: boolean
  /** 受け口の onDragOver に渡す（ファイルのときだけ受ける）。 */
  onDragOver: (e: React.DragEvent) => void
  /** 受け口の onDragLeave に渡す（中の部品へ移っただけなら消さない）。 */
  onDragLeave: (e: React.DragEvent) => void
  /** 落ちたとき・やめたときに呼ぶ。 */
  end: () => void
}

export function useFileDrag(): FileDrag {
  const [over, setOver] = useState(false)
  // 窓ぜんたいの見張りから読むので、いまの値を ref にも持つ
  const overRef = useRef(false)
  const set = useCallback((v: boolean) => { overRef.current = v; setOver(v) }, [])
  const end = useCallback(() => { if (overRef.current) set(false) }, [set])

  // ── 消し忘れの受け皿 ────────────────────────────────────────────────
  // 窓の外へ出した／外で手を離した／取り消した、のいずれでも消えるようにする。
  // 受け口自身の onDragLeave は、これらの場合に**届かないことがある**。
  useEffect(() => {
    // 見張りが見るのは**窓の外へ出たときだけ**。受け口の中の行き来まで拾うと、
    // 中の部品へ移るたびに表示が消える（2026-08-19 ブラウザで実測して発覚）。
    const onLeave = (e: DragEvent) => { if (leftWindow(e.relatedTarget)) end() }
    const onEnd = (e: Event) => { if (endsDrag(e.type)) end() }
    window.addEventListener('dragleave', onLeave, true)
    for (const t of ['drop', 'dragend', 'mousemove', 'blur']) window.addEventListener(t, onEnd, true)
    return () => {
      window.removeEventListener('dragleave', onLeave, true)
      for (const t of ['drop', 'dragend', 'mousemove', 'blur']) window.removeEventListener(t, onEnd, true)
    }
  }, [end])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e.dataTransfer?.types)) return
    e.preventDefault()
    if (!overRef.current) set(true)
  }, [set])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null
    const inside = !!rt && e.currentTarget.contains(rt)
    if (leftReceiver(rt, inside)) end()
  }, [end])

  return { over, onDragOver, onDragLeave, end }
}
