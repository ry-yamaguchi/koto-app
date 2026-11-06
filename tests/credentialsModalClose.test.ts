import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createModalManager } from '../src/renderer/ui/modalManager'
import { runRequestCloseCredentials } from '../src/renderer/confirmedActions'

// ── 認証情報の窓の閉じ方（枠は ui/Modal）─────────────────────────────────────
// 1) 振る舞い: 本物の manager に窓を登録し、Esc を押して「閉じる処理」を通す。
//    未保存で Esc → 確認が出る → キャンセルなら閉じない／「保存せずに閉じる」なら閉じる。確認の呼び出しの一覧を見る。
// 2) ソース: 外枠は Modal・Esc／背景／✕／「閉じる」が同じ requestClose を通る・古い外枠（自前の fixed inset-0 の背景）は禁止。

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

/** 本物の閉じる処理（runRequestCloseCredentials）を Esc につなぐ。 */
function setupWindow(dirty: boolean, answer: boolean) {
  const doc = new FakeDoc()
  const mgr = createModalManager(doc as any)
  const calls: string[] = []
  const requestClose = () => runRequestCloseCredentials('保存せずに閉じますか？', {
    dirty,
    confirm: async () => { calls.push('confirm'); return answer },
    discard: () => { calls.push('close') },
  })
  const frame = { querySelectorAll: () => [], focus() {}, isConnected: true }
  mgr.open({ frame: frame as any, onRequestClose: () => { void requestClose() } })
  return { doc, calls }
}

const flush = () => new Promise(r => setTimeout(r, 0))

describe('認証情報の窓: Esc は ✕ と同じ閉じる処理を通る', () => {
  it('★★★ 未保存で Esc → 確認が1回出る → キャンセルなら閉じない', async () => {
    const { doc, calls } = setupWindow(true, false)
    doc.press('Escape')
    await flush()
    expect(calls).toEqual(['confirm'])
  })

  it('★★ 未保存で Esc → 確認で「保存せずに閉じる」なら閉じる（確認のあとに閉じる）', async () => {
    const { doc, calls } = setupWindow(true, true)
    doc.press('Escape')
    await flush()
    expect(calls).toEqual(['confirm', 'close'])
  })

  it('★★ 未保存でなければ確認なしで閉じる', async () => {
    const { doc, calls } = setupWindow(false, false)
    doc.press('Escape')
    await flush()
    expect(calls).toEqual(['close'])
  })
})

const src = fs.readFileSync(path.join(__dirname, '../src/renderer/components/CredentialsModal.tsx'), 'utf8')

describe('CredentialsModal.tsx: 外枠は Modal', () => {
  it('★★★ Modal に requestClose を渡し、見出しの id を結び、確認の窓は枠の外の兄弟にする', () => {
    expect(src).toContain("import Modal from '../ui/Modal'")
    expect(src).toContain('onRequestClose={() => { void requestClose() }}')
    expect(src).toContain("await runRequestCloseCredentials('保存せずに閉じますか？', {")
    expect(src).not.toContain('await runDiscardCredentialEdits(')
    expect(src).toContain('labelledBy="credentials-modal-title"')
    expect(src).toContain('<h2 id="credentials-modal-title"')
    expect(src).toContain('      </Modal>\n      {confirmElement}\n    </>')
  })

  it('★★ ✕ に aria-label="閉じる"・✕ と「閉じる」ボタンは同じ requestClose', () => {
    expect(src).toContain('<button onClick={requestClose} aria-label="閉じる" className="ml-auto')
    expect(src).toContain('<button onClick={requestClose} className="flex-1 py-2.5')
  })

  it('★★ 古い外枠（自前の背景で requestClose を呼ぶ形）は残さない', () => {
    expect(src).not.toContain('<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={requestClose}>')
    expect(src).not.toContain('onClick={e => e.stopPropagation()}>\n        <div className="flex items-center gap-2.5 px-6 pt-6 pb-4 sticky')
  })
})
