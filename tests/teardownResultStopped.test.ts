import { describe, it, expect, beforeEach } from 'vitest'
import { summarizeResult, getOps, stageReporter, resetProjectOpsForTests, adoptStoppedOps } from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import { STAGE } from '../src/shared/stageTiming'
import { stoppedNextStep, type StoppedEntry } from '../src/shared/inFlightOps'
import type { PublishTargetKind } from '../src/shared/publishMeta'
import { toTeardownView, resumedTeardownView } from '../src/shared/teardownResult'
import { stoppedNotice, NOTICE_HANDLER, type NoticeTarget } from './stoppedNoticeHarness'

// ── 途中で止まった回の、結果の読み方（設計書 10.13.8・10.13.9・10.13.12 の V4・N1）────────────────────────────────
// 既存の期待（型を丸ごと書いた tests/teardownResultCommon.test.ts など）は 1 行も変えない（10.13.9・完了条件 3）ので、
// 止まった回に関する試験はこのファイルに置く。
//   V4  止まった回（earlierRuns）も、その場の返り値と、開き直したときの記録で、同じ値を読む（双子）
//   N1  起動の読み戻しが置く「Koto の終了で止まりました」の知らせは、失敗でなく途中（inProgress）で、stoppedByQuit が付く。
//       付くのは true のときだけ（false のときはキーごと付けない）。その場の返り値からは作れない
// 知らせの記録は、本物の projectOps（起動の読み戻し）が置いたものを使う（tests/stoppedNoticeHarness.ts）。

const DEDICATED = 'sakura-apprun-dedicated' as const
const SHARED = 'sakura-apprun' as const
const HANAMII = 'hanamii' as const
const DIR = '/tmp/koto-teardown-result-stopped'

const APP_LINE = 'アプリケーション『app1』を削除しました（消えたことを確認）'
const DONE_MSG = '削除の要求はすべて受け付けられ、一覧から消えたことを確認しました。コントロールパネルでもご確認ください。'

/** 同じ返り値を、その場で読む／記録（summarizeResult）から読む。 */
function twin(target: PublishTargetKind, raw: unknown) {
  return { live: toTeardownView(target, raw), resumed: resumedTeardownView(target, summarizeResult(raw)) }
}

describe('V4: 止まった回（earlierRuns）も、その場と開き直しで同じ値を読む', () => {
  const TIMINGS = { totalMs: 5000, stages: [{ stage: STAGE.teardownApp, ms: 3000 }, { stage: STAGE.teardownLb, ms: 2000 }] }
  const RAW = { ok: true, appDeleted: true, executed: [APP_LINE], message: DONE_MSG, remaining: {}, stageTimings: TIMINGS }
  const EARLIER = {
    startedAt: Date.UTC(2026, 9, 10, 5, 0, 0), lastKnownAt: Date.UTC(2026, 9, 10, 5, 6, 20), endedBy: 'quit' as const,
    knownMs: 380_000, stages: [{ stage: STAGE.teardownApp, ms: 72_000 }, { stage: STAGE.teardownLb, ms: 308_000 }], partialLast: true,
  }
  const WITH_EARLIER = { ...TIMINGS, earlierRuns: [EARLIER] }

  beforeEach(() => { resetProjectOpsForTests() })

  it('★★ V4 earlierRuns: その場の返り値も、finishOp が足した記録の extra.stageTimings も、止まった回を同じ形で読む', () => {
    const raw = { ...RAW, stageTimings: WITH_EARLIER }
    const live = toTeardownView(DEDICATED, raw)
    expect(live.stageTimings?.earlierRuns).toEqual([EARLIER])
    expect(live.stageTimings?.totalMs, '今回の分（意味を変えない）').toBe(5000)
    const rec = summarizeResult(RAW)
    rec.extra.stageTimings = WITH_EARLIER
    expect(resumedTeardownView(DEDICATED, rec)).toEqual(live)
  })

  it('V4 形の違う止まった回は、その場でも記録でも捨てる（正しい分だけ写す。全部捨てたら earlierRuns のキーごと付けない）', () => {
    const broken = [
      { ...EARLIER, endedBy: 'later' }, { ...EARLIER, startedAt: 'x' }, { ...EARLIER, knownMs: -1 },
      { ...EARLIER, stages: [{ stage: 'bad stage name', ms: 1 }] }, null, 3,
    ]
    const raw = { ...RAW, stageTimings: { ...TIMINGS, earlierRuns: [...broken, EARLIER] } }
    const live = toTeardownView(DEDICATED, raw)
    expect(live.stageTimings?.earlierRuns).toEqual([EARLIER])
    const rec = summarizeResult(RAW)
    rec.extra.stageTimings = raw.stageTimings
    expect(resumedTeardownView(DEDICATED, rec)).toEqual(live)
    const none = toTeardownView(DEDICATED, { ...RAW, stageTimings: { ...TIMINGS, earlierRuns: broken } })
    expect(none.stageTimings).toEqual(TIMINGS)
    expect('earlierRuns' in (none.stageTimings ?? {})).toBe(false)
  })

  it('★★ V4 止まった回を合わせた回（earlierRuns つき）も、本物の記録（withProjectLock → getOps）を通して、その場と開き直しは同じ', async () => {
    // Koto の終了で止まった回（起動の読み戻しが渡す）を持たせて、同じ公開先の削除を最後まで走らせる。
    const lastSeen = Date.now() - 20 * 60_000
    const run = {
      op: '削除' as const, target: DEDICATED, handler: 'apprunDedicated:teardown', version: '0.6.22',
      startedAt: lastSeen - 5 * 60_000, lastSeenAt: lastSeen,
      segments: [{ stage: STAGE.teardownApp, startedAt: lastSeen - 5 * 60_000, endedAt: lastSeen - 4 * 60_000 }, { stage: STAGE.teardownLb, startedAt: lastSeen - 4 * 60_000 }],
      endedBy: 'quit' as const,
    }
    const entry: StoppedEntry = { op: '削除', target: DEDICATED, handler: 'apprunDedicated:teardown', runs: [run], noticeSeen: true }
    adoptStoppedOps({ [DIR]: entry }, Date.now())
    const raw = { ok: true, appDeleted: true, executed: [APP_LINE], message: DONE_MSG, remaining: {} }
    const done = await withProjectLock(DIR, '削除', async () => {
      for (const s of [STAGE.teardownLb, STAGE.teardownStorage]) { stageReporter(DIR)(s); await new Promise<void>(r => setTimeout(r, 3)) }
      return raw
    }, { target: DEDICATED, handler: 'apprunDedicated:teardown' })
    if (done.busy) throw new Error('別の操作が走っていた')
    expect(done.stageTimings?.earlierRuns, '前提: 止まった回が今回に合わさっている').toHaveLength(1)
    expect(done.stageTimings?.earlierRuns?.[0]).toMatchObject({ endedBy: 'quit', partialLast: true, knownMs: 300_000 })
    // 専有型のハンドラは、返り値に stageTimings を足して画面へ返す（withStageTimings）。その場の画面が読むのはこの形
    const live = toTeardownView(DEDICATED, { ...(done.value as Record<string, unknown>), stageTimings: done.stageTimings })
    const resumed = resumedTeardownView(DEDICATED, getOps(DIR).last?.result)
    expect(live.stageTimings?.earlierRuns).toEqual(done.stageTimings?.earlierRuns)
    expect(resumed).toEqual(live)
  })
})

// ── N1: 「Koto の終了で止まりました」の知らせ（記録の extra.stoppedByQuit）────────────────────────────────────────
describe('N1: 「Koto の終了で止まりました」の知らせは、失敗でなく途中（inProgress）で、stoppedByQuit が付く', () => {
  beforeEach(() => { resetProjectOpsForTests() })
  const T = Date.UTC(2026, 9, 10, 5, 9, 0)
  const TARGETS_ALL: NoticeTarget[] = [DEDICATED, SHARED, HANAMII]

  it.each(TARGETS_ALL)('★★ %s: ok:false・state は inProgress・stoppedByQuit は true。一覧・警告・時間は空（短い知らせ）で、本文は次の操作の案内', target => {
    const rec = stoppedNotice(DIR, target, T)
    expect(rec.handler).toBe(NOTICE_HANDLER[target])
    const v = resumedTeardownView(target, rec.result)
    expect(v).toEqual({
      ok: false, state: 'inProgress', appDeleted: null, executed: [], message: stoppedNextStep(target),
      remaining: [], inProgress: [], warnings: [], stageTimings: null, stoppedByQuit: true,
    })
  })

  it('★★ stoppedByQuit が無い結果の TeardownView に、stoppedByQuit のキーが存在しない（false も書かない。既存の toEqual の期待を壊さない）', () => {
    const raws: Array<[string, Record<string, unknown>]> = [
      ['成功', { ok: true, appDeleted: true, executed: [APP_LINE], remaining: {} }],
      ['失敗（残った）', { ok: false, executed: [], remaining: { clusterID: 'c1' }, message: 'x' }],
      ['待ち切れた', { ok: false, executed: [], remaining: { loadBalancerID: 'l1' }, inProgress: { loadBalancerID: 'l1' } }],
      ['HANAMII 受付済み', { ok: false, appDeleted: false, deletionAccepted: true, executed: [] }],
      ['断り', { ok: false, message: 'キーが無い' }],
    ]
    for (const target of TARGETS_ALL) {
      for (const [name, raw] of raws) {
        const { live, resumed } = twin(target, raw)
        expect('stoppedByQuit' in live, `${target} ${name}（その場）`).toBe(false)
        expect('stoppedByQuit' in resumed, `${target} ${name}（記録）`).toBe(false)
      }
      for (const bad of [null, undefined, 'x', 3, []]) {
        expect('stoppedByQuit' in toTeardownView(target, bad), `${target} 読めない返り値`).toBe(false)
        expect('stoppedByQuit' in resumedTeardownView(target, bad as never), `${target} 読めない記録`).toBe(false)
      }
      // extra にあっても true でなければ知らせではない
      for (const bad of [false, 'true', 1, null, {}]) {
        const v = resumedTeardownView(target, { ok: false, extra: { stoppedByQuit: bad } })
        expect('stoppedByQuit' in v, `${target} extra.stoppedByQuit=${JSON.stringify(bad)}`).toBe(false)
        expect(v.state, target).toBe('failed')
      }
    }
  })

  it('★ 知らせを作れるのは記録（main の起動の読み戻し）だけ。その場の返り値に stoppedByQuit を載せても知らせにならない（偽の知らせを作らない）', () => {
    for (const target of TARGETS_ALL) {
      for (const raw of [{ ok: false, stoppedByQuit: true, message: 'x' }, { ok: false, extra: { stoppedByQuit: true }, message: 'x' }]) {
        const v = toTeardownView(target, raw)
        expect('stoppedByQuit' in v, target).toBe(false)
        expect(v.state, target).toBe('failed')
      }
    }
  })

  it('★ ok が先: 成功した記録は、extra に stoppedByQuit があっても知らせにしない（done のまま）', () => {
    const v = resumedTeardownView(DEDICATED, { ok: true, extra: { stoppedByQuit: true } })
    expect(v.state).toBe('done')
    expect('stoppedByQuit' in v).toBe(false)
  })

  it('★ ハンドラの返り値に stoppedByQuit を載せても、summarizeResult は extra に写さない（U9 と同じ。偽の知らせを作れない）', () => {
    const fake = summarizeResult({ ok: false, stoppedByQuit: true, message: 'x' })
    expect(fake.extra).not.toHaveProperty('stoppedByQuit')
    expect('stoppedByQuit' in resumedTeardownView(DEDICATED, fake)).toBe(false)
  })
})
