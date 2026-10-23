import { describe, it, expect, vi } from 'vitest'
import type { ReactElement } from 'react'

// ── 段階2（2b-1）: 選択（チェック）つきの確認 ──────────────────────────────────────────────────────────
// 設計書 docs/teardown-unify-plan.md の 10.7.7 (1)・10.7.12「選択つきの確認」・10.7.14 の 1。
//   ・resolveConfirmWithChoices … 押したボタンとチェックの状態から答えを作る純関数。やめるは { confirmed:false, choices:{} }。
//     値が無い（undefined）ときだけ defaultChecked、boolean ならそのまま、**ほかの値は false**（不明な値を「消す」に倒さない）
//   ・useConfirmChoices        … 選択の無い確認（confirm）と選択つきの確認（confirmWithChoices）を1つの ConfirmModal で出す。
//                                React の useState・useCallback だけをこの試験用の小さな実装に差し替えて、フックをそのまま呼ぶ
//   ・ConfirmModal             … 任意の props（choices・choiceValues・onToggleChoice）で本文とボタンの間にチェック欄を描く。
//                                無いときは今までの確認と同じ（チェック欄が出ない）

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

import { resolveConfirmWithChoices, choiceValueOf, useConfirmChoices, type ConfirmChoice } from '../src/renderer/useConfirmChoices'
import ConfirmModal from '../src/renderer/components/ConfirmModal'

const REG_ON: ConfirmChoice = { id: 'deleteRegistry', label: 'コンテナレジストリを削除する', defaultChecked: true }
const REG_OFF: ConfirmChoice = { id: 'deleteRegistry', label: 'コンテナレジストリを削除する', defaultChecked: false }
const OTHER: ConfirmChoice = { id: 'other', label: 'もう1つ', defaultChecked: false }

describe('resolveConfirmWithChoices: 押したボタンとチェックの状態から答えを作る（純関数）', () => {
  it('★★★ やめる（cancel）は { confirmed:false, choices:{} }。チェックがどうなっていても true にならない', () => {
    expect(resolveConfirmWithChoices('cancel', [REG_ON], {})).toEqual({ confirmed: false, choices: {} })
    expect(resolveConfirmWithChoices('cancel', [REG_ON], { deleteRegistry: true })).toEqual({ confirmed: false, choices: {} })
    expect(resolveConfirmWithChoices('cancel', [], {})).toEqual({ confirmed: false, choices: {} })
  })

  it('★★ 実行（confirm）: boolean ならそのまま', () => {
    expect(resolveConfirmWithChoices('confirm', [REG_ON], { deleteRegistry: false })).toEqual({ confirmed: true, choices: { deleteRegistry: false } })
    expect(resolveConfirmWithChoices('confirm', [REG_OFF], { deleteRegistry: true })).toEqual({ confirmed: true, choices: { deleteRegistry: true } })
  })

  it('★★ 実行（confirm）: 値が無い（触っていない）ときだけ defaultChecked。明示された undefined も「触っていない」', () => {
    expect(resolveConfirmWithChoices('confirm', [REG_ON], {})).toEqual({ confirmed: true, choices: { deleteRegistry: true } })
    expect(resolveConfirmWithChoices('confirm', [REG_OFF], {})).toEqual({ confirmed: true, choices: { deleteRegistry: false } })
    expect(resolveConfirmWithChoices('confirm', [REG_ON], { deleteRegistry: undefined })).toEqual({ confirmed: true, choices: { deleteRegistry: true } })
  })

  it.each([['yes'], ['true'], [1], [0], [''], [null], [{}], [[]]])(
    '★★★ 実行（confirm）: boolean でない値（%j）は false。defaultChecked が true の選択（Koto が作ったレジストリ）でも「消す」に倒さない', (v) => {
      expect(resolveConfirmWithChoices('confirm', [REG_ON], { deleteRegistry: v })).toEqual({ confirmed: true, choices: { deleteRegistry: false } })
      expect(resolveConfirmWithChoices('confirm', [REG_OFF], { deleteRegistry: v })).toEqual({ confirmed: true, choices: { deleteRegistry: false } })
    })

  it('選択が複数なら id ごとに決まる。選択に無い id の値は答えに入らない。値の無い id は defaultChecked', () => {
    const r = resolveConfirmWithChoices('confirm', [REG_ON, OTHER], { other: true, stranger: true })
    expect(r).toEqual({ confirmed: true, choices: { deleteRegistry: true, other: true } })
  })

  it('値の入れ物が持つ Object.prototype 由来の名前（toString・constructor）を、触った値と読まない', () => {
    const toStr: ConfirmChoice = { id: 'toString', label: 'x', defaultChecked: true }
    const ctor: ConfirmChoice = { id: 'constructor', label: 'y', defaultChecked: false }
    expect(resolveConfirmWithChoices('confirm', [toStr, ctor], {})).toEqual({ confirmed: true, choices: { toString: true, constructor: false } })
  })

  it('choiceValueOf: 画面に出すいまの値も、答えと同じ規則（二重に書かない）', () => {
    expect(choiceValueOf(REG_ON, {})).toBe(true)
    expect(choiceValueOf(REG_ON, { deleteRegistry: false })).toBe(false)
    expect(choiceValueOf(REG_ON, { deleteRegistry: 'yes' })).toBe(false)
    expect(choiceValueOf(REG_OFF, { deleteRegistry: true })).toBe(true)
    expect(choiceValueOf(REG_OFF, {})).toBe(false)
  })
})

// ── ConfirmModal の描画（要素の木を直接見る。DOM は使わない）──────────────────────────────────────────

function findAll(node: unknown, pred: (n: ReactElement & { props: any }) => boolean, out: Array<ReactElement & { props: any }> = []): Array<ReactElement & { props: any }> {
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out }
  if (!node || typeof node !== 'object') return out
  const el = node as ReactElement & { props: any }
  if (el.props === undefined) return out
  if (pred(el)) out.push(el)
  findAll(el.props.children, pred, out)
  return out
}
const textOf = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node && typeof node === 'object' && (node as any).props) return textOf((node as any).props.children)
  return ''
}
const render = (over: Record<string, unknown> = {}) => ConfirmModal({ open: true, title: 'T', body: 'B', onConfirm: () => {}, onCancel: () => {}, ...over } as any) as ReactElement
const checkboxes = (el: ReactElement) => findAll(el, n => n.type === 'input' && (n.props as any).type === 'checkbox')

describe('ConfirmModal: 任意のチェック欄（choices）', () => {
  it('★ choices が無い・空なら、チェック欄を描かない。要素の木も今までの確認と同じ（空の枠も足さない）', () => {
    expect(checkboxes(render())).toHaveLength(0)
    expect(checkboxes(render({ choices: [] }))).toHaveLength(0)
    // 描かないものは false（長さ0の && の結果）か undefined。React はどちらも何も描かないので、同じものとして比べる。
    const asJson = (el: ReactElement) => JSON.stringify(el, (_k, v) => (typeof v === 'function' ? undefined : v === false ? null : v))
    expect(asJson(render({ choices: [] }))).toBe(asJson(render()))
    expect(asJson(render({ choices: undefined, choiceValues: {} }))).toBe(asJson(render()))
  })

  it('★ choices があれば、本文とボタンの間にチェック欄を描く。値は choiceValues、無い id は defaultChecked', () => {
    const el = render({ choices: [REG_ON, OTHER], choiceValues: { other: true } })
    const boxes = checkboxes(el)
    expect(boxes.map(b => b.props.checked)).toEqual([true, true]) // deleteRegistry は defaultChecked(true)、other は choiceValues(true)
    const off = checkboxes(render({ choices: [REG_ON], choiceValues: { deleteRegistry: false } }))
    expect(off[0].props.checked).toBe(false)
    // 本文（select-text の段落）→ チェック欄 → ボタン の順
    const html = JSON.stringify(el, (_k, v) => (typeof v === 'function' ? undefined : v))
    expect(html.indexOf('select-text')).toBeLessThan(html.indexOf('checkbox'))
    expect(html.indexOf('checkbox')).toBeLessThan(html.indexOf('やめる'))
  })

  it('★★ チェックを動かすと onToggleChoice(id, 入れたか) が呼ばれる', () => {
    const toggled: Array<[string, boolean]> = []
    const el = render({ choices: [REG_ON], onToggleChoice: (id: string, c: boolean) => toggled.push([id, c]) })
    checkboxes(el)[0].props.onChange({ target: { checked: false } })
    checkboxes(el)[0].props.onChange({ target: { checked: true } })
    expect(toggled).toEqual([['deleteRegistry', false], ['deleteRegistry', true]])
  })

  it('★ note（赤い注意）はあるときだけ出し、help は状態に合う側の文を出す', () => {
    const withNote: ConfirmChoice = { ...REG_OFF, note: '借り物の断り', help: { checked: '消します', unchecked: '残します' } }
    const t = (v: boolean) => textOf(render({ choices: [withNote], choiceValues: { deleteRegistry: v } }))
    expect(t(false)).toContain('⚠️ 借り物の断り')
    expect(t(false)).toContain('残します')
    expect(t(false)).not.toContain('消します')
    expect(t(true)).toContain('消します')
    expect(t(true)).not.toContain('残します')
    const plain = textOf(render({ choices: [REG_OFF] }))
    expect(plain).not.toContain('⚠️')
  })

  // 今のチェックの状態の側の説明が空の文字列なら、説明の段落を出さない（チェックの名前の言い直しになる説明は、呼び手が空にする。空の段落を残さない）
  it('★★ help は、今の状態の側が空の文字列なら描かない（もう片方の側は描く）', () => {
    const emptyWhenOff: ConfirmChoice = { ...REG_OFF, help: { checked: '消します', unchecked: '' } }
    const paragraphs = (v: boolean) => findAll(render({ choices: [emptyWhenOff], choiceValues: { deleteRegistry: v } }), n => n.type === 'p' && String((n.props as any).className).includes('pl-6'))
    expect(paragraphs(false)).toHaveLength(0)
    expect(paragraphs(true).map(textOf)).toEqual(['消します'])
    // note（赤い注意）は help が空でも出る
    const withNote: ConfirmChoice = { ...emptyWhenOff, note: '借り物の断り' }
    expect(findAll(render({ choices: [withNote], choiceValues: { deleteRegistry: false } }), n => n.type === 'p' && String((n.props as any).className).includes('pl-6')).map(textOf)).toEqual(['⚠️ 借り物の断り'])
  })

  it('open=false のときは何も描かない（チェック欄があっても）', () => {
    expect(render({ open: false, choices: [REG_ON] })).toBeNull()
  })
})

// ── フック ─────────────────────────────────────────────────────────────────────────────────────

function mount() {
  rt.slots = []
  let latest!: ReturnType<typeof useConfirmChoices>
  const render = () => { rt.i = 0; latest = useConfirmChoices() }
  rt.rerender = render
  render()
  return {
    get h() { return latest },
    get props() { return (latest.element as any).props },
  }
}

describe('useConfirmChoices: 選択の無い確認と選択つきの確認を1つの ConfirmModal で出す', () => {
  it('★ 最初は閉じている', () => {
    const m = mount()
    expect(m.props.open).toBe(false)
  })

  it('★★ confirm（選択なし）: 開く → 実行で true／やめるで false。チェック欄は出ない', async () => {
    const m = mount()
    const p = m.h.confirm({ title: '見出し', body: '本文', confirmLabel: '実行', danger: true })
    expect(m.props.open).toBe(true)
    expect(m.props).toMatchObject({ title: '見出し', body: '本文', confirmLabel: '実行', danger: true })
    expect(m.props.choices).toEqual([])
    m.props.onConfirm()
    expect(await p).toBe(true)
    expect(m.props.open).toBe(false)

    const q = m.h.confirm({ title: 'x', body: 'y' })
    m.props.onCancel()
    expect(await q).toBe(false)
  })

  it('★★★ confirmWithChoices: 触らずに実行すれば defaultChecked の答え。画面に出る値も同じ', async () => {
    const m = mount()
    const p = m.h.confirmWithChoices({ title: 't', body: 'b', danger: true, choices: [REG_ON, OTHER] })
    expect(m.props.open).toBe(true)
    expect(m.props.choices).toEqual([REG_ON, OTHER])
    expect(m.props.choiceValues).toEqual({ deleteRegistry: true, other: false })
    m.props.onConfirm()
    expect(await p).toEqual({ confirmed: true, choices: { deleteRegistry: true, other: false } })
    expect(m.props.open).toBe(false)
  })

  it('★★★ チェックを動かして実行すれば、動かした値が答えになる。画面に出る値も追従する', async () => {
    const m = mount()
    const p = m.h.confirmWithChoices({ title: 't', body: 'b', choices: [REG_ON, OTHER] })
    m.props.onToggleChoice('deleteRegistry', false)
    m.props.onToggleChoice('other', true)
    expect(m.props.choiceValues).toEqual({ deleteRegistry: false, other: true })
    m.props.onConfirm()
    expect(await p).toEqual({ confirmed: true, choices: { deleteRegistry: false, other: true } })
  })

  it('★★★ チェックを動かしても、やめるは { confirmed:false, choices:{} }', async () => {
    const m = mount()
    const p = m.h.confirmWithChoices({ title: 't', body: 'b', choices: [REG_OFF] })
    m.props.onToggleChoice('deleteRegistry', true)
    m.props.onCancel()
    expect(await p).toEqual({ confirmed: false, choices: {} })
  })

  it('★★ 次の確認は、前の確認で動かした値を引き継がない（defaultChecked から始まる）', async () => {
    const m = mount()
    const first = m.h.confirmWithChoices({ title: 't', body: 'b', choices: [REG_ON] })
    m.props.onToggleChoice('deleteRegistry', false)
    m.props.onConfirm()
    await first
    const second = m.h.confirmWithChoices({ title: 't2', body: 'b2', choices: [REG_ON] })
    expect(m.props.choiceValues).toEqual({ deleteRegistry: true })
    m.props.onConfirm()
    expect(await second).toEqual({ confirmed: true, choices: { deleteRegistry: true } })
  })

  it('開いていないとき動かしても何も起きない（閉じたあとに届く古い操作で、確認が勝手に開かない）', () => {
    const m = mount()
    m.props.onToggleChoice('deleteRegistry', true)
    expect(m.props.open).toBe(false)
  })
})
