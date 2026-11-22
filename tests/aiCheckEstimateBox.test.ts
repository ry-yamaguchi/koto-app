import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AiCheckEstimateBox from '../src/renderer/components/AiCheckEstimateBox'
import { NOTHING_TO_CHECK_REPORT, OVER_LIMIT_REPORT, type AiEstimate, type EstimatePlan } from '../src/renderer/aiCheckEstimate'

// 見積りの枠を実際に描いて、ボタンの有無・札・押せるかを固定する。

const PLAN: EstimatePlan = { files: 3, promptChars: 1200, requests: 1, skipped: [], partial: [], nothing: false }
const made = (plan: Partial<EstimatePlan> = {}, budget: { allowed: boolean; message?: string; warning?: string } = { allowed: true }): AiEstimate =>
  ({ state: 'made', plan: { ...PLAN, ...plan }, budget })
const render = (estimate: AiEstimate, over: { running?: boolean; disabled?: boolean } = {}) =>
  renderToStaticMarkup(React.createElement(AiCheckEstimateBox, { estimate, running: over.running ?? false, disabled: over.disabled ?? false, onRun: () => {} }))
const buttons = (html: string) => (html.match(/<button/g) ?? []).length

describe('見積りの枠の描画', () => {
  it('送れる状態では、文とボタンが1つ出る', () => {
    const h = render(made())
    expect(buttons(h)).toBe(1)
    expect(h).toContain('>AIに確認してもらう</button>')
    expect(h).toContain('3個のファイル・約1,200文字を、さくらのAI Engine へ送ります。')
    expect(h).not.toContain('disabled=""')
  })
  it('上限で止める・送るものが無い・作れなかった、のどれでもボタンを出さない', () => {
    const stop = render(made({}, { allowed: false, message: '上限です' }))
    expect(buttons(stop)).toBe(0)
    expect(stop).toContain('上限です')
    const stopNoMsg = render(made({}, { allowed: false }))
    expect(buttons(stopNoMsg)).toBe(0)
    expect(stopNoMsg).toContain(OVER_LIMIT_REPORT)
    const nothing = render(made({ nothing: true }))
    expect(buttons(nothing)).toBe(0)
    expect(nothing).toContain(NOTHING_TO_CHECK_REPORT)
    const failed = render({ state: 'failed', failure: '読めませんでした' })
    expect(buttons(failed)).toBe(0)
    expect(failed).toContain('AI の確認の準備ができませんでした。')
    expect(failed).toContain('読めませんでした')
  })
  it('走っている間は札が「確認中…」で押せない。点検中も押せない', () => {
    const running = render(made(), { running: true, disabled: true })
    expect(running).toContain('>確認中…</button>')
    expect(running).toContain('disabled=""')
    const busy = render(made(), { disabled: true })
    expect(busy).toContain('>AIに確認してもらう</button>')
    expect(busy).toContain('disabled=""')
  })
  it('送らないファイルの注記と上限の警告の行が出る', () => {
    const h = render(made({ skipped: ['a.js'] }, { allowed: true, warning: '今月の利用が上限に近づいています。' }))
    expect(h).toContain('量が多いため、1個のファイルは送りません。')
    expect(h).toContain('今月の利用が上限に近づいています。')
    expect(buttons(h)).toBe(1)
  })
})
