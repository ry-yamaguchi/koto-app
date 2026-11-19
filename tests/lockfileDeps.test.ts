import { describe, it, expect } from 'vitest'
import {
  lockfileDeps, manifestDeps, manifestMatch, hasProductionDeps, exampleDeps, PUBLIC_REGISTRY_PREFIX,
  type LockfilePlan, type RootDeps,
} from '../src/shared/lockfileDeps'

// npm 11 が作った package-lock.json（lockfileVersion 3）の形を小さく写したもの。
const R = PUBLIC_REGISTRY_PREFIX
const REAL_PACKAGES: Record<string, unknown> = {
  '': {
    name: 'lock-probe', version: '1.0.0',
    dependencies: { '@babel/traverse': '7.23.0', express: '4.17.1', 'my-lodash': 'npm:lodash@4.17.20' },
    devDependencies: { 'left-pad': '1.3.0' },
    optionalDependencies: { fsevents: '2.3.3' },
  },
  'node_modules/express': {
    version: '4.17.1', resolved: `${R}express/-/express-4.17.1.tgz`, integrity: 'sha512-AAAA', license: 'MIT',
    dependencies: { debug: '2.6.9' },
  },
  'node_modules/my-lodash': {
    name: 'lodash', version: '4.17.20', resolved: `${R}lodash/-/lodash-4.17.20.tgz`, integrity: 'sha512-BBBB', license: 'MIT',
  },
  'node_modules/@babel/traverse': {
    version: '7.23.0', resolved: `${R}@babel/traverse/-/traverse-7.23.0.tgz`, integrity: 'sha512-CCCC', license: 'MIT',
  },
  'node_modules/left-pad': {
    version: '1.3.0', resolved: `${R}left-pad/-/left-pad-1.3.0.tgz`, integrity: 'sha512-DDDD', dev: true, license: 'WTFPL',
  },
  'node_modules/fsevents': {
    version: '2.3.3', resolved: `${R}fsevents/-/fsevents-2.3.3.tgz`, integrity: 'sha512-EEEE', hasInstallScript: true,
    license: 'MIT', optional: true, os: ['darwin'],
  },
  'node_modules/express/node_modules/debug': {
    version: '2.6.9', resolved: `${R}debug/-/debug-2.6.9.tgz`, integrity: 'sha512-FFFF', license: 'MIT',
  },
}

function lock(packages: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'x', lockfileVersion: 3, requires: true, packages, ...extra })
}
function withEntry(entry: unknown, key = 'node_modules/foo'): string {
  return lock({ '': { name: 'x' }, [key]: entry })
}
function ok(text: string): Extract<LockfilePlan, { state: 'ok' }> {
  const p = lockfileDeps(text)
  if (p.state !== 'ok') throw new Error(`state=${p.state}`)
  return p
}
const names = (p: Extract<LockfilePlan, { state: 'ok' }>) => p.deps.map((d) => `${d.name}@${d.version}`)

describe('lockfileDeps: スコープ付き', () => {
  it('resolved が公開のレジストリの形なら、スコープ付きも送る（npmjs.org 上の非公開のものとは、URL の形では見分けられない）', () => {
    const p = ok(lock({ 'node_modules/@acme/pkg': { version: '1.0.0', resolved: `${R}@acme/pkg/-/pkg-1.0.0.tgz` }, 'node_modules/express': { version: '4.17.1', resolved: `${R}express/-/express-4.17.1.tgz` } }))
    expect(names(p)).toEqual(['@acme/pkg@1.0.0', 'express@4.17.1'])
    expect(p.skipped.notPublic).toBe(0)
  })
  it('スコープ付きでも、ほかのレジストリ・名前と URL の食い違いは送らない', () => {
    const p = ok(lock({
      'node_modules/@acme/a': { version: '1.0.0', resolved: 'https://npm.acme.example/@acme/a/-/a-1.0.0.tgz' },
      'node_modules/@acme/b': { version: '1.0.0', resolved: `${R}@other/b/-/b-1.0.0.tgz` },
    }))
    expect(names(p)).toEqual([])
    expect(p.skipped.notPublic).toBe(2)
  })
  it('ビルドの印（+…）つきのバージョンは送らない', () => {
    const p = ok(lock({ 'node_modules/a': { version: '1.0.0+acme-internal', resolved: `${R}a/-/a-1.0.0.tgz` }, 'node_modules/b': { version: '1.0.0-rc.1', resolved: `${R}b/-/b-1.0.0-rc.1.tgz` } }))
    expect(names(p)).toEqual(['b@1.0.0-rc.1'])
    expect(p.skipped.badShape).toBe(1)
  })
})

describe('lockfileDeps: 実物の形', () => {
  const plan = ok(lock(REAL_PACKAGES))

  it('公開のライブラリが入る（別名は本当の名前で）', () => {
    const list = names(plan)
    expect(list).toContain('express@4.17.1')
    expect(list).toContain('lodash@4.17.20')
    expect(list).toContain('@babel/traverse@7.23.0')
    expect(list).toContain('fsevents@2.3.3')
    expect(list).toContain('debug@2.6.9')
    expect(list.some((s) => s.startsWith('my-lodash'))).toBe(false)
  })

  it('開発用は送らず数える', () => {
    expect(names(plan).some((s) => s.startsWith('left-pad'))).toBe(false)
    expect(plan.skipped).toEqual({ dev: 1, notPublic: 0, badShape: 0 })
  })

  it('ルートの dependencies と optionalDependencies を取り出す', () => {
    expect(plan.rootDeps).toEqual({
      dependencies: { '@babel/traverse': '7.23.0', express: '4.17.1', 'my-lodash': 'npm:lodash@4.17.20' },
      optionalDependencies: { fsevents: '2.3.3' },
    })
  })

  it('戻り値に integrity・resolved の URL が入らない', () => {
    const s = JSON.stringify(plan)
    expect(s).not.toContain('integrity')
    expect(s).not.toContain('sha512')
    expect(s).not.toContain('registry.npmjs.org')
    expect(s).not.toContain('node_modules')
  })
})

describe('lockfileDeps: 送らないもの', () => {
  it('別名で名前と URL が食い違うもの（name が無い）は送らず notPublic', () => {
    const p = ok(withEntry({ version: '4.17.20', resolved: `${R}lodash/-/lodash-4.17.20.tgz` }, 'node_modules/my-lodash'))
    expect(p.deps).toEqual([])
    expect(p.skipped.notPublic).toBe(1)
  })

  it.each([
    ['git+ssh', { version: '1.0.0', resolved: 'git+ssh://git@github.com/acme/secret-lib.git#abc' }],
    ['file:', { version: '1.0.0', resolved: 'file:../secret-lib' }],
    ['ほかのレジストリ', { version: '1.0.0', resolved: 'https://npm.example.com/foo/-/foo-1.0.0.tgz' }],
    ['resolved が無い', { version: '1.0.0' }],
    ['resolved が文字列でない', { version: '1.0.0', resolved: 5 }],
  ])('%s は notPublic で、一覧に名前が出ない', (_t, entry) => {
    const p = ok(withEntry(entry))
    expect(p.deps).toEqual([])
    expect(p.skipped.notPublic).toBe(1)
    expect(JSON.stringify(p)).not.toContain('foo')
  })

  it.each([
    `https://registry.npmjs.org.evil.example/foo/-/foo-1.0.0.tgz`,
    `http://registry.npmjs.org/foo/-/foo-1.0.0.tgz`,
    `https://registry.npmjs.org/foobar/-/foo-1.0.0.tgz`,
    `https://registry.npmjs.org/foo/foo-1.0.0.tgz`,
  ])('公開のレジストリでない resolved は送らない: %s', (resolved) => {
    const p = ok(withEntry({ version: '1.0.0', resolved }))
    expect(p.deps).toEqual([])
    expect(p.skipped.notPublic).toBe(1)
  })

  it.each([['^4.19.0'], ['latest'], ['4.19'], [4]])('version が %j なら送らず badShape', (version) => {
    const p = ok(withEntry({ version, resolved: `${R}foo/-/foo-1.0.0.tgz` }))
    expect(p.deps).toEqual([])
    expect(p.skipped.badShape).toBe(1)
  })

  it.each([
    ['空白', 'node_modules/fo o'],
    ['改行', 'node_modules/foo\nbar'],
    ['..', 'node_modules/..'],
    ['/ が2つ', 'node_modules/@a/b/c'],
  ])('名前に%sがあれば送らず badShape', (_t, key) => {
    const p = ok(withEntry({ version: '1.0.0', resolved: `${R}x/-/x-1.0.0.tgz` }, key))
    expect(p.deps).toEqual([])
    expect(p.skipped.badShape).toBe(1)
  })

  it('name が文字列でなければ badShape', () => {
    const p = ok(withEntry({ name: 5, version: '1.0.0', resolved: `${R}foo/-/foo-1.0.0.tgz` }))
    expect(p.skipped.badShape).toBe(1)
  })

  it('項目が物でなければ badShape', () => {
    const p = ok(withEntry('foo'))
    expect(p.skipped.badShape).toBe(1)
  })

  it('大文字の名前は受ける', () => {
    const p = ok(withEntry({ version: '1.0.0', resolved: `${R}JSONStream/-/JSONStream-1.0.0.tgz` }, 'node_modules/JSONStream'))
    expect(names(p)).toEqual(['JSONStream@1.0.0'])
  })

  it('optional・devOptional・peer は送る側', () => {
    const e = (extra: object) => ({ version: '1.0.0', resolved: `${R}foo/-/foo-1.0.0.tgz`, ...extra })
    for (const extra of [{ optional: true }, { devOptional: true }, { peer: true }]) {
      expect(names(ok(withEntry(e(extra))))).toEqual(['foo@1.0.0'])
    }
  })
})

describe('lockfileDeps: 名前の長さ・宛先・欠けた項目', () => {
  it('送る宛先は公開の npm レジストリに固定されている', () => {
    expect(PUBLIC_REGISTRY_PREFIX).toBe('https://registry.npmjs.org/')
    const p = ok(withEntry({ version: '1.0.0', resolved: 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz' }))
    expect(names(p)).toEqual(['foo@1.0.0'])
    const q = ok(withEntry({ version: '1.0.0', resolved: 'https://registry.yarnpkg.com/foo/-/foo-1.0.0.tgz' }))
    expect(q.deps).toEqual([])
    expect(q.skipped.notPublic).toBe(1)
  })

  it('名前が 214 字なら送り、215 字なら badShape', () => {
    const ok214 = 'a'.repeat(214)
    const p = ok(withEntry({ version: '1.0.0', resolved: `${R}${ok214}/-/x-1.0.0.tgz` }, `node_modules/${ok214}`))
    expect(p.deps).toEqual([{ name: ok214, version: '1.0.0' }])
    const long = 'a'.repeat(215)
    const q = ok(withEntry({ version: '1.0.0', resolved: `${R}${long}/-/x-1.0.0.tgz` }, `node_modules/${long}`))
    expect(q.deps).toEqual([])
    expect(q.skipped.badShape).toBe(1)
  })

  it('resolved だけあって version が無い項目は badShape', () => {
    const p = ok(withEntry({ resolved: `${R}foo/-/foo-1.0.0.tgz` }))
    expect(p.deps).toEqual([])
    expect(p.skipped.badShape).toBe(1)
  })
})

describe('lockfileDeps: 数えずに飛ばすもの', () => {
  const zero = { dev: 0, notPublic: 0, badShape: 0 }
  it('link: true', () => {
    const p = ok(withEntry({ resolved: 'packages/a', link: true }))
    expect(p.deps).toEqual([])
    expect(p.skipped).toEqual(zero)
  })
  it('node_modules/ を含まないキー（ワークスペースの自分のコード）', () => {
    const p = ok(withEntry({ name: 'a', version: '1.0.0' }, 'packages/a'))
    expect(p.skipped).toEqual(zero)
  })
  it('version も resolved も無い項目', () => {
    const p = ok(withEntry({ optional: true, os: ['win32'] }))
    expect(p.deps).toEqual([])
    expect(p.skipped).toEqual(zero)
  })
})

describe('lockfileDeps: 読める形', () => {
  it.each([
    ['lockfileVersion 1', JSON.stringify({ lockfileVersion: 1, packages: {}, dependencies: {} })],
    ['lockfileVersion が無い', JSON.stringify({ packages: {} })],
    ['lockfileVersion 4', JSON.stringify({ lockfileVersion: 4, packages: {} })],
    ['lockfileVersion が文字列', JSON.stringify({ lockfileVersion: '3', packages: {} })],
    ['packages が配列', JSON.stringify({ lockfileVersion: 3, packages: [] })],
    ['packages が無い', JSON.stringify({ lockfileVersion: 3 })],
  ])('%s は unsupported', (_t, text) => {
    expect(lockfileDeps(text)).toEqual({ state: 'unsupported' })
  })

  it.each([['壊れた JSON', '{"lockfileVersion": 3,'], ['最上位が配列', '[]'], ['最上位が null', 'null'], ['空', '']])(
    '%s は unreadable', (_t, text) => {
      expect(lockfileDeps(text)).toEqual({ state: 'unreadable' })
    },
  )

  it('lockfileVersion 2 も読む', () => {
    const p = ok(JSON.stringify({ lockfileVersion: 2, packages: REAL_PACKAGES }))
    expect(p.deps.length).toBe(5)
  })

  it('重複（入れ子に同じ名前と版）は1回・並びは名前順、次に版', () => {
    const e = (n: string, v: string) => ({ version: v, resolved: `${R}${n}/-/${n}-${v}.tgz` })
    const p = ok(lock({
      '': {},
      'node_modules/zed': e('zed', '1.0.0'),
      'node_modules/a/node_modules/debug': e('debug', '2.6.9'),
      'node_modules/debug': e('debug', '2.6.9'),
      'node_modules/b/node_modules/debug': e('debug', '10.0.0'),
      'node_modules/Alpha': e('Alpha', '1.0.0'),
    }))
    expect(names(p)).toEqual(['Alpha@1.0.0', 'debug@10.0.0', 'debug@2.6.9', 'zed@1.0.0'])
  })

  it('packages[""] が無い・物でないなら rootDeps は null', () => {
    expect(ok(lock({})).rootDeps).toBeNull()
    expect(ok(lock({ '': 'x' })).rootDeps).toBeNull()
  })

  it('ルートの値が文字列でなければ rootDeps は null', () => {
    expect(ok(lock({ '': { dependencies: { a: 1 } } })).rootDeps).toBeNull()
  })

  it('ルートに dependencies が無ければ空の物', () => {
    expect(ok(lock({ '': {} })).rootDeps).toEqual({ dependencies: {}, optionalDependencies: {} })
  })
})

describe('manifestDeps / manifestMatch / hasProductionDeps', () => {
  const root = (d: Record<string, string>, o: Record<string, string> = {}): RootDeps => ({ dependencies: d, optionalDependencies: o })

  it('package.json から取り出す・devDependencies は見ない', () => {
    expect(manifestDeps(JSON.stringify({ dependencies: { a: '^1.0.0' }, devDependencies: { b: '1' } })))
      .toEqual(root({ a: '^1.0.0' }))
  })

  it.each([['JSON でない', 'nope'], ['最上位が配列', '[]'], ['値が文字列でない', '{"dependencies":{"a":1}}'], ['dependencies が物でない', '{"dependencies":[]}'],
    ['optionalDependencies が壊れている', '{"optionalDependencies":{"a":null}}']])('%s は null', (_t, text) => {
    expect(manifestDeps(text)).toBeNull()
  })

  it('同じなら match', () => {
    expect(manifestMatch(root({ a: '^1.0.0' }, { b: '2.0.0' }), root({ a: '^1.0.0' }, { b: '2.0.0' }))).toBe('match')
    expect(manifestMatch(root({}), root({}))).toBe('match')
  })
  it('範囲の文字列が1文字違えば mismatch', () => {
    expect(manifestMatch(root({ a: '^1.0.0' }), root({ a: '^1.0.1' }))).toBe('mismatch')
  })
  it('キーが増えれば mismatch', () => {
    expect(manifestMatch(root({ a: '1.0.0' }), root({ a: '1.0.0', b: '1.0.0' }))).toBe('mismatch')
    expect(manifestMatch(root({ a: '1.0.0', b: '1.0.0' }), root({ a: '1.0.0' }))).toBe('mismatch')
    expect(manifestMatch(root({ a: '1.0.0' }), root({ b: '1.0.0' }))).toBe('mismatch')
  })
  it('optionalDependencies だけ違っても mismatch', () => {
    expect(manifestMatch(root({ a: '1.0.0' }, { f: '1.0.0' }), root({ a: '1.0.0' }, { f: '1.0.1' }))).toBe('mismatch')
    expect(manifestMatch(root({ a: '1.0.0' }, { f: '1.0.0' }), root({ a: '1.0.0' }))).toBe('mismatch')
  })
  it('キー __proto__ も値を比べる', () => {
    const a = manifestDeps('{"dependencies":{"__proto__":"a"}}')
    const b = manifestDeps('{"dependencies":{"__proto__":"b"}}')
    const c = manifestDeps('{"dependencies":{"__proto__":"a"}}')
    expect(manifestMatch(a, b)).toBe('mismatch')
    expect(manifestMatch(a, c)).toBe('match')
    expect(manifestMatch(a, manifestDeps('{}'))).toBe('mismatch')
  })
  it('片方が null なら unreadable', () => {
    expect(manifestMatch(null, root({}))).toBe('unreadable')
    expect(manifestMatch(root({}), null)).toBe('unreadable')
    expect(manifestMatch(null, null)).toBe('unreadable')
  })
  it('devDependencies の違いは match のまま', () => {
    const lockRoot = ok(lock({ '': { dependencies: { a: '1.0.0' }, devDependencies: { x: '1' } } })).rootDeps
    const mani = manifestDeps(JSON.stringify({ dependencies: { a: '1.0.0' }, devDependencies: { y: '2' } }))
    expect(manifestMatch(lockRoot, mani)).toBe('match')
  })

  it('hasProductionDeps', () => {
    expect(hasProductionDeps(root({}))).toBe(false)
    expect(hasProductionDeps(root({ a: '1' }))).toBe(true)
    expect(hasProductionDeps(root({}, { f: '1' }))).toBe(true)
  })
})

describe('exampleDeps', () => {
  const d = (name: string, version = '1.0.0') => ({ name, version })
  const root = (deps: Record<string, string>): RootDeps => ({ dependencies: deps, optionalDependencies: {} })
  it('package.json に直接書かれたライブラリを先に選ぶ（deps の並び順のまま）', () => {
    const deps = [d('a'), d('b'), d('c'), d('d')]
    expect(exampleDeps(deps, root({ c: '1', b: '1' }), 2)).toEqual(['b 1.0.0', 'c 1.0.0'])
  })
  it('足りなければ残りを deps の並び順で足し、count 件まで', () => {
    const deps = [d('a'), d('b'), d('c')]
    expect(exampleDeps(deps, root({ c: '1' }), 2)).toEqual(['c 1.0.0', 'a 1.0.0'])
    expect(exampleDeps(deps, root({ c: '1' }), 10)).toEqual(['c 1.0.0', 'a 1.0.0', 'b 1.0.0'])
  })
  it('deps が空なら空。rootDeps が null なら先頭から', () => {
    expect(exampleDeps([], root({ a: '1' }), 2)).toEqual([])
    expect(exampleDeps([d('a'), d('b'), d('c')], null, 2)).toEqual(['a 1.0.0', 'b 1.0.0'])
  })
  it('重複は出さない', () => {
    expect(exampleDeps([d('a'), d('a'), d('b')], root({ a: '1' }), 3)).toEqual(['a 1.0.0', 'b 1.0.0'])
  })
})
