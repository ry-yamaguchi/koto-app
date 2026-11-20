import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const lim = vi.hoisted(() => ({ total: 20_000_000 }))
vi.mock('../src/shared/publishScanLimits', async (orig) => {
  const m = await orig<typeof import('../src/shared/publishScanLimits')>()
  return { ...m, get PUBLISH_SCAN_TOTAL_LIMIT_BYTES() { return lim.total } }
})

import { runPublishScanFs } from '../src/main/publishScan'
import { PUBLISH_SCAN_FINDINGS_LIMIT, PUBLISH_SCAN_FILE_LIMIT_BYTES, PUBLISH_SCAN_NAME_LIMIT, PUBLISH_SCAN_YIELD_BYTES } from '../src/shared/publishScanLimits'

// 見本のキーは文字列の連結で組み立てる（実在しない値）
const GH_BODY = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const GH = 'gh' + 'p_' + GH_BODY
const KEY_LINE = `const t = "${GH}"\n`

let base = ''
let proj = ''
const put = (rel: string, content: string | Buffer) => {
  const p = path.join(proj, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const scan = () => runPublishScanFs(proj, 'publish')

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-scan-')))
  proj = path.join(base, 'proj')
  fs.mkdirSync(proj)
  lim.total = 20_000_000
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('見つける', () => {
  it('キーの直書きを、ファイル・行・種類・重さつきで返す', async () => {
    put('config.js', `// c\n\n${KEY_LINE}`)
    const r = await scan()
    expect(r.state).toBe('done')
    expect(r.scanned).toBe(1)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ kind: 'known-key', file: 'config.js', line: 3, severity: 'now' })
  })
  it('訪問者の入力をコマンドに使う書き方', async () => {
    put('server.js', "const { exec } = require('child_process')\nexec(req.query.cmd)\n")
    const r = await scan()
    expect(r.findings.map(f => [f.kind, f.file, f.line])).toEqual([['input-to-command', 'server.js', 2]])
  })
  it('公開に入る秘密らしい名前は、中身を読まずに名前だけで指摘する', async () => {
    put('credentials.json', `{"k": "${GH}"}`)
    const r = await scan()
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ kind: 'secret-name', file: 'credentials.json', severity: 'now' })
    expect(r.scanned).toBe(0)
    expect(JSON.stringify(r)).not.toContain(GH_BODY)
  })
})

describe('通す', () => {
  it('素材・ロックファイルは読まない', async () => {
    put('a.png', KEY_LINE)
    put('package-lock.json', KEY_LINE)
    const r = await scan()
    expect(r.findingsTotal).toBe(0)
    expect(r.scanned).toBe(0)
  })
  it('.env は中身を読まず、指摘にも出さない', async () => {
    put('.env', `TOKEN=${GH}\n`)
    const r = await scan()
    expect(r.findingsTotal).toBe(0)
    expect(JSON.stringify(r)).not.toContain(GH_BODY)
  })
  it('見本のファイルは出ない', async () => {
    put('config.example.js', KEY_LINE)
    const r = await scan()
    expect(r.findingsTotal).toBe(0)
  })
})

describe('公開の根と重さ', () => {
  it('public フォルダがあれば、その中だけを点検する', async () => {
    put('secret.js', KEY_LINE)
    put('public/index.html', '<p>hi</p>')
    const r = await scan()
    expect(r.findingsTotal).toBe(0)
    expect(r.listed).toBe(1)
  })
  it('static のプロジェクトのキーは now', async () => {
    put('app.js', KEY_LINE)
    const r = await scan()
    expect(r.mode).toBe('static')
    expect(r.findings[0].severity).toBe('now')
  })
  it('node のプロジェクトでは、配る用のフォルダの外は should・中は now', async () => {
    put('package.json', JSON.stringify({ scripts: { start: 'node server.js' } }))
    put('server.js', KEY_LINE)
    put('static/app.js', KEY_LINE)
    const r = await scan()
    expect(r.mode).toBe('node')
    const by = Object.fromEntries(r.findings.map(f => [f.file, f.severity]))
    expect(by).toEqual({ 'server.js': 'should', 'static/app.js': 'now' })
  })
})

describe('読めないもの', () => {
  it('上限より大きいファイルは名前と数で返し、読まない', async () => {
    put('big.js', KEY_LINE + 'x'.repeat(PUBLISH_SCAN_FILE_LIMIT_BYTES))
    const r = await scan()
    expect(r.notScanned.tooLarge).toEqual(['big.js'])
    expect(r.notScanned.tooLargeCount).toBe(1)
    expect(r.findingsTotal).toBe(0)
  })
  it('外を指すリンクは読まず、外のファイルの指摘も出ない', async () => {
    const outside = path.join(base, 'outside.js')
    fs.writeFileSync(outside, KEY_LINE)
    put('index.html', '<p>x</p>')
    fs.symlinkSync(outside, path.join(proj, 'link.js'))
    const r = await scan()
    expect(r.notScanned.unreadable).toEqual(['link.js'])
    expect(r.notScanned.unreadableCount).toBe(1)
    expect(r.findingsTotal).toBe(0)
  })
  it('バイナリは数だけ', async () => {
    put('data.txt', Buffer.from([65, 0, 66]))
    const r = await scan()
    expect(r.notScanned.binaryCount).toBe(1)
    expect(r.notScanned.binary).toEqual(['data.txt'])
    expect(r.scanned).toBe(0)
  })
  it('合計の上限を超えたら、あとのファイルは読まずに数える', async () => {
    lim.total = 100
    put('a.js', 'x'.repeat(200))
    put('b.js', KEY_LINE)
    put('c.js', KEY_LINE)
    const r = await scan()
    expect(r.scanned).toBe(1)
    expect(r.notScanned.overTotalCount).toBe(2)
    expect(r.notScanned.overTotal).toEqual(['b.js', 'c.js'])
    expect(r.findingsTotal).toBe(0)
  })
  it('名前は上限まで・数は全部（量の上限・文字として読めない）', async () => {
    lim.total = 10
    put('a.js', 'x'.repeat(200))
    for (let i = 0; i < PUBLISH_SCAN_NAME_LIMIT + 2; i++) put(`z${i}.js`, 'y')
    const r = await scan()
    expect(r.notScanned.overTotal).toHaveLength(PUBLISH_SCAN_NAME_LIMIT)
    expect(r.notScanned.overTotalCount).toBe(PUBLISH_SCAN_NAME_LIMIT + 2)
    lim.total = 20_000_000
    fs.rmSync(path.join(proj, 'a.js'))
    for (let i = 0; i < PUBLISH_SCAN_NAME_LIMIT + 2; i++) put(`b${i}.txt`, Buffer.from([65, 0, 66]))
    const r2 = await scan()
    expect(r2.notScanned.binary).toHaveLength(PUBLISH_SCAN_NAME_LIMIT)
    expect(r2.notScanned.binaryCount).toBe(PUBLISH_SCAN_NAME_LIMIT + 2)
  })
})

describe('見本の名前のファイルは読まない', () => {
  it('中に本物の形のキーがあっても指摘は出ず、点検した数に入らず、名前が出る', async () => {
    put('config.example.js', KEY_LINE)
    put('a.sample', KEY_LINE)
    put('ok.js', 'const a = 1\n')
    const r = await scan()
    expect(r.findingsTotal).toBe(0)
    expect(r.scanned).toBe(1)
    expect(r.notScanned.sampleCount).toBe(2)
    expect(r.notScanned.sample).toEqual(['a.sample', 'config.example.js'])
    expect(JSON.stringify(r)).not.toContain(GH_BODY)
  })
  it('名前は上限まで・数は全部', async () => {
    for (let i = 0; i < PUBLISH_SCAN_NAME_LIMIT + 2; i++) put(`c${i}.example.js`, 'x')
    const r = await scan()
    expect(r.notScanned.sample).toHaveLength(PUBLISH_SCAN_NAME_LIMIT)
    expect(r.notScanned.sampleCount).toBe(PUBLISH_SCAN_NAME_LIMIT + 2)
    expect(r.scanned).toBe(0)
  })
})

describe('main を長く止めない', () => {
  it('読んだ量が多いと、手を休める（ファイル数が少なくても）', async () => {
    // 量（バイト）で手を休めることを見る。4つとも同じ中身にする（作ったばかりの大きなファイルを最初に開くのに、
    // 環境によっては1つ10秒ほどかかる。同じ中身なら、その待ちは1回で済む）。待ちが長い環境のために、制限時間も長くする
    const body = ('word '.repeat(200) + '\n').repeat(600) // 1行 約1,000字 × 600行 ＝ 約60万字
    expect(Buffer.byteLength(body) * 4).toBeGreaterThan(PUBLISH_SCAN_YIELD_BYTES * 2)
    for (let i = 0; i < 4; i++) put(`big${i}.js`, body)
    const spy = vi.spyOn(globalThis, 'setImmediate')
    try {
      const r = await scan()
      expect(r.scanned).toBe(4)
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      spy.mockRestore()
    }
  }, 180_000)
})

describe('一覧と名前の上限', () => {
  it('大きすぎるファイルの名前は上限まで・数は全部', async () => {
    for (let i = 0; i < PUBLISH_SCAN_NAME_LIMIT + 2; i++) put(`big${i}.js`, 'x'.repeat(PUBLISH_SCAN_FILE_LIMIT_BYTES + 1))
    const r = await scan()
    expect(r.notScanned.tooLarge).toHaveLength(PUBLISH_SCAN_NAME_LIMIT)
    expect(r.notScanned.tooLargeCount).toBe(PUBLISH_SCAN_NAME_LIMIT + 2)
  })
  it('一覧が深さで切れたら listTruncated', async () => {
    put('index.html', '<p>x</p>')
    expect((await scan()).notScanned.listTruncated).toBe(false)
    put('a/b/c/d/e/f/g/h/i/j/deep.js', 'x')
    expect((await scan()).notScanned.listTruncated).toBe(true)
  })
  it('公開される一覧と同じ作りで読む（ドット始まりの公開フォルダも点検する・node_modules は入らない）', async () => {
    put('index.html', '<p>x</p>')
    put('node_modules/pkg/index.js', KEY_LINE)
    put('.well-known/x.js', KEY_LINE)
    const r = await scan()
    expect(r.findings.map(f => f.file)).toEqual(['.well-known/x.js'])
    expect(r.listed).toBe(2)
  })
})

describe('時間', () => {
  it('終わりの無い秘密鍵の開始行が大量にあるファイルでも、点検が固まらない', async () => {
    // 上限いっぱい近く（約 98 万バイト）の1ファイル。秘密の形の側の守りは tests/secretShapes.test.ts が見る
    put('k.txt', '-----BEGIN PRIVATE KEY-----\n'.repeat(35000))
    const t = Date.now()
    const r = await scan()
    expect(r.scanned).toBe(1)
    expect(Date.now() - t).toBeLessThan(2000)
  })
})

describe('並びと上限', () => {
  it('now が先・ファイル名の順', async () => {
    put('package.json', JSON.stringify({ scripts: { start: 'node server.js' } }))
    put('server.js', KEY_LINE)
    put('static/b.js', KEY_LINE)
    put('static/a.js', KEY_LINE)
    const r = await scan()
    expect(r.findings.map(f => f.file)).toEqual(['static/a.js', 'static/b.js', 'server.js'])
  })
  it('指摘が上限を超えると findings は上限まで・findingsTotal は全部', async () => {
    const body = KEY_LINE.repeat(250)
    put('a.js', body)
    put('b.js', body)
    put('c.js', body)
    const r = await scan()
    expect(r.findings).toHaveLength(PUBLISH_SCAN_FINDINGS_LIMIT)
    expect(r.findingsTotal).toBe(600)
  })
})

describe('値を出さない・通信しない', () => {
  it('戻り値の形は決まったキーだけ', async () => {
    put('config.js', KEY_LINE)
    const r = await scan()
    expect(Object.keys(r).sort()).toEqual(['findings', 'findingsTotal', 'listed', 'mode', 'notScanned', 'scanned', 'scope', 'state'])
    expect(Object.keys(r.findings[0]).sort()).toEqual(['file', 'kind', 'length', 'line', 'sample', 'severity'])
  })
  it('戻り値に、キーの本体・絶対パス・ファイルの中身が入らない', async () => {
    put('config.js', `${KEY_LINE}const marker = "UNIQUE_BODY_MARK"\n`)
    put('credentials.json', 'UNIQUE_SECRET_NAME_BODY')
    put('big.js', 'x'.repeat(PUBLISH_SCAN_FILE_LIMIT_BYTES + 1))
    const out = JSON.stringify(await scan())
    expect(out).not.toContain(GH_BODY)
    expect(out).not.toContain(base)
    expect(out).not.toContain('UNIQUE_BODY_MARK')
    expect(out).not.toContain('UNIQUE_SECRET_NAME_BODY')
  })
  it('通信しない', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    put('config.js', KEY_LINE)
    await scan()
    expect(f).not.toHaveBeenCalled()
  })
})
