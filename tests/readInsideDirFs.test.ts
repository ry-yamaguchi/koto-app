import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
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

import { readScanFileInsideDirFs } from '../src/main/readInsideDirFs'

describe('readScanFileInsideDirFs', () => {
  it('ふつうに読める（バイト数つき）', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
    expect(readScanFileInsideDirFs(dir, 'a.txt', 100, 10)).toEqual({ state: 'text', content: 'hello', bytes: 5 })
  })
  it('無ければ missing', () => {
    expect(readScanFileInsideDirFs(dir, 'none.txt', 100, 10)).toEqual({ state: 'missing' })
  })
  it('上限ちょうどは読め、1バイト超は too-large', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), '12345')
    expect(readScanFileInsideDirFs(dir, 'a.txt', 5, 10).state).toBe('text')
    expect(readScanFileInsideDirFs(dir, 'a.txt', 4, 10)).toEqual({ state: 'too-large' })
  })
  it('先頭に NUL があれば binary・見る範囲より後ろの NUL は text', () => {
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([97, 0, 98]))
    expect(readScanFileInsideDirFs(dir, 'b.bin', 100, 8)).toEqual({ state: 'binary' })
    fs.writeFileSync(path.join(dir, 'c.txt'), Buffer.from([97, 97, 97, 97, 97, 0, 98]))
    expect(readScanFileInsideDirFs(dir, 'c.txt', 100, 5).state).toBe('text')
    expect(readScanFileInsideDirFs(dir, 'c.txt', 100, 6)).toEqual({ state: 'binary' })
  })
  it('フォルダ・外を指すリンク・絶対パス・../ は unreadable', () => {
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.symlinkSync(outside, path.join(dir, 'link.txt'))
    expect(readScanFileInsideDirFs(dir, 'sub', 100, 10)).toEqual({ state: 'unreadable' })
    expect(readScanFileInsideDirFs(dir, 'link.txt', 100, 10)).toEqual({ state: 'unreadable' })
    expect(readScanFileInsideDirFs(dir, outside, 100, 10)).toEqual({ state: 'unreadable' })
    expect(readScanFileInsideDirFs(dir, '../outside.txt', 100, 10)).toEqual({ state: 'unreadable' })
  })
})

describe('readScanFileInsideDirFs: ふつうのファイル以外', () => {
  it('FIFO は開かずに unreadable を返す（書き手を待って固まらない）', () => {
    const fifo = path.join(dir, 'pipe')
    execFileSync('mkfifo', [fifo])
    const t = Date.now()
    expect(readScanFileInsideDirFs(dir, 'pipe', 1000, 100)).toEqual({ state: 'unreadable' })
    expect(Date.now() - t).toBeLessThan(2000)
  })
  it('フォルダは unreadable を返す', () => {
    fs.mkdirSync(path.join(dir, 'sub'))
    expect(readScanFileInsideDirFs(dir, 'sub', 1000, 100)).toEqual({ state: 'unreadable' })
    expect(readTextInsideDirFs(dir, 'sub', 1000)).toEqual({ state: 'unreadable' })
  })
})
