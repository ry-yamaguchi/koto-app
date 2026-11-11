import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Electron 43 から、開くダイアログは defaultPath を渡さないと毎回「ダウンロード」から始まる。
// 本物の registerFsHandlers が登録した IPC を、偽の dialog.showOpenDialog で呼び、渡した defaultPath を見る。

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  showOpenDialog: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { m.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  dialog: { showOpenDialog: m.showOpenDialog },
  shell: {},
}))

import { registerFsHandlers } from '../src/main/ipc/fs'
import { dialogStartDir, rememberedDirAfterPick } from '../src/main/ipc/dialogStart'

let home = ''
let savedHome: string | undefined
beforeEach(() => {
  savedHome = process.env.HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-dlg-')))
  process.env.HOME = home
  m.handlers.clear()
  m.showOpenDialog.mockReset()
  registerFsHandlers({ getMainWindow: () => ({}) } as any)
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})
const call = async (channel: string, ...args: unknown[]) => m.handlers.get(channel)!({}, ...args)
const lastDefaultPath = () => m.showOpenDialog.mock.calls.at(-1)![1].defaultPath

describe('開くダイアログの始まりの場所（Electron 43）', () => {
  it('最初の fs:openDialog はホームから始める（ダウンロードに任せない）', async () => {
    m.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await call('fs:openDialog')
    expect(lastDefaultPath()).toBe(home)
  })

  it('最初の fs:pickDirectory もホームから始める', async () => {
    m.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await call('fs:pickDirectory')
    expect(lastDefaultPath()).toBe(home)
  })

  it('fs:openDialog でフォルダを選ぶと、次は その親から始まる', async () => {
    const parent = path.join(home, 'work'); const proj = path.join(parent, 'p1')
    fs.mkdirSync(proj, { recursive: true })
    m.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [proj] })
    expect(await call('fs:openDialog')).toBe(proj)
    await call('fs:openDialog')
    expect(lastDefaultPath()).toBe(parent)
  })

  it('fs:openDialog でファイルを選ぶと、次はそのファイルのあるフォルダから始まる', async () => {
    const dir = path.join(home, 'docs'); fs.mkdirSync(dir)
    const f = path.join(dir, 'a.pdf'); fs.writeFileSync(f, 'x')
    m.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [f] })
    await call('fs:openDialog', { filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    await call('fs:pickDirectory')
    expect(lastDefaultPath()).toBe(dir)
  })

  it('fs:pickDirectory で選んだフォルダ自身から、次が始まる', async () => {
    const base = path.join(home, 'SAKURAIDE'); fs.mkdirSync(base)
    m.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [base] })
    await call('fs:pickDirectory')
    await call('fs:pickDirectory')
    expect(lastDefaultPath()).toBe(base)
  })

  it('覚えた場所が消えていたらホームに戻る / キャンセルでは覚えを変えない', async () => {
    const base = path.join(home, 'gone'); fs.mkdirSync(base)
    m.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [base] })
    await call('fs:pickDirectory')
    m.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await call('fs:pickDirectory')
    expect(lastDefaultPath()).toBe(base)
    fs.rmSync(base, { recursive: true })
    await call('fs:pickDirectory')
    expect(lastDefaultPath()).toBe(home)
  })
})

describe('dialogStart（純粋な判断）', () => {
  it('覚えた場所がフォルダとして在ればそれ、なければホーム', () => {
    expect(dialogStartDir('/a', '/h', () => true)).toBe('/a')
    expect(dialogStartDir('/a', '/h', () => false)).toBe('/h')
    expect(dialogStartDir(null, '/h', () => true)).toBe('/h')
  })
  it('覚える場所: フォルダ自身を残すか親か', () => {
    expect(rememberedDirAfterPick('/a/b', true, true)).toBe('/a/b')
    expect(rememberedDirAfterPick('/a/b', true, false)).toBe('/a')
    expect(rememberedDirAfterPick('/a/b.txt', false, true)).toBe('/a')
  })
})
