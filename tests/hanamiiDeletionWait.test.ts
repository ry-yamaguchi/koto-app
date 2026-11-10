import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { waitForHanamiiDeletion, hanamiiDeletionWaitTuning, type DeletionWaitOutcome } from '../src/main/hanamii/deletionWait'
import { readHanamiiAccepted, readHanamiiDeleteReply } from '../src/main/hanamii/deleteReply'
import { HANAMII_DELETION_WAIT_PROGRESS } from '../src/shared/teardownResult'
import { deleteProjectReplyText, getProjectReplyText, fastHanamiiDeletionWait, ACCEPTED_OPERATION_ID } from './hanamiiTeardownFixtures'
import type { HanamiiResult } from '../src/main/hanamii/client'

// ── このテストが固定すること（設計: GET で待ち、404 を合図に DELETE で確かめる。「消えた」と読むのは readHanamiiDeleteReply の1か所）──
// 純関数 waitForHanamiiDeletion を、偽の時計（本物の sleep で待たない）の上で動かし、出た要求の並びと時刻を見る。
//   ・GET の 404 だけでは「消えた」と読まない（確かめの DELETE が 404／deleted のときだけ）
//   ・GET の 200 は、本文が何であっても「まだある」
//   ・401・403 はすぐ打ち切る（DELETE は0本）／429・5xx・例外は失敗に数える（連続5回で打ち切り・途中の 200 で 0 に戻る）。待っている間の 429 を「削除に失敗」と読まない
//   ・DELETE は最初の1本を含めて、どの300秒の窓でも 11本以下・間隔は20秒以上／GET の間隔は5秒以上
const PID = 'prj_123'
type Item = number | { status: number; text?: string }

let clock: ReturnType<typeof fastHanamiiDeletionWait>
beforeEach(() => { clock = fastHanamiiDeletionWait() })
afterEach(() => { clock.restore() })

/** 台本どおりに答える偽の client（並びを使い切ったら最後の値を繰り返す）。呼んだ時刻も積む。 */
function script(get: Item[], del: Item[]) {
  const log: Array<{ method: 'GET' | 'DELETE'; at: number }> = []
  const n = { GET: 0, DELETE: 0 }
  const answer = (method: 'GET' | 'DELETE', list: Item[]): HanamiiResult => {
    log.push({ method, at: clock.now() })
    const item = list[Math.min(n[method]++, list.length - 1)]
    const status = typeof item === 'number' ? item : item.status
    if (status === 0) throw new Error('fetch failed')
    const text = typeof item === 'object' && item.text !== undefined ? item.text : method === 'DELETE' ? deleteProjectReplyText(status, PID) : getProjectReplyText(status, PID)
    return { ok: status >= 200 && status < 300, status, data: text ? JSON.parse(text) : null }
  }
  return {
    log,
    getProject: async () => answer('GET', get),
    deleteProject: async () => answer('DELETE', del),
    seq: () => log.map(l => l.method),
  }
}
const run = (s: ReturnType<typeof script>, over: { deleteJustSent?: boolean; finalConfirm?: boolean; onProgress?: (l: string, d: string) => void } = {}): Promise<DeletionWaitOutcome> =>
  waitForHanamiiDeletion({ getProject: s.getProject, deleteProject: s.deleteProject, deleteJustSent: over.deleteJustSent ?? false, finalConfirm: over.finalConfirm ?? true, onProgress: over.onProgress })

describe('waitForHanamiiDeletion: 「消えた」の合図', () => {
  it('★★★ GET 200→200→404、確かめの DELETE 404 → gone。並びは [GET×3, DELETE]', async () => {
    const s = script([200, 200, 404], [404])
    expect(await run(s)).toEqual({ kind: 'gone' })
    expect(s.seq()).toEqual(['GET', 'GET', 'GET', 'DELETE'])
  })

  it('★★★ 確かめの DELETE が 200（deleted:true）でも gone', async () => {
    const s = script([404], [200])
    expect(await run(s)).toEqual({ kind: 'gone' })
  })

  it('★★★ GET 404 でも、確かめの DELETE が 202（accepted）なら gone にしない。次の 404 の確かめ（20秒以上あと）で gone', async () => {
    const s = script([404], [202, 404])
    expect(await run(s)).toEqual({ kind: 'gone' })
    const deletes = s.log.filter(l => l.method === 'DELETE')
    expect(deletes).toHaveLength(2)
    expect(deletes[1].at - deletes[0].at, 'DELETE の間隔が20秒未満').toBeGreaterThanOrEqual(hanamiiDeletionWaitTuning.confirmGapMs)
  })

  it('★★ 最初の DELETE を送った直後（deleteJustSent）は、そこから20秒あけてから確かめる（すぐ 404 でも）', async () => {
    const s = script([404], [404])
    expect(await run(s, { deleteJustSent: true })).toEqual({ kind: 'gone' })
    const del = s.log.find(l => l.method === 'DELETE')!
    expect(del.at - s.log[0].at).toBeGreaterThanOrEqual(hanamiiDeletionWaitTuning.confirmGapMs)
    // 続きの回（GET から始める）は、最初の GET の 404 ですぐ確かめる
    const t = script([404], [404])
    await run(t, { deleteJustSent: false })
    expect(t.seq()).toEqual(['GET', 'DELETE'])
  })

  it('★★★ GET 200 の本文が deleted:true に見えても、gone にしない（GET の読みは待つだけ）', async () => {
    const s = script([{ status: 200, text: JSON.stringify({ project: { id: PID, deleted: true, deletion: 'completed' } }) }], [202])
    const r = await run(s)
    expect(r.kind).toBe('timeout')
  })
})

describe('waitForHanamiiDeletion: 上限（約5分）', () => {
  it('★★★ GET 200 が続く → timeout。最後の確かめの DELETE はちょうど1本（上限の直前）で、それが 202 なら timeout のまま', async () => {
    const s = script([200], [202])
    expect(await run(s)).toEqual({ kind: 'timeout' })
    expect(s.log.filter(l => l.method === 'DELETE')).toHaveLength(1)
    expect(s.log[s.log.length - 1].method).toBe('DELETE')
    // 待ちは約5分で終わる（本物の sleep は呼んでいない）
    const total = clock.sleeps.reduce((a, b) => a + b, 0)
    // 上限は「約5分」。既定の値そのものを固定する（調整の値を読むと、上限を延ばしても気づけない）
    expect(hanamiiDeletionWaitTuning).toMatchObject({ pollMs: 5000, confirmGapMs: 20000, maxWaitMs: 300000, maxConfirms: 10, maxFailures: 5 })
    expect(total).toBeLessThanOrEqual(320_000)
    expect(total).toBeGreaterThanOrEqual(285_000)
  })

  it('★★★ 最後の DELETE が 404（保険）なら gone', async () => {
    const s = script([200], [404])
    expect(await run(s)).toEqual({ kind: 'gone' })
    expect(s.log.filter(l => l.method === 'DELETE')).toHaveLength(1)
  })

  it('★★★ 続きの回（finalConfirm:false）は、GET 200 が続くなら DELETE を1本も送らずに timeout。GET が 404 を見せた回の確かめだけは送る', async () => {
    const s = script([200], [404])
    expect(await run(s, { finalConfirm: false })).toEqual({ kind: 'timeout' })
    expect(s.log.filter(l => l.method === 'DELETE'), '続きの回が上限の直前に DELETE を送った').toHaveLength(0)
    const t = script([200, 404], [404])
    expect(await run(t, { finalConfirm: false })).toEqual({ kind: 'gone' })
    expect(t.seq()).toEqual(['GET', 'GET', 'DELETE'])
  })

  it('★★ 上限の直前の DELETE も、その少し前の確かめの DELETE から20秒以上あける（DELETE どうしの間がすべて20秒以上）', async () => {
    // 290秒の GET が 404 → 確かめの DELETE（202）→ 295秒で上限 → 最後の DELETE は 310秒（間隔待ち）
    const s = script([...Array(58).fill(200), 404, 200], [202])
    expect(await run(s)).toEqual({ kind: 'timeout' })
    const deletes = s.log.filter(l => l.method === 'DELETE').map(l => l.at)
    expect(deletes).toHaveLength(2)
    expect(deletes[1] - deletes[0], 'DELETE の間隔が20秒未満').toBeGreaterThanOrEqual(hanamiiDeletionWaitTuning.confirmGapMs)
  })

  it('★★★ 時間切れを完了と読まない: 最後の DELETE が 500 でも timeout（gone でない）', async () => {
    expect(await run(script([200], [500]))).toEqual({ kind: 'timeout' })
  })
})

describe('waitForHanamiiDeletion: 確かめられない回', () => {
  it.each([401, 403])('★★★ GET が %i → すぐ unconfirmed。DELETE は0本', async (status) => {
    const s = script([200, status], [404])
    const r = await run(s)
    expect(r).toEqual({ kind: 'unconfirmed', detail: `HTTP ${status}` })
    expect(s.seq()).toEqual(['GET', 'GET'])
  })

  it.each([401, 403])('★★ 確かめの DELETE が %i → すぐ unconfirmed', async (status) => {
    const s = script([404], [status])
    expect(await run(s)).toEqual({ kind: 'unconfirmed', detail: `HTTP ${status}` })
    expect(s.seq()).toEqual(['GET', 'DELETE'])
  })

  it('★★★ GET の 500 が5回続く → unconfirmed（detail は HTTP 500）。例外も同じく数える', async () => {
    const s = script([500], [404])
    expect(await run(s)).toEqual({ kind: 'unconfirmed', detail: 'HTTP 500' })
    expect(s.seq()).toEqual(['GET', 'GET', 'GET', 'GET', 'GET'])
    const e = script([0], [404])
    const r = await run(e)
    expect(r.kind).toBe('unconfirmed')
    expect((r as { detail: string }).detail).toContain('fetch failed')
  })

  it('★★★ 待ちの GET の 429 は、その場で打ち切らず失敗に数える（429→429→404 は続き、gone まで進む）。連続5回で unconfirmed（HTTP 429）', async () => {
    const s = script([200, 429, 429, 404], [404])
    expect(await run(s)).toEqual({ kind: 'gone' })
    expect(s.seq()).toEqual(['GET', 'GET', 'GET', 'GET', 'DELETE'])
    const t = script([429], [404])
    expect(await run(t)).toEqual({ kind: 'unconfirmed', detail: 'HTTP 429' })
    expect(t.seq()).toEqual(['GET', 'GET', 'GET', 'GET', 'GET'])
  })

  it('★★★ 失敗の連続は、途中の 200 で 0 に戻る（4回失敗→200→4回失敗…では打ち切らない）', async () => {
    const s = script([500, 500, 500, 500, 200, 500, 500, 500, 500, 200], [202])
    // 並びを使い切ったあとは最後の 200 が続く＝timeout まで進む
    expect((await run(s)).kind).toBe('timeout')
  })

  it('★★★ 確かめの DELETE が 429 → 失敗とは呼ばずに待ち続ける（その場で打ち切らない・gone にもしない）。次の確かめで 404 → gone', async () => {
    const s = script([404], [429, 404])
    expect(await run(s)).toEqual({ kind: 'gone' })
    expect(s.log.filter(l => l.method === 'DELETE')).toHaveLength(2)
  })

  it('★★ 確かめの DELETE が 503 を5回続けた → unconfirmed（detail は HTTP 503）', async () => {
    const s = script([404], [503])
    expect(await run(s)).toEqual({ kind: 'unconfirmed', detail: 'HTTP 503' })
    expect(s.log.filter(l => l.method === 'DELETE')).toHaveLength(5)
  })
})

describe('waitForHanamiiDeletion: レート制限に収まる（1プロジェクト 30回/300秒の DELETE）', () => {
  it('★★★ GET は常に 404・DELETE は常に 202 でも、どの300秒の窓でも DELETE は最初の1本を含めて 11本以下。DELETE の間は20秒以上・GET の間は5秒以上', async () => {
    const s = script([404], [202])
    const r = await run(s, { deleteJustSent: true })
    expect(r.kind).toBe('timeout')
    // 最初の DELETE（呼び手が送ったもの）は待ち始めの時刻に数える
    const deletes = [s.log[0].at, ...s.log.filter(l => l.method === 'DELETE').map(l => l.at)]
    for (let i = 0; i < deletes.length; i++) {
      const inWindow = deletes.filter(t => t >= deletes[i] && t < deletes[i] + 300_000).length
      expect(inWindow, `${i} 本目からの300秒に ${inWindow} 本`).toBeLessThanOrEqual(11)
      if (i > 0) expect(deletes[i] - deletes[i - 1], `DELETE の間隔 ${i}`).toBeGreaterThanOrEqual(20_000)
    }
    const gets = s.log.filter(l => l.method === 'GET').map(l => l.at)
    for (let i = 1; i < gets.length; i++) expect(gets[i] - gets[i - 1], `GET の間隔 ${i}`).toBeGreaterThanOrEqual(5_000)
  })
})

describe('waitForHanamiiDeletion: 進み具合', () => {
  it('★★ 待つたびに、決まった文と「N秒経過」を出す', async () => {
    const seen: Array<[string, string]> = []
    const s = script([200, 200, 404], [404])
    await run(s, { onProgress: (l, d) => seen.push([l, d]) })
    expect(seen).toEqual([[HANAMII_DELETION_WAIT_PROGRESS, '0秒経過'], [HANAMII_DELETION_WAIT_PROGRESS, '5秒経過']])
  })
})

describe('readHanamiiAccepted（202 の本文の読み方）', () => {
  const r = (project: unknown) => readHanamiiAccepted({ data: { project } })
  it('★★ requiresReview は真偽値の true のときだけ真。文字列 "true"・項目の欠落・null は偽。operationId は空でない文字列だけ', () => {
    expect(r({ requiresReview: true, operationId: ACCEPTED_OPERATION_ID })).toEqual({ requiresReview: true, operationId: ACCEPTED_OPERATION_ID })
    expect(r({ requiresReview: false, operationId: 'op' })).toEqual({ requiresReview: false, operationId: 'op' })
    for (const bad of ['true', 1, null, undefined, {}, []]) expect(r({ requiresReview: bad }).requiresReview, String(bad)).toBe(false)
    expect(r({})).toEqual({ requiresReview: false, operationId: null })
    expect(r({ operationId: '' }).operationId).toBeNull()
    expect(r({ operationId: 5 }).operationId).toBeNull()
    expect(readHanamiiAccepted({ data: null })).toEqual({ requiresReview: false, operationId: null })
    expect(readHanamiiAccepted({ data: 'x' })).toEqual({ requiresReview: false, operationId: null })
  })

  it('★★ 原本の 202 の例（operationId・requiresReview:false）は accepted と読み、本文から operationId を取る', () => {
    const data = JSON.parse(deleteProjectReplyText(202, PID))
    expect(readHanamiiDeleteReply({ ok: true, status: 202, data })).toBe('accepted')
    expect(readHanamiiAccepted({ data })).toEqual({ requiresReview: false, operationId: ACCEPTED_OPERATION_ID })
  })
})
