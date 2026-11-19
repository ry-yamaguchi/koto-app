import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readOsvPlanFs } from '../src/main/osvProjectRead'
import { PUBLIC_REGISTRY_PREFIX as R } from '../src/shared/lockfileDeps'

let base = ''
let proj = ''
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osv-read-')))
  proj = path.join(base, 'proj')
  fs.mkdirSync(proj)
})
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

const pub = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version, resolved: `${R}${name}/-/${name}-${version}.tgz`, integrity: `sha512-SECRET-${name}`, ...extra,
})
function lock(root: Record<string, unknown>, rest: Record<string, unknown>): string {
  return JSON.stringify({ name: 'p', lockfileVersion: 3, packages: { '': root, ...rest } })
}
const GOOD_LOCK = lock(
  { dependencies: { express: '4.17.1' }, devDependencies: { vitest: '1.0.0' } },
  {
    'node_modules/express': pub('express', '4.17.1'),
    'node_modules/vitest': pub('vitest', '1.0.0', { dev: true }),
    'node_modules/internal-x': { version: '1.0.0', resolved: 'https://npm.corp.example/internal-x/-/internal-x-1.0.0.tgz', integrity: 'sha512-ZZ' },
  },
)
const GOOD_PKG = JSON.stringify({ dependencies: { express: '4.17.1' }, devDependencies: { vitest: '1.0.0' } })
const w = (dir: string, name: string, content: string) => fs.writeFileSync(path.join(dir, name), content)

describe('公開の根', () => {
  it('public フォルダがあれば、その中を読み、直下は読まない', () => {
    fs.mkdirSync(path.join(proj, 'public'))
    w(path.join(proj, 'public'), 'package.json', GOOD_PKG)
    w(path.join(proj, 'public'), 'package-lock.json', GOOD_LOCK)
    w(proj, 'package-lock.json', lock({ dependencies: { 'top-only': '1.0.0' } }, { 'node_modules/top-only': pub('top-only', '1.0.0') }))
    const r = readOsvPlanFs(proj)
    expect(r.state).toBe('ok')
    expect(JSON.stringify(r)).not.toContain('top-only')
    expect(JSON.stringify(r)).toContain('express')
  })
  it('直下にだけ lockfile があって public がある形は、直下の中身を出さない', () => {
    fs.mkdirSync(path.join(proj, 'public'))
    w(proj, 'package.json', GOOD_PKG)
    w(proj, 'package-lock.json', GOOD_LOCK)
    const r = readOsvPlanFs(proj)
    expect(r.state).toBe('no-manifest')
    expect(JSON.stringify(r)).not.toContain('express')
  })
  it('public が無ければ直下を読む', () => {
    w(proj, 'package.json', GOOD_PKG)
    w(proj, 'package-lock.json', GOOD_LOCK)
    expect(readOsvPlanFs(proj).state).toBe('ok')
  })
})

describe('判断の表', () => {
  it('どちらも無い → no-manifest', () => {
    expect(readOsvPlanFs(proj)).toEqual({ state: 'no-manifest' })
  })
  it('lockfile 無し・package.json はライブラリが空 → no-deps', () => {
    w(proj, 'package.json', JSON.stringify({ name: 'x', devDependencies: { a: '1' } }))
    expect(readOsvPlanFs(proj)).toEqual({ state: 'no-deps' })
  })
  it('lockfile 無し・package.json にライブラリがある → no-lockfile', () => {
    w(proj, 'package.json', GOOD_PKG)
    expect(readOsvPlanFs(proj)).toEqual({ state: 'no-lockfile' })
  })
  it('lockfile 無し・package.json が壊れている → no-lockfile', () => {
    w(proj, 'package.json', '{ broken')
    expect(readOsvPlanFs(proj)).toEqual({ state: 'no-lockfile' })
  })
  it('lockfile が読めない（フォルダ） → unreadable', () => {
    w(proj, 'package.json', GOOD_PKG)
    fs.mkdirSync(path.join(proj, 'package-lock.json'))
    expect(readOsvPlanFs(proj)).toEqual({ state: 'unreadable' })
  })
  it('lockfile の形が未対応 → unsupported', () => {
    w(proj, 'package-lock.json', JSON.stringify({ lockfileVersion: 1, dependencies: {} }))
    expect(readOsvPlanFs(proj)).toEqual({ state: 'unsupported' })
  })
  it('lockfile が壊れている → unreadable', () => {
    w(proj, 'package-lock.json', '{ broken')
    expect(readOsvPlanFs(proj)).toEqual({ state: 'unreadable' })
  })
  it('ライブラリが空で送る一覧も 0 件 → no-deps', () => {
    w(proj, 'package.json', JSON.stringify({ name: 'x' }))
    w(proj, 'package-lock.json', lock({ name: 'x' }, {}))
    expect(readOsvPlanFs(proj)).toEqual({ state: 'no-deps' })
  })
  it('package.json も lockfile の根も読めず、送る一覧が 0 件 → 「ライブラリが無い」とは言わず、ok で deps は空', () => {
    w(proj, 'package.json', '{ broken')
    w(proj, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: 5 } } }))
    const r = readOsvPlanFs(proj)
    expect(r.state).toBe('ok')
    if (r.state === 'ok') {
      expect(r.deps).toEqual([])
      expect(r.manifest).toBe('unreadable')
    }
  })
  it('ライブラリはあるが送る一覧が 0 件（全部が公開のレジストリ以外）→ ok で deps は空', () => {
    const l = lock({ dependencies: { 'internal-x': '1.0.0' } }, {
      'node_modules/internal-x': { version: '1.0.0', resolved: 'https://npm.corp.example/internal-x/-/internal-x-1.0.0.tgz' },
    })
    w(proj, 'package.json', JSON.stringify({ dependencies: { 'internal-x': '1.0.0' } }))
    w(proj, 'package-lock.json', l)
    const r = readOsvPlanFs(proj)
    expect(r.state).toBe('ok')
    if (r.state === 'ok') {
      expect(r.deps).toEqual([])
      expect(r.skipped.notPublic).toBe(1)
    }
  })
})

describe('一覧・照合', () => {
  it('開発用・公開のレジストリ以外は deps に入らず、skipped に数だけ出る', () => {
    w(proj, 'package.json', GOOD_PKG)
    w(proj, 'package-lock.json', GOOD_LOCK)
    const r = readOsvPlanFs(proj)
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    expect(r.deps).toEqual([{ name: 'express', version: '4.17.1' }])
    expect(r.skipped.dev).toBe(1)
    expect(r.skipped.notPublic).toBe(1)
    expect(r.examples).toEqual(['express 4.17.1'])
    expect(JSON.stringify(r)).not.toContain('internal-x')
  })
  it('lockfile と package.json が合っている → match', () => {
    w(proj, 'package.json', GOOD_PKG)
    w(proj, 'package-lock.json', GOOD_LOCK)
    expect(readOsvPlanFs(proj)).toMatchObject({ state: 'ok', manifest: 'match' })
  })
  it('範囲が違う → mismatch', () => {
    w(proj, 'package.json', JSON.stringify({ dependencies: { express: '^4.0.0' } }))
    w(proj, 'package-lock.json', GOOD_LOCK)
    expect(readOsvPlanFs(proj)).toMatchObject({ state: 'ok', manifest: 'mismatch' })
  })
  it('package.json が壊れている → manifest unreadable（state は ok のまま）', () => {
    w(proj, 'package.json', '{ broken')
    w(proj, 'package-lock.json', GOOD_LOCK)
    expect(readOsvPlanFs(proj)).toMatchObject({ state: 'ok', manifest: 'unreadable' })
  })
})

describe('守り', () => {
  it('package-lock.json がリンクで外を指す → unreadable', () => {
    const outside = path.join(base, 'outside-lock.json')
    fs.writeFileSync(outside, GOOD_LOCK)
    w(proj, 'package.json', GOOD_PKG)
    fs.symlinkSync(outside, path.join(proj, 'package-lock.json'))
    expect(readOsvPlanFs(proj)).toEqual({ state: 'unreadable' })
  })
  it('上限より大きい lockfile → unreadable', () => {
    w(proj, 'package.json', GOOD_PKG)
    w(proj, 'package-lock.json', ' '.repeat(16_000_001))
    expect(readOsvPlanFs(proj)).toEqual({ state: 'unreadable' })
  })
  it('JSON として正しいまま16MB を超える lockfile は読まない（上限が外れれば ok になる入力）', () => {
    w(proj, 'package.json', GOOD_PKG)
    w(proj, 'package-lock.json', JSON.stringify({ ...JSON.parse(GOOD_LOCK), pad: 'x'.repeat(16_000_000) }))
    expect(readOsvPlanFs(proj)).toEqual({ state: 'unreadable' })
  })
  it('1MB を超えて16MB 以下の lockfile は読める', () => {
    w(proj, 'package.json', GOOD_PKG)
    w(proj, 'package-lock.json', JSON.stringify({ ...JSON.parse(GOOD_LOCK), pad: 'x'.repeat(2_000_000) }))
    expect(readOsvPlanFs(proj)).toMatchObject({ state: 'ok', manifest: 'match' })
  })
  it('1MB を超える package.json は読まず、manifest は unreadable（state は ok のまま）', () => {
    w(proj, 'package.json', JSON.stringify({ dependencies: { express: '4.17.1' }, pad: 'x'.repeat(1_100_000) }))
    w(proj, 'package-lock.json', GOOD_LOCK)
    expect(readOsvPlanFs(proj)).toMatchObject({ state: 'ok', manifest: 'unreadable' })
  })
  it('戻り値に rootDeps・絶対パス・integrity が入らない', () => {
    w(proj, 'package.json', JSON.stringify({ dependencies: { express: '4.17.1', 'private-pkg': '1.0.0' } }))
    w(proj, 'package-lock.json', lock({ dependencies: { express: '4.17.1', 'private-pkg': '1.0.0' } }, {
      'node_modules/express': pub('express', '4.17.1'),
      'node_modules/private-pkg': { version: '1.0.0', resolved: 'https://npm.corp.example/private-pkg/-/p.tgz' },
    }))
    const r = readOsvPlanFs(proj)
    const j = JSON.stringify(r)
    expect(r.state).toBe('ok')
    expect(j).not.toContain('private-pkg')
    expect(j).not.toContain('rootDeps')
    expect(j).not.toContain('integrity')
    expect(j).not.toContain('SECRET')
    expect(j).not.toContain(base)
  })
  it('フォルダが文字列でなければ unreadable（例外を投げない）', () => {
    expect(readOsvPlanFs(undefined as unknown as string)).toEqual({ state: 'unreadable' })
  })
})
