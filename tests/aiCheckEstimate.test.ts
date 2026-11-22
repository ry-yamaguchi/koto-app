import { describe, it, expect } from 'vitest'
import { estimateViewOf, canSendOf, groupDigits, NOTHING_TO_CHECK_REPORT, OVER_LIMIT_REPORT, type AiEstimate, type EstimatePlan } from '../src/renderer/aiCheckEstimate'

const PLAN: EstimatePlan = { files: 12, promptChars: 1234567, requests: 1, skipped: [], partial: [], nothing: false }
const made = (plan: Partial<EstimatePlan> = {}, budget: { allowed: boolean; message?: string; warning?: string } = { allowed: true }): AiEstimate =>
  ({ state: 'made', plan: { ...PLAN, ...plan }, budget })
const texts = (e: AiEstimate) => estimateViewOf(e).lines.map(l => l.text)

describe('見積りの文', () => {
  it('1回で送る', () => {
    expect(texts(made())).toEqual(['AI の確認: 12個のファイル・約1,234,567文字を、さくらのAI Engine へ送ります。'])
    expect(estimateViewOf(made()).canSend).toBe(true)
  })
  it('2回以上は、回数を言う', () => {
    expect(texts(made({ requests: 3 }))).toEqual(['AI の確認: 12個のファイル・約1,234,567文字を、3回に分けて さくらのAI Engine へ送ります。'])
  })
  it('2回ちょうどでも、回数を言う（1回のときは言わない）', () => {
    expect(texts(made({ requests: 2 }))).toEqual(['AI の確認: 12個のファイル・約1,234,567文字を、2回に分けて さくらのAI Engine へ送ります。'])
    expect(texts(made({ requests: 1 }))[0]).not.toContain('回に分けて')
  })
  it('送らないファイルが1件でも、その下に言う（0件では言わない）', () => {
    expect(texts(made({ skipped: ['a'] }))).toEqual([
      'AI の確認: 12個のファイル・約1,234,567文字を、さくらのAI Engine へ送ります。',
      '量が多いため、1個のファイルは送りません。',
    ])
    expect(texts(made({ skipped: [] }))).toHaveLength(1)
  })
  it('送らないファイルがあれば、その下に言う。上限の警告はさらに下', () => {
    expect(texts(made({ skipped: ['a', 'b'] }, { allowed: true, warning: '今月の利用が上限に近づいています。' }))).toEqual([
      'AI の確認: 12個のファイル・約1,234,567文字を、さくらのAI Engine へ送ります。',
      '量が多いため、2個のファイルは送りません。',
      '今月の利用が上限に近づいています。',
    ])
  })
  it('送る回が無い（読めるファイルが1つも無かった）ときは、そう言ってボタンを出さない', () => {
    const v = estimateViewOf(made({ files: 0, promptChars: 0, requests: 0 }))
    expect(v.lines.map(l => l.text)).toEqual(['AI の確認: 送れるファイルがありません。'])
    expect(v.canSend).toBe(false)
  })
  it('中身を送るファイルが無く名前だけを伝える回は、0個とは言わず「ファイルの名前だけ」と言う（送れる）', () => {
    const v = estimateViewOf(made({ files: 0, promptChars: 345, requests: 1 }))
    expect(v.lines.map(l => l.text)).toEqual(['AI の確認: ファイルの名前だけ（約345文字）を、さくらのAI Engine へ送ります。'])
    expect(v.canSend).toBe(true)
    expect(texts(made({ files: 1, promptChars: 345, requests: 1 }))[0]).toBe('AI の確認: 1個のファイル・約345文字を、さくらのAI Engine へ送ります。')
  })
  it('上限で止めるときは、message をそのまま出してボタンを出さない。無ければ送る口と同じ文', () => {
    const v = estimateViewOf(made({}, { allowed: false, message: '上限です' }))
    expect(v.lines.map(l => l.text)).toEqual(['上限です'])
    expect(v.canSend).toBe(false)
    expect(texts(made({}, { allowed: false }))).toEqual([OVER_LIMIT_REPORT])
  })
  it('送るものが無いときは、送る口と同じ文でボタンを出さない', () => {
    const v = estimateViewOf(made({ nothing: true }))
    expect(v.lines.map(l => l.text)).toEqual([NOTHING_TO_CHECK_REPORT])
    expect(NOTHING_TO_CHECK_REPORT).toBe('チェック対象のコードファイルが見つかりませんでした。')
    expect(v.canSend).toBe(false)
  })
  it('見積りを作れなかったときは、準備できない文と失敗の文。ボタンを出さない', () => {
    const v = estimateViewOf({ state: 'failed', failure: '読めませんでした' })
    expect(v.lines).toEqual([{ kind: 'text', text: 'AI の確認の準備ができませんでした。' }, { kind: 'failure', text: '読めませんでした' }])
    expect(v.canSend).toBe(false)
  })
  it('判断の順: 例外 → 上限 → 送るものが無い', () => {
    expect(estimateViewOf(made({ nothing: true }, { allowed: false, message: 'm' })).lines[0].text).toBe('m')
    expect(canSendOf(null)).toBe(false)
  })
  it('3桁区切りはロケールに頼らない', () => {
    expect(groupDigits(0)).toBe('0')
    expect(groupDigits(999)).toBe('999')
    expect(groupDigits(1000)).toBe('1,000')
    expect(groupDigits(12345678)).toBe('12,345,678')
  })
})

describe('途中までしか送らないファイルの行', () => {
  it('1件・2件の文', () => {
    expect(texts(made({ partial: ['a'] }))[1]).toBe('量が多いため、1個のファイルは途中までしか送りません。')
    expect(texts(made({ partial: ['a', 'b'] }))[1]).toBe('量が多いため、2個のファイルは途中までしか送りません。')
  })
  it('0件では出ない', () => {
    expect(texts(made({ partial: [] }))).toHaveLength(1)
  })
  it('送らないファイルと両方あるときの並び: 見積りの文 → 送らない → 途中まで → 上限の警告', () => {
    expect(texts(made({ skipped: ['s'], partial: ['p'] }, { allowed: true, warning: '上限に近づいています。' }))).toEqual([
      'AI の確認: 12個のファイル・約1,234,567文字を、さくらのAI Engine へ送ります。',
      '量が多いため、1個のファイルは送りません。',
      '量が多いため、1個のファイルは途中までしか送りません。',
      '上限に近づいています。',
    ])
  })
})
