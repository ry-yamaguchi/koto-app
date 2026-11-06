// Modal.tsx — 窓（モーダル）の薄い殻。「背景 div > 枠 div」の2段に、読み上げの印と Esc・Tab・フォーカスの管理をつける。
//
// 窓の積み重ね・Esc の振り分け・Tab の閉じ込め・フォーカスの記録と復帰は modalManager.ts が持つ。
// ここは (1) その manager へ窓を1枚登録する (2) 開いたときの最初のフォーカスを決める (3) 印と背景クリックを描く、だけ。
// 窓の中身・幅・背景の濃さは呼び側が決める（見た目の統一は別の仕事）。
//
// ── 約束 ────────────────────────────────────────────────────────────
// ・role は通常 dialog。確認と通知は alertdialog。aria-modal="true"。
//   aria-labelledby・aria-describedby の id は、呼び側が書く固定の文字列（useId は使わない）。
// ・初期フォーカスは枠の中の `data-autofocus` の要素。無ければ枠自身（tabIndex={-1}）。
// ・背景クリックは、背景そのものを押したときだけ onRequestClose('backdrop')。枠の中のクリックは閉じない。
//   背景まで届いたクリックは、そこで止める（古い作りの親の背景が、確認の中のクリックで一緒に閉じるのを防ぐ）。
// ・Esc は最前面の窓だけが受ける（modalManager.ts）。閉じてよいかは onRequestClose を受けた側が決める。
// ・使う React の機能は useState・useRef・useEffect だけ（useId・useContext・ポータルは使わない）。
//   窓の中身を本物のまま動かす小さな描画器が、この範囲のフックしか持たない。

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { getModalManager, modalZIndex, type FocusTargetLike, type ModalFrameLike, type ModalHandle, type ModalManager } from './modalManager'

/** 閉じてほしいと言われた理由。 */
export type ModalCloseReason = 'escape' | 'backdrop'

export interface ModalProps {
  /** 閉じてほしいと言われたとき（Esc・背景クリック）。閉じてよいかは受けた側が決める（未保存なら確認・実行中は閉じない、など）。 */
  onRequestClose: (reason: ModalCloseReason) => void
  /** 通常は dialog。確認と通知は alertdialog。 */
  role?: 'dialog' | 'alertdialog'
  /** 見出しの要素の id（呼び側が書く固定の文字列）。 */
  labelledBy: string
  /** 説明の要素の id（呼び側が書く固定の文字列）。無ければ付けない。 */
  describedBy?: string
  /** 背景の div に足す class（背景の濃さ・余白）。位置と中央寄せは殻が持つ。 */
  backdropClassName: string
  /** 枠の div の class（幅・角・色）。長い本文のための最大の高さと縦のスクロールは殻が足す。 */
  panelClassName: string
  children?: ReactNode
}

/** 初期フォーカスの印を探す selector。 */
export const AUTOFOCUS_SELECTOR = '[data-autofocus]'

/** 無効・隠れた印は飛ばす。取れない環境では生きているとみなす。 */
function isUsableTarget(x: unknown): x is FocusTargetLike {
  const t = x as (FocusTargetLike & { disabled?: boolean; hidden?: boolean }) | null | undefined
  return typeof t?.focus === 'function' && !t.disabled && !t.hidden
}

/** 窓を開いたときに最初にフォーカスする先。枠の中の `data-autofocus` の最初の要素、無ければ枠自身。 */
export function pickInitialFocus(frame: ModalFrameLike): FocusTargetLike {
  for (const el of Array.from(frame.querySelectorAll(AUTOFOCUS_SELECTOR))) {
    if (isUsableTarget(el)) return el
  }
  return frame
}

/**
 * 窓を manager へ登録し、最初のフォーカスを動かす。返った handle の close() で登録を外し、開く前のフォーカスへ戻る。
 * 登録を先にする（manager が「開く前にフォーカスのあった要素」を覚えるため。順が逆だと戻り先が窓の中になる）。
 */
export function attachModal(manager: ModalManager, frame: ModalFrameLike, onRequestClose: () => void): ModalHandle {
  const handle = manager.open({ frame, onRequestClose })
  pickInitialFocus(frame).focus()
  return handle
}

/**
 * 背景のクリック。ここまで届いたクリックは止め、背景そのものを押したときだけ閉じてほしいと伝える。
 * 枠の中のクリック（target が背景でない）では閉じない。
 */
export function handleBackdropClick(
  e: { target: unknown; currentTarget: unknown; stopPropagation(): void },
  requestClose: (reason: ModalCloseReason) => void,
): void {
  e.stopPropagation()
  if (e.target === e.currentTarget) requestClose('backdrop')
}

export default function Modal({
  onRequestClose,
  role = 'dialog',
  labelledBy,
  describedBy,
  backdropClassName,
  panelClassName,
  children,
}: ModalProps) {
  // 重なりの深さは、開いた時点の「次の深さ」で描き始め、登録できたら manager が決めた値に合わせる
  const [depth, setDepth] = useState(() => getModalManager().nextDepth())
  const frameRef = useRef<HTMLDivElement | null>(null)
  // 親が毎回新しい関数を渡しても、登録は1回のまま最新の関数を呼ぶ
  const requestCloseRef = useRef(onRequestClose)
  requestCloseRef.current = onRequestClose

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const handle = attachModal(getModalManager(), frame, () => requestCloseRef.current('escape'))
    setDepth(handle.depth)
    return () => handle.close()
  }, [])

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center ${backdropClassName}`}
      style={{ zIndex: modalZIndex(depth) }}
      onClick={(e: MouseEvent<HTMLDivElement>) => handleBackdropClick(e, reason => requestCloseRef.current(reason))}
    >
      <div
        ref={frameRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`${panelClassName} max-h-[90vh] overflow-y-auto focus:outline-none`}
      >
        {children}
      </div>
    </div>
  )
}
