import { describe, it, expect } from 'vitest'

// ── T-R1e: 確認の文の食い違い（「削除しません」と「データも消えます」が並ぶ）を直す（0.6.24 R1-e）────────────────────────────────
// 状況（0.6.24 U1〜U5 の検分で指摘）: 保存場所の設定を読めない（'settings'）・問い合わせられなかった（'call'）回は、main が保存場所を1件も消さない。
// 確認の文は「保存場所は削除しません（使っていれば残り、月額が続きます）」と言うのに、ほかの公開先の記録も読めない回は、同じ確認の中で
// 「保存場所をほかの公開先が使っていれば、そちらのアプリのデータも消えます」とも言っていた。消えないものを消えると言う、正反対の2文。
// 直し方: `placementsUnreadable` が真の回は、「ほかの公開先の記録を読めなかった」の段落（「…データも消えます」）を出さない。
// 保存場所は読めて、ほかの公開先の記録だけ読めなかった回は、今どおりその段落を出す（main はそのとき、見せた保存場所を消す）。
// 判断は `unreadableCautions` の1つ。3つの公開先（HANAMII・共用型・専有型）の確認はすべて `buildTeardownConfirm` → これを通る。
import { unreadableCautions, buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import { hanamiiTeardownSpec, HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import { dedicatedTeardownSpec } from '../src/renderer/teardown/targets/dedicated'
import type { PublishTargetKind } from '../src/shared/publishMeta'

const TARGETS: PublishTargetKind[] = ['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated']
const NOTES = ['storage-only', 'always'] as const
const CAUSES = ['settings', 'call', null] as const
const BAD = 'データも消えます'
const OTHERS_HEAD = '⚠️ ほかの公開先の記録を読めなかったため'

describe('★★★ 保存場所に触れない回（settings・call）は、ほかの公開先の記録を読めなくても、「データも消えます」の段落を出さない', () => {
  for (const target of TARGETS) {
    for (const note of NOTES) {
      for (const cause of CAUSES) {
        it(`${target}・${note}・${String(cause)}: 注意は保存場所の1文だけ。「データも消えます」も「ほかの公開先の記録を読めなかった」も出ない`, () => {
          const cautions = unreadableCautions({ placementsUnreadable: true, placementsUnreadableCause: cause, otherTargetsUnreadable: true, otherTargets: [] }, HANAMII_TEARDOWN_WORDS, note, target)
          expect(cautions).toHaveLength(1)
          expect(cautions.join('\n')).not.toContain(BAD)
          expect(cautions.join('\n')).not.toContain(OTHERS_HEAD)
          expect(cautions[0]).toContain('保存場所の設定を')
          // ほかの公開先の記録が読めている回（otherTargetsUnreadable:false）と同じ出力（読めなかったことは、この回の注意を増やさない）
          expect(cautions).toEqual(unreadableCautions({ placementsUnreadable: true, placementsUnreadableCause: cause, otherTargetsUnreadable: false, otherTargets: [] }, HANAMII_TEARDOWN_WORDS, note, target))
        })
      }
    }
  }

  it('settings の注意は「保存場所の削除は行われません」、call の注意は「名前を挙げられない保存場所は削除しません」を言い、どちらも消える話はしない', () => {
    const settings = unreadableCautions({ placementsUnreadable: true, placementsUnreadableCause: 'settings', otherTargetsUnreadable: true, otherTargets: [] }, HANAMII_TEARDOWN_WORDS, 'always', 'hanamii')
    const call = unreadableCautions({ placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargetsUnreadable: true, otherTargets: [] }, HANAMII_TEARDOWN_WORDS, 'always', 'hanamii')
    expect(settings[0]).toContain('保存場所の削除は行われません')
    expect(call[0]).toContain('名前を挙げられない保存場所は削除しません')
    for (const s of [...settings, ...call]) expect(s).not.toContain('消えます')
  })
})

describe('★★ 対照: 保存場所は読めて、ほかの公開先の記録だけ読めなかった回は、今どおりその注意を出す', () => {
  for (const target of TARGETS) {
    for (const note of NOTES) {
      it(`${target}・${note}: placementsUnreadable:false → 「ほかの公開先の記録を読めなかった」と「そちらのアプリのデータも消えます」が出る`, () => {
        const cautions = unreadableCautions({ placementsUnreadable: false, placementsUnreadableCause: null, otherTargetsUnreadable: true, otherTargets: [] }, HANAMII_TEARDOWN_WORDS, note, target)
        expect(cautions).toHaveLength(1)
        expect(cautions[0].startsWith(OTHERS_HEAD)).toBe(true)
        expect(cautions[0]).toContain('そちらのアプリのデータも消えます')
      })
    }
  }
})

describe('★★★ 3つの公開先の確認ダイアログの本文（buildTeardownConfirm）でも同じ。保存場所に触れない回の本文に「データも消えます」が無い', () => {
  // 材料は最小限。仕様書の targets・leftoverNote・notes が読む項目だけを持つ（本物の仕様書を通す）
  const CASES = [
    { name: 'HANAMII', spec: hanamiiTeardownSpec, record: { projectId: 'p1', name: 'myapp', storageLeftoverBuckets: null } },
    { name: '共用型', spec: sharedTeardownSpec, record: { appNames: ['myapp'], registryName: null, registryOrigin: 'unknown', placements: [], stateOnlyBuckets: [], registryUsers: [] } },
    { name: '専有型', spec: dedicatedTeardownSpec, record: { applicationID: 'app1', applicationName: 'myapp', clusterID: 'c1' } },
  ] as const
  const factsOf = (record: unknown, over: Record<string, unknown>) => ({
    projectName: 'myapp', record, placements: [], otherTargets: [], waitNote: null,
    placementsUnreadable: false, placementsUnreadableCause: null, otherTargetsUnreadable: false, ...over,
  }) as any

  for (const c of CASES) {
    for (const cause of ['settings', 'call'] as const) {
      it(`${c.name}・${cause}: 本文に「${BAD}」も「ほかの公開先の記録を読めなかった」も無い。保存場所の注意は残る`, () => {
        const body = buildTeardownConfirm(c.spec as any, factsOf(c.record, { placementsUnreadable: true, placementsUnreadableCause: cause, otherTargetsUnreadable: true })).body
        expect(body).not.toContain(BAD)
        expect(body).not.toContain(OTHERS_HEAD)
        expect(body).toContain('保存場所の設定を')
      })
    }
    it(`${c.name}・対照（保存場所は読めた）: ほかの公開先の記録だけ読めなかった本文には、今どおり「そちらのアプリのデータも消えます」がある`, () => {
      const body = buildTeardownConfirm(c.spec as any, factsOf(c.record, { otherTargetsUnreadable: true })).body
      expect(body).toContain(OTHERS_HEAD)
      expect(body).toContain('そちらのアプリのデータも消えます')
    })
  }
})
