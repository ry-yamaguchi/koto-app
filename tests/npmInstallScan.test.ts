import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { scanModules } from '../src/main/cloud/npmInstall'
import { packageOfNative } from '../src/shared/deps'

// ── scanModules（2026-09-16・502 Bad Gateway で発覚した穴の回帰試験）─────────
//
// 実機で起きた連鎖: better-sqlite3 は `npm install --ignore-scripts` で入れても
// `.node` が1つもできない（組み立てそのものが `--ignore-scripts` で止まるため）。
// 以前の `findNativeBinaries` は `.node` の有無だけを見ていたので、この形を
// 「安全」とすり抜けさせ、公開したアプリがコンテナ起動時に `require` で落ちていた
// （`Could not locate the bindings file` → 1分ごとの再起動ループ → 502）。
//
// ここでは `fs` を偽物にせず、実際のフォルダを一時ディレクトリに作って確かめる。

let tmp = ''
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-npminstallscan-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

// ── 部品の中身を本物のバイト列で作る（改善案 1-7・案3・2026-09-17）──────────
// 公開先は node:22-alpine（musl・amd64）。ELF ヘッダだけでは glibc と musl を
// 区別できないので、libc の参照名を中身に置く。
function elf(tailText: string, machine = 0x3e): Buffer {
  const head = Buffer.alloc(0x40)
  head.set([0x7f, 0x45, 0x4c, 0x46], 0)
  head[4] = 0x02            // 64bit
  head[5] = 0x01            // リトルエンディアン
  head.writeUInt16LE(machine, 0x12)
  return Buffer.concat([head, Buffer.from(tailText, 'latin1')])
}
/** 公開先（Alpine）で動く部品。 */
const MUSL = () => elf('\0/lib/ld-musl-x86_64.so.1\0libc.musl-x86_64.so.1\0')
/** Linux 用だが公開先では動かない部品。 */
const GLIBC = () => elf('\0libc.so.6\0__libc_start_main\0')
/** お使いのパソコン用（macOS）の部品。 */
const MACHO = () => Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01])

/** `<node_modules>/<name>/<file>` に部品を置く。 */
function putBinary(modules: string, name: string, file: string, bytes: Buffer): void {
  const full = path.join(modules, name, file)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, bytes)
}

describe('scanModules: .node と「組み立てが要る」宣言を1回の走査で集める', () => {
  it('★★ 回帰: binding.gyp があって .node が1つも無いライブラリを拾う（better-sqlite3 と同じ構え）', () => {
    const modules = path.join(tmp, 'app', 'node_modules')
    const lib = path.join(modules, 'better-sqlite3')
    fs.mkdirSync(path.join(lib, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({
      name: 'better-sqlite3',
      scripts: { install: 'prebuild-install || node-gyp rebuild --release' },
    }))
    fs.writeFileSync(path.join(lib, 'binding.gyp'), '{}')
    fs.writeFileSync(path.join(lib, 'lib', 'database.js'), 'module.exports = {}')

    const scan = scanModules(modules)
    expect(scan.nativeBinaries).toEqual([])
    expect(scan.declaredNative).toEqual(['better-sqlite3'])
  })

  it('★ .node があるライブラリは nativeBinaries に出る', () => {
    const modules = path.join(tmp, 'app', 'node_modules')
    const releaseDir = path.join(modules, 'sqlite3', 'build', 'Release')
    fs.mkdirSync(releaseDir, { recursive: true })
    fs.writeFileSync(path.join(releaseDir, 'node_sqlite3.node'), '')

    const scan = scanModules(modules)
    expect(scan.nativeBinaries.length).toBe(1)
    expect(scan.nativeBinaries[0]).toContain('sqlite3')
    expect(scan.declaredNative).toEqual([])
  })

  it('★ 同じライブラリが .node と宣言の両方に当たっても、組み立てる側では1回だけになる（断るのは1件だけ）', () => {
    const modules = path.join(tmp, 'app', 'node_modules')
    const lib = path.join(modules, 'better-sqlite3')
    fs.mkdirSync(path.join(lib, 'build', 'Release'), { recursive: true })
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({
      name: 'better-sqlite3',
      scripts: { install: 'prebuild-install || node-gyp rebuild --release' },
    }))
    fs.writeFileSync(path.join(lib, 'binding.gyp'), '{}')
    fs.writeFileSync(path.join(lib, 'build', 'Release', 'better_sqlite3.node'), '')

    const scan = scanModules(modules)
    // `installDependencies` は `scan.blocked` をそのまま画面へ渡す（名前も理由も1件ずつ）。
    expect(scan.blocked.map(b => b.name)).toEqual(['better-sqlite3'])
    expect(packageOfNative(scan.nativeBinaries[0])).toBe('better-sqlite3')
  })

  it('★ @scope/name の形のライブラリの名前が @scope/name になる', () => {
    const modules = path.join(tmp, 'app', 'node_modules')
    const lib = path.join(modules, '@napi-rs', 'canvas')
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({ name: '@napi-rs/canvas', gypfile: true }))
    fs.writeFileSync(path.join(lib, 'binding.gyp'), '{}')

    const scan = scanModules(modules)
    expect(scan.declaredNative).toEqual(['@napi-rs/canvas'])
  })

  it('★ 入れ子（依存の依存）でも bcrypt になる', () => {
    const modules = path.join(tmp, 'app', 'node_modules')
    const outer = path.join(modules, 'a')
    const lib = path.join(outer, 'node_modules', 'bcrypt')
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(path.join(outer, 'package.json'), JSON.stringify({ name: 'a' }))
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({ name: 'bcrypt', gypfile: true }))
    fs.writeFileSync(path.join(lib, 'binding.gyp'), '{}')

    const scan = scanModules(modules)
    expect(scan.declaredNative).toEqual(['bcrypt'])
  })

  it('普通のライブラリ（express 相当）だけなら nativeBinaries・declaredNative とも空', () => {
    const modules = path.join(tmp, 'app', 'node_modules')
    const lib = path.join(modules, 'express')
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({
      name: 'express',
      // esbuild の postinstall と同じ形（組み立て道具は呼んでいない・誤検知しない）
      scripts: { postinstall: 'node install.js' },
    }))
    fs.writeFileSync(path.join(lib, 'index.js'), 'module.exports = {}')

    const scan = scanModules(modules)
    expect(scan.nativeBinaries).toEqual([])
    expect(scan.declaredNative).toEqual([])
    expect(scan.blocked).toEqual([])
  })
})

// ── ライブラリ単位で、種類まで見分けて通す（改善案 1-7・案3・2026-09-17）────────
// Koto は `npm install` に `--os=linux --cpu=x64 --libc=musl` を渡しているので、
// 入ってくる `.node` が**最初から公開先で動くもの**であることがある（例: sharp）。
// 「`.node` があれば断る」は止めすぎだった。一方で**分からないものは通さない**。
describe('scanModules: .node の種類を見分けて、公開先で動くものだけ通す', () => {
  const modulesIn = (t: string) => path.join(t, 'app', 'node_modules')

  it('★★ 公開先で動く部品を持つライブラリは通す（今回の本命・sharp の形）', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, '@img/sharp-linuxmusl-x64', 'lib/sharp-linuxmusl-x64.node', MUSL())
    fs.writeFileSync(path.join(modules, '@img/sharp-linuxmusl-x64', 'package.json'),
      JSON.stringify({ name: '@img/sharp-linuxmusl-x64' }))

    const scan = scanModules(modules)
    expect(scan.nativeBinaries.length).toBe(1)
    expect(scan.binaryKinds['@img/sharp-linuxmusl-x64']).toEqual(['linux-musl-x64'])
    expect(scan.blocked).toEqual([])
  })

  it('★★ お使いのパソコン用しか持たないライブラリは断る', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, 'bcrypt', 'lib/binding/bcrypt_lib.node', MACHO())

    const scan = scanModules(modules)
    expect(scan.binaryKinds['bcrypt']).toEqual(['macho'])
    expect(scan.blocked).toEqual([{ name: 'bcrypt', reason: 'macho-only' }])
  })

  it('★★ お使いのパソコン用と公開先用の両方を持つライブラリは通す（各OS用を同梱する形）', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, 'node-datachannel', 'prebuilds/darwin-arm64/node.node', MACHO())
    putBinary(modules, 'node-datachannel', 'prebuilds/linuxmusl-x64/node.node', MUSL())

    const scan = scanModules(modules)
    expect(scan.binaryKinds['node-datachannel']).toEqual(['linux-musl-x64', 'macho'])
    expect(scan.blocked).toEqual([])
  })

  it('★★ 公開先とは別の種類の Linux 用しか持たないライブラリは断る', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, '@img/sharp-linux-x64', 'lib/sharp-linux-x64.node', GLIBC())

    const scan = scanModules(modules)
    expect(scan.binaryKinds['@img/sharp-linux-x64']).toEqual(['linux-glibc-x64'])
    expect(scan.blocked).toEqual([{ name: '@img/sharp-linux-x64', reason: 'other-linux' }])
  })

  it('★★ 中身が空・見覚えのない部品は通さない（分からないものを大丈夫に倒さない）', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, 'mystery', 'build/Release/mystery.node', Buffer.alloc(0))

    const scan = scanModules(modules)
    expect(scan.binaryKinds['mystery']).toEqual(['unknown'])
    expect(scan.blocked).toEqual([{ name: 'mystery', reason: 'unknown' }])
  })

  it('★★ binding.gyp を持っていても、公開先用の部品を同梱していれば通す（.node を先に見る）', () => {
    const modules = modulesIn(tmp)
    const lib = path.join(modules, 'ssh2')
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({
      name: 'ssh2', scripts: { install: 'node-gyp-build' },
    }))
    fs.writeFileSync(path.join(lib, 'binding.gyp'), '{}')
    putBinary(modules, 'ssh2', 'prebuilds/linuxmusl-x64/node.napi.node', MUSL())

    const scan = scanModules(modules)
    expect(scan.declaredNative).toEqual(['ssh2'])   // 宣言そのものは拾っている
    expect(scan.blocked).toEqual([])                // それでも通す（公開先用が入っているから）
  })

  it('★★ 回帰: .node が無く binding.gyp があるライブラリは、これまでどおり断る', () => {
    const modules = modulesIn(tmp)
    const lib = path.join(modules, 'better-sqlite3')
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({
      name: 'better-sqlite3', scripts: { install: 'prebuild-install || node-gyp rebuild --release' },
    }))
    fs.writeFileSync(path.join(lib, 'binding.gyp'), '{}')

    const scan = scanModules(modules)
    expect(scan.blocked).toEqual([{ name: 'better-sqlite3', reason: 'needs-build' }])
  })

  it('★ 純 JS のライブラリは通す（止めすぎていない）', () => {
    const modules = modulesIn(tmp)
    const lib = path.join(modules, 'express')
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({ name: 'express' }))
    fs.writeFileSync(path.join(lib, 'index.js'), 'module.exports = {}')

    const scan = scanModules(modules)
    expect(scan.blocked).toEqual([])
    expect(scan.binaryKinds).toEqual({})
  })

  it('★ 通すライブラリと断るライブラリが混ざっても、断るほうだけ名前が出る', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, 'sharp-ok', 'a.node', MUSL())
    putBinary(modules, 'only-mac', 'b.node', MACHO())

    const scan = scanModules(modules)
    expect(scan.blocked.map(b => b.name)).toEqual(['only-mac'])
  })
})

// ── 件数上限が判定を盲目にしない（検分の指摘・2026-09-17）────────────────────
//
// 以前は `.node` を `limit` 件（既定50）見つけた時点で**走査ごと打ち切って**いた。
// 各OS用の部品を同梱するライブラリは1つで9〜14個の `.node` を持つので、数個並べば
// 50 に届く。そこで打ち切ると、
//   ・その先の「お使いのパソコン用しか無いライブラリ」が**無検査で公開される**（通しすぎ）
//   ・同じライブラリの公開先用が打ち切りの外に落ちて**動くものを断る**（止めすぎ）
// の両方が起きる。ここでは `limit` を小さく渡して、同じ状況をフィラー無しで再現する。
describe('scanModules: 件数上限は診断用の一覧だけに掛かる（判定は打ち切らない）', () => {
  const modulesIn = (t: string) => path.join(t, 'app', 'node_modules')

  it('★★ 上限を超えた位置にある「お使いのパソコン用しか無いライブラリ」も断る（通しすぎを塞ぐ）', () => {
    const modules = modulesIn(tmp)
    // 先に見つかる（名前順）ライブラリが上限を埋め切る
    putBinary(modules, 'aaa-many', 'prebuilds/linuxmusl-x64/1.node', MUSL())
    putBinary(modules, 'aaa-many', 'prebuilds/linuxmusl-x64/2.node', MUSL())
    putBinary(modules, 'aaa-many', 'prebuilds/linuxmusl-x64/3.node', MUSL())
    putBinary(modules, 'zzz-mac', 'lib/binding.node', MACHO())

    const scan = scanModules(modules, 2)
    expect(scan.nativeBinaries.length, '診断用の一覧には上限が効いている').toBe(2)
    expect(scan.binaryKinds['zzz-mac'], '上限の外の部品が種類を見られていない').toEqual(['macho'])
    expect(scan.blocked).toEqual([{ name: 'zzz-mac', reason: 'macho-only' }])
  })

  it('★★ 上限を超えた位置に公開先用の部品があるライブラリは通す（止めすぎを塞ぐ）', () => {
    const modules = modulesIn(tmp)
    // 同じライブラリの中で、お使いのパソコン用が先・公開先用があとに来る形
    putBinary(modules, 'zz-multi', 'prebuilds/darwin-arm64/node.node', MACHO())
    putBinary(modules, 'zz-multi', 'prebuilds/linuxmusl-x64/node.node', MUSL())

    const scan = scanModules(modules, 1)
    expect(scan.nativeBinaries.length).toBe(1)
    expect(scan.binaryKinds['zz-multi']).toEqual(['linux-musl-x64', 'macho'])
    expect(scan.blocked, '上限の外に落ちた公開先用を見落として断っている').toEqual([])
  })

  it('★★ 上限を超えても「組み立てが要る」宣言を取りこぼさない', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, 'aaa-many', '1.node', MUSL())
    putBinary(modules, 'aaa-many', '2.node', MUSL())
    const lib = path.join(modules, 'zzz-gyp')
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({ name: 'zzz-gyp' }))
    fs.writeFileSync(path.join(lib, 'binding.gyp'), '{}')

    const scan = scanModules(modules, 1)
    expect(scan.declaredNative).toEqual(['zzz-gyp'])
    expect(scan.blocked).toEqual([{ name: 'zzz-gyp', reason: 'needs-build' }])
  })
})

// ── 入れ子の node_modules（同名の別コピー）は別物として判定する（検分の指摘）──
//
// npm は版が食い違う依存を入れ子の `node_modules` に別コピーとして置く。名前だけで
// 集計すると2つが合流し、「どちらかに公開先用があれば通す」という**通しすぎ**になる。
describe('scanModules: 入れ子の同名ライブラリは、コピーごとに判定する', () => {
  const modulesIn = (t: string) => path.join(t, 'app', 'node_modules')

  it('★★ 上位に公開先用があっても、入れ子のコピーが別種類なら断る', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, 'bar', 'b.node', MUSL())
    putBinary(modules, path.join('foo', 'node_modules', 'bar'), 'b.node', GLIBC())

    const scan = scanModules(modules)
    expect(scan.blocked).toEqual([{ name: 'bar', reason: 'other-linux' }])
  })

  it('★★ 上位に公開先用があっても、入れ子のコピーが組み立て前なら断る', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, 'qux', 'q.node', MUSL())
    const nested = path.join(modules, 'baz', 'node_modules', 'qux')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'qux' }))
    fs.writeFileSync(path.join(nested, 'binding.gyp'), '{}')

    const scan = scanModules(modules)
    expect(scan.declaredNative).toEqual(['qux'])
    expect(scan.blocked).toEqual([{ name: 'qux', reason: 'needs-build' }])
  })

  it('★ 入れ子のコピーも公開先用を持っていれば、両方とも通す（止めすぎていない）', () => {
    const modules = modulesIn(tmp)
    putBinary(modules, 'bar', 'b.node', MUSL())
    putBinary(modules, path.join('foo', 'node_modules', 'bar'), 'b.node', MUSL())

    const scan = scanModules(modules)
    expect(scan.blocked).toEqual([])
    expect(scan.binaryKinds['bar']).toEqual(['linux-musl-x64'])
  })
})
