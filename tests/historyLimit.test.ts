import { describe, it, expect } from 'vitest'
import { limitHistory } from '../src/renderer/historyLimit'

function makeMessages(count: number, contentFn: (i: number) => string = (i) => `msg ${i}`) {
  return Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: contentFn(i) }))
}

describe('limitHistory', () => {
  it('returns short histories (5 messages) unchanged', () => {
    const msgs = makeMessages(5)
    const result = limitHistory(msgs)
    expect(result).toHaveLength(5)
    expect(result).toEqual(msgs)
  })

  it('returns 21 entries for 25 messages: a system notice mentioning 5件 omitted, plus the last 20', () => {
    const msgs = makeMessages(25)
    const result = limitHistory(msgs)
    expect(result).toHaveLength(21)
    expect(result[0].role).toBe('system')
    expect(result[0].content).toContain('5件')
    expect(result.slice(1)).toEqual(msgs.slice(-20))
  })

  it('truncates a message longer than 4000 chars and appends the omission marker', () => {
    const longContent = 'x'.repeat(5000)
    const msgs = [{ role: 'user', content: longContent }]
    const result = limitHistory(msgs)
    expect(result).toHaveLength(1)
    expect(result[0].content.length).toBeLessThan(longContent.length)
    expect(result[0].content.endsWith('…（長いため後半を省略）')).toBe(true)
    expect(result[0].content.startsWith('x'.repeat(4000))).toBe(true)
  })

  it('returns an empty array for an empty input', () => {
    expect(limitHistory([])).toEqual([])
  })
})
