import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { shouldCloseNewProject } from '../src/renderer/newProjectClose'
import { handleModelSelectEscape } from '../src/renderer/components/ModelSelect'
import { createModalManager } from '../src/renderer/ui/modalManager'

// ── 新規プロジェクトの窓の閉じ方 ────────────────────────────────────────────────────────────────
//   ・背景クリックでは閉じない。Esc は作成中・インポート中は閉じない（✕・キャンセルと同じ守り）
//   ・モデル選択の一覧が開いているときの Esc は、一覧だけを閉じる（窓まで届かせない）
// 偽の document にキャプチャ段階とバブリング段階の順で keydown を流し、本物の manager と本物の判断関数を通す。

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

type Listener = (e: any) => void

/** capture→bubble の順に配り、stopPropagation で以降を止める偽の document。 */
class FakeDoc {
  activeElement: unknown = null
  private capture: Listener[] = []
  private bubble: Listener[] = []
  addEventListener(_t: 'keydown', l: Listener, capture?: boolean) { (capture ? this.capture : this.bubble).push(l) }
  removeEventListener(_t: 'keydown', l: Listener, capture?: boolean) {
    const list = capture ? this.capture : this.bubble
    const i = list.indexOf(l)
    if (i >= 0) list.splice(i, 1)
  }
  press(key: string) {
    let stopped = false
    const e = { key, defaultPrevented: false, stopPropagation: () => { stopped = true } }
    for (const l of [...this.capture]) l(e)
    if (stopped) return
    for (const l of [...this.bubble]) l(e)
  }
}

const frame = () => ({ focus() {}, querySelectorAll: () => [] as unknown[] })

describe('shouldCloseNewProject: 閉じてよいか', () => {
  it('★★★ 背景クリックは、何をしていても閉じない', () => {
    expect(shouldCloseNewProject('backdrop', false, false)).toBe(false)
    expect(shouldCloseNewProject('backdrop', true, false)).toBe(false)
    expect(shouldCloseNewProject('backdrop', false, true)).toBe(false)
  })

  it('★★★ Esc は、作成中（busy）・インポート中（importBusy）は閉じない。どちらでもないときだけ閉じる', () => {
    expect(shouldCloseNewProject('escape', false, false)).toBe(true)
    expect(shouldCloseNewProject('escape', true, false)).toBe(false)
    expect(shouldCloseNewProject('escape', false, true)).toBe(false)
    expect(shouldCloseNewProject('escape', true, true)).toBe(false)
  })
})

describe('窓と一覧の Esc（本物の manager・偽の document）', () => {
  function setup(state: { busy: boolean; importBusy: boolean }) {
    const doc = new FakeDoc()
    const manager = createModalManager(doc as any)
    const closed: string[] = []
    manager.open({
      frame: frame() as any,
      onRequestClose: reason => { if (shouldCloseNewProject(reason, state.busy, state.importBusy)) closed.push(reason) },
    })
    // ModelSelect が一覧を開いている間だけ付ける listener と同じ形（キャプチャ段階）
    let open = true
    const onKey = (e: any) => { handleModelSelectEscape(e, () => { open = false }) }
    const attach = () => doc.addEventListener('keydown', onKey, true)
    const detach = () => doc.removeEventListener('keydown', onKey, true)
    return { doc, closed, isOpen: () => open, attach, detach }
  }

  it('★★★ 一覧が開いている間の Esc は一覧だけ閉じ、窓は閉じない。一覧が閉じたあとの Esc で窓が閉じる', () => {
    const s = setup({ busy: false, importBusy: false })
    s.attach()
    s.doc.press('Escape')
    expect(s.isOpen()).toBe(false)
    expect(s.closed).toEqual([])
    s.detach()
    s.doc.press('Escape')
    expect(s.closed).toEqual(['escape'])
  })

  it('一覧が無いとき、窓は Esc で閉じる。作成中は閉じない', () => {
    const idle = setup({ busy: false, importBusy: false })
    idle.doc.press('Escape')
    expect(idle.closed).toEqual(['escape'])
    const busy = setup({ busy: true, importBusy: false })
    busy.doc.press('Escape')
    expect(busy.closed).toEqual([])
    const importing = setup({ busy: false, importBusy: true })
    importing.doc.press('Escape')
    expect(importing.closed).toEqual([])
  })

  it('Esc 以外のキーは一覧も止めない', () => {
    let stopped = 0
    let closed = 0
    expect(handleModelSelectEscape({ key: 'Enter', stopPropagation: () => { stopped++ } }, () => { closed++ })).toBe(false)
    expect({ stopped, closed }).toEqual({ stopped: 0, closed: 0 })
  })
})

describe('呼び出しの形（ソース）', () => {
  const modalSrc = read('src/renderer/components/NewProjectModal.tsx')
  const selectSrc = read('src/renderer/components/ModelSelect.tsx')

  it('★★ 新規プロジェクトは Modal で包み、判断は shouldCloseNewProject を通す。手書きの覆い・古い背景クリックは無い', () => {
    expect(modalSrc).toContain("import Modal from '../ui/Modal'")
    expect(modalSrc).toContain('<Modal')
    expect(modalSrc).toContain('labelledBy="new-project-title"')
    expect(modalSrc).toContain('<h2 id="new-project-title"')
    expect(modalSrc).toContain('onRequestClose={reason => { if (shouldCloseNewProject(reason, busy, importBusy)) onClose() }}')
    expect(modalSrc).not.toContain('fixed inset-0')
    expect(modalSrc).not.toContain('onClick={busy || importBusy ? undefined : onClose}')
    expect(modalSrc).not.toContain('onClick={e => e.stopPropagation()}')
  })

  it('★★ ✕ に aria-label="閉じる"（作成中は ✕ 自体を出さない）', () => {
    expect(modalSrc).toContain('{!busy && !importBusy && (\n            <button onClick={onClose} aria-label="閉じる"')
  })

  it('★★★ ModelSelect の Esc はキャプチャ段階で受ける（付ける・外すとも true）。バブリング段階の古い形は無い', () => {
    expect(selectSrc).toContain("document.addEventListener('keydown', onKey, true)")
    expect(selectSrc).toContain("document.removeEventListener('keydown', onKey, true)")
    expect(selectSrc).toContain('handleModelSelectEscape(e, () => setOpen(false))')
    expect(selectSrc).not.toContain("document.addEventListener('keydown', onKey)")
    expect(selectSrc).not.toContain("document.removeEventListener('keydown', onKey)")
    expect(selectSrc).not.toContain("if (e.key === 'Escape') setOpen(false)")
  })
})
