import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 0.6.24 R2-h: 読めない・壊れている `.sakuraide.json` のプロジェクトは、`fs:trashProject` が移さずに断る（K3 と同じ向き）──────────
// いまは `readApprunDedicatedFs` が読めない記録を「専有型の残りなし」と読み、そのまま移していた（記録ごと移り、専有型の月額が止まらない）。
// 本物の登録を IPC 名から呼び、実フォルダと「shell.trashItem の呼ばれた一覧」で見る。ENOENT（記録が無い）は今どおり通す。
// 変異: unreadable を通す（確かめを外す）／ENOENT まで断る（kind !== 'ok'）。

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
import { FS_TRASH_MESSAGES, trashProjectFs } from '../src/main/ipc/fsTrash'

let home = ''
let savedHome: string | undefined
const lockedFiles: string[] = []
beforeEach(() => {
  savedHome = process.env.HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r2h-')))
  process.env.HOME = home
  m.trashItem.mockClear()
  m.handlers.clear()
  registerFsHandlers({} as any)
})
afterEach(() => {
  for (const f of lockedFiles.splice(0)) { try { fs.chmodSync(f, 0o644) } catch { /* 無い */ } }
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
const MESSAGE = '公開の記録（.sakuraide.json）を読めないため、移していません。記録を直してから、もう一度削除してください。'

describe('★★★ R2-h fs:trashProject: 読めない `.sakuraide.json` は断る。shell.trashItem は0回・フォルダも記録も動かない', () => {
  it('断りの文は作者の決めた文のとおり', () => {
    expect(FS_TRASH_MESSAGES.metaUnreadable).toBe(MESSAGE)
  })

  it.each([
    ['壊れた JSON', '{"publish": {'],
    ['空のファイル', ''],
    ['JSON でない文字', 'これは記録ではない'],
  ])('★★★ %s → 断る。移す要求0件・記録はそのまま', async (_label, content) => {
    const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', content))
    put('SAKURAIDE/p/index.html')
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
    expect(fs.readFileSync(at('SAKURAIDE/p/.sakuraide.json'), 'utf-8')).toBe(content)
  })

  it('★★★ `.sakuraide.json` がファイルでなくフォルダ（読めない）→ 断る', async () => {
    fs.mkdirSync(at('SAKURAIDE/p/.sakuraide.json'), { recursive: true })
    put('SAKURAIDE/p/.sakura-cloud/state.json', '{}') // プロジェクトの印はこちら
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it.skipIf(rootIsMe)('★★★ 権限がなく読めない（0o000）→ 断る', async () => {
    const meta = put('SAKURAIDE/p/.sakuraide.json', '{"target":"apprun-dedicated"}')
    fs.chmodSync(meta, 0o000); lockedFiles.push(meta)
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★★ 直呼び（trashProjectFs）でも断る。IPC の登録に頼らない', async () => {
    const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', '{broken'))
    const trashItem = vi.fn(async (_p: string) => {})
    expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, { home, trashItem })).toEqual({ ok: false, message: MESSAGE })
    expect(trashItem.mock.calls).toEqual([])
  })

  it('★★★ 確認の印が無ければ、確認の文が先（読めない記録の文は、確認の次に来る）', async () => {
    const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', '{broken'))
    expect(await call('fs:trashProject', dir)).toEqual({ ok: false, message: '確認ダイアログを通っていません' })
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
  })
})

describe('★★ R2-h 対照: 記録が無い（ENOENT）・読める記録は今どおり移す', () => {
  it('★★★ `.sakuraide.json` が無く `.sakura-cloud/` だけのプロジェクトは移す（1回）', async () => {
    const dir = path.dirname(path.dirname(put('SAKURAIDE/p/.sakura-cloud/state.json', '{}')))
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })

  it('★★★ 読める `.sakuraide.json`（`{}`・公開先つき）は移す（1回ずつ）', async () => {
    const a = path.dirname(put('SAKURAIDE/a/.sakuraide.json', '{}'))
    const b = path.dirname(put('SAKURAIDE/b/.sakuraide.json', '{"target":"hanamii","publish":{"targets":{}}}'))
    expect(await call('fs:trashProject', a, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
    expect(await call('fs:trashProject', b, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[a], [b]])
  })
})
