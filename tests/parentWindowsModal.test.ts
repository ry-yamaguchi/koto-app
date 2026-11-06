import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createModalManager, modalZIndex } from '../src/renderer/ui/modalManager'

// ── 親の窓（設定・公開）の枠（ui/Modal）──────────────────────────────────────
// 1) 振る舞い: 設定と公開が重なったとき、前面は「あとに開いたほう」になる（JSX の並びではなく開いた順）。
//    Esc は最前面の1枚だけが受ける。
// 2) ソース: 外枠は Modal・✕ に aria-label・古い外枠は禁止。公開の Esc/背景の扱い・名前編集の Esc。

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

const frame = () => ({ querySelectorAll: () => [], focus() {}, isConnected: true })

describe('設定と公開が重なる: 前面は開いた順', () => {
  it('★★★ 設定 → 公開の順に開くと、公開が前面（z-index が大きい）。Esc は公開だけが閉じる', () => {
    const doc = new FakeDoc()
    const mgr = createModalManager(doc as any)
    const calls: string[] = []
    const settings = mgr.open({ frame: frame() as any, onRequestClose: () => { calls.push('settings') } })
    const publish = mgr.open({ frame: frame() as any, onRequestClose: () => { calls.push('publish') } })
    expect(modalZIndex(settings.depth)).toBe(50)
    expect(modalZIndex(publish.depth)).toBe(60)
    doc.press('Escape')
    expect(calls).toEqual(['publish'])
  })

  it('★★ 公開 → 設定の順に開くと、設定が前面（JSX で設定が先に書かれていても）', () => {
    const doc = new FakeDoc()
    const mgr = createModalManager(doc as any)
    const calls: string[] = []
    const publish = mgr.open({ frame: frame() as any, onRequestClose: () => { calls.push('publish') } })
    const settings = mgr.open({ frame: frame() as any, onRequestClose: () => { calls.push('settings') } })
    expect(modalZIndex(settings.depth)).toBeGreaterThan(modalZIndex(publish.depth))
    doc.press('Escape')
    expect(calls).toEqual(['settings'])
  })
})

const read = (f: string) => fs.readFileSync(path.join(__dirname, '../src/renderer/components', f), 'utf8')

describe('SettingsModal.tsx: 外枠は Modal', () => {
  const src = read('SettingsModal.tsx')
  it('★★★ Modal に onClose を渡し、見出しの id を結ぶ。確認の窓は枠の外の兄弟', () => {
    expect(src).toContain("import Modal from '../ui/Modal'")
    expect(src).toContain('<Modal\n        onRequestClose={onClose}\n        labelledBy="settings-modal-title"')
    expect(src).toContain('<h2 id="settings-modal-title"')
    expect(src).toContain('      </Modal>\n      {confirmElement}\n    </>\n  )\n}')
  })
  it('★★ ✕ に aria-label="閉じる"', () => {
    expect(src).toContain('<button onClick={onClose} aria-label="閉じる" className="ml-auto')
  })
  it('★★ 古い外枠（自前の背景・背景クリックで onClose）は残さない', () => {
    expect(src).not.toContain('className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"\n      onClick={onClose}')
    expect(src).not.toContain('onClick={e => e.stopPropagation()}')
  })
})

describe('PublishModal.tsx: 外枠は Modal', () => {
  const src = read('PublishModal.tsx')
  it('★★★ Esc は走っていても閉じ、背景クリックだけ走っている間は閉じない', () => {
    expect(src).toContain("const handleRequestClose = (reason: 'escape' | 'backdrop') => { if (reason === 'escape' || !opRunning) onClose() }")
    expect(src).toContain('<Modal\n      onRequestClose={handleRequestClose}\n      labelledBy="publish-modal-title"')
    expect(src).toContain('<h2 id="publish-modal-title"')
    expect(src).toContain('    </Modal>\n  )\n}')
  })
  it('★★ 古い外枠（自前の背景・handleBackdropClick）は残さない', () => {
    expect(src).not.toContain('handleBackdropClick')
    expect(src).not.toContain('<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"')
  })
})

describe('AppRunPanel.tsx: 名前編集の Esc は窓を一緒に閉じない', () => {
  it('★★★ Esc の枝が preventDefault を呼ぶ（Modal は defaultPrevented の Esc を受けない）', () => {
    const src = read('AppRunPanel.tsx')
    expect(src).toContain("if (e.key === 'Escape') { e.preventDefault(); nameCommittedRef.current = true;")
    expect(src).not.toContain("if (e.key === 'Escape') { nameCommittedRef.current = true;")
  })
})
