import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { shouldCheckFromMenu, type UpdateState } from '../src/shared/updatePolicy'

// 2026-11-13 作者の要望: メニューバーの「更新を確認…」から更新へたどり着けるようにする。
// 判断の表と、main → preload → App → SettingsModal の配線を固定する。

const ROOT = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

describe('shouldCheckFromMenu: 確認を始めてよい状態の表', () => {
  const table: [UpdateState, boolean][] = [
    [{ kind: 'idle' }, true],
    [{ kind: 'none' }, true],
    [{ kind: 'error', message: 'x' }, true],
    [{ kind: 'checking' }, false],
    [{ kind: 'available', version: '1.0.0' }, false],
    [{ kind: 'downloading', version: '1.0.0', percent: 10 }, false],
    [{ kind: 'downloaded', version: '1.0.0' }, false],
  ]
  for (const [state, expected] of table) {
    it(`${state.kind} → ${expected}`, () => expect(shouldCheckFromMenu(state)).toBe(expected))
  }
})

// 項目の数を数える（壊したら落ちる対照のため、判定を関数にしておく）
const countItems = (main: string) => main.split('checkUpdateItem,').length - 1
const itemDefinedOnce = (main: string) => main.split("label: '更新を確認…'").length - 1 === 1
const usesNonce = (app: string) => app.includes('setUpdateRequest(n => n + 1)') && !/setUpdateRequest\(true\)/.test(app)
const decidesByPolicy = (m: string) => /if \(shouldCheckFromMenu\(update\)\)\s*void runUpdateCheck\(\)/.test(m)

describe('main.ts: メニューの項目', () => {
  const main = read('src/main/main.ts')
  it('項目の定義は1つで、アプリのメニューとヘルプの2か所で使う', () => {
    expect(itemDefinedOnce(main)).toBe(true)
    expect(countItems(main)).toBe(2)
    expect(main).toContain("sendToWindow(mainWindow, 'menu:check-update')")
  })
  it('アプリのメニューは「について」の直後・ヘルプは「バージョン」の行の直後', () => {
    expect(main).toMatch(/role: 'about'[^\n]*\n\s*checkUpdateItem,/)
    expect(main).toMatch(/ベータ提供中）`, enabled: false \},\n\s*checkUpdateItem,/)
  })
  it('対照: 片方を消すと2か所でなくなる／真偽値で渡すと検出される', () => {
    expect(countItems(main.replace('            checkUpdateItem,\n', ''))).toBe(1)
    expect(usesNonce(read('src/renderer/App.tsx').replace('setUpdateRequest(n => n + 1)', 'setUpdateRequest(true)'))).toBe(false)
  })
})

describe('preload・型・App・SettingsModal', () => {
  it('preload の app.onCheckUpdate が menu:check-update を購読し、解除関数を返す', () => {
    const pre = read('src/main/preload.ts')
    const at = pre.indexOf('onCheckUpdate')
    expect(at).toBeGreaterThan(-1)
    const block = pre.slice(at, at + 260)
    expect(block).toContain("ipcRenderer.on('menu:check-update'")
    expect(block).toContain("removeListener('menu:check-update'")
    expect(read('src/renderer/global.d.ts')).toContain('onCheckUpdate(cb: () => void): () => void')
  })
  it('App は合図で設定を開き、依頼を回数で渡す（閉じたら0に戻す）', () => {
    const app = read('src/renderer/App.tsx')
    expect(app).toContain('onCheckUpdate(')
    expect(app).toMatch(/onCheckUpdate\(\(\) => \{\s*setShowSettings\(true\)[\s;]*setUpdateRequest\(n => n \+ 1\)/)
    expect(usesNonce(app)).toBe(true)
    expect(app).toContain('updateRequest={updateRequest}')
    expect(app).toContain('setUpdateRequest(0)')
  })
  it('SettingsModal は純粋な関数で判断し、状態の読み込み後に1回だけ処理し、窓の外へイベントを足さない', () => {
    const m = read('src/renderer/components/SettingsModal.tsx')
    expect(decidesByPolicy(m)).toBe(true)
    expect(decidesByPolicy(m.replace('shouldCheckFromMenu(update)', 'true'))).toBe(false)
    expect(decidesByPolicy(m.replace('if (shouldCheckFromMenu(update))', 'if (true || shouldCheckFromMenu(update))'))).toBe(false)
    expect(decidesByPolicy(m.replace('if (shouldCheckFromMenu(update)) void runUpdateCheck()', 'shouldCheckFromMenu(update); void runUpdateCheck()'))).toBe(false)
    expect(m).toContain('updateRequest <= handledRequest.current || !updateLoaded')
    expect(m).toContain("scrollIntoView({ block: 'nearest' })")
    // 送り直しは短いあいだだけ（期限の時刻と比べる）。利用者が窓の中を動かしたら止める（React の口で受ける）
    expect(m).toMatch(/pinUntil\.current = Date\.now\(\) \+ \d+/)
    expect(m).toContain('Date.now() < pinUntil.current')
    for (const h of ['onWheel', 'onTouchStart', 'onPointerDown', 'onKeyDown']) expect(m, h).toContain(`${h}={stopPin}`)
    expect(m).toContain('ro.disconnect()')
    // 窓の外（window・document）へイベントを足さない（メニューを閉じる処理の事故の防止。hookify の決まりと同じ種類）
    expect(m).not.toMatch(/(window|document)\.addEventListener\(\s*['"](click|mousedown|pointerdown|keydown|contextmenu|wheel|scroll)['"]/)
  })
})
