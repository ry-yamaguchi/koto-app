// OSV.dev への照会の同意: 同じ版の値のときだけ同意済み。読めない・書けないときも例外にしない。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OSV_CONSENT_KEY, OSV_CONSENT_VERSION, hasOsvConsent, recordOsvConsent, revokeOsvConsent } from '../src/renderer/osvConsent'

let store: Map<string, string>

function stubStorage(over: { getItem?: (k: string) => string | null; setItem?: (k: string, v: string) => void; removeItem?: (k: string) => void } = {}) {
  vi.stubGlobal('localStorage', {
    getItem: over.getItem ?? ((k: string) => (store.has(k) ? store.get(k)! : null)),
    setItem: over.setItem ?? ((k: string, v: string) => { store.set(k, String(v)) }),
    removeItem: over.removeItem ?? ((k: string) => { store.delete(k) }),
  })
}

beforeEach(() => { store = new Map(); stubStorage() })
afterEach(() => { vi.unstubAllGlobals() })

describe('OSV.dev への照会の同意', () => {
  it('キーの実値と版', () => {
    expect(OSV_CONSENT_KEY).toBe('koto_osv_consent')
    expect(OSV_CONSENT_VERSION).toBe('1')
  })

  it('未保存は未同意', () => {
    expect(hasOsvConsent()).toBe(false)
  })

  it('記録すると同意済みになり、true を返す', () => {
    expect(recordOsvConsent()).toBe(true)
    expect(store.get('koto_osv_consent')).toBe('1')
    expect(hasOsvConsent()).toBe(true)
  })

  it('別の版の値は未同意', () => {
    for (const v of ['0', '2', '1 ', '']) {
      store.set(OSV_CONSENT_KEY, v)
      expect(hasOsvConsent()).toBe(false)
    }
  })

  it('取り消すと未同意に戻り、true を返す', () => {
    recordOsvConsent()
    expect(revokeOsvConsent()).toBe(true)
    expect(store.has(OSV_CONSENT_KEY)).toBe(false)
    expect(hasOsvConsent()).toBe(false)
  })

  it('読めないときは未同意（例外にしない）', () => {
    stubStorage({ getItem: () => { throw new Error('denied') } })
    expect(() => hasOsvConsent()).not.toThrow()
    expect(hasOsvConsent()).toBe(false)
  })

  it('書けない・消せないときは false を返し、例外にしない', () => {
    stubStorage({ setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('denied') } })
    expect(recordOsvConsent()).toBe(false)
    expect(revokeOsvConsent()).toBe(false)
    expect(hasOsvConsent()).toBe(false)
  })
})
