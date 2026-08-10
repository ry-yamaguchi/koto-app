import { describe, it, expect } from 'vitest'
import { looksLikePath, mergePathEntries, loginPathArgs } from '../src/main/loginPath'

// 2026-08-01: GUI起動時にPATHが最小限になり、Homebrewで入れた node/npm/docker が
// 「入っているのに見つからない」問題への対処（loginPath.ts）の純粋ロジック。

describe('looksLikePath', () => {
  it('絶対パスを含むコロン区切りならPATHとみなす', () => {
    expect(looksLikePath('/opt/homebrew/bin:/usr/bin:/bin')).toBe(true)
    expect(looksLikePath('/usr/bin')).toBe(true)
  })

  it('空・非文字列・絶対パスを含まないものは拒否する', () => {
    expect(looksLikePath('')).toBe(false)
    expect(looksLikePath('   ')).toBe(false)
    expect(looksLikePath(undefined)).toBe(false)
    expect(looksLikePath(null)).toBe(false)
    expect(looksLikePath('bin:usr')).toBe(false)
  })

  it('複数行は拒否する（プロファイルの出力が混ざった場合を採用しない）', () => {
    expect(looksLikePath('ようこそ！\n/opt/homebrew/bin:/usr/bin')).toBe(false)
  })
})

describe('mergePathEntries', () => {
  it('先に渡したものを優先し、重複を除いて連結する', () => {
    expect(mergePathEntries('/a:/b', '/b:/c')).toBe('/a:/b:/c')
  })

  it('空文字・undefined・空要素を無視する', () => {
    expect(mergePathEntries('/a', '', undefined, '/a:/b:')).toBe('/a:/b')
    expect(mergePathEntries()).toBe('')
  })

  it('元のPATHを捨てない（開発時に端末から起動した環境を壊さないため）', () => {
    const login = '/opt/homebrew/bin:/usr/bin:/bin'
    const before = '/usr/bin:/bin:/my/custom/tool'
    expect(mergePathEntries(login, before)).toBe('/opt/homebrew/bin:/usr/bin:/bin:/my/custom/tool')
  })

  it('実在する定番ディレクトリを末尾に足せる', () => {
    expect(mergePathEntries('/usr/bin', '', '/opt/homebrew/bin')).toBe('/usr/bin:/opt/homebrew/bin')
  })
})

describe('loginPathArgs', () => {
  it('zsh/bash はログインシェルで PATH を出力する', () => {
    expect(loginPathArgs('/bin/zsh')).toEqual(['-l', '-c', 'printf %s "$PATH"'])
    expect(loginPathArgs('/bin/bash')).toEqual(['-l', '-c', 'printf %s "$PATH"'])
  })

  it('fish は $PATH がリスト変数なので : で連結する', () => {
    expect(loginPathArgs('/opt/homebrew/bin/fish')).toEqual(['-l', '-c', 'string join : $PATH'])
  })

  it('シェルが空でも既定の形を返す', () => {
    expect(loginPathArgs('')).toEqual(['-l', '-c', 'printf %s "$PATH"'])
  })
})
