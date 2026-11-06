import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileIfUnchangedFs } from '../src/main/writeIfUnchangedFs'

// ── 書くのに途中で失敗したとき（空き容量・I/O）、書きかけのファイルを残さない ──
// writeFileSync は開いた時点で中身を空にするので、途中で切れると書きかけの中身が残る。それを残すと、次の保存が
// 「外で書き換えられた」と読んでしまう（Koto 自身が書きかけたものを、外の変更と取り違える）。
// 実際のディスクでは空き容量不足を再現できないので、fs の writeFileSync だけを「途中まで書いて失敗する」ものに差し替える。

const hook = vi.hoisted(() => ({
  /** 書き込みの呼び出しを差し替える。undefined なら本物。 */
  write: undefined as undefined | ((p: string, data: string, call: number) => void),
  calls: 0,
  /** 差し替える前の本物の書き込み。 */
  real: undefined as unknown as (p: string, data: string, enc: string) => void,
}))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  hook.real = actual.writeFileSync as typeof hook.real
  const writeFileSync = (p: any, data: any, opts?: any) => {
    hook.calls++
    if (hook.write) hook.write(p, data, hook.calls)
    else hook.real(p, data, opts)
  }
  return { ...actual, writeFileSync, default: { ...actual, writeFileSync } }
})

let dir = ''
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-wiu-partial-')))
  hook.write = undefined
  hook.calls = 0
})
afterEach(() => {
  hook.write = undefined
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 本物の書き込み（差し替え前）。 */
const realWrite = (p: string, data: string) => hook.real(p, data, 'utf-8')
const noSpace = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })

describe('writeFileIfUnchangedFs: 書くのに失敗したとき、書きかけを残さない', () => {
  it('★★★ あるファイルを書いている途中で失敗した: 失敗はそのまま投げる。ディスクは読んでいた中身に戻る（書きかけが残らない）', () => {
    const f = path.join(dir, 'a.txt')
    realWrite(f, 'old content')
    // 1回目（本体の書き込み）は書きかけを残して失敗、2回目（戻す書き込み）は本物
    hook.write = (p, data, call) => {
      if (call === 1) { realWrite(p, 'par'); throw noSpace() }
      realWrite(p, data)
    }
    expect(() => writeFileIfUnchangedFs(f, 'new content that does not fit', 'old content')).toThrow('no space left on device')
    expect(fs.readFileSync(f, 'utf-8')).toBe('old content')
  })

  it('★★ 戻す書き込みも失敗しても、元の失敗を投げる（別の例外で包まない）', () => {
    const f = path.join(dir, 'a.txt')
    realWrite(f, 'old content')
    hook.calls = 0
    hook.write = () => { throw noSpace() }
    let thrown: unknown
    try { writeFileIfUnchangedFs(f, 'new', 'old content') } catch (e) { thrown = e }
    expect((thrown as { code?: string }).code).toBe('ENOSPC')
    expect(hook.calls).toBe(2) // 本体の書き込みと、戻す書き込みの2回だけ
    expect(fs.readFileSync(f, 'utf-8')).toBe('old content') // 書き込みが何も効かなかったので、そのまま
  })

  it('★★ 作り直す回（expected が null）に失敗したら、できかけのファイルを消す', () => {
    const f = path.join(dir, 'sub', 'a.txt')
    hook.write = (p, _data, call) => {
      if (call === 1) { realWrite(p, 'par'); throw noSpace() }
    }
    expect(() => writeFileIfUnchangedFs(f, 'new', null)).toThrow('no space left on device')
    expect(fs.existsSync(f)).toBe(false)
  })

  it('書けた回は、1回だけ書く（戻す書き込みを足さない）', () => {
    const f = path.join(dir, 'a.txt')
    realWrite(f, 'old')
    hook.calls = 0
    expect(writeFileIfUnchangedFs(f, 'new', 'old')).toEqual({ ok: true })
    expect(hook.calls).toBe(1)
    expect(fs.readFileSync(f, 'utf-8')).toBe('new')
  })

  it('止めた回（外で変わっていた）は、書き込みを1回も呼ばない', () => {
    const f = path.join(dir, 'a.txt')
    realWrite(f, '外の版')
    hook.calls = 0
    expect(writeFileIfUnchangedFs(f, 'mine', 'old')).toEqual({ ok: false, reason: 'changed', disk: '外の版' })
    expect(hook.calls).toBe(0)
  })
})
