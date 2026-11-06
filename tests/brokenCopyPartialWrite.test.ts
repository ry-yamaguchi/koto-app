import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ── 壊れた記録の写しを書いている途中で失敗したとき（0.6.26）──────────────────────────────────
// 書けるフォルダでも、ディスクが一杯のときは写しの書き込みが途中で止まる。そのとき:
//   ・書きかけの写しを残さない（「残してあります」と言う写しが欠けた中身にならない）
//   ・消すのは、いま自分が作った写しだけ。元の記録は決して消さない
//   ・backupName は null（その会話には書き込まない側へ倒す）
// 権限を外したフォルダ（0o555）では消す処理も権限で失敗し、50個の名前を埋める形では書き込みの
// 例外に入らない。どちらもこの分岐を通らないので、ここで書き込みの関数だけを差し替えて通す。
//
// ESM では `vi.spyOn(fs, 'writeFileSync')` が使えないので、'fs' を「既定では本物へ委譲するラッパー」に
// 差し替え、writeFileSync だけをテストごとに差し替える（tests/unused.test.ts と同じ作法）。
const writeHook = vi.hoisted(() => ({
  impl: null as null | ((file: unknown, data: unknown, options: unknown) => void),
  real: null as null | ((file: unknown, data: unknown, options: unknown) => void),
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  writeHook.real = actual.writeFileSync as unknown as (file: unknown, data: unknown, options: unknown) => void
  return {
    ...actual,
    writeFileSync: (file: unknown, data: unknown, options: unknown) => {
      if (writeHook.impl) return writeHook.impl(file, data, options)
      return writeHook.real!(file, data, options)
    },
  }
})

import { copyBrokenOnce, resetBrokenCopyMemory } from '../src/main/chatStore/brokenCopy'

const ORIGINAL = 'これは読めなかった会話の記録です。消えてはいけません。'
const STAMP = 'chat.json.broken-20261103-142530'
const enospc = (): Error => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })

let dir = ''
let file = ''
const names = () => fs.readdirSync(dir).sort()

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-partialcopy-'))
  file = path.join(dir, 'chat.json')
  fs.writeFileSync(file, ORIGINAL)
  resetBrokenCopyMemory()
})
afterEach(() => {
  writeHook.impl = null
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('copyBrokenOnce: 写しの書き込みが途中で失敗した回', () => {
  it('書きかけの写しを消す。元の記録はそのまま残り、backupName は null', () => {
    writeHook.impl = (dest, data, options) => {
      // 半分だけ書いてから、ディスクが一杯になる
      const half = (data as Buffer).subarray(0, Math.floor((data as Buffer).length / 2))
      writeHook.real!(dest, half, options)
      throw enospc()
    }

    const r = copyBrokenOnce(file, Buffer.from(ORIGINAL), new Date(2026, 10, 3, 14, 25, 30))

    expect(r).toEqual({ backupName: null })
    expect(names()).toEqual(['chat.json']) // 書きかけの写し（chat.json.broken-…）は残っていない
    expect(fs.readFileSync(file, 'utf-8')).toBe(ORIGINAL) // 元は消えず、中身も同じ
  })

  it('書き始める前に失敗した回も、元の記録はそのまま残り、backupName は null', () => {
    writeHook.impl = () => { throw enospc() }

    const r = copyBrokenOnce(file, Buffer.from(ORIGINAL), new Date(2026, 10, 3, 14, 25, 30))

    expect(r).toEqual({ backupName: null })
    expect(names()).toEqual(['chat.json'])
    expect(fs.readFileSync(file, 'utf-8')).toBe(ORIGINAL)
  })

  it('失敗のあと、書き込みが戻れば（同じ秒でも）写しを作れる。前の書きかけは名前を塞がない', () => {
    writeHook.impl = (dest, data, options) => {
      writeHook.real!(dest, (data as Buffer).subarray(0, 3), options)
      throw enospc()
    }
    expect(copyBrokenOnce(file, Buffer.from(ORIGINAL), new Date(2026, 10, 3, 14, 25, 30))).toEqual({ backupName: null })

    writeHook.impl = null // 空きができた
    const r = copyBrokenOnce(file, Buffer.from(ORIGINAL), new Date(2026, 10, 3, 14, 25, 30))

    expect(r).toEqual({ backupName: STAMP })
    expect(names()).toEqual(['chat.json', STAMP])
    expect(fs.readFileSync(path.join(dir, STAMP), 'utf-8')).toBe(ORIGINAL)
    expect(fs.readFileSync(file, 'utf-8')).toBe(ORIGINAL)
  })
})
