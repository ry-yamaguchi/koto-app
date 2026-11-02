import { describe, it, expect } from 'vitest'
import {
  planProjectDeleteTeardown, sharedLeftoverGateOf, sharedLeftoverNote, remainingPlacementsNote, remainingPlacementsNoteWithKeep, type ProjectDeleteFacts, type SharedLeftover,
} from '../src/renderer/teardown/projectDeletePlan'
import { leftoverStorageNoteLine, keptStorageNoteOf, rowStorageNotesOf, unsteppedLeftoverNote, vercelStorageTornDown } from '../src/renderer/teardown/projectDeleteWords'
import type { PublishTargetKind } from '../src/renderer/publishStatus'

// ── 削除の画面: 保存場所が全部「消さずに残す」（keep）回は、残りの段を足さない（門・文・Vercel の判断）──────────────
// 門は sharedLeftoverGateOf の1つ（開いたとき〔plan〕も走らせる直前のかけ直しも同じ関数）。keep は cloud:twinFacts が読めた回にだけ付く。
//   全部 keep（アプリ無し・数えるレジストリ無し）→ 足さない／一部だけ keep → 足す／keep が付かない（読めなかった）→ 足す／アプリ・数えるレジストリがあれば足す
// 文の期待は関数を通さず書き下す。実フォルダ・本物の main に流す試験は tests/projectDeleteKeepRun.test.ts。

const facts = (over: Partial<ProjectDeleteFacts> = {}): ProjectDeleteFacts =>
  ({ targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null, ...over })
const KEEP_TWIN = { risk: 'twin' as const, folders: ['copy'] }
const KEEP_UNREAD = { risk: 'unread' as const, folders: ['broken'] }
const A = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
const B = { bucket: 'koto-b', prefix: 'projects/myapp/', shared: true }
const kept = <P extends object>(p: P, keep = KEEP_TWIN) => ({ ...p, keep })
const left = (over: Partial<SharedLeftover> = {}): SharedLeftover =>
  ({ appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [], ...over })
const planOf = (targets: PublishTargetKind[], sharedLeftover: SharedLeftover | null, over: Partial<ProjectDeleteFacts> = {}) =>
  planProjectDeleteTeardown(facts({ targets, sharedLeftover, ...over }))

describe('門: 全部 keep なら残りの段を足さない（アプリ無し・数えるレジストリ無し）', () => {
  it('★★★ 保存場所が全部 keep（twin）→ 段を足さない。leftover のキーも無い', () => {
    const p = planOf([], left({ placements: [kept(A)] }))
    expect(p).toEqual({ block: null, teardown: [], twinned: [] })
    expect(Object.keys(p).sort()).toEqual(['block', 'teardown', 'twinned'])
  })

  it('★★★ keep の理由が確かめられなかった（unread）でも同じ。複数の保存場所が全部 keep でも同じ', () => {
    expect(planOf([], left({ placements: [kept(A, KEEP_UNREAD)] })).teardown).toEqual([])
    expect(planOf([], left({ placements: [kept(A), kept(B, KEEP_UNREAD)] })).teardown).toEqual([])
    expect('leftover' in planOf([], left({ placements: [kept(A), kept(B, KEEP_UNREAD)] }))).toBe(false)
  })

  it('★★★ 同じバケットを別の prefix で持つ分も、全件 keep なら足さない。1件でも keep が無ければ足す', () => {
    const A2 = { ...A, prefix: 'projects/other/' }
    expect(planOf([], left({ placements: [kept(A), kept(A2)] })).teardown).toEqual([])
    expect(planOf([], left({ placements: [kept(A), A2] })).teardown).toEqual(['sakura-apprun'])
  })

  it('★★★ 一部だけ keep（混在）→ 段を足す。呼び名は「保存場所」', () => {
    expect(planOf([], left({ placements: [kept(A), B] }))).toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [], leftover: { noun: '保存場所' } })
    expect(planOf([], left({ placements: [A, kept(B)] })).leftover).toEqual({ noun: '保存場所' })
  })

  it('★★★ keep が付かない（読めなかった・口が無い）→ 今までどおり段を足す（不明を「消さない」に倒さない）', () => {
    expect(planOf([], left({ placements: [A] }))).toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [], leftover: { noun: '保存場所' } })
    expect(planOf([], left({ placements: [A, B] })).teardown).toEqual(['sakura-apprun'])
  })

  it('★★★ keep が偽・null の値は消す側として数える（keep: null が付いても段を足す）', () => {
    expect(planOf([], left({ placements: [{ ...A, keep: null } as any] })).teardown).toEqual(['sakura-apprun'])
    expect(planOf([], left({ placements: [{ ...A, keep: undefined }] })).teardown).toEqual(['sakura-apprun'])
  })

  it('★★★ アプリがあれば、保存場所が全部 keep でも足す（呼び名は null＝公開の回）', () => {
    expect(planOf([], left({ appNames: ['myapp'], placements: [kept(A)] }))).toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [], leftover: { noun: null } })
  })

  it('★★★ 数えるレジストリ（借り手なし）があれば、保存場所が全部 keep でも足す。呼び名は「コンテナレジストリ」だけ（keep は数えない）', () => {
    for (const origin of ['owned', 'adopted', 'unknown'] as const) {
      expect(planOf([], left({ registryName: 'reg', registryOrigin: origin, placements: [kept(A)] })), origin)
        .toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [], leftover: { noun: 'コンテナレジストリ' } })
    }
    // 保存場所が一部 keep でなければ、これまでどおり両方
    expect(planOf([], left({ registryName: 'reg', registryOrigin: 'owned', placements: [kept(A), B] })).leftover).toEqual({ noun: '保存場所・コンテナレジストリ' })
  })

  it('★★ 借り手のいるレジストリは数えない（K2）。全部 keep なら、レジストリの名前があっても足さない', () => {
    expect(planOf([], left({ registryName: 'reg', registryOrigin: 'owned', registryUsers: ['borrower'], placements: [kept(A)] }))).toEqual({ block: null, teardown: [], twinned: [] })
  })

  it('★★ 保存場所が無い・全部 keep でもアプリもレジストリも無い、は元から足さない（門は null）', () => {
    expect(sharedLeftoverGateOf(left())).toBeNull()
    expect(sharedLeftoverGateOf(left({ placements: [kept(A)] }))).toBeNull()
    expect(sharedLeftoverGateOf(left({ placements: [A] }))).toEqual({ noun: '保存場所' })
  })

  it('★★ 門は options（同じ押しで済んだ組・鍵・設定から外した保存場所）を渡しても、全部 keep なら null。混在は options の判断に従う', () => {
    const opts = { handled: [{ bucket: 'koto-a', prefix: 'projects/myapp/' }], keyRecorded: false, stateOnlyBuckets: [] as string[] }
    expect(sharedLeftoverGateOf(left({ placements: [kept(A)] }), opts)).toBeNull()
    expect(sharedLeftoverGateOf(left({ placements: [kept(A), B] }), opts)).toEqual({ noun: '保存場所' }) // B は済んだ組に無い
  })

  it('★★ HANAMII の行がある回: 段は HANAMII だけ。全部 keep の残りの段は足さない（HANAMII の段は変わらない）', () => {
    const p = planOf(['hanamii'], left({ placements: [kept(A)] }))
    expect(p).toEqual({ block: null, teardown: ['hanamii'], twinned: [] })
    expect(planOf(['hanamii'], left({ placements: [kept(A), B] })).teardown).toEqual(['hanamii', 'sakura-apprun'])
  })

  it('★★ 共用型の行がある回は、残りの段の門を通らない（行そのものが段）。keep の有無で変わらない', () => {
    expect(planOf(['sakura-apprun'], null, { placements: [kept(A)] })).toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [] })
  })

  it('★★ 止める理由があるときは、keep があっても止めるまま（leftover も無い）', () => {
    const p = planOf([], left({ placements: [kept(A)] }), { running: { op: '公開', target: 'hanamii' } })
    expect(p.block).not.toBeNull()
    expect('leftover' in p).toBe(false)
  })
})

describe('赤い箱の 💾（3つの経路）: keep の保存場所に「データも削除します」を言わず、「残ります」と理由を言う', () => {
  const KEPT_TWIN_LINE = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『copy』も同じデータを使っています。'
  const KEPT_UNREAD_LINE = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『broken』の記録を読めないため、同じデータを使っているか確かめられませんでした。'
  const REMOVE_B = '保存場所『koto-b』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。この保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。'

  it('★★★ leftoverNote（段を足さない回の赤い箱の注意。sharedLeftoverNote の withKeep）: 全部 keep → 理由つきの「残ります」。月額の金額は言わない（確認の費用の行・括弧の月額と同じ形）', () => {
    expect(sharedLeftoverNote(left({ placements: [kept(A)] }), { withKeep: true })).toBe(KEPT_TWIN_LINE)
    expect(sharedLeftoverNote(left({ placements: [kept(A, KEEP_UNREAD)] }), { withKeep: true })).toBe(KEPT_UNREAD_LINE)
    expect(sharedLeftoverNote(left({ placements: [kept(A)] }), { withKeep: true })).not.toContain('削除します')
  })

  it('★★★ keep の無い入力の文は、1文字も変わらない（remainingPlacementsNote・sharedLeftoverNote・withKeep でも）', () => {
    const OLD = '保存場所「koto-a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。'
    expect(remainingPlacementsNote([{ bucket: 'a' }])).toBe('保存場所「a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。')
    expect(remainingPlacementsNote([{ bucket: 'a' }, { bucket: 'b' }])).toBe('保存場所「a・b」とその中のデータは残ります（消すまで1つにつき月額495円・税込が続きます）。')
    expect(sharedLeftoverNote(left({ placements: [A] }))).toBe(OLD)
    expect(sharedLeftoverNote(left({ placements: [A] }), { withKeep: true })).toBe(OLD)
    expect(sharedLeftoverNote(left({ placements: [{ ...A, keep: null } as any] }), { withKeep: true })).toBe(OLD)
    expect(remainingPlacementsNoteWithKeep([{ bucket: 'a' }, { bucket: 'b' }])).toBe(remainingPlacementsNote([{ bucket: 'a' }, { bucket: 'b' }]))
  })

  it('★★★ withKeep を付けない既定は keep を見ない（チェックを外した回の1行は、keep の有無によらず今の文。「残ります」側の文は変えない）', () => {
    expect(sharedLeftoverNote(left({ placements: [kept(A)] }))).toBe('保存場所「koto-a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。')
  })

  it('★★ 混在の leftoverNote: 消す側は今の文、消さない側は理由つき。金額は消す側の数だけ', () => {
    expect(remainingPlacementsNoteWithKeep([kept(A), { bucket: 'koto-b' }])).toBe(
      '保存場所「koto-b」とその中のデータは残ります（消すまで月額495円・税込が続きます）。' + KEPT_TWIN_LINE)
    expect(remainingPlacementsNoteWithKeep([kept(A), { bucket: 'koto-b' }, { bucket: 'koto-c' }])).toBe(
      '保存場所「koto-b・koto-c」とその中のデータは残ります（消すまで1つにつき月額495円・税込が続きます）。' + KEPT_TWIN_LINE)
  })

  it('★★★ keptStorageNoteOf（チェックを外した回の1行）は、keep の有無によらず今の文（keep の理由は言わない）。記録の残りが無い回も同じ', () => {
    const OLD = '保存場所「koto-a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。'
    expect(keptStorageNoteOf(facts({ sharedLeftover: left({ placements: [kept(A)] }), placements: [kept(A)] }))).toBe(OLD)
    expect(keptStorageNoteOf(facts({ targets: ['sakura-apprun'], sharedLeftover: null, placements: [kept(A)] }))).toBe(OLD)
    expect(keptStorageNoteOf(facts({ sharedLeftover: left({ placements: [A] }), placements: [A] }))).toBe(OLD)
  })

  it('★★★ leftoverLine（leftoverStorageNoteLine。チェックがオンの残りの段）: 混在は、消す保存場所を「削除します」・keep の保存場所を「残ります」と言い分ける', () => {
    const f = facts({ sharedLeftover: left({ placements: [kept(A), B] }) })
    const plan = planProjectDeleteTeardown(f)
    expect(plan.leftover).toEqual({ noun: '保存場所' })
    expect(leftoverStorageNoteLine(plan, f)).toBe(REMOVE_B + KEPT_TWIN_LINE)
    // 消すものの文は keep の保存場所を名指ししない
    expect(REMOVE_B).not.toContain('koto-a')
  })

  it('★★★ leftoverLine: 全部 keep でレジストリを数える回（段は足す）は、保存場所を「残ります」と言う。「データも削除します」は出ない', () => {
    const f = facts({ sharedLeftover: left({ registryName: 'reg', registryOrigin: 'owned', placements: [kept(A)] }) })
    const plan = planProjectDeleteTeardown(f)
    expect(plan.leftover).toEqual({ noun: 'コンテナレジストリ' })
    expect(leftoverStorageNoteLine(plan, f)).toBe(KEPT_TWIN_LINE)
  })

  it('★★★ rowNotes（rowStorageNotesOf。公開先の行）: HANAMII の行の保存場所が keep なら「残ります」。keep の無い入力は今の文', () => {
    const f = facts({ targets: ['hanamii'], placements: [kept(A)] })
    const plan = planProjectDeleteTeardown(f)
    expect(rowStorageNotesOf(plan, f)).toEqual([{ target: 'hanamii', note: KEPT_TWIN_LINE }])
    expect(rowStorageNotesOf(plan, facts({ targets: ['hanamii'], placements: [kept(B, KEEP_UNREAD), A] }))[0].note.startsWith(
      '保存場所『koto-a』にある、このプロジェクトのデータも削除します。')).toBe(true)
    const none = facts({ targets: ['hanamii'], placements: [A] })
    expect(rowStorageNotesOf(planProjectDeleteTeardown(none), none)[0].note).toBe(
      '保存場所『koto-a』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。この保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。')
  })
})

describe('unsteppedLeftoverNote: 段を足さなかった残りの赤い箱の注意。公開先の行の 💾 が名指しした keep の保存場所は言い直さない', () => {
  const KEPT = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『copy』も同じデータを使っています。'
  const f = (placements: Array<Record<string, unknown>>, over: Partial<ProjectDeleteFacts> = {}) =>
    facts({ sharedLeftover: left({ placements: placements as SharedLeftover['placements'] }), placements: placements as ProjectDeleteFacts['placements'], ...over })

  it('★★★ 公開先の行が出ていない回は、keep の保存場所をそのまま言う（sharedLeftoverNote と同じ文）', () => {
    expect(unsteppedLeftoverNote(f([kept(A)]), false)).toBe(KEPT)
    expect(unsteppedLeftoverNote(f([kept(A)]), false)).toBe(sharedLeftoverNote(left({ placements: [kept(A)] }), { withKeep: true }))
  })

  it('★★★ 公開先の行が出ている回（HANAMII の行）は、その行が名指しした keep の保存場所を言い直さない。名指しされていない保存場所は言う', () => {
    expect(unsteppedLeftoverNote(f([kept(A)]), true)).toBe('')
    const both = facts({ sharedLeftover: left({ placements: [kept(A), kept(B, KEEP_UNREAD)] }), placements: [kept(A)] })
    expect(unsteppedLeftoverNote(both, true)).toBe('保存場所『koto-b』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『broken』の記録を読めないため、同じデータを使っているか確かめられませんでした。')
  })

  it('★★★ keep の無い保存場所・レジストリの文は、公開先の行が出ていても今のまま（言い直さないのは keep のあるものだけ）', () => {
    const plain = left({ placements: [A], registryName: 'reg', registryOrigin: 'adopted', registryUsers: ['other'] })
    expect(unsteppedLeftoverNote(facts({ sharedLeftover: plain, placements: [A] }), true)).toBe(sharedLeftoverNote(plain))
    const reg = left({ placements: [kept(A)], registryName: 'reg', registryOrigin: 'adopted', registryUsers: ['other'] })
    expect(unsteppedLeftoverNote(facts({ sharedLeftover: reg, placements: [kept(A)] }), true)).toBe('コンテナレジストリ『reg』も残ります。')
  })

  it('★★ 記録の残りが無い回は空', () => {
    expect(unsteppedLeftoverNote(facts({ placements: [kept(A)] }), true)).toBe('')
  })

  it('★★★ 名指しされたかは、名前と prefix の組で比べる: 同じバケットの別の prefix（P1 は消す・P2 は keep）の P2 の「残ります」は、公開先の行が出ていても赤い箱から消えない', () => {
    const P2 = { ...A, prefix: 'projects/other/' }
    // 公開先の行が言うのは env.json の P1（消す側）だけ。P2 は記録の残りにだけある keep の保存場所
    const f1 = facts({ sharedLeftover: left({ placements: [kept(P2)] }), placements: [A] })
    expect(unsteppedLeftoverNote(f1, true)).toBe(KEPT)
    // P2 まで公開先の行が名指ししているなら、言い直さない（同じ組）
    const f2 = facts({ sharedLeftover: left({ placements: [kept(P2)] }), placements: [A, kept(P2)] })
    expect(unsteppedLeftoverNote(f2, true)).toBe('')
    // P1・P2 とも keep で、行が名指ししたのは P1 だけ → P2 は言う（同じバケットの名前だけで消さない）
    const f3 = facts({ sharedLeftover: left({ placements: [kept(A), kept(P2)] }), placements: [kept(A)] })
    expect(unsteppedLeftoverNote(f3, true)).toBe(KEPT)
  })

  it('★★ 公開先の行が出ていない回は、同じバケットの別の prefix の keep も、そのまま言う', () => {
    const P2 = { ...A, prefix: 'projects/other/' }
    expect(unsteppedLeftoverNote(facts({ sharedLeftover: left({ placements: [kept(P2)] }), placements: [A] }), false)).toBe(KEPT)
  })

  it('★★ 変えないもの: keep の無い入力は、公開先の行が同じバケットを名指しした回も今のまま（残りの段の行 leftoverStorageNoteLine は、同じバケットの文を2回言わない）', () => {
    const P2 = { ...A, prefix: 'projects/other/' }
    for (const placements of [[A, P2], [P2, A]]) {
      const f = facts({ targets: ['hanamii'], sharedLeftover: left({ placements }), placements: [A] })
      const plan = planProjectDeleteTeardown(f)
      expect(plan.teardown).toEqual(['hanamii', 'sakura-apprun'])
      expect(leftoverStorageNoteLine(plan, f)).toBe('')
      expect(unsteppedLeftoverNote(f, true)).toBe(sharedLeftoverNote(left({ placements }), { withKeep: true }))
    }
  })
})

describe('leftoverStorageNoteLine: HANAMII の行が名指しした保存場所の除き方（keep のある保存場所は名前と prefix の組で比べる）', () => {
  const plan = { teardown: ['hanamii', 'sakura-apprun'] as PublishTargetKind[], leftover: { noun: '保存場所' } }
  const P1 = { bucket: 'koto-a', prefix: 'projects/x/', shared: true }
  const P2 = { bucket: 'koto-a', prefix: 'projects/y/', shared: true }
  const KEPT_A = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『copy』も同じデータを使っています。'
  const f = (placements: unknown[], row: unknown[]) =>
    facts({ placements: row as ProjectDeleteFacts['placements'], sharedLeftover: left({ placements: placements as SharedLeftover['placements'] }) })

  it('★★★ 同じバケットの別の prefix が keep（P1 は消す・P2 は keep）: HANAMII の行が P1 を名指ししても、P2 の「残ります」は言う', () => {
    expect(leftoverStorageNoteLine(plan, f([P1, kept(P2)], [P1]))).toBe(KEPT_A)
  })

  it('★★★ P1 も P2 も keep で、行が名指ししたのは P1 だけ: P2 は言う。P2 まで名指ししていれば言い直さない（同じ組）', () => {
    expect(leftoverStorageNoteLine(plan, f([kept(P1), kept(P2)], [kept(P1)]))).toBe(KEPT_A)
    expect(leftoverStorageNoteLine(plan, f([kept(P1), kept(P2)], [kept(P1), kept(P2)]))).toBe('')
    expect(leftoverStorageNoteLine(plan, f([kept(P2)], [P1, kept(P2)]))).toBe('')
  })

  it('★★ 行が出ていない回（HANAMII の段が箱に無い）は、名指しで除かない', () => {
    expect(leftoverStorageNoteLine(plan, f([P1, kept(P2)], [P1]), ['sakura-apprun'])).toBe(
      '保存場所『koto-a』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。この保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。' + KEPT_A)
  })

  it('★★ keep の無い保存場所は、同じバケット名が名指しされていれば、prefix が違っても除く（今のまま）', () => {
    expect(leftoverStorageNoteLine(plan, f([P1, P2], [P1]))).toBe('')
    expect(leftoverStorageNoteLine(plan, f([P2], [P1]))).toBe('')
  })
})

describe('Vercel の案内の最後の文: 保存場所が全部 keep なら実際に残るので、「残ります」を言う側（消す保存場所がある回だけ言わない）', () => {
  const plan = (sharedLeftover: SharedLeftover) => planProjectDeleteTeardown(facts({ targets: ['vercel'], sharedLeftover }))
  const gone = (sharedLeftover: SharedLeftover) => vercelStorageTornDown(plan(sharedLeftover), facts({ sharedLeftover }), true)

  it('★★★ 消す保存場所がある → 言わない（偽でなく真）。keep の無い入力は今までどおり', () => {
    expect(gone(left({ placements: [A] }))).toBe(true)
    expect(gone(left({ placements: [kept(A), B] }))).toBe(true)
  })

  it('★★★ 保存場所が全部 keep でレジストリだけを破棄する回（段は足される）→ 偽。保存場所は残るので、案内の最後の文を言う', () => {
    const l = left({ registryName: 'reg', registryOrigin: 'owned', placements: [kept(A)] })
    expect(plan(l).leftover).toEqual({ noun: 'コンテナレジストリ' })
    expect(gone(l)).toBe(false)
  })
})
