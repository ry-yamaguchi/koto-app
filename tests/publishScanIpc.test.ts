import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
}))
const boom = vi.hoisted(() => ({ on: false }))
vi.mock('../src/main/publishScan', async (orig) => {
  const m = await orig<typeof import('../src/main/publishScan')>()
  return { ...m, runPublishScanFs: (d: string, s: 'publish' | 'github') => { if (boom.on) throw new TypeError('fetch failed'); return m.runPublishScanFs(d, s) } }
})

import { publishScanFs, registerPublishScanHandlers } from '../src/main/ipc/publishScan'
import { failureText } from '../src/shared/failureText'

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const count = (src: string, needle: string) => src.split(needle).length - 1

let base = ''
beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-scan-ipc-'))) })
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); boom.on = false })

describe('publishScanFs', () => {
  it.each([
    ['相対パス', 'proj', 'publish'],
    ['空', '', 'publish'],
    ['数', 5, 'publish'],
    ['scope が other', '/abs', 'other'],
    ['scope が無い', '/abs', undefined],
  ])('%s は bad-dir', async (_n, dir, scope) => {
    expect(await publishScanFs(dir, scope)).toEqual({ state: 'bad-dir' })
  })
  it('scope が github は通る', async () => {
    fs.writeFileSync(path.join(base, 'index.html'), '<p>x</p>')
    const r = await publishScanFs(base, 'github')
    expect(r.state).toBe('done')
    expect((r as { scope: string }).scope).toBe('github')
  })
  it('通る回は done', async () => {
    fs.writeFileSync(path.join(base, 'index.html'), '<p>x</p>')
    const r = await publishScanFs(base, 'publish')
    expect(r.state).toBe('done')
  })
  it('想定外の例外は failed で、message は failureText の文（素通りしない）', async () => {
    boom.on = true
    const r = await publishScanFs(base, 'publish')
    expect(r).toEqual({ state: 'failed', message: failureText(new TypeError('fetch failed'), { readOnly: true }) })
    expect((r as { message: string }).message).not.toBe('fetch failed')
  })
  it('チャンネルを登録する', async () => {
    registerPublishScanHandlers()
    expect(handlers.has('publishScan:run')).toBe(true)
    expect(await handlers.get('publishScan:run')!('rel', 'publish')).toEqual({ state: 'bad-dir' })
  })
})

describe('配線', () => {
  it('main・preload・global.d.ts の3点が揃っている', () => {
    const ipc = read('src/main/ipc/publishScan.ts')
    expect(count(ipc, "ipcMain.handle('publishScan:run', (_e, projectDir: unknown, scope: unknown) => publishScanFs(projectDir, scope))")).toBe(1)
    const index = read('src/main/ipc/index.ts')
    expect(count(index, "import { registerPublishScanHandlers } from './publishScan'")).toBe(1)
    expect(count(index, 'registerPublishScanHandlers()')).toBe(1)
    expect(read('src/main/preload.ts')).toContain("run: (projectDir: string, scope: import('../shared/publishScanTypes').PublishScanScope) => ipcRenderer.invoke('publishScan:run', projectDir, scope),")
    expect(read('src/renderer/global.d.ts')).toContain("run(projectDir: string, scope: import('../shared/publishScanTypes').PublishScanScope): Promise<import('../shared/publishScanTypes').PublishScanReply>")
  })
  it('runPublishScanFs( を呼ぶのは ipc/publishScan.ts だけ', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) { walk(rel); continue }
        if (!/\.tsx?$/.test(e.name)) continue
        if (rel === 'src/main/publishScan.ts') continue // 定義元
        if (read(rel).includes('runPublishScanFs(')) offenders.push(rel)
      }
    }
    walk('src/main')
    expect(offenders).toEqual(['src/main/ipc/publishScan.ts'])
  })
  it('通信する書き方が無い', () => {
    for (const f of ['src/main/publishScan.ts', 'src/main/ipc/publishScan.ts']) {
      expect(read(f)).not.toContain('fetch(')
      expect(read(f)).not.toContain('http')
    }
  })
})
