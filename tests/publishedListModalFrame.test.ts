import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createModalManager } from '../src/renderer/ui/modalManager'

// ── 📡 公開したもの一覧の窓の枠（ui/Modal）──────────────────────────────────
// 1) 振る舞い: 本物の manager に窓を登録し、Esc で onClose が1回呼ばれる。
// 2) ソース: 外枠は Modal・✕ に aria-label・古い外枠（自前の fixed inset-0 の背景）は禁止。

class FakeDoc {
  activeElement: unknown = null
  body = { focus() {} }
  listeners: Array<(e: any) => void> = []
  addEventListener(_t: string, l: (e: any) => void) { this.listeners.push(l) }
  removeEventListener(_t: string, l: (e: any) => void) { this.listeners = this.listeners.filter(x => x !== l) }
  press(key: string) {
    const e: any = { key, defaultPrevented: false, preventDefault() { e.defaultPrevented = true } }
    for (const l of [...this.listeners]) l(e)
  }
}

describe('公開したもの一覧の窓: Esc で閉じる', () => {
  it('★★★ Esc で onClose が1回だけ呼ばれる', () => {
    const doc = new FakeDoc()
    const mgr = createModalManager(doc as any)
    const calls: string[] = []
    const frame = { querySelectorAll: () => [], focus() {}, isConnected: true }
    mgr.open({ frame: frame as any, onRequestClose: () => { calls.push('close') } })
    doc.press('Escape')
    expect(calls).toEqual(['close'])
  })
})

const src = fs.readFileSync(path.join(__dirname, '../src/renderer/components/PublishedListModal.tsx'), 'utf8')

describe('PublishedListModal.tsx: 外枠は Modal', () => {
  it('★★★ Modal に onClose を渡し、見出しの id を結ぶ', () => {
    expect(src).toContain("import Modal from '../ui/Modal'")
    expect(src).toContain('<Modal\n      onRequestClose={onClose} labelledBy="published-list-title"')
    expect(src).toContain('<h2 id="published-list-title"')
    expect(src).toContain('    </Modal>\n  )\n}')
  })

  it('★★ ✕ に aria-label="閉じる"・「閉じる」ボタンも同じ onClose', () => {
    expect(src).toContain('<button onClick={onClose} aria-label="閉じる" className="text-ink-muted')
    expect(src).toContain('<button onClick={onClose} className="text-xs border border-line rounded-lg px-3 py-1.5')
  })

  it('★★ 古い外枠（自前の背景で onClose を呼ぶ形）は残さない', () => {
    expect(src).not.toContain('<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>')
    expect(src).not.toContain('onClick={e => e.stopPropagation()}\n      >\n        <div className="flex items-center justify-between px-5 py-3')
  })
})
