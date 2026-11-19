import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readTextInsideDirFs } from '../src/main/readInsideDirFs'

let base = ''
let dir = ''
let outside = ''
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inside-dir-')))
  dir = path.join(base, 'proj')
  outside = path.join(base, 'outside.txt')
  fs.mkdirSync(dir)
  fs.writeFileSync(outside, 'secret')
})
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

describe('readTextInsideDirFs', () => {
  it('ふつうに読める', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
    expect(readTextInsideDirFs(dir, 'a.txt', 100)).toEqual({ state: 'text', content: 'hello' })
  })
  it('無ければ missing', () => {
    expect(readTextInsideDirFs(dir, 'none.txt', 100)).toEqual({ state: 'missing' })
  })
  it('フォルダは unreadable', () => {
    fs.mkdirSync(path.join(dir, 'sub'))
    expect(readTextInsideDirFs(dir, 'sub', 100)).toEqual({ state: 'unreadable' })
  })
  it('上限ちょうどは読め、1バイト超は unreadable', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), '12345')
    expect(readTextInsideDirFs(dir, 'a.txt', 5)).toEqual({ state: 'text', content: '12345' })
    expect(readTextInsideDirFs(dir, 'a.txt', 4)).toEqual({ state: 'unreadable' })
  })
  it('rel が絶対パス・外へ出る・空は unreadable', () => {
    expect(readTextInsideDirFs(dir, outside, 100)).toEqual({ state: 'unreadable' })
    expect(readTextInsideDirFs(dir, '../outside.txt', 100)).toEqual({ state: 'unreadable' })
    expect(readTextInsideDirFs(dir, '', 100)).toEqual({ state: 'unreadable' })
  })
  it('ファイルの下を指す（ENOENT 以外の失敗）は missing でなく unreadable', () => {
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x')
    expect(readTextInsideDirFs(dir, 'file.txt/sub', 100)).toEqual({ state: 'unreadable' })
  })
  it('中のリンクが外のファイルを指すと unreadable', () => {
    fs.symlinkSync(outside, path.join(dir, 'link.txt'))
    expect(readTextInsideDirFs(dir, 'link.txt', 100)).toEqual({ state: 'unreadable' })
  })
  it('中のリンクが中のファイルを指すなら読める', () => {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'in')
    fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'))
    expect(readTextInsideDirFs(dir, 'link.txt', 100)).toEqual({ state: 'text', content: 'in' })
  })
  it('dir が文字列でなければ unreadable', () => {
    expect(readTextInsideDirFs(undefined as unknown as string, 'a.txt', 100)).toEqual({ state: 'unreadable' })
    expect(readTextInsideDirFs(5 as unknown as string, 'a.txt', 100)).toEqual({ state: 'unreadable' })
  })
})
