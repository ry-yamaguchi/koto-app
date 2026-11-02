import { describe, it, expect } from 'vitest'
import { buildTeardownConfirm, keptAlongsideRemoved } from '../src/renderer/teardown/confirm'
import { sharedTeardownSpec, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec } from '../src/renderer/teardown/targets/dedicated'
import type { TeardownFacts, TeardownPlacement } from '../src/renderer/teardown/types'

// ── 0.6.25: 消す保存場所と消さない保存場所が混じる確認 ───────────────────────────────────────────────────────────────
//  1. 消さない側の月額: 費用の行は消す側だけを言うので、混じる回だけ、消さない側の 💾 に既存の括弧「（消すまで月額が続きます）」を付ける。
//     全部消さない回は費用の行が言うので括弧を付けない（同じ事実を2回言わない）。keep の無い入力は変わらない。3つの公開先すべて。
//  2. 設定から外した保存場所（state にだけある）の「削除します」の注意: 同じバケットの別の prefix の一方だけ keep のときは、
//     もう一方は消すので、注意を残す（名前と prefix の組で全部 keep のときだけ外す）。
// 期待の文は関数を通さず書き下す（関数を写した期待は、関数が壊れても通る）。

const TWIN = { risk: 'twin' as const, folders: ['rc24-h2'] }
const UNREAD = { risk: 'unread' as const, folders: ['rc24-x'] }
const KEPT_TWIN: TeardownPlacement = { bucket: 'koto-rc24-1028', prefix: 'projects/rc24-h/', shared: true, keep: TWIN }
const KEPT_UNREAD: TeardownPlacement = { bucket: 'koto-kept-2', prefix: 'projects/rc24-h/', shared: true, keep: UNREAD }
const GONE: TeardownPlacement = { bucket: 'koto-other', prefix: 'projects/rc24-h/', shared: false }

const NOTE_TWIN = '保存場所『koto-rc24-1028』とその中のデータは残ります。フォルダ『rc24-h2』も同じデータを使っています。'
const NOTE_TWIN_MIXED = '保存場所『koto-rc24-1028』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『rc24-h2』も同じデータを使っています。'
const NOTE_UNREAD_MIXED = '保存場所『koto-kept-2』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『rc24-x』の記録を読めないため、同じデータを使っているか確かめられませんでした。'
const REMOVE_OTHER = '保存場所『koto-other』にある、このプロジェクトのデータも削除します。'
const COST_KEPT = '保存場所は残るため、月額は続きます。'
const MONTHLY = '消すまで月額が続きます'

const facts = <R>(record: R, placements: TeardownPlacement[]): TeardownFacts<R> => ({
  projectName: 'rc24-h', record, placements, placementsUnreadable: false, placementsUnreadableCause: null,
  otherTargets: [], otherTargetsUnreadable: false, waitNote: null,
})
const hanamiiRec: HanamiiTeardownRecord = { projectId: 'p1', name: 'rc24-h', tokenId: null, storageLeftoverBuckets: null }
const sharedRec = (o: Partial<SharedTeardownRecord> = {}): SharedTeardownRecord =>
  ({ appNames: [], registryName: null, registryOrigin: 'owned', registryUsers: [], placements: [], stateOnlyBuckets: [], keyRecorded: true, ...o })
const REC_KEPT = { bucket: 'koto-rc24-1028', prefix: 'projects/rc24-h/', shared: true }
const REC_KEPT_2 = { bucket: 'koto-kept-2', prefix: 'projects/rc24-h/', shared: true }
const REC_GONE = { bucket: 'koto-other', prefix: 'projects/rc24-h/', shared: false }
const dedicatedRec = { applicationID: 'app-1', applicationName: 'myapp', loadBalancerID: 'lb-1', asgID: 'asg-1', clusterID: 'cl-1' } as never

// 3つの公開先。record は、その公開先の確認が保存場所を挙げられる形（共用型はアプリあり・HANAMII はプロジェクトあり・専有型は資源あり）
type Entry = { name: string; build: (placements: TeardownPlacement[]) => { title: string; body: string } }
const ENTRIES: Entry[] = [
  { name: 'HANAMII', build: p => buildTeardownConfirm(hanamiiTeardownSpec, facts(hanamiiRec, p)) },
  { name: '共用型', build: p => buildTeardownConfirm(sharedTeardownSpec, facts(sharedRec({ appNames: ['myapp'], placements: [REC_KEPT, REC_KEPT_2, REC_GONE] }), p)) },
  { name: '専有型', build: p => buildTeardownConfirm(dedicatedTeardownSpec, facts(dedicatedRec, p)) },
]
const bodyOf = (c: { body: string }) => c.body.split('\n\n')
const storageParagraph = (c: { body: string }) => bodyOf(c).find(p => p.startsWith('💾 ')) ?? ''
const count = (s: string, sub: string) => s.split(sub).length - 1

describe('keptAlongsideRemoved: 消す保存場所と消さない保存場所が混じる回か', () => {
  it('★★★ 消す側・消さない側の両方が1件以上あるときだけ真。名前の無いものは数えない', () => {
    expect(keptAlongsideRemoved([KEPT_TWIN, GONE])).toBe(true)
    expect(keptAlongsideRemoved([GONE, KEPT_UNREAD, KEPT_TWIN])).toBe(true)
    expect(keptAlongsideRemoved([KEPT_TWIN, null, { bucket: '' }, GONE])).toBe(true)
    // 全部消さない・全部消す・保存場所が無い
    expect(keptAlongsideRemoved([KEPT_TWIN])).toBe(false)
    expect(keptAlongsideRemoved([KEPT_TWIN, KEPT_UNREAD])).toBe(false)
    expect(keptAlongsideRemoved([GONE])).toBe(false)
    expect(keptAlongsideRemoved([GONE, { ...GONE, bucket: 'koto-b' }])).toBe(false)
    expect(keptAlongsideRemoved([])).toBe(false)
    expect(keptAlongsideRemoved(null)).toBe(false)
    expect(keptAlongsideRemoved(undefined)).toBe(false)
    // 名前の無いものだけ（keep があっても数えない）
    expect(keptAlongsideRemoved([null, { bucket: '', keep: TWIN }])).toBe(false)
    // keep が null・偽は消す側
    expect(keptAlongsideRemoved([KEPT_TWIN, { ...GONE, keep: null as never }])).toBe(true)
  })
})

describe('混在の確認: 消さない側の 💾 に、既存の括弧「（消すまで月額が続きます）」を付ける（3つの公開先）', () => {
  for (const e of ENTRIES) {
    it(`★★★ ${e.name}・混在: 消さない側の 💾 は括弧の月額つき。消す側の文のあとに続く。費用の行は消す側だけで、「月額は続きます」と重ねない`, () => {
      const c = e.build([KEPT_TWIN, GONE])
      const kept = storageParagraph(c)
      expect(kept.startsWith(`💾 ${REMOVE_OTHER}`), `${e.name}: 💾 の先頭が消す側の文でない`).toBe(true)
      expect(kept.endsWith(NOTE_TWIN_MIXED), `${e.name}: 消さない側の 💾 に括弧の月額が付かない`).toBe(true)
      expect(count(c.body, MONTHLY), `${e.name}: 月額の括弧がちょうど1つでない`).toBe(1)
      expect(c.body, `${e.name}: 全部消さない回の費用の行が混じった`).not.toContain(COST_KEPT)
      expect(bodyOf(c)[bodyOf(c).length - 1], `${e.name}: 費用の行は消す側だけ`).toContain('保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。')
    })

    it(`★★ ${e.name}・混在（確かめられない保存場所）: 理由の文は main の note と同じ。括弧の月額は消さない保存場所ごとの文に付く`, () => {
      const c = e.build([KEPT_TWIN, KEPT_UNREAD, GONE])
      const kept = storageParagraph(c)
      expect(kept.endsWith(NOTE_TWIN_MIXED + NOTE_UNREAD_MIXED), `${e.name}`).toBe(true)
      expect(count(c.body, MONTHLY), `${e.name}`).toBe(2)
    })

    it(`★★★ ${e.name}・全部消さない: 括弧を付けない（費用の行「保存場所は残るため、月額は続きます。」が1回だけ言う）`, () => {
      const c = e.build([KEPT_TWIN])
      expect(storageParagraph(c), e.name).toBe(`💾 ${NOTE_TWIN}`)
      expect(c.body, e.name).not.toContain(MONTHLY)
      expect(count(c.body, COST_KEPT), e.name).toBe(1)
      const two = e.build([KEPT_TWIN, KEPT_UNREAD])
      expect(two.body, `${e.name}: 全部消さない2件`).not.toContain(MONTHLY)
      expect(count(two.body, COST_KEPT), `${e.name}: 全部消さない2件`).toBe(1)
    })

    it(`★★ ${e.name}・keep の無い入力: 今までどおり（括弧の月額は出ない。keep: null・keep の無いものも同じ）`, () => {
      const c = e.build([GONE])
      expect(c.body, e.name).not.toContain(MONTHLY)
      expect(c.body, e.name).not.toContain('は残ります')
      expect(storageParagraph(c).startsWith(`💾 ${REMOVE_OTHER}`), e.name).toBe(true)
      expect(e.build([{ ...GONE, keep: null as never }]).body, e.name).toBe(c.body)
    })
  }
})

describe('設定から外した保存場所（state にだけある）の注意は、同じバケットの別の prefix の一方だけ keep なら、もう一方は消すので残す', () => {
  const P1 = { bucket: 'koto-gone', prefix: 'projects/rc24-h/', shared: true }
  const P2 = { bucket: 'koto-gone', prefix: 'projects/rc24-h-2/', shared: true }
  const r = sharedRec({ placements: [P1, P2], stateOnlyBuckets: ['koto-gone'] })
  const SAYS = '⚠️ 設定から外した保存場所『koto-gone』も削除します。'
  const keptP = (p: TeardownPlacement): TeardownPlacement => ({ ...p, keep: TWIN })

  it('★★★ notes: 一方だけ keep → 言う（どちらの側でも）。両方 keep → 言わない。どちらも keep でない → 言う', () => {
    expect(sharedTeardownSpec.notes!(r, [keptP(P1), P2])).toEqual([SAYS])
    expect(sharedTeardownSpec.notes!(r, [P1, keptP(P2)])).toEqual([SAYS])
    expect(sharedTeardownSpec.notes!(r, [keptP(P1), keptP(P2)])).toEqual([])
    expect(sharedTeardownSpec.notes!(r, [P1, P2])).toEqual([SAYS])
    expect(sharedTeardownSpec.notes!(r)).toEqual([SAYS])
  })

  it('★★★ 確認の本文: 一方だけ keep なら「削除します」の段落が出る。両方 keep なら出ない', () => {
    const withApp = sharedRec({ appNames: ['myapp'], placements: [P1, P2], stateOnlyBuckets: ['koto-gone'] })
    const some = buildTeardownConfirm(sharedTeardownSpec, facts(withApp, [keptP(P1), P2]))
    expect(bodyOf(some)).toContain(SAYS)
    const all = buildTeardownConfirm(sharedTeardownSpec, facts(withApp, [keptP(P1), keptP(P2)]))
    expect(all.body).not.toContain('設定から外した保存場所')
  })
})
