import { describe, it, expect } from 'vitest'
import { runSecuritySteps } from '../src/renderer/securityCheckSteps'

describe('runSecuritySteps', () => {
  it('ai が null: scan だけ呼ぶ。中止が真でも no-ai', async () => {
    for (const stop of [false, true]) {
      const log: string[] = []
      const end = await runSecuritySteps({ scan: async () => { log.push('scan') }, ai: null, stopRequested: () => stop })
      expect(log).toEqual(['scan'])
      expect(end).toBe('no-ai')
    }
  })
  it('中止なし: scan のあとに ai', async () => {
    const log: string[] = []
    const end = await runSecuritySteps({
      scan: async () => { log.push('scan') },
      ai: async () => { log.push('ai') },
      stopRequested: () => false,
    })
    expect(log).toEqual(['scan', 'ai'])
    expect(end).toBe('ai-done')
  })
  it('点検の間に中止が押されたら、ai は1回も呼ばない', async () => {
    const log: string[] = []
    let stopped = false
    const end = await runSecuritySteps({
      scan: async () => { log.push('scan'); stopped = true },
      ai: async () => { log.push('ai') },
      stopRequested: () => stopped,
    })
    expect(log).toEqual(['scan'])
    expect(end).toBe('stopped-before-ai')
  })
  it('中止の印を読むのは点検が済んだあと', async () => {
    let scanDone = false
    let doneAtRead: boolean | null = null
    await runSecuritySteps({
      scan: async () => { await Promise.resolve(); scanDone = true },
      ai: async () => {},
      stopRequested: () => { doneAtRead = scanDone; return false },
    })
    expect(doneAtRead).toBe(true)
  })
  it('scan が失敗したら ai は呼ばず、失敗がそのまま伝わる', async () => {
    const log: string[] = []
    const err = new Error('scan failed')
    await expect(runSecuritySteps({
      scan: async () => { throw err },
      ai: async () => { log.push('ai') },
      stopRequested: () => false,
    })).rejects.toBe(err)
    expect(log).toEqual([])
  })
  it('ai が失敗したら、失敗がそのまま伝わる', async () => {
    const err = new Error('ai failed')
    await expect(runSecuritySteps({
      scan: async () => {},
      ai: async () => { throw err },
      stopRequested: () => false,
    })).rejects.toBe(err)
  })
})
