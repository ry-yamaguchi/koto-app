import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AiMessage from '../src/renderer/components/AiMessage'

// Koto 自身の一言（plain の吹き出し）に失敗の文が入るとき、最後の「詳細: 原文」の行は文のすぐ下に小さく出す。
// AI の本文（plain でない）は解釈しない・変えない。

const html = (content: string, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(AiMessage, { content, ...props } as any))

describe('AiMessage plain - 失敗の詳細の行', () => {
  const shown = '⚠️ インターネットに接続できませんでした。接続を確かめてから、もう一度送信してください。\n詳細: getaddrinfo ENOTFOUND api.ai.sakura.ad.jp'

  it('文は本文の大きさ、詳細は小さい行で、「詳細: 」の文字が付く', () => {
    const h = html(shown, { plain: true })
    expect(h).toContain('⚠️ インターネットに接続できませんでした。接続を確かめてから、もう一度送信してください。')
    expect(h).toMatch(/<span class="[^"]*text-\[10px\][^"]*select-text">詳細: getaddrinfo ENOTFOUND api\.ai\.sakura\.ad\.jp<\/span>/)
    // 詳細は文の側には残らない（「詳細:」は小さい行の中の1か所だけ）
    expect(h.split('詳細:').length).toBe(2)
    expect(h.indexOf('もう一度送信してください')).toBeLessThan(h.indexOf('詳細:'))
  })

  it('詳細の無い一言は今までどおり文字のまま', () => {
    const h = html('✏️ ファイルを保存しました', { plain: true })
    expect(h).toContain('✏️ ファイルを保存しました')
    expect(h).not.toContain('<span')
  })

  it('途中の行にある「詳細:」は詳細として分けない', () => {
    const h = html('詳細: これは途中\nあとの行', { plain: true })
    expect(h).not.toContain('text-[10px]')
    expect(h).toContain('詳細: これは途中')
  })

  it('plain でない（AI の本文）は詳細として分けない', () => {
    const h = html('説明です\n詳細: ここは AI の本文')
    expect(h).not.toContain('text-[10px]')
  })

  it('詳細の中の < や & は文字として出る（タグにならない）', () => {
    const h = html('文です。\n詳細: <b>x</b> & y', { plain: true })
    expect(h).not.toContain('<b>')
    expect(h).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y')
  })
})
