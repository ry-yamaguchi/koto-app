import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// 保存先は initInFlightOpsStore で一時フォルダに差し替える。electron の app は、userData を読んだら落ちる偽物（利用者の保存領域に触れない）。
vi.mock('electron', () => ({ app: { getPath: () => { throw new Error('利用者の保存領域（userData）を読もうとした') }, getVersion: () => '0.0.0-test' }, ipcMain: { handle: () => {} } }))

import { armInFlightOps, inFlightHasWork, type ArmInFlightDeps } from '../src/main/inFlightOpsArm'
import { initInFlightOpsStore, inFlightOpsFilePath, loadInFlightOps, IN_FLIGHT_FILE_MAX_BYTES } from '../src/main/inFlightOpsStore'
import { isInFlightSinkConnected } from '../src/main/inFlightOutlet'
import { getOps, ackOps, progressReporter, resetProjectOpsForTests } from '../src/main/projectOps'
import * as projectOps from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import { emptyInFlightFile, type InFlightFile } from '../src/shared/inFlightOps'

// ── 起動の読み戻し armInFlightOps（設計書 10.13.5・10.13.12 の A1〜A4）─────────────────────────────────────
// 一時フォルダに本物の保存の部品（inFlightOpsStore）を差し、前の Koto が残したファイルを読み戻す。`exists`・`hasWork`・`onWillQuit` は偽物。
// 何があっても投げず、失敗したら口をつながない（この起動では時間の持ち越しが効かないだけ）。

let dir = ''
let quitHandlers: (() => void)[] = []
const NOW = Date.UTC(2026, 9, 12, 4, 0, 0)
const SEC = 1000
const K = '/Users/yamada/Documents/projects/site'
const DED = { target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown' }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-inflight-arm-'))
  initInFlightOpsStore(dir)
  resetProjectOpsForTests()
  quitHandlers = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetProjectOpsForTests()
  initInFlightOpsStore(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

const deps = (over: Partial<ArmInFlightDeps> = {}): ArmInFlightDeps => ({
  version: '0.6.22', exists: () => true, hasWork: () => true, onWillQuit: fn => { quitHandlers.push(fn) }, now: () => NOW, ...over,
})

const runningFile = (): InFlightFile => ({
  v: 1,
  running: { [K]: { op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', version: '0.6.21', startedAt: NOW - 600 * SEC, lastSeenAt: NOW - 300 * SEC, segments: [{ stage: 'teardown.lb', startedAt: NOW - 600 * SEC }] } },
  stopped: {},
})
const writeRaw = (text: string): void => fs.writeFileSync(inFlightOpsFilePath(), text, 'utf-8')
const readDisk = (): InFlightFile => JSON.parse(fs.readFileSync(inFlightOpsFilePath(), 'utf-8')) as InFlightFile

describe('A0 前の Koto が残した「走っている」は、止まった回になる（読み戻しの全体）', () => {
  it('★ 走っていた削除が stopped へ移り（running は空）、知らせが出て、口がつながり、will-quit を1つ登録する', () => {
    writeRaw(JSON.stringify(runningFile()))
    expect(armInFlightOps(deps())).toBe(true)
    expect(isInFlightSinkConnected()).toBe(true)
    expect(quitHandlers).toHaveLength(1)
    const disk = readDisk()
    expect(disk.running).toEqual({})
    expect(disk.stopped[K].runs.map(r => r.endedBy)).toEqual(['quit'])
    expect(disk.stopped[K].noticeSeen).toBe(false)
    const last = getOps(K).last!
    expect(last.result).toMatchObject({ ok: false, message: 'もう一度削除を押すと、続きから進みます。', extra: { stoppedByQuit: true } })
    expect(last.finishedAt).toBe(NOW - 300 * SEC)
    expect(getOps('/Users/yamada/Documents/projects/other')).toEqual({ running: null, last: null, earlier: [] }) // 別のプロジェクトには出ない
  })

  it('★ 見たと伝えると、ファイルに見た印が書かれ（本物の保存の部品を通る）、もう一度読み戻しても出ない', () => {
    writeRaw(JSON.stringify(runningFile()))
    armInFlightOps(deps())
    ackOps(K, getOps(K).last!.startedAt)
    expect(readDisk().stopped[K].noticeSeen).toBe(true)
    resetProjectOpsForTests() // 開き直し
    armInFlightOps(deps({ now: () => NOW + 600 * SEC }))
    expect(getOps(K).last).toBeNull()
    expect(readDisk().stopped[K].runs).toHaveLength(1) // 時間は残る
  })

  it('★ 読み戻しのあとに走った操作が、同じファイルへ書かれる（口がつながっている）。終わると running から消える', async () => {
    armInFlightOps(deps())
    const g: { open: () => void } = { open: () => {} }
    const closed = new Promise<void>(r => { g.open = r })
    const p = withProjectLock(K, '削除', async () => { await closed; return { ok: true } }, DED)
    progressReporter(K)('LB', { stage: 'teardown.lb' })
    expect(readDisk().running[K]).toMatchObject({ op: '削除', version: '0.6.22', segments: [{ stage: 'teardown.lb' }] })
    g.open(); await p
    expect(readDisk().running).toEqual({})
  })

  it('★ will-quit で登録した関数を呼ぶと、走っているものの「最後に分かった時刻」がその時刻になる', async () => {
    armInFlightOps(deps())
    const closed = new Promise<void>(() => {})
    void withProjectLock(K, '削除', async () => { await closed; return { ok: true } }, DED)
    progressReporter(K)('LB', { stage: 'teardown.lb' })
    vi.setSystemTime(NOW + 90 * SEC)
    quitHandlers[0]()
    expect(readDisk().running[K].lastSeenAt).toBe(NOW + 90 * SEC)
  })

  it('will-quit の関数は、書き切りが投げても投げない（終了を止めない）', () => {
    armInFlightOps(deps())
    vi.spyOn(projectOps, 'flushInFlightOps').mockImplementation(() => { throw new Error('boom') })
    expect(() => quitHandlers[0]()).not.toThrow()
  })
})

describe('A1 壊れた中身・空のファイル・1MB超 → 投げない。口がつながる（空から始まる）', () => {
  const BAD: [string, () => void][] = [
    ['壊れた JSON', () => writeRaw('{"v":1,"running":{')],
    ['空のファイル', () => writeRaw('')],
    ['形が違う', () => writeRaw(JSON.stringify({ v: 2, running: 5, stopped: 'x' }))],
    ['1MB を超える（中身は正しい JSON）', () => writeRaw(JSON.stringify({ ...runningFile(), pad: 'x'.repeat(IN_FLIGHT_FILE_MAX_BYTES) }))],
    ['ファイルの場所がフォルダ', () => fs.mkdirSync(inFlightOpsFilePath())],
  ]
  it.each(BAD)('★ %s', async (_name, make) => {
    make()
    expect(armInFlightOps(deps())).toBe(true)
    expect(isInFlightSinkConnected()).toBe(true)
    expect(getOps(K)).toEqual({ running: null, last: null, earlier: [] })
    // 口は生きている: 操作が走ればファイルへ書かれる（場所がフォルダだった場合は書けないが、落ちない）
    await withProjectLock(K, '削除', async () => ({ ok: true }), DED)
    if (fs.statSync(inFlightOpsFilePath()).isFile()) expect(loadInFlightOps()).toEqual(emptyInFlightFile())
  })

  it('★ 壊れたファイルは、読み戻しの書き戻しで正しい形に直る', () => {
    writeRaw('{"v":1,"running":{')
    armInFlightOps(deps())
    expect(readDisk()).toEqual(emptyInFlightFile())
  })

  it('保存先が書けない（親がファイル）: 投げない・口はつながる。操作の結果も変わらない', async () => {
    fs.writeFileSync(path.join(dir, 'blocker'), 'x')
    initInFlightOpsStore(path.join(dir, 'blocker', 'sub'))
    expect(armInFlightOps(deps())).toBe(true)
    expect(isInFlightSinkConnected()).toBe(true)
    const r = await withProjectLock(K, '削除', async () => ({ ok: true, message: '消しました' }), DED)
    expect(r.busy).toBe(false)
    expect(getOps(K).last!.result).toMatchObject({ ok: true, message: '消しました' })
  })
})

describe('A2 exists が投げる → 投げない。その項目は残る', () => {
  it('★ フォルダの確かめが投げても、読み戻しは進み、項目は残す側に倒す（知らせが出る）', () => {
    writeRaw(JSON.stringify(runningFile()))
    expect(armInFlightOps(deps({ exists: () => { throw new Error('ネットワークドライブが外れている') } }))).toBe(true)
    expect(Object.keys(readDisk().stopped)).toEqual([K])
    expect(getOps(K).last).not.toBeNull()
  })

  it('★ フォルダが無ければ（exists が false）捨てる。知らせも出ない', () => {
    writeRaw(JSON.stringify(runningFile()))
    armInFlightOps(deps({ exists: () => false }))
    expect(readDisk().stopped).toEqual({})
    expect(getOps(K).last).toBeNull()
  })
})

describe('A3 hasWork が投げる → 投げない。その項目は残る', () => {
  it('★ 続けるものの確かめが投げても、項目は残る', () => {
    writeRaw(JSON.stringify(runningFile()))
    expect(armInFlightOps(deps({ hasWork: () => { throw new Error('読めない') } }))).toBe(true)
    expect(Object.keys(readDisk().stopped)).toEqual([K])
    expect(getOps(K).last).not.toBeNull()
  })

  it('★ 続けるものが無ければ（hasWork が false）捨てる。公開先を渡して確かめる', () => {
    writeRaw(JSON.stringify(runningFile()))
    const hasWork = vi.fn(() => false)
    armInFlightOps(deps({ hasWork }))
    expect(hasWork).toHaveBeenCalledWith(K, 'sakura-apprun-dedicated')
    expect(readDisk().stopped).toEqual({})
    expect(getOps(K).last).toBeNull()
  })
})

describe('A4 projectOps への受け渡し（adoptStoppedOps）が投げる → 投げない。口はつながない', () => {
  it('★ 投げたら false を返し、口はつながず、will-quit も登録しない。以後ファイルは書かれない', async () => {
    writeRaw(JSON.stringify(runningFile()))
    vi.spyOn(projectOps, 'adoptStoppedOps').mockImplementation(() => { throw new Error('受け渡しに失敗') })
    expect(armInFlightOps(deps())).toBe(false)
    expect(projectOps.adoptStoppedOps).toHaveBeenCalled() // 空振りしない
    expect(isInFlightSinkConnected()).toBe(false)
    expect(quitHandlers).toHaveLength(0)
    const before = fs.readFileSync(inFlightOpsFilePath(), 'utf-8')
    await withProjectLock(K, '削除', async () => ({ ok: true }), DED)
    expect(fs.readFileSync(inFlightOpsFilePath(), 'utf-8')).toBe(before) // 書かない
  })

  it('will-quit の登録が投げても、投げない。口はつながない', () => {
    expect(armInFlightOps(deps({ onWillQuit: () => { throw new Error('登録できない') } }))).toBe(false)
    expect(isInFlightSinkConnected()).toBe(false)
  })
})

describe('A5 続けるものがあるかの本物（inFlightHasWork）', () => {
  const project = (meta: unknown | null): string => {
    const p = fs.mkdtempSync(path.join(dir, 'proj-'))
    if (meta !== null) fs.writeFileSync(path.join(p, '.sakuraide.json'), typeof meta === 'string' ? meta : JSON.stringify(meta))
    return p
  }

  it('★ 専有型: 資源の ID か、保存場所だけが残った印があれば true。記録が空・無い・壊れていれば false', () => {
    expect(inFlightHasWork(project({ publish: { apprunDedicated: { loadBalancerID: 'lb-1' } } }), 'sakura-apprun-dedicated')).toBe(true)
    expect(inFlightHasWork(project({ publish: { apprunDedicated: { applicationID: 'app-1' } } }), 'sakura-apprun-dedicated')).toBe(true)
    expect(inFlightHasWork(project({ publish: { apprunDedicated: { storageLeftoverBucket: 'b' } } }), 'sakura-apprun-dedicated')).toBe(true)
    expect(inFlightHasWork(project({ publish: { apprunDedicated: {} } }), 'sakura-apprun-dedicated')).toBe(false)
    expect(inFlightHasWork(project({}), 'sakura-apprun-dedicated')).toBe(false)
    expect(inFlightHasWork(project(null), 'sakura-apprun-dedicated')).toBe(false)
    expect(inFlightHasWork(project('{壊れている'), 'sakura-apprun-dedicated')).toBe(false)
  })

  it('★ 専有型の公開の記録（📡 の行）だけがあっても、資源の記録が空なら false（消すものが無い）', () => {
    expect(inFlightHasWork(project({ publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: '2026-10-10' } } } }), 'sakura-apprun-dedicated')).toBe(false)
  })

  it('★ 共用型・HANAMII・Vercel・レンタル: 公開の記録の行があれば true（日時が空でも）。無ければ false', () => {
    for (const t of ['sakura-apprun', 'hanamii', 'vercel', 'sakura-rental'] as const) {
      expect(inFlightHasWork(project({ publish: { targets: { [t]: { publishedAt: '2026-10-10' } } } }), t)).toBe(true)
      expect(inFlightHasWork(project({ publish: { targets: { [t]: {} } } }), t)).toBe(true)
      expect(inFlightHasWork(project({ publish: { targets: {} } }), t)).toBe(false)
      expect(inFlightHasWork(project(null), t)).toBe(false)
    }
    // 別の公開先の行では true にならない
    expect(inFlightHasWork(project({ publish: { targets: { hanamii: { publishedAt: 'x' } } } }), 'sakura-apprun')).toBe(false)
  })

  it('公開先が分からない（unknown）は false', () => {
    expect(inFlightHasWork(project({ publish: { targets: { hanamii: {} } } }), 'unknown')).toBe(false)
  })
})
