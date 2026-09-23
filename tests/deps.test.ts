import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  listDependencies, planDependencies, isNativeBinary, packageOfNative, packageDirOfNative,
  nativeDepsMessage, nativeDepsMessageForBlocked, installTimeNote, declaresNativeBuild,
  nativeBinaryKind, runsOnPublishTarget, blockReasonForPackage, primaryBlockReason,
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

  // ── 同名の別コピーを見分ける（検分の指摘・2026-09-17）────────────────────
  // npm は版が食い違う依存を入れ子の node_modules に別コピーとして置く。名前だけを
  // キーに集計すると2つが合流し、「どちらかに公開先用があれば通す」という通しすぎになる。
  it('★★ 持ち主の「フォルダ」が分かる（同名の別コピーを見分けるため）', () => {
    expect(packageDirOfNative('node_modules/bar/b.node')).toBe('node_modules/bar')
    expect(packageDirOfNative('node_modules/foo/node_modules/bar/b.node'))
      .toBe('node_modules/foo/node_modules/bar')
    expect(packageDirOfNative('node_modules/@napi-rs/canvas/x.node'))
      .toBe('node_modules/@napi-rs/canvas')
  })

  it('★★ 上位と入れ子の同名ライブラリは、別のフォルダとして区別される', () => {
    expect(packageDirOfNative('node_modules/bar/b.node'))
      .not.toBe(packageDirOfNative('node_modules/foo/node_modules/bar/b.node'))
  })

  it('ライブラリのフォルダ自身を渡しても、そのフォルダを返す（.node のパスでなくてよい）', () => {
    expect(packageDirOfNative('node_modules/foo/node_modules/bar'))
      .toBe('node_modules/foo/node_modules/bar')
  })

  it('★ 「動きません」で終わらせず、どうすればよいかまで書く', () => {
    const m = nativeDepsMessage(['sqlite3'])
    expect(m).toContain('sqlite3')
    expect(m).toContain('Linux')
    expect(m).toMatch(/AIに|Dockerfile/)
  })

  it('同じライブラリの名前が複数回渡っても、1回だけ出す', () => {
    const m = nativeDepsMessage(['sqlite3', 'sqlite3'])
    expect(m.match(/sqlite3/g)?.length).toBe(1)
  })
})

// ── declaresNativeBuild（2026-09-16・502 で発覚した穴）──────────────────
// `--ignore-scripts` は組み立てを止める守りだが、止めている以上「組み立て済みの
// .node が無い」のは当たり前になり、`.node` の有無だけでは安全と判断できない。
// ライブラリ自身の宣言（binding.gyp・gypfile・install系スクリプト）を見る。
describe('declaresNativeBuild: 組み立てが要ると自分で宣言しているか', () => {
  it('★ binding.gyp があれば true', () => {
    expect(declaresNativeBuild({}, true)).toBe(true)
  })

  it('★ gypfile: true なら true', () => {
    expect(declaresNativeBuild({ gypfile: true }, false)).toBe(true)
  })

  it('★ install が prebuild-install || node-gyp rebuild --release なら true（better-sqlite3 の形）', () => {
    const pkg = { scripts: { install: 'prebuild-install || node-gyp rebuild --release' } }
    expect(declaresNativeBuild(pkg, false)).toBe(true)
  })

  it('★ install が node-pre-gyp install --fallback-to-build なら true', () => {
    const pkg = { scripts: { install: 'node-pre-gyp install --fallback-to-build' } }
    expect(declaresNativeBuild(pkg, false)).toBe(true)
  })

  it('★★ postinstall が node -e "try{require(\'./postinstall\')}catch(e){}" なら false（core-js・誤検知しない）', () => {
    const pkg = { scripts: { postinstall: 'node -e "try{require(\'./postinstall\')}catch(e){}"' } }
    expect(declaresNativeBuild(pkg, false)).toBe(false)
  })

  it('★★ postinstall が node install.js なら false（esbuild・誤検知しない）', () => {
    const pkg = { scripts: { postinstall: 'node install.js' } }
    expect(declaresNativeBuild(pkg, false)).toBe(false)
  })

  it('husky の prepare（install 系ではない）も false', () => {
    const pkg = { scripts: { prepare: 'husky install' } }
    expect(declaresNativeBuild(pkg, false)).toBe(false)
  })

  it('何も無い普通のライブラリ（express 相当）は false', () => {
    expect(declaresNativeBuild({ name: 'express', scripts: { test: 'echo ok' } }, false)).toBe(false)
    expect(declaresNativeBuild({}, false)).toBe(false)
  })

  it('壊れた package.json（null・文字列・配列）でも落ちない', () => {
    expect(declaresNativeBuild(null, false)).toBe(false)
    expect(declaresNativeBuild('express', false)).toBe(false)
    expect(declaresNativeBuild([], false)).toBe(false)
    // binding.gyp があるなら、package.json がどんな形でも true（独立した目印）
    expect(declaresNativeBuild(null, true)).toBe(true)
  })
})

// ── nativeBinaryKind（改善案 1-7・案3・2026-09-17）────────────────────────
// `.node` があるだけで断るのは止めすぎだった。Koto は公開先の形を指定して入れているので、
// 入ってくる `.node` が最初から公開先で動くものであることがある。
// **本物のバイト列を組み立てて**確かめる（ELF ヘッダだけでは glibc と musl を
// 区別できず、libc の参照名で分かれる——2026-09-17 に実際のファイルで確かめた）。
const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0))

/** ELF のヘッダ（64bit・リトルエンディアン）＋ 末尾に文字列を置いたバイト列を作る。 */
function elfBytes(opts?: { cls?: number; machine?: number; tail?: string }): Uint8Array {
  const head = new Uint8Array(0x40)
  head.set([0x7f, 0x45, 0x4c, 0x46], 0)   // ELF の目印
  head[4] = opts?.cls ?? 0x02             // class: 64bit
  head[5] = 0x01                          // data: リトルエンディアン
  const machine = opts?.machine ?? 0x3e   // e_machine: x86-64
  head[0x12] = machine & 0xff
  head[0x13] = (machine >> 8) & 0xff
  const tail = ascii(opts?.tail ?? '')
  const out = new Uint8Array(head.length + tail.length)
  out.set(head, 0)
  out.set(tail, head.length)
  return out
}

describe('nativeBinaryKind: 部品の種類を見分ける', () => {
  it('★★ ELF ＋ musl の参照 → linux-musl-x64（公開先で動く・これを通す）', () => {
    const buf = elfBytes({ tail: '\0/lib/ld-musl-x86_64.so.1\0libc.musl-x86_64.so.1\0' })
    expect(nativeBinaryKind(buf)).toBe('linux-musl-x64')
  })

  it('★★ ELF ＋ libc.so.6 → linux-glibc-x64（Linux 用でも公開先では動かない）', () => {
    expect(nativeBinaryKind(elfBytes({ tail: '\0libc.so.6\0' }))).toBe('linux-glibc-x64')
  })

  it('★★ 両方あっても musl を先に見る（順序を入れ替えると誤判定する）', () => {
    expect(nativeBinaryKind(elfBytes({ tail: '\0libc.so.6\0libc.musl-x86_64.so.1\0' }))).toBe('linux-musl-x64')
  })

  it('★★ ELF だが libc の参照が無い → unknown（musl と決めつけない）', () => {
    expect(nativeBinaryKind(elfBytes({ tail: '\0just some data\0' }))).toBe('unknown')
  })

  it('★★ ELF だが e_machine が違う（arm64）→ linux-other', () => {
    expect(nativeBinaryKind(elfBytes({ machine: 0xb7, tail: '\0libc.musl-x86_64.so.1\0' }))).toBe('linux-other')
  })

  it('★ ELF だが 32bit（class=01）→ linux-other', () => {
    expect(nativeBinaryKind(elfBytes({ cls: 0x01, tail: '\0libc.so.6\0' }))).toBe('linux-other')
  })

  it('★★ Mach-O の4通りの目印 → macho（お使いのパソコン用）', () => {
    const magics = [
      [0xcf, 0xfa, 0xed, 0xfe], [0xce, 0xfa, 0xed, 0xfe],
      [0xfe, 0xed, 0xfa, 0xcf], [0xfe, 0xed, 0xfa, 0xce],
    ]
    for (const m of magics) {
      expect(nativeBinaryKind(new Uint8Array([...m, 0x07, 0x00, 0x00, 0x01]))).toBe('macho')
    }
  })

  it('短すぎる入力・空・見覚えのない先頭でも落ちない', () => {
    expect(nativeBinaryKind(new Uint8Array(0))).toBe('unknown')
    expect(nativeBinaryKind(new Uint8Array([0x7f, 0x45]))).toBe('unknown')
    // ELF の目印はあるが、ヘッダの途中で切れている
    expect(nativeBinaryKind(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02]))).toBe('linux-other')
    expect(nativeBinaryKind(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBe('unknown')
  })

  it('★ 通してよいのは linux-musl-x64 だけ', () => {
    expect(runsOnPublishTarget('linux-musl-x64')).toBe(true)
    for (const k of ['linux-glibc-x64', 'linux-other', 'macho', 'unknown'] as const) {
      expect(runsOnPublishTarget(k)).toBe(false)
    }
  })
})

describe('blockReasonForPackage: 断るかどうかはライブラリ単位で決める', () => {
  it('★★ 公開先で動く部品を1つでも持っていれば通す（sharp の形）', () => {
    expect(blockReasonForPackage(['linux-musl-x64'], false)).toBe(null)
  })

  it('★★ お使いのパソコン用と公開先用の両方を同梱していれば通す（各OS用を全部入れる形）', () => {
    expect(blockReasonForPackage(['macho', 'linux-glibc-x64', 'linux-musl-x64'], false)).toBe(null)
  })

  it('★★ .node があれば、組み立ての宣言より .node を先に見る（誤って「組み立て前」にしない）', () => {
    expect(blockReasonForPackage(['linux-musl-x64'], true)).toBe(null)
  })

  it('★ お使いのパソコン用しか無ければ断る', () => {
    expect(blockReasonForPackage(['macho'], false)).toBe('macho-only')
  })

  it('★ 公開先とは別の種類の Linux 用しか無ければ断る', () => {
    expect(blockReasonForPackage(['linux-glibc-x64'], false)).toBe('other-linux')
    expect(blockReasonForPackage(['macho', 'linux-other'], false)).toBe('other-linux')
  })

  it('★ 種類が分からないものは通さない', () => {
    expect(blockReasonForPackage(['unknown'], false)).toBe('unknown')
    expect(blockReasonForPackage(['macho', 'unknown'], false)).toBe('unknown')
  })

  it('★ .node が1つも無く、組み立てが要ると宣言していれば断る（これまでどおり）', () => {
    expect(blockReasonForPackage([], true)).toBe('needs-build')
  })

  it('.node も宣言も無い普通のライブラリは通す', () => {
    expect(blockReasonForPackage([], false)).toBe(null)
  })

  it('理由が混ざったら、断定できるものを先に使う', () => {
    expect(primaryBlockReason(['unknown', 'needs-build'])).toBe('needs-build')
    expect(primaryBlockReason(['unknown', 'other-linux'])).toBe('other-linux')
    expect(primaryBlockReason(['unknown'])).toBe('unknown')
  })
})

describe('断る文面を、理由ごとに書き分ける', () => {
  const tail = /AIに「このライブラリを使わない作りに直して」と頼むか、公開先を「エキスパート（自分の Dockerfile）」に切り替えてください。$/

  it('★ 組み立てられていないとき（これまでの文面のまま）', () => {
    const m = nativeDepsMessage(['better-sqlite3'], 'needs-build')
    expect(m).toContain('パソコンごとに組み立てが必要な部品を含んでいます')
    expect(m).toMatch(tail)
  })

  it('★ お使いのパソコン用しか入っていないとき', () => {
    const m = nativeDepsMessage(['bcrypt'], 'macho-only')
    expect(m).toContain('お使いのパソコン用の部品しか入っていません')
    expect(m).not.toContain('組み立てが必要')
    expect(m).toMatch(tail)
  })

  it('★ 公開先とは別の種類の Linux 用のとき', () => {
    const m = nativeDepsMessage(['bcrypt'], 'other-linux')
    expect(m).toContain('公開先とは別の種類の Linux 用の部品です')
    expect(m).not.toContain('組み立てが必要')
    expect(m).toMatch(tail)
  })

  it('★ 種類を確かめられなかったとき', () => {
    const m = nativeDepsMessage(['bcrypt'], 'unknown')
    expect(m).toContain('種類を確かめられませんでした')
    expect(m).toMatch(tail)
  })

  it('★★ 専門用語（ELF・musl・glibc・Mach-O）を画面に出さない', () => {
    for (const r of ['needs-build', 'macho-only', 'other-linux', 'unknown'] as const) {
      const m = nativeDepsMessage(['bcrypt'], r)
      expect(m).not.toMatch(/ELF|musl|glibc|Mach-O|x86_64|arm64/i)
    }
  })

  it('理由を渡さなければ、これまでの文面（組み立てられていない）になる', () => {
    expect(nativeDepsMessage(['sqlite3'])).toBe(nativeDepsMessage(['sqlite3'], 'needs-build'))
  })
})

// ── 理由が混ざっても、事実と違う説明をしない（検分の指摘・2026-09-17）──────────
//
// 理由を1つに畳んで名前を全部並べると、当てはまらない理由を告げることになる。
// 例: better-sqlite3（組み立てが要る）と、お使いのパソコン用の部品しか無いライブラリが
// 同時に引っかかると、両方の名前を並べて「組み立てが必要」と出てしまい、後者の持ち主は
// 「組み立てを待てば直る」と原因を取り違える。
describe('断る文面: 理由が混ざったら、理由ごとにまとめて並べる', () => {
  const MIXED = [
    { name: 'better-sqlite3', reason: 'needs-build' as const },
    { name: '@img/sharp-darwin-arm64', reason: 'macho-only' as const },
  ]

  it('★★ 組み立てが要らないライブラリに「組み立てが必要」と言わない', () => {
    const m = nativeDepsMessageForBlocked(MIXED)
    const build = m.split('\n').find(l => l.includes('組み立てが必要')) ?? ''
    expect(build).toContain('better-sqlite3')
    expect(build, 'お使いのパソコン用しか無いライブラリに「組み立てが必要」と言っている')
      .not.toContain('@img/sharp-darwin-arm64')
  })

  it('★★ お使いのパソコン用しか無いライブラリには、その理由が付く', () => {
    const m = nativeDepsMessageForBlocked(MIXED)
    const mac = m.split('\n').find(l => l.includes('お使いのパソコン用の部品しか入っていません')) ?? ''
    expect(mac).toContain('@img/sharp-darwin-arm64')
    expect(mac).not.toContain('better-sqlite3')
  })

  it('★ 理由の数だけ文が並び、次の一手は最後に1回だけ', () => {
    const m = nativeDepsMessageForBlocked(MIXED)
    expect(m.split('\n').length).toBe(2)
    expect(m.match(/エキスパート/g)?.length).toBe(1)
  })

  it('★ 理由が1つだけなら、これまでの文面と同じ', () => {
    expect(nativeDepsMessageForBlocked([{ name: 'bcrypt', reason: 'macho-only' }]))
      .toBe(nativeDepsMessage(['bcrypt'], 'macho-only'))
  })

  it('★ 同じ理由のライブラリは1文にまとまる', () => {
    const m = nativeDepsMessageForBlocked([
      { name: 'a', reason: 'other-linux' },
      { name: 'b', reason: 'other-linux' },
    ])
    expect(m.split('\n').length).toBe(1)
    expect(m).toContain('a、b')
  })

  it('★★ 混ざっても専門用語（ELF・musl・glibc・Mach-O）を画面に出さない', () => {
    const m = nativeDepsMessageForBlocked([
      { name: 'a', reason: 'needs-build' }, { name: 'b', reason: 'macho-only' },
      { name: 'c', reason: 'other-linux' }, { name: 'd', reason: 'unknown' },
    ])
    expect(m).not.toMatch(/ELF|musl|glibc|Mach-O|x86_64|arm64/i)
    expect(m.split('\n').length).toBe(4)
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
    // **理由まで渡していること**を、呼び出しの形ごと一意に指す（検分の指摘・2026-09-17）。
    // 以前は `throw new Error(nativeDepsMessage` までしか見ておらず、**第2引数（理由）を
    // 落とす変異を素通り**させていた。実際に投げられる文面は
    // tests/imageBuildNativeBlock.test.ts が本物の呼び出しで固定している。
    expect(img).toMatch(
      /nativeBlocked\.length > 0[\s\S]{0,400}throw new Error\(nativeDepsMessageForBlocked\(r\.nativeBlocked\)\)/)
    expect(img, '理由を落とした古い呼び方に戻っている').not.toMatch(/nativeDepsMessage\(r\.nativePackages/)
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
