import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  OSV_SETTINGS_TITLE, OSV_SETTINGS_CONSENTED, OSV_SETTINGS_NOT_CONSENTED, OSV_SETTINGS_REVOKE,
} from '../src/renderer/osvCheckWords'

const ROOT = path.join(__dirname, '..')
const RENDERER = path.join(ROOT, 'src/renderer')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const count = (src: string, needle: string) => src.split(needle).length - 1
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(ROOT, full))
  }
  return out
}

const CARD = read('src/renderer/components/OsvConsentSettings.tsx')
const MODAL = read('src/renderer/components/SettingsModal.tsx')

describe('OsvConsentSettings.tsx', () => {
  it('同意の有無は描くたびに保存先から読む', () => {
    expect(count(CARD, 'const consented = hasOsvConsent()')).toBe(1)
    const useStateLines = CARD.split('\n').filter(l => l.includes('useState('))
    expect(useStateLines.length).toBeGreaterThan(0)
    for (const l of useStateLines) expect(/consent/i.test(l)).toBe(false)
  })
  it('取り消しのボタンは1つで、同意済みのときだけ出る', () => {
    expect(count(CARD, 'onClick={() => { revokeOsvConsent(); bump(n => n + 1) }}')).toBe(1)
    expect(count(CARD, '{consented && (')).toBe(1)
    expect(CARD.indexOf('{consented && (')).toBeLessThan(CARD.indexOf('revokeOsvConsent()'))
  })
  it('設定から同意はできない・直接保存を触らない・確認の窓も失敗の行も使わない', () => {
    expect(CARD).not.toContain('recordOsvConsent')
    expect(count(CARD, '{OSV_SEND_NOTE}')).toBe(1)
    expect(CARD).not.toContain('localStorage')
    expect(CARD).not.toContain('window.confirm(')
    expect(CARD).not.toContain('<FailureLines')
  })
})

describe('SettingsModal.tsx', () => {
  it('カードは「最初のあいさつ」の後ろ・AI の切替（キーの有無の枠）の前に1つ', () => {
    expect(count(MODAL, '<OsvConsentSettings />')).toBe(1)
    const at = MODAL.indexOf('<OsvConsentSettings />')
    expect(at).toBeGreaterThan(MODAL.indexOf('{GREET_ON_OPEN_LABEL}'))
    expect(count(MODAL, '{(hasClaudeKey || hasAiEngineKey) && (')).toBeGreaterThan(0)
    expect(at).toBeLessThan(MODAL.indexOf('{(hasClaudeKey || hasAiEngineKey) && ('))
  })
  it('import は1つ', () => {
    expect(count(MODAL, "import OsvConsentSettings from './OsvConsentSettings'")).toBe(1)
  })
})

describe('同意の保存と取り消しの呼び出し元', () => {
  const files = walk(RENDERER)
  const callers = (fn: string) => files
    .filter(f => !f.endsWith('src/renderer/osvConsent.ts'))
    .filter(f => count(read(f), `${fn}(`) > 0)
    .map(f => path.basename(f))
  it('revokeOsvConsent を呼ぶのは OsvConsentSettings.tsx だけ', () => {
    expect(callers('revokeOsvConsent')).toEqual(['OsvConsentSettings.tsx'])
  })
  it('recordOsvConsent を呼ぶのは OsvCheckBlock.tsx だけ', () => {
    expect(callers('recordOsvConsent')).toEqual(['OsvCheckBlock.tsx'])
  })
})

describe('設定のカードの文', () => {
  it('文字列を固定する', () => {
    expect(OSV_SETTINGS_TITLE).toBe('セキュリティ')
    expect(OSV_SETTINGS_CONSENTED).toBe('ライブラリの脆弱性の照会: 同意済み')
    expect(OSV_SETTINGS_NOT_CONSENTED).toBe('ライブラリの脆弱性の照会: まだ同意していません。調べるときに確認します。')
    expect(OSV_SETTINGS_REVOKE).toBe('取り消す')
  })
})
