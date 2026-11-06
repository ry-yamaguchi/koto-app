import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  TABBABLE_SELECTOR,
  collectTabbables,
  planTab,
  shouldHandleEscape,
  tabDirection,
} from '../src/renderer/ui/modalKeys'

// ── 窓が受けるキーの判定（純関数）──────────────────────────────────
// Esc は最前面の窓だけが受ける。ただし日本語入力の変換中の Esc（変換の取り消し）と、窓の中の部品がすでに
// 受けた Esc（名前編集の取り消しなど）で、窓まで一緒に閉じてはいけない。

describe('Esc を窓が受けてよいか', () => {
  it('ふつうの Esc は受ける', () => {
    expect(shouldHandleEscape({ key: 'Escape' })).toBe(true)
    expect(shouldHandleEscape({ key: 'Escape', isComposing: false, defaultPrevented: false })).toBe(true)
  })

  it('Esc 以外のキーは受けない', () => {
    for (const key of ['Enter', 'Tab', 'a', ' ', 'Backspace']) {
      expect(shouldHandleEscape({ key })).toBe(false)
    }
  })

  // 変換を取り消す Esc で窓が閉じると、入力中の文字ごと失う
  it('変換中の Esc は受けない（isComposing も keyCode 229 も）', () => {
    expect(shouldHandleEscape({ key: 'Escape', isComposing: true })).toBe(false)
    expect(shouldHandleEscape({ key: 'Escape', keyCode: 229 })).toBe(false)
  })

  it('中の部品がすでに受けた Esc（defaultPrevented）は受けない', () => {
    expect(shouldHandleEscape({ key: 'Escape', defaultPrevented: true })).toBe(false)
  })
})

describe('Tab を窓が受けてよいか・向き', () => {
  it('Tab は前向き、Shift+Tab は後ろ向き', () => {
    expect(tabDirection({ key: 'Tab' })).toBe('forward')
    expect(tabDirection({ key: 'Tab', shiftKey: false })).toBe('forward')
    expect(tabDirection({ key: 'Tab', shiftKey: true })).toBe('backward')
  })

  it('Tab 以外は受けない', () => {
    expect(tabDirection({ key: 'Escape' })).toBe(null)
    expect(tabDirection({ key: 'Enter', shiftKey: true })).toBe(null)
  })

  it('修飾キー（Ctrl・Alt・⌘）付きは受けない', () => {
    expect(tabDirection({ key: 'Tab', ctrlKey: true })).toBe(null)
    expect(tabDirection({ key: 'Tab', altKey: true })).toBe(null)
    expect(tabDirection({ key: 'Tab', metaKey: true })).toBe(null)
  })

  it('変換中と、中の部品がすでに受けた Tab は受けない', () => {
    expect(tabDirection({ key: 'Tab', isComposing: true })).toBe(null)
    expect(tabDirection({ key: 'Tab', keyCode: 229 })).toBe(null)
    expect(tabDirection({ key: 'Tab', defaultPrevented: true })).toBe(null)
  })
})

describe('Tab の動かし方（端・外・0個）', () => {
  it('止まる要素が1つも無いときは、動かさず枠にとどめる（前向きも後ろ向きも）', () => {
    expect(planTab(0, -1, false)).toEqual({ kind: 'hold' })
    expect(planTab(0, -1, true)).toEqual({ kind: 'hold' })
    expect(planTab(0, 0, false)).toEqual({ kind: 'hold' })
  })

  it('枠の外（または枠自身・並びに無い要素）にあれば、先頭（Shift なら末尾）へ戻す', () => {
    expect(planTab(3, -1, false)).toEqual({ kind: 'focus', index: 0 })
    expect(planTab(3, -1, true)).toEqual({ kind: 'focus', index: 2 })
    // 並びの外を指す番号も「外」と同じに扱う
    expect(planTab(3, 3, false)).toEqual({ kind: 'focus', index: 0 })
    expect(planTab(3, 7, true)).toEqual({ kind: 'focus', index: 2 })
  })

  it('末尾で前へ進むと先頭へ、先頭で後ろへ進むと末尾へ一周する', () => {
    expect(planTab(3, 2, false)).toEqual({ kind: 'focus', index: 0 })
    expect(planTab(3, 0, true)).toEqual({ kind: 'focus', index: 2 })
  })

  it('途中と、端でも内向きの動きはブラウザに任せる', () => {
    expect(planTab(3, 1, false)).toEqual({ kind: 'native' })
    expect(planTab(3, 1, true)).toEqual({ kind: 'native' })
    expect(planTab(3, 0, false)).toEqual({ kind: 'native' })
    expect(planTab(3, 2, true)).toEqual({ kind: 'native' })
  })

  it('要素が1つだけなら、どちら向きでもその1つに留まる', () => {
    expect(planTab(1, 0, false)).toEqual({ kind: 'focus', index: 0 })
    expect(planTab(1, 0, true)).toEqual({ kind: 'focus', index: 0 })
    expect(planTab(1, -1, false)).toEqual({ kind: 'focus', index: 0 })
    expect(planTab(1, -1, true)).toEqual({ kind: 'focus', index: 0 })
  })
})

describe('枠の中で Tab が止まる要素を集める', () => {
  const el = (name: string, extra: Record<string, unknown> = {}) => ({ name, focus() {}, ...extra })

  it('selector は書き下した形で渡す（無効・隠し・tabindex=-1 は含めない）', () => {
    const asked: string[] = []
    const root = { querySelectorAll: (s: string) => { asked.push(s); return [] } }
    collectTabbables(root)
    expect(asked).toEqual([TABBABLE_SELECTOR])
    for (const piece of [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
    ]) {
      expect(TABBABLE_SELECTOR.split(', ')).toContain(piece)
    }
  })

  it('文書の順を保ち、無効・隠し・見えない（描かれていない）要素を除く', () => {
    const a = el('a')
    const disabled = el('disabled', { disabled: true })
    const hidden = el('hidden', { hidden: true })
    const invisible = el('invisible', { getClientRects: () => ({ length: 0 }) })
    const visible = el('visible', { getClientRects: () => ({ length: 1 }) })
    const root = { querySelectorAll: () => [a, disabled, hidden, invisible, visible] }
    expect(collectTabbables(root).map(t => (t as unknown as { name: string }).name)).toEqual(['a', 'visible'])
  })

  it('見えるかを調べられない要素（getClientRects が無い環境）は、見えているとみなす', () => {
    const a = el('a')
    expect(collectTabbables({ querySelectorAll: () => [a] })).toEqual([a])
  })
})

// 変換中の判定は keyInput.ts の isComposing だけが持つ。ここで複製すると、片方だけ直されて抜ける
describe('変換中の判定は keyInput.ts のものを使う', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/modalKeys.ts'), 'utf8')

  it('isComposing を取り込み、生のイベントをそのまま渡す', () => {
    expect(src).toContain("import { isComposing } from '../keyInput'")
    expect(src).toContain('isComposing({ key: e.key, nativeEvent: e, keyCode: e.keyCode })')
  })

  it('keyCode 229 の自前の判定を書かない', () => {
    expect(src).not.toContain('229')
  })
})
