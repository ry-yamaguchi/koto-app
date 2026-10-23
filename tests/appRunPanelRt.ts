// appRunPanelRt.ts — AppRunPanel を DOM なしで動かすための偽の React（フックを実際に回し、状態の更新で描き直す小さな実行環境）。
// 使うテスト: tests/ops-shared-panel.test.ts（閉じて開き直しても続きが見える）・tests/sharedTeardownSection*.test.ts（段階2の2c・S1・S2）。
//
// ops-shared-panel.test.ts の先頭にあったものを、そのまま取り出した（差分: 破棄の結果欄の部品を展開する EXPAND に足した）。
// 使い方: テストのファイルの先頭に、次の3つの vi.mock を書く（vi.mock はそのファイルの中でしか効かない）。
//   vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
//   vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
//   vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())

/**
 * 偽の React。フックを回し、setState で描き直す（React 18 と同じく、更新はまとめて次のマイクロタスクで描く）。
 * 画面は作らない: jsx は `{ type, props }` を返すだけ。expand() で（フックを持たない）自作の部品だけを
 * 展開して、画面に出る文字・ボタンを読む。
 */
export const RT = (() => {
  const Fragment = Symbol('Fragment')
  type EffSlot = { kind: 'effect'; deps: unknown[] | undefined; cleanup?: () => void; first: boolean }
  class Inst {
    slots: any[] = []
    idx = 0
    mounted = true
    queued = false
    tree: any = null
    renders = 0
    queue: { slot: EffSlot; fn: () => void | (() => void) }[] = []
    constructor(public fn: (p: any) => any, public props: any) {}
  }
  let current: Inst | null = null
  const depsChanged = (a?: unknown[], b?: unknown[]) =>
    !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]))

  function renderOnce(inst: Inst) {
    current = inst
    inst.idx = 0
    inst.queue = []
    try { inst.tree = inst.fn(inst.props) } finally { current = null }
    inst.renders++
    const pend = inst.queue
    for (const q of pend) if (q.slot.cleanup) { const c = q.slot.cleanup; q.slot.cleanup = undefined; try { c() } catch { /* 解除の失敗は無視 */ } }
    for (const q of pend) { const c = q.fn(); q.slot.cleanup = typeof c === 'function' ? c : undefined }
  }
  function schedule(inst: Inst) {
    if (inst.queued) return
    inst.queued = true
    queueMicrotask(() => { inst.queued = false; if (inst.mounted) renderOnce(inst) })
  }
  const need = () => { if (!current) throw new Error('フックが描画の外で呼ばれた'); return current }

  const useState = (init: unknown) => {
    const inst = need()
    const i = inst.idx++
    if (!(i in inst.slots)) inst.slots[i] = { v: typeof init === 'function' ? (init as () => unknown)() : init }
    const slot = inst.slots[i]
    if (!slot.set) {
      slot.set = (nv: unknown) => {
        if (!inst.mounted) return // 外れたあとの更新は捨てる（React 18 と同じ）
        const next = typeof nv === 'function' ? (nv as (p: unknown) => unknown)(slot.v) : nv
        if (Object.is(next, slot.v)) return
        slot.v = next
        schedule(inst)
      }
    }
    return [slot.v, slot.set]
  }
  const useRef = (init: unknown) => {
    const inst = need()
    const i = inst.idx++
    if (!(i in inst.slots)) inst.slots[i] = { current: init }
    return inst.slots[i]
  }
  const useMemo = (fn: () => unknown, deps?: unknown[]) => {
    const inst = need()
    const i = inst.idx++
    const slot = inst.slots[i]
    if (!slot || depsChanged(slot.deps, deps)) inst.slots[i] = { deps, v: fn() }
    return inst.slots[i].v
  }
  const useCallback = (fn: unknown, deps?: unknown[]) => useMemo(() => fn, deps)
  const useEffect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const inst = need()
    const i = inst.idx++
    if (!(i in inst.slots)) inst.slots[i] = { kind: 'effect', deps: undefined, first: true } as EffSlot
    const slot = inst.slots[i] as EffSlot
    if (slot.first || depsChanged(slot.deps, deps)) {
      slot.deps = deps
      slot.first = false
      inst.queue.push({ slot, fn })
    }
  }

  const jsx = (type: unknown, props: any, key?: unknown) => ({ $$: 'el', type, props: props ?? {}, key })
  const jsxDEV = (type: unknown, props: any, key?: unknown) => jsx(type, props, key)

  function mount(fn: (p: any) => any, props: any): Inst {
    const inst = new Inst(fn, props)
    renderOnce(inst)
    return inst
  }
  function setProps(inst: Inst, props: any) {
    inst.props = props
    renderOnce(inst)
  }
  function unmount(inst: Inst) {
    if (!inst.mounted) return
    inst.mounted = false
    for (const s of inst.slots) if (s && s.kind === 'effect' && s.cleanup) { const c = s.cleanup; s.cleanup = undefined; try { c() } catch { /* 解除の失敗は無視 */ } }
  }

  /** フックを持たない自作の部品だけ展開する。ほかの部品（ConfirmModal など）は箱のまま（props を読む）。 */
  const EXPAND = new Set([
    'OpResultView', 'StoppedResultView', 'WarningsBlock', 'CaptionLine', 'ConfirmDialog',
    // 破棄の結果欄（共通の部品。フックを持たない）。段階2の2c で、破棄の結果は SharedTeardownResultView が描く。
    'SharedTeardownResultView', 'TeardownResultView', 'ResumedNotesView', 'ErrorBlock',
  ])
  function expand(node: any): any {
    if (node == null || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(expand).filter(x => x !== null)
    if (node.$$ === 'el') {
      const { type, props } = node
      if (type === Fragment) return expand(props.children)
      if (typeof type === 'function' && EXPAND.has(type.name)) return expand(type(props))
      return { type: typeof type === 'string' ? type : (type?.name || 'Component'), props, kids: expand(props.children) }
    }
    return null
  }
  function textOf(n: any): string {
    if (n == null) return ''
    if (typeof n === 'string') return n
    if (Array.isArray(n)) return n.map(textOf).join('')
    return textOf(n.kids)
  }
  function findAll(n: any, pred: (x: any) => boolean, out: any[] = []): any[] {
    if (n == null || typeof n === 'string') return out
    if (Array.isArray(n)) { for (const c of n) findAll(c, pred, out); return out }
    if (pred(n)) out.push(n)
    findAll(n.kids, pred, out)
    return out
  }

  return { Fragment, useState, useRef, useMemo, useCallback, useEffect, jsx, jsxDEV, mount, setProps, unmount, expand, textOf, findAll }
})()

export const reactModule = () => ({
  useState: RT.useState, useRef: RT.useRef, useMemo: RT.useMemo, useCallback: RT.useCallback, useEffect: RT.useEffect,
  default: {},
})
export const jsxRuntimeModule = () => ({ jsx: RT.jsx, jsxs: RT.jsx, Fragment: RT.Fragment })
export const jsxDevRuntimeModule = () => ({ jsxDEV: RT.jsxDEV, Fragment: RT.Fragment })
