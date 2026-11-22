import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SecurityReportBody from '../src/renderer/components/SecurityReportBody'
import type { ReportPart } from '../src/renderer/securityCheck'

// 結果の本文の描画。fold の付いた行は閉じた <details> にまとめ、文字は解釈せずそのまま出す。

const html = (parts: ReportPart[]) =>
  renderToStaticMarkup(createElement(SecurityReportBody, { result: { report: parts.map(p => p.text).join('\n'), parts } }))

const PARTS: ReportPart[] = [
  { text: '判定: 要確認', ai: false },
  { text: '・a.html:3 気をつけたい点があります（AI の判断）\n　**太字** と `コード` の説明', ai: false, fold: '念のため（2件）' },
  { text: '・b.html:4 気をつけたい点があります（AI の判断）', ai: false, fold: '念のため（2件）' },
  { text: '※ 末尾の注記', ai: false },
]

describe('SecurityReportBody の fold', () => {
  it('★ fold のある行は <details>（閉じた状態）の中に入り、<summary> が fold の文', () => {
    const h = html(PARTS)
    const m = h.match(/<details([^>]*)><summary[^>]*>([^<]*)<\/summary>([\s\S]*?)<\/details>/)
    expect(m).not.toBeNull()
    expect(m![1]).not.toContain('open')
    expect(m![2]).toBe('念のため（2件）')
    expect(m![3]).toContain('a.html:3')
    expect(m![3]).toContain('b.html:4')
    // 続いている2件は1つの <details> にまとまる
    expect(h.match(/<details/g)).toHaveLength(1)
    // fold の外の行は <details> の外
    const outside = h.replace(m![0], '')
    expect(outside).toContain('判定: 要確認')
    expect(outside).toContain('末尾の注記')
    expect(outside).not.toContain('a.html:3')
  })

  it('★ note の **太字** や `コード` は、<strong>・<code> にならず文字のまま出る', () => {
    const h = html(PARTS)
    expect(h).not.toContain('<strong')
    expect(h).not.toContain('<code')
    expect(h).toContain('**太字** と `コード` の説明')
  })

  it('★ ai が true の行は太字・コードとして描かれ、同じ文でも ai が false なら文字のまま', () => {
    const text = '**太字** と `コード`'
    const on = html([{ text, ai: true }])
    expect(on).toContain('<strong')
    expect(on).toContain('<code')
    const off = html([{ text, ai: false }])
    expect(off).not.toContain('<strong')
    expect(off).not.toContain('<code')
    expect(off).toContain(text)
  })

  it('fold の無い結果は <details> を作らない', () => {
    const h = html([{ text: '判定: 問題なし', ai: false }])
    expect(h).not.toContain('<details')
    expect(h).toContain('判定: 問題なし')
  })

  it('fold の文が違うものは、別の <details>', () => {
    const h = html([
      { text: 'x', ai: false, fold: 'A' },
      { text: 'y', ai: false, fold: 'B' },
    ])
    expect(h.match(/<details/g)).toHaveLength(2)
  })

  it('parts が無い結果は、report 全体を文字のまま出す', () => {
    const h = renderToStaticMarkup(createElement(SecurityReportBody, { result: { report: '一言 **そのまま**' } }))
    expect(h).toContain('一言 **そのまま**')
    expect(h).not.toContain('<strong')
  })
})
