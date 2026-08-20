import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// テーマの色が「読める」ことを固定する（2026-08-20 Ryosuke 指摘）。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
// `.theme-light` が補助色（--green / --red / --yellow …）を**一つも再定義していなかった**ため、
// ダーク用に選んだ明るい色が白地にそのまま載り、**ライトモードでは読めなかった**
// （実測: 緑 1.67 / 水 1.05 / 黄 1.76。読みやすさの目安は 4.5:1）。
// 「✅ すべて確認できました」「⚠️ 除外」などが薄くて見えない状態が、気づかれないまま続いていた。
//
// 色は目で見て決めるものだが、**読めるかどうかは計算できる**。
// テーマや色を足したときに黙って壊れないよう、ここで数値として固定する。
//
// あわせて、掟5 の「`--xxx` と `--xxx-rgb` は必ず同じ色を指すこと」も検査する
// （ズレるとテーマ間で色が食い違い、不透明度付きの指定だけが別の色になる）。

const CSS = readFileSync(join(__dirname, '../src/renderer/index.css'), 'utf-8')

/** `:root { … }` / `.theme-light { … }` の中身を取り出す。 */
function block(selector: string): string {
  const i = CSS.indexOf(selector)
  expect(i, `${selector} が index.css に無い`).toBeGreaterThanOrEqual(0)
  const start = CSS.indexOf('{', i)
  const end = CSS.indexOf('\n}', start)
  return CSS.slice(start, end)
}

function varOf(src: string, name: string): string | null {
  // 最後の定義を採る（同じブロック内で上書きされていてもよい）
  const m = [...src.matchAll(new RegExp(`--${name}\\s*:\\s*([^;]+);`, 'g'))]
  return m.length ? m[m.length - 1][1].trim() : null
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

function triple(s: string): [number, number, number] {
  const n = s.split(/\s+/).map(Number)
  expect(n).toHaveLength(3)
  return n as [number, number, number]
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** 読みやすさの目安（WCAG AA の通常サイズ）。 */
const MIN = 4.5

const THEMES = [
  { name: 'ダーク（:root）', selector: ':root {' },
  { name: 'ライト（.theme-light）', selector: '.theme-light {' },
]

/** 文字色として使う補助色（text-brand-* として実際に使われているもの）。 */
const BRAND = ['green', 'blue', 'yellow', 'orange', 'cyan', 'red'] as const

/** その色が載る地色。 */
const BACKGROUNDS = ['bg-base', 'bg-surface', 'bg-elevated', 'bg-overlay'] as const

describe.each(THEMES)('$name', ({ selector }) => {
  const src = block(selector)

  it.each([...BRAND])('--%s が、どの地色の上でも読める', (name) => {
    const hex = varOf(src, name)
    expect(hex, `--${name} が定義されていない（ダーク用の色がそのまま使われてしまう）`).toBeTruthy()
    const fg = hexToRgb(hex!)
    for (const bgName of BACKGROUNDS) {
      const bg = varOf(src, bgName)
      expect(bg, `--${bgName} が定義されていない`).toBeTruthy()
      const r = contrast(fg, hexToRgb(bg!))
      expect(r, `--${name} を --${bgName} の上に置くと ${r.toFixed(2)}:1（目安 ${MIN}:1）`).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('本文の色が、どの地色の上でも読める', () => {
    const fg = hexToRgb(varOf(src, 'text-primary')!)
    for (const bgName of BACKGROUNDS) {
      expect(contrast(fg, hexToRgb(varOf(src, bgName)!))).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('--xxx と --xxx-rgb が同じ色を指す（掟5）', () => {
    const names = [...src.matchAll(/--([a-z-]+)-rgb\s*:/g)].map(m => m[1])
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) {
      const hex = varOf(src, n)
      if (!hex || !hex.startsWith('#')) continue // hex を持たない組（--sakura-glow 等）は対象外
      expect(triple(varOf(src, `${n}-rgb`)!), `--${n} と --${n}-rgb がズレている`).toEqual(hexToRgb(hex))
    }
  })
})

// ── 明るいテーマだけの約束 ────────────────────────────────────────────
// 補助色は背景としても使われる（`bg-brand-red/90 text-white` など）。
// ライトの色は「文字として読めるところまで暗くした」結果、白文字を載せても読める。
// **ダークの色ではこれは成り立たない**（実測: 白文字 × --red で 3.08:1、--green で 1.77:1）。
// これは今回の変更で生じたものではなく、以前からある別の課題なので、
// ここでは**成り立っている側だけ**を固定する（成り立たないことを黙って通さないための記録も兼ねる）。
describe('ライト（.theme-light）の補助色は、背景としても使える', () => {
  const src = block('.theme-light {')
  it.each([...BRAND])('--%s の上の白文字が読める', (name) => {
    expect(contrast(hexToRgb(varOf(src, name)!), [255, 255, 255])).toBeGreaterThanOrEqual(MIN)
  })
})
