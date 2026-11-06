import { describe, it, expect } from 'vitest'
import {
  createModalManager,
  getModalManager,
  modalZIndex,
  nextDepthOf,
  pushEntry,
  removeEntry,
  topOf,
} from '../src/renderer/ui/modalManager'
import { TABBABLE_SELECTOR } from '../src/renderer/ui/modalKeys'

// ── 偽の document ───────────────────────────────────────────────────
// 本物の DOM（jsdom）は足さない。窓の管理に要る最小限だけを、ここで作る。

type Listener = (e: any) => void

class FakeEl {
  isConnected = true
  /** false なら focus() を呼んでも activeElement が動かない（無効・隠れている要素の代わり）。 */
  focusable = true
  disabled = false
  hidden = false
  focusCalls = 0
  constructor(readonly doc: FakeDoc, readonly name: string) {}
  focus() {
    this.focusCalls++
    if (this.isConnected && this.focusable) this.doc.activeElement = this
  }
}

class FakeFrame extends FakeEl {
  tabbables: FakeEl[] = []
  asked: string[] = []
  querySelectorAll(selector: string) {
    this.asked.push(selector)
    return this.tabbables
  }
}

/** 第3引数が true か { capture: true } なら捕捉段階。 */
const isCapture = (o: unknown) => o === true || (typeof o === 'object' && o !== null && (o as { capture?: unknown }).capture === true)

class FakeDoc {
  activeElement: unknown = null
  body = new FakeEl(this, 'body')
  /** バブル段階の listener（付け方の指定が無ければここ）。 */
  listeners: Listener[] = []
  /** 捕捉段階の listener。 */
  capturing: Listener[] = []
  addCalls: Array<[string, Listener]> = []
  removeCalls: Array<[string, Listener]> = []
  addEventListener(type: string, l: Listener, options?: unknown) {
    this.addCalls.push([type, l])
    ;(isCapture(options) ? this.capturing : this.listeners).push(l)
  }
  removeEventListener(type: string, l: Listener, options?: unknown) {
    this.removeCalls.push([type, l])
    // 本物と同じく、付けたときと同じ段階を指したときだけ外れる
    if (isCapture(options)) this.capturing = this.capturing.filter(x => x !== l)
    else this.listeners = this.listeners.filter(x => x !== l)
  }
  /**
   * keydown の届く順（本物と同じ）: 捕捉段階の listener → 押された場所の部品（React の onKeyDown など。`atTarget`）→ バブル段階の listener。
   * 部品が preventDefault すると、あとのバブル段階の listener は defaultPrevented を見る。
   */
  press(e: any, atTarget?: (e: any) => void) {
    for (const l of [...this.capturing]) l(e)
    atTarget?.(e)
    for (const l of [...this.listeners]) l(e)
  }
  el(name: string) { return new FakeEl(this, name) }
  frame(name: string, tabbableNames: string[] = []) {
    const f = new FakeFrame(this, name)
    f.tabbables = tabbableNames.map(n => new FakeEl(this, n))
    return f
  }
}

function key(k: string, extra: Record<string, unknown> = {}) {
  const e: any = {
    key: k,
    defaultPrevented: false,
    prevented: 0,
    preventDefault() { e.prevented++; e.defaultPrevented = true },
    ...extra,
  }
  return e
}

/** 窓を開き、閉じてほしいと言われた回数と理由を数える。 */
function openWindow(mgr: ReturnType<typeof createModalManager>, frame: FakeFrame) {
  const asked: string[] = []
  const handle = mgr.open({ frame, onRequestClose: r => { asked.push(r) } })
  return { handle, asked }
}

function setup() {
  const doc = new FakeDoc()
  const mgr = createModalManager(doc as any)
  return { doc, mgr }
}

// ── 積み重ねの純関数 ────────────────────────────────────────────────

describe('z-index は 50 + 10 × 深さ', () => {
  it('深さ0は今の z-50 のまま、1つ重なるごとに 10 上がる', () => {
    expect(modalZIndex(0)).toBe(50)
    expect(modalZIndex(1)).toBe(60)
    expect(modalZIndex(2)).toBe(70)
    expect(modalZIndex(5)).toBe(100)
  })

  it('負・小数・数でない値は 0 として扱う', () => {
    expect(modalZIndex(-3)).toBe(50)
    expect(modalZIndex(NaN)).toBe(50)
    expect(modalZIndex(Infinity)).toBe(50)
    expect(modalZIndex(1.9)).toBe(60)
  })
})

describe('スタックの出し入れ', () => {
  it('最前面は、いちばん後ろに重ねたもの。空なら無い', () => {
    expect(topOf([])).toBeUndefined()
    expect(topOf(['a', 'b', 'c'])).toBe('c')
  })

  it('重ねるときは最前面に足し、元の配列を変えない', () => {
    const before = ['a', 'b']
    const after = pushEntry(before, 'c')
    expect(after).toEqual(['a', 'b', 'c'])
    expect(before).toEqual(['a', 'b'])
  })

  it('途中を抜いても、残りの順は変わらない（元の配列も変えない）', () => {
    const before = ['a', 'b', 'c']
    expect(removeEntry(before, 'b')).toEqual(['a', 'c'])
    expect(removeEntry(before, 'a')).toEqual(['b', 'c'])
    expect(removeEntry(before, 'c')).toEqual(['a', 'b'])
    expect(before).toEqual(['a', 'b', 'c'])
  })

  it('無いものを抜いても何も変わらない', () => {
    expect(removeEntry(['a', 'b'], 'x')).toEqual(['a', 'b'])
    expect(removeEntry([], 'x')).toEqual([])
  })

  it('次の深さは最前面より1つ深い。空なら 0。途中が抜けても最前面を追い越す', () => {
    expect(nextDepthOf([])).toBe(0)
    expect(nextDepthOf([{ depth: 0 }])).toBe(1)
    expect(nextDepthOf([{ depth: 0 }, { depth: 1 }, { depth: 2 }])).toBe(3)
    // 深さ1の窓が抜けたあと。個数（2）ではなく最前面（2）の次の 3 にする
    expect(nextDepthOf([{ depth: 0 }, { depth: 2 }])).toBe(3)
  })
})

// ── listener の登録と解除 ───────────────────────────────────────────

describe('keydown の listener は、窓がある間だけ1本', () => {
  it('窓が1枚も無いうちは、何も付けない', () => {
    const { doc } = setup()
    expect(doc.addCalls).toEqual([])
    expect(doc.listeners).toHaveLength(0)
  })

  it('1枚目で1本付き、2枚目で増えない。途中の1枚を閉じても残り、最後の1枚で外れる', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    expect(doc.listeners).toHaveLength(1)
    expect(doc.addCalls.map(([type]) => type)).toEqual(['keydown'])
    const b = openWindow(mgr, doc.frame('B'))
    expect(doc.listeners).toHaveLength(1)
    expect(doc.addCalls).toHaveLength(1)

    b.handle.close()
    expect(doc.listeners).toHaveLength(1)
    expect(doc.removeCalls).toHaveLength(0)

    a.handle.close()
    expect(doc.listeners).toHaveLength(0)
    expect(doc.removeCalls).toHaveLength(1)
    // 付けたものと同じ関数を外している
    expect(doc.removeCalls[0]).toEqual(doc.addCalls[0])
  })

  it('途中の窓から先に閉じても、最後の1枚で外れる', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    const b = openWindow(mgr, doc.frame('B'))
    a.handle.close()
    expect(doc.listeners).toHaveLength(1)
    b.handle.close()
    expect(doc.listeners).toHaveLength(0)
  })

  it('閉じたあとにもう一度開くと、また1本付く', () => {
    const { doc, mgr } = setup()
    openWindow(mgr, doc.frame('A')).handle.close()
    openWindow(mgr, doc.frame('B'))
    expect(doc.listeners).toHaveLength(1)
    expect(doc.addCalls).toHaveLength(2)
    expect(doc.removeCalls).toHaveLength(1)
  })

  it('close を何度呼んでも1回分（解除も、ほかの窓への影響も）', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    const b = openWindow(mgr, doc.frame('B'))
    b.handle.close()
    b.handle.close()
    b.handle.close()
    expect(mgr.size()).toBe(1)
    expect(doc.removeCalls).toHaveLength(0)
    a.handle.close()
    a.handle.close()
    expect(mgr.size()).toBe(0)
    expect(doc.removeCalls).toHaveLength(1)
  })

  // React の StrictMode は effect を「登録 → 解除 → 登録」と二重に回す
  it('StrictMode と同じ「開く → 閉じる → 開く」でも、listener は1本・窓は1枚・Esc は1回だけ届く', () => {
    const { doc, mgr } = setup()
    const frame = doc.frame('A')
    const first = openWindow(mgr, frame)
    first.handle.close()
    const second = openWindow(mgr, frame)
    expect(doc.listeners).toHaveLength(1)
    expect(doc.addCalls).toHaveLength(2)
    expect(doc.removeCalls).toHaveLength(1)
    expect(mgr.size()).toBe(1)

    doc.press(key('Escape'))
    expect(first.asked).toEqual([])
    expect(second.asked).toEqual(['escape'])

    // 最初の登録の close は、もう効かない（2回目の登録を巻き込まない）
    first.handle.close()
    expect(mgr.size()).toBe(1)
    expect(doc.listeners).toHaveLength(1)
  })

  it('同じ枠を二重に登録しても1枚。Esc は1回、呼ぶのは新しいほうの onRequestClose', () => {
    const { doc, mgr } = setup()
    const frame = doc.frame('A')
    const first = openWindow(mgr, frame)
    const second = openWindow(mgr, frame)
    expect(mgr.size()).toBe(1)
    expect(doc.listeners).toHaveLength(1)
    expect(doc.addCalls).toHaveLength(1)
    expect(second.handle).toBe(first.handle)

    doc.press(key('Escape'))
    expect(first.asked).toEqual([])
    expect(second.asked).toEqual(['escape'])

    first.handle.close()
    expect(mgr.size()).toBe(0)
    expect(doc.listeners).toHaveLength(0)
  })
})

// ── Esc ─────────────────────────────────────────────────────────────

describe('Esc は最前面の1枚だけが受ける', () => {
  it('重なっていても、呼ばれるのは最前面の窓だけ（理由は escape）', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    const b = openWindow(mgr, doc.frame('B'))
    const c = openWindow(mgr, doc.frame('C'))
    doc.press(key('Escape'))
    expect(c.asked).toEqual(['escape'])
    expect(b.asked).toEqual([])
    expect(a.asked).toEqual([])
  })

  it('子を閉じると、次の Esc は親に届く', () => {
    const { doc, mgr } = setup()
    const parent = openWindow(mgr, doc.frame('親'))
    const child = openWindow(mgr, doc.frame('子'))
    doc.press(key('Escape'))
    child.handle.close()
    doc.press(key('Escape'))
    expect(child.asked).toEqual(['escape'])
    expect(parent.asked).toEqual(['escape'])
  })

  it('途中の窓を閉じたあとの最前面は、残っている中で最後に開いたもの', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    const b = openWindow(mgr, doc.frame('B'))
    const c = openWindow(mgr, doc.frame('C'))
    b.handle.close()
    doc.press(key('Escape'))
    expect(c.asked).toEqual(['escape'])
    expect(a.asked).toEqual([])
    c.handle.close()
    doc.press(key('Escape'))
    expect(a.asked).toEqual(['escape'])
  })

  // 閉じてよいかは窓の持ち主が決める。manager は勝手に閉じない
  it('Esc を渡しても、窓を閉じるのは持ち主だけ（manager は閉じない）', () => {
    const { doc, mgr } = setup()
    openWindow(mgr, doc.frame('A'))
    openWindow(mgr, doc.frame('B'))
    doc.press(key('Escape'))
    expect(mgr.size()).toBe(2)
    expect(doc.listeners).toHaveLength(1)
  })

  it('変換中の Esc は無視する（isComposing も keyCode 229 も）', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    doc.press(key('Escape', { isComposing: true }))
    doc.press(key('Escape', { keyCode: 229 }))
    expect(a.asked).toEqual([])
    doc.press(key('Escape'))
    expect(a.asked).toEqual(['escape'])
  })

  it('defaultPrevented の Esc は無視する', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    doc.press(key('Escape', { defaultPrevented: true }))
    expect(a.asked).toEqual([])
  })

  // defaultPrevented を見る守りは、部品の onKeyDown が終わったあと（document のバブル段階）でしか効かない。
  // 捕捉段階につけると、部品が preventDefault した Esc（名前の編集の取り消しなど）を窓が先に受けて、一緒に閉じてしまう
  it('★★ listener は document のバブル段階につく。窓の中の部品が preventDefault した Esc は、窓が受けない', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    expect(doc.addCalls.map(([type]) => type)).toEqual(['keydown'])
    expect(doc.listeners).toHaveLength(1)
    expect(doc.capturing).toHaveLength(0)

    // 部品が Esc で自分の編集だけを取り消す（preventDefault して、窓は閉じない）
    const handled = key('Escape')
    doc.press(handled, e => e.preventDefault())
    expect(handled.prevented).toBe(1)
    expect(a.asked).toEqual([])

    // 部品が何もしなかった Esc は、窓が受ける
    doc.press(key('Escape'), () => {})
    expect(a.asked).toEqual(['escape'])

    // 外すときも、付けたときと同じ段階で外す（外れ残らない）
    a.handle.close()
    expect(doc.listeners).toHaveLength(0)
    expect(doc.capturing).toHaveLength(0)
  })

  it('Esc 以外のキーでは閉じてほしいと言わない', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    for (const k of ['Enter', 'a', ' ', 'Backspace', 'ArrowDown']) doc.press(key(k))
    expect(a.asked).toEqual([])
  })

  it('全部閉じたあとに古い listener が呼ばれても、何も起きない', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    const stale = doc.addCalls[0][1]
    a.handle.close()
    stale(key('Escape'))
    stale(key('Tab'))
    expect(a.asked).toEqual([])
  })
})

// ── Tab ─────────────────────────────────────────────────────────────

describe('Tab は最前面の窓の中で一周する', () => {
  function tabSetup() {
    const { doc, mgr } = setup()
    const frame = doc.frame('A', ['t1', 't2', 't3'])
    const win = openWindow(mgr, frame)
    const [t1, t2, t3] = frame.tabbables
    return { doc, mgr, frame, win, t1, t2, t3 }
  }

  it('枠の中を探すときは、決まった selector で探す', () => {
    const { doc, frame, t3 } = tabSetup()
    doc.activeElement = t3
    doc.press(key('Tab'))
    expect(frame.asked).toEqual([TABBABLE_SELECTOR])
  })

  it('末尾で Tab を押すと先頭へ、先頭で Shift+Tab を押すと末尾へ戻る（既定の動きは止める）', () => {
    const { doc, t1, t3 } = tabSetup()
    doc.activeElement = t3
    const forward = key('Tab')
    doc.press(forward)
    expect(doc.activeElement).toBe(t1)
    expect(forward.prevented).toBe(1)

    const backward = key('Tab', { shiftKey: true })
    doc.press(backward)
    expect(doc.activeElement).toBe(t3)
    expect(backward.prevented).toBe(1)
  })

  it('途中ではブラウザに任せる（フォーカスを動かさず、既定の動きも止めない）', () => {
    const { doc, t2 } = tabSetup()
    doc.activeElement = t2
    const forward = key('Tab')
    const backward = key('Tab', { shiftKey: true })
    doc.press(forward)
    doc.press(backward)
    expect(doc.activeElement).toBe(t2)
    expect(forward.prevented).toBe(0)
    expect(backward.prevented).toBe(0)
  })

  it('枠の外にフォーカスがあれば、先頭へ（Shift なら末尾へ）戻す', () => {
    const { doc, t1, t3 } = tabSetup()
    const outside = doc.el('背景のボタン')
    doc.activeElement = outside
    const forward = key('Tab')
    doc.press(forward)
    expect(doc.activeElement).toBe(t1)
    expect(forward.prevented).toBe(1)

    doc.activeElement = outside
    doc.press(key('Tab', { shiftKey: true }))
    expect(doc.activeElement).toBe(t3)
  })

  it('フォーカスが枠自身にあるとき（初期フォーカス）も、先頭・末尾へ入る', () => {
    const { doc, frame, t1, t3 } = tabSetup()
    doc.activeElement = frame
    doc.press(key('Tab'))
    expect(doc.activeElement).toBe(t1)
    doc.activeElement = frame
    doc.press(key('Tab', { shiftKey: true }))
    expect(doc.activeElement).toBe(t3)
  })

  it('フォーカスがどこにも無い（null）ときも、先頭へ入る', () => {
    const { doc, t1 } = tabSetup()
    doc.activeElement = null
    doc.press(key('Tab'))
    expect(doc.activeElement).toBe(t1)
  })

  it('止まる要素が1つも無い枠では、既定の動きを止めて枠にとどめる', () => {
    const { doc, mgr } = setup()
    const frame = doc.frame('空の窓')
    openWindow(mgr, frame)
    doc.activeElement = doc.el('背景のボタン')
    const e = key('Tab')
    doc.press(e)
    expect(e.prevented).toBe(1)
    expect(doc.activeElement).toBe(frame)
  })

  it('無効・隠しの要素は飛ばして一周する', () => {
    const { doc, mgr } = setup()
    const frame = doc.frame('A', ['t1', 't2', 't3'])
    openWindow(mgr, frame)
    const [t1, t2, t3] = frame.tabbables
    t3.disabled = true
    t2.hidden = true
    // 止まるのは t1 だけ。t1 から Tab を押すと t1 に戻る
    doc.activeElement = t1
    const e = key('Tab')
    doc.press(e)
    expect(doc.activeElement).toBe(t1)
    expect(e.prevented).toBe(1)
  })

  it('重なっているときは、最前面の枠の中だけを一周する', () => {
    const { doc, mgr } = setup()
    const back = doc.frame('背面', ['a1', 'a2'])
    const front = doc.frame('前面', ['b1', 'b2'])
    openWindow(mgr, back)
    openWindow(mgr, front)
    doc.activeElement = front.tabbables[1]
    doc.press(key('Tab'))
    expect(doc.activeElement).toBe(front.tabbables[0])
    // 背面の枠は探さない
    expect(back.asked).toEqual([])

    // 背面の要素にフォーカスがあっても、前面の先頭へ引き戻す
    doc.activeElement = back.tabbables[0]
    doc.press(key('Tab'))
    expect(doc.activeElement).toBe(front.tabbables[0])
  })

  it('変換中・defaultPrevented・修飾キー付きの Tab は動かさない', () => {
    const { doc, t3 } = tabSetup()
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      doc.activeElement = t3
      const e = key('Tab', extra)
      doc.press(e)
      expect(doc.activeElement).toBe(t3)
      expect(e.prevented).toBe(0)
    }
  })

  it('窓を閉じたあとの Tab には何もしない（listener が外れている）', () => {
    const { doc, win, t3 } = tabSetup()
    win.handle.close()
    doc.activeElement = t3
    const e = key('Tab')
    doc.press(e)
    expect(e.prevented).toBe(0)
    expect(doc.activeElement).toBe(t3)
  })
})

// ── フォーカスの記録と復帰 ──────────────────────────────────────────

describe('閉じたら、開く前の要素へフォーカスを戻す', () => {
  it('開く前にフォーカスのあった要素へ戻す', () => {
    const { doc, mgr } = setup()
    const opener = doc.el('開いたボタン')
    doc.activeElement = opener
    const frame = doc.frame('A', ['a1'])
    const win = openWindow(mgr, frame)
    frame.tabbables[0].focus()
    expect(doc.activeElement).toBe(frame.tabbables[0])
    win.handle.close()
    expect(doc.activeElement).toBe(opener)
  })

  it('子を閉じると親の中の元の場所へ、親を閉じると最初のボタンへ戻る', () => {
    const { doc, mgr } = setup()
    const opener = doc.el('開いたボタン')
    doc.activeElement = opener
    const parentFrame = doc.frame('親', ['p1'])
    const parent = openWindow(mgr, parentFrame)
    const p1 = parentFrame.tabbables[0]
    p1.focus()
    const childFrame = doc.frame('子', ['c1'])
    const child = openWindow(mgr, childFrame)
    childFrame.tabbables[0].focus()

    child.handle.close()
    expect(doc.activeElement).toBe(p1)
    parent.handle.close()
    expect(doc.activeElement).toBe(opener)
  })

  it('戻り先が画面から無くなっていれば、次の最前面の枠へ戻す', () => {
    const { doc, mgr } = setup()
    const parentFrame = doc.frame('親', ['p1'])
    openWindow(mgr, parentFrame)
    const p1 = parentFrame.tabbables[0]
    p1.focus()
    const child = openWindow(mgr, doc.frame('子', ['c1']))
    p1.isConnected = false
    child.handle.close()
    expect(doc.activeElement).toBe(parentFrame)
  })

  it('戻り先がフォーカスを受け取らないときも、次の最前面の枠へ戻す', () => {
    const { doc, mgr } = setup()
    const parentFrame = doc.frame('親', ['p1'])
    openWindow(mgr, parentFrame)
    const p1 = parentFrame.tabbables[0]
    p1.focus()
    const child = openWindow(mgr, doc.frame('子'))
    p1.focusable = false
    doc.activeElement = doc.el('どこか')
    child.handle.close()
    expect(p1.focusCalls).toBe(2)
    expect(doc.activeElement).toBe(parentFrame)
  })

  it('戻り先が無く、次の窓も無ければ何もしない', () => {
    const { doc, mgr } = setup()
    const opener = doc.el('開いたボタン')
    doc.activeElement = opener
    const win = openWindow(mgr, doc.frame('A'))
    const inside = doc.el('窓の中')
    doc.activeElement = inside
    opener.isConnected = false
    expect(() => win.handle.close()).not.toThrow()
    expect(doc.activeElement).toBe(inside)
    expect(opener.focusCalls).toBe(0)
  })

  it('開く前にフォーカスがどこにも無かったとき（null・body）は、覚えない', () => {
    for (const initial of ['null', 'body'] as const) {
      const { doc, mgr } = setup()
      doc.activeElement = initial === 'null' ? null : doc.body
      const win = openWindow(mgr, doc.frame('A'))
      const inside = doc.el('窓の中')
      doc.activeElement = inside
      win.handle.close()
      expect(doc.body.focusCalls).toBe(0)
      expect(doc.activeElement).toBe(inside)
    }
  })

  it('戻り先が無くても、まだ窓が残っていれば、その枠へ戻す', () => {
    const { doc, mgr } = setup()
    const parentFrame = doc.frame('親')
    openWindow(mgr, parentFrame)
    doc.activeElement = null
    const child = openWindow(mgr, doc.frame('子'))
    child.handle.close()
    expect(doc.activeElement).toBe(parentFrame)
  })

  it('最前面でない窓を閉じても、フォーカスは動かさない', () => {
    const { doc, mgr } = setup()
    const opener = doc.el('開いたボタン')
    doc.activeElement = opener
    const back = openWindow(mgr, doc.frame('背面'))
    const frontFrame = doc.frame('前面', ['b1'])
    openWindow(mgr, frontFrame)
    const b1 = frontFrame.tabbables[0]
    b1.focus()
    back.handle.close()
    expect(doc.activeElement).toBe(b1)
    expect(opener.focusCalls).toBe(0)
  })

  it('途中の窓が先に閉じたあと、最前面を閉じると、その窓が覚えていた元の場所へ戻る', () => {
    const { doc, mgr } = setup()
    const opener = doc.el('開いたボタン')
    doc.activeElement = opener
    const parentFrame = doc.frame('親', ['p1'])
    const parent = openWindow(mgr, parentFrame)
    const p1 = parentFrame.tabbables[0]
    p1.focus()
    const childFrame = doc.frame('子', ['c1'])
    const child = openWindow(mgr, childFrame)
    const c1 = childFrame.tabbables[0]
    c1.focus()

    // 親が先に画面から外れる（親の中の p1 はもう無い）
    p1.isConnected = false
    parent.handle.close()
    expect(doc.activeElement).toBe(c1)

    child.handle.close()
    expect(doc.activeElement).toBe(opener)
  })

  it('2回目以降の close ではフォーカスを動かさない', () => {
    const { doc, mgr } = setup()
    const opener = doc.el('開いたボタン')
    doc.activeElement = opener
    const win = openWindow(mgr, doc.frame('A'))
    win.handle.close()
    expect(opener.focusCalls).toBe(1)
    const elsewhere = doc.el('別の場所')
    doc.activeElement = elsewhere
    win.handle.close()
    expect(opener.focusCalls).toBe(1)
    expect(doc.activeElement).toBe(elsewhere)
  })

  it('StrictMode と同じ「開く → 閉じる → 開く」のあとでも、戻り先は最初の要素のまま', () => {
    const { doc, mgr } = setup()
    const opener = doc.el('開いたボタン')
    doc.activeElement = opener
    const frame = doc.frame('A', ['a1'])
    const first = openWindow(mgr, frame)
    frame.tabbables[0].focus()
    first.handle.close()
    expect(doc.activeElement).toBe(opener)

    const second = openWindow(mgr, frame)
    frame.tabbables[0].focus()
    second.handle.close()
    expect(doc.activeElement).toBe(opener)
  })
})

// ── 深さと z-index ──────────────────────────────────────────────────

describe('開いた順の深さ', () => {
  it('開いた順に 0・1・2。次の深さも同じ数を返す', () => {
    const { doc, mgr } = setup()
    expect(mgr.nextDepth()).toBe(0)
    const a = openWindow(mgr, doc.frame('A'))
    expect(mgr.nextDepth()).toBe(1)
    const b = openWindow(mgr, doc.frame('B'))
    const c = openWindow(mgr, doc.frame('C'))
    expect([a.handle.depth, b.handle.depth, c.handle.depth]).toEqual([0, 1, 2])
    expect([a, b, c].map(w => modalZIndex(w.handle.depth))).toEqual([50, 60, 70])
    expect(mgr.size()).toBe(3)
  })

  it('途中が抜けても、深さは変わらない。次の窓は最前面を追い越す', () => {
    const { doc, mgr } = setup()
    const a = openWindow(mgr, doc.frame('A'))
    const b = openWindow(mgr, doc.frame('B'))
    const c = openWindow(mgr, doc.frame('C'))
    b.handle.close()
    expect(a.handle.depth).toBe(0)
    expect(c.handle.depth).toBe(2)
    const d = openWindow(mgr, doc.frame('D'))
    expect(d.handle.depth).toBe(3)
    expect(modalZIndex(d.handle.depth)).toBeGreaterThan(modalZIndex(c.handle.depth))
  })

  it('全部閉じると、次はまた深さ0（今の z-50）から', () => {
    const { doc, mgr } = setup()
    openWindow(mgr, doc.frame('A')).handle.close()
    expect(mgr.size()).toBe(0)
    expect(openWindow(mgr, doc.frame('B')).handle.depth).toBe(0)
  })
})

// ── document が無い環境 ─────────────────────────────────────────────

describe('document が無い環境では何もしない', () => {
  it('null・undefined を渡しても、開く・閉じるが空振りして投げない', () => {
    for (const none of [null, undefined]) {
      const mgr = createModalManager(none)
      const frame = new FakeDoc().frame('A')
      const asked: string[] = []
      const handle = mgr.open({ frame, onRequestClose: r => { asked.push(r) } })
      expect(handle.depth).toBe(0)
      expect(mgr.size()).toBe(0)
      expect(mgr.nextDepth()).toBe(0)
      expect(() => { handle.close(); handle.close() }).not.toThrow()
      expect(asked).toEqual([])
    }
  })

  it('共有の manager も、document が無い環境（node）では何もしない', () => {
    expect(typeof document).toBe('undefined')
    const mgr = getModalManager()
    expect(getModalManager()).toBe(mgr)
    const handle = mgr.open({ frame: new FakeDoc().frame('A'), onRequestClose: () => {} })
    expect(mgr.size()).toBe(0)
    expect(() => handle.close()).not.toThrow()
  })
})
