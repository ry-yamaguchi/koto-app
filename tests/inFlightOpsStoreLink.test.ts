import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// 保存の主役は fs と一時フォルダ。electron の app はどこからも呼ばれない（保存先は initInFlightOpsStore で差し替える）。
vi.mock('electron', () => ({ app: { getPath: () => { throw new Error('利用者の保存領域（userData）を読もうとした') }, getVersion: () => '0.0.0-test' }, ipcMain: { handle: () => {} } }))

import {
  initInFlightOpsStore, inFlightOpsFilePath, loadInFlightOps, writeInFlightOps,
} from '../src/main/inFlightOpsStore'
import { setInFlightSink, flushInFlightOps, progressReporter, runningOpName, resetProjectOpsForTests } from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import { emptyInFlightFile, type InFlightFile } from '../src/shared/inFlightOps'

// ── projectOps の口に本物の保存部品（inFlightOpsStore）をつなぐ（設計書 10.13.4）────────────────────────────────────
// 偽の口（tests/inFlightOpsRecord.test.ts）では見えない、ファイルに実際に載るものを、使い捨ての一時フォルダで見る。
// 利用者の保存領域には触らない（上の electron の偽物は、userData を読んだら落ちる）。

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-inflight-link-')); initInFlightOpsStore(dir); resetProjectOpsForTests() })
afterEach(() => { resetProjectOpsForTests(); initInFlightOpsStore(null); fs.rmSync(dir, { recursive: true, force: true }) })

const T0 = Date.UTC(2026, 9, 12, 3, 0, 0)
const K = '/Users/yamada/Documents/projects/site'
/** 前の Koto が残した、走っている印つきのファイル。 */
const leftover = (): InFlightFile => ({
  v: 1,
  running: { [K]: { op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', version: '0.6.22', startedAt: T0, lastSeenAt: T0 + 60_000, segments: [{ stage: 'teardown.lb', startedAt: T0 }] } },
  stopped: {},
})

describe('projectOps の口に writeInFlightOps をつなぐ', () => {
  const P = '/p/inflight-real'
  const META = { target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown' }
  const gate = () => { let open!: () => void; const closed = new Promise<void>(r => { open = r }); return { open, wait: async () => { await closed; return { ok: true } } } }

  it('★ 走っている間は running がファイルに載り（段の時刻だけ）、終われば消える。ファイルは数KBで、文を含まない', async () => {
    setInFlightSink(writeInFlightOps, { version: '0.6.22' })
    const g = gate()
    const p = withProjectLock(P, '削除', g.wait, { ...META, secrets: ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'] })
    expect(Object.keys(loadInFlightOps().running)).toEqual([P])
    progressReporter(P)('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 でロードバランサを待っています', { stage: 'teardown.lb' })
    const during = loadInFlightOps().running[P]
    expect(during).toMatchObject({ op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', version: '0.6.22' })
    expect(during.segments).toHaveLength(1)
    expect(during.segments[0]).toMatchObject({ stage: 'teardown.lb' })
    const text = fs.readFileSync(inFlightOpsFilePath(), 'utf-8')
    expect(text.length).toBeLessThan(4096)
    expect(text).not.toMatch(/ghp_|ロードバランサ|待っています/)
    g.open(); await p
    expect(loadInFlightOps()).toEqual(emptyInFlightFile())
    expect(fs.existsSync(`${inFlightOpsFilePath()}.tmp`)).toBe(false)
  })

  it('★ 保存先が書けなくても操作は止まらず結果も変わらない。直ったあとの flush（終了の直前）で、終わった回が消える', async () => {
    writeInFlightOps(leftover())
    const before = fs.readFileSync(inFlightOpsFilePath(), 'utf-8')
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'x', 'utf-8')
    initInFlightOpsStore(path.join(blocker, 'sub'))
    setInFlightSink(writeInFlightOps)
    const r = await withProjectLock(P, '削除', async () => ({ ok: true, message: '消しました' }), META)
    expect(r).toMatchObject({ busy: false, value: { ok: true, message: '消しました' } })
    expect(runningOpName(P)).toBeUndefined()
    // 保存先が直る → 終了の直前に書き切る
    initInFlightOpsStore(dir)
    expect(fs.readFileSync(inFlightOpsFilePath(), 'utf-8')).toBe(before)
    flushInFlightOps(Date.now())
    expect(loadInFlightOps().running).toEqual({})
  })
})
