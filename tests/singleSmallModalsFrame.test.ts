import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createModalManager } from '../src/renderer/ui/modalManager'
import HistoryModal from '../src/renderer/components/HistoryModal'
import GithubSaveModal from '../src/renderer/components/GithubSaveModal'
import ServerFilesModal from '../src/renderer/components/ServerFilesModal'
import KnowledgeModal from '../src/renderer/components/KnowledgeModal'

// ── 単独の小窓5つ（履歴・GitHub に保存・サーバのファイル・資料・サイドバーの名前入力）の枠 ──────────────
// 1) markup: 本物の React で描き、role・aria-modal・aria-labelledby が見出しと結ばれ、✕ に aria-label がある。
// 2) 振る舞い: 名前入力は本物の manager に登録し、IME 変換中の Esc では閉じず、変換が済んだ Esc で閉じる。
// 3) ソース: 外枠は Modal・古い外枠（自前の fixed inset-0 の背景）と名前入力の自前 Esc は残さない。

const noop = () => {}

function check(html: string, titleId: string, title: string) {
  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-modal="true"')
  expect(html).toContain(`aria-labelledby="${titleId}"`)
  expect(html).toContain(`<h2 id="${titleId}"`)
  expect(html).toContain(title)
  expect(html).toContain('aria-label="閉じる"')
}

describe('小窓4つ: 本物の React で描いた markup', () => {
  it('★★★ 履歴', () => {
    const h = renderToStaticMarkup(createElement(HistoryModal, { projectDir: '/tmp/ws/p', onClose: noop, onRestored: async () => {} } as any))
    check(h, 'history-modal-title', '🕘 履歴')
  })
  it('★★★ GitHub に保存', () => {
    const h = renderToStaticMarkup(createElement(GithubSaveModal, { projectDir: '/tmp/ws/p', onClose: noop, onOpenCredentials: noop } as any))
    check(h, 'github-save-title', '💾 GitHubに保存')
  })
  it('★★★ サーバのファイル（閉じているときは何も描かない）', () => {
    const props = { onClose: noop, projectDir: '/tmp/ws/p', meta: {} }
    expect(renderToStaticMarkup(createElement(ServerFilesModal, { ...props, open: false } as any))).toBe('')
    check(renderToStaticMarkup(createElement(ServerFilesModal, { ...props, open: true } as any)), 'server-files-title', '🗄 サーバのファイル')
  })
  it('★★★ 資料（キーの有無どちらでも）', () => {
    for (const apiKey of ['', 'k']) {
      const h = renderToStaticMarkup(createElement(KnowledgeModal, { apiKey, onClose: noop, onOpenCredentials: noop, projectDir: '/tmp/ws/p' } as any))
      check(h, 'knowledge-modal-title', '📚 資料')
    }
  })
})

class FakeDoc {
  activeElement: unknown = null
  body = { focus() {} }
  listeners: Array<(e: any) => void> = []
  addEventListener(_t: string, l: (e: any) => void) { this.listeners.push(l) }
  removeEventListener(_t: string, l: (e: any) => void) { this.listeners = this.listeners.filter(x => x !== l) }
  press(init: Record<string, unknown>) {
    const e: any = { defaultPrevented: false, preventDefault() { e.defaultPrevented = true }, ...init }
    for (const l of [...this.listeners]) l(e)
  }
}

describe('名前入力の窓: Esc は変換中なら閉じない', () => {
  it('★★★ 変換中の Esc では閉じず、変換が済んだ Esc で1回閉じる', () => {
    const doc = new FakeDoc()
    const mgr = createModalManager(doc as any)
    const calls: string[] = []
    const frame = { querySelectorAll: () => [], focus() {}, isConnected: true }
    mgr.open({ frame: frame as any, onRequestClose: () => { calls.push('close') } })
    doc.press({ key: 'Escape', isComposing: true })
    doc.press({ key: 'Escape', keyCode: 229 })
    expect(calls).toEqual([])
    doc.press({ key: 'Escape' })
    expect(calls).toEqual(['close'])
  })
})

const read = (f: string) => fs.readFileSync(path.join(__dirname, '../src/renderer/components', f), 'utf8')
const OLD_FRAME = '<div className="fixed inset-0 z-50 flex items-center justify-center'

describe('ソース: 外枠は Modal', () => {
  for (const [file, id] of [
    ['HistoryModal.tsx', 'history-modal-title'],
    ['GithubSaveModal.tsx', 'github-save-title'],
    ['ServerFilesModal.tsx', 'server-files-title'],
    ['KnowledgeModal.tsx', 'knowledge-modal-title'],
  ] as const) {
    it(`★★★ ${file}: Modal に onClose を渡し、見出しの id を結ぶ。古い外枠は残さない`, () => {
      const s = read(file)
      expect(s).toContain("import Modal from '../ui/Modal'")
      expect(s).toContain(`<Modal\n      onRequestClose={onClose} labelledBy="${id}" backdropClassName="bg-black/50 backdrop-blur-sm"`)
      expect(s).toContain('    </Modal>\n  )\n}')
      expect(s).not.toContain(OLD_FRAME)
      expect(s).not.toContain('onClick={e => e.stopPropagation()}')
    })
  }

  it('★★ 5画面すべての ✕ に aria-label="閉じる"', () => {
    expect(read('HistoryModal.tsx')).toContain('<button onClick={onClose} aria-label="閉じる" className="ml-auto')
    expect(read('GithubSaveModal.tsx')).toContain('<button onClick={onClose} aria-label="閉じる" className="ml-auto')
    expect(read('KnowledgeModal.tsx')).toContain('<button onClick={onClose} aria-label="閉じる" className="ml-auto')
    expect(read('ServerFilesModal.tsx')).toContain('<button onClick={onClose} aria-label="閉じる" className="text-ink-muted')
  })

  it('★★★ Sidebar の名前入力: Modal で包み、自前の Esc 処理と autoFocus は残さない（Esc は Modal が変換中を見て受ける）', () => {
    const s = read('Sidebar.tsx')
    expect(s).toContain("import Modal from '../ui/Modal'")
    expect(s).toContain('<Modal\n          onRequestClose={() => setNameDialog(null)} labelledBy="sidebar-name-dialog-title" backdropClassName="bg-black/30"')
    expect(s).toContain('<div id="sidebar-name-dialog-title"')
    expect(s).toContain('              data-autofocus\n              value={nameInput}')
    expect(s).not.toContain("else if (e.key === 'Escape') { e.preventDefault(); setNameDialog(null) }")
    expect(s).not.toContain('className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"')
    expect(s).not.toContain('              autoFocus\n              value={nameInput}')
  })
})
