import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'

// useConfirm・useConfirmChoices は React フック。vitest は node 環境（描画器なし）なので、useState だけを小さな偽物に差し替える
// （tests/confirmCallSites.test.ts と同じ作り）。
const rt = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, rerender: () => {} }))
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

import { createNotifyQueue, type NotifyOptions } from '../src/renderer/notifyQueue'
import { useConfirm } from '../src/renderer/useConfirm'
import { useConfirmChoices } from '../src/renderer/useConfirmChoices'
import NotifyModal from '../src/renderer/components/NotifyModal'
import Modal from '../src/renderer/ui/Modal'

// notify（OK が1つだけの通知）は続けて呼ばれうる。待ち行列は、積んだ順に1つずつ出し、すべての Promise を解決する。

const n = (title: string): NotifyOptions => ({ title, body: `${title}の本文` })

describe('createNotifyQueue: 続けて積んでも、両方（全部）が解決する', () => {
  it('★★★ 2回続けて積む → 先のものだけが出ている → OK で先が解決し次が出る → OK で次も解決する（出た順の一覧）', async () => {
    const shown: (string | null)[] = []
    const q = createNotifyQueue(c => shown.push(c?.title ?? null))
    const done: string[] = []
    const a = q.push(n('A')).then(() => done.push('A'))
    const b = q.push(n('B')).then(() => done.push('B'))
    expect(shown).toEqual(['A']) // B は A が閉じるまで出ない
    expect(q.current()?.title).toBe('A')
    q.dismiss()
    await a
    expect(done).toEqual(['A'])
    expect(shown).toEqual(['A', 'B'])
    expect(q.current()?.title).toBe('B')
    q.dismiss()
    await b
    expect(done).toEqual(['A', 'B'])
    expect(shown).toEqual(['A', 'B', null])
    expect(q.current()).toBeNull()
  })

  it('★★ 3回でも順番どおり。出ていないときの dismiss は何もしない', async () => {
    const q = createNotifyQueue()
    q.dismiss()
    const order: string[] = []
    const ps = ['A', 'B', 'C'].map(t => q.push(n(t)).then(() => order.push(t)))
    q.dismiss(); q.dismiss(); q.dismiss()
    await Promise.all(ps)
    expect(order).toEqual(['A', 'B', 'C'])
    expect(q.current()).toBeNull()
  })

  it('★★ 閉じたあとにまた積むと、すぐ出る', async () => {
    const shown: (string | null)[] = []
    const q = createNotifyQueue(c => shown.push(c?.title ?? null))
    const a = q.push(n('A')); q.dismiss(); await a
    const b = q.push(n('B'))
    expect(shown).toEqual(['A', null, 'B'])
    q.dismiss(); await b
  })
})

describe('useConfirm の notify: 続けて2回呼んでも両方解決する。OK 1つの alertdialog', () => {
  function mount() {
    rt.slots = []
    let latest!: ReturnType<typeof useConfirm>
    const render = () => { rt.i = 0; latest = useConfirm() }
    rt.rerender = render
    render()
    return { get h() { return latest } }
  }
  const notifyEl = (m: ReturnType<typeof mount>) =>
    (m.h.element as ReactElement<{ children: ReactElement[] }>).props.children[1] as ReactElement<any>

  it('★★★ 2回続けて呼ぶ → 先の題が出る → OK で先が解決 → 次の題が出る → OK で次も解決。出ていないときは何も描かない', async () => {
    const m = mount()
    expect(notifyEl(m).props.open).toBe(false)
    const done: string[] = []
    const a = m.h.notify({ title: '先', body: '先の本文' }).then(() => done.push('先'))
    const b = m.h.notify({ title: '後', body: '後の本文' }).then(() => done.push('後'))
    expect(notifyEl(m).type).toBe(NotifyModal)
    expect(notifyEl(m).props).toMatchObject({ open: true, title: '先', body: '先の本文' })
    notifyEl(m).props.onClose()
    await a
    expect(done).toEqual(['先'])
    expect(notifyEl(m).props).toMatchObject({ open: true, title: '後', body: '後の本文' })
    notifyEl(m).props.onClose()
    await b
    expect(done).toEqual(['先', '後'])
    expect(notifyEl(m).props.open).toBe(false)
  })

  it('★★ NotifyModal は alertdialog の Modal。ボタンは OK の1つだけ・本文は select-text。Esc も OK と同じ（閉じるだけ）', () => {
    let closed = 0
    const shown = NotifyModal({ open: true, title: 't', body: 'b', onClose: () => { closed++ } }) as ReactElement<any>
    expect(shown.type).toBe(Modal)
    expect(shown.props.role).toBe('alertdialog')
    const kids = shown.props.children as ReactElement<any>[]
    expect(kids[1].props.className).toContain('select-text')
    const buttons = (kids[2].props.children as ReactElement<any>)
    expect(buttons.props.children).toBe('OK')
    shown.props.onRequestClose('escape')
    expect(closed).toBe(1)
    expect(NotifyModal({ open: false, title: 't', body: 'b', onClose: () => {} })).toBeNull()
  })
})

describe('useConfirmChoices の confirm は pending が1つ（記録: 続けて2回呼ぶと先は解決されない）', () => {
  it('★★ 先の Promise は解決されないまま、後のものだけが答えを受ける。直すとここが落ちるので、useConfirm の notify と同じ作りへ直すこと', async () => {
    rt.slots = []
    let latest!: ReturnType<typeof useConfirmChoices>
    const render = () => { rt.i = 0; latest = useConfirmChoices() }
    rt.rerender = render
    render()
    let firstSettled = false
    latest.confirm({ title: '1', body: '1' }).then(() => { firstSettled = true })
    const second = latest.confirm({ title: '2', body: '2' })
    const el = latest.element as ReactElement<any>
    expect(el.props.title).toBe('2')
    el.props.onConfirm()
    expect(await second).toBe(true)
    await new Promise(r => setTimeout(r, 0))
    expect(firstSettled).toBe(false)
  })
})
