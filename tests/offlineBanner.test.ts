import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import OfflineBanner, { OFFLINE_BANNER_TEXT } from '../src/renderer/components/OfflineBanner'
import { readOnline, subscribeOnline } from '../src/renderer/hooks/useOnlineStatus'

// 回線が切れているときだけ出る1行の帯。navigator.onLine を初期値にし、online / offline の出来事で切り替わる。

const html = () => renderToStaticMarkup(React.createElement(OfflineBanner))

afterEach(() => { vi.unstubAllGlobals() })

describe('オフラインの帯の描画', () => {
  it('オフラインで出る（文は一字一句・role=status・aria-live=polite・ボタンなし）', () => {
    vi.stubGlobal('navigator', { onLine: false })
    const h = html()
    expect(OFFLINE_BANNER_TEXT).toBe('インターネットに接続されていません。AI や公開は、接続してからお使いください。')
    expect(h).toContain(OFFLINE_BANNER_TEXT)
    expect(h).toContain('role="status"')
    expect(h).toContain('aria-live="polite"')
    expect(h).not.toContain('<button')
  })

  it('オンラインでは何も出ない', () => {
    vi.stubGlobal('navigator', { onLine: true })
    expect(html()).toBe('')
  })
})

describe('online / offline の出来事', () => {
  it('両方の出来事を購読し、出来事ごとに印が読み直され、外すと購読が消える', () => {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (t: string, l: () => void) => { listeners.set(t, l) },
      removeEventListener: (t: string, l: () => void) => { if (listeners.get(t) === l) listeners.delete(t) },
    })
    const nav = { onLine: true }
    vi.stubGlobal('navigator', nav)
    const seen: boolean[] = []
    const off = subscribeOnline(() => { seen.push(readOnline()) })
    expect([...listeners.keys()].sort()).toEqual(['offline', 'online'])
    nav.onLine = false
    listeners.get('offline')!()
    nav.onLine = true
    listeners.get('online')!()
    expect(seen).toEqual([false, true])
    off()
    expect(listeners.size).toBe(0)
  })
})
