import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ── ようこその窓の枠（ui/Modal）──────────────────────────────────────────
// 1) 振る舞い: 本物の OnboardingModal を react の小さな代役の上で描き、窓へ渡った onRequestClose（Esc・背景クリック相当）を呼んでも onClose は動かず、
//    「キャンセル」のボタンだけが onClose を呼ぶ。画面の枚が替わったら、その枚の初期フォーカスの印へフォーカスが移る。
// 2) ソース: 外枠は Modal・見出しの id が結ばれ・3枚目の入力欄が初期フォーカスの印を持つ。古い外枠は禁止。

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  effects: [] as { fn: () => void | (() => void); deps: unknown[] | undefined }[],
  index: 0,
  rendered: [] as { type: unknown; props: any }[],
}))
vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = hooks.index++
    if (hooks.states.length <= i) hooks.states.push(init)
    return [hooks.states[i], (v: unknown) => { hooks.states[i] = v }]
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[] | undefined) => { hooks.effects.push({ fn, deps }) },
  useRef: (v: unknown) => ({ current: v }),
  default: {},
}))
vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: any) => { hooks.rendered.push({ type, props }); return null }
  return { jsx, jsxs: jsx, Fragment: () => null }
})
vi.mock('react/jsx-dev-runtime', () => {
  const jsxDEV = (type: unknown, props: any) => { hooks.rendered.push({ type, props }); return null }
  return { jsxDEV, Fragment: () => null }
})

import OnboardingModal, { focusStepStart } from '../src/renderer/components/OnboardingModal'
import Modal from '../src/renderer/ui/Modal'

const calls: string[] = []
function render() {
  hooks.index = 0; hooks.effects.length = 0; hooks.rendered.length = 0
  OnboardingModal({
    onSetApiKey: () => { calls.push('setKey') },
    onClose: () => { calls.push('onClose') },
    onCreateProject: () => { calls.push('create') },
    onOpenCredentials: () => { calls.push('credentials') },
  })
}
const modalProps = () => hooks.rendered.find(r => r.type === Modal)!.props
beforeEach(() => { calls.length = 0; hooks.states.length = 0; render() })

describe('ようこその窓: Esc でも背景クリックでも閉じない', () => {
  it('★★★ 窓へ渡った閉じる依頼（Esc・背景）を呼んでも onClose には何も起きない。「キャンセル」だけが onClose を呼ぶ', () => {
    modalProps().onRequestClose('escape')
    modalProps().onRequestClose('backdrop')
    expect(calls).toEqual([])
    hooks.rendered.find(r => r.type === 'button')!.props.onClick()
    expect(calls).toEqual(['onClose'])
  })
})

describe('ようこその窓: 枚が替わったときのフォーカス', () => {
  const target = (log: string[], name: string) => ({ focus() { log.push(name) } })
  const title = (frame: unknown) => ({ closest: (sel: string) => (sel === '[role="dialog"]' ? frame : null) })

  it('★★★ 枠の中の初期フォーカスの印（data-autofocus）へ移る。印が無ければ枠へ', () => {
    const log: string[] = []
    const input = target(log, 'input')
    focusStepStart(title({ querySelectorAll: () => [input], focus: () => log.push('frame'), isConnected: true }))
    expect(log).toEqual(['input'])
    log.length = 0
    focusStepStart(title({ querySelectorAll: () => [], focus: () => log.push('frame'), isConnected: true }))
    expect(log).toEqual(['frame'])
    focusStepStart(null)
    expect(log).toEqual(['frame'])
  })

  it('★★★ 枚（step）が替わるたびに動く効果が、見出しから枠をたどって移す（1枚目・3枚目の描画で押すボタンも入力欄も印つき）', () => {
    const log: string[] = []
    const frame = { querySelectorAll: (sel: string) => { log.push(sel); return [] }, focus: () => log.push('frame'), isConnected: true }
    ;(globalThis as any).document = { getElementById: (id: string) => (id === 'onboarding-title' ? title(frame) : null) }
    const effect = hooks.effects[0]
    expect(effect.deps).toEqual([1])
    effect.fn()
    expect(log).toEqual(['[data-autofocus]', 'frame'])
    hooks.states[0] = 3; render()
    expect(hooks.effects[0].deps).toEqual([3])
    const input = hooks.rendered.find(r => r.type === 'input')!.props
    expect(input).toHaveProperty('data-autofocus', true)
    expect(input.autoFocus).toBeUndefined()
    delete (globalThis as any).document
  })
})

const src = fs.readFileSync(path.join(__dirname, '../src/renderer/components/OnboardingModal.tsx'), 'utf8')

describe('OnboardingModal.tsx: 外枠は Modal', () => {
  it('★★★ Modal に閉じない処理を渡し、見出しの id を3枚とも結ぶ', () => {
    expect(src).toContain("import Modal, { pickInitialFocus } from '../ui/Modal'")
    expect(src).toContain('      onRequestClose={ignoreCloseRequest}\n    >')
    expect(src).toContain('    </Modal>\n  )\n}')
    expect(src.match(/<h2 id=\{ONBOARDING_TITLE_ID\}/g)?.length).toBe(3)
  })

  it('★★ 閉じる経路は「キャンセル」「保存して閉じる」だけで、Modal の閉じる依頼から onClose を呼ばない', () => {
    expect(src).not.toMatch(/onRequestClose=\{[^}]*onClose/)
    expect(src).toContain('export function ignoreCloseRequest(): void {}')
  })

  it('★★ 3枚目の APIキー入力欄が初期フォーカスの印を持つ', () => {
    expect(src).toContain('placeholder="発行したAPIキーを貼り付け"\n              data-autofocus\n              className=')
    expect(src).not.toContain('autoFocus')
    expect(src).toContain("useEffect(() => { focusStepStart(document.getElementById(ONBOARDING_TITLE_ID)) }, [step])")
  })

  it('★★ 古い外枠（自前の fixed inset-0 の背景）は残さない', () => {
    expect(src).not.toContain('<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">')
    expect(src).not.toContain('fixed inset-0')
  })
})
