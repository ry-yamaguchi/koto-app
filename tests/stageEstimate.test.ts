import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { STAGE, ALL_STAGES } from '../src/shared/stageTiming'
import {
  ESTIMATE_RECENT, KEEP_PER_STAGE, DEV_MEASURES,
  emptyStore, sanitizeStore, appendSamples, medianOf, recentSamples, estimateForStage, estimatesFor,
  approxDurationText, estimateText, estimateLineFor, readEstimate,
  type StageTimingStore, type StageSample,
} from '../src/shared/stageEstimate'

// ── 段ごとの「目安」と、記録の持ち方（2026-10-07・作者の決定）──────────────────────────────────
// 目安は、最初は開発時の実測（測った段だけ・測っていない段には出さない）。この Mac で一度でも測れたら、
// その段の最近5回の中央値（成功した回だけ数える）。記録は段ごとに最近10件まで。壊れた記録でも落ちない。
// ここは純関数（ファイルに触らない）。ファイルの読み書きは tests/stageTimingStore.test.ts。

/** n 日目の 12:00 に終わった1回ぶんの記録（古い順に並べやすいよう日付を変える）。 */
const sample = (ms: number, day = 1, zone: string | null = 'is1a'): StageSample => ({
  ms, at: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`, version: '0.6.21', zone,
})
const storeOf = (stage: string, list: StageSample[]): StageTimingStore => ({ v: 1, stages: { [stage]: list } })
const LB = STAGE.teardownLb

describe('medianOf: 中央値', () => {
  it('★ 奇数件は真ん中の値', () => { expect(medianOf([30, 10, 20])).toBe(20) })
  it('★ 偶数件は真ん中の2つの平均', () => { expect(medianOf([10, 20, 30, 40])).toBe(25) })
  it('★ 1件はその値', () => { expect(medianOf([7])).toBe(7) })
  it('偶数件の平均は整数に丸める', () => { expect(medianOf([1, 2])).toBe(2) })
  it('空・有限でない値だけのときは null（落ちない）', () => {
    expect(medianOf([])).toBeNull()
    expect(medianOf([NaN, Infinity])).toBeNull()
  })
  it('並べ替えても元の配列を変えない', () => {
    const xs = [3, 1, 2]
    medianOf(xs)
    expect(xs).toEqual([3, 1, 2])
  })
})

describe('estimateForStage: この Mac の記録 → 開発時の実測 → 無し', () => {
  it('★ この Mac の記録が1件以上あれば、そちらが優先（件数つき）。開発時の実測（約9分）には戻らない', () => {
    const e = estimateForStage(LB, storeOf(LB, [sample(8 * 60_000)]))
    expect(e).toEqual({ kind: 'local', ms: 8 * 60_000, count: 1 })
  })

  it('★ 最近5件の中央値。古い6件目以前は数えない', () => {
    // 古い順に 100, 100, 100（古い3件・外れ値）, そのあと 10, 20, 30, 40, 50（最近5件）
    const list = [sample(100, 1), sample(100, 2), sample(100, 3), sample(10, 4), sample(20, 5), sample(30, 6), sample(40, 7), sample(50, 8)]
    const e = estimateForStage(LB, storeOf(LB, list))
    expect(e).toEqual({ kind: 'local', ms: 30, count: ESTIMATE_RECENT })
    expect(ESTIMATE_RECENT).toBe(5)
  })

  it('★ 件数が5に満たないときは、ある分だけ（3件なら3件の中央値・件数も3）', () => {
    const e = estimateForStage(LB, storeOf(LB, [sample(10, 1), sample(30, 2), sample(20, 3)]))
    expect(e).toEqual({ kind: 'local', ms: 20, count: 3 })
  })

  it('偶数件（4件）は真ん中の2つの平均', () => {
    const e = estimateForStage(LB, storeOf(LB, [sample(10, 1), sample(20, 2), sample(30, 3), sample(40, 4)]))
    expect(e).toEqual({ kind: 'local', ms: 25, count: 4 })
  })

  it('「最近」は日付で決める。保存の並びが崩れていても、日付の新しい5件を使う', () => {
    const shuffled = [sample(50, 8), sample(100, 1), sample(10, 4), sample(100, 2), sample(40, 7), sample(20, 5), sample(100, 3), sample(30, 6)]
    expect(estimateForStage(LB, storeOf(LB, shuffled))).toEqual({ kind: 'local', ms: 30, count: 5 })
  })

  it('ゾーンでは分けない（別のゾーンの記録も同じ段として数える）', () => {
    const e = estimateForStage(LB, storeOf(LB, [sample(10, 1, 'is1a'), sample(30, 2, 'tk1b'), sample(20, 3, null)]))
    expect(e).toEqual({ kind: 'local', ms: 20, count: 3 })
  })

  it('★ この Mac の記録が無い段は、開発時の実測（原本に数字がある段だけ・出典の日付つき）', () => {
    expect(estimateForStage(LB, emptyStore())).toEqual({ kind: 'dev', ms: 9 * 60_000, note: null, date: '2026-09-10' })
    expect(estimateForStage(STAGE.publishLbAddress, emptyStore())).toEqual({ kind: 'dev', ms: null, note: '数分', date: '2026-09-16' })
    expect(estimateForStage(STAGE.teardownAsg, emptyStore())).toEqual({ kind: 'dev', ms: null, note: '数分', date: '2026-09-10' })
  })

  it('★★ どちらも無い段は null（測っていない段に目安を作らない）', () => {
    for (const s of ALL_STAGES) {
      if (s.id in DEV_MEASURES) continue
      expect(estimateForStage(s.id, emptyStore()), `${s.id} に目安がある`).toBeNull()
    }
    expect(estimateForStage('unknown.stage', emptyStore())).toBeNull()
  })

  it('別の段の記録は混ざらない（teardown.lb の記録が teardown.asg・teardown.cluster の目安にならない）', () => {
    const store = storeOf(LB, [sample(8 * 60_000)])
    expect(estimateForStage(STAGE.teardownAsg, store)).toEqual({ kind: 'dev', ms: null, note: '数分', date: '2026-09-10' }) // 開発時の実測のまま
    expect(estimateForStage(STAGE.teardownCluster, store)).toBeNull()
  })

  it('段の名前が Object の継承プロパティでも落ちない', () => {
    expect(estimateForStage('constructor', emptyStore())).toBeNull()
    expect(estimateForStage('toString', emptyStore())).toBeNull()
  })

  it('開発時の実測の表は、差し替えられる（テストで別の表を渡せる）', () => {
    expect(estimateForStage('x.y', emptyStore(), { 'x.y': { minutes: 2, date: '2026-01-02', source: 's', basis: 'b' } })).toEqual({ kind: 'dev', ms: 120_000, note: null, date: '2026-01-02' })
    expect(estimateForStage('x.y', emptyStore(), { 'x.y': { note: '少し', date: '2026-01-02', source: 's', basis: 'b' } })).toEqual({ kind: 'dev', ms: null, note: '少し', date: '2026-01-02' })
    expect(estimateForStage('x.y', emptyStore(), { 'x.y': { date: '2026-01-02', source: 's', basis: 'b' } })).toBeNull()
    expect(estimateForStage('x.y', emptyStore(), { 'x.y': { minutes: 0, date: '2026-01-02', source: 's', basis: 'b' } })).toBeNull()
  })
})

describe('開発時の実測の表は、原本（docs）に数字がある段だけ', () => {
  it('★ 持っているのは teardown.lb（約9分・2026-09-10）・teardown.asg（「数分」・2026-09-10）・publish.lb-address（「数分」・2026-09-16）の3つだけ', () => {
    expect(Object.keys(DEV_MEASURES).sort()).toEqual(['publish.lb-address', 'teardown.asg', 'teardown.lb'])
    expect(DEV_MEASURES['teardown.lb']).toMatchObject({ minutes: 9, date: '2026-09-10' })
    expect(DEV_MEASURES['teardown.asg']).toMatchObject({ note: '数分', date: '2026-09-10' })
    expect(DEV_MEASURES['publish.lb-address']).toMatchObject({ note: '数分', date: '2026-09-16' })
    expect(DEV_MEASURES['teardown.asg'].minutes).toBeUndefined() // 分数は測っていない＝数字にしない
    expect(DEV_MEASURES['publish.lb-address'].minutes).toBeUndefined() // 付くまでの分数は測っていない＝数字にしない
  })

  it('★ どの数字も「何を測ったものか」（basis）を持つ。IP の「数分」は、この段だけの所要ではなく「クラスタ作成からの経過」と明記してある（2026-10-07 検分の指摘5）', () => {
    for (const [id, m] of Object.entries(DEV_MEASURES)) expect(m.basis.length, `${id} の basis が空`).toBeGreaterThan(10)
    expect(DEV_MEASURES['publish.lb-address'].basis).toContain('クラスタ作成からの経過')
    expect(DEV_MEASURES['publish.lb-address'].basis).toContain('この段だけの所要時間ではない')
  })

  it('出典の原本に、その実測が書いてある（docs/apprun-dedicated-plan.md）', () => {
    const plan = fs.readFileSync(path.join(__dirname, '../docs/apprun-dedicated-plan.md'), 'utf-8')
    expect(plan).toContain('### 5-11.')
    expect(plan).toContain('2026-09-10')
    expect(plan).toContain('LB は約9分で消滅')
    expect(plan).toContain('### 5-13.')
    expect(plan).toContain('2026-09-16')
    expect(plan).toContain('クラスタ作成の約2分後は空・数分後には付いていた')
    expect(plan).toContain('ASG を削除（削除中が数分）') // teardown.asg の「数分」
  })
})

describe('appendSamples: 段ごとに最近10件まで（古いものから捨てる）', () => {
  const entry = (ms: number, day: number) => ({ at: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`, version: '0.6.21', zone: 'is1a', stages: [{ stage: LB, ms }] })

  it('★ 11件目を足すと、いちばん古い1件が消えて10件', () => {
    let s = emptyStore()
    for (let d = 1; d <= 11; d++) s = appendSamples(s, entry(d * 1000, d))
    expect(KEEP_PER_STAGE).toBe(10)
    expect(s.stages[LB].length).toBe(10)
    expect(s.stages[LB][0].ms).toBe(2000) // 1日目（1000）が捨てられた
    expect(s.stages[LB][9].ms).toBe(11_000)
  })

  it('★ 12件足しても10件。残るのは新しい10件', () => {
    let s = emptyStore()
    for (let d = 1; d <= 12; d++) s = appendSamples(s, entry(d * 1000, d))
    expect(s.stages[LB].map(x => x.ms)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => n * 1000))
  })

  it('元の store を変えない（新しい store を返す）', () => {
    const base = storeOf(LB, [sample(1000, 1)])
    const next = appendSamples(base, entry(2000, 2))
    expect(base.stages[LB].length).toBe(1)
    expect(next.stages[LB].length).toBe(2)
  })

  it('1回の操作の複数の段を、それぞれの段の記録へ足す。持つのは { ms, at, version, zone } だけ', () => {
    const s = appendSamples(emptyStore(), {
      at: '2026-10-07T01:02:03.000Z', version: '0.6.21', zone: 'tk1b',
      stages: [{ stage: STAGE.teardownApp, ms: 4000 }, { stage: STAGE.teardownLb, ms: 540_000 }],
    })
    expect(Object.keys(s.stages).sort()).toEqual(['teardown.app', 'teardown.lb'])
    expect(s.stages['teardown.lb']).toEqual([{ ms: 540_000, at: '2026-10-07T01:02:03.000Z', version: '0.6.21', zone: 'tk1b' }])
    expect(Object.keys(s.stages['teardown.lb'][0]).sort()).toEqual(['at', 'ms', 'version', 'zone'])
  })

  it('形の合わない行（名前・時間）は足さない。時刻が読めない記録は足さない', () => {
    const s = appendSamples(emptyStore(), {
      at: '2026-10-07T00:00:00.000Z', version: 'v', zone: null,
      stages: [{ stage: 'BAD NAME', ms: 5 }, { stage: 'a.neg', ms: -1 }, { stage: 'a.nan', ms: NaN }, { stage: 'a.ok', ms: 10 }],
    })
    expect(Object.keys(s.stages)).toEqual(['a.ok'])
    expect(Object.keys(appendSamples(emptyStore(), { at: 'いつか', version: 'v', zone: null, stages: [{ stage: 'a.ok', ms: 1 }] }).stages)).toEqual([])
  })

  it('既に上限を超えている store に足しても10件に収まる', () => {
    const big = storeOf(LB, Array.from({ length: 14 }, (_, i) => sample(i, i + 1)))
    expect(appendSamples(big, entry(99, 20)).stages[LB].length).toBe(10)
  })

  it('段の名前が Object の継承プロパティでも落ちない', () => {
    const s = appendSamples(emptyStore(), { at: '2026-10-07T00:00:00.000Z', version: 'v', zone: null, stages: [{ stage: 'constructor', ms: 5 }] })
    expect(s.stages['constructor']).toHaveLength(1)
  })
})

describe('sanitizeStore: 壊れた記録でも落ちない（空として扱う）', () => {
  it.each([null, undefined, 3, 'x', [], {}, { stages: null }, { stages: [] }, { stages: 'x' }, { v: 1 }])('%j → 空', (bad) => {
    expect(sanitizeStore(bad)).toEqual(emptyStore())
  })

  it('★ 使える記録だけ残す: 形の合わない記録・名前は捨てる', () => {
    const s = sanitizeStore({ v: 1, stages: {
      [LB]: [sample(1000, 1), { ms: 'x', at: '2026-10-01T00:00:00Z' }, null, { ms: 5, at: 'いつか' }, { ms: -1, at: '2026-10-01T00:00:00Z' }, sample(2000, 2)],
      'BAD NAME': [sample(1, 1)],
      'a.notlist': 'x',
    } })
    expect(Object.keys(s.stages)).toEqual([LB])
    expect(s.stages[LB].map(x => x.ms)).toEqual([1000, 2000])
  })

  it('★ 上限を超えて入っていても、読むときに新しい10件へ収める', () => {
    const s = sanitizeStore({ v: 1, stages: { [LB]: Array.from({ length: 25 }, (_, i) => sample(i + 1, (i % 28) + 1)) } })
    expect(s.stages[LB].length).toBe(10)
  })

  it('余計な項目（秘密になりうるもの）は読み込んだ時点で落ちる: 持つのは { ms, at, version, zone } だけ', () => {
    const s = sanitizeStore({ v: 1, stages: { [LB]: [{ ...sample(1000, 1), projectDir: '/Users/x/secret', token: 'abc' }] } })
    expect(Object.keys(s.stages[LB][0]).sort()).toEqual(['at', 'ms', 'version', 'zone'])
  })
})

describe('recentSamples', () => {
  it('古い順に並べて、新しい n 件を返す', () => {
    expect(recentSamples([sample(3, 3), sample(1, 1), sample(2, 2)], 2).map(x => x.ms)).toEqual([2, 3])
  })
})

describe('画面に出す目安の文', () => {
  it.each([
    [500, '約1秒'], [29_000, '約29秒'], [59_000, '約59秒'], [60_000, '約1分'], [8 * 60_000, '約8分'],
    [8.4 * 60_000, '約8分'], [8.6 * 60_000, '約9分'], [59.4 * 60_000, '約59分'], [60 * 60_000, '約1時間'], [80 * 60_000, '約1時間20分'],
  ])('approxDurationText(%i) → %s', (ms, text) => { expect(approxDurationText(ms)).toBe(text) })

  it('★ この Mac の記録: 「目安 約8分（この Mac での最近3回の中央値）」', () => {
    expect(estimateText({ kind: 'local', ms: 8 * 60_000, count: 3 })).toBe('目安 約8分（この Mac での最近3回の中央値）')
    expect(estimateText({ kind: 'local', ms: 8 * 60_000, count: 5 })).toBe('目安 約8分（この Mac での最近5回の中央値）')
  })
  it('この Mac の記録が1件だけのときは「中央値」と言わず「前回の実測」', () => {
    expect(estimateText({ kind: 'local', ms: 8 * 60_000, count: 1 })).toBe('目安 約8分（この Mac での前回の実測）')
  })
  it('★ 開発時の実測: 「目安 約9分（開発時の実測・2026-09-10）」。数字が無いときは原本の言葉のまま「数分」', () => {
    expect(estimateText({ kind: 'dev', ms: 9 * 60_000, note: null, date: '2026-09-10' })).toBe('目安 約9分（開発時の実測・2026-09-10）')
    expect(estimateText({ kind: 'dev', ms: null, note: '数分', date: '2026-09-16' })).toBe('目安 数分（開発時の実測・2026-09-16）')
  })
  it('実際の表から作った文（記録が無いとき）', () => {
    expect(estimateText(estimateForStage(STAGE.teardownLb, emptyStore())!)).toBe('目安 約9分（開発時の実測・2026-09-10）')
    expect(estimateText(estimateForStage(STAGE.publishLbAddress, emptyStore())!)).toBe('目安 数分（開発時の実測・2026-09-16）')
  })
})

describe('estimatesFor / estimateLineFor / readEstimate（画面が1回の問い合わせで読む）', () => {
  it('★ 目安のある段だけが入る（測っていない段は入らない）', () => {
    const e = estimatesFor(emptyStore())
    expect(Object.keys(e).sort()).toEqual(['publish.lb-address', 'teardown.asg', 'teardown.lb'])
    const e2 = estimatesFor(storeOf(STAGE.createLb, [sample(60_000)]))
    expect(Object.keys(e2).sort()).toEqual(['create.lb', 'publish.lb-address', 'teardown.asg', 'teardown.lb'])
    expect(e2['create.lb']).toEqual({ kind: 'local', ms: 60_000, count: 1 })
  })

  it('★ estimateLineFor: 待っている段の目安の一文。段が分からない・一覧に無い・形が違うときは null（何も出さない）', () => {
    const raw = JSON.parse(JSON.stringify(estimatesFor(emptyStore())))
    expect(estimateLineFor(STAGE.teardownLb, raw)).toBe('目安 約9分（開発時の実測・2026-09-10）')
    expect(estimateLineFor(STAGE.teardownAsg, raw)).toBe('目安 数分（開発時の実測・2026-09-10）')
    expect(estimateLineFor(STAGE.teardownCluster, raw)).toBeNull()
    for (const stage of [null, undefined, '']) expect(estimateLineFor(stage as any, raw)).toBeNull()
    for (const bad of [null, undefined, 3, 'x', [], { 'teardown.lb': 'x' }, { 'teardown.lb': { kind: 'local', ms: -1, count: 1 } }, { 'teardown.lb': { kind: 'dev' } }]) {
      expect(estimateLineFor(STAGE.teardownLb, bad), JSON.stringify(bad)).toBeNull()
    }
    expect(estimateLineFor('constructor', {})).toBeNull()
  })

  it('readEstimate: IPC の返り値を信用しない', () => {
    expect(readEstimate({ kind: 'local', ms: 10, count: 2 })).toEqual({ kind: 'local', ms: 10, count: 2 })
    expect(readEstimate({ kind: 'local', ms: 10, count: 0 })).toBeNull()
    expect(readEstimate({ kind: 'dev', ms: null, note: '数分', date: '2026-09-16' })).toEqual({ kind: 'dev', ms: null, note: '数分', date: '2026-09-16' })
    expect(readEstimate({ kind: 'dev', ms: null, note: null, date: '2026-09-16' })).toBeNull()
    expect(readEstimate({ kind: 'other' })).toBeNull()
    expect(readEstimate(null)).toBeNull()
  })
})
