import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// dataLayer.ts は electron の app を（テンプレートの場所を探すためだけに）読み込む。
// 走査は electron に触らないので、ここでは最小の偽物を置く。
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { scanDataUsage } from '../src/main/dataLayer'

// ── なぜこのテストが要るか（2026-09-23 検分）──────────────────────────
// 走査は `if (usesDataLayer(text)) usedBy.push(rel) else { …書き込みを調べる }`
// という排他になっていた。AI が server.js の先頭に koto-data の import を1行足し、
// 66行目の fs.writeFileSync を消し忘れる——**いちばん起きやすい「途中まで書き直し」**
// がまさにこの形で、そのファイルは検査から外れて writesFiles が空になる。
// すると「🔎 書き直せたか確かめる」が『✅ 書き直せています』と答え、警告も消える。
// **AI の嘘を確かめるための機能が、Koto 自身の名前で同じ嘘をつく**ことになり、
// 利用者は公開してデータを失う。振る舞いで固定する（掟10）。

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-scan-'))
})
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 消せなくてもよい */ }
})

const write = (rel: string, text: string) => {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
}

describe('プロジェクトの走査（データの扱い）', () => {
  it('koto-data を import していても、残った書き込みを必ず拾う（途中まで書き直し）', () => {
    write('server.js', [
      "import { save } from './koto-data.js'",
      "import fs from 'node:fs'",
      'const data = {}',
      "fs.writeFileSync('answers.json', JSON.stringify(data))", // 消し忘れ
    ].join('\n'))

    const scan = scanDataUsage(dir)
    expect(scan.usedBy).toEqual(['server.js'])
    // **両方に載る＝書き直しが途中**。片方に振り分けてはいけない
    expect(scan.writesFiles).toEqual([{ file: 'server.js', lines: [4] }])
  })

  it('別のファイルが koto-data を使っていても、書き込みの残るファイルを隠さない', () => {
    write('a.js', "import { save } from './koto-data.js'\nsave('k', 1)")
    write('b.js', "import fs from 'node:fs'\nfs.writeFileSync('d.json', '{}')")

    const scan = scanDataUsage(dir)
    expect(scan.usedBy).toEqual(['a.js'])
    expect(scan.writesFiles).toEqual([{ file: 'b.js', lines: [2] }])
  })

  it('書き直しが終わっていれば、書き込みは1件も残らない', () => {
    write('server.js', "import { save } from './koto-data.js'\nawait save('answers', {})")

    const scan = scanDataUsage(dir)
    expect(scan.usedBy).toEqual(['server.js'])
    expect(scan.writesFiles).toEqual([])
    expect(scan.truncated).toBe(false)
  })

  // ★ 見ていないものを「見つかりませんでした」に倒さない
  it('大きすぎて見送ったファイルがあれば、打ち切りとして印を立てる', () => {
    write('huge.js', `// ${'x'.repeat(600 * 1024)}\nfs.writeFileSync('d.json', x)`)

    const scan = scanDataUsage(dir)
    expect(scan.writesFiles).toEqual([]) // 読んでいないので当然見つからない
    expect(scan.truncated).toBe(true)    // **だが「無い」わけではない**
    expect(scan.skipped).toBeGreaterThan(0)
  })

  it('全部見られたときは打ち切りの印を立てない', () => {
    write('index.js', "console.log('hello')")

    const scan = scanDataUsage(dir)
    expect(scan.truncated).toBe(false)
    expect(scan.skipped).toBe(0)
  })
})

// ── 置く条件（2026-09-23 実機・利用者のアプリが起動しなくなった）────────────
//
// Koto は AI に「koto-data を使う形に書き直して」と頼む。ところが置く条件が
// 「**すでに** koto-data を使っているファイルがあるか」だったため、
// **書き直す前は必ず0件で、ファイルは一度も置かれなかった**（鶏と卵）。
// AI は存在しないファイルからの読み込みを頼まれ、完了できないまま
// 「完了しました」と3回答えた。そのうえ読み込めるようにしようと
// package.json に "type": "module" を足し、**アプリが起動しなくなった**。
//
// だから条件を「もう使っている、**または これから要る**」に変える。
// そして **require のアプリには require 版を置く**（アプリの形は変えさせない）。

import { ensureDataLayer, projectModuleKind, dataLayerPlacement, dataLayerStamp } from '../src/main/dataLayer'

const exists = (rel: string) => fs.existsSync(path.join(dir, rel))

describe('データ層を置く（既にあれば触らない）', () => {
  // ★ 今回の事故の本体。誰も使っていなくても、書き込んでいるなら置く
  it('誰も koto-data を使っていなくても、ファイルに書き込んでいれば置く', () => {
    write('package.json', '{"name":"app"}')
    write('server.js', [
      "const fs = require('node:fs')",
      "fs.writeFileSync('data.json', '[]')",
    ].join('\n'))

    const r = ensureDataLayer(dir)
    expect(r.placed).toBe(true)
    expect(r.ready).toBe(true)
    expect(exists('koto-data.cjs')).toBe(true)
  })

  // ★ require のアプリに import 版を置くと、AI が package.json を書き換えて壊す
  it('require のアプリには koto-data.cjs を置く', () => {
    write('package.json', '{"name":"app"}')
    write('server.js', "const fs = require('node:fs')\nfs.writeFileSync('d.json', '[]')")

    const r = ensureDataLayer(dir)
    expect(r.moduleKind).toBe('cjs')
    expect(r.file).toBe('koto-data.cjs')
    expect(exists('koto-data.cjs')).toBe(true)
    expect(exists('koto-data.js')).toBe(false)
  })

  // ★ import のアプリには import 版を置く
  it('import のアプリには koto-data.js を置く', () => {
    write('package.json', '{"name":"app","type":"module"}')
    write('server.js', "import fs from 'node:fs'\nfs.writeFileSync('d.json', '[]')")

    const r = ensureDataLayer(dir)
    expect(r.moduleKind).toBe('esm')
    expect(r.file).toBe('koto-data.js')
    expect(exists('koto-data.js')).toBe(true)
    expect(exists('koto-data.cjs')).toBe(false)
  })

  // ★ 差し替えられている可能性がある（roadmap S-1）。黙って元に戻さない
  it('既にあれば上書きしない（ただし頼んでよい状態として扱う）', () => {
    write('package.json', '{"name":"app","type":"module"}')
    write('server.js', "import fs from 'node:fs'\nfs.writeFileSync('d.json', '[]')")
    write('koto-data.js', '// データベース版に差し替え済み')

    const r = ensureDataLayer(dir)
    expect(r.placed).toBe(false)
    // **無いわけではない。** 読み込み先はあるので、書き直しは頼んでよい
    expect(r.ready).toBe(true)
    expect(r.file).toBe('koto-data.js')
    expect(fs.readFileSync(path.join(dir, 'koto-data.js'), 'utf8')).toBe('// データベース版に差し替え済み')
  })

  it('すでに koto-data を使っているだけのプロジェクトにも置く（これまでどおり）', () => {
    write('package.json', '{"name":"app","type":"module"}')
    write('app.js', "import { save } from './koto-data.js'\nawait save('a', {})")

    expect(ensureDataLayer(dir).placed).toBe(true)
    expect(exists('koto-data.js')).toBe(true)
  })

  it('何も要らないプロジェクトには置かない', () => {
    write('package.json', '{"name":"app"}')
    write('index.js', "console.log('hello')")

    const r = ensureDataLayer(dir)
    expect(r.placed).toBe(false)
    expect(r.ready).toBe(false)
    expect(r.file).toBeNull()
    expect(exists('koto-data.cjs')).toBe(false)
    expect(exists('koto-data.js')).toBe(false)
  })

  it('プロジェクトが指定されていなければ何もしない', () => {
    const r = ensureDataLayer('')
    expect(r.placed).toBe(false)
    expect(r.ready).toBe(false)
  })

  // 2026-08-14 実機: 0600 のまま容器へ入り、Node が自分のファイルを読めずに
  // EACCES で起動に失敗した。**読み取りだけを足す**（x も w も触らない）
  it('置いたファイルは、誰でも読める権限になっている', () => {
    write('package.json', '{"name":"app"}')
    write('server.js', "const fs = require('node:fs')\nfs.writeFileSync('d.json', '[]')")

    ensureDataLayer(dir)
    const mode = fs.statSync(path.join(dir, 'koto-data.cjs')).mode & 0o777
    expect(mode & 0o444).toBe(0o444)
  })

  // ★ 置いた .cjs 自身の中の fs.writeFile を「利用者の書き込み」と数えない
  it('置いたあとに調べ直しても、置いたファイル自身は警告にならない', () => {
    write('package.json', '{"name":"app"}')
    write('server.js', "const fs = require('node:fs')\nfs.writeFileSync('d.json', '[]')")
    ensureDataLayer(dir)

    const scan = scanDataUsage(dir)
    expect(scan.writesFiles.map(w => w.file)).toEqual(['server.js'])
    expect(scan.usedBy).toEqual([]) // まだ書き直していないので当然0件
  })

  // ★ 書き直したあとは「使っている」と判定できること（.cjs を拾えないと嘘になる）
  it('.cjs を読み込む形に書き直せば、使っていると判定する', () => {
    write('package.json', '{"name":"app"}')
    write('server.js', "const { save } = require('./koto-data.cjs')\nsave('a', {})")
    ensureDataLayer(dir)

    const scan = scanDataUsage(dir)
    expect(scan.usedBy).toEqual(['server.js'])
    expect(scan.writesFiles).toEqual([])
  })
})

describe('プロジェクトの形を読む', () => {
  it('package.json の type を見る', () => {
    write('package.json', '{"type":"module"}')
    expect(projectModuleKind(dir)).toBe('esm')
  })

  it('package.json が無ければ require のアプリとして扱う', () => {
    expect(projectModuleKind(dir)).toBe('cjs')
  })
})

// ── アプリの形の見分け（2026-09-23 検分）────────────────────────────────
// 以前は「公開の根の package.json」1枚だけを見ていた。だが Node は
//   (1) `.mjs` は常に import・`.cjs` は常に require（package.json より強い）
//   (2) package.json が無ければ**親フォルダへ遡って**いちばん近いものを見る
// という決まりなので、次の形で判定を誤り、**今回とまったく同じエラー**
// （ReferenceError: require is not defined in ES module scope ／
//  Cannot find module）でアプリが起動しなくなる。振る舞いで固定する。
describe('アプリの形の見分け（拡張子と、親の package.json）', () => {
  // ★ public/ に package.json が無く、プロジェクト直下に "type": "module" がある形。
  //   ~/SAKURAIDE/syosetuReader が実際にこの形（直下に package.json・公開の根が public/）
  it('公開の根に package.json が無ければ、プロジェクト直下まで遡って見る', () => {
    write('package.json', '{"name":"app","type":"module"}')
    write('public/server.js', "import fs from 'node:fs'\nfs.writeFileSync('d.json', '[]')")

    const root = path.join(dir, 'public')
    expect(projectModuleKind(root, { projectDir: dir })).toBe('esm')

    const r = ensureDataLayer(root, dir)
    expect(r.moduleKind).toBe('esm')
    expect(r.file).toBe('koto-data.js')
    expect(exists('public/koto-data.js')).toBe(true)
    expect(exists('public/koto-data.cjs')).toBe(false)
  })

  // ★ 近いほうが勝つ（Node と同じ）。public/ に package.json があれば直下は見ない
  it('公開の根に package.json があれば、そちらが勝つ（親は見ない）', () => {
    write('package.json', '{"name":"app","type":"module"}')
    write('public/package.json', '{"name":"inner"}')
    write('public/server.js', "const fs = require('node:fs')\nfs.writeFileSync('d.json', '[]')")

    const root = path.join(dir, 'public')
    expect(projectModuleKind(root, { projectDir: dir })).toBe('cjs')
    expect(ensureDataLayer(root, dir).file).toBe('koto-data.cjs')
  })

  // ★ .mjs は package.json に関係なく import。ここを見ないと require を勧めてしまい
  //   ReferenceError: require is not defined で起動しない
  it('server.mjs があれば、package.json に type が無くても import のアプリ', () => {
    write('package.json', '{"name":"app"}')
    write('server.mjs', "import fs from 'node:fs'\nfs.writeFileSync('d.json', '[]')")

    const r = ensureDataLayer(dir, dir)
    expect(r.moduleKind).toBe('esm')
    expect(r.file).toBe('koto-data.js')
    expect(exists('koto-data.js')).toBe(true)
    expect(exists('koto-data.cjs')).toBe(false)
  })

  // ★ 逆も同じ。.cjs は "type": "module" でも require
  it('server.cjs があれば、"type": "module" でも require のアプリ', () => {
    write('package.json', '{"name":"app","type":"module"}')
    write('server.cjs', "const fs = require('node:fs')\nfs.writeFileSync('d.json', '[]')")

    const r = ensureDataLayer(dir, dir)
    expect(r.moduleKind).toBe('cjs')
    expect(r.file).toBe('koto-data.cjs')
    expect(exists('koto-data.cjs')).toBe(true)
  })

  // ★ 形が割れるときは拡張子を決め手にしない（どちらに倒しても片方が壊れる）。
  //   package.json へ落として、推測しない
  it('.mjs と .cjs が混在するときは、package.json で決める', () => {
    write('package.json', '{"name":"app","type":"module"}')
    write('a.mjs', "import fs from 'node:fs'\nfs.writeFileSync('d.json', '[]')")
    write('b.cjs', "const fs = require('node:fs')\nfs.writeFileSync('e.json', '[]')")

    expect(ensureDataLayer(dir, dir).moduleKind).toBe('esm')
  })

  // ★ プロジェクト直下を渡さなければ、従来どおり根の1枚だけ（後方互換）
  it('プロジェクト直下を渡さなければ、公開の根の1枚だけを見る', () => {
    write('package.json', '{"name":"app","type":"module"}')
    write('public/server.js', "console.log('hi')")
    expect(projectModuleKind(path.join(dir, 'public'))).toBe('cjs')
  })
})

// ── 古い koto-data を、どこまで差し替えてよいか（2026-09-24 検分）─────────
//
// 直しの出発点は「**いま公開中のアプリ**が混雑で真っ白になる／後勝ちで消える」で、
// その対象は**すべて既にファイルを持っている**。「既にあれば触らない」だけでは、
// いちばん効く直しがいちばん必要なところに届かない。
// 一方で、データベース版に差し替えたものを元に戻したら事故になる（roadmap S-1）。
// 判断は純関数 `dataLayerPlacement` の1か所に置き、ここで振る舞いを固定する（掟10）。
describe('既にある koto-data を差し替えてよいかの判断（純関数）', () => {
  const stamped = (v: string) => `// koto-data.js\n//\n// koto-data-template: ${v}\nconst BUCKET = ''\n`

  it('無ければ置く', () => {
    expect(dataLayerPlacement(null, stamped('2026-09-24.2'))).toBe('place')
  })

  it('印が同じなら、そのまま（触らない）', () => {
    expect(dataLayerPlacement(stamped('2026-09-24.2'), stamped('2026-09-24.2'))).toBe('up-to-date')
  })

  it('★ 印が古いときだけ差し替える', () => {
    expect(dataLayerPlacement(stamped('2026-09-24.1'), stamped('2026-09-24.2'))).toBe('replace')
  })

  // ★ 古い版を配って、直したものを巻き戻さない
  it('印が新しいものは差し替えない', () => {
    expect(dataLayerPlacement(stamped('2026-09-25.1'), stamped('2026-09-24.2'))).toBe('up-to-date')
  })

  // ★ ここが守られないと、利用者がデータベース版に差し替えた仕事を消してしまう
  it('★ 印が無いものには触らない（作り替えられている可能性がある）', () => {
    expect(dataLayerPlacement('// データベース版に差し替え済み', stamped('2026-09-24.2'))).toBe('leave-alone')
    expect(dataLayerPlacement('', stamped('2026-09-24.2'))).toBe('leave-alone')
  })

  it('印を読む（無ければ null）', () => {
    expect(dataLayerStamp(stamped('2026-09-24.2'))).toBe('2026-09-24.2')
    expect(dataLayerStamp('// koto-data.js')).toBeNull()
    expect(dataLayerStamp(null)).toBeNull()
  })

  // ★ いま同梱しているテンプレートに、実際に印が入っていること
  //   （入っていないと、この先どの版も差し替えられない）
  it('★ 同梱の2つのテンプレートに、同じ印が入っている', () => {
    const js = fs.readFileSync(path.join(process.cwd(), 'templates/koto-data.js'), 'utf8')
    const cjs = fs.readFileSync(path.join(process.cwd(), 'templates/koto-data.cjs'), 'utf8')
    expect(dataLayerStamp(js)).not.toBeNull()
    expect(dataLayerStamp(cjs)).toBe(dataLayerStamp(js))
  })
})

describe('古い koto-data の差し替え（実際のファイルで）', () => {
  const template = (file: string) => fs.readFileSync(path.join(process.cwd(), 'templates', file), 'utf8')

  // ★ 今回の直しが「いちばん必要なアプリ」に届くこと
  it('★ Koto が置いた古い版は、新しい版へ差し替える', () => {
    write('package.json', '{"name":"app"}')
    write('server.js', "const { save } = require('./koto-data.cjs')\nsave('a', {})")
    // 印はあるが版が古い（Koto が置いたまま）
    write('koto-data.cjs', template('koto-data.cjs').replace(/koto-data-template: .*/, 'koto-data-template: 2026-09-01.0'))

    const r = ensureDataLayer(dir)
    expect(r.replaced).toBe(true)
    expect(r.needsUpdate).toBe(false)
    expect(r.ready).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'koto-data.cjs'), 'utf8')).toBe(template('koto-data.cjs'))
  })

  it('同じ版なら、書き換えない', () => {
    write('package.json', '{"name":"app"}')
    write('server.js', "const { save } = require('./koto-data.cjs')\nsave('a', {})")
    write('koto-data.cjs', template('koto-data.cjs'))
    const before = fs.statSync(path.join(dir, 'koto-data.cjs')).mtimeMs

    const r = ensureDataLayer(dir)
    expect(r.replaced).toBe(false)
    expect(r.needsUpdate).toBe(false)
    expect(fs.statSync(path.join(dir, 'koto-data.cjs')).mtimeMs).toBe(before)
  })

  // ★ 利用者が作り替えたものを、黙って元に戻さない
  it('★ 印が無いものは触らず、画面に知らせる印（needsUpdate）を返す', () => {
    write('package.json', '{"name":"app","type":"module"}')
    write('server.js', "import { save } from './koto-data.js'\nsave('a', {})")
    write('koto-data.js', '// データベース版に差し替え済み')

    const r = ensureDataLayer(dir)
    expect(r.replaced).toBe(false)
    expect(r.needsUpdate).toBe(true)
    expect(r.ready).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'koto-data.js'), 'utf8')).toBe('// データベース版に差し替え済み')
  })

  // ★ 置いたファイルには書き込み権限が無いことがある（読み取りだけを足しているため）
  it('★ 読み取り専用で置かれていても、差し替えられる', () => {
    write('package.json', '{"name":"app"}')
    write('server.js', "const { save } = require('./koto-data.cjs')\nsave('a', {})")
    const dest = path.join(dir, 'koto-data.cjs')
    write('koto-data.cjs', template('koto-data.cjs').replace(/koto-data-template: .*/, 'koto-data-template: 2026-09-01.0'))
    fs.chmodSync(dest, 0o444)

    const r = ensureDataLayer(dir)
    expect(r.replaced).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe(template('koto-data.cjs'))
    expect(fs.statSync(dest).mode & 0o444).toBe(0o444)
  })
})
