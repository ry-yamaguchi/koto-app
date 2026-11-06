import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import type { ReactElement } from 'react'

// ── Modal.tsx（窓の薄い殻）の振る舞い ─────────────────────────────────────────────────────────────
// DOM（jsdom）は足さない。React のフックだけを小さな実装に差し替えて Modal を関数として直接呼び、
// 返った要素の木（背景の onClick・枠の ref）と、effect が manager へ登録する中身を見る。
// 差し替えたフックは、描き直しをまたいで state・ref を覚え、依存配列が変わらない effect は走り直さない（本物の React と同じ）。
// 親が描き直すたびに新しい onRequestClose を渡す場面（ConfirmModal など）を、この小さな React で再現して固定する。
// manager は本物（createModalManager）に偽の document を渡して使い、Esc が最前面の1枚だけに届くことまで通す。
//   ・背景を押したときだけ閉じてほしいと伝える。枠の中のクリックは閉じない。どちらも背景より上へ届かせない
//   ・開いたら manager へ登録し、先に登録してから最初のフォーカスを動かす（戻り先を覚えさせるため）
//   ・最初のフォーカスは data-autofocus の最初の使える要素、無ければ枠自身
//   ・最前面の窓だけが Esc を受ける。閉じたら開く前のフォーカスへ戻る
//   ・重なりの深さは開いた時点の「次の深さ」で描き、登録できたら manager の値に合わせる
//   ・親が新しい onRequestClose を渡して描き直しても、登録は1回のまま（外れない・つけ直さない・初期フォーカスへ引き戻さない）。
//     Esc も背景クリックも、そのときの最新の関数を呼ぶ
// 表示（markup）は tests/modalMarkup.test.ts が本物の React で固定する。

const rt = vi.hoisted(() => ({
  /** フックの置き場。描き直しをまたいで残る（新しく載せるときに空にする）。 */
  slots: [] as any[],
  cursor: 0,
  /** 今回の描画で「走らせる」と決まった effect（初回・依存配列が変わったとき・依存配列なし）。 */
  effects: [] as Array<() => void | (() => void)>,
  queue: [] as Array<{ slot: any; deps: unknown[] | undefined; fn: () => void | (() => void) }>,
  setStateCalls: [] as unknown[],
  manager: null as any,
}))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const slot = (rt.slots[rt.cursor] ??= { value: typeof init === 'function' ? (init as () => unknown)() : init })
      rt.cursor++
      return [slot.value, (nv: unknown) => { rt.setStateCalls.push(nv); slot.value = nv }]
    },
    useRef: (init: unknown) => {
      // 本物の React と同じく、描き直しても同じ ref を返す
      const slot = (rt.slots[rt.cursor] ??= { ref: { current: init } })
      rt.cursor++
      return slot.ref
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const slot = (rt.slots[rt.cursor] ??= {})
      rt.cursor++
      const same = slot.committed === true && deps !== undefined && slot.deps !== undefined &&
        deps.length === slot.deps.length && deps.every((d, i) => Object.is(d, slot.deps[i]))
      if (!same) { rt.effects.push(fn); rt.queue.push({ slot, deps, fn }) }
    },
  }
})

vi.mock('../src/renderer/ui/modalManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/ui/modalManager')>()
  return { ...real, getModalManager: () => rt.manager }
})

import Modal, { attachModal, handleBackdropClick, pickInitialFocus, AUTOFOCUS_SELECTOR } from '../src/renderer/ui/Modal'
import { createModalManager } from '../src/renderer/ui/modalManager'

// ── 偽の document と要素 ──────────────────────────────────────────

class FakeEl {
  isConnected = true
  disabled = false
  hidden = false
  focusCalls = 0
  constructor(readonly doc: FakeDoc, readonly name: string) {}
  focus() { this.focusCalls++; this.doc.activeElement = this }
}

class FakeFrame extends FakeEl {
  autofocus: FakeEl[] = []
  tabbables: FakeEl[] = []
  asked: string[] = []
  querySelectorAll(selector: string) {
    this.asked.push(selector)
    return selector === AUTOFOCUS_SELECTOR ? this.autofocus : this.tabbables
  }
}

class FakeDoc {
  activeElement: unknown = null
  body = new FakeEl(this, 'body')
  listeners: Array<(e: any) => void> = []
  /** listener をつけた回数（外れて付け直されたかを見る）。 */
  adds = 0
  addEventListener(_t: string, l: (e: any) => void) { this.adds++; this.listeners.push(l) }
  removeEventListener(_t: string, l: (e: any) => void) { this.listeners = this.listeners.filter(x => x !== l) }
  press(e: any) { for (const l of [...this.listeners]) l(e) }
}

const esc = () => ({ key: 'Escape', defaultPrevented: false, preventDefault() {} })

function findAll(node: unknown, pred: (n: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out }
  if (!node || typeof node !== 'object' || (node as any).props === undefined) return out
  if (pred(node)) out.push(node)
  findAll((node as any).props.children, pred, out)
  return out
}

/** Modal を描く（フックの置き場は触らない＝同じ Modal の描き直し）。背景の div と枠の div を返す。 */
function rerenderModal(over: Record<string, unknown> = {}) {
  rt.cursor = 0
  rt.effects = []
  rt.queue = []
  rt.setStateCalls = []
  const onRequestClose = vi.fn()
  const tree = Modal({ onRequestClose, labelledBy: 't', backdropClassName: 'bg-black/30', panelClassName: 'w-full', children: null, ...over } as any) as ReactElement
  const frameEl = (tree as any).props.children as any
  return { tree: tree as any, frameEl, frameRef: frameEl.ref as { current: unknown }, onRequestClose }
}

/** Modal を新しく載せて1回描く。 */
function renderModal(over: Record<string, unknown> = {}) {
  rt.slots = []
  return rerenderModal(over)
}

/** 描いたあとに React が effect を走らせる順を写す: 走らせる effect だけ、前回の cleanup → 今回の effect。 */
function commitEffects() {
  for (const q of rt.queue.splice(0)) {
    q.slot.cleanup?.()
    q.slot.cleanup = q.fn() ?? undefined
    q.slot.committed = true
    q.slot.deps = q.deps
  }
}

let doc: FakeDoc
beforeEach(() => {
  doc = new FakeDoc()
  rt.manager = createModalManager(doc as any)
})

describe('背景のクリック: 背景そのものを押したときだけ閉じてほしいと伝える', () => {
  it('★★★ 背景そのもの（target が currentTarget）を押すと onRequestClose(\'backdrop\') が1回。クリックは上へ届かせない', () => {
    const { tree, onRequestClose } = renderModal()
    const backdrop = {}
    const stop = vi.fn()
    tree.props.onClick({ target: backdrop, currentTarget: backdrop, stopPropagation: stop })
    expect(onRequestClose.mock.calls).toEqual([['backdrop']])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('★★★ 枠の中を押した（target が枠の中の要素）ときは閉じてほしいと伝えない。ただし上へは届かせない', () => {
    const { tree, onRequestClose } = renderModal()
    const stop = vi.fn()
    tree.props.onClick({ target: {}, currentTarget: {}, stopPropagation: stop })
    expect(onRequestClose).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('handleBackdropClick は純関数として同じ判断（枠の中=閉じない・背景=閉じる）。止めるのはどちらも先', () => {
    const calls: string[] = []
    const same = {}
    handleBackdropClick({ target: same, currentTarget: same, stopPropagation: () => calls.push('stop') }, r => calls.push(r))
    handleBackdropClick({ target: {}, currentTarget: same, stopPropagation: () => calls.push('stop') }, r => calls.push(r))
    expect(calls).toEqual(['stop', 'backdrop', 'stop'])
  })
})

describe('最初のフォーカス', () => {
  it('★ data-autofocus の最初の使える要素へ。無効・隠れたものは飛ばす', () => {
    const frame = new FakeFrame(doc as any, 'frame')
    const disabled = new FakeEl(doc as any, 'disabled'); disabled.disabled = true
    const hidden = new FakeEl(doc as any, 'hidden'); hidden.hidden = true
    const ok = new FakeEl(doc as any, 'ok')
    const later = new FakeEl(doc as any, 'later')
    frame.autofocus = [disabled, hidden, ok, later]
    expect(pickInitialFocus(frame as any)).toBe(ok)
    expect(frame.asked).toEqual(['[data-autofocus]'])
  })

  it('★ 印が無い・全部使えないときは枠自身（tabIndex=-1 の枠に focus する）', () => {
    const frame = new FakeFrame(doc as any, 'frame')
    expect(pickInitialFocus(frame as any)).toBe(frame)
    const disabled = new FakeEl(doc as any, 'd'); disabled.disabled = true
    frame.autofocus = [disabled]
    expect(pickInitialFocus(frame as any)).toBe(frame)
  })
})

describe('attachModal: 登録してからフォーカスする', () => {
  it('★★★ 開く前にフォーカスのあった要素を覚えてから、窓の中へフォーカスを動かす。閉じると元の要素へ戻る', () => {
    const opener = new FakeEl(doc as any, 'opener')
    opener.focus()
    const frame = new FakeFrame(doc as any, 'frame')
    const button = new FakeEl(doc as any, 'button')
    frame.autofocus = [button]
    const handle = attachModal(rt.manager, frame as any, () => {})
    expect(doc.activeElement).toBe(button)
    handle.close()
    expect(doc.activeElement).toBe(opener)
  })

  it('印が無ければ枠自身にフォーカスし、閉じると元の要素へ戻る', () => {
    const opener = new FakeEl(doc as any, 'opener')
    opener.focus()
    const frame = new FakeFrame(doc as any, 'frame')
    const handle = attachModal(rt.manager, frame as any, () => {})
    expect(doc.activeElement).toBe(frame)
    handle.close()
    expect(doc.activeElement).toBe(opener)
  })
})

describe('Modal の effect: manager への登録', () => {
  it('★★★ 描いた枠を最前面の窓として登録する。Esc は onRequestClose(\'escape\') になる', () => {
    const { frameRef, onRequestClose } = renderModal()
    const frame = new FakeFrame(doc as any, 'frame')
    frameRef.current = frame
    rt.effects[0]()
    expect(rt.manager.size()).toBe(1)
    doc.press(esc())
    expect(onRequestClose.mock.calls).toEqual([['escape']])
  })

  it('★★★ 下に別の窓があっても、Esc を受けるのは最前面の Modal だけ（下の窓には届かない）', () => {
    const parentClose = vi.fn()
    const parentFrame = new FakeFrame(doc as any, 'parent')
    rt.manager.open({ frame: parentFrame, onRequestClose: parentClose })

    const { frameRef, onRequestClose } = renderModal()
    frameRef.current = new FakeFrame(doc as any, 'child')
    rt.effects[0]()
    expect(rt.manager.size()).toBe(2)

    doc.press(esc())
    expect(onRequestClose.mock.calls).toEqual([['escape']])
    expect(parentClose).not.toHaveBeenCalled()
  })

  it('★★ 下の窓がある回の重なり: 描き始めは「次の深さ」の z-index、登録できたら manager が決めた深さへ合わせる', () => {
    const parentFrame = new FakeFrame(doc as any, 'parent')
    rt.manager.open({ frame: parentFrame, onRequestClose: () => {} })

    const { tree, frameRef } = renderModal()
    expect(tree.props.style).toEqual({ zIndex: 60 })

    frameRef.current = new FakeFrame(doc as any, 'child')
    rt.effects[0]()
    expect(rt.setStateCalls).toEqual([1])
  })

  it('★★ 窓が1枚もないときの描き始めは深さ0（今の z-50 のまま）', () => {
    const { tree } = renderModal()
    expect(tree.props.style).toEqual({ zIndex: 50 })
  })

  it('★ cleanup で登録を外す（外れたあとの Esc は誰にも届かない）。外した後に開く前のフォーカスへ戻る', () => {
    const opener = new FakeEl(doc as any, 'opener')
    opener.focus()
    const { frameRef, onRequestClose } = renderModal()
    frameRef.current = new FakeFrame(doc as any, 'frame')
    const cleanup = rt.effects[0]() as () => void
    expect(typeof cleanup).toBe('function')
    cleanup()
    expect(rt.manager.size()).toBe(0)
    expect(doc.listeners).toHaveLength(0)
    doc.press(esc())
    expect(onRequestClose).not.toHaveBeenCalled()
    expect(doc.activeElement).toBe(opener)
  })

  it('★ StrictMode の二重 effect（登録 → 解除 → 登録）でも、登録は1枚・listener は1本', () => {
    const { frameRef, onRequestClose } = renderModal()
    frameRef.current = new FakeFrame(doc as any, 'frame')
    const first = rt.effects[0]() as () => void
    first()
    rt.effects[0]()
    expect(rt.manager.size()).toBe(1)
    expect(doc.listeners).toHaveLength(1)
    doc.press(esc())
    expect(onRequestClose.mock.calls).toEqual([['escape']])
  })

  it('枠がまだ無い（ref が空）ときは何も登録しない', () => {
    renderModal()
    expect(rt.effects[0]()).toBeUndefined()
    expect(rt.manager.size()).toBe(0)
  })
})

describe('Modal の描き直し: 親が毎回新しい onRequestClose を渡しても、登録は1回のまま最新の関数を呼ぶ', () => {
  // 確認の窓のチェックを切り替える・入力欄を打つたびに、親が描き直されて `() => onCancel()` のような新しい関数が渡る
  it('★★★ 描き直しても effect は走り直さない。登録は1回のまま、窓の中で動かしたフォーカスを初期フォーカスへ引き戻さない', () => {
    const opener = new FakeEl(doc as any, 'opener')
    opener.focus()
    const first = renderModal()
    const frame = new FakeFrame(doc as any, 'frame')
    const button = new FakeEl(doc as any, 'button')
    const other = new FakeEl(doc as any, 'other')
    frame.autofocus = [button]
    first.frameRef.current = frame
    commitEffects()
    expect(rt.manager.size()).toBe(1)
    expect(doc.adds).toBe(1)
    expect(doc.activeElement).toBe(button)

    // 利用者が窓の中でフォーカスを動かす（Tab で別の部品へ）
    other.focus()
    for (let i = 0; i < 3; i++) {
      rerenderModal()
      expect(rt.effects, `${i + 1}回目の描き直し`).toHaveLength(0)
      commitEffects()
    }
    expect(rt.manager.size()).toBe(1)
    expect(doc.adds).toBe(1) // listener を外してつけ直していない
    expect(button.focusCalls).toBe(1) // 初期フォーカスへ引き戻していない
    expect(opener.focusCalls).toBe(1) // 描き直しの途中で、開く前のフォーカスへ戻していない
    expect(doc.activeElement).toBe(other)
  })

  it('★★★ Esc も背景クリックも、描き直しで渡された最新の onRequestClose を呼ぶ（初回の関数は呼ばない）', () => {
    const first = renderModal()
    first.frameRef.current = new FakeFrame(doc as any, 'frame')
    commitEffects()
    const second = rerenderModal()
    commitEffects()
    const third = rerenderModal()
    commitEffects()

    doc.press(esc())
    const backdrop = {}
    third.tree.props.onClick({ target: backdrop, currentTarget: backdrop, stopPropagation() {} })

    expect(third.onRequestClose.mock.calls).toEqual([['escape'], ['backdrop']])
    expect(second.onRequestClose).not.toHaveBeenCalled()
    expect(first.onRequestClose).not.toHaveBeenCalled()
    expect(rt.manager.size()).toBe(1)
  })
})

describe('Modal.tsx のソース: 使う機能と呼び出しの形', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/ui/Modal.tsx'), 'utf-8')
  // 行頭のコメントは除く（コメントが禁じる名前を説明していても、使っていることにしない）
  const src = raw.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const jsx = src.slice(src.indexOf('  return (\n    <div'))

  it('★ React から取り込むのは useEffect・useRef・useState だけ（小さな描画器が持つフックの範囲）', () => {
    const imports = src.match(/import \{[^}]*\} from 'react'/g) ?? []
    expect(imports).toEqual(["import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'"])
    for (const hook of ['useId', 'useContext', 'useReducer', 'useSyncExternalStore', 'useLayoutEffect', 'createPortal']) {
      expect(src).not.toContain(hook)
    }
  })

  it('★ 登録は attachModal(getModalManager(), frame, …) の1か所。Esc は requestCloseRef 経由で最新の関数へ', () => {
    expect(src).toContain("const handle = attachModal(getModalManager(), frame, () => requestCloseRef.current('escape'))")
    expect(src.match(/attachModal\(getModalManager\(\)/g)).toHaveLength(1)
    expect(src).toContain('const [depth, setDepth] = useState(() => getModalManager().nextDepth())')
    expect(src).toContain('style={{ zIndex: modalZIndex(depth) }}')
    // 重なりを見ずに固定の z-index へ戻した形を禁じる
    expect(src).not.toContain('z-50')
  })

  it('★ 背景の onClick は handleBackdropClick を通す。枠に onClick（stopPropagation の直書き）は無い', () => {
    expect(src).toContain('onClick={(e: MouseEvent<HTMLDivElement>) => handleBackdropClick(e, reason => requestCloseRef.current(reason))}')
    expect(jsx.match(/onClick=/g)).toHaveLength(1)
    expect(jsx).not.toContain('stopPropagation')
  })
})
