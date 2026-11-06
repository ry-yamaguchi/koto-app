import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 画面の入口（index.html）が、外のサーバーへ向かう記述を持たないこと ─────────────────
// Koto は「画面を開いただけでは外へ出ない」作り（フォントも同梱のものを使う）。
// 外のサーバーを指す <link rel="preconnect"> は、使うあてが無いので消した。消すのは無害。
// 本番の設定で実際に接続していたかは確かめていない。
// 一度消したものが書き戻されないよう、index.html の文字列そのものを見る
// （配布物の dist/renderer/index.html は build の出力なので、ここでは見ない）。

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf-8')

describe('index.html は外のサーバーを指さない', () => {
  it('★ http:// / https:// で始まる URL が1つも無い', () => {
    expect(html).not.toMatch(/https?:\/\//i)
  })

  it('プロトコル省略形（//host/...）の参照も無い', () => {
    // src / href / content の値が // で始まるもの（同じ場所の相対パスは / 1つなので当たらない）
    expect(html).not.toMatch(/\b(?:src|href|content)\s*=\s*["']\/\//i)
  })

  it('接続の先読み（preconnect / dns-prefetch / prefetch / preload）が無い', () => {
    expect(html).not.toMatch(/rel\s*=\s*["'][^"']*\b(?:preconnect|dns-prefetch|prefetch|preload)\b/i)
  })

  it('消した行の形（fonts.googleapis.com への preconnect）が戻っていない', () => {
    expect(html).not.toContain('fonts.googleapis.com')
    expect(html).not.toContain('fonts.gstatic.com')
    expect(html).not.toContain('<link rel="preconnect"')
  })

  it('本物の入口は残っている（空にして通ってしまわない）', () => {
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('<script type="module" src="/src/renderer/main.tsx"></script>')
    expect(html).toContain('<title>Koto</title>')
  })
})
