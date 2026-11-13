import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ErrorBand from '../src/renderer/components/ErrorBand'

// 赤い帯は選択でき、コピーのボタンがある。見た目（赤い塗り／赤い文字）は従来のまま。
// 12か所の失敗の帯がすべてこの部品を通る（呼び出しの形ごと固定し、元の直書きは禁止）。

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components', rel), 'utf-8')

describe('ErrorBand の描画', () => {
  it('赤い塗りのまま・文は select-text・コピーのボタンがある', () => {
    const h = renderToStaticMarkup(React.createElement(ErrorBand, { text: '接続できません' }))
    expect(h).toContain('bg-brand-red-fill')
    expect(h).toContain('text-white')
    expect(h).toContain('select-text')
    expect(h).toContain('接続できません')
    expect(h).toContain('>📋 コピー</button>')
  })

  it('文字だけの赤（tone=text）でも select-text とコピーがある', () => {
    const h = renderToStaticMarkup(React.createElement(ErrorBand, { text: '❌ 失敗', tone: 'text' }))
    expect(h).toContain('text-brand-red')
    expect(h).not.toContain('bg-brand-red-fill')
    expect(h).toContain('select-text')
    expect(h).toContain('>📋 コピー</button>')
  })

  it('className で帯の余白を差し替えられ、文のあとに children が続く', () => {
    const h = renderToStaticMarkup(
      React.createElement(ErrorBand, { text: '本文', className: 'px-3 py-1.5 text-[11px] text-white bg-brand-red-fill' },
        React.createElement('button', null, '認証情報を開く')))
    expect(h).toContain('px-3 py-1.5 text-[11px] text-white bg-brand-red-fill')
    expect(h).toContain('本文<button>認証情報を開く</button>')
  })
})

describe('詳細の行（置き換えた文の原文）', () => {
  const SENTENCE = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。'
  const shown = `${SENTENCE}\n詳細: getaddrinfo ENOTFOUND api.ai.sakura.ad.jp`

  it('文のすぐ下に、小さく薄い「詳細: 原文」の行が出る（文と同じ大きさの1行に潰れない）', () => {
    const h = renderToStaticMarkup(React.createElement(ErrorBand, { text: shown }))
    expect(h).toContain(SENTENCE)
    expect(h).toContain('text-[10px]')
    expect(h).toContain('>詳細: getaddrinfo ENOTFOUND api.ai.sakura.ad.jp</span>')
    // 文の側には詳細の行が混ざらない（FailureLines が文と詳細を分けて描く）
    expect(h.indexOf(SENTENCE)).toBeLessThan(h.indexOf('詳細: '))
  })

  it('children のボタンは、文のあと・詳細の行の前に出る（詳細の下へ押し出さない）', () => {
    const h = renderToStaticMarkup(
      React.createElement(ErrorBand, { text: shown }, React.createElement('button', null, '認証情報を開く')))
    expect(h.indexOf(SENTENCE)).toBeLessThan(h.indexOf('認証情報を開く'))
    expect(h.indexOf('認証情報を開く')).toBeLessThan(h.indexOf('詳細: '))
  })

  it('詳細が無い文には詳細の行を足さない', () => {
    const h = renderToStaticMarkup(React.createElement(ErrorBand, { text: '接続できません' }))
    expect(h).not.toContain('詳細: ')
    expect(h).not.toContain('text-[10px]')
  })

  it('tone=text（接続テストの結果）でも詳細の行が出る', () => {
    const h = renderToStaticMarkup(React.createElement(ErrorBand, { text: `❌ ${shown}`, tone: 'text' }))
    expect(h).toContain('❌ ' + SENTENCE)
    expect(h).toContain('>詳細: getaddrinfo ENOTFOUND api.ai.sakura.ad.jp</span>')
  })
})

describe('コピー', () => {
  it('コピーは共通の CopyButton に帯の文そのものを渡す（自前のボタンを持たない）', () => {
    const src = read('ErrorBand.tsx')
    // 押したときに、文・詳細・Koto の版・日時を写す文を作る（text だけを写す直す前の形は禁じる）
    expect(src).toContain('<CopyButton text={text} getText={() => failureCopyNow(text)} className={buttonClass} />')
    expect(src).not.toContain('<CopyButton text={text} className={buttonClass} />')
    expect(src).not.toContain('navigator.clipboard')
    expect(src).not.toContain('<button')
  })

  it('ほかの画面のコピーと同じ言い方（題は「このメッセージをコピー」）', () => {
    const h = renderToStaticMarkup(React.createElement(ErrorBand, { text: '失敗の文' }))
    expect(h).toContain('title="このメッセージをコピー"')
    expect(h).not.toContain('title="メッセージをコピー"')
  })
})

describe('12か所が ErrorBand を使う', () => {
  const SITES: Array<[string, string, number]> = [
    ['NewProjectModal.tsx', '<ErrorBand text={error} className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2" />', 1],
    ['ImportFromPublishedPanel.tsx', '<ErrorBand text={error}>', 1],
    ['AccessKeySection.tsx', '<ErrorBand text={test.message} />', 1],
    ['ServerFilesModal.tsx', '<ErrorBand text={connMsg} />', 1],
    ['ServerFilesModal.tsx', '<ErrorBand text={listError} />', 1],
    ['PublishModal.tsx', '<ErrorBand text={error} className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2" />', 1],
    ['AppRunPanel.tsx', '<ErrorBand text={envError} className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed break-all" />', 2],
    ['AppRunPanel.tsx', '<ErrorBand text={planError} className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed break-all" />', 1],
    ['AiMessage.tsx', '<ErrorBand text={err} className="px-3 py-1.5 text-[11px] text-white bg-brand-red-fill" />', 1],
    ['CredentialsTestButtons.tsx', '{state === \'ng\' && <ErrorBand tone="text" text={`❌ ${detail}`} />}', 2],
    ['OnboardingModal.tsx', '<ErrorBand tone="text" className="text-xs mt-3 text-brand-red" text={result.msg} />', 1],
  ]
  it.each(SITES)('%s は %s を使う', (file, shape, count) => {
    const src = read(file)
    expect(src.split(shape).length - 1).toBe(count)
    expect(src).toContain("import ErrorBand from './ErrorBand'")
  })

  it('元の直書き（赤い塗りの帯・選択できない赤い文字）は残っていない', () => {
    const files = ['NewProjectModal.tsx', 'ImportFromPublishedPanel.tsx', 'AccessKeySection.tsx', 'ServerFilesModal.tsx',
      'PublishModal.tsx', 'AiMessage.tsx', 'OnboardingModal.tsx']
    for (const f of files) {
      expect(read(f), f).not.toMatch(/<(p|div) className="[^"]*bg-brand-red-fill/)
    }
    // AppRunPanel の赤い塗りの帯は ErrorBand 以外では、文を持たない見出し（データ削除の注意・バッジ・ボタン）だけ
    const app = read('AppRunPanel.tsx')
    expect(app).not.toMatch(/<p className="[^"]*bg-brand-red-fill[^"]*">\{(envError|planError)\}/)
    expect(app).not.toContain('{envError}</p>')
    expect(app).not.toContain('{planError}</p>')
    expect(read('CredentialsTestButtons.tsx')).not.toContain('<span className="text-[11px] text-brand-red">❌ {detail}</span>')
  })
})
