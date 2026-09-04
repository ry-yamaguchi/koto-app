import { describe, it, expect } from 'vitest'
import { ALWAYS_USED_RE, findUnusedFiles } from '../src/shared/unusedFiles'

// findUnusedFiles（roadmap #18）の判定は「参照らしき文字列が出現するか」という
// 控えめな判定（真の到達グラフではない）。誤る方向は「未使用と言いすぎない」側に
// 固定する設計判断（unusedFiles.ts 冒頭のコメント参照）——ファイルを動かす提案の
// 土台なので、使っているものを未使用と言い張る誤りが最も害が大きい。
//
// このテストは「使用中と判定すべき例」と「未使用と判定すべき例」を対で確かめる。

/** テスト用の readText: マップから返す。無ければ null（バイナリ扱い）。 */
function readerOf(map: Record<string, string>): (rel: string) => string | null {
  return (rel) => (rel in map ? map[rel] : null)
}

describe('findUnusedFiles: href で使用中 / 未使用の対', () => {
  const files = ['index.html', 'menu.html', 'index_old.html']
  const contents = {
    'index.html': '<a href="menu.html">メニュー</a>',
    'menu.html': '<p>メニューページ</p>',
    // index_old.html はどこからもリンクされていない
    'index_old.html': '<p>古いトップページ</p>',
  }

  it('★★ nav でリンクされている menu.html は使用中', () => {
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).not.toContain('menu.html')
  })

  it('★★ どこにも名前が出ない index_old.html は未使用', () => {
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).toContain('index_old.html')
  })
})

describe('findUnusedFiles: CSS の url() 参照で使用中 / 未参照は未使用', () => {
  const files = ['index.html', 'style.css', 'images/hero.jpg', 'images/unused.jpg']
  const contents = {
    'index.html': '<link rel="stylesheet" href="style.css">',
    'style.css': ".hero { background-image: url('images/hero.jpg'); }",
    // images/unused.jpg はどこからも参照されていない
  }

  it('★★ CSS の url() から参照されている hero.jpg は使用中', () => {
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).not.toContain('images/hero.jpg')
  })

  it('★★ どこからも参照されていない unused.jpg は未使用', () => {
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).toContain('images/unused.jpg')
  })
})

describe('ALWAYS_USED_RE: 外部クローラーが直接読みにくる慣習ファイル（2026-09-04 追加分）', () => {
  // 検索エンジンの所有確認・広告管理ファイルは、コードから参照されなくても置いておく正当なもの。
  // 「外部利用マーク」機能ではなく許可リストで吸収する（Ryosuke と合意）。対で固定する。
  it('★★ 検証ファイル・広告ファイルは参照が無くても使用中', () => {
    const files = ['google1a2b3c4d.html', 'BingSiteAuth.xml', 'ads.txt', 'app-ads.txt', 'index.html']
    const unused = findUnusedFiles(files, readerOf({ 'index.html': '' }))
    expect(unused).toEqual([])
  })
  it('（対） 名前が似ているだけのページ（mygoogle.html）は許可されず、未参照なら未使用', () => {
    const files = ['mygoogle.html', 'index.html']
    const unused = findUnusedFiles(files, readerOf({ 'index.html': '' }))
    expect(unused).toContain('mygoogle.html')
  })
})

describe('findUnusedFiles: サブフォルダ内から**ファイル名だけ**で参照されるケース', () => {
  // 実世界で普通にある形: images/gallery.html が同じフォルダの hero.jpg を `src="hero.jpg"` と書く。
  // このときプロジェクト相対パス（images/hero.jpg）は本文のどこにも現れない——
  // **basename での照合が無いと軒並み未使用と誤判定**し、押すと壊れる（最も害が大きい誤り）。
  // 検収の変異試験（referenceForms から base を外す退行）が素通りしたため対で固定（2026-09-03）。
  const files = ['images/hero.jpg', 'images/unused.png', 'images/gallery.html', 'index.html']
  const contents = {
    'images/gallery.html': '<img src="hero.jpg">',
    'index.html': '<a href="images/gallery.html">ギャラリー</a>',
  }

  it('★★ 同フォルダから basename だけで参照される images/hero.jpg は使用中', () => {
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).not.toContain('images/hero.jpg')
  })

  it('（対） 参照の無い images/unused.png は未使用', () => {
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).toContain('images/unused.png')
  })
})

describe('findUnusedFiles: 日本語ファイル名は encodeURI 形の参照でも使用中と判定する', () => {
  const files = ['index.html', '画像/メニュー.jpg']
  const contents = {
    // ブラウザ・エディタが書き出す実際の形（encodeURI: / は残る）
    'index.html': `<img src="${encodeURI('画像/メニュー.jpg')}">`,
  }

  it('★★ encodeURI 形で参照されていれば使用中', () => {
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).not.toContain('画像/メニュー.jpg')
  })

  it('（対） 参照が無ければ未使用', () => {
    const noRefContents = { 'index.html': '<p>参照なし</p>' }
    const unused = findUnusedFiles(files, readerOf(noRefContents))
    expect(unused).toContain('画像/メニュー.jpg')
  })
})

describe('findUnusedFiles: ALWAYS_USED_RE の慣習ファイルは参照が無くても常に使用中', () => {
  const always = [
    'index.html', 'about/index.html', '404.html', 'favicon.ico', 'robots.txt',
    'sitemap.xml', 'manifest.json', 'apple-touch-icon-152x152.png', 'og-image.png',
    '.well-known/apple-app-site-association', 'CNAME', '.htaccess', 'nginx.conf',
    'Dockerfile', '.dockerignore',
  ]

  it.each(always)('★ %s は参照が無くても使用中扱い', (rel) => {
    const unused = findUnusedFiles([rel], readerOf({}))
    expect(unused).not.toContain(rel)
  })

  it('ALWAYS_USED_RE 自体も同じ判定になっている（対応関係の確認）', () => {
    for (const rel of always) expect(ALWAYS_USED_RE.test(rel)).toBe(true)
  })

  it('（対） 似ているが慣習に当たらない名前は、参照が無ければ未使用のまま', () => {
    // "logo.png" は og*.png のパターンに巻き込まれない（先頭が og で始まらない）
    const unused = findUnusedFiles(['logo.png'], readerOf({}))
    expect(unused).toContain('logo.png')
  })
})

describe('findUnusedFiles: 自分自身の中身は自分の使用判定に使わない', () => {
  it('★★ 自分のファイル名を含むコメントが自分の中にしか無ければ未使用', () => {
    const files = ['old-notes.html']
    const contents = { 'old-notes.html': '<!-- old-notes.html: 過去のメモ -->' }
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).toContain('old-notes.html')
  })

  it('（対） 他のファイルの中に名前があれば使用中', () => {
    const files = ['old-notes.html', 'index.html']
    const contents = {
      'old-notes.html': '<!-- old-notes.html: 過去のメモ -->',
      'index.html': '<a href="old-notes.html">メモ</a>',
    }
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).not.toContain('old-notes.html')
  })
})

describe('findUnusedFiles: その他の性質', () => {
  it('大文字小文字を区別しない', () => {
    const files = ['Logo.PNG', 'index.html']
    const contents = { 'index.html': '<img src="logo.png">' }
    const unused = findUnusedFiles(files, readerOf(contents))
    expect(unused).not.toContain('Logo.PNG')
  })

  it('入力順を保つ', () => {
    const files = ['c.jpg', 'a.jpg', 'b.jpg']
    const unused = findUnusedFiles(files, readerOf({}))
    expect(unused).toEqual(['c.jpg', 'a.jpg', 'b.jpg'])
  })

  it('readText が null を返すファイル（バイナリ等）はコーパスに含めない', () => {
    // .jpg は元々テキストとして読まないが、念のため null を返しても落ちないことを確認
    const files = ['a.jpg', 'index.html']
    const unused = findUnusedFiles(files, readerOf({ 'index.html': '' }))
    expect(unused).toContain('a.jpg')
  })
})
