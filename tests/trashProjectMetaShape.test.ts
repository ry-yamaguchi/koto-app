import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 形の違う `.sakuraide.json` のプロジェクトは、`fs:trashProject` が移さずに断る ──────────────────────────────────────────────
// JSON として読めても、中身の形が公開の記録でない（配列・文字列・null・publish が数・targets が数）なら、読めない記録と同じに断る。
// 形を読めた回（`{}`・公開先つき）は今までどおり移す。本物の登録を IPC 名から呼び、実フォルダと「shell.trashItem の呼ばれた一覧」で見る。
// 画面と同じ判断を通ること（全部の組み合わせの表）は tests/projectDeleteRecordShapeTable.test.ts。
// 変異: 形の判断を外す（kind が ok なら通す）／`{}` まで断る（形の判断を厳しくする）。

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
import { readMetaFs, writePublishRecordFs, writeHanamiiProjectIdFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'

let home = ''
let savedHome: string | undefined
beforeEach(() => {
  savedHome = process.env.HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-meta-shape-')))
  process.env.HOME = home
  m.trashItem.mockClear()
  m.handlers.clear()
  registerFsHandlers({} as any)
})
afterEach(() => {
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
const MESSAGE = '公開の記録（.sakuraide.json）を読めないため、移していません。記録を直してから、もう一度削除してください。'

describe('★★★ 形の違う `.sakuraide.json` は断る。shell.trashItem は0回・フォルダも記録も動かない', () => {
  it('断りの文は、読めない記録のときと同じ文', () => {
    expect(FS_TRASH_MESSAGES.metaUnreadable).toBe(MESSAGE)
  })

  it.each([
    ['配列', '[]'],
    ['文字列', '"x"'],
    ['null', 'null'],
    ['数', '5'],
    ['publish が数', '{"publish":5}'],
    ['publish が文字列', '{"publish":"x"}'],
    ['publish が配列', '{"publish":[]}'],
    ['targets が数', '{"publish":{"targets":5}}'],
    ['targets が配列', '{"publish":{"targets":[]}}'],
  ])('★★★ %s → 断る。移す要求0件・記録はそのまま（IPC 経由）', async (_label, content) => {
    const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', content))
    put('SAKURAIDE/p/index.html')
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
    expect(fs.readFileSync(at('SAKURAIDE/p/.sakuraide.json'), 'utf-8')).toBe(content)
    expect(fs.existsSync(at('SAKURAIDE/p/index.html'))).toBe(true)
  })

  it('★★★ 直呼び（trashProjectFs）でも断る。IPC の登録に頼らない', async () => {
    const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', '{"publish":{"targets":5}}'))
    const trashItem = vi.fn(async (_p: string) => {})
    expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, { home, trashItem })).toEqual({ ok: false, message: MESSAGE })
    expect(trashItem.mock.calls).toEqual([])
  })

  it('★★★ 確認の印が無ければ、確認の文が先（形違いの文は、確認の次に来る）', async () => {
    const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', '[]'))
    expect(await call('fs:trashProject', dir)).toEqual({ ok: false, message: '確認ダイアログを通っていません' })
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: false, message: MESSAGE })
    expect(m.trashItem.mock.calls).toEqual([])
  })
})

describe('★★ 対照: 形を読めた `.sakuraide.json` は今までどおり移す', () => {
  it.each([
    ['空のオブジェクト', '{}'],
    ['公開先つき', '{"target":"hanamii","publish":{"targets":{"hanamii":{"publishedAt":null,"url":null}}}}'],
    ['publish が空', '{"publish":{}}'],
    ['publish が null', '{"publish":null}'],
    ['targets が空', '{"publish":{"targets":{}}}'],
    ['targets が null', '{"publish":{"targets":null}}'],
  ])('★★★ %s → 移す（1回）', async (_label, content) => {
    const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', content))
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })

  it('★★★ 記録が無い（ENOENT）は移す（1回）', async () => {
    const dir = path.dirname(path.dirname(put('SAKURAIDE/p/.sakura-cloud/state.json', '{}')))
    expect(await call('fs:trashProject', dir, { confirmed: true, skippedForTwins: [] })).toEqual({ ok: true })
    expect(m.trashItem.mock.calls).toEqual([[dir]])
  })
})

describe('★★ ほかの道は変えない: 公開の記録を書き足す・読む道は、形違いを空の記録として扱う（断らない）', () => {
  it.each([['配列', '[]'], ['文字列', '"x"'], ['null', 'null'], ['publish が数', '{"publish":5}'], ['targets が数', '{"publish":{"targets":5}}']])(
    '★★ %s: readMetaFs は形を判断せず ok で返し、書き足しは空の記録から書き直し、専有型の読みは空（投げない）',
    (_label, content) => {
      const dir = path.dirname(put('SAKURAIDE/p/.sakuraide.json', content))
      expect(readMetaFs(dir)).toEqual({ kind: 'ok', value: JSON.parse(content) })
      expect(readApprunDedicatedFs(dir)).toEqual({})
      writePublishRecordFs(dir, 'vercel', { publishedAt: 't', url: null })
      writeHanamiiProjectIdFs(dir, 'proj-x')
      const written = JSON.parse(fs.readFileSync(at('SAKURAIDE/p/.sakuraide.json'), 'utf-8'))
      expect(written.publish.targets.vercel).toEqual({ publishedAt: 't', url: null })
      expect(written.publish.hanamii.projectId).toBe('proj-x')
    },
  )
})
