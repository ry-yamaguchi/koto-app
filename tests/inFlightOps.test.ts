import { describe, it, expect, vi } from 'vitest'
import {
  sanitizeInFlightFile, adoptAtStartup, stoppedRunTimings, emptyInFlightFile,
  isStoppedByQuit, stoppedNextStep, stoppedWhenText, stoppedNoticeHeadline, isInFlightKey, STOPPED_OP_POLICY,
  type InFlightFile, type InFlightRun, type StoppedRun, type StoppedEntry, type StartupProbe,
} from '../src/shared/inFlightOps'

// ── 途中で止まった回の記録（in-flight-ops.json）の整え方・起動時の整理・時間・文（設計書 10.13・10.15）─────────────
// 純関数だけを、振る舞いで固定する（P1 整え方 / P2 起動時の整理 / P3 止まった回の時間 / P4 文と種類の表）。
// 時計は引数で渡す（`Date` に頼らない）。ファイルの読み書き・projectOps への配線は別の単位のテスト。

const DEDICATED = 'sakura-apprun-dedicated'
const T0 = Date.UTC(2026, 9, 12, 3, 0, 0)
const NOW = Date.UTC(2026, 9, 13, 0, 0, 0)
const MIN = 60_000
const DAY = 24 * 60 * MIN
const K = '/Users/yamada/Documents/projects/site'

const run = (over: Partial<InFlightRun> = {}): InFlightRun => ({
  op: '削除', target: DEDICATED, handler: 'apprunDedicated:teardown', version: '0.6.22',
  startedAt: T0, lastSeenAt: T0 + 5 * MIN, segments: [{ stage: 'teardown.lb', startedAt: T0 }], ...over,
})
const stoppedRun = (over: Partial<StoppedRun> = {}): StoppedRun => ({ ...run(), endedBy: 'quit', ...over })
const entry = (runs: StoppedRun[], over: Partial<StoppedEntry> = {}): StoppedEntry => ({
  op: '削除', target: DEDICATED, handler: 'apprunDedicated:teardown', runs, noticeSeen: false, ...over,
})
const file = (over: Partial<InFlightFile> = {}): InFlightFile => ({ v: 1, running: {}, stopped: {}, ...over })
const probe = (over: Partial<StartupProbe> = {}): StartupProbe => ({ exists: () => true, hasWork: () => true, ...over })
const seenAt = (ms: number) => stoppedRun({ startedAt: ms - 5 * MIN, lastSeenAt: ms })

describe('P1 sanitizeInFlightFile: 読んだ値を使える形にする（何が来ても落ちない・文は入れない）', () => {
  it('★ 正しい形はそのまま通る（往復）', () => {
    const f = file({
      running: { [K]: run({ segments: [{ stage: 'teardown.app', startedAt: T0, endedAt: T0 + 1000 }, { stage: 'teardown.lb', startedAt: T0 + 1000 }] }) },
      stopped: { '/p/other': entry([stoppedRun({ endedBy: 'unfinished' })], { noticeSeen: true }) },
    })
    expect(sanitizeInFlightFile(f)).toEqual(f)
    expect(sanitizeInFlightFile(JSON.parse(JSON.stringify(f)))).toEqual(f)
  })

  it('★ 壊れた形・オブジェクトでないもの・v が 1 でないものは、空の中身（落ちない）', () => {
    for (const bad of [null, undefined, 3, 'x', [], {}, { v: 2, running: { [K]: run() } }, { running: { [K]: run() } }, { v: '1' }]) {
      expect(sanitizeInFlightFile(bad), JSON.stringify(bad)).toEqual(emptyInFlightFile())
    }
    expect(sanitizeInFlightFile({ v: 1, running: 'x', stopped: [] })).toEqual(emptyInFlightFile())
  })

  it('★ 種類・公開先・ハンドラ名の形が違う回は捨てる（正しい回は残る）', () => {
    const f = sanitizeInFlightFile({ v: 1, running: {
      '/p/a': run(), '/p/b': { ...run(), op: '壊す' }, '/p/c': { ...run(), target: 'aws' },
      '/p/d': { ...run(), handler: 'bad handler!' }, '/p/e': { ...run(), handler: 'ハンドラ' }, '/p/f': { ...run(), handler: 3 },
      '/p/g': { ...run(), op: undefined }, '/p/h': null, '/p/i': 'x',
    }, stopped: {} })
    expect(Object.keys(f.running)).toEqual(['/p/a'])
  })

  it('空のハンドラ名（鍵を取るとき渡されなかった）は通る。公開先は 5つ＋unknown が通る', () => {
    expect(sanitizeInFlightFile({ v: 1, running: { '/p/a': run({ handler: '' }) }, stopped: {} }).running['/p/a'].handler).toBe('')
    const targets = ['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental', 'vercel', 'unknown']
    const running = Object.fromEntries(targets.map((t, i) => [`/p/${i}`, run({ target: t as any })]))
    expect(Object.keys(sanitizeInFlightFile({ v: 1, running, stopped: {} }).running)).toHaveLength(6)
  })

  it('★ handler・version は64文字に切る。version の形が違えば空。文字列でなければ空', () => {
    const f = sanitizeInFlightFile({ v: 1, running: {
      '/p/a': run({ handler: 'a'.repeat(100), version: 'v'.repeat(100) }),
      '/p/b': { ...run(), version: 'ver sion ！' }, '/p/c': { ...run(), version: 5 }, '/p/d': { ...run(), version: undefined },
    }, stopped: {} })
    expect(f.running['/p/a'].handler).toBe('a'.repeat(64))
    expect(f.running['/p/a'].version).toBe('v'.repeat(64))
    for (const k of ['/p/b', '/p/c', '/p/d']) expect(f.running[k].version, k).toBe('')
  })

  it('★ 時刻が負・巨大・数でない回は捨てる。区間の時刻が悪い区間と、段の名前の形が悪い区間は、その区間だけ捨てる', () => {
    const f = sanitizeInFlightFile({ v: 1, running: {
      '/p/a': { ...run(), startedAt: -1 }, '/p/b': { ...run(), lastSeenAt: 1e18 }, '/p/c': { ...run(), startedAt: '1' },
      '/p/d': { ...run(), lastSeenAt: NaN }, '/p/e': { ...run(), startedAt: Infinity },
      '/p/ok': run({ segments: [
        { stage: 'teardown.app', startedAt: T0, endedAt: T0 + 10 }, { stage: 'BAD NAME', startedAt: T0 }, { stage: 'teardown.lb', startedAt: -5 },
        { stage: 'teardown.asg', startedAt: T0, endedAt: -1 }, { stage: 'teardown.cluster', startedAt: 1e18 }, null as any, { startedAt: T0 } as any,
        { stage: 'teardown.storage', startedAt: T0 + 20 },
      ] }),
    }, stopped: {} })
    expect(Object.keys(f.running)).toEqual(['/p/ok'])
    expect(f.running['/p/ok'].segments).toEqual([
      { stage: 'teardown.app', startedAt: T0, endedAt: T0 + 10 }, { stage: 'teardown.storage', startedAt: T0 + 20 },
    ])
  })

  it('区間は50まで（多すぎるときは、いちばん新しい50を残す）', () => {
    const segments = Array.from({ length: 80 }, (_, i) => ({ stage: `a.s${i}`, startedAt: T0 + i }))
    const out = sanitizeInFlightFile({ v: 1, running: { [K]: run({ segments }) }, stopped: {} }).running[K].segments
    expect(out).toHaveLength(50)
    expect(out[0].stage).toBe('a.s30')
    expect(out[49].stage).toBe('a.s79')
  })

  it('★★ 鍵（プロジェクトのパス）: 相対パス・NUL を含む・4097文字は捨てる。長い実際のパスは切らずに残る', () => {
    const long = '/Users/yamada/Documents/projects/clients/2026/autumn-campaign/landing-site/long-project-name-for-the-shop'
    expect(long.length).toBeGreaterThan(100)
    const f = sanitizeInFlightFile({ v: 1, running: {
      'relative/path': run(), '': run(), 'C:\\Users\\x': run(), [`/p/nul\0x`]: run(),
      ['/' + 'a'.repeat(4096)]: run(), [long]: run(),
    }, stopped: { 'rel': entry([stoppedRun()]), [`/p/nul\0x`]: entry([stoppedRun()]), [long]: entry([stoppedRun()]) } })
    expect(Object.keys(f.running)).toEqual([long])
    expect(Object.keys(f.stopped)).toEqual([long])
    expect(isInFlightKey('/' + 'a'.repeat(4095))).toBe(true)
    expect(isInFlightKey('/' + 'a'.repeat(4096))).toBe(false)
  })

  it('★★ 先頭64文字が同じ2つの鍵は、2件のまま混ざらない（鍵を切ると同じ鍵になる＝掟11）', () => {
    const base = '/Users/yamada/Documents/projects/clients/2026/autumn-campaign/shops/'
    expect(base.length).toBeGreaterThanOrEqual(64)
    const a = `${base}shop-a`
    const b = `${base}shop-b`
    expect(a.slice(0, 64)).toBe(b.slice(0, 64))
    const f = sanitizeInFlightFile({ v: 1, running: { [a]: run({ startedAt: T0 }), [b]: run({ startedAt: T0 + 1 }) }, stopped: { [a]: entry([stoppedRun({ startedAt: T0 })]), [b]: entry([stoppedRun({ startedAt: T0 + 1 })]) } })
    expect(Object.keys(f.running).sort()).toEqual([a, b])
    expect(f.running[a].startedAt).toBe(T0)
    expect(f.running[b].startedAt).toBe(T0 + 1)
    expect(Object.keys(f.stopped).sort()).toEqual([a, b])
  })

  it('★ 止まった項目: 回は古い順に3つまで（いちばん新しい3つを残す）。endedBy が違う回・項目と種類や公開先が違う回は捨てる。回が無い項目は捨てる', () => {
    const runs = [5, 1, 4, 2, 3].map(n => stoppedRun({ startedAt: T0 + n * 1000, lastSeenAt: T0 + n * 1000 + 10 }))
    const f = sanitizeInFlightFile({ v: 1, running: {}, stopped: {
      '/p/a': entry(runs),
      '/p/b': entry([{ ...stoppedRun(), endedBy: 'crash' } as any]),
      '/p/c': entry([stoppedRun({ op: '公開' }), stoppedRun({ target: 'hanamii' }), stoppedRun({ startedAt: T0 + 7 })]),
      '/p/d': entry([]),
      '/p/e': { ...entry([stoppedRun()]), op: 'x' },
      '/p/f': { ...entry([stoppedRun()]), runs: 'x' },
    } })
    expect(f.stopped['/p/a'].runs.map(r => r.startedAt)).toEqual([T0 + 3000, T0 + 4000, T0 + 5000])
    expect(f.stopped['/p/c'].runs.map(r => r.startedAt)).toEqual([T0 + 7])
    expect(Object.keys(f.stopped).sort()).toEqual(['/p/a', '/p/c'])
  })

  it('noticeSeen は true のときだけ true（それ以外は false）', () => {
    const f = sanitizeInFlightFile({ v: 1, running: {}, stopped: {
      '/p/a': entry([stoppedRun()], { noticeSeen: true }), '/p/b': { ...entry([stoppedRun()]), noticeSeen: 'yes' }, '/p/c': { ...entry([stoppedRun()]), noticeSeen: undefined },
    } })
    expect([f.stopped['/p/a'].noticeSeen, f.stopped['/p/b'].noticeSeen, f.stopped['/p/c'].noticeSeen]).toEqual([true, false, false])
  })

  it('★ 止まった項目は20件まで（いちばん新しい lastSeenAt の古いものから捨てる）。走っている項目は100件まで', () => {
    const stopped = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`/p/${i}`, entry([seenAt(T0 + i * 1000)])]))
    const out = sanitizeInFlightFile({ v: 1, running: {}, stopped }).stopped
    expect(Object.keys(out)).toHaveLength(20)
    for (let i = 5; i < 25; i++) expect(out[`/p/${i}`], `p/${i}`).toBeDefined()
    for (let i = 0; i < 5; i++) expect(out[`/p/${i}`], `p/${i}`).toBeUndefined()
    const running = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`/p/${i}`, run({ lastSeenAt: T0 + i })]))
    expect(Object.keys(sanitizeInFlightFile({ v: 1, running, stopped: {} }).running)).toHaveLength(100)
  })

  it('★★ 文を入れない: 決まった項目以外（進み具合の文・メッセージ・URL・トークン）は写さない', () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const f = sanitizeInFlightFile({ v: 1, label: secret, running: { [K]: { ...run(), label: secret, detail: `https://user:pass@example.com/${secret}`, message: secret, zone: 'is1a', secrets: [secret], segments: [{ stage: 'teardown.lb', startedAt: T0, label: secret }] } },
      stopped: { [K]: { ...entry([{ ...stoppedRun(), message: secret }]), message: secret } } })
    expect(JSON.stringify(f)).not.toContain('ghp_')
    expect(JSON.stringify(f)).not.toContain('example.com')
    expect(Object.keys(f.running[K]).sort()).toEqual(['handler', 'lastSeenAt', 'op', 'segments', 'startedAt', 'target', 'version'])
    expect(Object.keys(f.running[K].segments[0]).sort()).toEqual(['stage', 'startedAt'])
    expect(Object.keys(f.stopped[K]).sort()).toEqual(['handler', 'noticeSeen', 'op', 'runs', 'target'])
    expect(Object.keys(f.stopped[K].runs[0]).sort()).toEqual(['endedBy', 'handler', 'lastSeenAt', 'op', 'segments', 'startedAt', 'target', 'version'])
  })

  it('入力を書き換えない', () => {
    const input = JSON.parse(JSON.stringify(file({ running: { [K]: run() }, stopped: { '/p/a': entry([stoppedRun()]) } })))
    const copy = JSON.parse(JSON.stringify(input))
    sanitizeInFlightFile(input)
    expect(input).toEqual(copy)
  })
})

describe('P2 adoptAtStartup: 起動したとき、走っていた記録を止まった回へ移し、要らないものを捨てる', () => {
  it('★ running の削除は、止まった回（quit）へ移る。running は空になる', () => {
    const r = run({ lastSeenAt: NOW - MIN })
    const out = adoptAtStartup(file({ running: { [K]: r } }), NOW, probe())
    expect(out).toEqual(file({ stopped: { [K]: entry([{ ...r, endedBy: 'quit' }]) } }))
    expect(out.running).toEqual({})
  })

  it('★ 同じ公開先・同じ種類の止まった項目があれば、回を後ろに足す。noticeSeen は false に戻る', () => {
    const old = stoppedRun({ startedAt: NOW - 3 * DAY, lastSeenAt: NOW - 3 * DAY + MIN, endedBy: 'unfinished' })
    const r = run({ startedAt: NOW - 2 * MIN, lastSeenAt: NOW - MIN, handler: 'apprunDedicated:teardown2' })
    const out = adoptAtStartup(file({ running: { [K]: r }, stopped: { [K]: entry([old], { noticeSeen: true }) } }), NOW, probe())
    expect(out.stopped[K].runs).toEqual([old, { ...r, endedBy: 'quit' }])
    expect(out.stopped[K].noticeSeen).toBe(false)
    expect(out.stopped[K].handler).toBe('apprunDedicated:teardown2')
  })

  it('★★ 回は3つまで（古い回から捨てる）', () => {
    const olds = [1, 2, 3].map(n => stoppedRun({ startedAt: NOW - (10 - n) * DAY, lastSeenAt: NOW - (10 - n) * DAY + MIN }))
    const r = run({ startedAt: NOW - 2 * MIN, lastSeenAt: NOW - MIN })
    const out = adoptAtStartup(file({ running: { [K]: r }, stopped: { [K]: entry(olds) } }), NOW, probe())
    expect(out.stopped[K].runs).toEqual([olds[1], olds[2], { ...r, endedBy: 'quit' }])
  })

  it('★★ 同じ startedAt の回は1つ（書き戻しに失敗して、次の起動でもう一度読んでも二重にならない）。「見た」も戻さない', () => {
    const r = run({ startedAt: NOW - 2 * MIN, lastSeenAt: NOW - MIN })
    const again = adoptAtStartup(file({ running: { [K]: r }, stopped: { [K]: entry([{ ...r, endedBy: 'quit' }], { noticeSeen: true }) } }), NOW, probe())
    expect(again.stopped[K].runs).toHaveLength(1)
    expect(again.stopped[K].noticeSeen).toBe(true)
    // 2回続けて同じ中身を渡しても、回は増えない
    const twice = adoptAtStartup(file({ running: { [K]: r } }), NOW, probe())
    const thrice = adoptAtStartup(file({ running: { [K]: r }, stopped: twice.stopped }), NOW, probe())
    expect(thrice.stopped[K].runs).toHaveLength(1)
  })

  it('★ 別の公開先の削除なら置き換える（新しいほうだけが残る・noticeSeen は false）', () => {
    const old = stoppedRun({ target: 'hanamii', handler: 'hanamii:teardown', lastSeenAt: NOW - DAY })
    const r = run({ lastSeenAt: NOW - MIN })
    const out = adoptAtStartup(file({ running: { [K]: r }, stopped: { [K]: entry([old], { target: 'hanamii', handler: 'hanamii:teardown', noticeSeen: true }) } }), NOW, probe())
    expect(out.stopped[K]).toEqual(entry([{ ...r, endedBy: 'quit' }]))
  })

  it('★★ 作成・公開の止まった回は捨てる（表どおり）。止まった削除があるプロジェクトへ公開・作成の回が来ても、止まった削除は残る', () => {
    const del = entry([stoppedRun({ lastSeenAt: NOW - DAY })], { noticeSeen: true })
    for (const op of ['公開', '作成'] as const) {
      const out = adoptAtStartup(file({ running: { [K]: run({ op, handler: 'apprunDedicated:publishApp', lastSeenAt: NOW - MIN }) }, stopped: { [K]: del } }), NOW, probe())
      expect(out.stopped[K], op).toEqual(del)
    }
    // 止まった削除が無いプロジェクトでは、何も残らない
    for (const op of ['公開', '作成'] as const) {
      expect(adoptAtStartup(file({ running: { [K]: run({ op, lastSeenAt: NOW - MIN }) } }), NOW, probe()), op).toEqual(emptyInFlightFile())
    }
    // 持つのは削除だけ（ファイルに作成・公開の止まった項目が紛れ込んでいても持たない）
    const stray = adoptAtStartup(file({ stopped: { [K]: entry([stoppedRun({ op: '公開', lastSeenAt: NOW - MIN })], { op: '公開' }) } }), NOW, probe())
    expect(stray).toEqual(emptyInFlightFile())
  })

  it('★★ 30日の境: 29日前は残る・30日ちょうどは残る・31日前は捨てる（いちばん新しい回で見る）', () => {
    const at = (ms: number) => adoptAtStartup(file({ stopped: { [K]: entry([seenAt(NOW - ms)]) } }), NOW, probe())
    expect(Object.keys(at(29 * DAY).stopped)).toEqual([K])
    expect(Object.keys(at(30 * DAY).stopped)).toEqual([K])
    expect(Object.keys(at(30 * DAY + 1).stopped)).toEqual([])
    expect(Object.keys(at(31 * DAY).stopped)).toEqual([])
    // 古い回と新しい回があれば、新しいほうで見る
    const mixed = entry([seenAt(NOW - 40 * DAY), seenAt(NOW - DAY)])
    expect(Object.keys(adoptAtStartup(file({ stopped: { [K]: mixed } }), NOW, probe()).stopped)).toEqual([K])
  })

  it('★ 時計のずれ: 最後に分かった時刻が今より5分以上先なら捨てる（4分59秒先は残る）', () => {
    const at = (ms: number) => adoptAtStartup(file({ stopped: { [K]: entry([seenAt(NOW + ms)]) } }), NOW, probe())
    expect(Object.keys(at(4 * MIN + 59_000).stopped)).toEqual([K])
    expect(Object.keys(at(5 * MIN).stopped)).toEqual([])
    expect(Object.keys(at(DAY).stopped)).toEqual([])
  })

  it('★ フォルダがもう無い（exists が false）なら捨てる。exists には鍵を渡す。無いフォルダには hasWork を聞かない', () => {
    const exists = vi.fn((k: string) => k !== '/p/gone')
    const hasWork = vi.fn(() => true)
    const out = adoptAtStartup(file({ stopped: { '/p/gone': entry([seenAt(NOW - MIN)]), '/p/here': entry([seenAt(NOW - MIN)]) } }), NOW, probe({ exists, hasWork }))
    expect(Object.keys(out.stopped)).toEqual(['/p/here'])
    expect(exists.mock.calls.map(c => c[0]).sort()).toEqual(['/p/gone', '/p/here'])
    expect(hasWork.mock.calls).toEqual([['/p/here', DEDICATED]])
  })

  it('★★ 続けるものが無い（hasWork が false）なら捨てる。true なら残る。hasWork には鍵と公開先を渡す', () => {
    const hasWork = vi.fn((k: string) => k === '/p/work')
    const out = adoptAtStartup(file({ running: { '/p/none': run({ lastSeenAt: NOW - MIN }) }, stopped: {
      '/p/work': entry([seenAt(NOW - MIN)]), '/p/hana': entry([{ ...seenAt(NOW - MIN), target: 'hanamii' }], { target: 'hanamii' }),
    } }), NOW, probe({ hasWork }))
    expect(Object.keys(out.stopped)).toEqual(['/p/work'])
    expect(hasWork.mock.calls.sort()).toEqual([['/p/hana', 'hanamii'], ['/p/none', DEDICATED], ['/p/work', DEDICATED]])
  })

  it('exists・hasWork が投げても投げない。その項目は残す側に倒す', () => {
    const out = adoptAtStartup(file({ stopped: { '/p/a': entry([seenAt(NOW - MIN)]), '/p/b': entry([seenAt(NOW - MIN)]) } }), NOW, probe({
      exists: (k) => { if (k === '/p/a') throw new Error('io'); return true },
      hasWork: (k) => { if (k === '/p/b') throw new Error('io'); return true },
    }))
    expect(Object.keys(out.stopped).sort()).toEqual(['/p/a', '/p/b'])
  })

  it('★ 止まった項目は20件まで（いちばん新しい回が新しいものを残す）', () => {
    const stopped = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`/p/${i}`, entry([seenAt(NOW - (30 - i) * MIN)])]))
    const out = adoptAtStartup(file({ stopped }), NOW, probe())
    expect(Object.keys(out.stopped)).toHaveLength(20)
    expect(out.stopped['/p/3']).toBeUndefined()
    expect(out.stopped['/p/4']).toBeDefined()
    expect(out.stopped['/p/23']).toBeDefined()
  })

  it('★ すでに20件ある所へ止まった回が1件加わると、いちばん古い項目が押し出される（20件のまま）', () => {
    const stopped = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/p/${i}`, entry([seenAt(NOW - (60 - i) * MIN)])]))
    const out = adoptAtStartup(file({ running: { '/p/new': run({ lastSeenAt: NOW - MIN }) }, stopped }), NOW, probe())
    expect(Object.keys(out.stopped)).toHaveLength(20)
    expect(out.stopped['/p/new']).toBeDefined()
    expect(out.stopped['/p/0']).toBeUndefined()
    expect(out.stopped['/p/1']).toBeDefined()
  })

  it('版が違う回も、知らない段の名前もそのまま持つ', () => {
    const r = run({ version: '0.5.0', lastSeenAt: NOW - MIN, segments: [{ stage: 'future.stage', startedAt: T0 }] })
    expect(adoptAtStartup(file({ running: { [K]: r } }), NOW, probe()).stopped[K].runs[0]).toEqual({ ...r, endedBy: 'quit' })
  })

  it('前から止まっていた項目も、起動のたびに30日・フォルダ・続ける物で確かめ直す', () => {
    const f = file({ stopped: { '/p/old': entry([seenAt(NOW - 40 * DAY)]), '/p/ok': entry([seenAt(NOW - DAY)]) } })
    expect(Object.keys(adoptAtStartup(f, NOW, probe()).stopped)).toEqual(['/p/ok'])
    expect(adoptAtStartup(adoptAtStartup(f, NOW, probe()), NOW, probe())).toEqual(adoptAtStartup(f, NOW, probe()))
  })

  it('壊れた中身を渡しても落ちない（空から始まる）。入力を書き換えない', () => {
    expect(adoptAtStartup(null, NOW, probe())).toEqual(emptyInFlightFile())
    expect(adoptAtStartup({ v: 9 }, NOW, probe())).toEqual(emptyInFlightFile())
    const input = JSON.parse(JSON.stringify(file({ running: { [K]: run({ lastSeenAt: NOW - MIN }) }, stopped: { '/p/a': entry([seenAt(NOW - MIN)]) } })))
    const copy = JSON.parse(JSON.stringify(input))
    adoptAtStartup(input, NOW, probe())
    expect(input).toEqual(copy)
  })
})

describe('P3 stoppedRunTimings: 止まった回の段ごとの時間', () => {
  const S = 1000

  it('★ 閉じた区間はその長さ、最後の開いた区間は最後に分かった時刻まで。partialLast・knownMs・endedBy を写す', () => {
    const t = stoppedRunTimings(stoppedRun({
      startedAt: T0, lastSeenAt: T0 + 72 * S + 308 * S,
      segments: [{ stage: 'teardown.app', startedAt: T0 + 1 * S, endedAt: T0 + 73 * S }, { stage: 'teardown.lb', startedAt: T0 + 73 * S }],
    }))
    expect(t).toEqual({
      startedAt: T0, lastKnownAt: T0 + 380 * S, endedBy: 'quit', knownMs: 380 * S,
      stages: [{ stage: 'teardown.app', ms: 72 * S }, { stage: 'teardown.lb', ms: 307 * S }], partialLast: true,
    })
  })

  it('★ 同じ段に2回入ったら足す。途中の段に戻っていても、「途中まで」の段が最後の行になる', () => {
    const t = stoppedRunTimings(stoppedRun({
      startedAt: T0, lastSeenAt: T0 + 9 * S,
      segments: [
        { stage: 'teardown.asg', startedAt: T0, endedAt: T0 + 1 * S },
        { stage: 'teardown.lb', startedAt: T0 + 1 * S, endedAt: T0 + 4 * S },
        { stage: 'teardown.asg', startedAt: T0 + 4 * S },
      ],
    }))
    expect(t!.stages).toEqual([{ stage: 'teardown.lb', ms: 3 * S }, { stage: 'teardown.asg', ms: 6 * S }])
    expect(t!.partialLast).toBe(true)
    // 閉じた区間だけが同じ段に2回あるときは、最初に入った順のまま足す
    const closed = stoppedRunTimings(stoppedRun({
      lastSeenAt: T0 + 9 * S,
      segments: [
        { stage: 'teardown.asg', startedAt: T0, endedAt: T0 + 1 * S }, { stage: 'teardown.lb', startedAt: T0 + 1 * S, endedAt: T0 + 4 * S },
        { stage: 'teardown.asg', startedAt: T0 + 4 * S, endedAt: T0 + 6 * S },
      ],
    }))
    expect(closed!.stages).toEqual([{ stage: 'teardown.asg', ms: 3 * S }, { stage: 'teardown.lb', ms: 3 * S }])
    expect(closed!.partialLast).toBe(false)
  })

  it('★ 段が1つも無い回は null（何に使った時間か分からないものを足さない）。形の合わない段の名前だけの回も null', () => {
    expect(stoppedRunTimings(stoppedRun({ segments: [] }))).toBeNull()
    expect(stoppedRunTimings(stoppedRun({ segments: [{ stage: 'BAD NAME', startedAt: T0 }] }))).toBeNull()
    expect(stoppedRunTimings(stoppedRun({ endedBy: 'unfinished', segments: [] }))).toBeNull()
  })

  it('★ 最後に分かった時刻が始まりより前（時計のずれ）は 0 にする（負にならない）', () => {
    const t = stoppedRunTimings(stoppedRun({ startedAt: T0, lastSeenAt: T0 - 5 * S, segments: [{ stage: 'teardown.lb', startedAt: T0 }] }))
    expect(t!.knownMs).toBe(0)
    expect(t!.stages).toEqual([{ stage: 'teardown.lb', ms: 0 }])
    expect(t!.partialLast).toBe(false)
    const closed = stoppedRunTimings(stoppedRun({ segments: [{ stage: 'teardown.lb', startedAt: T0 + 10, endedAt: T0 }] }))
    expect(closed!.stages).toEqual([{ stage: 'teardown.lb', ms: 0 }])
  })

  it('★ partialLast: 開いた区間が1ミリ秒以上経っていれば true。段の切り替えの直後（0ミリ秒）に止まった回と、最後の区間が閉じた回は false', () => {
    const open = (lastSeenAt: number) => stoppedRunTimings(stoppedRun({ startedAt: T0, lastSeenAt, segments: [{ stage: 'teardown.app', startedAt: T0, endedAt: T0 + 5 * S }, { stage: 'teardown.lb', startedAt: T0 + 5 * S }] }))
    expect(open(T0 + 5 * S + 1)!.partialLast).toBe(true)
    expect(open(T0 + 5 * S)!.partialLast).toBe(false)
    expect(open(T0 + 5 * S)!.stages).toEqual([{ stage: 'teardown.app', ms: 5 * S }, { stage: 'teardown.lb', ms: 0 }])
    const closedLast = stoppedRunTimings(stoppedRun({ lastSeenAt: T0 + 9 * S, segments: [{ stage: 'teardown.app', startedAt: T0, endedAt: T0 + 5 * S }] }))
    expect(closedLast!.partialLast).toBe(false)
  })

  it('★ 待ち切れた回（unfinished）は、最後の段が時間切れで終わったので partialLast がいつも true。endedBy を写す', () => {
    const t = stoppedRunTimings(stoppedRun({
      endedBy: 'unfinished', startedAt: T0, lastSeenAt: T0 + 600 * S,
      segments: [{ stage: 'teardown.app', startedAt: T0, endedAt: T0 + 5 * S }, { stage: 'teardown.lb', startedAt: T0 + 5 * S, endedAt: T0 + 600 * S }],
    }))
    expect(t).toEqual({
      startedAt: T0, lastKnownAt: T0 + 600 * S, endedBy: 'unfinished', knownMs: 600 * S,
      stages: [{ stage: 'teardown.app', ms: 5 * S }, { stage: 'teardown.lb', ms: 595 * S }], partialLast: true,
    })
  })

  it('入力を書き換えない', () => {
    const r = stoppedRun({ segments: [{ stage: 'teardown.asg', startedAt: T0, endedAt: T0 + S }, { stage: 'teardown.lb', startedAt: T0 + S, endedAt: T0 + 2 * S }, { stage: 'teardown.asg', startedAt: T0 + 2 * S }] })
    const copy = JSON.parse(JSON.stringify(r))
    stoppedRunTimings(r)
    expect(r).toEqual(copy)
  })
})

describe('P4 文・判定・種類の表', () => {
  it('★ STOPPED_OP_POLICY: 持つのは削除だけ（書き下して比べる）', () => {
    expect(STOPPED_OP_POLICY).toEqual({ 削除: 'keep', 作成: 'drop', 公開: 'drop' })
  })

  it('★ stoppedNextStep: 専有型は続きから進むと言う。共用型・HANAMII・そのほかは確かめていないので言わない', () => {
    expect(stoppedNextStep('sakura-apprun-dedicated')).toBe('もう一度削除を押すと、続きから進みます。')
    for (const t of ['sakura-apprun', 'hanamii', 'vercel', 'sakura-rental', 'unknown', '']) {
      expect(stoppedNextStep(t), t).toBe('どこまで済んだか管理画面で確かめてから、もう一度破棄を押してください。')
      expect(stoppedNextStep(t), t).not.toContain('続きから')
    }
  })

  it('★ isStoppedByQuit: extra.stoppedByQuit が true のときだけ true（偽の知らせにならない）', () => {
    expect(isStoppedByQuit({ ok: false, message: 'x', extra: { stoppedByQuit: true } })).toBe(true)
    for (const bad of [null, undefined, 'x', 3, [], {}, { extra: {} }, { extra: null }, { extra: { stoppedByQuit: false } }, { extra: { stoppedByQuit: 'true' } }, { extra: { stoppedByQuit: 1 } }, { stoppedByQuit: true }]) {
      expect(isStoppedByQuit(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('★ stoppedWhenText: 「HH:MM ごろ、Koto の終了で止まりました」。時刻が読めなければ時刻なし', () => {
    expect(stoppedWhenText(new Date(2026, 9, 10, 14, 9).getTime())).toBe('14:09 ごろ、Koto の終了で止まりました')
    expect(stoppedWhenText(new Date(2026, 9, 10, 7, 5).getTime())).toBe('07:05 ごろ、Koto の終了で止まりました')
    for (const bad of [NaN, undefined, null, 'x', {}]) expect(stoppedWhenText(bad), String(bad)).toBe('Koto の終了で止まりました')
  })

  it('★ stoppedNoticeHeadline: 「〇〇は、Koto の終了で止まりました（HH:MM ごろ）」。時刻が読めなければ括弧ごと省く。「に終わりました」は言わない', () => {
    expect(stoppedNoticeHeadline('削除', new Date(2026, 9, 10, 14, 9).getTime())).toBe('削除は、Koto の終了で止まりました（14:09 ごろ）')
    expect(stoppedNoticeHeadline('破棄', new Date(2026, 9, 10, 7, 5).getTime())).toBe('破棄は、Koto の終了で止まりました（07:05 ごろ）')
    for (const bad of [NaN, undefined, null, 'x', {}]) expect(stoppedNoticeHeadline('削除', bad), String(bad)).toBe('削除は、Koto の終了で止まりました')
    expect(stoppedNoticeHeadline('削除')).not.toContain('に終わりました')
  })
})
