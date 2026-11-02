import { describe, it, expect } from 'vitest'
import { keptOnlyOf, keptOnlyField, readKeptOnly, type KeptOnlyFacts } from '../src/shared/keptOnly'
import { teardownCallOf, teardownStateOf, teardownCallLine, type TeardownCall } from '../src/shared/teardownCall'
import { toTeardownView, resumedTeardownView, resultCallOf, type TeardownView } from '../src/shared/teardownResult'
import { summarizeResult } from '../src/main/projectOps'
import { projectDeleteVerdict, type ProjectDeleteStep, type ProjectDeletePlan } from '../src/renderer/teardown/projectDeletePlan'
import { teardownRemainingWarnings } from '../src/shared/cloudCost'

// ── 「何も消さなかった」の印（keptOnly）: 判定の純関数と、結果の読み方（T-2b・T-2c の純関数の部分）──────────────────
// 判定の純関数 keptOnlyOf は、main の共用型・専有型の破棄が同じこの1つを通る（実際の main に流す試験は tests/keptOnlyTeardown.test.ts）。
// ここは、判定の全分岐と、印を読む側（teardownCallOf・toTeardownView・記録の読み直し）の全分岐を固定する。
// 印は真偽値の true だけを真と読む（不明な値を「何も消さなかった」と読まない）。ok が先（失敗した回は印を読まない）。

const BASE: KeptOnlyFacts = { ok: true, removedApp: false, removedRegistry: false, storage: [{ keptData: true }] }

describe('keptOnlyOf: 何も消さなかったか', () => {
  it('★★★ ok・アプリもレジストリも消していない・保存場所が全部 keptData → 真（1件でも2件でも）', () => {
    expect(keptOnlyOf(BASE)).toBe(true)
    expect(keptOnlyOf({ ...BASE, storage: [{ keptData: true }, { keptData: true }] })).toBe(true)
  })

  it('★★★ ok:false は偽（失敗した回は、何が消えたか分からない）', () => {
    expect(keptOnlyOf({ ...BASE, ok: false })).toBe(false)
  })

  it('★★★ アプリを消した回は偽。レジストリを実際に消した回も偽', () => {
    expect(keptOnlyOf({ ...BASE, removedApp: true })).toBe(false)
    expect(keptOnlyOf({ ...BASE, removedRegistry: true })).toBe(false)
  })

  it('★★★ 保存場所が0件の回は偽（残した保存場所が無ければ「保存場所だけが残った」とは言えない）', () => {
    expect(keptOnlyOf({ ...BASE, storage: [] })).toBe(false)
  })

  it('★★★ 1件でもデータを消した保存場所があれば偽（全部が keptData のときだけ）', () => {
    expect(keptOnlyOf({ ...BASE, storage: [{ keptData: true }, {}] })).toBe(false)
    expect(keptOnlyOf({ ...BASE, storage: [{}, { keptData: true }] })).toBe(false)
    expect(keptOnlyOf({ ...BASE, storage: [{ keptData: false }] })).toBe(false)
    expect(keptOnlyOf({ ...BASE, storage: [{ keptData: undefined }] })).toBe(false)
  })

  it('★★★ 不明な値は、何も消さなかった側に倒さない: keptData が真偽値の true でない・消していないと確かめられていない・ok が true でない', () => {
    for (const odd of ['true', 1, 'yes', {}, [], null]) {
      expect(keptOnlyOf({ ...BASE, storage: [{ keptData: odd }] }), `keptData=${JSON.stringify(odd)}`).toBe(false)
    }
    expect(keptOnlyOf({ ...BASE, removedApp: undefined as never })).toBe(false)
    expect(keptOnlyOf({ ...BASE, removedRegistry: undefined as never })).toBe(false)
    expect(keptOnlyOf({ ...BASE, removedApp: 0 as never })).toBe(false)
    expect(keptOnlyOf({ ...BASE, ok: 'true' as never })).toBe(false)
    expect(keptOnlyOf({ ...BASE, ok: 1 as never })).toBe(false)
  })
})

describe('keptOnlyField: 返り値へ足す項目（真のときだけキーごと付ける）', () => {
  it('★★ 真なら { keptOnly: true }、偽なら何も付けない（keptOnly: false も書かない）', () => {
    expect(keptOnlyField(BASE)).toEqual({ keptOnly: true })
    const off = keptOnlyField({ ...BASE, storage: [] })
    expect(off).toEqual({})
    expect('keptOnly' in off).toBe(false)
    expect('keptOnly' in { ok: true, ...keptOnlyField({ ...BASE, removedApp: true }) }).toBe(false)
  })
})

describe('readKeptOnly: 返り値・記録の extra から印を読む（真偽値の true だけ）', () => {
  it('★★★ true だけが真。文字列 "true"・数 1・false・無い・オブジェクトでない値は読まない', () => {
    expect(readKeptOnly({ keptOnly: true })).toBe(true)
    for (const odd of ['true', 1, 'yes', false, 0, null, undefined, {}, []]) {
      expect(readKeptOnly({ keptOnly: odd }), `keptOnly=${JSON.stringify(odd)}`).toBe(false)
    }
    for (const odd of [null, undefined, 'x', 7, true]) expect(readKeptOnly(odd), `fields=${JSON.stringify(odd)}`).toBe(false)
    expect(readKeptOnly({})).toBe(false)
  })
})

// ── 呼び名（T-2c）────────────────────────────────────────────────────────────────────
const CALL_BASE = { ok: false, accepted: false, stopped: false, stoppedByQuit: false, warnings: 0 }

describe('teardownCallOf と keptOnly（T-2c）', () => {
  it('★★★ 成功で keptOnly:true は doneKeptOnly（警告があっても・無くても。警告つきの済んだ回とは別の呼び名）', () => {
    expect(teardownCallOf({ ...CALL_BASE, ok: true, keptOnly: true })).toBe('doneKeptOnly')
    expect(teardownCallOf({ ...CALL_BASE, ok: true, keptOnly: true, warnings: 2 })).toBe('doneKeptOnly')
  })

  it('★★★ keptOnly が無い・false の成功は今までどおり（done／doneWithWarnings）', () => {
    expect(teardownCallOf({ ...CALL_BASE, ok: true })).toBe('done')
    expect(teardownCallOf({ ...CALL_BASE, ok: true, keptOnly: false })).toBe('done')
    expect(teardownCallOf({ ...CALL_BASE, ok: true, keptOnly: false, warnings: 1 })).toBe('doneWithWarnings')
    expect(teardownCallOf({ ...CALL_BASE, ok: true, warnings: 1 })).toBe('doneWithWarnings')
  })

  it('★★★ ok が先: 失敗の回は keptOnly を読まない（failed・途中のまま）', () => {
    expect(teardownCallOf({ ...CALL_BASE, keptOnly: true })).toBe('failed')
    expect(teardownCallOf({ ...CALL_BASE, keptOnly: true, accepted: true })).toBe('inProgress')
    expect(teardownCallOf({ ...CALL_BASE, keptOnly: true, stopped: true })).toBe('inProgress')
    expect(teardownCallOf({ ...CALL_BASE, keptOnly: true, stoppedByQuit: true })).toBe('stoppedByQuit')
  })

  it('★★★ 不明な値（文字列 "true"・数 1）は読まない', () => {
    expect(teardownCallOf({ ...CALL_BASE, ok: true, keptOnly: 'true' as never })).toBe('done')
    expect(teardownCallOf({ ...CALL_BASE, ok: true, keptOnly: 1 as never, warnings: 1 })).toBe('doneWithWarnings')
  })

  it('★★★ state は done に畳む（移してよい。state を増やさない）。ほかの呼び名の畳み方は変わらない', () => {
    expect(teardownStateOf('doneKeptOnly')).toBe('done')
    const table: Record<TeardownCall, string> = { done: 'done', doneKeptOnly: 'done', doneWithWarnings: 'done', inProgress: 'inProgress', stoppedByQuit: 'inProgress', failed: 'failed' }
    for (const [call, state] of Object.entries(table)) expect(teardownStateOf(call as TeardownCall), call).toBe(state)
  })

  it('★★ 開き直しの一言: 何も消していない回は「成功しました」と言わない（言い分けの全分岐は tests/keptOnlyHeadline.test.ts）', () => {
    expect(teardownCallLine('doneKeptOnly', '')).toEqual({ text: '⚠️ 何も消していません。', tone: 'wait' })
    expect(teardownCallLine('doneKeptOnly', 'm')).not.toEqual(teardownCallLine('done', 'm'))
  })
})

// ── 結果の読み方（T-2b の純関数の部分）────────────────────────────────────────────────────
const SHARED = 'sakura-apprun' as const
const DEDICATED = 'sakura-apprun-dedicated' as const
/** main が keptOnly の回に返す形（保存場所が複製のため、データにも手を付けず残した。共用型・アプリ無し）。 */
const KEPT_REPLY = {
  ok: true, appDeleted: true, executed: ['保存場所『koto-data-a』のデータは残しました — フォルダ『myapp copy』も同じデータを使っています。'],
  keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptBucketsUsedByOthers: ['koto-data-a'], keptOnly: true,
}
const record = (reply: unknown) => summarizeResult(reply)

describe('印の読み方: その場（toTeardownView）と記録（summarizeResult → resumedTeardownView）が同じ keptOnly を読む', () => {
  it('★★★ 共用型・専有型の成功: view に keptOnly:true・state は done のまま・ok は変わらない。月額の警告は残る（お金を削らない）', () => {
    for (const target of [SHARED, DEDICATED]) {
      const live = toTeardownView(target, KEPT_REPLY)
      expect(live, target).toMatchObject({ ok: true, state: 'done', keptOnly: true })
      expect(live.warnings, `${target}: 月額の警告`).toEqual(teardownRemainingWarnings({ keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptBucketsUsedByOthers: ['koto-data-a'] }))
      expect(live.warnings.length).toBeGreaterThan(0)
      const rec = record(KEPT_REPLY)
      expect(rec.extra, 'EXTRA_KEYS に keptOnly が無いと、記録に写らない').toMatchObject({ keptOnly: true })
      expect(resumedTeardownView(target, rec), `${target}: 開き直し`).toEqual(live)
      expect(resultCallOf(target, rec)).toBe('doneKeptOnly')
    }
  })

  it('★★★ 印が無い成功は今までどおり: view に keptOnly のキーが無い（false も書かない）・呼び名は done／doneWithWarnings', () => {
    const plain = { ok: true, appDeleted: true, executed: ['アプリを削除しました'] }
    const live = toTeardownView(SHARED, plain)
    expect('keptOnly' in live).toBe(false)
    expect(resumedTeardownView(SHARED, record(plain))).toEqual(live)
    expect(resultCallOf(SHARED, record(plain))).toBe('done')
    const { keptOnly: _drop, ...withoutMark } = KEPT_REPLY
    const warned = toTeardownView(SHARED, withoutMark)
    expect('keptOnly' in warned).toBe(false)
    expect(resultCallOf(SHARED, record(withoutMark))).toBe('doneWithWarnings')
  })

  it('★★★ ok が先: 失敗した回に keptOnly が付いていても読まない（failed のまま・移してよい側に倒さない）', () => {
    const failedReply = { ...KEPT_REPLY, ok: false, message: '失敗' }
    for (const target of [SHARED, DEDICATED]) {
      const live = toTeardownView(target, failedReply)
      expect(live.state, target).toBe('failed')
      expect('keptOnly' in live, target).toBe(false)
      expect(resultCallOf(target, record(failedReply)), target).toBe('failed')
      expect('keptOnly' in resumedTeardownView(target, record(failedReply)), target).toBe(false)
    }
  })

  it('★★★ 不明な値（文字列 "true"・数 1・false）は読まない。view にも呼び名にも出ない', () => {
    for (const odd of ['true', 1, false, null]) {
      const reply = { ...KEPT_REPLY, keptOnly: odd }
      const live = toTeardownView(SHARED, reply)
      expect('keptOnly' in live, `keptOnly=${JSON.stringify(odd)}`).toBe(false)
      expect(live.state).toBe('done')
      expect(resultCallOf(SHARED, record(reply)), `keptOnly=${JSON.stringify(odd)}`).toBe('doneWithWarnings')
      expect('keptOnly' in resumedTeardownView(SHARED, record(reply))).toBe(false)
    }
  })

  it('★★★ HANAMII は印を付けない公開先: 付いていても読まない（見出しがプロジェクト削除の唯一の知らせ）', () => {
    const live = toTeardownView('hanamii', KEPT_REPLY)
    expect(live.state).toBe('done')
    expect('keptOnly' in live).toBe(false)
    expect('keptOnly' in resumedTeardownView('hanamii', record(KEPT_REPLY))).toBe(false)
    expect(resultCallOf('hanamii', record(KEPT_REPLY))).toBe('doneWithWarnings')
  })

  it('★★ 許可リスト EXTRA_KEYS: keptOnly は記録の extra に写る（印が無い回には写らない）', () => {
    expect(summarizeResult({ ok: true, keptOnly: true }).extra).toEqual({ keptOnly: true })
    expect(summarizeResult({ ok: true }).extra).toEqual({})
  })
})

describe('プロジェクトの削除: keptOnly の回も done 扱い（移してよいかは変わらない）', () => {
  const PLAN: ProjectDeletePlan = { block: null, teardown: ['sakura-apprun'] }
  const stepOf = (view: TeardownView): ProjectDeleteStep => ({ target: 'sakura-apprun', kind: 'done', view, words: {} as never })

  it('★★★ keptOnly の step: 移す（moveToTrash）。月額の警告があるので hold（見せてから、もう一度押してもらう）。印が無い同じ警告の step と同じ判断', () => {
    const marked = toTeardownView(SHARED, KEPT_REPLY)
    const { keptOnly: _drop, ...withoutMark } = KEPT_REPLY
    const unmarked = toTeardownView(SHARED, withoutMark)
    expect(marked.keptOnly).toBe(true)
    expect(projectDeleteVerdict(PLAN, true, [stepOf(marked)])).toEqual({ moveToTrash: true, hold: true })
    expect(projectDeleteVerdict(PLAN, true, [stepOf(unmarked)])).toEqual(projectDeleteVerdict(PLAN, true, [stepOf(marked)]))
  })
})
