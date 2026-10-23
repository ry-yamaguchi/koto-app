import { describe, it, expect } from 'vitest'
import { teardownCallOf, teardownStateOf, teardownCallLine, type TeardownCall } from '../src/shared/teardownCall'
import {
  resultCallOf, resumedTeardownView, toTeardownView, HANAMII_DELETION_ACCEPTED_WARNING, TEARDOWN_IN_PROGRESS_WARNING_HEAD,
} from '../src/shared/teardownResult'
import { warningsNotRepeatedIn } from '../src/shared/opsText'
import { summarizeResult } from '../src/main/projectOps'
import type { PublishTargetKind } from '../src/shared/publishMeta'

// ── 破棄・削除の結果を、画面でどう呼ぶか（0.6.22-rc.3 の実機・2026-10-21・10.18.15 の d1・d2）────────────────────
// HANAMII が削除を受け付けただけの回（ok:false・deletionAccepted）を、【公開】の結果カードが「失敗しました」と言い、
// すぐ下の結果欄は「途中です」と言った。同じ記録を読む画面が、`r.ok` だけで失敗と言う所と、見出しの state で途中と言う所に分かれていた。
// 呼び名を決める唯一の定義は shared/teardownCall.ts の teardownCallOf。ここは、その全分岐と、
//   ・事実（返り値・記録）からの読み（resultCallOf）が、結果欄の見出し（TeardownView.state）と必ず同じ答えを返すこと
//   ・本文と同じ警告を落とす規則（warningsNotRepeatedIn）の全分岐
// を固定する。画面に描いた結果は tests/teardownCallRender.test.ts。

const base = { ok: false, accepted: false, stopped: false, stoppedByQuit: false, warnings: 0 }

describe('teardownCallOf: 全分岐', () => {
  it('★★★ 受け付けただけ（accepted）は、ok:false でも失敗ではなく途中', () => {
    expect(teardownCallOf({ ...base, accepted: true })).toBe('inProgress')
  })

  it('★★ 専有型が待ち切れて止まった（stopped）も途中', () => {
    expect(teardownCallOf({ ...base, stopped: true })).toBe('inProgress')
  })

  it('★★★ Koto の終了で止まった（stoppedByQuit）は、受け付けた・待ち切れたより先に決まる別の呼び名（失敗ではない）', () => {
    expect(teardownCallOf({ ...base, stoppedByQuit: true })).toBe('stoppedByQuit')
    expect(teardownCallOf({ ...base, stoppedByQuit: true, accepted: true })).toBe('stoppedByQuit')
  })

  it('★★ 成功は警告が無ければ done、あれば doneWithWarnings', () => {
    expect(teardownCallOf({ ...base, ok: true })).toBe('done')
    expect(teardownCallOf({ ...base, ok: true, warnings: 1 })).toBe('doneWithWarnings')
    expect(teardownCallOf({ ...base, ok: true, warnings: 3 })).toBe('doneWithWarnings')
  })

  it('★★★ 失敗は、途中の印が何も無い ok:false だけ（警告の数は関係しない）', () => {
    expect(teardownCallOf({ ...base })).toBe('failed')
    expect(teardownCallOf({ ...base, warnings: 2 })).toBe('failed')
  })

  it('★★ ok が先: 成功した記録は、途中の印が付いていても途中でも失敗でもない', () => {
    expect(teardownCallOf({ ok: true, accepted: true, stopped: true, stoppedByQuit: true, warnings: 0 })).toBe('done')
    expect(teardownCallOf({ ok: true, accepted: true, stopped: true, stoppedByQuit: true, warnings: 1 })).toBe('doneWithWarnings')
  })
})

describe('teardownStateOf: 結果欄の見出しの3つへの畳み方', () => {
  it('★★ 済んだ（警告つきを含む）は done、途中の2つは inProgress、失敗は failed', () => {
    const table: Record<TeardownCall, string> = { done: 'done', doneWithWarnings: 'done', inProgress: 'inProgress', stoppedByQuit: 'inProgress', failed: 'failed' }
    for (const [call, state] of Object.entries(table)) expect(teardownStateOf(call as TeardownCall), call).toBe(state)
  })
})

describe('teardownCallLine: 開き直しの知らせの、結果の一言', () => {
  it('★★★ 済んだ・途中・失敗を言い分ける。受け付けただけの回に「失敗しました」と言わない', () => {
    expect(teardownCallLine('done', 'ok message')).toEqual({ text: '✅ 成功しました。 ok message', tone: 'ok' })
    expect(teardownCallLine('doneWithWarnings', '')).toEqual({ text: '✅ 成功しました。', tone: 'ok' })
    expect(teardownCallLine('inProgress', '受け付けました')).toEqual({ text: '⏳ 途中です。 受け付けました', tone: 'wait' })
    expect(teardownCallLine('failed', '断られた')).toEqual({ text: '⚠️ 失敗しました。 断られた', tone: 'fail' })
    expect(teardownCallLine('failed', '')).toEqual({ text: '⚠️ 失敗しました。', tone: 'fail' })
  })

  it('★★ 「Koto の終了で止まりました」の知らせは一言を足さず、次の操作の案内（message）だけを出す。案内が無ければ何も出さない', () => {
    expect(teardownCallLine('stoppedByQuit', 'もう一度削除を押すと、続きから進みます。')).toEqual({ text: 'もう一度削除を押すと、続きから進みます。', tone: 'plain' })
    expect(teardownCallLine('stoppedByQuit', '')).toBeNull()
  })
})

// ── 事実からの読み ────────────────────────────────────────────────────────────────────
// 記録は、main の実際の summarizeResult を通して作る（偽の形を手で書かない）。返り値の形は main の各ハンドラが返すとおり。
const HANAMII: PublishTargetKind = 'hanamii'
const DEDICATED: PublishTargetKind = 'sakura-apprun-dedicated'
const SHARED: PublishTargetKind = 'sakura-apprun'
/** HANAMII が DELETE を受け付けただけの回に、main の hanamii:teardown が返す形（src/main/ipc/hanamiiTeardown.ts の runHanamiiTeardown）。 */
const ACCEPTED_REPLY = { ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING }
const FAILED_REPLY = { ok: false, message: '削除に失敗しました（HTTP 500）' }
const record = (reply: unknown) => summarizeResult(reply)

describe('resultCallOf: 記録から読む。結果欄の見出し（TeardownView.state）と同じ答え', () => {
  it('★★★ HANAMII が受け付けただけの記録は inProgress。同じ記録を resumedTeardownView が読んでも途中（見出しと食い違わない）', () => {
    const rec = record(ACCEPTED_REPLY)
    expect(rec.ok).toBe(false)
    expect(resultCallOf(HANAMII, rec)).toBe('inProgress')
    expect(resumedTeardownView(HANAMII, rec).state).toBe('inProgress')
  })

  it('★★★ 本当の失敗（HTTP 500 で断られた）の記録は failed のまま', () => {
    const rec = record(FAILED_REPLY)
    expect(resultCallOf(HANAMII, rec)).toBe('failed')
    expect(resumedTeardownView(HANAMII, rec).state).toBe('failed')
  })

  it('★★ 受け付けた印は HANAMII のものだけ。専有型・共用型の記録に deletionAccepted が付いていても途中と読まない', () => {
    const rec = record(ACCEPTED_REPLY)
    expect(resultCallOf(DEDICATED, rec)).toBe('failed')
    expect(resultCallOf(SHARED, rec)).toBe('failed')
  })

  it('★★ 専有型が待ち切れて止まった記録（inProgress の中身がある）は途中。HANAMII の記録には効かない', () => {
    const rec = record({ ok: false, inProgress: { applicationID: 'app-1' }, message: '待ち切れませんでした' })
    expect(resultCallOf(DEDICATED, rec)).toBe('inProgress')
    expect(resumedTeardownView(DEDICATED, rec).state).toBe('inProgress')
    expect(resultCallOf(HANAMII, rec)).toBe('failed')
  })

  it('★★ 成功の記録は、警告が無ければ done・警告があれば doneWithWarnings', () => {
    expect(resultCallOf(HANAMII, record({ ok: true, appDeleted: true, executed: ['✅ 破棄しました'] }))).toBe('done')
    expect(resultCallOf(SHARED, record({ ok: true, executed: ['アプリを削除しました'], keptBucketName: 'koto-data-bucket' }))).toBe('doneWithWarnings')
  })

  it('★★★ Koto の終了で止まった知らせ（extra.stoppedByQuit）は stoppedByQuit。ok:true の記録は知らせではない', () => {
    const stopped = { ok: false, message: 'もう一度削除を押すと、続きから進みます。', lines: [], warnings: [], extra: { stoppedByQuit: true } }
    expect(resultCallOf(DEDICATED, stopped)).toBe('stoppedByQuit')
    expect(resultCallOf(DEDICATED, { ...stopped, ok: true })).toBe('done')
  })

  it('★★ 記録が無い・読めない（オブジェクトでない）は failed（結果欄の「読み取れませんでした」と同じ）', () => {
    for (const bad of [null, undefined]) expect(resultCallOf(HANAMII, bad), String(bad)).toBe('failed')
    expect(resultCallOf(HANAMII, ('x' as unknown) as never)).toBe('failed')
    expect(resumedTeardownView(HANAMII, null).state).toBe('failed')
  })

  it('★★ 公開・作成の記録を通しても、ok と警告だけで決まる（途中の印は付かない）。公開先が分からなくても読める', () => {
    expect(resultCallOf('unknown', record({ ok: true, url: 'https://example.com/' }))).toBe('done')
    expect(resultCallOf('unknown', record({ ok: true, notice: '公開できました。次にすることがあります' }))).toBe('doneWithWarnings')
    expect(resultCallOf('unknown', record({ ok: false, message: '公開に失敗しました' }))).toBe('failed')
  })

  it('★★★ 双子: 同じ返り値を、その場の画面（toTeardownView）と、記録から開き直した画面（resumedTeardownView）が読んでも、見出しの state は resultCallOf の答えと一致する', () => {
    const replies: [PublishTargetKind, unknown][] = [
      [HANAMII, ACCEPTED_REPLY],
      [HANAMII, FAILED_REPLY],
      [HANAMII, { ok: true, appDeleted: true, executed: ['✅ 破棄しました'] }],
      [HANAMII, { ok: false, appDeleted: true, remainingBuckets: ['koto-data-x'], message: '保存場所を消せませんでした' }],
      [DEDICATED, { ok: false, inProgress: { loadBalancerID: 'lb1' }, message: '待ち切れませんでした' }],
      [DEDICATED, { ok: false, remaining: { applicationID: 'app1' }, message: 'アプリの削除に失敗しました' }],
      [SHARED, { ok: true, executed: ['アプリを削除しました'], keptBucketName: 'koto-data-bucket' }],
      [SHARED, { ok: false, message: '失敗' }],
    ]
    for (const [target, reply] of replies) {
      const rec = record(reply)
      const call = resultCallOf(target, rec)
      expect(toTeardownView(target, reply).state, `${target} ${JSON.stringify(reply)} その場`).toBe(teardownStateOf(call))
      expect(resumedTeardownView(target, rec).state, `${target} ${JSON.stringify(reply)} 開き直し`).toBe(teardownStateOf(call))
    }
  })

  it('★ 専有型の「待ち切れずに止まりました」の警告の書き出しは、途中の呼び名とは別（文の作り手の確認）', () => {
    const rec = record({ ok: false, inProgress: { applicationID: 'app-1' }, message: 'm' })
    expect(rec.warnings?.some(w => w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD))).toBe(true)
  })
})

describe('warningsNotRepeatedIn: 本文と同じ文の警告は出さない（d2）', () => {
  it('★★★ 本文と同じ文の警告は落ちる。先頭の ⚠️・⚠・※ と空白を除いて同じでも落ちる', () => {
    const m = HANAMII_DELETION_ACCEPTED_WARNING
    expect(warningsNotRepeatedIn(m, [m])).toEqual([])
    expect(warningsNotRepeatedIn(m, [`⚠️ ${m}`])).toEqual([])
    expect(warningsNotRepeatedIn(m, [`⚠ ${m}`])).toEqual([])
    expect(warningsNotRepeatedIn(m, [`※ ${m}`])).toEqual([])
    expect(warningsNotRepeatedIn(m, [`  ⚠️   ${m}  `])).toEqual([])
  })

  it('★★★ 本文に無い警告は、そのまま（印も順序も）残る。月額が続く等の知らせを落とさない', () => {
    const other = '⚠️ 保存場所『koto-data-x』は残しました。月額が続きます'
    expect(warningsNotRepeatedIn('本文です', [other, '別の知らせ'])).toEqual([other, '別の知らせ'])
    expect(warningsNotRepeatedIn(HANAMII_DELETION_ACCEPTED_WARNING, [HANAMII_DELETION_ACCEPTED_WARNING, other])).toEqual([other])
  })

  it('★★ 本文が無い・文字列でないときは何も落とさない。空の文・印だけの文は落ちる（「⚠️ 」だけの行にしない）', () => {
    for (const m of [undefined, null, '', 7, {}]) expect(warningsNotRepeatedIn(m, ['知らせ']), String(m)).toEqual(['知らせ'])
    expect(warningsNotRepeatedIn('本文', ['', '⚠️', '⚠️  ', '  ', '知らせ'])).toEqual(['知らせ'])
    expect(warningsNotRepeatedIn('本文', [])).toEqual([])
  })

  it('★ 本文の一部として含まれる文も落ちる（結果欄・開き直しの知らせが前から使っている規則と同じ）', () => {
    expect(warningsNotRepeatedIn('前置き。保存場所は残しました。後書き', ['保存場所は残しました。'])).toEqual([])
  })
})
