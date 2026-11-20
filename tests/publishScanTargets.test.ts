import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { scanTargetOf, LOCKFILE_RE, ASSET_FILE_RE, isKotoBuildConfig } from '../src/shared/publishScanTargets'

const ROOT = path.join(__dirname, '..')

describe('scanTargetOf', () => {
  it.each(['.env', 'credentials.json', 'service-account-x.json', 'sub/.env'])('%s は名前だけ見る', (f) => {
    expect(scanTargetOf(f)).toBe('secret-name')
  })
  it.each(['package-lock.json', 'sub/yarn.lock', 'pnpm-lock.yaml', 'Dockerfile', 'nginx.conf', '.dockerignore', 'a.png', 'img/b.JPG', 'f.woff2', 'v.mp4'])('%s は飛ばす', (f) => {
    expect(scanTargetOf(f)).toBe('skip')
  })
  it.each(['server.js', 'index.html', 'config.php', 'data.txt', 'Makefile', 'logo.svg', 'a.pdf'])('%s は読む', (f) => {
    expect(scanTargetOf(f)).toBe('scan')
  })
})

describe('定義は1か所', () => {
  it('isKotoBuildConfig は名簿の名前に当たる', () => {
    expect(isKotoBuildConfig('Dockerfile')).toBe(true)
    expect(isKotoBuildConfig('a/nginx.conf')).toBe(true)
    expect(isKotoBuildConfig('app.js')).toBe(false)
  })
  it('正規表現が期待どおり', () => {
    expect(LOCKFILE_RE.test('package-lock.json')).toBe(true)
    expect(ASSET_FILE_RE.test('a.svg')).toBe(false)
  })
  it('securityCheck.ts は同じ定義を import し、自分では定義を持たない', () => {
    const s = fs.readFileSync(path.join(ROOT, 'src/renderer/securityCheck.ts'), 'utf-8')
    expect(s).toContain("import { LOCKFILE_RE, ASSET_FILE_RE, isKotoBuildConfig } from '../shared/publishScanTargets'")
    expect(s).not.toContain('LOCKFILE_RE =')
    expect(s).not.toContain('ASSET_FILE_RE =')
    expect(s).not.toContain('function isKotoBuildConfig')
  })
})

describe("scanTargetOf: 範囲 'github'（GitHub 保存）", () => {
  it.each(['package-lock.json', 'sub/yarn.lock', 'Dockerfile', 'nginx.conf', '.dockerignore'])('%s は読む', (f) => {
    expect(scanTargetOf(f, 'github')).toBe('scan')
  })
  it.each(['a.png', 'v.mp4'])('%s は素材なので飛ばす', (f) => {
    expect(scanTargetOf(f, 'github')).toBe('skip')
  })
  it.each(['package-lock.json', 'Dockerfile'])('%s は、公開の範囲では引数なしでも飛ばす', (f) => {
    expect(scanTargetOf(f)).toBe('skip')
    expect(scanTargetOf(f, 'publish')).toBe('skip')
  })
})

describe('scanTargetOf: 素材と秘密らしい名前は範囲によらず同じ', () => {
  it.each(['publish', 'github'] as const)('%s: 素材は飛ばし、秘密らしい名前は secret-name', (scope) => {
    expect(scanTargetOf('a.png', scope)).toBe('skip')
    expect(scanTargetOf('.env', scope)).toBe('secret-name')
    expect(scanTargetOf('app.js', scope)).toBe('scan')
  })
})

describe('scanTargetOf: 秘密らしい名前の確かめが、飛ばすより先', () => {
  // 名前が秘密らしく、かつ素材の拡張子にも当たるものは、飛ばさず名前の指摘にする
  it.each(['credentials.png', 'secret.mp4', 'img/credentials.woff2'])('%s は名前だけ見る', (f) => {
    expect(scanTargetOf(f)).toBe('secret-name')
    expect(scanTargetOf(f, 'github')).toBe('secret-name')
  })
})
