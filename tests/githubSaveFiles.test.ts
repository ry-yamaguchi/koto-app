import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { githubSaveFilesFs } from '../src/main/github/saveFiles'
import { MAX_FILE_BYTES } from '../src/main/github/enumerate'

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

let proj = ''
const put = (rel: string, content: string | Buffer) => {
  const p = path.join(proj, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
beforeEach(() => { proj = fs.mkdtempSync(path.join(os.tmpdir(), 'github-save-files-')) })
afterEach(() => { fs.rmSync(proj, { recursive: true, force: true }) })

describe('githubSaveFilesFs', () => {
  it('飛ばすフォルダ・.DS_Store は一覧に出ない', () => {
    put('index.html', 'x')
    put('public/a.js', 'x')
    put('node_modules/m/i.js', 'x')
    put('dist/o.js', 'x')
    put('.git/config', 'x')
    put('.DS_Store', 'x')
    const r = githubSaveFilesFs(proj)
    expect([...r.included].sort()).toEqual(['index.html', 'public/a.js'])
    expect(r.excluded).toEqual([])
  })
  it('.env は excluded の env', () => {
    put('.env', 'K=1')
    put('a.js', 'x')
    const r = githubSaveFilesFs(proj)
    expect(r.included).toEqual(['a.js'])
    expect(r.excluded).toEqual([{ path: '.env', reason: 'env' }])
  })
  it('5MB を超えるファイルは excluded の size', () => {
    put('big.bin', Buffer.alloc(MAX_FILE_BYTES + 1))
    put('ok.bin', Buffer.alloc(MAX_FILE_BYTES))
    const r = githubSaveFilesFs(proj)
    expect(r.included).toEqual(['ok.bin'])
    expect(r.excluded).toEqual([{ path: 'big.bin', reason: 'size' }])
  })
})

describe('github:save の配線', () => {
  it('一覧は githubSaveFilesFs を1回呼ぶだけで、ipc/github.ts に列挙の写しが無い', () => {
    const src = read('src/main/ipc/github.ts')
    expect(src.split('const { included, excluded } = githubSaveFilesFs(projectDir)').length - 1).toBe(1)
    expect(src).not.toContain('readdirSync')
    expect(src).not.toContain('partitionEntries')
  })
})
