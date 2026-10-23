import { describe, it, expect } from 'vitest'
import { ownRegistryBillingNote, sharedLeftoverNote, remainingPlacementsNote, type ProjectDeleteFacts, type SharedLeftover } from '../src/renderer/teardown/projectDeletePlan'
import type { PublishTargetKind } from '../src/renderer/publishStatus'

// ── 「公開も一緒に破棄する」を外したときの、コンテナレジストリの月額の文（2026-10-19、0.6.22-rc.1 の実機）──────────────────
// 言うのは、先に破棄する公開先に共用型があり、その記録のレジストリが「このプロジェクトのために Koto が作った（owned）もので、ほかのプロジェクトが
// 使っていない」ときだけ。共用型の行があるだけでは言わない（記録が無いプロジェクトにも「月額220円が続きます」と言っていた）。
// 文の期待は、関数を通さず書き下す。
describe('ownRegistryBillingNote: owned で、借り手がいないときだけ月額を言う', () => {
  const SENTENCE = 'コンテナレジストリの月額220円（税込）が、消すまで続きます。'
  const facts = (sharedRegistry: ProjectDeleteFacts['sharedRegistry']): Pick<ProjectDeleteFacts, 'sharedRegistry'> => ({ sharedRegistry })
  const reg = (origin: 'owned' | 'adopted' | 'unknown', users: string[] = [], registryName = 'myreg') => ({ registryName, origin, users })
  const SHARED: PublishTargetKind[] = ['sakura-apprun']

  it('★★★ owned で借り手がいない → 言う。文は今のまま', () => {
    expect(ownRegistryBillingNote(facts(reg('owned')), SHARED)).toBe(SENTENCE)
    expect(ownRegistryBillingNote(facts(reg('owned')), ['hanamii', 'sakura-apprun'])).toBe(SENTENCE)
  })

  it('★★★ レジストリの記録が無い（作者の実例: .sakura-cloud が無く、共用型の行だけ）・材料が無い → 言わない', () => {
    expect(ownRegistryBillingNote(facts(null), SHARED)).toBe('')
    expect(ownRegistryBillingNote({} as any, SHARED)).toBe('') // 材料の項目が無い旧い形でも、言う側に倒れない
  })

  it('★★★ owned でも、ほかのプロジェクトが借りている → 言わない（1件でも）', () => {
    expect(ownRegistryBillingNote(facts(reg('owned', ['reminder'])), SHARED)).toBe('')
    expect(ownRegistryBillingNote(facts(reg('owned', ['reminder', 'landing', 'x', 'y'])), SHARED)).toBe('')
  })

  it('★★★ 借りたもの（adopted）・作ったか分からないもの（unknown）→ 言わない（借り手の有無に関わらず）', () => {
    for (const users of [[], ['reminder']]) {
      expect(ownRegistryBillingNote(facts(reg('adopted', users)), SHARED), `adopted ${users}`).toBe('')
      expect(ownRegistryBillingNote(facts(reg('unknown', users)), SHARED), `unknown ${users}`).toBe('')
    }
  })

  it('★★ 名前が空のレジストリ → 言わない。先に破棄する公開先に共用型が無い（済んだ・HANAMII だけ）→ 言わない', () => {
    expect(ownRegistryBillingNote(facts(reg('owned', [], '')), SHARED)).toBe('')
    expect(ownRegistryBillingNote(facts(reg('owned')), [])).toBe('')
    expect(ownRegistryBillingNote(facts(reg('owned')), ['hanamii'])).toBe('')
  })
})

// ── 共用型の行は無いが、記録にレジストリが残っているプロジェクト（赤い箱の 💾 の行。上と同じ判断）──────────────────
// 月額まで言うのは、このプロジェクトだけのレジストリ（owned で借り手なし）のときだけ。それ以外は、残ることだけを言う。
describe('sharedLeftoverNote: コンテナレジストリの月額は、owned で借り手がいないときだけ言う', () => {
  const placements = [{ bucket: 'koto-a', prefix: 'projects/a/', shared: true }]
  const left = (registryOrigin: SharedLeftover['registryOrigin'], registryUsers: string[] = [], registryName: string | null = 'reg', pl = placements): SharedLeftover =>
    ({ registryName, registryOrigin, registryUsers, placements: pl })
  const WITH_COST = 'コンテナレジストリ『reg』も残ります（消すまで月額220円・税込が続きます）。'
  const WITHOUT_COST = 'コンテナレジストリ『reg』も残ります。'

  it('★★★ owned で借り手がいない → 名前と月額220円。保存場所があれば、保存場所 → レジストリの順', () => {
    expect(sharedLeftoverNote(left('owned', [], 'reg', []))).toBe(WITH_COST)
    expect(sharedLeftoverNote(left('owned'))).toBe(remainingPlacementsNote(placements) + WITH_COST)
  })

  it('★★★ 借りたもの（adopted）・作ったか分からないもの（unknown）→ 残ることだけ。月額は言わない（借り手の有無に関わらず）', () => {
    for (const users of [[], ['reminder']]) {
      for (const origin of ['adopted', 'unknown'] as const) {
        expect(sharedLeftoverNote(left(origin, users, 'reg', [])), `${origin} ${users}`).toBe(WITHOUT_COST)
        expect(sharedLeftoverNote(left(origin, users)), `${origin} ${users}`).toBe(remainingPlacementsNote(placements) + WITHOUT_COST)
      }
    }
  })

  it('★★★ owned でも、ほかのプロジェクトが使っている → 残ることだけ。月額は言わない（1件でも）', () => {
    expect(sharedLeftoverNote(left('owned', ['reminder'], 'reg', []))).toBe(WITHOUT_COST)
    expect(sharedLeftoverNote(left('owned', ['reminder', 'landing', 'x', 'y']))).toBe(remainingPlacementsNote(placements) + WITHOUT_COST)
  })

  it('★★ 保存場所の月額（495円）は、レジストリの由来に関わらず言う。どちらも無ければ空', () => {
    for (const origin of ['owned', 'adopted', 'unknown'] as const) expect(sharedLeftoverNote(left(origin, [], null)), origin).toBe(remainingPlacementsNote(placements))
    expect(sharedLeftoverNote(left('owned', [], null, []))).toBe('')
  })
})
