// Claude の同意の版: 旧い旗だけでは未同意にし、次に使うとき1回だけ確認し直す。
// 保存領域を偽にして、読めない・書けないときの動きも固定する。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CLAUDE_CONSENT_KEY, CLAUDE_CONSENT_VERSION_KEY, CLAUDE_CONSENT_VERSION,
  hasClaudeConsent, recordClaudeConsent, isClaudeConsentReconfirm, claudeConsentBody,
} from '../src/renderer/claudeMode'

let store: Map<string, string>

function stubStorage(over: { getItem?: (k: string) => string | null; setItem?: (k: string, v: string) => void } = {}) {
  vi.stubGlobal('localStorage', {
    getItem: over.getItem ?? ((k: string) => (store.has(k) ? store.get(k)! : null)),
    setItem: over.setItem ?? ((k: string, v: string) => { store.set(k, String(v)) }),
    removeItem: (k: string) => { store.delete(k) },
  })
}

beforeEach(() => { store = new Map(); stubStorage() })
afterEach(() => { vi.unstubAllGlobals() })

describe('Claude の同意の版', () => {
  it('何も無ければ未同意', () => {
    expect(hasClaudeConsent()).toBe(false)
    expect(isClaudeConsentReconfirm()).toBe(false)
  })

  it('旧いキーだけ（版なし）は未同意で、確認し直しになる', () => {
    store.set(CLAUDE_CONSENT_KEY, '1')
    expect(hasClaudeConsent()).toBe(false)
    expect(isClaudeConsentReconfirm()).toBe(true)
  })

  it('古い版の値は未同意', () => {
    store.set(CLAUDE_CONSENT_KEY, '1')
    store.set(CLAUDE_CONSENT_VERSION_KEY, '1')
    expect(hasClaudeConsent()).toBe(false)
  })

  it('同意を記録すると新しい版になり、以後は確認が出ない', () => {
    store.set(CLAUDE_CONSENT_KEY, '1')
    recordClaudeConsent()
    expect(store.get(CLAUDE_CONSENT_VERSION_KEY)).toBe(CLAUDE_CONSENT_VERSION)
    expect(hasClaudeConsent()).toBe(true)
    expect(isClaudeConsentReconfirm()).toBe(false)
  })

  it('読めないときは未同意に倒す（例外にしない）', () => {
    stubStorage({ getItem: () => { throw new Error('denied') } })
    expect(hasClaudeConsent()).toBe(false)
    expect(isClaudeConsentReconfirm()).toBe(false)
  })

  it('書けなくても例外にならない', () => {
    stubStorage({ setItem: () => { throw new Error('quota') } })
    expect(() => recordClaudeConsent()).not.toThrow()
    expect(hasClaudeConsent()).toBe(false)
  })

  it('確認の本文: 送られるものに、読んだページと資料の抜粋が入る。確認し直しのときだけ変わった点を添える', () => {
    const first = claudeConsentBody(false)
    const again = claudeConsentBody(true)
    for (const t of [first, again]) {
      expect(t).toContain('Claude が読んだページの内容')
      expect(t).toContain('資料の抜粋')
      expect(t).toContain('Anthropic')
    }
    expect(first).not.toContain('増えました')
    expect(again).toContain('送られるものが増えました')
  })

  it('確認の結びは、初回・確認し直しのどちらも「初回と、送られるものが増えたときだけ」（初回のみ、とは言わない）', () => {
    for (const t of [claudeConsentBody(false), claudeConsentBody(true)]) {
      expect(t.endsWith('（この確認は、初回と、送られるものが増えたときだけ出ます）')).toBe(true)
      expect(t).not.toContain('初回のみ')
    }
  })
})
