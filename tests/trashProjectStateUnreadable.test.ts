import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 0.6.24 R3-d: 読めない・壊れている `.sakura-cloud/state.json` のプロジェクトも、`fs:trashProject` は移さずに断る（R2-h の双子）────────────
// R2-h は `.sakuraide.json` だけだった。共用型の記録（state.json の apprun-app・bucket・レジストリ）が ENOENT 以外で読めない・壊れているのに移すと、記録ごと移り、
// 共用型の資源（月額）を Koto から止められなくなる。ENOENT（記録が無い）は今どおり通す。
// 本物の登録を IPC 名から呼び、実フォルダと「shell.trashItem の呼ばれた一覧」で見る（掟10）。
// 変異: state.json の確かめを外す／ENOENT まで断る（kind !== 'ok'）／`.sakuraide.json` の確かめより先に置く（順序）。

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
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r3d-')))
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
const MESSAGE = '公開の記録（.sakura-cloud/state.json）を読めないため、移していません。記録を直してから、もう一度削除してください。'
const META_MESSAGE = '公開の記録（.sakuraide.json）を読めないため、移していません。記録を直してから、もう一度削除してください。'
const GO = { confirmed: true, skippedForTwins: [] }
const STATE = 'SAKURAIDE/p/.sakura-cloud/state.json'

describe('★★★ R3-d fs:trashProject: 読めない `.sakura-cloud/state.json` は断る。shell.trashItem は0回・フォルダも記録も動かない', () => {
  it('断りの文は R2-h と同じ形で、ファイル名だけ違う', () => {
    expect(FS_TRASH_MESSAGES.stateUnreadable).toBe(MESSAGE)
    expect(FS_TRASH_MESSAGES.stateUnreadable).toBe(FS_TRASH_MESSAGES.metaUnreadable.replace('.sakuraide.json', '.sakura-cloud/state.json'))
  })

  it.each([
    ['壊れた JSON', '{"resources": ['],
    ['空のファイル', ''],
    ['JSON でない文字', 'これは記録ではない'],
  ])('★★★ %s → 断る。移す要求0件・記録はそのまま', async (_label, content) => {
    const state = put(STATE, content)
    put('SAKURAIDE/p/index.html')
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), GO)).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
    expect(fs.readFileSync(state, 'utf-8')).toBe(content)
    expect(fs.existsSync(at('SAKURAIDE/p/index.html'))).toBe(true)
  })

  it('★★★ `.sakuraide.json` は読める（公開先つき）が state.json が壊れている → 断る（R2-h の確かめだけでは通っていた形）', async () => {
    put('SAKURAIDE/p/.sakuraide.json', '{"publish":{"targets":{}}}')
    put(STATE, '{ 壊れた')
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), GO)).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★★ state.json がファイルでなくフォルダ（読めない）→ 断る', async () => {
    fs.mkdirSync(at(STATE), { recursive: true })
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), GO)).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it.skipIf(rootIsMe)('★★★ 権限がなく読めない（0o000）→ 断る', async () => {
    const state = put(STATE, '{"resources":[]}')
    fs.chmodSync(state, 0o000); lockedFiles.push(state)
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), GO)).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
  })

  it('★★★ 直呼び（trashProjectFs）でも断る。IPC の登録に頼らない', async () => {
    put(STATE, '{broken')
    const trashItem = vi.fn(async (_p: string) => {})
    expect(await trashProjectFs(at('SAKURAIDE/p'), GO, { home, trashItem })).toEqual({ ok: false, message: MESSAGE })
    expect(trashItem.mock.calls).toEqual([])
  })
})

describe('★★ R3-d 順序: 確認 → 場所 → 走っている操作 → `.sakuraide.json`（R2-h）→ state.json（R3-d）→ skippedForTwins の形', () => {
  it('確認の印が無ければ確認の文が先', async () => {
    put(STATE, '{broken')
    expect(await call('fs:trashProject', at('SAKURAIDE/p'))).toEqual({ ok: false, message: '確認ダイアログを通っていません' })
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), GO)).toEqual({ ok: false, message: MESSAGE })
  })

  it('両方が読めないときは `.sakuraide.json` の文（R2-h が先）', async () => {
    put('SAKURAIDE/p/.sakuraide.json', '{broken')
    put(STATE, '{broken')
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), GO)).toEqual({ ok: false, message: META_MESSAGE })
  })

  it('state.json が読めないとき、skippedForTwins の形が不正でも state.json の文が先（複製の読み直しより先に断る）', async () => {
    put(STATE, '{broken')
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), { confirmed: true, skippedForTwins: ['nope'] })).toEqual({ ok: false, message: MESSAGE })
    expect(await call('fs:trashProject', at('SAKURAIDE/p'), { confirmed: true, skippedForTwins: ['sakura-apprun'] })).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
  })
})

describe('★★ R3-d 対照: 記録が無い（ENOENT）・読める記録は今どおり移す', () => {
  it('★★★ state.json が無い（`.sakuraide.json` だけ・`.sakura-cloud/` だけ）→ 移す', async () => {
    const a = path.dirname(put('SAKURAIDE/a/.sakuraide.json', '{}'))
    fs.mkdirSync(at('SAKURAIDE/b/.sakura-cloud'), { recursive: true })
    put('SAKURAIDE/b/.sakura-cloud/env.json', '{}')
    expect(await call('fs:trashProject', a, GO)).toEqual({ ok: true })
    expect(await call('fs:trashProject', at('SAKURAIDE/b'), GO)).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[a], [at('SAKURAIDE/b')]])
  })

  it('★★★ 読める state.json（空のオブジェクト・resources つき）→ 移す', async () => {
    put('SAKURAIDE/a/.sakura-cloud/state.json', '{}')
    put('SAKURAIDE/b/.sakura-cloud/state.json', '{"name":"b","backend":"apprun","resources":[]}')
    expect(await call('fs:trashProject', at('SAKURAIDE/a'), GO)).toEqual({ ok: true })
    expect(await call('fs:trashProject', at('SAKURAIDE/b'), GO)).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[at('SAKURAIDE/a')], [at('SAKURAIDE/b')]])
  })
})
