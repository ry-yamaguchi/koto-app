import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'

// ── useConfirm: 最初にフォーカスするボタン（initialFocus）が ConfirmModal まで届く ─────────────────────
// 呼び口（useConfirm 12・useConfirmChoices 4）は変えずに、確認の窓の最初のフォーカスを呼び側が指せる。
// 赤い確認は ConfirmModal 側で常にキャンセル。お金に触れる赤くない確認 3 か所（Claude の同意・前のバージョンへ戻す・専有型の公開）が
// initialFocus: 'cancel' を渡す。useConfirmChoices 側は tests/confirmChoices.test.ts が同じ形で固定する。
// React の useState・useCallback だけを小さな実装に差し替えて、フックをそのまま呼ぶ。

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  i: 0,
  rerender: () => {},
}))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const idx = rt.i++
      if (!(idx in rt.slots)) rt.slots[idx] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[idx]) : v
        if (Object.is(next, rt.slots[idx])) return
        rt.slots[idx] = next
        rt.rerender()
      }
      return [rt.slots[idx], set]
    },
    useCallback: (fn: unknown) => fn,
  }
})

import { useConfirm } from '../src/renderer/useConfirm'
import ConfirmModal from '../src/renderer/components/ConfirmModal'

function mount() {
  rt.slots = []
  let latest!: ReturnType<typeof useConfirm>
  const render = () => { rt.i = 0; latest = useConfirm() }
  rt.rerender = render
  render()
  return {
    get h() { return latest },
    // element は確認（ConfirmModal）と通知（NotifyModal）を並べた Fragment。確認はその1つめ
    get el() { return (latest.element as ReactElement<{ children: ReactElement[] }>).props.children[0] },
    get props() { return (this.el as any).props },
  }
}

describe('useConfirm: initialFocus を ConfirmModal へ渡す', () => {
  it('★★★ confirm({ initialFocus: \'cancel\' }) の間、ConfirmModal の initialFocus が \'cancel\'。答えは今までどおり boolean', async () => {
    const m = mount()
    const p = m.h.confirm({ title: '専有型にアプリを公開します', body: '本文', confirmLabel: '公開する', danger: false, initialFocus: 'cancel' })
    expect(m.el.type).toBe(ConfirmModal)
    expect(m.props).toMatchObject({ open: true, danger: false, initialFocus: 'cancel', confirmLabel: '公開する' })
    m.props.onConfirm()
    expect(await p).toBe(true)
    expect(m.props.open).toBe(false)
  })

  it('★★ 言わなければ initialFocus は無し（赤い確認はキャンセル・それ以外は実行の既定は ConfirmModal が持つ）', async () => {
    const m = mount()
    const p = m.h.confirm({ title: 't', body: 'b', danger: true })
    expect(m.props.initialFocus).toBeUndefined()
    m.props.onCancel()
    expect(await p).toBe(false)
  })

  it('★★ 次の確認へは持ち越さない（前の確認の initialFocus が残らない）', async () => {
    const m = mount()
    const first = m.h.confirm({ title: 'a', body: 'b', initialFocus: 'cancel' })
    expect(m.props.initialFocus).toBe('cancel')
    m.props.onCancel()
    await first
    const second = m.h.confirm({ title: 'c', body: 'd' })
    expect(m.props.initialFocus).toBeUndefined()
    m.props.onCancel()
    await second
  })

  it('閉じている間は ConfirmModal へ initialFocus を渡しても open は false（何も描かない）', () => {
    const m = mount()
    expect(m.props.open).toBe(false)
    expect(m.props.initialFocus).toBeUndefined()
  })
})
