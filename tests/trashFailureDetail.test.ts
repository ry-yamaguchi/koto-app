import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { trashProjectFs, trashFs, TRASH_FAILED_SENTENCE } from '../src/main/ipc/fsTrash'
import { moveProjectToTrash, trashFailureText } from '../src/renderer/teardown/projectDelete'
import { splitFailureDetail } from '../src/shared/failureDetail'
import { failureText } from '../src/shared/failureText'
import { resetProjectOpsForTests } from '../src/main/projectOps'

// ── P-138: ゴミ箱へ移せない失敗（macOS の文・code の無い Error）に、案内の文と「詳細:」が付く ──────────────
// 本物の形で通す: 実フォルダ → 本物の trashProjectFs（偽の trashItem が macOS の日本語の文で投げる）→ 画面の trash 口（ProjectDeleteDialog と同じ変換）→
// 本物の moveProjectToTrash → 画面が出す message を FailureLines と同じ splitFailureDetail で分ける。層を別々に固定するだけにしない。
// 変異: main の catch で failureText をそのまま返す（元の形）→ 案内の文が出ず落ちる／画面の trashFailureText が詳細を落とす → 落ちる。

const MAC = 'The operation couldn\u2019t be completed. ファイル“p”をゴミ箱に入れることができませんでした。'
const GO = { confirmed: true, skippedForTwins: [] as string[] }
let home = ''
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-p138-')))
  fs.mkdirSync(path.join(home, 'SAKURAIDE', 'p'), { recursive: true })
  fs.writeFileSync(path.join(home, 'SAKURAIDE', 'p', 'index.html'), '<p>hi</p>')
})
afterEach(() => { resetProjectOpsForTests(); fs.rmSync(home, { recursive: true, force: true }) })
const dir = () => path.join(home, 'SAKURAIDE', 'p')
const failing = async (_p: string) => { throw new Error(MAC) }

describe('P-138 プロジェクトの削除: ゴミ箱へ移せない（本物の形）', () => {
  it('★★★ main から画面の文まで: 案内の文と「詳細:」（原文）が出る。macOS の文だけにならない', async () => {
    const phase = await moveProjectToTrash(dir(), [], {
      runningOp: async () => null,
      exists: async () => true,
      trash: async (p, skipped) => {
        const r = await trashProjectFs(p, { confirmed: true, skippedForTwins: skipped }, { home, trashItem: failing })
        if (r.ok) return
        throw new Error(r.message) // ProjectDeleteDialog の trash 口と同じ
      },
    } as any, [])
    expect(phase.phase).toBe('trashFailed')
    const { text, detail } = splitFailureDetail((phase as any).message)
    expect(text).toContain('プロジェクトを削除できませんでした')
    expect(text).toContain('Finder で、ロックされていないか・権限を確かめてください')
    expect(detail).toContain('ゴミ箱に入れることができませんでした')
    // 案内の文が文のほうに、原文は詳細のほうだけに（原文が文の側に出ない）
    expect(text).not.toContain('ゴミ箱に入れることができませんでした')
  })

  it('main の返す message は「固定の文＋詳細: 原文」', async () => {
    const r = await trashProjectFs(dir(), GO, { home, trashItem: failing })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail((r as any).message)
    expect(text).toBe(TRASH_FAILED_SENTENCE)
    expect(detail).toContain('ゴミ箱に入れることができませんでした')
    expect(fs.existsSync(dir())).toBe(true)
  })

  it('権限の code が付いた失敗でも、詳細を落とさない（画面の trashFailureText が fs-denied の分岐で捨てない）', () => {
    const shown = trashFailureText(new Error(`${TRASH_FAILED_SENTENCE}\n詳細: EPERM: operation not permitted`))
    expect(splitFailureDetail(shown).detail).toBe('EPERM: operation not permitted')
    expect(splitFailureDetail(shown).text).toBe(TRASH_FAILED_SENTENCE)
  })

  it('IPC の頭が付いても、文と詳細は二重にならない（failureText）', () => {
    const e = new Error(`Error invoking remote method 'fs:trash': Error: ${TRASH_FAILED_SENTENCE}\n詳細: ${MAC}`)
    const shown = failureText(e, { checkAt: 'ファイル一覧' })
    expect(shown).toBe(`${TRASH_FAILED_SENTENCE}\n詳細: ${MAC}`)
  })
})

describe('P-138 双子: ファイル一覧のゴミ箱（fs:trash）も同じ形', () => {
  it('★★★ trashFs は文＋詳細で投げ、画面の failureText を通っても案内と詳細が残る', async () => {
    const f = path.join(home, 'SAKURAIDE', 'p', 'index.html')
    let thrown: unknown
    try { await trashFs(f, { home, trashItem: failing }) } catch (e) { thrown = e }
    const shown = failureText(thrown, { checkAt: 'ファイル一覧' })
    expect(splitFailureDetail(shown).text).toBe(TRASH_FAILED_SENTENCE)
    expect(splitFailureDetail(shown).detail).toContain('ゴミ箱に入れることができませんでした')
  })
})
