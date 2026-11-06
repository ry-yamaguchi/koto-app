import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ErrorBoundary, { AppCrashView, RegionCrashView, readThemeClass } from '../src/renderer/components/ErrorBoundary'
import { buildCrashReport } from '../src/shared/crashReport'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ErrorBoundary: 状態遷移', () => {
  it('getDerivedStateFromError は例外を状態に載せる', () => {
    const err = new Error('boom')
    expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err, hasError: true })
  })

  it('componentDidCatch は記録だけで、状態を動かさない', () => {
    const b = new ErrorBoundary({ scope: 'region' })
    const setState = vi.spyOn(b, 'setState')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    b.componentDidCatch(new Error('x'), { componentStack: 'at Foo' } as any)
    expect(log).toHaveBeenCalledTimes(1)
    expect(setState).not.toHaveBeenCalled()
  })

  it('retry は例外を消し、key を付け替える（中の部品を作り直す）', () => {
    const b = new ErrorBoundary({ scope: 'region' })
    b.state = { error: new Error('x'), hasError: true, resetKey: 0 }
    b.setState = ((fn: any) => { b.state = { ...b.state, ...fn(b.state) } }) as any
    b.retry()
    expect(b.state).toEqual({ error: null, hasError: false, resetKey: 1 })
  })

  it('例外が無いときは子をそのまま描き、あるときは代わりの表示を描く', () => {
    const ok = new ErrorBoundary({ scope: 'region', children: createElement('p', null, 'ふつう') })
    expect(renderToStaticMarkup(ok.render() as any)).toContain('ふつう')
    const ng = new ErrorBoundary({ scope: 'region', children: createElement('p', null, 'ふつう') })
    ng.state = { error: new Error('x'), hasError: true, resetKey: 0 }
    const html = renderToStaticMarkup(ng.render() as any)
    expect(html).not.toContain('ふつう')
    expect(html).toContain('この部分を読み込み直す')
  })
})

describe('表示の文', () => {
  it('全体の表示に「保存していない編集」の文と2つのボタンがある', () => {
    const html = renderToStaticMarkup(createElement(AppCrashView, { error: new Error('x'), themeClass: 'theme-light', onReload: () => {} }))
    expect(html).toContain('もう一度読み込むと、保存していない編集は失われます。')
    expect(html).toContain('もう一度読み込む')
    expect(html).toContain('診断情報をコピー')
    expect(html).toContain('theme-light')
  })

  it('領域の表示は「この部分を読み込み直す」', () => {
    const html = renderToStaticMarkup(createElement(RegionCrashView, { error: new Error('x'), onRetry: () => {} }))
    expect(html).toContain('この部分を読み込み直す')
    expect(html).not.toContain('保存していない編集')
  })

  it('テーマ: 保存がダークなら theme-light を付けず、ライト・未設定・読めないときは付ける', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'dark' })
    expect(readThemeClass()).toBe('')
    vi.stubGlobal('localStorage', { getItem: () => 'light' })
    expect(readThemeClass()).toBe('theme-light')
    vi.stubGlobal('localStorage', { getItem: () => null })
    expect(readThemeClass()).toBe('theme-light')
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') } })
    expect(readThemeClass()).toBe('theme-light')
  })
})

describe('crashReport: 診断情報', () => {
  const err = Object.assign(new Error('失敗 token=abcdefghijklmnop12345 /Users/taro/proj/a.ts'), {
    stack: 'Error: x\n    at f (/Users/taro/proj/a.ts:1:1)\n' + Array.from({ length: 20 }, (_, i) => `    at g${i} (/Users/taro/b.ts)`).join('\n'),
  })

  it('版・OS・エラー名・メッセージ・スタックの先頭だけを入れる', () => {
    const t = buildCrashReport({ version: '0.6.26', platform: 'MacIntel', error: err })
    expect(t).toContain('Koto 0.6.26')
    expect(t).toContain('OS: MacIntel')
    expect(t).toContain('エラー: Error')
    expect(t).toContain('メッセージ:')
    expect(t).toContain('at g0')
    expect(t).not.toContain('at g19')
  })

  it('秘密を伏せる', () => {
    const t = buildCrashReport({ error: err })
    expect(t).not.toContain('abcdefghijklmnop12345')
    expect(t).toContain('***')
  })

  it('ホームのパスを ~ に置き換える', () => {
    const t = buildCrashReport({ error: err })
    expect(t).not.toContain('/Users/taro')
    expect(t).toContain('~/proj/a.ts')
  })

  it('Error でない値が投げられても作れる', () => {
    expect(buildCrashReport({ error: 'text only' })).toContain('メッセージ: text only')
    expect(buildCrashReport({ error: undefined })).toContain('エラー: Error')
  })
})

describe('つなぎ込み（呼び口の形）', () => {
  it('main.tsx は App を全体の枠で包む', () => {
    const src = read('src/renderer/main.tsx')
    expect(src).toContain('<ErrorBoundary scope="app">')
    expect(src).toMatch(/<ErrorBoundary scope="app">\s*<App \/>\s*<\/ErrorBoundary>/)
  })

  it('App.tsx は5領域を領域の枠で包み、エディタは Suspense の外側', () => {
    const src = read('src/renderer/App.tsx')
    expect((src.match(/<ErrorBoundary scope="region">/g) ?? []).length).toBe(5)
    for (const inner of ['<ChatApp ', '<Sidebar\n', '<TerminalPanel ', '<ChatPanel ']) {
      const i = src.indexOf(inner)
      expect(i, inner).toBeGreaterThan(0)
      expect(src.lastIndexOf('<ErrorBoundary scope="region">', i)).toBeGreaterThan(src.lastIndexOf('</ErrorBoundary>', i))
    }
    expect(src).toMatch(/<ErrorBoundary scope="region">\s*<Suspense[\s\S]*?<\/Suspense>\s*<\/ErrorBoundary>/)
  })
})
