import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── Modal と ConfirmModal の表示（本物の React で HTML にする）─────────────────────────────────────
// フックを差し替えずに renderToStaticMarkup で描く（effect は回らない）。見るのは読み上げの印と構造:
//   ・role（通常 dialog・確認は alertdialog）・aria-modal="true"
//   ・aria-labelledby が見出しの id と、aria-describedby が本文の id と一致している
//   ・open=false は空
//   ・「背景 div > 枠 div」の2段（小さな描画器の試験が背景の div を探す）
//   ・長い本文のための max-h-[90vh] overflow-y-auto。見た目（幅・背景の濃さ・赤枠）は今のまま
//   ・初期フォーカスの印 data-autofocus がどのボタンに付くか
//   ・重なりの深さが z-index に出る（manager が数えた次の深さ。深さ0は今の 50）
// 押す・Esc・フォーカスの動きは tests/modalComponent.test.ts と tests/confirmChoices.test.ts が見る。

const rt = vi.hoisted(() => ({ nextDepth: 0 }))

vi.mock('../src/renderer/ui/modalManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/ui/modalManager')>()
  return { ...real, getModalManager: () => ({ open: () => ({ depth: 0, close() {} }), nextDepth: () => rt.nextDepth, size: () => rt.nextDepth }) }
})

import Modal from '../src/renderer/ui/Modal'
import ConfirmModal from '../src/renderer/components/ConfirmModal'

beforeEach(() => { rt.nextDepth = 0 })

const modal = (over: Record<string, unknown> = {}, ...children: unknown[]) =>
  renderToStaticMarkup(createElement(Modal as any, { onRequestClose: () => {}, labelledBy: 'my-title', backdropClassName: 'bg-black/50', panelClassName: 'w-96', ...over }, ...children))

const confirmHtml = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ConfirmModal as any, { open: true, title: '見出し', body: '本文です', onConfirm: () => {}, onCancel: () => {}, ...over }))

describe('Modal: 読み上げの印と2段の構造', () => {
  it('★★★ 既定は role="dialog"・aria-modal="true"・aria-labelledby は呼び側の id。説明の id が無ければ aria-describedby は付けない', () => {
    const h = modal({}, createElement('h2', { id: 'my-title' }, '設定'))
    expect(h).toContain('role="dialog"')
    expect(h).toContain('aria-modal="true"')
    expect(h).toContain('aria-labelledby="my-title"')
    expect(h).not.toContain('aria-describedby')
    expect(h).toContain('<h2 id="my-title">設定</h2>')
  })

  it('★★ role="alertdialog" と aria-describedby を渡せる', () => {
    const h = modal({ role: 'alertdialog', describedBy: 'my-body' })
    expect(h).toContain('role="alertdialog"')
    expect(h).not.toContain('role="dialog"')
    expect(h).toContain('aria-describedby="my-body"')
  })

  it('★★★ 背景の div の中に枠の div が1つ（2段）。背景は fixed inset-0 で中央寄せ、枠が role・aria・tabindex=-1 を持つ', () => {
    const h = modal({}, createElement('p', null, 'x'))
    const m = h.match(/^<div class="([^"]*)" style="z-index:50"><div ([^>]*)><p>x<\/p><\/div><\/div>$/)
    expect(m).not.toBeNull()
    const [, backdropClass, frameAttrs] = m!
    expect(backdropClass).toBe('fixed inset-0 flex items-center justify-center bg-black/50')
    expect(frameAttrs).toContain('role="dialog"')
    expect(frameAttrs).toContain('aria-modal="true"')
    expect(frameAttrs).toContain('tabindex="-1"')
    expect(h.match(/fixed inset-0/g)).toHaveLength(1)
  })

  it('★★ 枠は呼び側の class に、長い本文のための max-h-[90vh] overflow-y-auto を足す（幅などは呼び側のまま）', () => {
    const h = modal({ panelClassName: 'w-[460px] bg-elevated' })
    expect(h).toMatch(/<div role="dialog"[^>]*class="w-\[460px\] bg-elevated max-h-\[90vh\] overflow-y-auto focus:outline-none"/)
  })

  it('★★★ 重なり: 描き始めの z-index は「次の深さ」。深さ0は 50、1つ重なるごとに 10 上がる（スタックを見る）', () => {
    expect(modal()).toContain('style="z-index:50"')
    rt.nextDepth = 1
    expect(modal()).toContain('style="z-index:60"')
    rt.nextDepth = 3
    expect(modal()).toContain('style="z-index:80"')
  })
})

describe('ConfirmModal: Modal の上に載った確認（alertdialog）', () => {
  it('★★★ open=false は空（何も描かない）', () => {
    expect(confirmHtml({ open: false })).toBe('')
  })

  it('★★★ role="alertdialog"・aria-modal="true"。aria-labelledby は見出しの id、aria-describedby は本文の id と一致する', () => {
    const h = confirmHtml({ title: '会話を削除します', body: '元に戻せません。' })
    expect(h).toContain('role="alertdialog"')
    expect(h).toContain('aria-modal="true"')
    const labelledBy = h.match(/aria-labelledby="([^"]+)"/)![1]
    const describedBy = h.match(/aria-describedby="([^"]+)"/)![1]
    expect(labelledBy).not.toBe(describedBy)
    expect(h).toContain(`<p id="${labelledBy}" class="text-sm font-semibold text-ink">会話を削除します</p>`)
    expect(h).toMatch(new RegExp(`<p id="${describedBy}"[^>]*>元に戻せません。</p>`))
  })

  it('★★ danger のときは見出しの先頭に ⚠️ が付いても、aria-labelledby の指す要素は見出しのまま', () => {
    const h = confirmHtml({ danger: true, title: '消します' })
    const labelledBy = h.match(/aria-labelledby="([^"]+)"/)![1]
    expect(h).toContain(`<p id="${labelledBy}" class="text-sm font-semibold text-ink">⚠️ 消します</p>`)
  })

  it('★★★ 構造は「背景 div > 枠 div」の2段のまま。見た目（背景の濃さ・幅・角・色・余白）は変えない', () => {
    const h = confirmHtml()
    expect(h).toMatch(/^<div class="fixed inset-0 flex items-center justify-center bg-black\/30 p-4" style="z-index:50"><div role="alertdialog"/)
    expect(h).toContain('class="w-full max-w-md rounded-xl border border-line bg-surface p-4 space-y-3 max-h-[90vh] overflow-y-auto focus:outline-none"')
    expect(confirmHtml({ danger: true })).toContain('class="w-full max-w-md rounded-xl border border-brand-red/70 bg-surface p-4 space-y-3 max-h-[90vh] overflow-y-auto focus:outline-none"')
    expect(h.match(/fixed inset-0/g)).toHaveLength(1)
  })

  it('★★ 確認が別の窓に重なって開くと、深さの分だけ z-index が上がる（親の窓の上に出る）', () => {
    rt.nextDepth = 1
    expect(confirmHtml()).toContain('style="z-index:60"')
  })
})

describe('ConfirmModal: 最初にフォーカスするボタン（data-autofocus）', () => {
  const autofocusButton = (h: string) => {
    const hits = [...h.matchAll(/<button[^>]*data-autofocus="true"[^>]*>([^<]*)<\/button>/g)]
    return hits.map(m => m[1])
  }

  it('★★★ 赤くない確認は「実行」（押す側）に付く。ボタンはちょうど1つ', () => {
    expect(autofocusButton(confirmHtml({ confirmLabel: '移動する' }))).toEqual(['移動する'])
  })

  it('★★★ 赤い確認（danger）は「キャンセル」に付く。実行には付かない', () => {
    expect(autofocusButton(confirmHtml({ danger: true, confirmLabel: '削除する' }))).toEqual(['キャンセル'])
    expect(autofocusButton(confirmHtml({ danger: true, cancelLabel: '戻る', confirmLabel: '削除する' }))).toEqual(['戻る'])
  })

  it('★★★ initialFocus: \'cancel\'（お金に触れる赤くない確認）は「キャンセル」に付く', () => {
    expect(autofocusButton(confirmHtml({ danger: false, initialFocus: 'cancel', confirmLabel: '公開する' }))).toEqual(['キャンセル'])
  })

  it('★★★ 赤い確認は、呼び側が initialFocus: \'confirm\' と言っても「キャンセル」のまま（開いた直後の Return で消さない）', () => {
    expect(autofocusButton(confirmHtml({ danger: true, initialFocus: 'confirm', confirmLabel: '削除する' }))).toEqual(['キャンセル'])
  })

  it('赤くない確認で initialFocus: \'confirm\' を渡せば「実行」（何も言わないときと同じ）', () => {
    expect(autofocusButton(confirmHtml({ initialFocus: 'confirm', confirmLabel: '実行する' }))).toEqual(['実行する'])
  })
})
