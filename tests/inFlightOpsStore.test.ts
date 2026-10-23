import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// 「読まずに空」を確かめるため、readFileSync を呼んだ回数だけ数える（中身は本物の fs のまま）。
const reads = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => { reads.paths.push(String(args[0])); return real.readFileSync(...args) }) as typeof real.readFileSync
  return { ...real, default: { ...real, readFileSync }, readFileSync }
})

// 保存の主役は fs と一時フォルダ。electron の app はどこからも呼ばれない（保存先は initInFlightOpsStore で差し替える）。
vi.mock('electron', () => ({ app: { getPath: () => { throw new Error('利用者の保存領域（userData）を読もうとした') }, getVersion: () => '0.0.0-test' }, ipcMain: { handle: () => {} } }))

import {
  initInFlightOpsStore, inFlightOpsFilePath, loadInFlightOps, writeInFlightOps, IN_FLIGHT_FILE_MAX_BYTES,
} from '../src/main/inFlightOpsStore'
import { emptyInFlightFile, type InFlightFile } from '../src/shared/inFlightOps'

// ── 途中で止まった回の記録（in-flight-ops.json）の読み書き（設計書 10.13.3・10.13.12 の S1〜S6）─────────────────
// 保存先は app.getPath('userData') の in-flight-ops.json。**テストでは必ず使い捨ての一時フォルダへ差し替える**
// （利用者の保存領域に触らない。上の electron の偽物は、userData を読んだら落ちる）。
// ・書き込みは同期の一時ファイル → rename ・書けなければ false（例外を出さない）
// ・壊れている・読めない・1MB を超える → 空として扱い、次に書くと直る

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-inflight-')); initInFlightOpsStore(dir) })
afterEach(() => { initInFlightOpsStore(null); fs.rmSync(dir, { recursive: true, force: true }) })

const T0 = Date.UTC(2026, 9, 12, 3, 0, 0)
const K = '/Users/yamada/Documents/projects/site'
const goodFile = (): InFlightFile => ({
  v: 1,
  running: { [K]: { op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', version: '0.6.22', startedAt: T0, lastSeenAt: T0 + 60_000, segments: [{ stage: 'teardown.lb', startedAt: T0 }] } },
  stopped: {
    '/p/other': {
      op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', noticeSeen: false,
      runs: [{ op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', version: '0.6.22', startedAt: T0 - 600_000, lastSeenAt: T0 - 300_000, segments: [{ stage: 'teardown.app', startedAt: T0 - 600_000, endedAt: T0 - 500_000 }], endedBy: 'quit' }],
    },
  },
})

describe('S1 保存先は差し替えられる（利用者の保存領域を使わない）', () => {
  it('★ 保存先は差し替えたフォルダの in-flight-ops.json。electron の userData は読まない', () => {
    expect(inFlightOpsFilePath()).toBe(path.join(dir, 'in-flight-ops.json'))
    expect(writeInFlightOps(goodFile())).toBe(true)
    expect(fs.existsSync(path.join(dir, 'in-flight-ops.json'))).toBe(true)
  })

  it('差し替えを戻すと本番の userData を見に行く（偽物は読んだら落ちる）。読む・書くは落ちない', () => {
    initInFlightOpsStore(null)
    expect(() => inFlightOpsFilePath()).toThrow('userData')
    expect(loadInFlightOps()).toEqual(emptyInFlightFile())
    expect(writeInFlightOps(goodFile())).toBe(false)
  })

  it('★ 書いたものを読み戻すと同じ（往復）', () => {
    expect(writeInFlightOps(goodFile())).toBe(true)
    expect(loadInFlightOps()).toEqual(goodFile())
  })

  it('保存先のフォルダが無くても、書くときに作る', () => {
    initInFlightOpsStore(path.join(dir, 'a', 'b'))
    expect(writeInFlightOps(goodFile())).toBe(true)
    expect(loadInFlightOps()).toEqual(goodFile())
  })
})

describe('S2 一時ファイル → rename', () => {
  it('★ 書いたあとに一時ファイルが残らない', () => {
    writeInFlightOps(goodFile())
    expect(fs.existsSync(`${inFlightOpsFilePath()}.tmp`)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual(['in-flight-ops.json'])
  })

  it('★ 書けなかったとき（一時ファイルの場所がフォルダ）は false で、いまのファイルが壊れない', () => {
    writeInFlightOps(goodFile())
    const before = fs.readFileSync(inFlightOpsFilePath(), 'utf-8')
    fs.mkdirSync(`${inFlightOpsFilePath()}.tmp`)
    expect(writeInFlightOps({ ...goodFile(), running: {} })).toBe(false)
    expect(fs.readFileSync(inFlightOpsFilePath(), 'utf-8')).toBe(before)
  })

  it('★ 書く前に整える: 決まった形に合わない項目（文・余計なキー）は1つも書かれない', () => {
    const f = goodFile() as any
    f.running[K].label = 'ghp_SECRETTOKEN1234567890 を使っています'
    f.running[K].detail = 'https://user:pass@example.com/x'
    f.running[K].segments[0].message = '文'
    f.extra = { token: 'ghp_SECRETTOKEN1234567890' }
    expect(writeInFlightOps(f)).toBe(true)
    const text = fs.readFileSync(inFlightOpsFilePath(), 'utf-8')
    expect(text).not.toMatch(/SECRETTOKEN|user:pass|使っています|"label"|"detail"|"message"|"extra"/)
    expect(JSON.parse(text)).toEqual(goodFile())
  })
})

describe('S3 壊れた JSON → 空。次に書くと直る', () => {
  it('★ 壊れた JSON でも落ちず空。次に書くと上書きされて直る', () => {
    fs.writeFileSync(inFlightOpsFilePath(), '{ これは JSON ではない', 'utf-8')
    expect(loadInFlightOps()).toEqual(emptyInFlightFile())
    expect(writeInFlightOps(goodFile())).toBe(true)
    expect(loadInFlightOps()).toEqual(goodFile())
  })

  it('JSON だが形が違う（配列・文字列・null・v 違い）でも落ちず空。ファイルが無くても空', () => {
    expect(loadInFlightOps()).toEqual(emptyInFlightFile())
    for (const raw of ['[]', '"x"', 'null', '3', '', '{"v":2,"running":{},"stopped":{}}', '{"running":"x"}']) {
      fs.writeFileSync(inFlightOpsFilePath(), raw, 'utf-8')
      expect(loadInFlightOps(), raw).toEqual(emptyInFlightFile())
    }
  })

  it('壊れた項目が混ざっていても、使える項目は残す', () => {
    const raw = { ...goodFile(), running: { ...goodFile().running, '/p/bad': { op: '壊す' }, 'relative/path': goodFile().running[K] } }
    fs.writeFileSync(inFlightOpsFilePath(), JSON.stringify(raw), 'utf-8')
    expect(Object.keys(loadInFlightOps().running)).toEqual([K])
  })
})

describe('S4 読めない → 空・落ちない', () => {
  it('★ 読めないファイル（同じ名前がフォルダ）でも落ちない。読みは空・書きは false', () => {
    fs.mkdirSync(inFlightOpsFilePath())
    expect(loadInFlightOps()).toEqual(emptyInFlightFile())
    expect(writeInFlightOps(goodFile())).toBe(false)
  })
})

describe('S5 書けない → false・例外を出さない', () => {
  it('★ 保存先の親がファイルのとき: false を返し、例外を出さない', () => {
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'x', 'utf-8')
    initInFlightOpsStore(path.join(blocker, 'sub'))
    expect(() => writeInFlightOps(goodFile())).not.toThrow()
    expect(writeInFlightOps(goodFile())).toBe(false)
    expect(loadInFlightOps()).toEqual(emptyInFlightFile())
  })
})

describe('S6 1MB を超えるファイルは読まずに空として扱う', () => {
  /** 正しい JSON の後ろを空白で埋めて、ちょうど bytes バイトにする。 */
  const writePadded = (bytes: number) => {
    const body = JSON.stringify(goodFile())
    fs.writeFileSync(inFlightOpsFilePath(), body + ' '.repeat(bytes - Buffer.byteLength(body)), 'utf-8')
    expect(fs.statSync(inFlightOpsFilePath()).size).toBe(bytes)
  }

  it('★ 上限は 1MB（1024×1024 バイト）', () => {
    expect(IN_FLIGHT_FILE_MAX_BYTES).toBe(1_048_576)
  })

  it('★ 中身が正しい JSON でも、1MB を1バイト超えたら読まずに空', () => {
    writePadded(IN_FLIGHT_FILE_MAX_BYTES + 1)
    reads.paths.length = 0
    expect(loadInFlightOps()).toEqual(emptyInFlightFile())
    expect(reads.paths.filter(p => p === inFlightOpsFilePath())).toEqual([]) // 大きさを見ただけで、中身は読んでいない
  })

  it('★ ちょうど 1MB までは読む', () => {
    writePadded(IN_FLIGHT_FILE_MAX_BYTES)
    reads.paths.length = 0
    expect(loadInFlightOps()).toEqual(goodFile())
    expect(reads.paths.filter(p => p === inFlightOpsFilePath())).toEqual([inFlightOpsFilePath()]) // 検査が空振りしない: 読んだときは数えられる
  })

  it('大きすぎて空と見なしたあと、書くと上書きされて直る', () => {
    writePadded(IN_FLIGHT_FILE_MAX_BYTES + 1)
    expect(writeInFlightOps(goodFile())).toBe(true)
    expect(fs.statSync(inFlightOpsFilePath()).size).toBeLessThan(IN_FLIGHT_FILE_MAX_BYTES)
    expect(loadInFlightOps()).toEqual(goodFile())
  })

  it('★ 上限どおりの最大の中身（20件×3回×50区間）でも 1MB を超えず、そのまま読み戻せる', () => {
    const seg = (i: number) => ({ stage: 'teardown.lb', startedAt: T0 + i * 1000, endedAt: T0 + i * 1000 + 500 })
    const stoppedRun = (n: number) => ({
      op: '削除' as const, target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown', version: '0.6.22',
      startedAt: T0 + n, lastSeenAt: T0 + 100_000 + n, segments: Array.from({ length: 50 }, (_, i) => seg(i)), endedBy: 'quit' as const,
    })
    const stopped: InFlightFile['stopped'] = {}
    for (let i = 0; i < 20; i++) {
      stopped[`/Users/yamada/Documents/projects/project-${String(i).padStart(2, '0')}`] = {
        op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', noticeSeen: false,
        runs: [stoppedRun(1), stoppedRun(2), stoppedRun(3)],
      }
    }
    const big: InFlightFile = { v: 1, running: {}, stopped }
    expect(writeInFlightOps(big)).toBe(true)
    expect(fs.statSync(inFlightOpsFilePath()).size).toBeLessThan(IN_FLIGHT_FILE_MAX_BYTES)
    expect(loadInFlightOps()).toEqual(big)
  })
})
