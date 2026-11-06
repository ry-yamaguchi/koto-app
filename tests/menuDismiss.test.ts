import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachMenuDismiss } from '../src/renderer/ui/menuDismiss'

type Entry = { type: string; fn: () => void; capture: boolean }
const capOf = (o?: boolean | AddEventListenerOptions) => (typeof o === 'object' ? !!o.capture : !!o)

function makeFake() {
  const list: Entry[] = []
  return {
    list,
    addEventListener(type: string, fn: any, o?: boolean | AddEventListenerOptions) {
      list.push({ type, fn, capture: capOf(o) })
    },
    removeEventListener(type: string, fn: any, o?: boolean | EventListenerOptions) {
      const c = capOf(o as any)
      const i = list.findIndex((e) => e.type === type && e.fn === fn && e.capture === c)
      if (i >= 0) list.splice(i, 1)
    },
  }
}
type Fake = ReturnType<typeof makeFake>

// window に届くまでの2つの段: capture → (#root での処理) → bubble
// stoppedBeforeWindow: 途中の要素（メニューの ul など）が伝わりを止めたとき。window の bubble には届かない
function dispatchThroughWindow(fake: Fake, type: string, duringTarget?: () => void, opts: { stoppedBeforeWindow?: boolean } = {}) {
  for (const e of [...fake.list].filter((x) => x.capture && x.type === type)) e.fn()
  duringTarget?.()
  if (opts.stoppedBeforeWindow) return
  for (const e of [...fake.list].filter((x) => !x.capture && x.type === type)) e.fn()
}

// 直す前の形: どちらも bubble
function legacyAttach(target: Fake, onClose: () => void) {
  const close = () => onClose()
  target.addEventListener('click', close)
  target.addEventListener('contextmenu', close)
  return () => { target.removeEventListener('click', close); target.removeEventListener('contextmenu', close) }
}

describe('attachMenuDismiss', () => {
  it('対照: 直す前の形は、開いた contextmenu の途中で付けると閉じてしまう', () => {
    const fake = makeFake()
    const onClose = vi.fn()
    dispatchThroughWindow(fake, 'contextmenu', () => { legacyAttach(fake, onClose) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('開いた contextmenu の途中で付けても、閉じない', () => {
    const fake = makeFake()
    const onClose = vi.fn()
    dispatchThroughWindow(fake, 'contextmenu', () => { attachMenuDismiss(fake, onClose) })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('付けたあとの新しい contextmenu で、1回閉じる', () => {
    const fake = makeFake()
    const onClose = vi.fn()
    attachMenuDismiss(fake, onClose)
    dispatchThroughWindow(fake, 'contextmenu')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('付けたあとの新しい click で、1回閉じる', () => {
    const fake = makeFake()
    const onClose = vi.fn()
    attachMenuDismiss(fake, onClose)
    dispatchThroughWindow(fake, 'click')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('メニューの中のクリック（ul が伝わりを止める）では閉じない＝click は bubble で付ける', () => {
    const fake = makeFake()
    const onClose = vi.fn()
    attachMenuDismiss(fake, onClose)
    dispatchThroughWindow(fake, 'click', undefined, { stoppedBeforeWindow: true })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('外したあとは、contextmenu も click も呼ばれない', () => {
    const fake = makeFake()
    const onClose = vi.fn()
    const detach = attachMenuDismiss(fake, onClose)
    detach()
    expect(fake.list).toHaveLength(0)
    dispatchThroughWindow(fake, 'contextmenu')
    dispatchThroughWindow(fake, 'click')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Sidebar の配線', () => {
  const src = readFileSync(join(__dirname, '../src/renderer/components/Sidebar.tsx'), 'utf8')
  const start = src.indexOf('function ContextMenu(')
  const end = src.indexOf('function FileTree(')
  const contextMenuBody = src.slice(start, end)
  it('ContextMenu の中で attachMenuDismiss を使い、window に直接 contextmenu を付けない', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(contextMenuBody).toContain('useEffect(() => attachMenuDismiss(window, onClose), [onClose])')
    expect(src).not.toContain("window.addEventListener('contextmenu'")
  })
  it('閉じる関数は描き直しで変えない（描くたびに新しい関数を渡すと、見張りが付け直されてクリックを取りこぼす）', () => {
    expect(src).toContain('const closeMenu = useCallback(() => setMenu(null), [])')
    expect(src).toContain('onClose={closeMenu}')
    expect(src).not.toContain('onClose={() => setMenu(null)}')
  })
})
