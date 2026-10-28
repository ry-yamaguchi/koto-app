import { describe, it, expect } from 'vitest'
import { projectDeleteBlockOf, projectDeleteBlockNote, planProjectDeleteTeardown, type ProjectDeleteFacts } from '../src/renderer/teardown/projectDeletePlan'

// ── 専有型の「保存場所だけ残った」を全件で言う（設計書 10.11.4 (5)・10.12 の B=2。0.6.22 段階3B-2）──────────────────
// 押し直しの印を全件（storageLeftoverBuckets）にしたので、プロジェクトの削除を止める文も全部の名前を言う。
// 先頭の1件だけを言うと、名前が出なかった保存場所の月額を黙らせる（お金の文は削らない）。1件のときの文は変えない（tests/projectDeletePlan.test.ts）。
// 行（publish.targets の専有型）があっても、資源の ID が無く保存場所だけが残っているなら言い分ける（0.6.22 段階3B-7・設計書 10.11.9 の D3。
// D1=1 で、保存場所だけ残った回は 📡 の行が残るため）。

const facts = (over: Partial<ProjectDeleteFacts>): ProjectDeleteFacts => ({
  targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null, ...over,
})

describe('projectDeleteBlockOf: 保存場所の残りの全件（storageLeftoverBuckets）があればその全件、無ければ storageLeftoverBucket の1件（旧い記録）', () => {
  it('★★★ 全件があれば全件の名前で言う。全件が無い・空・読めない値だけなら、1件の印（旧い記録）', () => {
    expect(projectDeleteBlockOf([], { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a', 'koto-b'] }, false))
      .toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-a', 'koto-b'] })
    for (const buckets of [null, undefined, [], ['', 5 as any]]) {
      expect(projectDeleteBlockOf([], { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: buckets }, false), JSON.stringify(buckets))
        .toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-a'] })
    }
  })

  it('★★★ 行があっても、保存場所の残りだけなら全件の名前で言う（D3）。ID が1つでもあれば全件があっても dedicated', () => {
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { storageLeftoverBuckets: ['koto-a', 'koto-b'] }, false))
      .toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-a', 'koto-b'] })
    expect(projectDeleteBlockOf(['hanamii', 'sakura-apprun-dedicated'], { storageLeftoverBucket: 'koto-a' }, false))
      .toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-a'] })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { clusterID: 'c-1', storageLeftoverBuckets: ['koto-a', 'koto-b'] }, false)).toEqual({ reason: 'dedicated' })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { clusterID: 'c-1', storageLeftoverBucket: 'koto-a' }, false)).toEqual({ reason: 'dedicated' })
    // 行だけがあり記録が空（幽霊の行）・形が読めない保存場所だけ → dedicated のまま（言い分けるのは「ID が無く、読める名前がある」ときだけ）
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], {}, false)).toEqual({ reason: 'dedicated' })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { storageLeftoverBucket: 5 as any }, false)).toEqual({ reason: 'dedicated' })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { storageLeftoverBucket: '' }, false)).toEqual({ reason: 'dedicated' })
    expect(projectDeleteBlockOf([], { clusterID: 'c-1', storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a', 'koto-b'] }, false)).toEqual({ reason: 'dedicated' })
  })

  it('全件が読めない値だけで1件の印も無い → 止めない。1件の印が読めない値（数）で全件が文字列 → 止める側（dedicated）に倒す', () => {
    expect(projectDeleteBlockOf([], { storageLeftoverBuckets: ['', 5 as any] }, false)).toBeNull()
    expect(projectDeleteBlockOf([], { storageLeftoverBucket: 5 as any, storageLeftoverBuckets: 'koto-a' as any }, false)).toEqual({ reason: 'dedicated' })
  })

  it('planProjectDeleteTeardown を通しても、全件の名前が block に出る（公開先の行が無くても。専有型の行があっても。teardown には専有型を入れない）', () => {
    expect(planProjectDeleteTeardown(facts({ dedicated: { storageLeftoverBucket: 'a', storageLeftoverBuckets: ['a', 'b'] } })).block)
      .toEqual({ reason: 'dedicated-storage-leftover', buckets: ['a', 'b'] })
    const withRow = planProjectDeleteTeardown(facts({ targets: ['sakura-apprun-dedicated'], dedicated: { storageLeftoverBucket: 'a', storageLeftoverBuckets: ['a', 'b'] } }))
    expect(withRow.block).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['a', 'b'] })
    expect(withRow.teardown).toEqual([])
  })
})

describe('projectDeleteBlockNote: dedicated-storage-leftover は全部の名前を言う', () => {
  const TAIL = '先に「📦 さくらのAppRun」の専有型タブ「手順6 作ったものを削除する」で残った保存場所を削除してから、もう一度このプロジェクトを削除してください。'

  it('★★ 残りが2件なら両方の名前を言う。3件でも全部', () => {
    expect(projectDeleteBlockNote({ reason: 'dedicated-storage-leftover', buckets: ['koto-a', 'koto-b'] }))
      .toBe(`さくらのAppRun 専有型の削除で、保存場所『koto-a』『koto-b』だけが残っています（消すまで月額が続きます）。${TAIL}`)
    expect(projectDeleteBlockNote({ reason: 'dedicated-storage-leftover', buckets: ['a', 'b', 'c'] })).toContain('保存場所『a』『b』『c』だけが残っています')
  })

  it('1件のときの文は、全件を言う形にしても1文字も変えない', () => {
    expect(projectDeleteBlockNote({ reason: 'dedicated-storage-leftover', buckets: ['koto-data'] }))
      .toBe(`さくらのAppRun 専有型の削除で、保存場所『koto-data』だけが残っています（消すまで月額が続きます）。${TAIL}`)
  })
})
