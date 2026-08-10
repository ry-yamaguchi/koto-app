import { describe, it, expect } from 'vitest'
import { applyEdit } from '../src/renderer/editFile'

// edit_file ツール（部分編集）の置換ロジック。write_file の全文書き直しに代わる新ツールで、
// old_string は正規表現ではなく単純なリテラル文字列一致で扱う（重要: 特殊文字がそのまま一致すること）。

describe('applyEdit - 基本の置換', () => {
  it('1件一致で置換でき、件数を返す', () => {
    const r = applyEdit('const a = 1\nconst b = 2\n', 'const a = 1', 'const a = 100')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.next).toBe('const a = 100\nconst b = 2\n')
      expect(r.count).toBe(1)
    }
  })

  it('old_stringが空なら empty-old', () => {
    const r = applyEdit('hello world', '', 'x')
    expect(r).toEqual({ ok: false, reason: 'empty-old', count: 0 })
  })

  it('old_stringとnew_stringが同じなら no-change', () => {
    const r = applyEdit('hello world', 'hello', 'hello')
    expect(r).toEqual({ ok: false, reason: 'no-change', count: 0 })
  })

  it('一致が0件なら not-found', () => {
    const r = applyEdit('hello world', 'goodbye', 'x')
    expect(r).toEqual({ ok: false, reason: 'not-found', count: 0 })
  })

  it('削除（new_stringが空文字）もできる', () => {
    const r = applyEdit('foo-bar-baz', '-bar', '')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.next).toBe('foo-baz')
  })
})

describe('applyEdit - 複数一致の扱い', () => {
  it('2件以上でreplaceAll未指定（false）なら ambiguous（件数も返る）', () => {
    const r = applyEdit('foo foo foo', 'foo', 'bar')
    expect(r).toEqual({ ok: false, reason: 'ambiguous', count: 3 })
  })

  it('2件以上でreplaceAll=trueなら全件置換する', () => {
    const r = applyEdit('foo foo foo', 'foo', 'bar', true)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.next).toBe('bar bar bar')
      expect(r.count).toBe(3)
    }
  })

  it('1件一致ならreplaceAll=trueでも同じ結果になる', () => {
    const r = applyEdit('only one match here', 'match', 'hit', true)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.next).toBe('only one hit here')
      expect(r.count).toBe(1)
    }
  })
})

describe('applyEdit - 複数行のold_string', () => {
  it('改行を含む複数行のold_stringでも置換できる', () => {
    const content = 'function foo() {\n  return 1\n}\n\nfunction bar() {\n  return 2\n}\n'
    const oldString = 'function foo() {\n  return 1\n}'
    const newString = 'function foo() {\n  return 100\n}'
    const r = applyEdit(content, oldString, newString)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.next).toContain('return 100')
      expect(r.next).toContain('function bar() {\n  return 2\n}')
      expect(r.count).toBe(1)
    }
  })
})

describe('applyEdit - 正規表現の特殊文字はリテラル扱い', () => {
  it('. * $ ( ) 等を含む文字列が正規表現として解釈されず、そのまま一致する', () => {
    const content = 'price: $10.50 (tax incl.)\nother: $10450 (tax incl.)\n'
    // 正規表現として解釈されるなら "$10.50 (tax incl.)" は "." がワイルドカードになり
    // 2行目の "$10450 (tax incl.)" 等にも誤って一致しうるが、リテラル一致ならこの1件だけに一致する。
    const oldString = '$10.50 (tax incl.)'
    const r = applyEdit(content, oldString, '$12.00 (tax incl.)')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.count).toBe(1)
      expect(r.next).toBe('price: $12.00 (tax incl.)\nother: $10450 (tax incl.)\n')
    }
  })

  it('正規表現的に無効なパターン（閉じていない括弧等）でもエラーにならず一致判定できる', () => {
    const content = 'array[0] = (a + b'
    const r = applyEdit(content, '(a + b', '(a + c')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.next).toBe('array[0] = (a + c')
  })
})
