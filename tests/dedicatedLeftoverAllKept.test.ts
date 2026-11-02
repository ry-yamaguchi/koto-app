import { describe, it, expect } from 'vitest'
import { dedicatedLeftoverAllKept, dedicatedLeftoverMarkNames } from '../src/shared/teardownSupport'

// ── dedicatedLeftoverAllKept: 専有型の記録が言う「残っている保存場所」が、全部「消さずに残す」側か（画面と main の fs:trashProject が同じこれを通る）──────────
// 真になるのは、資源の ID が1つも無く、印の保存場所が1件以上あり、その名前それぞれについて、同じ名前の保存場所が材料に1件以上あって全部 keep のときだけ。
// 材料に無い名前・keep の無い保存場所が1件でもあれば偽。形の読めない値は偽（止める側）。
// 複数形（storageLeftoverBuckets）と単数（storageLeftoverBucket）の両方を数える（読み方が食い違う記録でも、片方にしか無い名前を見落とさない）。
// 期待は関数を通さず書き下す。変異: keep を見ない・材料に無い名前を残す側に数える・ID を見ない・単数を数えない・配列の読めない要素を黙って落とす、がそれぞれ落ちる。

const TWIN = { risk: 'twin', folders: ['copy'] }
const UNREAD = { risk: 'unread', folders: [] }
const kept = (bucket: string, keep: unknown = TWIN, prefix = 'p/') => ({ bucket, prefix, keep })
const plain = (bucket: string, prefix = 'p/') => ({ bucket, prefix })
const names = (...n: string[]) => ({ storageLeftoverBucket: n[0], storageLeftoverBuckets: n })

describe('★★★ 真になる回（全部 keep・ID なし・印あり）', () => {
  it('印が1件で、同じ名前の保存場所が keep（twin・unread のどちらも）', () => {
    expect(dedicatedLeftoverAllKept(names('a'), [kept('a')])).toBe(true)
    expect(dedicatedLeftoverAllKept(names('a'), [kept('a', UNREAD)])).toBe(true)
  })
  it('印が2件で、どちらの保存場所も keep', () => {
    expect(dedicatedLeftoverAllKept(names('a', 'b'), [kept('a'), kept('b', UNREAD)])).toBe(true)
  })
  it('旧い記録（先頭の1件 storageLeftoverBucket だけ）でも読む', () => {
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: 'a' }, [kept('a')])).toBe(true)
  })
  it('同じ名前を別の prefix で持つ分は、全部 keep のときだけ真', () => {
    expect(dedicatedLeftoverAllKept(names('a'), [kept('a', TWIN, 'p1/'), kept('a', TWIN, 'p2/')])).toBe(true)
    expect(dedicatedLeftoverAllKept(names('a'), [kept('a', TWIN, 'p1/'), plain('a', 'p2/')])).toBe(false)
  })
  it('印にない名前の保存場所が材料に混ざっていても、印の名前が全部 keep なら真（印のほかは見ない）', () => {
    expect(dedicatedLeftoverAllKept(names('a'), [kept('a'), plain('other')])).toBe(true)
  })
  it('材料の中の読めない要素（null・undefined）は数えない', () => {
    expect(dedicatedLeftoverAllKept(names('a'), [null, undefined, kept('a')])).toBe(true)
  })
})

describe('★★★ 偽になる回（止める側）', () => {
  it('keep の無い保存場所が1件でもあれば偽（keep なし・null・false・undefined）', () => {
    expect(dedicatedLeftoverAllKept(names('a'), [plain('a')])).toBe(false)
    expect(dedicatedLeftoverAllKept(names('a'), [{ bucket: 'a', keep: null }])).toBe(false)
    expect(dedicatedLeftoverAllKept(names('a'), [{ bucket: 'a', keep: false }])).toBe(false)
    expect(dedicatedLeftoverAllKept(names('a'), [{ bucket: 'a', keep: undefined }])).toBe(false)
  })
  it('印が2件で、1件だけ keep なら偽', () => {
    expect(dedicatedLeftoverAllKept(names('a', 'b'), [kept('a'), plain('b')])).toBe(false)
    expect(dedicatedLeftoverAllKept(names('a', 'b'), [plain('a'), kept('b')])).toBe(false)
  })
  it('★★★ 印の名前が材料に無ければ偽（材料に無い名前を、残す側に数えない）。材料が空・材料に別の名前しか無い回も偽', () => {
    expect(dedicatedLeftoverAllKept(names('a'), [])).toBe(false)
    expect(dedicatedLeftoverAllKept(names('a'), [kept('other')])).toBe(false)
    expect(dedicatedLeftoverAllKept(names('a', 'b'), [kept('a')])).toBe(false)
  })
  it('★★★ 材料が配列でない・null・undefined は空として扱い、偽', () => {
    for (const bad of [null, undefined, 'x', 5, {}, { 0: kept('a'), length: 1 }, true]) {
      expect(dedicatedLeftoverAllKept(names('a'), bad as any), String(JSON.stringify(bad))).toBe(false)
    }
  })
  it('★★★ 資源の ID が1つでもあれば偽（全部 keep でも。アプリ・クラスタ・ASG・LB のどれでも）', () => {
    for (const f of ['applicationID', 'clusterID', 'asgID', 'loadBalancerID']) {
      expect(dedicatedLeftoverAllKept({ ...names('a'), [f]: 'x-1' }, [kept('a')]), f).toBe(false)
    }
    // 空の文字列・null は ID が無いのと同じ（今までの dedicatedTeardownHasWork と同じ読み方）
    expect(dedicatedLeftoverAllKept({ ...names('a'), applicationID: '', clusterID: null, asgID: undefined }, [kept('a')])).toBe(true)
  })
  it('印が無い・読めない記録は偽（空・null・undefined・印が空・文字列でない印・空の名前）', () => {
    for (const rec of [null, undefined, {}, { storageLeftoverBuckets: [] }, { storageLeftoverBucket: '' }, { storageLeftoverBuckets: [5, null, ''] }, 'x', 5, []]) {
      expect(dedicatedLeftoverAllKept(rec as any, [kept('a'), kept('')]), JSON.stringify(rec)).toBe(false)
    }
  })
})

describe('★★★ 複数形と単数が食い違う記録（手で直した・壊れた）は、両方の名前を数える。読めない値は偽', () => {
  it('★★★ 単数の名前が材料に無い（複数形の名前は全部 keep）→ 偽（単数を見落とさない）', () => {
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: 'z', storageLeftoverBuckets: ['a'] }, [kept('a')])).toBe(false)
  })
  it('★★★ 単数の名前が keep の無い保存場所に当たる → 偽', () => {
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: 'z', storageLeftoverBuckets: ['a'] }, [kept('a'), plain('z')])).toBe(false)
  })
  it('★★ 単数の名前も材料にあり全部 keep → 真（両方を数えても、そろった記録は真のまま）', () => {
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: 'z', storageLeftoverBuckets: ['a'] }, [kept('a'), kept('z', UNREAD)])).toBe(true)
  })
  it('★★★ 複数形の中に文字列でない要素・空の名前が混ざる → 偽（黙って落として真にしない）', () => {
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: 'a', storageLeftoverBuckets: ['a', 42 as any] }, [kept('a')])).toBe(false)
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: 'a', storageLeftoverBuckets: ['a', null as any] }, [kept('a')])).toBe(false)
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: 'a', storageLeftoverBuckets: ['a', ''] }, [kept('a')])).toBe(false)
  })
  it('★★★ 複数形が配列でない・単数が文字列でない → 偽', () => {
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: 'a', storageLeftoverBuckets: 'a' as any }, [kept('a')])).toBe(false)
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: 5 as any, storageLeftoverBuckets: ['a'] }, [kept('a')])).toBe(false)
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: { x: 1 } as any }, [kept('a')])).toBe(false)
  })
  it('★★ 単数が空の文字列・null で複数形が正しい記録は、複数形だけで読む（真）', () => {
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: '', storageLeftoverBuckets: ['a'] }, [kept('a')])).toBe(true)
    expect(dedicatedLeftoverAllKept({ storageLeftoverBucket: null, storageLeftoverBuckets: ['a'] }, [kept('a')])).toBe(true)
  })

  it('★★ dedicatedLeftoverMarkNames: 両方の名前を重ならずに返す。読めない値は null。値が無ければ空', () => {
    expect(dedicatedLeftoverMarkNames({ storageLeftoverBucket: 'z', storageLeftoverBuckets: ['a', 'b'] })).toEqual(['a', 'b', 'z'])
    expect(dedicatedLeftoverMarkNames({ storageLeftoverBucket: 'a', storageLeftoverBuckets: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(dedicatedLeftoverMarkNames({ storageLeftoverBucket: 'a' })).toEqual(['a'])
    expect(dedicatedLeftoverMarkNames({ storageLeftoverBuckets: ['a', 'a'] })).toEqual(['a'])
    for (const none of [null, undefined, {}, { storageLeftoverBucket: '', storageLeftoverBuckets: [] }, { storageLeftoverBucket: null, storageLeftoverBuckets: null }]) {
      expect(dedicatedLeftoverMarkNames(none as any), JSON.stringify(none)).toEqual([])
    }
    for (const bad of [{ storageLeftoverBuckets: 'a' }, { storageLeftoverBuckets: [1] }, { storageLeftoverBuckets: [''] }, { storageLeftoverBucket: 7 }]) {
      expect(dedicatedLeftoverMarkNames(bad as any), JSON.stringify(bad)).toBeNull()
    }
  })
})
