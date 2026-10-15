import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// 保存の主役は fs と一時フォルダ。electron の app はどこからも呼ばれない（保存先は initStageTimingStore で差し替える）。
vi.mock('electron', () => ({ app: { getPath: () => { throw new Error('利用者の保存領域（userData）を読もうとした') }, getVersion: () => '0.0.0-test' }, ipcMain: { handle: () => {} } }))

import { initStageTimingStore, stageTimingFilePath, loadStageTimings, recordStageTimings } from '../src/main/stageTimingStore'
import { STAGE } from '../src/shared/stageTiming'

// ── 段ごとの所要時間の保存（Koto の保存領域の小さな JSON・2026-10-07）────────────────────────────────
// 保存先は app.getPath('userData') の stage-timings.json。**テストでは必ず使い捨ての一時フォルダへ差し替える**
// （利用者の保存領域に触らない。上の electron の偽物は、userData を読んだら落ちる）。
// ・書き込みは一時ファイル → rename ・壊れた JSON・読めないファイルでも落ちない（空として扱い、上書きで直る）
// ・段ごとに最近10件まで ・持つのは { ms, at, version, zone } だけ（秘密・場所は入れない）

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-stagetiming-')); initStageTimingStore(dir) })
afterEach(() => { initStageTimingStore(null); fs.rmSync(dir, { recursive: true, force: true }) })

const entry = (ms: number, day = 1, stage: string = STAGE.teardownLb) => ({
  at: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`, version: '0.6.21', zone: 'is1a' as string | null, stages: [{ stage, ms }],
})

describe('保存先は差し替えられる（利用者の保存領域を使わない）', () => {
  it('★ 保存先は差し替えたフォルダの stage-timings.json。electron の userData は読まない', () => {
    expect(stageTimingFilePath()).toBe(path.join(dir, 'stage-timings.json'))
    expect(recordStageTimings(entry(1000))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'stage-timings.json'))).toBe(true)
  })
})

describe('読む: 無い・壊れている・読めない → 空（落ちない）', () => {
  it('ファイルが無ければ空', () => {
    expect(loadStageTimings()).toEqual({ v: 1, stages: {} })
  })

  it('★ 壊れた JSON でも落ちず空。次に書くと上書きされて直る', () => {
    fs.writeFileSync(stageTimingFilePath(), '{ これは JSON ではない', 'utf-8')
    expect(loadStageTimings()).toEqual({ v: 1, stages: {} })
    expect(recordStageTimings(entry(5000))).toBe(true)
    const fixed = JSON.parse(fs.readFileSync(stageTimingFilePath(), 'utf-8'))
    expect(fixed.stages['teardown.lb']).toHaveLength(1)
    expect(loadStageTimings().stages['teardown.lb'][0].ms).toBe(5000)
  })

  it('JSON だが形が違う（配列・文字列・null）でも落ちず空', () => {
    for (const raw of ['[]', '"x"', 'null', '3', '{"stages":"x"}']) {
      fs.writeFileSync(stageTimingFilePath(), raw, 'utf-8')
      expect(loadStageTimings()).toEqual({ v: 1, stages: {} })
    }
  })

  it('★ 読めないファイル（同じ名前がフォルダ）でも落ちない。読みは空・書きは false（結果を変えない）', () => {
    fs.mkdirSync(stageTimingFilePath())
    expect(loadStageTimings()).toEqual({ v: 1, stages: {} })
    expect(recordStageTimings(entry(1000))).toBe(false)
  })

  it('保存先のフォルダが無くても、書くときに作る', () => {
    initStageTimingStore(path.join(dir, 'a', 'b'))
    expect(recordStageTimings(entry(1000))).toBe(true)
    expect(loadStageTimings().stages['teardown.lb']).toHaveLength(1)
  })
})

describe('書く: 足す・10件まで・一時ファイル → rename', () => {
  it('★ 記録は { ms, at, version, zone } だけ。ほかの項目（場所・ID・名前）は書かれない', () => {
    recordStageTimings(entry(1234, 7))
    const raw = JSON.parse(fs.readFileSync(stageTimingFilePath(), 'utf-8'))
    expect(raw).toEqual({ v: 1, stages: { 'teardown.lb': [{ ms: 1234, at: '2026-10-07T00:00:00.000Z', version: '0.6.21', zone: 'is1a' }] } })
    const text = fs.readFileSync(stageTimingFilePath(), 'utf-8')
    expect(text).not.toMatch(/projectDir|token|secret|\/Users\//)
  })

  it('★ 段ごとに最近10件まで（11件目で古いものから捨てる）。ファイルにもそのまま残る', () => {
    for (let d = 1; d <= 12; d++) recordStageTimings(entry(d * 1000, d))
    const list = JSON.parse(fs.readFileSync(stageTimingFilePath(), 'utf-8')).stages['teardown.lb']
    expect(list.map((x: { ms: number }) => x.ms)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => n * 1000))
  })

  it('複数の段・複数回の記録が、段ごとに積まれる（別の段は混ざらない）', () => {
    recordStageTimings({ ...entry(1000, 1), stages: [{ stage: STAGE.teardownApp, ms: 100 }, { stage: STAGE.teardownLb, ms: 1000 }] })
    recordStageTimings(entry(2000, 2))
    const s = loadStageTimings()
    expect(s.stages['teardown.app'].map(x => x.ms)).toEqual([100])
    expect(s.stages['teardown.lb'].map(x => x.ms)).toEqual([1000, 2000])
  })

  it('★ 一時ファイル → rename: 書いたあとに一時ファイルが残らない。書けなかったときは、いまの記録が壊れない', () => {
    recordStageTimings(entry(1000, 1))
    expect(fs.existsSync(`${stageTimingFilePath()}.tmp`)).toBe(false)
    const before = fs.readFileSync(stageTimingFilePath(), 'utf-8')
    // 一時ファイルの場所をフォルダで塞ぐ → 書き込みは失敗する。元のファイルはそのまま残る
    fs.mkdirSync(`${stageTimingFilePath()}.tmp`)
    expect(recordStageTimings(entry(2000, 2))).toBe(false)
    expect(fs.readFileSync(stageTimingFilePath(), 'utf-8')).toBe(before)
  })

  it('記録に壊れた行が混ざっていても、使える行は残して足す', () => {
    fs.writeFileSync(stageTimingFilePath(), JSON.stringify({ v: 1, stages: { 'teardown.lb': [
      { ms: 1000, at: '2026-10-01T00:00:00.000Z', version: 'v', zone: null }, { ms: 'x' }, null,
    ] } }), 'utf-8')
    recordStageTimings(entry(2000, 2))
    expect(loadStageTimings().stages['teardown.lb'].map(x => x.ms)).toEqual([1000, 2000])
  })
})
