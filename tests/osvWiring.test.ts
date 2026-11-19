import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const count = (src: string, needle: string) => src.split(needle).length - 1

describe('IPC の3点セット: osv:preview・osv:check は main・preload・global.d.ts が揃っている', () => {
  it('main: ipc/osv.ts が登録し、ipc/index.ts が1回呼ぶ', () => {
    const ipc = read('src/main/ipc/osv.ts')
    expect(count(ipc, "ipcMain.handle('osv:preview', (_e, projectDir: unknown) => osvPreviewFs(projectDir))")).toBe(1)
    expect(count(ipc, "ipcMain.handle('osv:check', (_e, projectDir: unknown, consented: unknown) => osvCheckFs(projectDir, consented, fetch))")).toBe(1)
    const index = read('src/main/ipc/index.ts')
    expect(count(index, "import { registerOsvHandlers } from './osv'")).toBe(1)
    expect(count(index, 'registerOsvHandlers()')).toBe(1)
  })
  it('preload: 2つの口が同じチャンネルを呼ぶ', () => {
    const preload = read('src/main/preload.ts')
    expect(preload).toContain("preview: (projectDir: string) => ipcRenderer.invoke('osv:preview', projectDir),")
    expect(preload).toContain("check: (projectDir: string, consented: boolean) => ipcRenderer.invoke('osv:check', projectDir, consented),")
  })
  it('global.d.ts: 型が宣言されている', () => {
    const d = read('src/renderer/global.d.ts')
    expect(d).toContain('preview(projectDir: string): Promise<')
    expect(d).toContain('check(projectDir: string, consented: boolean): Promise<')
  })
  it('ipc/osv.ts に URL を書かない', () => {
    expect(read('src/main/ipc/osv.ts')).not.toMatch(/https?:\/\//)
  })
  it('src/main の中で runOsvCheck( を呼ぶのは ipc/osv.ts だけ', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        if (fs.statSync(full).isDirectory()) walk(full, out)
        else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(ROOT, full))
      }
      return out
    }
    const callers = walk(path.join(ROOT, 'src/main'))
      .filter(f => read(f).split('\n').some(l => !l.trim().startsWith('//') && !/\bfunction\s+runOsvCheck\(/.test(l) && l.includes('runOsvCheck(')))
    expect(callers).toEqual(['src/main/ipc/osv.ts'])
  })
})
