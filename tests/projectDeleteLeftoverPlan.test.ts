import { describe, it, expect } from 'vitest'
import { planProjectDeleteTeardown, noticesAddedSince, type ProjectDeleteFacts, type SharedLeftover } from '../src/renderer/teardown/projectDeletePlan'
import { sharedLeftoverNoun, sharedRegistryCounted, sharedRegistryDeleteDefault } from '../src/renderer/teardown/targets/shared'
import type { PublishTargetKind } from '../src/renderer/publishStatus'

// ── 0.6.24 A（U10）: プロジェクトの削除で、残った保存場所・コンテナレジストリ・アプリを破棄する段を足す門（planProjectDeleteTeardown）・残りの呼び名・押し直し ──
// 仕様 docs/v0624-aefi-spec.md の 1章 A-2・A-6、3章 T-A1・T-A7。作者の決定 K2（借り手のいるレジストリだけが残る回は段を足さない）。
// 期待は関数を通さず書き下す。文の表（チェックの文・💾 の行）は tests/projectDeleteWords.test.ts。

const facts = (over: Partial<ProjectDeleteFacts> = {}): ProjectDeleteFacts =>
  ({ targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null, ...over })
const PL = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
const left = (over: Partial<SharedLeftover> = {}): SharedLeftover =>
  ({ appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [], ...over })
const plan = (targets: PublishTargetKind[], sharedLeftover: SharedLeftover | null, over: Partial<ProjectDeleteFacts> = {}) =>
  planProjectDeleteTeardown(facts({ targets, sharedLeftover, ...over }))
const COVER = { hanamii: [], 'sakura-apprun': ['myapp copy'], 'sakura-apprun-dedicated': [] }

describe('T-A1 門: 共用型の行が無いのに記録の残りがあるとき、sakura-apprun の段を足す（足した回だけ leftover が付く）', () => {
  it('★★★ 保存場所だけ → 段を足す。呼び名は「保存場所」', () => {
    expect(plan([], left({ placements: [PL] }))).toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [], leftover: { noun: '保存場所' } })
  })

  it('★★★ HANAMII と保存場所 → 並びは HANAMII が先（共用型の破棄は HANAMII のデータも消すので）。targets の並びに依らない', () => {
    expect(plan(['hanamii'], left({ placements: [PL] })).teardown).toEqual(['hanamii', 'sakura-apprun'])
    expect(plan(['hanamii'], left({ placements: [PL] })).leftover).toEqual({ noun: '保存場所' })
  })

  it('★★★ Vercel・レンタルサーバの行と保存場所 → 段は共用型の1つだけ（Vercel は teardown に入らない）', () => {
    expect(plan(['vercel'], left({ placements: [PL] }))).toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [], leftover: { noun: '保存場所' } })
    expect(plan(['sakura-rental', 'vercel'], left({ placements: [PL] })).teardown).toEqual(['sakura-apprun'])
  })

  it('★★★ 止める理由があるときは足さない（専有型・走っている操作・保存場所だけの専有型の残り）。leftover のキーも無い', () => {
    const l = left({ placements: [PL] })
    for (const p of [
      plan(['sakura-apprun-dedicated'], l),
      plan([], l, { dedicated: { clusterID: 'c-1' } }),
      plan([], l, { dedicated: { storageLeftoverBucket: 'koto-x' } }),
      plan([], l, { running: { op: '公開', target: 'hanamii' } }),
    ]) {
      expect(p.block).not.toBeNull()
      expect(p.teardown).toEqual([])
      expect('leftover' in p).toBe(false)
    }
  })

  it('★★★ K2: 借り手のいるレジストリだけが残る回は、段を足さない（由来が何でも）。leftover のキーも無い', () => {
    for (const origin of ['owned', 'adopted', 'unknown'] as const) {
      const p = plan([], left({ registryName: 'reg', registryOrigin: origin, registryUsers: ['reminder'] }))
      expect(p, origin).toEqual({ block: null, teardown: [], twinned: [] })
      expect(Object.keys(p).sort()).toEqual(['block', 'teardown', 'twinned'])
    }
  })

  it('★★★ 借り手のいないレジストリだけ → 由来が owned でも adopted でも unknown でも段を足す（呼び名は「コンテナレジストリ」）', () => {
    for (const origin of ['owned', 'adopted', 'unknown'] as const) {
      expect(plan([], left({ registryName: 'reg', registryOrigin: origin })), origin).toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [], leftover: { noun: 'コンテナレジストリ' } })
    }
  })

  it('★★ 保存場所とレジストリの両方 →「保存場所・コンテナレジストリ」。借り手のいるレジストリと保存場所なら、数えるのは保存場所だけ', () => {
    expect(plan([], left({ placements: [PL], registryName: 'reg' })).leftover).toEqual({ noun: '保存場所・コンテナレジストリ' })
    expect(plan([], left({ placements: [PL], registryName: 'reg', registryUsers: ['reminder'] })).leftover).toEqual({ noun: '保存場所' })
  })

  it('★★★ 行の無いアプリ（📡 の「一覧から削除」で行だけ外した回）→ 段を足す。呼び名は null（公開の回）。借り手のいるレジストリがあっても足す', () => {
    expect(plan([], left({ appNames: ['myapp-app'] }))).toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [], leftover: { noun: null } })
    expect(plan([], left({ appNames: ['myapp-app'], registryName: 'reg', registryUsers: ['reminder'] })).leftover).toEqual({ noun: null })
    expect(plan(['hanamii'], left({ appNames: ['myapp-app'], placements: [PL] })).teardown).toEqual(['hanamii', 'sakura-apprun'])
  })

  it('★★★ 共用型が複製の対象（覆う複製がある）→ 足さない。複製を読めなかった回（twins が null）は足す（外さない側）', () => {
    const l = left({ placements: [PL] })
    expect(plan([], l, { twins: COVER })).toEqual({ block: null, teardown: [], twinned: [] })
    expect(plan([], l, { twins: null }).teardown).toEqual(['sakura-apprun'])
    expect(plan([], l, { twins: { ...COVER, 'sakura-apprun': [] } }).teardown).toEqual(['sakura-apprun'])
    expect(plan([], l, { twins: { ...COVER, hanamii: ['myapp copy'], 'sakura-apprun': [] } }).teardown, 'HANAMII の複製は共用型の門に関係しない').toEqual(['sakura-apprun'])
  })

  it('★★ 空の残り・残りが無い → 足さない。専有型の複製で止めを外した回でも、残りがあれば足す', () => {
    expect(plan([], left())).toEqual({ block: null, teardown: [], twinned: [] })
    expect(plan([], null)).toEqual({ block: null, teardown: [], twinned: [] })
    const p = plan(['sakura-apprun-dedicated'], left({ placements: [PL] }), { twins: { ...COVER, 'sakura-apprun': [], 'sakura-apprun-dedicated': ['myapp copy'] } })
    expect(p.block).toBeNull()
    expect(p.teardown).toEqual(['sakura-apprun'])
    expect(p.twinned.map(x => x.target)).toEqual(['sakura-apprun-dedicated'])
  })

  it('★★ 形が読めない値（appNames・placements が配列でない）は、足す側に倒さない', () => {
    expect(plan([], { registryName: 'reg', registryOrigin: 'owned', registryUsers: [], placements: [PL] } as unknown as SharedLeftover).teardown).toEqual([])
    expect(plan([], { appNames: ['a'], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: null } as unknown as SharedLeftover).teardown).toEqual([])
  })

  it('★★ 共用型の行があるのに残りも来た（つじつまの合わない材料）→ 共用型は1つだけ。leftover は付けない', () => {
    const p = plan(['sakura-apprun'], left({ placements: [PL] }))
    expect(p.teardown).toEqual(['sakura-apprun'])
    expect('leftover' in p).toBe(false)
  })
})

describe('sharedRegistryCounted・sharedLeftoverNoun・sharedRegistryDeleteDefault（門と確認の題が使う表）', () => {
  it('★★★ 数えるレジストリは、名前があり、借り手がいないものだけ。形が読めない借り手は数えない', () => {
    expect(sharedRegistryCounted({ registryName: 'reg', registryUsers: [] })).toBe(true)
    expect(sharedRegistryCounted({ registryName: 'reg', registryUsers: ['reminder'] })).toBe(false)
    expect(sharedRegistryCounted({ registryName: null, registryUsers: [] })).toBe(false)
    expect(sharedRegistryCounted({ registryName: '', registryUsers: [] })).toBe(false)
    expect(sharedRegistryCounted({ registryName: 'reg', registryUsers: undefined as unknown as string[] })).toBe(false)
  })

  it.each([
    [['app'], [PL], true, null], [['app'], [], false, null],
    [[], [PL], false, '保存場所'], [[], [], true, 'コンテナレジストリ'], [[], [PL], true, '保存場所・コンテナレジストリ'],
    [[], [], false, null],
  ] as const)('★★ アプリ %j・保存場所 %j・レジストリを数える %s → %s', (appNames, placements, counted, noun) => {
    expect(sharedLeftoverNoun({ appNames: [...appNames], placements: [...placements] }, counted)).toBe(noun)
  })

  it('★★ 確認の既定オンは、Koto が作った（owned）借り手のいないレジストリだけ（チェックの文の「次の確認で選べます」が同じ口を通る）', () => {
    expect(sharedRegistryDeleteDefault({ registryName: 'reg', registryOrigin: 'owned', registryUsers: [] })).toBe(true)
    for (const origin of ['adopted', 'unknown'] as const) expect(sharedRegistryDeleteDefault({ registryName: 'reg', registryOrigin: origin, registryUsers: [] }), origin).toBe(false)
    expect(sharedRegistryDeleteDefault({ registryName: 'reg', registryOrigin: 'owned', registryUsers: ['reminder'] })).toBe(false)
  })
})

describe('T-A7 noticesAddedSince: 残りが増えたことを数えるのは、チェックが外れているときだけ（オンなら確認が名指しする）', () => {
  const seen = facts({ sharedLeftover: left({ placements: [PL], registryName: 'reg' }) })
  const MORE = [
    ['新しい保存場所', facts({ sharedLeftover: left({ placements: [PL, { bucket: 'koto-b', prefix: 'p/', shared: false }], registryName: 'reg' }) })],
    ['別のレジストリ', facts({ sharedLeftover: left({ placements: [PL], registryName: 'other' }) })],
    ['アプリが残っていた', facts({ sharedLeftover: left({ appNames: ['myapp-app'], placements: [PL], registryName: 'reg' }) })],
  ] as const

  it.each(MORE)('★★★ チェックが外れている回は、%s が増えたら数える。オンの回は数えない', (_name, fresh) => {
    expect(noticesAddedSince(seen, fresh, false)).toBe(true)
    expect(noticesAddedSince(seen, fresh, true)).toBe(false)
  })

  it('★★★ 見せた材料が無い（残りが新しく出てきた）回も、外れているときだけ数える', () => {
    const fresh = facts({ sharedLeftover: left({ appNames: ['myapp-app'] }) })
    expect(noticesAddedSince(facts(), fresh, false)).toBe(true)
    expect(noticesAddedSince(facts(), fresh, true)).toBe(false)
  })

  it('★★★ 見せたものと同じ・減っただけ・アプリが減っただけなら、外れていても数えない（行き止まりにしない）', () => {
    const had = facts({ sharedLeftover: left({ appNames: ['a', 'b'], placements: [PL] }) })
    expect(noticesAddedSince(had, facts({ sharedLeftover: left({ appNames: ['b', 'a'], placements: [{ ...PL }] }) }), false)).toBe(false)
    expect(noticesAddedSince(had, facts({ sharedLeftover: left({ appNames: ['a'], placements: [] }) }), false)).toBe(false)
  })

  it('★★★ 公開の記録が読めなくなったことは、チェックがオンでも数える（unreadable は今のまま）', () => {
    expect(noticesAddedSince(facts(), facts({ unreadable: true }), true)).toBe(true)
    expect(noticesAddedSince(facts(), facts({ unreadable: true }), false)).toBe(true)
  })

  it('★★ 渡し忘れ・形違い（true でない値）は「外れている」側＝見せて止める側に倒す', () => {
    const fresh = MORE[0][1]
    expect(noticesAddedSince(seen, fresh, undefined as unknown as boolean)).toBe(true)
    expect(noticesAddedSince(seen, fresh, 'true' as unknown as boolean)).toBe(true)
  })
})
