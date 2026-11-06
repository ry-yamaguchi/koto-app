import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { maskHomePath } from '../src/shared/homePath'

// 診断の記録（crash.log）に書く文から、ホームのパス（利用者名）を `~` に置き換える純関数の試験。
// 記録は利用者が作者へ送るもので、貼り付け先が公開の場所のこともある。使い方（書く直前に通すこと）は tests/crashGuard.test.ts が固定する。

describe('maskHomePath', () => {
  const CASES: Array<{ label: string; text: string; home?: string; masked: string }> = [
    { label: 'エラーの文に入るパス（引用符の中）', text: "ENOENT: no such file or directory, open '/Users/tanaka/Projects/A社サイト/.sakuraide.json'", masked: "ENOENT: no such file or directory, open '~/Projects/A社サイト/.sakuraide.json'" },
    { label: 'スタックの各行（括弧の中）', text: 'Error: x\n    at read (/Users/tanaka/sakura-ide/dist/main/a.js:10:5)\n    at async /Users/tanaka/sakura-ide/dist/main/b.js:3:1', masked: 'Error: x\n    at read (~/sakura-ide/dist/main/a.js:10:5)\n    at async ~/sakura-ide/dist/main/b.js:3:1' },
    { label: '利用者名にドットやハイフンが入る', text: 'open /Users/taro.yamada-2/Documents/x.txt', masked: 'open ~/Documents/x.txt' },
    { label: '利用者名だけ（その下が無い）', text: 'cwd=/Users/tanaka', masked: 'cwd=~' },
    { label: '1行に2つ', text: 'copy /Users/a/x to /Users/b/y', masked: 'copy ~/x to ~/y' },
    { label: 'file URL', text: 'file:///Users/tanaka/Projects/index.html', masked: 'file://~/Projects/index.html' },
    { label: '/Users の外のパスは変えない', text: 'open /Applications/Koto.app/Contents/Resources/app.asar/dist/main/main.js', masked: 'open /Applications/Koto.app/Contents/Resources/app.asar/dist/main/main.js' },
    { label: 'URL の途中の /Users/ は変えない', text: 'GET https://example.com/Users/profile', masked: 'GET https://example.com/Users/profile' },
    { label: '名前の一部（Users）は変えない', text: 'see /MyUsers/x and DataUsers/y', masked: 'see /MyUsers/x and DataUsers/y' },
    { label: 'ホームが /Users の外（home を渡したとき）', text: "open '/var/folders/zz/tanaka-home/Projects/a.txt'", home: '/var/folders/zz/tanaka-home', masked: "open '~/Projects/a.txt'" },
    { label: 'ホームの末尾の / は無視する', text: 'open /var/folders/zz/tanaka-home/a.txt', home: '/var/folders/zz/tanaka-home/', masked: 'open ~/a.txt' },
    { label: 'ホームと名前が前方一致するだけの別のフォルダは変えない', text: 'open /var/folders/zz/tanaka-home-backup/a.txt', home: '/var/folders/zz/tanaka-home', masked: 'open /var/folders/zz/tanaka-home-backup/a.txt' },
    { label: 'ホームがルートのときは何もしない', text: 'open /etc/hosts', home: '/', masked: 'open /etc/hosts' },
    { label: 'ホームが空のときも落ちない', text: 'open /etc/hosts', home: '', masked: 'open /etc/hosts' },
    { label: 'ホームの文字列に正規表現の特別な字が入っていても、その字として探す', text: 'open /srv/a+b(1)/x and /srv/aab1/x', home: '/srv/a+b(1)', masked: 'open ~/x and /srv/aab1/x' },
  ]

  for (const c of CASES) {
    it(c.label, () => {
      expect(maskHomePath(c.text, c.home)).toBe(c.masked)
      // もう一度かけても変わらない
      expect(maskHomePath(c.masked, c.home)).toBe(c.masked)
    })
  }

  it('空・未定義でも落ちない', () => {
    expect(maskHomePath('')).toBe('')
    expect(maskHomePath(undefined as unknown as string)).toBe('')
    expect(maskHomePath('x', undefined)).toBe('x')
  })

  it('長い入力でも時間がかからない', () => {
    const start = Date.now()
    maskHomePath('/Users/a/'.repeat(100_000))
    maskHomePath('a'.repeat(1_000_000), '/Users/a')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('★ ホームのパスを置き換える関数は、ここだけ。src の中に `/Users/` を探す正規表現の複製が無い', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(join(__dirname, '..', d), { withFileTypes: true })) e.isDirectory() ? walk(`${d}/${e.name}`) : files.push(`${d}/${e.name}`)
    }
    walk('src')
    const dupes = files
      .filter(f => /\.tsx?$/.test(f) && f !== 'src/shared/homePath.ts')
      .filter(f => readFileSync(join(__dirname, '..', f), 'utf-8').includes('\\/Users\\/'))
    expect(dupes).toEqual([])
  })
})
