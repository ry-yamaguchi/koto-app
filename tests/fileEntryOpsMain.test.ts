import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deleteFileEntry, type FileEntryDeleteDeps } from '../src/renderer/fileEntryOps'
import { trashCheckFs, trashFs, FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'

// ── T-E4（つなぎ）: ファイル一覧の削除を、**本物の main（fs:trashCheck・fs:trash の中身）と実フォルダ（一時のホーム）**に繋いで通す（0.6.24 E-4）──────────
// renderer の振り分け（fileEntryOps.ts）は、main の答えの形（ok・kind・message）を読む。双方が別々の型を持つので、**実際の答えを流して**ずれを見つける
// （kind の綴りが食い違うと、根が「断りの文」になる・記録が確認へ進む、のどちらかが起きる）。
//   ・根 → 削除の画面（確認も移す要求も 0）／記録・中にプロジェクトがある・調べられない・ホームの直下 → main の文がそのまま画面に出る（移す要求 0）
//   ・ふつうのファイル → 確認のあとで移す（ここだけ 1 回）

let home = ''
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-entryops-')) })
afterEach(() => {
  const unlock = (d: string) => { try { fs.chmodSync(d, 0o755); for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(path.join(d, e.name)) } catch { /* 無い・読めない */ } }
  unlock(home)
  fs.rmSync(home, { recursive: true, force: true })
})

const at = (...rel: string[]) => path.join(home, ...rel)
function put(rel: string, content = 'x'): string {
  const full = at(rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

/** 本物の main の判断につないだ口。移す口 `trashItem` と確認・画面の動きだけ偽物にして、呼ばれたものを残す。 */
function wired(confirmAnswer = true) {
  const log = { trashed: [] as string[], confirms: 0, opened: [] as string[], alerts: [] as string[], announced: [] as string[] }
  const deps: FileEntryDeleteDeps = {
    trashCheck: async p => trashCheckFs(p, { home }),
    trash: p => trashFs(p, { home, trashItem: async abs => { log.trashed.push(abs) } }),
    confirm: async () => { log.confirms++; return confirmAnswer },
    openProjectDelete: d => { log.opened.push(d) },
    alert: m => { log.alerts.push(m) },
    announceDeleted: p => { log.announced.push(p) },
  }
  return { log, deps }
}
const entryOf = (p: string) => ({ name: path.basename(p), path: p })

describe('★★★ T-E4 本物の main につないだ、ファイル一覧の削除の振り分け', () => {
  it('プロジェクトの根（.sakuraide.json がある）→ 削除の画面を開くだけ。確認 0・移す要求 0・断りの文 0', async () => {
    const root = path.dirname(put('SAKURAIDE/proj/.sakuraide.json', '{"name":"p"}'))
    put('SAKURAIDE/proj/index.html')
    const { log, deps } = wired()
    await deleteFileEntry(entryOf(root), deps)
    expect(log.opened).toEqual([root])
    expect(log.confirms).toBe(0)
    expect(log.trashed).toEqual([])
    expect(log.alerts).toEqual([])
    expect(fs.existsSync(at('SAKURAIDE/proj/.sakuraide.json'))).toBe(true)
  })

  it('プロジェクトの根（.sakura-cloud だけがある）も同じ', async () => {
    const root = at('SAKURAIDE/proj2')
    put('SAKURAIDE/proj2/.sakura-cloud/state.json', '{}')
    const { log, deps } = wired()
    await deleteFileEntry(entryOf(root), deps)
    expect(log.opened).toEqual([root])
    expect(log.trashed).toEqual([])
  })

  it.each([
    ['記録（state.json）', 'SAKURAIDE/proj/.sakura-cloud/state.json', FS_TRASH_MESSAGES.record],
    ['記録（.sakuraide.json）', 'SAKURAIDE/proj/.sakuraide.json', FS_TRASH_MESSAGES.record],
    ['記録の中のフォルダ（.sakuraide-backup/1）', 'SAKURAIDE/proj/.sakuraide-backup/1/a.txt', FS_TRASH_MESSAGES.record],
  ])('%s → main の文をそのまま出す。確認 0・移す要求 0・ディスクはそのまま', async (_name, rel, message) => {
    const file = put(rel)
    const { log, deps } = wired()
    await deleteFileEntry(entryOf(file), deps)
    expect(log.alerts).toEqual([message])
    expect(message).toBe('Koto の記録のファイルなので、ここからは削除できません。')
    expect(log.confirms).toBe(0)
    expect(log.trashed).toEqual([])
    expect(log.opened).toEqual([])
    expect(fs.existsSync(file)).toBe(true)
  })

  it('中にプロジェクトがあるフォルダ → 「まとめて削除できません」。確認 0・移す要求 0', async () => {
    put('ws/clients/acme/.sakuraide.json', '{}')
    const { log, deps } = wired()
    await deleteFileEntry(entryOf(at('ws/clients')), deps)
    expect(log.alerts).toEqual([FS_TRASH_MESSAGES.workspace])
    expect(log.confirms).toBe(0)
    expect(log.trashed).toEqual([])
    expect(log.opened).toEqual([])
  })

  it('中を調べられないフォルダ（chmod 000）→ 「確かめられないため、削除していません」。確認 0・移す要求 0', async () => {
    const dir = at('SAKURAIDE/proj/locked')
    put('SAKURAIDE/proj/locked/a.txt')
    fs.chmodSync(dir, 0o000)
    const { log, deps } = wired()
    await deleteFileEntry(entryOf(dir), deps)
    expect(log.alerts).toEqual([FS_TRASH_MESSAGES.unknown])
    expect(log.confirms).toBe(0)
    expect(log.trashed).toEqual([])
  })

  it('ホームの直下 → ホームの深さの断り（main の文）。確認 0・移す要求 0', async () => {
    const dir = at('Documents')
    fs.mkdirSync(dir)
    const { log, deps } = wired()
    await deleteFileEntry(entryOf(dir), deps)
    expect(log.alerts).toHaveLength(1)
    expect(log.alerts[0]).toContain('ホームフォルダの直下')
    expect(log.confirms).toBe(0)
    expect(log.trashed).toEqual([])
  })

  it('ふつうのファイル → 確認のあとで 1 回だけ移す。タブへ知らせる', async () => {
    put('SAKURAIDE/proj/.sakuraide.json', '{}')
    const file = put('SAKURAIDE/proj/public/index.html')
    const { log, deps } = wired()
    await deleteFileEntry(entryOf(file), deps)
    expect(log.confirms).toBe(1)
    expect(log.trashed).toEqual([file])
    expect(log.announced).toEqual([file])
    expect(log.alerts).toEqual([])
    expect(log.opened).toEqual([])
  })

  it('ふつうのフォルダ → 確認でやめたら移さない', async () => {
    put('SAKURAIDE/proj/.sakuraide.json', '{}')
    const dir = path.dirname(put('SAKURAIDE/proj/images/a.png'))
    const { log, deps } = wired(false)
    await deleteFileEntry(entryOf(dir), deps)
    expect(log.confirms).toBe(1)
    expect(log.trashed).toEqual([])
    expect(log.announced).toEqual([])
  })
})
