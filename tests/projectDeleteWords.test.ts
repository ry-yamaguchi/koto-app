import { describe, it, expect } from 'vitest'
import { planProjectDeleteTeardown, PROJECT_DELETE_STOPPED_TAIL_LEFTOVER, type ProjectDeleteFacts, type SharedLeftover } from '../src/renderer/teardown/projectDeletePlan'
import { projectDeleteCheckWords, isUnpublishedLeftoverPlan, leftoverStorageNoteLine, keptStorageNoteOf, rowStorageNotesOf, vercelStorageTornDown } from '../src/renderer/teardown/projectDeleteWords'
import type { PublishTargetKind } from '../src/renderer/publishStatus'

// ── 0.6.24 A（U10）: プロジェクトの削除のダイアログの文（plan・材料から決まるもの）。仕様 docs/v0624-aefi-spec.md の A-3・A-4・A-7、3章 T-A5・T-A6 ──────
// 文の期待は関数を通さず書き下す（関数を写した期待は、関数が壊れても通る）。plan は本物の planProjectDeleteTeardown で作る（門と文が同じ判断を通ることを見る）。

const facts = (over: Partial<ProjectDeleteFacts> = {}): ProjectDeleteFacts =>
  ({ targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null, ...over })
const A = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
const B = { bucket: 'koto-b', prefix: 'projects/old/', shared: false }
const left = (over: Partial<SharedLeftover> = {}): SharedLeftover =>
  ({ appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [], ...over })
const make = (targets: PublishTargetKind[], sharedLeftover: SharedLeftover | null, over: Partial<ProjectDeleteFacts> = {}) => {
  const f = facts({ targets, sharedLeftover, ...over })
  return { f, plan: planProjectDeleteTeardown(f) }
}
const wordsOf = (targets: PublishTargetKind[], sharedLeftover: SharedLeftover | null) => { const { f, plan } = make(targets, sharedLeftover); return projectDeleteCheckWords(plan, f) }

// 公開のある回の文は、1文字も変えない（もとのダイアログの文）
const PUBLIC = {
  label: '公開も一緒に破棄する',
  on: '先に公開を破棄してから、フォルダをゴミ箱へ移します。破棄に失敗したときは削除しません。',
  off: '公開はそのまま残ります。フォルダを消すと「どこに何を公開したか」の記録も消えるため、あとから Koto では破棄できなくなります。',
  running: '公開を破棄しています…',
}
const ON_PLAIN = '先に破棄してから、フォルダをゴミ箱へ移します。破棄に失敗したときは削除しません。'
const OFF_PLAIN = 'フォルダを消すと記録も消えるため、あとから Koto では破棄できなくなります。'
const CHOOSE = (r: string) => ` コンテナレジストリ『${r}』を消すかは、次の確認で選べます。`

describe('T-A5 projectDeleteCheckWords: チェックの文（公開のある回は今のまま・公開していない回は残りの呼び名で言う）', () => {
  it.each([
    ['HANAMII の行', ['hanamii'] as PublishTargetKind[], null],
    ['共用型の行', ['sakura-apprun'] as PublishTargetKind[], null],
    ['行の無いアプリ（記録にアプリが残る）', [] as PublishTargetKind[], left({ appNames: ['myapp-app'] })],
    ['行の無いアプリと保存場所', [] as PublishTargetKind[], left({ appNames: ['myapp-app'], placements: [A] })],
    ['HANAMII の行と保存場所（段が2つ）', ['hanamii'] as PublishTargetKind[], left({ placements: [A] })],
    ['HANAMII の行と借り手のいないレジストリ', ['hanamii'] as PublishTargetKind[], left({ registryName: 'reg', registryOrigin: 'adopted' })],
    ['何も無い（段が無い）', [] as PublishTargetKind[], null],
  ])('★★★ 公開あり: %s → 今の文のまま（1文字も変えない）。実行中は「公開を破棄しています…」', (_n, targets, sharedLeftover) => {
    expect(wordsOf(targets, sharedLeftover)).toEqual(PUBLIC)
  })

  it('★★★ 保存場所だけ → 「保存場所も一緒に破棄する」。オフの説明は、公開の記録が無いので「記録」と言う。実行中は「破棄しています…」', () => {
    expect(wordsOf([], left({ placements: [A] }))).toEqual({ label: '保存場所も一緒に破棄する', on: ON_PLAIN, off: OFF_PLAIN, running: '破棄しています…' })
  })

  it('★★★ Vercel・レンタルサーバの行と保存場所 → 公開していない回（teardown は共用型の段1つだけ。facts.targets が空かどうかで決めない）', () => {
    expect(wordsOf(['vercel'], left({ placements: [A] }))).toEqual({ label: '保存場所も一緒に破棄する', on: ON_PLAIN, off: OFF_PLAIN, running: '破棄しています…' })
    expect(wordsOf(['sakura-rental', 'vercel'], left({ placements: [A] })).label).toBe('保存場所も一緒に破棄する')
  })

  it('★★★ 借り手のいないレジストリだけ: owned は確認の既定がオンなので、確認で選べるとは言わない。adopted・unknown は既定オフなので、オンの説明に足す', () => {
    expect(wordsOf([], left({ registryName: 'reg', registryOrigin: 'owned' }))).toEqual({ label: 'コンテナレジストリも一緒に破棄する', on: ON_PLAIN, off: OFF_PLAIN, running: '破棄しています…' })
    for (const origin of ['adopted', 'unknown'] as const) {
      expect(wordsOf([], left({ registryName: 'reg', registryOrigin: origin })), origin).toEqual({ label: 'コンテナレジストリも一緒に破棄する', on: ON_PLAIN + CHOOSE('reg'), off: OFF_PLAIN, running: '破棄しています…' })
    }
  })

  it('★★ 保存場所とレジストリの両方 →「保存場所・コンテナレジストリも一緒に破棄する」。借り物なら確認で選べると足す', () => {
    expect(wordsOf([], left({ placements: [A], registryName: 'reg', registryOrigin: 'owned' })).label).toBe('保存場所・コンテナレジストリも一緒に破棄する')
    expect(wordsOf([], left({ placements: [A], registryName: 'reg', registryOrigin: 'adopted' })).on).toBe(ON_PLAIN + CHOOSE('reg'))
  })

  it('★★ 借り手のいるレジストリと保存場所 → 呼び名は「保存場所」だけ。数えないレジストリのことは言わない', () => {
    expect(wordsOf([], left({ placements: [A], registryName: 'reg', registryOrigin: 'adopted', registryUsers: ['reminder'] }))).toEqual({ label: '保存場所も一緒に破棄する', on: ON_PLAIN, off: OFF_PLAIN, running: '破棄しています…' })
  })

  it('★★ 材料を渡さない呼び方は、選べるという足しを付けない（呼び名・ほかの文は同じ）', () => {
    const { plan } = make([], left({ registryName: 'reg', registryOrigin: 'adopted' }))
    expect(projectDeleteCheckWords(plan).on).toBe(ON_PLAIN)
    expect(projectDeleteCheckWords(plan, null).label).toBe('コンテナレジストリも一緒に破棄する')
  })

  it('★★★ 「公開していない回」は teardown が共用型の段1つだけで、その段が残りのためのものであるとき。段が2つ・アプリが残る回・残りの段が無い回は公開あり', () => {
    expect(isUnpublishedLeftoverPlan({ teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })).toBe(true)
    expect(isUnpublishedLeftoverPlan({ teardown: ['hanamii', 'sakura-apprun'], leftover: { noun: '保存場所' } })).toBe(false)
    expect(isUnpublishedLeftoverPlan({ teardown: ['sakura-apprun'], leftover: { noun: null } })).toBe(false)
    expect(isUnpublishedLeftoverPlan({ teardown: ['sakura-apprun'] })).toBe(false)
    expect(isUnpublishedLeftoverPlan({ teardown: ['hanamii'], leftover: { noun: '保存場所' } })).toBe(false)
    expect(isUnpublishedLeftoverPlan({ teardown: [], leftover: { noun: '保存場所' } })).toBe(false)
  })

  it('★★ A-7 の尻（公開していない回）: 記録も消えて破棄できなくなる・もう一度押す・コントロールパネルで確かめたときだけチェックを外す', () => {
    expect(PROJECT_DELETE_STOPPED_TAIL_LEFTOVER).toBe(
      'このままフォルダを削除すると、保存場所などの記録も消えて、Koto から破棄できなくなります。'
      + 'もう一度「🗑 ゴミ箱に移動」を押してください。保存場所がもう無いことをコントロールパネルで確かめたときだけ、チェックを外して削除できます。')
  })
})

describe('T-A6 💾 の行: オフは state にだけある保存場所とレジストリも言い、オンの残りの行は HANAMII が名指しした保存場所を言い直さない', () => {
  const OFF_ONE_A = '保存場所「koto-a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。'
  const ON_ONE = (b: string, shared: boolean) => `保存場所『${b}』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。`
    + (shared ? 'この保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。' : '残るものが無ければ、保存場所そのものも削除して月額を止めます。')
  const ON_TWO = '保存場所『koto-a』『koto-b』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。'
    + 'それぞれの保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。'

  it('★★★ オフ: state にだけある保存場所（env.json に無い）とレジストリが出る。同じ保存場所は1回だけ', () => {
    const f = facts({ placements: [A], sharedLeftover: left({ placements: [A, B], registryName: 'reg', registryOrigin: 'adopted' }) })
    expect(keptStorageNoteOf(f)).toBe('保存場所「koto-a・koto-b」とその中のデータは残ります（消すまで1つにつき月額495円・税込が続きます）。コンテナレジストリ『reg』も残ります。')
  })

  it('★★★ オフ: 記録だけに保存場所がある（材料の placements は空）→ 言う。レジストリだけ → レジストリの文だけ。借り手のいない owned は月額まで言う', () => {
    expect(keptStorageNoteOf(facts({ sharedLeftover: left({ placements: [A] }) }))).toBe(OFF_ONE_A)
    expect(keptStorageNoteOf(facts({ sharedLeftover: left({ registryName: 'reg', registryOrigin: 'adopted' }) }))).toBe('コンテナレジストリ『reg』も残ります。')
    expect(keptStorageNoteOf(facts({ sharedLeftover: left({ registryName: 'reg', registryOrigin: 'owned' }) }))).toBe('コンテナレジストリ『reg』も残ります（消すまで月額220円・税込が続きます）。')
  })

  it('★★★ オフ: 材料の placements（env.json）にだけある保存場所も落とさない。同じバケットの別 prefix は名前を1回だけ', () => {
    expect(keptStorageNoteOf(facts({ placements: [A], sharedLeftover: left({ registryName: 'reg', registryOrigin: 'adopted' }) })))
      .toBe(OFF_ONE_A + 'コンテナレジストリ『reg』も残ります。')
    expect(keptStorageNoteOf(facts({ placements: [A, { ...A, prefix: 'projects/other/' }], sharedLeftover: left({ placements: [A] }) }))).toBe(OFF_ONE_A)
  })

  it('★★ オフ: 記録の残りが無い回は今のまま（材料の placements の文）。何も残らない回は空', () => {
    expect(keptStorageNoteOf(facts({ placements: [A] }))).toBe(OFF_ONE_A)
    expect(keptStorageNoteOf(facts())).toBe('')
    expect(keptStorageNoteOf(facts({ sharedLeftover: left() }))).toBe('')
  })

  it('★★★ オンの残りの行: HANAMII が無い回は、記録の保存場所の全件を名指しする。公開先の名前は前に付けない（文だけ）', () => {
    const { f, plan } = make(['vercel'], left({ placements: [A, B] }), { placements: [A] })
    expect(leftoverStorageNoteLine(plan, f)).toBe(ON_TWO)
    const one = make([], left({ placements: [B] }))
    expect(leftoverStorageNoteLine(one.plan, one.f)).toBe(ON_ONE('koto-b', false))
  })

  it('★★★ オンの残りの行: HANAMII と並ぶ回は、HANAMII の行がすでに名指しした保存場所を除く（同じ保存場所を2回言わない）。残りが同じなら行を出さない', () => {
    const more = make(['hanamii'], left({ placements: [A, B] }), { placements: [A] })
    expect(leftoverStorageNoteLine(more.plan, more.f)).toBe(ON_ONE('koto-b', false))
    const same = make(['hanamii'], left({ placements: [A] }), { placements: [A] })
    expect(same.plan.teardown).toEqual(['hanamii', 'sakura-apprun'])
    expect(leftoverStorageNoteLine(same.plan, same.f)).toBe('')
  })

  it('★★ オンの残りの行: HANAMII の破棄が済んで箱から外れた後（shownTeardown に HANAMII が無い）は、除かない。同じバケットの別 prefix は1つにまとめる', () => {
    const { f, plan } = make(['hanamii'], left({ placements: [A, { ...A, prefix: 'projects/other/' }] }), { placements: [A] })
    expect(leftoverStorageNoteLine(plan, f, ['sakura-apprun'])).toBe(ON_ONE('koto-a', true))
    expect(leftoverStorageNoteLine(plan, f)).toBe('')
  })

  it('★★ オンの残りの行: 残りの段が無い回（行のある共用型・段を足さなかった回）・箱に共用型の段が無い回・材料に残りが無い回は空', () => {
    const row = make(['hanamii', 'sakura-apprun'], null, { placements: [A] })
    expect(row.plan.leftover).toBeUndefined()
    expect(leftoverStorageNoteLine(row.plan, row.f)).toBe('')
    const { f, plan } = make([], left({ placements: [A] }))
    expect(leftoverStorageNoteLine(plan, f, [])).toBe('')
    expect(leftoverStorageNoteLine(plan, facts())).toBe('')
    expect(leftoverStorageNoteLine({ teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } }, facts({ sharedLeftover: left({ placements: [] }) }))).toBe('')
  })
})

describe('U12 rowStorageNotesOf: チェックがオンの 💾 の行のうち、公開先の行（残りの段は除く）', () => {
  const one = (bucket: string) => `保存場所『${bucket}』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。`
  it('★★★ 行のある HANAMII・共用型は、公開先ごとに env.json の保存場所（facts.placements）で1行。並びは段の並び（HANAMII が先）', () => {
    const { f, plan } = make(['sakura-apprun', 'hanamii'], null, { placements: [B] })
    const rows = rowStorageNotesOf(plan, f)
    expect(rows.map(r => r.target)).toEqual(['hanamii', 'sakura-apprun'])
    expect(rows.every(r => r.note.startsWith(one('koto-b')))).toBe(true)
  })

  it('★★★ 残りの段（plan.leftover の共用型）は返さない。返すと「📦 さくらのAppRun:」を前に付けた行が env の保存場所で出る。HANAMII の行は残る', () => {
    const { f, plan } = make(['hanamii'], left({ placements: [A] }), { placements: [B] })
    expect(plan.teardown).toEqual(['hanamii', 'sakura-apprun'])
    expect(plan.leftover).toBeDefined()
    expect(rowStorageNotesOf(plan, f).map(r => r.target)).toEqual(['hanamii'])
    const alone = make([], left({ placements: [A] }), { placements: [B] })
    expect(alone.plan.teardown).toEqual(['sakura-apprun'])
    expect(rowStorageNotesOf(alone.plan, alone.f)).toEqual([])
  })

  it('★★ 箱に出している段（shownTeardown）だけ。済んで外れた HANAMII は返さない。保存場所が無い回・保存場所を消さない段は返さない', () => {
    const { f, plan } = make(['hanamii', 'sakura-apprun'], null, { placements: [B] })
    expect(rowStorageNotesOf(plan, f, ['sakura-apprun']).map(r => r.target)).toEqual(['sakura-apprun'])
    expect(rowStorageNotesOf(plan, f, [])).toEqual([])
    const none = make(['hanamii'], null)
    expect(rowStorageNotesOf(none.plan, none.f)).toEqual([])
  })
})

describe('U12 vercelStorageTornDown（A-9）: Vercel の案内の最後の文を言わない回', () => {
  const t = (targets: PublishTargetKind[], sl: SharedLeftover | null, on: boolean, shown?: PublishTargetKind[]) => {
    const { f, plan } = make(targets, sl)
    return vercelStorageTornDown(plan, f, on, shown)
  }
  it('★★★ 真: チェックがオンで、残りの段があり、その段が保存場所を破棄する（Vercel の行があってもなくても）', () => {
    expect(t(['vercel'], left({ placements: [A] }), true)).toBe(true)
    expect(t([], left({ placements: [A], registryName: 'R', registryOrigin: 'owned' }), true)).toBe(true)
    expect(t(['vercel', 'hanamii'], left({ placements: [A] }), true)).toBe(true)
  })

  it('★★★ 偽: チェックが外れている（保存場所は残る）。true 以外（渡し忘れ・形違い）も偽', () => {
    expect(t(['vercel'], left({ placements: [A] }), false)).toBe(false)
    const { f, plan } = make(['vercel'], left({ placements: [A] }))
    expect(vercelStorageTornDown(plan, f, undefined as unknown as boolean)).toBe(false)
    expect(vercelStorageTornDown(plan, f, 'true' as unknown as boolean)).toBe(false)
  })

  it('★★★ 偽: 残りの段が無い（行のある共用型だけ・K2 で足さない・段を足さない回）', () => {
    expect(t(['vercel'], null, true)).toBe(false)
    expect(t(['vercel', 'sakura-apprun'], null, true)).toBe(false)
    expect(t(['vercel'], left({ registryName: 'R', registryOrigin: 'adopted', registryUsers: ['other'] }), true)).toBe(false)
  })

  it('★★★ 偽: 残りの段が保存場所に触れない（レジストリだけ・アプリだけ）。保存場所は実際に残るので、「残ります」を消さない', () => {
    expect(t(['vercel'], left({ registryName: 'R', registryOrigin: 'owned' }), true)).toBe(false)
    expect(t(['vercel'], left({ appNames: ['myapp'] }), true)).toBe(false)
  })

  it('★★★ 偽: 覆う複製があって段を足さない回（保存場所は記録に残るが、破棄しない）。plan.leftover が無いので、保存場所は残る', () => {
    const { f, plan } = make(['vercel'], left({ placements: [A] }), { twins: { hanamii: [], 'sakura-apprun': ['myapp copy'], 'sakura-apprun-dedicated': [] } })
    expect(plan.leftover).toBeUndefined()
    expect(plan.teardown).toEqual([])
    expect(vercelStorageTornDown(plan, f, true)).toBe(false)
  })

  it('★★★ 偽: 残りの段の印（plan.leftover）が無ければ、共用型の段があり記録に保存場所が残っていても偽（印で決める。段の有無だけで決めない。仕様は「残りの段がある回だけ」）', () => {
    const f = { sharedLeftover: left({ placements: [A] }) }
    expect(vercelStorageTornDown({ teardown: ['sakura-apprun'] }, f, true)).toBe(false)
    expect(vercelStorageTornDown({ teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } }, f, true)).toBe(true)
  })

  it('★★ 偽: 残りの段が箱から外れている（shownTeardown に共用型が無い）。保存場所が配列でない形も偽', () => {
    expect(t(['vercel'], left({ placements: [A] }), true, [])).toBe(false)
    const { f, plan } = make(['vercel'], left({ placements: [A] }))
    expect(vercelStorageTornDown(plan, { sharedLeftover: { ...f.sharedLeftover!, placements: undefined as unknown as [] } }, true)).toBe(false)
  })
})
