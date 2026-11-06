import { describe, it, expect, vi } from 'vitest'
import { probeOnline } from '../src/main/net/onlineProbe'

describe('probeOnline', () => {
  it('isOnline が false なら名前を引かずに false', async () => {
    const lookup = vi.fn()
    expect(await probeOnline({ isOnline: () => false, lookup })).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })
  it('名前が引ければ true', async () => {
    expect(await probeOnline({ isOnline: () => true, lookup: async () => ({ address: '1.2.3.4' }) })).toBe(true)
  })
  it('名前が引けなければ false', async () => {
    expect(await probeOnline({ isOnline: () => true, lookup: async () => { throw new Error('ENOTFOUND') } })).toBe(false)
  })
  it('時間切れなら false', async () => {
    expect(await probeOnline({ isOnline: () => true, lookup: () => new Promise(() => {}), timeoutMs: 20 })).toBe(false)
  })
  it('isOnline が投げても外へ出さない', async () => {
    expect(await probeOnline({ isOnline: () => { throw new Error('x') } })).toBe(false)
  })
})
