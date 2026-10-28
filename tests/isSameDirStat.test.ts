import { describe, it, expect, vi, afterEach } from 'vitest'

// isSameDirFs が呼ぶ fs.statSync だけを差し替えられるようにする（ふだんは本物へ流す）。bucketUsers.ts は `import * as fs from 'fs'` で読む。
const fake = vi.hoisted(() => ({ statSync: null as null | ((p: unknown) => unknown) }))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const statSync = (...args: Parameters<typeof real.statSync>) => (fake.statSync ? fake.statSync(args[0]) : real.statSync(...args))
  return { ...real, statSync, default: { ...real, statSync } }
})

import { isSameDirStat, isSameDirFs, type DirStatLike } from '../src/main/cloud/bucketUsers'

// ── 0.6.24 R3-f: `isSameDirFs` の比べる部分（dev・ino・フォルダか）を、fs に触れない純関数 `isSameDirStat` にして、表で固定する ──────────────────────────
// 検分で見つかった穴: `isSameDirFs` の `x.dev === y.dev` を外しても、全件緑だった（実フォルダの試験は、同じボリュームの中だけで、dev が違う組を作れない）。
// 別のボリューム（外付けのドライブ・別のパーティション）の inode 番号は重なりうるので、dev を見ないと、別のフォルダを「自分」と数える（複製・使用者を数え落とす）。
// 変異: dev の比較を外す／ino の比較を外す／片方のフォルダ判定を外す（x・y それぞれ）。

const stat = (kind: 'dir' | 'file', dev: number | bigint, ino: number | bigint): DirStatLike => ({ dev, ino, isDirectory: () => kind === 'dir' })

describe('★★★ isSameDirStat: 両方がフォルダで、dev と ino がどちらも等しいときだけ同じ', () => {
  it.each([
    ['同じ dev・同じ ino（フォルダ）', stat('dir', 16777230, 1234), stat('dir', 16777230, 1234), true],
    ['★ dev が違う・ino が同じ（別のボリュームで inode 番号が重なった）', stat('dir', 16777230, 1234), stat('dir', 16777231, 1234), false],
    ['★ dev が違う（逆の向き）', stat('dir', 2, 7), stat('dir', 1, 7), false],
    ['dev が同じ・ino が違う', stat('dir', 16777230, 1234), stat('dir', 16777230, 1235), false],
    ['dev も ino も違う', stat('dir', 1, 1), stat('dir', 2, 2), false],
    ['x がフォルダでない（dev・ino は同じ）', stat('file', 5, 9), stat('dir', 5, 9), false],
    ['y がフォルダでない（dev・ino は同じ）', stat('dir', 5, 9), stat('file', 5, 9), false],
    ['どちらもフォルダでない（dev・ino は同じ）', stat('file', 5, 9), stat('file', 5, 9), false],
    ['BigInt の stat: 同じ', stat('dir', 16777230n, 1234n), stat('dir', 16777230n, 1234n), true],
    ['★ BigInt の stat: dev が違う', stat('dir', 16777230n, 1234n), stat('dir', 16777231n, 1234n), false],
    ['BigInt の stat: ino が違う', stat('dir', 1n, 1n), stat('dir', 1n, 2n), false],
  ] as Array<[string, DirStatLike, DirStatLike, boolean]>)('%s → %s', (_label, x, y, expected) => {
    expect(isSameDirStat(x, y)).toBe(expected)
    expect(isSameDirStat(y, x), '引数の順を入れ替えても同じ答え').toBe(expected)
  })
})

describe('★★★ isSameDirFs は、実際の stat を isSameDirStat に渡す（dev が違えば、ino が同じでも別のフォルダ）', () => {
  afterEach(() => { fake.statSync = null })

  it('★★★ 偽の stat（同じ ino・違う dev）→ false。同じ dev・同じ ino → true。stat が失敗したら false', () => {
    const table: Record<string, DirStatLike> = {
      '/a': stat('dir', 1, 77), '/b': stat('dir', 2, 77), '/c': stat('dir', 1, 77),
    }
    fake.statSync = (p: unknown) => {
      const s = table[String(p)]
      if (!s) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return s
    }
    expect(isSameDirFs('/a', '/b')).toBe(false) // dev が違う
    expect(isSameDirFs('/a', '/c')).toBe(true)
    expect(isSameDirFs('/a', '/missing')).toBe(false)
  })
})
