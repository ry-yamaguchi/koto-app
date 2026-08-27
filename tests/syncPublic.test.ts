import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
// @ts-expect-error — ビルド用スクリプト（型定義は持たない）
import { findLocalIdentifiers } from '../scripts/sync-public.mjs'

// ── なぜ要るか（2026-08-26、scripts/look-renderer.mjs で発覚）───────────────
// 公開用リポジトリへは src/tests/scripts/build/.github が丸ごとコピーされる。
// 開発者のホームディレクトリの絶対パスが look-renderer.mjs に埋まったまま
// 公開されかけたが、気づいたのは偶然だった。sync-public.mjs は当時、
// ファイル単位の除外（MUST_NOT_PUBLISH）しか見ておらず、中身を見ていなかった。
// **気づかなくても止まる**ようにするのがこのテストの対象（findLocalIdentifiers）。

describe('findLocalIdentifiers — その環境でしか意味を持たない文字列を探す', () => {
  const HOME = { label: 'ホームディレクトリの絶対パス', value: '/Users/somebody' }
  const HOST = { label: 'マシン名', value: 'somebodys-mac' }

  it('当たらないテキストでは空配列', () => {
    expect(findLocalIdentifiers('ただの文章です\nどこにも当たりません', [HOME, HOST])).toEqual([])
  })

  it('ホームディレクトリの絶対パスが1行にあれば、その行番号と label を返す', () => {
    const text = ['1行目', '2行目 /Users/somebody/repo/src/index.ts にあった', '3行目'].join('\n')
    expect(findLocalIdentifiers(text, [HOME])).toEqual([{ line: 2, label: 'ホームディレクトリの絶対パス' }])
  })

  it('複数行・複数パターンでも全部返す', () => {
    const text = [
      'ここは無関係',
      '/Users/somebody/project にある',
      'まだ無関係',
      'マシン名は somebodys-mac です',
    ].join('\n')
    expect(findLocalIdentifiers(text, [HOME, HOST])).toEqual([
      { line: 2, label: 'ホームディレクトリの絶対パス' },
      { line: 4, label: 'マシン名' },
    ])
  })

  // os.hostname() が空文字を返す環境（コンテナ等）で、全行が空文字にマッチしてしまうのを防ぐ
  it('value が空文字のパターンは無視する', () => {
    const text = 'なんでもない1行だけの文章'
    expect(findLocalIdentifiers(text, [{ label: '空のパターン', value: '' }])).toEqual([])
    expect(findLocalIdentifiers(text, [{ label: '空のパターン', value: '' }, HOME])).toEqual([])
  })

  // ログに残すと意味が無いので、当たった値そのものは戻り値に含めない
  it('戻り値に値そのものを含めない', () => {
    const text = '/Users/somebody/secret にある'
    const hits = findLocalIdentifiers(text, [HOME])
    expect(hits).toEqual([{ line: 1, label: 'ホームディレクトリの絶対パス' }])
    expect(JSON.stringify(hits)).not.toContain('/Users/somebody')
  })

  it('1行に2つ当たったら2件返す', () => {
    const text = '/Users/somebody で somebodys-mac が動いている'
    expect(findLocalIdentifiers(text, [HOME, HOST])).toEqual([
      { line: 1, label: 'ホームディレクトリの絶対パス' },
      { line: 1, label: 'マシン名' },
    ])
  })
})

// ── 配線（画面は無いのでソースを読んで固定。掟10）─────────────────────────
// 当て先は呼び出しの形ごと一意に指す。コメントは戒めとして本文に厚く残っているので、
// 剥がしてから見る（adoptAppRun.test.ts と同じ流儀）。
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('sync-public.mjs の配線', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'scripts/sync-public.mjs'), 'utf-8')
  const src = readCode('scripts/sync-public.mjs')

  it('os.homedir() と os.hostname() を実行時に呼んでいる', () => {
    expect(src).toContain('os.homedir()')
    expect(src).toContain('os.hostname()')
  })

  // ⚠️ このスクリプト自身も公開される。探す文字列（絶対パス）をソースに直接書くと、
  // 書いた瞬間にそれが公開される。コメントも含め、ソース全体にリテラルが無いことを確かめる
  // （実行時に os.homedir() で求めていれば、このテストのように `/Users/` が書かれていても
  //   それは値ではなく本テストのコメント側の話であり、対象は sync-public.mjs 側）。
  it('探す文字列がソースに直書きされていない（絶対パスのリテラルが無い）', () => {
    expect(/\/Users\/[A-Za-z0-9_.-]/.test(raw)).toBe(false)
  })

  it('見つかったら process.exit(1) している', () => {
    const idx = src.indexOf('if (hits.length) {')
    expect(idx).toBeGreaterThan(-1)
    expect(src.slice(idx, idx + 300)).toContain('process.exit(1)')
  })

  it('走査は assertNoLocalIdentifiers 経由で、直接値をソースに置かない呼び出しになっている', () => {
    expect(src).toContain("{ label: 'ホームディレクトリの絶対パス', value: os.homedir() }")
    expect(src).toContain("{ label: 'マシン名', value: os.hostname().replace(/\\.local$/, '') }")
  })
})
