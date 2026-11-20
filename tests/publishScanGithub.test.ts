import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runPublishScanFs } from '../src/main/publishScan'

// 見本のキーは文字列の連結で組み立てる（実在しない値）
const GH_BODY = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const GH = 'gh' + 'p_' + GH_BODY
const KEY_LINE = `const t = "${GH}"\n`
const CMD_LINE = "const { exec } = require('child_process')\nexec(req.query.cmd)\n"

let base = ''
let proj = ''
const put = (rel: string, content: string | Buffer) => {
  const p = path.join(proj, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const gh = () => runPublishScanFs(proj, 'github')
const files = (r: Awaited<ReturnType<typeof gh>>) => r.findings.map(f => f.file).sort()

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-scan-gh-')))
  proj = path.join(base, 'proj')
  fs.mkdirSync(proj)
})
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

describe("範囲 'github' は保存されるファイルを見る", () => {
  it('public/・直下・素材（公開しません）/ の中のキーは見つかる', async () => {
    put('public/a.js', KEY_LINE)
    put('top.js', KEY_LINE)
    put('素材（公開しません）/m.js', KEY_LINE)
    const r = await gh()
    expect(files(r)).toEqual(['public/a.js', 'top.js', '素材（公開しません）/m.js'])
  })
  it('dist/ と node_modules/ の中のキーは見つからない', async () => {
    put('dist/a.js', KEY_LINE)
    put('node_modules/m/i.js', KEY_LINE)
    put('ok.js', 'const a = 1\n')
    const r = await gh()
    expect(r.findings).toEqual([])
    expect(r.scanned).toBe(1)
  })
  it('.env は指摘にならない（保存から外れる）', async () => {
    put('.env', `K=${GH}\n`)
    put('ok.js', 'const a = 1\n')
    const r = await gh()
    expect(r.findings).toEqual([])
  })
  it('credentials.json は secret-name の指摘（should）で、中身を読まない', async () => {
    put('credentials.json', `{"k": "${GH}"}`)
    const r = await gh()
    expect(r.findings).toEqual([{ kind: 'secret-name', file: 'credentials.json', severity: 'should' }])
    expect(r.scanned).toBe(0)
    expect(JSON.stringify(r)).not.toContain(GH_BODY)
  })
})

describe("範囲 'github' は秘密だけを見る", () => {
  it('訪問者の入力の書き方は出ない。publish では出る', async () => {
    put('server.js', CMD_LINE)
    const g = await gh()
    expect(g.findings).toEqual([])
    expect(g.scanned).toBe(1)
    const p = await runPublishScanFs(proj, 'publish')
    expect(p.findings.map(f => f.kind)).toEqual(['input-to-command'])
  })
  it('長い行は数えない', async () => {
    put('app.min.js', 'var a = 1; /*' + 'x'.repeat(6000) + '*/\n')
    const g = await gh()
    expect(g.notScanned.longLineCount).toBe(0)
    expect(g.notScanned.longLine).toEqual([])
    const p = await runPublishScanFs(proj, 'publish')
    expect(p.notScanned.longLineCount).toBe(1)
    expect(p.notScanned.longLine).toEqual(['app.min.js'])
  })
  it('重さは全部 should・mode は null・scope が入る', async () => {
    put('a.js', KEY_LINE)
    put('credentials.json', '{}')
    put('server.js', CMD_LINE)
    const r = await gh()
    expect(r.scope).toBe('github')
    expect(r.mode).toBeNull()
    expect(r.notScanned.listTruncated).toBe(false)
    expect(r.findings.map(f => f.kind).sort()).toEqual(['known-key', 'secret-name'])
    expect(r.findings.every(f => f.severity === 'should')).toBe(true)
  })
  it('publish の結果は scope が publish', async () => {
    put('a.js', KEY_LINE)
    const r = await runPublishScanFs(proj, 'publish')
    expect(r.scope).toBe('publish')
    expect(r.mode).toBe('static')
  })
})

describe('longLine の数え方（publish）', () => {
  it('longLine と longLineCount を返す', async () => {
    for (let i = 0; i < 7; i++) put(`m${i}.js`, 'var a = 1; /*' + 'x'.repeat(6000) + '*/\n')
    put('short.js', 'var a = 1\n')
    const r = await runPublishScanFs(proj, 'publish')
    expect(r.notScanned.longLineCount).toBe(7)
    expect(r.notScanned.longLine).toHaveLength(5)
    expect(r.findingsTotal).toBe(0)
  })
})

describe("範囲 'github' はロックファイルとビルド設定のキーも見つける", () => {
  it('Dockerfile と package-lock.json の中のキーは見つかる', async () => {
    put('Dockerfile', `ENV T=${GH}\n`)
    put('package-lock.json', `{"resolved": "${GH}"}\n`)
    const r = await gh()
    expect(files(r)).toEqual(['Dockerfile', 'package-lock.json'])
  })
  it("範囲 'publish' では同じものを飛ばす", async () => {
    put('Dockerfile', `ENV T=${GH}\n`)
    put('ok.js', 'const a = 1\n')
    const r = await runPublishScanFs(proj, 'publish')
    expect(r.findings).toEqual([])
  })
})

describe("範囲 'github' の根と見本の名前", () => {
  it('projectDir の末尾に区切りが付いていても点検できる', async () => {
    put('top.js', KEY_LINE)
    const r = await runPublishScanFs(proj + '/', 'github')
    expect(r.state).toBe('done')
    expect(r.scanned).toBe(1)
    expect(files(r)).toEqual(['top.js'])
  })
  it('見本の名前のファイルは読まず、点検した数に入れず、名前を出す', async () => {
    put('config.example.js', KEY_LINE)
    put('ok.js', 'const a = 1\n')
    const r = await gh()
    expect(r.findingsTotal).toBe(0)
    expect(r.scanned).toBe(1)
    expect(r.notScanned.sample).toEqual(['config.example.js'])
    expect(r.notScanned.sampleCount).toBe(1)
  })
})
