// D-16 C: 開発用サーバーの見張りを狭める（2026-09-16）。
// 文書を1文直すたびに画面が丸ごと読み込み直され、操作の途中の状態が消えていた。
// ここでは「外したもの」と「**外していないもの**」を固定する（src や index.html を
// うっかり外すと、直しても画面に出ない＝原因の分かりにくい不具合になる）。
// vite.config.ts は plugin を読み込むため import せず、本文を読んで確かめる（他のテストと同じ流儀）。
import * as fs from 'fs'
import * as path from 'path'
import { describe, it, expect } from 'vitest'

const src = fs.readFileSync(path.join(__dirname, '..', 'vite.config.ts'), 'utf-8')
/** server.watch.ignored の中身（配列リテラルの本文）だけを取り出す。 */
const ignoredBlock = (() => {
  const m = src.match(/ignored:\s*\[([\s\S]*?)\]/)
  return m ? m[1] : ''
})()

describe('vite の開発用サーバー: 見張りから外すもの', () => {
  it('画面に関係しないものを外している', () => {
    expect(ignoredBlock).not.toBe('')
    for (const pattern of ['docs/**', 'README.md', 'CHANGELOG.md', '.git/**', 'dist/**', 'build/**', 'scripts/**', 'tests/**', '*.md']) {
      expect(ignoredBlock).toContain(pattern)
    }
  })

  it('画面に関係するものは外していない（src・index.html・vite.config.ts 自身・package.json）', () => {
    for (const keep of ['src/', 'index.html', 'vite.config', 'package.json']) {
      expect(ignoredBlock).not.toContain(keep)
    }
  })

  it('配布版の設定ではない（server の下にある＝開発用サーバー限定）', () => {
    const serverIdx = src.indexOf('server: {')
    const ignoredIdx = src.indexOf('ignored:')
    expect(serverIdx).toBeGreaterThanOrEqual(0)
    expect(ignoredIdx).toBeGreaterThan(serverIdx)
    expect(src.indexOf('build: {')).toBeLessThan(serverIdx) // build の設定には入れていない
  })
})
