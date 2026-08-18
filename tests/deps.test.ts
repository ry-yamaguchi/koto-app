import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  listDependencies, planDependencies, isNativeBinary, packageOfNative,
  nativeDepsMessage, installTimeNote,
} from '../src/shared/deps'
import { installTargetsFromCommand, confirmReason } from '../src/renderer/aiTools'

// ── 改善案 1-5（2026-08-18）──────────────────────────────────────────
// `dependencies` があると正直に断っていた。だが AI に「フォームを作って」と
// 頼めば express を使うコードが出てくるのが自然で、**断られた利用者は
// そこで終わる**（作れないのと同じ）。手元で用意して持っていけるようにする。

describe('依存ライブラリを数える', () => {
  it('dependencies を名前順で取り出す', () => {
    expect(listDependencies({ dependencies: { express: '^4', dotenv: '^16' } })).toEqual(['dotenv', 'express'])
  })

  it('★ devDependencies は持っていかない（動かすのに要らない）', () => {
    expect(listDependencies({ devDependencies: { vitest: '^1' } })).toEqual([])
  })

  it('壊れた package.json でも落ちない', () => {
    expect(listDependencies(null)).toEqual([])
    expect(listDependencies({ dependencies: 'express' })).toEqual([])
  })

  it('依存が無ければ、用意そのものをしない', () => {
    expect(planDependencies({ name: 'x' })).toEqual({ kind: 'none' })
    expect(planDependencies({ dependencies: { express: '^4' } })).toEqual({ kind: 'install', names: ['express'] })
  })
})

describe('持っていけない部品を見分ける', () => {
  it('★ その場で機械語に翻訳された部品（.node）を見つける', () => {
    expect(isNativeBinary('app/node_modules/sqlite3/build/Release/node_sqlite3.node')).toBe(true)
    expect(isNativeBinary('app/node_modules/express/index.js')).toBe(false)
  })

  it('持ち主のライブラリ名が分かる', () => {
    expect(packageOfNative('app/node_modules/sqlite3/build/Release/x.node')).toBe('sqlite3')
    expect(packageOfNative('app/node_modules/@napi-rs/canvas/x.node')).toBe('@napi-rs/canvas')
  })

  it('入れ子（依存の依存）でも、いちばん内側の持ち主を指す', () => {
    expect(packageOfNative('app/node_modules/a/node_modules/bcrypt/lib/x.node')).toBe('bcrypt')
  })

  it('★ 「動きません」で終わらせず、どうすればよいかまで書く', () => {
    const m = nativeDepsMessage(['app/node_modules/sqlite3/build/Release/x.node'])
    expect(m).toContain('sqlite3')
    expect(m).toContain('Linux')
    expect(m).toMatch(/AIに|Dockerfile/)
  })

  it('同じライブラリの部品が複数あっても、名前は1回だけ出す', () => {
    const m = nativeDepsMessage([
      'app/node_modules/sqlite3/build/Release/a.node',
      'app/node_modules/sqlite3/build/Release/b.node',
    ])
    expect(m.match(/sqlite3/g)?.length).toBe(1)
  })
})

describe('待ち時間の目安', () => {
  it('件数に応じて伝える', () => {
    expect(installTimeNote(0)).toBe('')
    expect(installTimeNote(3)).toContain('1分')
    expect(installTimeNote(30)).toContain('分')
  })
})

// ── 配線（判断だけ正しくても、繋がっていなければ意味がない・掟10）──────────
describe('依存ライブラリの用意が繋がっている', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('★ 内蔵ビルダーが用意する（層に含める前に）', () => {
    const img = read('src/main/cloud/imageBuild.ts')
    expect(img).toContain('installDependencies')
    // tar を作る前に用意する（あとだと node_modules が入らない）
    expect(img.indexOf('installDependencies')).toBeLessThan(img.indexOf("'tar', ['-cf'"))
  })

  it('★ 後付けスクリプトを走らせない（素性の分からないコードを動かさない）', () => {
    // **コメントではなく、実際に渡す引数を見る**
    // （最初この確認はコメントの文字列を拾っており、外しても落ちなかった）
    const src = read('src/main/cloud/npmInstall.ts')
    const argv = /\[\s*'install',[^\]]*\]/.exec(src)?.[0] ?? ''
    expect(argv).toContain("'--ignore-scripts'")
    expect(argv).toContain("'--omit=dev'")
  })

  it('★ 持っていけない部品があれば、層を作らずに止める', () => {
    const img = read('src/main/cloud/imageBuild.ts')
    expect(img).toMatch(/nativeFiles\.length > 0[\s\S]{0,200}throw new Error\(nativeDepsMessage/)
  })

  it('★ 依存があっても「動かせない」と断らない（改善案 1-5 の本体）', () => {
    const rd = read('src/shared/runtimeDetect.ts')
    expect(rd).not.toMatch(/depNames\.length > 0[\s\S]{0,200}unsupported/)
  })

  it('待たされる理由を、押す前に伝える', () => {
    expect(read('src/main/ipc/cloud.ts')).toContain('installTimeNote')
  })
})

// ── 何が入るのかを見せる（2026-08-18 Ryosuke 指摘）────────────────────
// 「インターネットからプログラムを取得して実行します」だけでは、
// **何が入るのか分からない**まま許可することになる。
describe('インストールするものを名指しする', () => {
  it('コマンドに書かれていれば、そこから読む', () => {
    expect(installTargetsFromCommand('npm install express cors')).toEqual(['express', 'cors'])
    expect(installTargetsFromCommand('npm i -D vitest')).toEqual(['vitest'])
    expect(installTargetsFromCommand('yarn add dayjs')).toEqual(['dayjs'])
  })

  it('名前の書かれていない npm install は、コマンドからは分からない', () => {
    expect(installTargetsFromCommand('npm install')).toEqual([])
  })

  it('★ 確認の文面に名前が入る', () => {
    expect(confirmReason('npm install express')).toContain('express')
    // 名前なしのときは、呼び出し側が package.json から渡す
    expect(confirmReason('npm install', { dependencies: ['express', 'dotenv'] })).toContain('express')
    expect(confirmReason('npm install', { dependencies: [] })).toContain('取得して実行します')
  })

  it('多すぎるときは、ほか◯件にまとめる', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(confirmReason('npm install', { dependencies: many })).toContain('ほか2件')
  })
})

describe('公開先の形で用意する', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('★ このパソコンの形ではなく、公開先（Linux/amd64/musl）の形で入れる', () => {
    // 実測: 指定しないと esbuild は @esbuild/darwin-arm64（Mach-O）が入り、
    // `.node` ではないので見つける仕掛けにも掛からず、そのまま公開されて起動しない
    const src = read('src/main/cloud/npmInstall.ts')
    expect(src).toContain("'--os=linux'")
    expect(src).toContain("'--cpu=x64'")
    expect(src).toContain("'--libc=musl'")
  })

  it('同じものを何度も取りに行かない', () => {
    expect(read('src/main/cloud/npmInstall.ts')).toContain("'--prefer-offline'")
  })
})
