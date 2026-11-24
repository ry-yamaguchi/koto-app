import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { trashUnusedImages, isInsideRoot } from '../src/renderer/unusedImagesTrash'

// ── P-137: 「🗑 使っていない画像をゴミ箱へ」は、公開の根（public/ があればその中）の下から移す ──────────────
// 見た目のチェックが返す名前は公開の根からの相対。移す先をプロジェクト直下につなぐと、public/ があるプロジェクトでは1件も移せず、
// 直下に同じ名前の別のファイルがあればそれを移してしまう。偽の electronAPI（fs.exists・fs.trash）で、移した先の一覧と移せなかった名前を見る。
// 変異: 移す先を `${projectDir}/${rel}`（直下）に戻す／`..` を弾かない／根を決める前に移し始める、がそれぞれ落ちる。

const PROJECT = '/Users/me/site'
let trashed: string[] = []
let existing: Set<string> = new Set()
let failOn: Set<string> = new Set()

beforeEach(() => {
  trashed = []
  existing = new Set()
  failOn = new Set()
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        exists: async (p: string) => existing.has(p),
        trash: async (p: string) => { if (failOn.has(p)) throw new Error('移せません'); trashed.push(p) },
      },
    },
  }
})
afterEach(() => { delete (globalThis as any).window })

describe('P-137 trashUnusedImages: 移す先は公開の根の下', () => {
  it('★★★ public/ がある: 名前は public/ の中として移す。直下の同じ名前のファイルは移さない', async () => {
    existing.add(`${PROJECT}/public`)
    const failed = await trashUnusedImages(PROJECT, ['images/old.png', 'bg.jpg'])
    expect(trashed).toEqual([`${PROJECT}/public/images/old.png`, `${PROJECT}/public/bg.jpg`])
    expect(trashed).not.toContain(`${PROJECT}/bg.jpg`)
    expect(failed).toEqual([])
  })

  it('public/ が無い（移行前）: プロジェクト直下の中として移す', async () => {
    const failed = await trashUnusedImages(PROJECT, ['images/old.png'])
    expect(trashed).toEqual([`${PROJECT}/images/old.png`])
    expect(failed).toEqual([])
  })

  it('★★★ 外を指す名前は移さず、移せなかった名前に数える（絶対パス・.. ・空）', async () => {
    existing.add(`${PROJECT}/public`)
    const bad = ['/etc/passwd', '../secret.png', 'a/../../b.png', '', 'C:/x.png', '~/x.png', '.']
    const failed = await trashUnusedImages(PROJECT, [...bad, 'ok..name.png'])
    expect(trashed).toEqual([`${PROJECT}/public/ok..name.png`])
    expect(failed).toEqual(bad)
  })

  it('★★ 見た目のチェックの時点の根を渡したら、その後に public/ が現れても渡した根の下へ移す', async () => {
    // チェックの時は public/ が無かった（根は直下）→ 押すまでの間に public/ ができた
    existing.add(`${PROJECT}/public`)
    const failed = await trashUnusedImages(PROJECT, ['a.png'], PROJECT)
    expect(trashed).toEqual([`${PROJECT}/a.png`])
    expect(failed).toEqual([])
  })

  it('移すのに失敗した名前は、残りを止めずに移せなかった名前へ', async () => {
    existing.add(`${PROJECT}/public`)
    failOn.add(`${PROJECT}/public/b.png`)
    const failed = await trashUnusedImages(PROJECT, ['a.png', 'b.png', 'c.png'])
    expect(trashed).toEqual([`${PROJECT}/public/a.png`, `${PROJECT}/public/c.png`])
    expect(failed).toEqual(['b.png'])
  })

  it('プロジェクトの場所が空: 何も移さず全部を移せなかった名前にする', async () => {
    const failed = await trashUnusedImages('', ['a.png'])
    expect(trashed).toEqual([])
    expect(failed).toEqual(['a.png'])
  })

  it('isInsideRoot: 根の下に収まる相対だけ通す', () => {
    for (const ok of ['a.png', 'img/a.png', './a.png', 'a..b.png']) expect(isInsideRoot(ok), ok).toBe(true)
    for (const ng of ['', '/a.png', '../a.png', 'a/../a.png', '.', './', 'a\0b', 1 as unknown]) expect(isInsideRoot(ng), String(ng)).toBe(false)
  })
})
