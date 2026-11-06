// 権限で断られたとき、読み取りなら「読み込めませんでした」、書き込みなら「書き込めません」と言い分ける。
// readOnly は「もう一度押してよいか」の印でもあるので、文面の操作名（Node の「…, mkdir '<path>'」・npm の「syscall mkdir」）を先に見る。
import { describe, it, expect } from 'vitest'
import { failureText } from '../src/shared/failureText'
import { splitFailureDetail } from '../src/shared/failureDetail'

const READ_TEXT = '読み込めませんでした'
const WRITE_TEXT = 'このフォルダには書き込めません'
const textOf = (e: unknown, opts: Parameters<typeof failureText>[1] = {}): string => splitFailureDetail(failureText(e, opts)).text

describe('権限の失敗の読み書きの言い分け', () => {
  it('一覧を読む（scandir）失敗は、書き込みの場面でも「読み込めませんでした」', () => {
    const e = Object.assign(new Error("EACCES: permission denied, scandir '/Users/me/ws'"), { code: 'EACCES' })
    expect(textOf(e)).toBe(`${READ_TEXT}（/Users/me/ws）。Finder で権限を確かめてください。`)
    expect(textOf(e)).not.toContain('別の場所を選ぶか')
  })

  it('フォルダを作る（mkdir）失敗は、readOnly でも「書き込めません」', () => {
    const e = Object.assign(new Error("EACCES: permission denied, mkdir '/Users/me/dl'"), { code: 'EACCES' })
    expect(textOf(e, { readOnly: true })).toContain(WRITE_TEXT)
    expect(textOf(e, { readOnly: true })).not.toContain(READ_TEXT)
  })

  it('名前の変更（rename）は書き込み', () => {
    const e = Object.assign(new Error("EACCES: permission denied, rename '/Users/me/a' -> '/Users/me/b'"), { code: 'EACCES' })
    expect(textOf(e, { readOnly: true })).toContain(WRITE_TEXT)
  })

  it('open は読み書きどちらでも出るので readOnly に従う', () => {
    const e = Object.assign(new Error("EACCES: permission denied, open '/Users/me/app/env.json'"), { code: 'EACCES' })
    expect(textOf(e, { readOnly: true })).toContain(READ_TEXT)
    expect(textOf(e)).toContain(WRITE_TEXT)
  })

  it('npm の「syscall mkdir」は書き込み・「syscall scandir」は読み取り', () => {
    const mk = 'npm error code EACCES\nnpm error syscall mkdir\nnpm error path /Users/me/app/node_modules\nnpm error EACCES: permission denied'
    const sc = 'npm error code EACCES\nnpm error syscall scandir\nnpm error path /Users/me/app\nnpm error EACCES: permission denied'
    expect(textOf(mk, { readOnly: true })).toContain(WRITE_TEXT)
    expect(textOf(sc)).toContain(READ_TEXT)
  })

  it('操作名が無い権限の失敗は、今までどおり readOnly で決める（既定は書き込み）', () => {
    const e = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    expect(textOf(e)).toContain(WRITE_TEXT)
    expect(textOf(e, { readOnly: true })).toContain(READ_TEXT)
  })

  it('詳細の行には原文が残る', () => {
    const e = Object.assign(new Error("EACCES: permission denied, scandir '/Users/me/ws'"), { code: 'EACCES' })
    expect(splitFailureDetail(failureText(e)).detail).toContain('EACCES')
  })
})
