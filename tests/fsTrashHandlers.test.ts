import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

// ── T-E2・T-E3（登録の配線）: 本物の `registerFsHandlers` が登録した IPC を、偽の electron（ipcMain・shell.trashItem）で呼ぶ（0.6.24 E-2・掟6）──────────
// fsTrash.ts の関数（tests/fsTrash.test.ts）が正しくても、fs.ts がそこを呼んでいなければ守りは働かない（「守りの関数は正しいが呼ばれていない」）。
// ここは、IPC の名前（fs:trash・fs:rename・fs:trashCheck・fs:trashProject）から呼び、**偽の shell.trashItem の呼ばれた一覧**と実フォルダで見る。
// home は os.homedir()（＝$HOME）。fs:homeDir と同じソース（別ソースだと、HOME 差し替え時にワークスペースの home とガードの home がズレる・2026-09-02 実測）。
// あわせて、preload（ipcRenderer.invoke）と global.d.ts の型の3点が揃っていること（掟6）を、名前ごと見る。

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  trashItem: vi.fn(async (_p: string) => {}),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { m.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: { trashItem: m.trashItem },
}))

import { registerFsHandlers } from '../src/main/ipc/fs'

let home = ''
let savedHome: string | undefined
beforeEach(() => {
  savedHome = process.env.HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-fshandlers-')))
  process.env.HOME = home // os.homedir() が返す値
  m.trashItem.mockClear()
  m.handlers.clear()
  registerFsHandlers({} as any)
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})

// 本物の ipcMain は、同期ハンドラの throw も invoke の reject にする。ここも同じに揃える（async で包む）
const call = async (channel: string, ...args: unknown[]) => m.handlers.get(channel)!({}, ...args)
const at = (...rel: string[]) => path.join(home, ...rel)
function put(rel: string, content = 'x'): string {
  const full = at(rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

describe('★★★ 登録の配線: IPC 名から呼ぶと、守りを通る', () => {
  it('4つの IPC が登録されている', () => {
    for (const ch of ['fs:trash', 'fs:rename', 'fs:trashCheck', 'fs:trashProject']) expect(m.handlers.has(ch), ch).toBe(true)
    expect(os.homedir()).toBe(home) // このテストの home は $HOME に従う
  })

  it('★★★ fs:trash: ふつうのファイルは shell.trashItem へ1回。記録・プロジェクトの根は、投げて0回', async () => {
    put('SAKURAIDE/p/.sakuraide.json', '{}'); put('SAKURAIDE/p/.sakura-cloud/state.json', '{}'); const f = put('SAKURAIDE/p/index.html')
    await call('fs:trash', f)
    expect(m.trashItem.mock.calls).toEqual([[f]])
    m.trashItem.mockClear()
    await expect(call('fs:trash', at('SAKURAIDE/p/.sakura-cloud/state.json'))).rejects.toThrow('Koto の記録のファイルなので、ここからは削除できません。')
    await expect(call('fs:trash', at('SAKURAIDE/p'))).rejects.toThrow('プロジェクトのフォルダは、プロジェクトの 🗑 から削除してください。')
    await expect(call('fs:trash', at('SAKURAIDE'))).rejects.toThrow('ホームフォルダの直下は')
    expect(m.trashItem).not.toHaveBeenCalled()
  })

  it('★★★ fs:trashCheck: 種類を返す（読むだけ・trashItem は呼ばない）', async () => {
    put('SAKURAIDE/p/.sakuraide.json', '{}'); const f = put('SAKURAIDE/p/index.html')
    expect(await call('fs:trashCheck', f)).toEqual({ ok: true })
    const root = await call('fs:trashCheck', at('SAKURAIDE/p'))
    expect(root).toMatchObject({ ok: false, kind: 'project' })
    expect(await call('fs:trashCheck', at('SAKURAIDE/p/.sakuraide.json'))).toMatchObject({ ok: false, kind: 'record' })
    expect(m.trashItem).not.toHaveBeenCalled()
  })

  it('★★★ fs:trashProject: 確認の印が無ければ0回。印があれば、プロジェクトの根を1回だけ移す', async () => {
    const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', '{}'))
    expect(await call('fs:trashProject', dir)).toEqual({ ok: false, message: '確認ダイアログを通っていません' })
    expect(await call('fs:trashProject', dir, {})).toMatchObject({ ok: false })
    expect(m.trashItem).not.toHaveBeenCalled()
    expect(await call('fs:trashProject', dir, { confirmed: true })).toMatchObject({ ok: false }) // skippedForTwins は必須（R2-e）
    expect(m.trashItem).not.toHaveBeenCalled()
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })

  it('★★ fs:rename: ふつうのファイルは変わる。記録・プロジェクトの根は投げて、ディスクは変わらない', async () => {
    put('SAKURAIDE/p/.sakuraide.json', '{}'); put('SAKURAIDE/p/a.txt', 'a')
    expect(await call('fs:rename', at('SAKURAIDE/p/a.txt'), 'b.txt')).toBe(at('SAKURAIDE/p/b.txt'))
    await expect(call('fs:rename', at('SAKURAIDE/p/.sakuraide.json'), 'x.json')).rejects.toThrow('Koto の記録のファイルなので、名前を変えられません。')
    await expect(call('fs:rename', at('SAKURAIDE/p'), 'q')).rejects.toThrow('プロジェクトのフォルダの名前は変えられません。')
    expect(fs.existsSync(at('SAKURAIDE/p/.sakuraide.json'))).toBe(true)
    expect(fs.existsSync(at('SAKURAIDE/q'))).toBe(false)
  })
})

describe('掟6: main / preload / 型 の3点が揃っている', () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf-8')
  it('fs:trashCheck・fs:trashProject は preload から invoke され、global.d.ts に型がある', () => {
    const preload = read('src/main/preload.ts')
    expect(preload).toContain("trashCheck: (p: string) => ipcRenderer.invoke('fs:trashCheck', p),")
    expect(preload).toContain("trashProject: (dir: string, opts: { confirmed: true; skippedForTwins: string[] }) => ipcRenderer.invoke('fs:trashProject', dir, opts),")
    const types = read('src/renderer/global.d.ts')
    expect(types).toContain('trashCheck(p: string): Promise<{ ok: true } | { ok: false; kind:')
    expect(types).toContain("trashProject(dir: string, opts: { confirmed: true; skippedForTwins: Array<'hanamii' | 'sakura-apprun' | 'sakura-apprun-dedicated' | 'sakura-rental' | 'vercel'> }): Promise<{ ok: true } | { ok: false; message: string; reason?: 'twins-gone' }>")
  })
})
