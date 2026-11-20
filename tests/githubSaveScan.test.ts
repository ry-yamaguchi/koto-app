import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import GithubSaveScan, { scanAndPlace } from '../src/renderer/components/GithubSaveScan'
import { GITHUB_SCAN_TITLE, GITHUB_SCAN_NOTE, PUBLISH_SCAN_BUTTON_NO_AI } from '../src/renderer/publishScanWords'
import type { ScanView } from '../src/renderer/publishScanWords'

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const count = (src: string, needle: string) => src.split(needle).length - 1
const g = globalThis as unknown as { window?: unknown }
afterEach(() => { delete g.window })

function fakeApi(reply: unknown, calls: unknown[][]) {
  g.window = { electronAPI: { publishScan: { run: async (...a: unknown[]) => { calls.push(a); return reply } } } }
}

describe('GithubSaveScan: 描画', () => {
  it('開いただけでは点検を呼ばず、題・説明・ボタンだけを出す（結果は無い）', () => {
    const calls: unknown[][] = []
    fakeApi({ state: 'bad-dir' }, calls)
    const html = renderToStaticMarkup(createElement(GithubSaveScan, { projectDir: '/p' }))
    expect(calls).toEqual([])
    expect(html).toContain(GITHUB_SCAN_TITLE)
    expect(html).toContain(GITHUB_SCAN_NOTE)
    expect(html).toContain(PUBLISH_SCAN_BUTTON_NO_AI)
    expect(html).not.toContain('Koto の点検')
  })
})

describe('scanAndPlace', () => {
  it("'github' で1回だけ呼び、結果を置く", async () => {
    const calls: unknown[][] = []
    fakeApi({ state: 'bad-dir' }, calls)
    const placed: ScanView[] = []
    await scanAndPlace('/p', () => '/p', v => placed.push(v))
    expect(calls).toEqual([['/p', 'github']])
    expect(placed).toHaveLength(1)
    expect(placed[0].verdict).toBe('skip')
  })
  it('プロジェクトが変わった後に届いた結果は置かない', async () => {
    fakeApi({ state: 'bad-dir' }, [])
    let cur = '/p'
    const placed: ScanView[] = []
    const p = scanAndPlace('/p', () => cur, v => placed.push(v))
    cur = '/q'
    await p
    expect(placed).toEqual([])
  })
})

describe('GithubSaveScan / GithubSaveModal の配線', () => {
  it('親へ何も返さない（コールバックの prop が無い）', () => {
    const s = read('src/renderer/components/GithubSaveScan.tsx')
    expect(s).toContain('export default function GithubSaveScan({ projectDir }: { projectDir: string })')
    expect(s).toContain('<PublishScanResult view={scan} hideTitle />')
  })
  it('開いただけで点検が走らない（useEffect は結果を消す1つだけで、run を呼ぶ所は押したときの1つだけ）', () => {
    const s = read('src/renderer/components/GithubSaveScan.tsx')
    expect(count(s, 'useEffect(')).toBe(1)
    expect(count(s, 'void run()')).toBe(1)
    expect(count(s, "onClick={() => { void run() }}")).toBe(1)
  })
  it('押し直したとき、走らせる前に前の結果を消す', () => {
    const s = read('src/renderer/components/GithubSaveScan.tsx')
    const run = s.indexOf('async function run() {')
    const clear = s.indexOf('setScan(null)', run)
    const go = s.indexOf('await scanAndPlace(', run)
    expect(run).toBeGreaterThan(-1)
    expect(clear).toBeGreaterThan(run)
    expect(clear).toBeLessThan(go)
  })
  it('プロジェクトが変わったら、出ていた前の結果を消す', () => {
    const s = read('src/renderer/components/GithubSaveScan.tsx')
    expect(count(s, 'useEffect(() => { setScan(null) }, [projectDir])')).toBe(1)
  })
  const m = read('src/renderer/components/GithubSaveModal.tsx')
  it('置き場の1行が1回、読み込み中の分岐の直前にある', () => {
    const line = '{tokenLoaded && metaLoaded && !!token && <GithubSaveScan projectDir={projectDir} />}'
    expect(count(m, line)).toBe(1)
    const at = m.indexOf(line)
    const tern = m.indexOf('{!tokenLoaded || !metaLoaded ? (')
    expect(m.slice(at + line.length, tern).trim()).toBe('')
  })
  it('保存のボタンの disabled の式は元のまま（点検は保存を止めない）', () => {
    expect(count(m, 'disabled={saving}')).toBe(1)
    expect(count(m, 'disabled={creating || saving || !newRepoName.trim()}')).toBe(1)
  })
  it('SecurityCheckSection と OsvCheckBlock は居ない', () => {
    expect(m).not.toContain('SecurityCheckSection')
    expect(m).not.toContain('OsvCheckBlock')
  })
})
