import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildMainIo } from '../src/main/chat/turnRunner'
import type { ChatEvent } from '../src/shared/chatEvents'

// B'-3d-2b: main の io（buildMainIo・src/main/chat/turnRunner.ts）を実ファイルシステムで
// 直接駆動して確かめる。electron（ipcMain/app/shell）を一切呼ばない経路（applyFile）だけを
// 対象にする——buildMainIo 自体は electron に依存するモジュール（ipc/fs.ts・ipc/shell.ts・
// ipc/web.ts）を import するが、それらは「import されるだけでは electron の実体に触れない」
// （tests/learningWiring.test.ts が turnRunner.ts を import して確かめずみの前提と同じ）。
// applyFile は fs.mkdirSync/writeFileSync という Node 標準の fs しか使わないため、
// electron 非依存のまま実駆動できる（learningStore.ts の「保存先ディレクトリを差し替える」
// 作法と同じ発想で、ここは書き込み先そのものを一時フォルダにする）。

let tmpDirs: string[] = []
function mkTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-toolexec-mainio-'))
  tmpDirs.push(d)
  return d
}

beforeEach(() => {
  tmpDirs = []
})
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

// buildMainIo の第2引数（payload）は applyFile では一切参照されない（ragSearch のときだけ
// payload.spec.apiKey を使う）。ここでは applyFile だけを検証するので、型を満たす最小限の
// ダミーで足りる（vitest はテストファイルを型検査しない＝tsconfig.main.json/tsconfig.json の
// include に tests/ は無い）。
const dummyPayload = { turnId: 't1', spec: { apiKey: '' }, caps: {} } as any

describe('buildMainIo: applyFile（main 直呼びの保存＋aiFileWritten通知）', () => {
  it('cleanAiRelPath 済みの位置（writeRoot 直下）へ実際に書く', async () => {
    const writeRoot = mkTmpDir()
    const emitted: ChatEvent<unknown>[] = []
    const io = buildMainIo({ writeRoot }, dummyPayload, (ev) => { emitted.push(ev) })

    await io.applyFile!('hello.txt', 'こんにちは')

    const full = path.join(writeRoot, 'hello.txt')
    expect(fs.readFileSync(full, 'utf-8')).toBe('こんにちは')
  })

  it('emit に aiFileWritten（rel・実際に書いた full）が乗る', async () => {
    const writeRoot = mkTmpDir()
    const emitted: ChatEvent<unknown>[] = []
    const io = buildMainIo({ writeRoot }, dummyPayload, (ev) => { emitted.push(ev) })

    await io.applyFile!('a.txt', 'hi')

    const full = path.join(writeRoot, 'a.txt')
    expect(emitted).toEqual([{ kind: 'aiFileWritten', rel: 'a.txt', full }])
  })

  it('無いフォルダは mkdir -p 相当で作ってから書く（fs:writeFile ハンドラと同じ書き方）', async () => {
    const writeRoot = mkTmpDir()
    const io = buildMainIo({ writeRoot }, dummyPayload, () => {})

    await io.applyFile!('nested/deep/file.txt', 'content')

    const full = path.join(writeRoot, 'nested', 'deep', 'file.txt')
    expect(fs.existsSync(full)).toBe(true)
    expect(fs.readFileSync(full, 'utf-8')).toBe('content')
  })

  it('rel が "./" で始まっていても cleanAiRelPath が正規化してから書く', async () => {
    const writeRoot = mkTmpDir()
    const emitted: ChatEvent<unknown>[] = []
    const io = buildMainIo({ writeRoot }, dummyPayload, (ev) => { emitted.push(ev) })

    await io.applyFile!('./b.txt', 'x')

    const full = path.join(writeRoot, 'b.txt') // 先頭の './' は落ちる（cleanAiRelPath）
    expect(fs.readFileSync(full, 'utf-8')).toBe('x')
    expect(emitted).toEqual([{ kind: 'aiFileWritten', rel: './b.txt', full }]) // rel は AI が渡した生の値のまま通知される
  })

  it('上書き保存（既存ファイルの内容を差し替える）でも同じ位置へ書き、aiFileWritten が乗る', async () => {
    const writeRoot = mkTmpDir()
    const full = path.join(writeRoot, 'c.txt')
    fs.writeFileSync(full, 'old', 'utf-8')
    const emitted: ChatEvent<unknown>[] = []
    const io = buildMainIo({ writeRoot }, dummyPayload, (ev) => { emitted.push(ev) })

    await io.applyFile!('c.txt', 'new')

    expect(fs.readFileSync(full, 'utf-8')).toBe('new')
    expect(emitted).toEqual([{ kind: 'aiFileWritten', rel: 'c.txt', full }])
  })
})
