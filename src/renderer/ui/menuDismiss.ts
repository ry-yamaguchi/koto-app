// 右クリックのメニューを「ほかの場所の操作で閉じる」リスナーの付け外し。
export type MenuDismissTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

export function attachMenuDismiss(target: MenuDismissTarget, onClose: () => void): () => void {
  const close = () => onClose()
  // contextmenu は capture で付ける。React 18 は開いた右クリックの途中で effect を流すが、
  // そのときには window の capture の段はもう過ぎているので、開いた右クリック自身は届かない。
  // あとで別の場所を右クリックすると、capture で先に閉じ、そのあと行のハンドラが新しいメニューを開く。
  target.addEventListener('contextmenu', close, { capture: true })
  // click は bubble のまま。メニューの中のクリックは ul の onClick の stopPropagation で
  // window まで届かない。capture にすると項目の onClick より先にメニューが閉じて、項目が押せなくなる。
  target.addEventListener('click', close)
  return () => {
    target.removeEventListener('contextmenu', close, { capture: true })
    target.removeEventListener('click', close)
  }
}
