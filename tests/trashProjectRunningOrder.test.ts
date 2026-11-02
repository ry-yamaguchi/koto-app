import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { trashProjectFs, FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'
import { withProjectLock } from '../src/main/projectLock'
import { resetProjectOpsForTests } from '../src/main/projectOps'

// ── fs:trashProject の断りの順: 走っている操作 → `.sakuraide.json` → `.sakura-cloud/state.json` ──────────────────────────────────
// 画面の止める理由の順（走っている操作 → 公開の記録を読めない。tests/projectDeleteRecordPlan.test.ts）と、main の断りの順を同じに固定する。
// 走っている操作と、読めない・形が違う記録が重なる回に、main が記録の文を返すと、画面（処理が進んでいます）と文が食い違う。
// 実フォルダと「shell.trashItem の代役が呼ばれた一覧」で見る。重なりを解いた（走っている操作が終わった）あとは、同じフォルダを記録の文で断ることも確かめる
// （記録が本当に断る状態だったことの対照）。
// 変異: 走っている操作の断りを、記録の断りより後ろへ動かす（順序）。

let home = ''
let trashed: string[] = []
const deps = () => ({ home, trashItem: async (p: string) => { trashed.push(p) } })
const GO = { confirmed: true, skippedForTwins: [] }

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-trash-order-')))
  trashed = []
})
afterEach(() => {
  resetProjectOpsForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

const at = (...rel: string[]) => path.join(home, ...rel)
function put(rel: string, content: string): void {
  const full = at(rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}
/** このフォルダで操作が走っている状態にする（鍵を持ったまま待つ）。返す関数が鍵を放して、操作を終える。 */
function holdRunning(dir: string): () => Promise<void> {
  let open!: () => void
  const gate = new Promise<void>(r => { open = r })
  const holder = withProjectLock(dir, '公開', () => gate, { target: 'sakura-apprun-dedicated', handler: 'test:hold' })
  return async () => { open(); await holder }
}

const META = 'SAKURAIDE/p/.sakuraide.json'
const STATE = 'SAKURAIDE/p/.sakura-cloud/state.json'
const PROJECT = (): string => at('SAKURAIDE/p')

describe('★★★ 走っている操作と、読めない・形違いの記録が重なる回は、走っている操作の文が先（main の断りの順）', () => {
  const CASES: Array<[string, Array<[string, string]>, string]> = [
    ['壊れた .sakuraide.json', [[META, '{"publish": {']], FS_TRASH_MESSAGES.metaUnreadable],
    ['形違いの .sakuraide.json（配列）', [[META, '[]']], FS_TRASH_MESSAGES.metaUnreadable],
    ['形違いの .sakuraide.json（publish が数）', [[META, '{"publish":5}']], FS_TRASH_MESSAGES.metaUnreadable],
    ['壊れた .sakura-cloud/state.json', [[STATE, '{ 壊れた state']], FS_TRASH_MESSAGES.stateUnreadable],
    ['.sakuraide.json も state.json も壊れている', [[META, '{broken'], [STATE, '{ 壊れた state']], FS_TRASH_MESSAGES.metaUnreadable],
  ]

  it.each(CASES)('★★★ %s + 走っている操作 → 走っている操作の文。移す要求0件。終わったあとは記録の文で断る', async (_label, files, recordMessage) => {
    for (const [rel, content] of files) put(rel, content)
    const release = holdRunning(PROJECT())
    try {
      expect(await trashProjectFs(PROJECT(), GO, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.running })
      expect(trashed).toEqual([])
    } finally {
      await release()
    }
    // 対照: 走っている操作が終われば、同じフォルダを記録の文で断る（重なりの回に、記録が断る状態だったこと）
    expect(await trashProjectFs(PROJECT(), GO, deps())).toEqual({ ok: false, message: recordMessage })
    expect(trashed).toEqual([])
  })

  it('★★ 文は言い分ける: 走っている操作の文と記録の文は別の文（同じ文で通る試験にしない）', () => {
    expect(new Set([FS_TRASH_MESSAGES.running, FS_TRASH_MESSAGES.metaUnreadable, FS_TRASH_MESSAGES.stateUnreadable]).size).toBe(3)
  })
})
