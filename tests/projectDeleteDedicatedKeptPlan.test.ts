import { describe, it, expect } from 'vitest'
import {
  planProjectDeleteTeardown, projectDeleteBlockOf, projectDeleteBlockNote, type ProjectDeleteFacts, type SharedLeftover,
} from '../src/renderer/teardown/projectDeletePlan'
import { dedicatedKeptNoteOf, dedicatedKeptOf, type NotesOnScreen } from '../src/renderer/teardown/projectDeleteDedicatedKept'
import { rowStorageNotesOf, leftoverStorageNoteLine, keptStorageNoteOf, unsteppedLeftoverNote } from '../src/renderer/teardown/projectDeleteWords'
import { teardownDataNoteForAll } from '../src/shared/teardownSupport'

// ── 削除の画面: 専有型で、残っている保存場所が全部「消さずに残す」なら止めない（plan.block が null・plan.dedicatedKept に残す保存場所を載せる）──────────
// 判断は shared の dedicatedLeftoverAllKept の1つ（tests/dedicatedLeftoverAllKept.test.ts）。ここは、plan がそれを呼ぶ順（走っている操作・記録を読めない・覆う複製が先）と、
// 載せる保存場所、赤い箱の 💾 の1行の文（teardownDataNoteForAll の答えそのもの・ほかの 💾 の行が名指しした保存場所は除く）を固定する。
// 実フォルダ・本物の main に流す試験は tests/trashProjectDedicatedKept.test.ts・tests/dedicatedKeptRealMain.test.ts。
// 変異: 判断が keep を見ない・ID を見ない・走っている操作より先に外す・覆う複製と重ねて載せる・名指し済みの保存場所を除かない、がそれぞれ落ちる。

const KEEP = { risk: 'twin' as const, folders: ['copy'] }
const UNREAD = { risk: 'unread' as const, folders: [] as string[] }
const A = { bucket: 'koto-a', prefix: 'p/', shared: true, keep: KEEP }
const B = { bucket: 'koto-b', prefix: 'p/', shared: true, keep: UNREAD }
const PLAIN = { bucket: 'koto-c', prefix: 'p/', shared: true }
const MARK_A = { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a'] }
const facts = (over: Partial<ProjectDeleteFacts> = {}): ProjectDeleteFacts => ({
  targets: ['sakura-apprun-dedicated'], unreadable: false, unconfirmed: false, dedicated: MARK_A, placements: [A], running: null,
  sharedLeftover: null, sharedRegistry: null, twins: null, ...over,
})
const left = (placements: SharedLeftover['placements']): SharedLeftover =>
  ({ appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements })
const KEPT_A = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『copy』も同じデータを使っています。'

describe('★★★ plan: 印の保存場所が全部 keep なら止めず、残す保存場所を plan に載せる', () => {
  it('専有型の行つき・ID なし・印の保存場所が keep（twin）→ block null。dedicatedKept に、その保存場所（keep 付き）だけが入る。ほかのキーは増えない', () => {
    const p = planProjectDeleteTeardown(facts())
    expect(p).toEqual({ block: null, teardown: [], twinned: [], dedicatedKept: [A] })
    expect(Object.keys(p).sort()).toEqual(['block', 'dedicatedKept', 'teardown', 'twinned'])
  })

  it('★★ 理由が確かめられなかった（unread）でも同じ。印が2件で全部 keep なら、2件とも載る（並びは facts.placements のまま）', () => {
    expect(planProjectDeleteTeardown(facts({ dedicated: { storageLeftoverBucket: 'koto-b', storageLeftoverBuckets: ['koto-b'] }, placements: [B] })).dedicatedKept).toEqual([B])
    const two = planProjectDeleteTeardown(facts({ dedicated: { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a', 'koto-b'] }, placements: [B, A] }))
    expect(two.block).toBeNull()
    expect(two.dedicatedKept).toEqual([B, A])
  })

  it('★★★ 印のない保存場所（印の名前に当たらないもの）は載せない。載せるのは、印の名前に当たる facts.placements の要素だけ', () => {
    const p = planProjectDeleteTeardown(facts({ placements: [A, PLAIN] }))
    expect(p.block).toBeNull()
    expect(p.dedicatedKept).toEqual([A])
  })

  it('★★★ 専有型の行が無く、印だけが残る回（📡 の行を消したあと）も、止めずに載せる', () => {
    expect(planProjectDeleteTeardown(facts({ targets: [] }))).toEqual({ block: null, teardown: [], twinned: [], dedicatedKept: [A] })
  })

  it('★★★ keep の無い保存場所が1件でも混ざれば、今までどおり dedicated-storage-leftover で止まる。キーは付かない', () => {
    for (const placements of [[{ ...A, keep: undefined }], [PLAIN], [], [A, { ...PLAIN, bucket: 'koto-a' }]]) {
      const p = planProjectDeleteTeardown(facts({ placements: placements as any }))
      expect(p.block, JSON.stringify(placements)).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-a'] })
      expect('dedicatedKept' in p).toBe(false)
    }
    const two = planProjectDeleteTeardown(facts({ dedicated: { storageLeftoverBuckets: ['koto-a', 'koto-c'], storageLeftoverBucket: 'koto-a' }, placements: [A, PLAIN] }))
    expect(two.block).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-a', 'koto-c'] })
  })

  it('★★★ 資源の ID が1つでもあれば、保存場所が全部 keep でも dedicated で止まる（ID の種類ごと）', () => {
    for (const f of ['applicationID', 'clusterID', 'asgID', 'loadBalancerID']) {
      const p = planProjectDeleteTeardown(facts({ dedicated: { ...MARK_A, [f]: 'x-1' } }))
      expect(p.block, f).toEqual({ reason: 'dedicated' })
      expect('dedicatedKept' in p, f).toBe(false)
    }
  })

  it('★★ 幽霊の行（専有型の行だけがあり、記録が空）は、今までどおり dedicated', () => {
    for (const dedicated of [null, {}, { applicationID: null, storageLeftoverBuckets: [] }]) {
      const p = planProjectDeleteTeardown(facts({ dedicated, placements: [A] }))
      expect(p.block, JSON.stringify(dedicated)).toEqual({ reason: 'dedicated' })
      expect('dedicatedKept' in p).toBe(false)
    }
  })

  it('★★ 専有型の行も印も無い回は、止めず、キーも付かない（外した回ではない）', () => {
    expect(planProjectDeleteTeardown(facts({ targets: [], dedicated: null }))).toEqual({ block: null, teardown: [], twinned: [] })
    expect(planProjectDeleteTeardown(facts({ targets: [], dedicated: { storageLeftoverBuckets: ['koto-a'] } }))).toEqual({ block: null, teardown: [], twinned: [] })
  })

  it('★★ HANAMII の行がある回も、段（teardown）はそのまま。専有型の分だけ dedicatedKept に載る', () => {
    const p = planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun-dedicated'] }))
    expect(p.block).toBeNull()
    expect(p.teardown).toEqual(['hanamii'])
    expect(p.dedicatedKept).toEqual([A])
  })
})

describe('★★★ 順序: 走っている操作・記録を読めない・覆う複製の判断が先（これらのときは外さない・載せない）', () => {
  it('走っている操作 → running で止まる。dedicatedKept は付かない', () => {
    const p = planProjectDeleteTeardown(facts({ running: { op: '公開', target: 'sakura-apprun-dedicated' } as any }))
    expect(p.block).toEqual({ reason: 'running', op: '公開', target: 'sakura-apprun-dedicated' })
    expect('dedicatedKept' in p).toBe(false)
  })

  it('公開の記録を読めない回 → record-unreadable で止まる。teardown・twinned は空、dedicatedKept は付かない', () => {
    const p = planProjectDeleteTeardown(facts({ unreadable: true, targets: ['hanamii', 'sakura-apprun-dedicated'] }))
    expect(p).toEqual({ block: { reason: 'record-unreadable' }, teardown: [], twinned: [] })
  })

  it('★★★ 走っている操作と記録を読めない回が重なっても、走っている操作が先（今までの順）', () => {
    const p = planProjectDeleteTeardown(facts({ running: { op: '削除', target: 'sakura-apprun-dedicated' } as any, unreadable: true }))
    expect(p.block).toMatchObject({ reason: 'running' })
  })

  it('★★★ 覆う複製で外した回は、dedicatedKept を載せない（twinned が同じことを言う。同じことを2回言わない）', () => {
    const p = planProjectDeleteTeardown(facts({ twins: { 'sakura-apprun-dedicated': ['copy'] } as any }))
    expect(p.block).toBeNull()
    expect(p.twinned).toEqual([{ target: 'sakura-apprun-dedicated', folders: ['copy'] }])
    expect('dedicatedKept' in p).toBe(false)
  })

  it('★★ 覆う複製を調べられなかった回（twins が null）は、複製では外さない。保存場所が全部 keep なら、この理由で外す', () => {
    const p = planProjectDeleteTeardown(facts({ twins: null }))
    expect(p.twinned).toEqual([])
    expect(p.dedicatedKept).toEqual([A])
  })
})

describe('★★★ projectDeleteBlockOf の leftoverAllKept 引数: 真偽値の true だけを読む（渡し忘れ・形違いは外さない）', () => {
  const run = (v?: unknown) => projectDeleteBlockOf(['sakura-apprun-dedicated'], MARK_A, false, null, false, v as any)
  it('★★★ true だけが外す', () => {
    expect(run(true)).toBeNull()
  })
  it('★★★ 渡さない・false・文字列の "true"・1・オブジェクトは、外さない（dedicated-storage-leftover のまま）', () => {
    for (const v of [undefined, false, 'true', 1, {}, null]) {
      expect(run(v), String(v)).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-a'] })
    }
  })
  it('★★★ true を渡しても、ID があれば外さない・幽霊の行は外さない（引数は理由の言い分けだけを動かす）', () => {
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { ...MARK_A, clusterID: 'c' }, false, null, false, true)).toEqual({ reason: 'dedicated' })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], {}, false, null, false, true)).toEqual({ reason: 'dedicated' })
  })
  it('★★ 走っている操作・記録を読めないは、true でも先に止める', () => {
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], MARK_A, false, { op: '公開', target: 'hanamii' } as any, false, true)).toMatchObject({ reason: 'running' })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], MARK_A, false, null, true, true)).toEqual({ reason: 'record-unreadable' })
  })
  it('止める文は今までどおり（保存場所だけが残っている文）', () => {
    expect(projectDeleteBlockNote({ reason: 'dedicated-storage-leftover', buckets: ['koto-a'] })).toContain('保存場所『koto-a』だけが残っています（消すまで月額が続きます）。')
  })
})

describe('★★★ dedicatedKeptOf: 外した回だけ載せる', () => {
  it('外していない回（止める理由がある・複製で外した）は null', () => {
    expect(dedicatedKeptOf(facts(), false, { reason: 'dedicated' })).toBeNull()
    expect(dedicatedKeptOf(facts(), true, null)).toBeNull()
    expect(dedicatedKeptOf(facts(), false, null)).toEqual([A])
  })
})

describe('★★★ 赤い箱の 💾 の1行（dedicatedKeptNoteOf）: 文は teardownDataNoteForAll の答えそのもの。ほかの行が名指しした保存場所は除く', () => {
  const none: NotesOnScreen = { rowNotes: false, leftoverLine: false, keptNote: false, leftoverNote: false }
  const planOf = (f: ProjectDeleteFacts) => planProjectDeleteTeardown(f)

  it('★★★ ほかの行が出ていない回（共用型の記録を読めなかった回など）: 専有型の行が、残る保存場所の文を言う。文は teardownDataNoteForAll の答えそのもの', () => {
    const f = facts({ unconfirmed: true })
    expect(dedicatedKeptNoteOf(planOf(f), f, none)).toBe(KEPT_A)
    expect(dedicatedKeptNoteOf(planOf(f), f, none)).toBe(teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', placements: [A] }))
  })

  it('★★★ plan に載っていない回は空（外した回だけ出す）', () => {
    expect(dedicatedKeptNoteOf({}, facts(), none)).toBe('')
    expect(dedicatedKeptNoteOf({ dedicatedKept: [] }, facts(), none)).toBe('')
    const blocked = facts({ placements: [PLAIN] })
    expect(dedicatedKeptNoteOf(planOf(blocked), blocked, none)).toBe('')
  })

  it('★★★ ふつうの形（共用型の記録を読めた。leftoverNote が同じ保存場所を言う）: 専有型の行は出ない', () => {
    const f = facts({ sharedLeftover: left([A]) })
    const p = planOf(f)
    expect(p.dedicatedKept).toEqual([A])
    const leftoverNote = unsteppedLeftoverNote(f, false)
    expect(leftoverNote).toBe(KEPT_A)
    expect(dedicatedKeptNoteOf(p, f, { ...none, leftoverNote: leftoverNote !== '' })).toBe('')
  })

  it('★★★ 公開先の行（HANAMII）が名指しする回・チェックを外した回の行が名指しする回も、出ない', () => {
    const f = facts({ targets: ['hanamii', 'sakura-apprun-dedicated'], sharedLeftover: left([A]) })
    const p = planOf(f)
    const rows = rowStorageNotesOf(p, f)
    expect(rows).toHaveLength(1)
    expect(rows[0].note).toBe(KEPT_A)
    expect(dedicatedKeptNoteOf(p, f, { ...none, rowNotes: true })).toBe('')
    expect(keptStorageNoteOf(f)).toContain('koto-a')
    expect(dedicatedKeptNoteOf(p, f, { ...none, keptNote: true })).toBe('')
    expect(leftoverStorageNoteLine({ teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } }, f)).toContain('koto-a')
    expect(dedicatedKeptNoteOf(p, f, { ...none, leftoverLine: true })).toBe('')
  })

  it('★★★ 出ていない行は名指しに数えない（行が出ていなければ、専有型の行が言う）', () => {
    const f = facts({ sharedLeftover: left([A]) })
    expect(dedicatedKeptNoteOf(planOf(f), f, none)).toBe(KEPT_A)
  })

  it('★★★ 名指しは名前と prefix の組で見る。同じバケットの別の prefix の保存場所は、別の保存場所として残る', () => {
    const A2 = { ...A, prefix: 'other/' }
    const f = facts({ placements: [A, A2], sharedLeftover: left([A]) })
    const p = planOf(f)
    expect(p.dedicatedKept).toEqual([A, A2])
    // 行が名指ししたのは A（prefix p/）だけ。A2 は専有型の行が言う
    expect(dedicatedKeptNoteOf(p, f, { ...none, leftoverNote: true })).toBe(teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', placements: [A2] }))
    expect(dedicatedKeptNoteOf(p, f, { ...none, leftoverNote: true })).toBe(KEPT_A)
  })

  it('★★ 共用型の記録が、この保存場所を言わない回（レジストリだけ・別の保存場所だけ）は、専有型の行が言う', () => {
    const f = facts({ sharedLeftover: { ...left([]), registryName: 'reg', registryOrigin: 'adopted', registryUsers: ['other'] } })
    expect(dedicatedKeptNoteOf(planOf(f), f, { ...none, leftoverNote: true })).toBe(KEPT_A)
    const g = facts({ placements: [A, PLAIN], sharedLeftover: left([PLAIN]) })
    expect(dedicatedKeptNoteOf(planOf(g), g, { ...none, leftoverNote: true })).toBe(KEPT_A)
  })

  it('★★ 複数の保存場所は、名指しされなかった分だけを1つの文で言う', () => {
    const f = facts({ dedicated: { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a', 'koto-b'] }, placements: [A, B], sharedLeftover: left([A]) })
    expect(dedicatedKeptNoteOf(planOf(f), f, { ...none, leftoverNote: true })).toBe(teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', placements: [B] }))
    expect(dedicatedKeptNoteOf(planOf(f), f, none)).toBe(teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', placements: [A, B] }))
  })
})

describe('★★ 印の複数形と単数が食い違う記録（手で直した・壊れた）: 両方の名前を数えて、止めるか・どの保存場所が残るかを言う', () => {
  it('★★★ 単数の名前が材料に無い・読めない値が混ざる → 止める（dedicated-storage-leftover）。dedicatedKept のキーは付かない', () => {
    for (const dedicated of [
      { storageLeftoverBucket: 'koto-gone', storageLeftoverBuckets: ['koto-a'] },
      { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a', 42 as any] },
    ]) {
      const p = planProjectDeleteTeardown(facts({ dedicated }))
      expect(p.block, JSON.stringify(dedicated)).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-a'] })
      expect('dedicatedKept' in p).toBe(false)
    }
  })

  it('★★ 両方の名前が材料にあり全部 keep → 止めず、両方の保存場所を載せる（単数にしか無い名前も言う）', () => {
    const p = planProjectDeleteTeardown(facts({ dedicated: { storageLeftoverBucket: 'koto-b', storageLeftoverBuckets: ['koto-a'] }, placements: [A, B] }))
    expect(p.block).toBeNull()
    expect(p.dedicatedKept).toEqual([A, B])
  })
})

