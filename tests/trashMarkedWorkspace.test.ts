import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 0.6.24 R2-c: 記録の印があるフォルダでも、直下に子のプロジェクトがあれば「中にプロジェクトがあるフォルダ」（workspace）──────────
// 印は、開いたフォルダで公開先を選ぶだけで書かれる（App.tsx の mergeProjectMeta(currentDir, { target })）。そのフォルダのプロジェクトの削除を通すと、
// 中の子のプロジェクトの記録ごと移り、子の専有型の止めも走っている操作の確かめも通らない。本物の登録を IPC 名から呼び、実フォルダと「shell.trashItem の呼ばれた一覧」で見る。
// 変異: fileOpVerdict が自分の印で早く返す形（`if (own) return 'project'`）に戻す。

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
import { FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'

let home = ''
let savedHome: string | undefined
const lockedDirs: string[] = []
beforeEach(() => {
  savedHome = process.env.HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r2c-')))
  process.env.HOME = home
  m.trashItem.mockClear()
  m.handlers.clear()
  registerFsHandlers({} as any)
})
afterEach(() => {
  for (const d of lockedDirs.splice(0)) { try { fs.chmodSync(d, 0o755) } catch { /* 無い */ } }
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})

const call = async (channel: string, ...args: unknown[]) => m.handlers.get(channel)!({}, ...args)
const at = (...rel: string[]) => path.join(home, ...rel)
function put(rel: string, content = 'x'): string {
  const full = at(rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0

/** 開いたフォルダ ws に公開先の印（.sakuraide.json）があり、直下に子のプロジェクト child がある形。 */
function markedWorkspace(): string {
  put('SAKURAIDE/ws/.sakuraide.json', '{"target":"hanamii"}')
  put('SAKURAIDE/ws/child/.sakuraide.json', '{"publish":{"targets":{}}}'); put('SAKURAIDE/ws/child/index.html', '<p>child</p>')
  put('SAKURAIDE/ws/notes.txt', 'ふつうのファイル')
  return at('SAKURAIDE/ws')
}

describe('★★★ R2-c 印があるフォルダの直下に子のプロジェクト → workspace。fs:trashProject は断り、移す要求は0件', () => {
  it('★★★ fs:trashProject: 断りの文は「中にプロジェクトがある」。shell.trashItem は0回・フォルダも子の記録も動かない', async () => {
    const ws = markedWorkspace()
    const r = await call('fs:trashProject', ws, { confirmed: true, skippedForTwins: [] })
    expect(r).toEqual({ ok: false, message: FS_TRASH_MESSAGES.workspace })
    expect(m.trashItem.mock.calls).toEqual([])
    expect(fs.existsSync(at('SAKURAIDE/ws/.sakuraide.json'))).toBe(true)
    expect(fs.existsSync(at('SAKURAIDE/ws/child/.sakuraide.json'))).toBe(true)
  })

  it('★★★ 印が .sakura-cloud（フォルダ）の側でも同じ。子の印が .sakura-cloud でも同じ', async () => {
    put('SAKURAIDE/ws2/.sakura-cloud/state.json', '{}'); put('SAKURAIDE/ws2/child/.sakura-cloud/state.json', '{}')
    expect(await call('fs:trashProject', at('SAKURAIDE/ws2'), { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: FS_TRASH_MESSAGES.workspace })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★★ fs:trashCheck は workspace（以前は project と答え、ファイル一覧がプロジェクトの削除の画面へ案内していた）', async () => {
    const ws = markedWorkspace()
    expect(await call('fs:trashCheck', ws)).toEqual({ ok: false, kind: 'workspace', message: FS_TRASH_MESSAGES.workspace })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★★ fs:trash（ファイル一覧の削除）・fs:rename も断る。ディスクは動かない', async () => {
    const ws = markedWorkspace()
    await expect(call('fs:trash', ws)).rejects.toThrow(FS_TRASH_MESSAGES.workspace)
    await expect(call('fs:rename', ws, 'ws-renamed')).rejects.toThrow(FS_TRASH_MESSAGES.renameWorkspace)
    expect(m.trashItem.mock.calls).toEqual([])
    expect(fs.existsSync(ws)).toBe(true)
    expect(fs.existsSync(at('SAKURAIDE/ws-renamed'))).toBe(false)
  })

  it.skipIf(rootIsMe)('★★★ 子が調べられない（権限なし）→ unknown で断る。project と答えて移さない', async () => {
    const ws = markedWorkspace()
    fs.mkdirSync(path.join(ws, 'locked')); fs.writeFileSync(path.join(ws, 'locked', 'a.txt'), 'a')
    fs.chmodSync(path.join(ws, 'locked'), 0o000); lockedDirs.push(path.join(ws, 'locked'))
    // 子の child に印があるので、まず workspace。印のある子を外して unknown だけを残す
    fs.rmSync(path.join(ws, 'child'), { recursive: true, force: true })
    expect(await call('fs:trashProject', ws, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: FS_TRASH_MESSAGES.unknown })
    expect(await call('fs:trashCheck', ws)).toMatchObject({ ok: false, kind: 'unknown' })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it.skipIf(rootIsMe)('★★★ 印はあるが、直下の一覧が読めない（0o311）→ unknown で断る。project と答えて移さない', async () => {
    const ws = markedWorkspace()
    fs.chmodSync(ws, 0o311); lockedDirs.push(ws) // 中の名前は引ける（印の確認は通る）が、一覧は読めない
    expect(await call('fs:trashProject', ws, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: FS_TRASH_MESSAGES.unknown })
    expect(await call('fs:trashCheck', ws)).toMatchObject({ ok: false, kind: 'unknown' })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★ 対照: 印があり、子にプロジェクトが無い（ふつうのプロジェクト）は今までどおり project。移すのは1回', async () => {
    const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', '{}'))
    put('SAKURAIDE/p/public/index.html'); put('SAKURAIDE/p/images/a.png'); put('SAKURAIDE/p/.sakura-cloud/state.json', '{}')
    expect(await call('fs:trashCheck', dir)).toMatchObject({ ok: false, kind: 'project' })
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })

  it('★★ 対照: 印の無い親フォルダ（子のプロジェクトだけ）は今までどおり workspace', async () => {
    put('SAKURAIDE/plainws/child/.sakuraide.json', '{}')
    expect(await call('fs:trashProject', at('SAKURAIDE/plainws'), { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: FS_TRASH_MESSAGES.workspace })
    expect(m.trashItem.mock.calls).toEqual([])
  })
})
