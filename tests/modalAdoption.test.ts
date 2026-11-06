import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// ── 窓の作り方の固定（0.6.26）─────────────────────────────────────────────────────────────
// 窓は src/renderer/ui/Modal.tsx で作る。この試験は src/renderer の全ファイルを読み、次を守らせる。
//   ・手書きの覆い（fixed inset-0）が ui/Modal.tsx にしか出ない
//   ・ブラウザ標準の alert / confirm の呼び出しが 0 件（確認は ConfirmModal、失敗の通知は notify）
//   ・窓（ui/Modal を使うファイル）の ✕ / × のボタンに aria-label がある

const RENDERER = join(__dirname, '..', 'src', 'renderer')

function listSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listSources(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const files = listSources(RENDERER).map(p => ({ path: relative(RENDERER, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

/** 行コメントと ブロックコメントの中の言及は数えない（窓の決まりを説明する文があってよい）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, (_, a) => a)
}

/** `fixed` と `inset-0` が同じ class の並びに両方ある（順不同）。 */
const HAND_WRITTEN_OVERLAY = /(?:\bfixed\b[^"'`\n]*\binset-0\b|\binset-0\b[^"'`\n]*\bfixed\b)/
/** 窓の ✕ ボタン。onClick={() => ...} の => で打ち切られないよう、=> は属性の一部として読む。 */
const CLOSE_BUTTON = /<button\b((?:=>|[^>])*)>\s*[✕×]\s*<\/button>/g
const WINDOW_DIALOG_CALL = /\bwindow\s*\.\s*(?:alert|confirm)\s*\(/
const BARE_ALERT_CALL = /(^|[^\w.$])alert\s*\(/

describe('窓の作り方（src/renderer 全体）', () => {
  it('src/renderer のファイルを読めている（空の検査で通らない）', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some(f => f.path === 'ui/Modal.tsx')).toBe(true)
  })

  it('手書きの覆い（fixed inset-0）は ui/Modal.tsx にだけある', () => {
    const hits = files.filter(f => HAND_WRITTEN_OVERLAY.test(stripComments(f.text))).map(f => f.path)
    expect(hits).toEqual(['ui/Modal.tsx'])
  })

  it('ブラウザ標準の alert / confirm（window 付き）は 0 件', () => {
    const hits = files.filter(f => WINDOW_DIALOG_CALL.test(stripComments(f.text))).map(f => f.path)
    expect(hits).toEqual([])
  })

  it('window を付けない alert の呼び出しも 0 件', () => {
    const hits = files.filter(f => BARE_ALERT_CALL.test(stripComments(f.text))).map(f => f.path)
    expect(hits).toEqual([])
  })

  it('窓（ui/Modal を使うファイル）の ✕ と × のボタンはすべて aria-label を持つ', () => {
    const windows = files.filter(f => /from ['"][^'"]*ui\/Modal['"]/.test(f.text))
    expect(windows.length).toBeGreaterThanOrEqual(10)
    const bad: string[] = []
    let seen = 0
    for (const f of windows) {
      const re = new RegExp(CLOSE_BUTTON)
      let m: RegExpExecArray | null
      while ((m = re.exec(f.text))) {
        seen++
        if (!/aria-label=/.test(m[1])) bad.push(f.path)
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8)
    expect(bad).toEqual([])
  })

  it('✕ ボタンの検査はアロー関数の onClick も拾い、aria-label の無いものを見つける', () => {
    const re = new RegExp(CLOSE_BUTTON)
    const src = '<button onClick={() => onClose()} className="x">✕</button>'
    const m = re.exec(src)
    expect(m).not.toBeNull()
    expect(/aria-label=/.test(m![1])).toBe(false)
  })

  it('検査の正規表現が書き方の違いを拾う（順不同・絶対位置の別物は除く）', () => {
    expect(HAND_WRITTEN_OVERLAY.test('<div className="fixed inset-0 z-50 bg-black/50">')).toBe(true)
    expect(HAND_WRITTEN_OVERLAY.test('<div className="inset-0 flex fixed">')).toBe(true)
    expect(HAND_WRITTEN_OVERLAY.test('<div className="absolute inset-0 z-30">')).toBe(false)
    expect(WINDOW_DIALOG_CALL.test('window.' + 'alert("x")')).toBe(true)
    expect(BARE_ALERT_CALL.test('  ' + 'alert("x")')).toBe(true)
    expect(BARE_ALERT_CALL.test('notify("x")')).toBe(false)
  })
})
