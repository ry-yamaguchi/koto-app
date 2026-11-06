import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyReadFailure, readDiskFs, readCheckFs, writeFileIfUnchangedFs } from '../src/main/writeIfUnchangedFs'

// ── 「変わっていなければ書く」口（main/writeIfUnchangedFs.ts）。本物の一時フォルダで、書く前後のディスクを比べる ──
// 歯止めは main にある。画面が読み直して比べるのではなく、main が読んでから書くまでを1つの処理で続ける。
// 見るもの: 返り値の理由と、ディスクの前後（書いていないのに中身が変わっていないか・無いのに作られていないか）。

const m = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { m.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  dialog: {},
  shell: { trashItem: async () => {} },
}))
import { registerFsHandlers } from '../src/main/ipc/fs'

let dir = ''
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-wiu-')))
})
afterEach(() => {
  try { fs.chmodSync(path.join(dir, 'a.txt'), 0o644) } catch { /* 無い */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

const at = (...rel: string[]) => path.join(dir, ...rel)
function put(rel: string, content: string): string {
  const full = at(rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}
const read = (p: string) => fs.readFileSync(p, 'utf-8')
// root は権限を無視して読めるので、権限を外した読めないファイルの行は飛ばす
const canTestPermissions = typeof process.getuid === 'function' && process.getuid() !== 0

describe('classifyReadFailure: 無い（ENOENT）だけが missing。ほかはすべて unreadable', () => {
  const code = (c: string) => Object.assign(new Error('x'), { code: c })
  it('エラーコードの表', () => {
    expect(classifyReadFailure(code('ENOENT'))).toBe('missing')
    for (const c of ['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EIO', 'EMFILE', 'ELOOP', 'ENAMETOOLONG']) {
      expect(classifyReadFailure(code(c)), c).toBe('unreadable')
    }
  })
  it('★ コードの無い例外・形の違うものは、書かない側（unreadable）に倒す', () => {
    expect(classifyReadFailure(new Error('x'))).toBe('unreadable')
    expect(classifyReadFailure(null)).toBe('unreadable')
    expect(classifyReadFailure(undefined)).toBe('unreadable')
    expect(classifyReadFailure('ENOENT')).toBe('unreadable')
    expect(classifyReadFailure({})).toBe('unreadable')
  })
  it('★ 例外の文面は読まない: 文に ENOENT と書いてあってもコードが違えば unreadable、コードが ENOENT なら文が何でも missing', () => {
    expect(classifyReadFailure(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'EACCES' }))).toBe('unreadable')
    expect(classifyReadFailure(Object.assign(new Error('権限がありません'), { code: 'ENOENT' }))).toBe('missing')
  })
})

describe('readDiskFs: 読んだ結果の分類（本物のファイル）', () => {
  it('読める・無い・フォルダ', () => {
    const f = put('a.txt', 'こんにちは')
    expect(readDiskFs(f)).toEqual({ kind: 'text', text: 'こんにちは' })
    expect(readDiskFs(at('none.txt'))).toEqual({ kind: 'missing' })
    fs.mkdirSync(at('d'))
    expect(readDiskFs(at('d'))).toEqual({ kind: 'unreadable' })
  })
  it('★ 親がファイル（ENOTDIR）は missing ではなく unreadable', () => {
    put('a.txt', 'x')
    expect(readDiskFs(at('a.txt', 'child.txt'))).toEqual({ kind: 'unreadable' })
  })
  it.skipIf(!canTestPermissions)('権限を外したファイルは unreadable', () => {
    const f = put('a.txt', 'x')
    fs.chmodSync(f, 0o000)
    expect(readDiskFs(f)).toEqual({ kind: 'unreadable' })
  })
  it('空のファイルは「無い」ではなく空の文字列', () => {
    const f = put('a.txt', '')
    expect(readDiskFs(f)).toEqual({ kind: 'text', text: '' })
  })
})

describe('writeFileIfUnchangedFs: 基準（expected）が文字列の回', () => {
  it('★★★ ディスクが基準と同じなら書く', () => {
    const f = put('a.txt', 'old')
    expect(writeFileIfUnchangedFs(f, 'new', 'old')).toEqual({ ok: true })
    expect(read(f)).toBe('new')
  })

  it('★★★ 外で変わっていたら書かず changed（今のディスクの中身を返す）。ディスクは外の版のまま', () => {
    const f = put('a.txt', 'old')
    fs.writeFileSync(f, '外で書き換えた') // 端末・ほかのエディタ・git の変更
    expect(writeFileIfUnchangedFs(f, 'new', 'old')).toEqual({ ok: false, reason: 'changed', disk: '外で書き換えた' })
    expect(read(f)).toBe('外で書き換えた')
  })

  it('★★★ 外で変わっていたら、同じ呼び出しを繰り返しても書かない（呼ぶたびに確かめる）', () => {
    const f = put('a.txt', 'old')
    fs.writeFileSync(f, 'X')
    for (let i = 0; i < 3; i++) expect(writeFileIfUnchangedFs(f, 'new', 'old').ok).toBe(false)
    expect(read(f)).toBe('X')
  })

  it('★★★ 消えていたら書かず missing。ファイルは作られない（親フォルダも）', () => {
    const f = put('sub/a.txt', 'old')
    fs.rmSync(f)
    expect(writeFileIfUnchangedFs(f, 'new', 'old')).toEqual({ ok: false, reason: 'missing' })
    expect(fs.existsSync(f)).toBe(false)
    fs.rmSync(at('sub'), { recursive: true })
    expect(writeFileIfUnchangedFs(f, 'new', 'old')).toEqual({ ok: false, reason: 'missing' })
    expect(fs.existsSync(at('sub'))).toBe(false)
  })

  it.skipIf(!canTestPermissions)('★★★ 読めない（権限を外したファイル）なら書かず unreadable。missing とは言わない', () => {
    const f = put('a.txt', 'old')
    fs.chmodSync(f, 0o000)
    expect(writeFileIfUnchangedFs(f, 'new', 'old')).toEqual({ ok: false, reason: 'unreadable' })
    fs.chmodSync(f, 0o644)
    expect(read(f)).toBe('old')
  })

  it('★★★ 読めない（ファイルの場所がフォルダ）なら書かず unreadable', () => {
    fs.mkdirSync(at('d'))
    expect(writeFileIfUnchangedFs(at('d'), 'new', 'old')).toEqual({ ok: false, reason: 'unreadable' })
    expect(fs.statSync(at('d')).isDirectory()).toBe(true)
  })

  it('ディスクがすでに書きたい中身と同じ（基準とは違う）なら、書かずに ok。ディスクはそのまま', () => {
    const f = put('a.txt', 'same')
    const before = fs.statSync(f).mtimeMs
    expect(writeFileIfUnchangedFs(f, 'same', 'old')).toEqual({ ok: true })
    expect(read(f)).toBe('same')
    expect(fs.statSync(f).mtimeMs).toBe(before) // 書き直していない
  })

  it('空文字の基準: 空のファイルなら書く。中身があれば changed（空文字は null ではない）', () => {
    const empty = put('a.txt', '')
    expect(writeFileIfUnchangedFs(empty, 'new', '')).toEqual({ ok: true })
    expect(read(empty)).toBe('new')
    const full = put('b.txt', '外の版')
    expect(writeFileIfUnchangedFs(full, 'new', '')).toEqual({ ok: false, reason: 'changed', disk: '外の版' })
    expect(read(full)).toBe('外の版')
  })

  it('日本語・改行コード・BOM もそのまま比べる（読み書きで中身が変わらない）', () => {
    const body = '﻿日本語\r\nの行\n'
    const f = put('a.txt', body)
    expect(writeFileIfUnchangedFs(f, body + '追記', body)).toEqual({ ok: true })
    expect(read(f)).toBe(body + '追記')
    // 改行だけが違う版は、同じとは見ない
    expect(writeFileIfUnchangedFs(f, 'x', body.replace('\r\n', '\n') + '追記').ok).toBe(false)
    expect(read(f)).toBe(body + '追記')
  })

  it('書いたあとの基準で続けて保存できる（書く → 書く）', () => {
    const f = put('a.txt', 'v1')
    expect(writeFileIfUnchangedFs(f, 'v2', 'v1').ok).toBe(true)
    expect(writeFileIfUnchangedFs(f, 'v3', 'v2').ok).toBe(true)
    expect(writeFileIfUnchangedFs(f, 'v4', 'v1').ok).toBe(false) // 古い基準では書けない
    expect(read(f)).toBe('v3')
  })
})

describe('writeFileIfUnchangedFs: expected が null（無いときだけ作る）', () => {
  it('★★★ 無ければ作る', () => {
    const f = at('a.txt')
    expect(writeFileIfUnchangedFs(f, '作り直した中身', null)).toEqual({ ok: true })
    expect(read(f)).toBe('作り直した中身')
  })

  it('無くて、親フォルダも無いときは、親フォルダも掘って作る', () => {
    const f = at('x', 'y', 'a.txt')
    expect(writeFileIfUnchangedFs(f, 'v', null)).toEqual({ ok: true })
    expect(read(f)).toBe('v')
  })

  it('★★★ あれば書かず changed（その間に外で作られた）。ディスクは外の版のまま', () => {
    const f = put('a.txt', '外で作られた')
    expect(writeFileIfUnchangedFs(f, '自分の中身', null)).toEqual({ ok: false, reason: 'changed', disk: '外で作られた' })
    expect(read(f)).toBe('外で作られた')
  })

  it('★★★ 空のファイルがあっても「ある」。書かず changed', () => {
    const f = put('a.txt', '')
    expect(writeFileIfUnchangedFs(f, '自分の中身', null)).toEqual({ ok: false, reason: 'changed', disk: '' })
    expect(read(f)).toBe('')
  })

  it('★★★ あるファイルが書きたい中身と同じでも、無いときだけ作る形では ok にしない（書かず changed）', () => {
    const f = put('a.txt', 'same')
    expect(writeFileIfUnchangedFs(f, 'same', null)).toEqual({ ok: false, reason: 'changed', disk: 'same' })
  })

  it.skipIf(!canTestPermissions)('★★★ あるが読めない（権限）なら書かず unreadable。無いものとして作らない', () => {
    const f = put('a.txt', '読めない中身')
    fs.chmodSync(f, 0o000)
    expect(writeFileIfUnchangedFs(f, '自分の中身', null)).toEqual({ ok: false, reason: 'unreadable' })
    fs.chmodSync(f, 0o644)
    expect(read(f)).toBe('読めない中身')
  })

  it('★★★ 場所がフォルダなら書かず unreadable', () => {
    fs.mkdirSync(at('d'))
    expect(writeFileIfUnchangedFs(at('d'), 'v', null)).toEqual({ ok: false, reason: 'unreadable' })
    expect(fs.readdirSync(at('d'))).toEqual([])
  })
})

describe('writeFileIfUnchangedFs: 指定が正しくない回は、書かずに投げる（不明な値を「同じ」「無いとき」と読まない）', () => {
  const bad: [string, () => unknown][] = [
    ['expected が undefined（無いファイル）', () => writeFileIfUnchangedFs(at('none.txt'), 'v', undefined as any)],
    ['expected が undefined（あるファイル）', () => writeFileIfUnchangedFs(put('a.txt', 'old'), 'v', undefined as any)],
    ['expected が数値', () => writeFileIfUnchangedFs(put('b.txt', 'old'), 'v', 0 as any)],
    ['expected が false', () => writeFileIfUnchangedFs(at('none2.txt'), 'v', false as any)],
    ['content が文字列でない', () => writeFileIfUnchangedFs(put('c.txt', 'old'), undefined as any, 'old')],
    ['パスが空', () => writeFileIfUnchangedFs('', 'v', null)],
    ['パスが文字列でない', () => writeFileIfUnchangedFs(undefined as any, 'v', null)],
  ]
  for (const [name, run] of bad) {
    it(`★★★ ${name} → 投げる`, () => {
      expect(run).toThrow('保存の指定が正しくないため、書いていません。')
    })
  }
  it('★★★ 投げた回は、ディスクを1つも動かさない', () => {
    const before = fs.readdirSync(dir).sort()
    expect(() => writeFileIfUnchangedFs(at('none.txt'), 'v', undefined as any)).toThrow()
    expect(fs.readdirSync(dir).sort()).toEqual(before)
    const f = put('a.txt', 'old')
    expect(() => writeFileIfUnchangedFs(f, 'v', undefined as any)).toThrow()
    expect(read(f)).toBe('old')
  })
})

describe('readCheckFs: 読めるかを聞く。分類は保存の口と同じ（ファイルが無い ENOENT だけが missing）', () => {
  it('読めるファイル・空のファイルは readable', () => {
    expect(readCheckFs(put('a.txt', 'x'))).toBe('readable')
    expect(readCheckFs(put('empty.txt', ''))).toBe('readable')
  })
  it('★ 無いファイルだけが missing', () => {
    expect(readCheckFs(at('none.txt'))).toBe('missing')
    expect(readCheckFs(at('none-dir', 'a.txt'))).toBe('missing') // 親フォルダごと無い（ENOENT）
  })
  it('★★ 無いのではなく読めないもの（フォルダ・親がファイル）は unreadable。existsSync が false でも「消えた」と言わない', () => {
    fs.mkdirSync(at('d'))
    expect(readCheckFs(at('d'))).toBe('unreadable')
    const parent = put('notdir', 'x')
    const child = path.join(parent, 'a.txt')
    expect(fs.existsSync(child)).toBe(false)
    expect(readCheckFs(child)).toBe('unreadable')
  })
  it('権限を外したファイルは unreadable', () => {
    if (!canTestPermissions) return
    const f = put('a.txt', 'x')
    fs.chmodSync(f, 0o000)
    expect(readCheckFs(f)).toBe('unreadable')
  })
  it('★ 保存の口の答えと必ず揃う（同じ場所について、readCheck が missing/unreadable と言うなら、保存の口も同じ理由で止める）', () => {
    fs.mkdirSync(at('d'))
    const parent = put('notdir', 'x')
    for (const p of [at('none.txt'), at('d'), path.join(parent, 'a.txt')]) {
      const kind = readCheckFs(p)
      expect(kind).not.toBe('readable')
      expect(writeFileIfUnchangedFs(p, 'v', 'old')).toEqual({ ok: false, reason: kind })
    }
  })
})

describe('★★★ 登録の配線: IPC の名前（fs:writeFileIfUnchanged）から呼ぶと、同じ歯止めを通る', () => {
  beforeEach(() => {
    m.handlers.clear()
    registerFsHandlers({} as any)
  })
  const call = async (...args: unknown[]) => m.handlers.get('fs:writeFileIfUnchanged')!({}, ...args)

  it('登録されている', () => {
    expect(m.handlers.has('fs:writeFileIfUnchanged')).toBe(true)
  })

  it('同じなら書く・外で変わっていたら書かず changed・消えていたら missing・あるフォルダは unreadable', async () => {
    const f = put('a.txt', 'old')
    expect(await call(f, 'new', 'old')).toEqual({ ok: true })
    expect(read(f)).toBe('new')
    fs.writeFileSync(f, '外の版')
    expect(await call(f, 'mine', 'new')).toEqual({ ok: false, reason: 'changed', disk: '外の版' })
    expect(read(f)).toBe('外の版')
    fs.rmSync(f)
    expect(await call(f, 'mine', '外の版')).toEqual({ ok: false, reason: 'missing' })
    expect(fs.existsSync(f)).toBe(false)
    fs.mkdirSync(at('d'))
    expect(await call(at('d'), 'mine', 'x')).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('null は「無いときだけ作る」。あれば書かない', async () => {
    const f = at('a.txt')
    expect(await call(f, 'first', null)).toEqual({ ok: true })
    expect(await call(f, 'second', null)).toEqual({ ok: false, reason: 'changed', disk: 'first' })
    expect(read(f)).toBe('first')
  })

  it('fs:readCheck: 読めるかを聞く口が登録され、readCheckFs の答えをそのまま返す（読むだけ）', async () => {
    expect(m.handlers.has('fs:readCheck')).toBe(true)
    const f = put('a.txt', 'x')
    const call = (p: string) => m.handlers.get('fs:readCheck')!({}, p)
    expect(await call(f)).toBe('readable')
    expect(await call(at('none.txt'))).toBe('missing')
    fs.mkdirSync(at('d'))
    expect(await call(at('d'))).toBe('unreadable')
    expect(read(f)).toBe('x')
  })

  it('指定が正しくない回は、IPC の呼び出しが失敗し（書かない）', async () => {
    const f = put('a.txt', 'old')
    await expect(call(f, 'new', undefined)).rejects.toThrow('保存の指定が正しくないため、書いていません。')
    expect(read(f)).toBe('old')
  })
})

describe('掟6: main / preload / 型 の3点が揃っている', () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('main: ハンドラは writeFileIfUnchangedFs を expected ごと呼ぶ1本だけ。直に書く形（fs.writeFileSync・fs.writeFile）を持たない', () => {
    const s = src('src/main/ipc/fs.ts')
    expect(s).toContain(
      "ipcMain.handle('fs:writeFileIfUnchanged', (_, filePath: string, content: string, expected: string | null) =>\n" +
      '    writeFileIfUnchangedFs(filePath, content, expected))'
    )
    expect(s).toContain("import { writeFileIfUnchangedFs, readCheckFs } from '../writeIfUnchangedFs'")
    expect(s.split("'fs:writeFileIfUnchanged'").length - 1).toBe(1)
    // ハンドラの中に、比べない書き方が入り込んでいない
    const handler = s.slice(s.indexOf("ipcMain.handle('fs:writeFileIfUnchanged'"), s.indexOf("ipcMain.handle('fs:readFileInProject'"))
    expect(handler).not.toContain('writeFileSync')
    expect(handler).not.toContain('readFileSync')
  })

  it('main の実体: 比べる表は mayWriteTab の1つ。読んでから書く順', () => {
    const s = src('src/main/writeIfUnchangedFs.ts')
    expect(s).toContain("import { mayWriteTab, type WriteIfUnchangedResult } from '../shared/editorSync'")
    expect(s).toContain('const verdict = mayWriteTab({ baseline: expected, content, disk })')
    expect(s.indexOf('const read = readDiskFs(filePath)')).toBeLessThan(s.indexOf('const verdict = mayWriteTab('))
    expect(s.indexOf('const verdict = mayWriteTab(')).toBeLessThan(s.indexOf("fs.writeFileSync(filePath, content, 'utf-8')"))
    // 例外の文面を読んで分類しない
    expect(s).not.toContain('.message')
  })

  it('preload から invoke され、global.d.ts に型がある', () => {
    const preload = src('src/main/preload.ts')
    expect(preload).toContain(
      "writeFileIfUnchanged: (path: string, content: string, expected: string | null) => ipcRenderer.invoke('fs:writeFileIfUnchanged', path, content, expected),"
    )
    const types = src('src/renderer/global.d.ts')
    expect(types).toContain('writeFileIfUnchanged(path: string, content: string, expected: string | null): Promise<WriteIfUnchangedResultShape>')
    // 読めるかを聞く口（fs:readCheck）の3点
    expect(src('src/main/ipc/fs.ts')).toContain("ipcMain.handle('fs:readCheck', (_, filePath: string) => readCheckFs(filePath))")
    expect(preload).toContain("readCheck: (path: string) => ipcRenderer.invoke('fs:readCheck', path),")
    expect(types).toContain("readCheck(path: string): Promise<'readable' | 'missing' | 'unreadable'>")
    expect(types).toContain("type WriteIfUnchangedResultShape = import('../shared/editorSync').WriteIfUnchangedResult")
  })
})
