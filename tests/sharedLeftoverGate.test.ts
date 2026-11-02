import { describe, it, expect } from 'vitest'
import { sharedLeftoverGateOf } from '../src/renderer/teardown/sharedLeftoverGate'
import { sharedLeftoverGateOf as viaPlan } from '../src/renderer/teardown/projectDeletePlan'

// ── 残りの段の門（sharedLeftoverGateOf）: 同じ押しで HANAMII が済ませた保存場所だけが残りなら走らせない ─────────────────
// 純関数。記録（読み直した共用型の記録）と、同じ押しで済んだ保存場所の組（handled）で決まる。走らせない（null）のは、全部の条件が読めて満たされたときだけ。
// 形が読めない値・欠けた値は、走らせる側（残りの呼び名を返す）に倒す。偽の HANAMII・本物の main を通す試験は tests/sharedLeftoverHandled.test.ts。

const PREFIX = 'projects/myapp/'
const A = { bucket: 'koto-data-a', prefix: PREFIX, shared: true }
const A2 = { bucket: 'koto-data-a', prefix: 'projects/other/', shared: true }
const B = { bucket: 'koto-data-b', prefix: PREFIX, shared: true }
const HANDLED_A = [{ bucket: 'koto-data-a', prefix: PREFIX }]

const left = (over: Record<string, unknown> = {}) => ({ appNames: [] as string[], registryName: null as string | null, registryUsers: [] as string[], placements: [A], ...over }) as any
/** 全部の条件が満たされた options（鍵なし・設定から外した保存場所なし・A を済ませた）。 */
const skipOpts = (over: Record<string, unknown> = {}) => ({ handled: HANDLED_A, keyRecorded: false, stateOnlyBuckets: [] as string[], ...over }) as any

describe('門: options を渡さない呼び方は、記録だけで決まる（今までの門のまま）', () => {
  it('保存場所がある → 保存場所。アプリがある → null（公開の回）。数えるレジストリだけ → コンテナレジストリ', () => {
    expect(sharedLeftoverGateOf(left())).toEqual({ noun: '保存場所' })
    expect(sharedLeftoverGateOf(left({ appNames: ['myapp'] }))).toEqual({ noun: null })
    expect(sharedLeftoverGateOf(left({ placements: [], registryName: 'myreg' }))).toEqual({ noun: 'コンテナレジストリ' })
    expect(sharedLeftoverGateOf(left({ placements: [A], registryName: 'myreg' }))).toEqual({ noun: '保存場所・コンテナレジストリ' })
  })

  it('何も残っていない・借り手のいるレジストリだけ・形が読めない値 → null（段を足さない）', () => {
    expect(sharedLeftoverGateOf(left({ placements: [] }))).toBeNull()
    expect(sharedLeftoverGateOf(left({ placements: [], registryName: 'myreg', registryUsers: ['sibling'] }))).toBeNull()
    expect(sharedLeftoverGateOf(left({ appNames: 'x' }))).toBeNull()
    expect(sharedLeftoverGateOf(left({ placements: undefined }))).toBeNull()
  })

  it('projectDeletePlan から再エクスポートした同じ関数（門は1つ）', () => {
    expect(viaPlan).toBe(sharedLeftoverGateOf)
  })
})

describe('門: 同じ押しで HANAMII が済ませた保存場所だけが残り → 走らせない（null）', () => {
  it('★★★ 全部の条件が満たされる: 保存場所 A だけが残りで、A は HANAMII が済ませた → null', () => {
    expect(sharedLeftoverGateOf(left(), skipOpts())).toBeNull()
  })

  it('★★★ 済ませた組に、残りに無い組が混ざっていても、残りの全部が覆われていれば null', () => {
    expect(sharedLeftoverGateOf(left(), skipOpts({ handled: [...HANDLED_A, { bucket: 'koto-data-z', prefix: '' }] }))).toBeNull()
  })

  it('★★★ 残りに、済ませていない保存場所がある → 走らせる（残りの呼び名は今までどおり）', () => {
    expect(sharedLeftoverGateOf(left({ placements: [A, B] }), skipOpts())).toEqual({ noun: '保存場所' })
  })

  it('★★★ 同じバケットの別の prefix が残る → 走らせる（名前だけで比べない）', () => {
    expect(sharedLeftoverGateOf(left({ placements: [A, A2] }), skipOpts())).toEqual({ noun: '保存場所' })
    expect(sharedLeftoverGateOf(left({ placements: [A2] }), skipOpts())).toEqual({ noun: '保存場所' })
  })

  it('★★★ 空の prefix は、空の prefix の組とだけ一致する', () => {
    expect(sharedLeftoverGateOf(left({ placements: [{ bucket: 'koto-data-a', prefix: '', shared: true }] }), skipOpts())).toEqual({ noun: '保存場所' })
    expect(sharedLeftoverGateOf(left({ placements: [{ bucket: 'koto-data-a', prefix: '', shared: true }] }), skipOpts({ handled: [{ bucket: 'koto-data-a', prefix: '' }] }))).toBeNull()
  })
})

describe('門: 条件が1つでも欠ければ走らせる（不明値は走らせる側）', () => {
  it.each([
    ['handled を渡さない', { handled: undefined }],
    ['handled が空（保存場所の設定を読めなかった回）', { handled: [] }],
    ['handled が配列でない', { handled: 'x' }],
    ['keyRecorded が true（記録の鍵が残っている）', { keyRecorded: true }],
    ['keyRecorded が欠けた', { keyRecorded: undefined }],
    ["keyRecorded が文字列 'false'", { keyRecorded: 'false' }],
    ['keyRecorded が数値 0', { keyRecorded: 0 }],
    ['keyRecorded が null', { keyRecorded: null }],
    ['設定から外した保存場所がある', { stateOnlyBuckets: ['koto-data-a'] }],
    ['stateOnlyBuckets が欠けた', { stateOnlyBuckets: undefined }],
    ['stateOnlyBuckets が配列でない', { stateOnlyBuckets: 'none' }],
  ])('★★★ %s → 走らせる', (_n, over) => {
    expect(sharedLeftoverGateOf(left(), skipOpts(over))).toEqual({ noun: '保存場所' })
  })

  it('★★★ アプリが残る → 走らせる（呼び名は null＝公開の言い方）', () => {
    expect(sharedLeftoverGateOf(left({ appNames: ['myapp'] }), skipOpts())).toEqual({ noun: null })
  })

  it('★★★ 数えるレジストリが残る → 走らせる（保存場所は済んでいても、レジストリの仕事がある）', () => {
    expect(sharedLeftoverGateOf(left({ registryName: 'myreg' }), skipOpts())).toEqual({ noun: '保存場所・コンテナレジストリ' })
    expect(sharedLeftoverGateOf(left({ placements: [], registryName: 'myreg' }), skipOpts())).toEqual({ noun: 'コンテナレジストリ' })
  })

  it('借り手のいるレジストリは数えない: 保存場所を HANAMII が済ませ、ほかに仕事が無ければ走らせない', () => {
    expect(sharedLeftoverGateOf(left({ registryName: 'myreg', registryUsers: ['sibling'] }), skipOpts())).toBeNull()
  })

  it('残りの保存場所の要素が壊れた形（null）でも投げず、走らせる側に倒す', () => {
    expect(sharedLeftoverGateOf(left({ placements: [null] }), skipOpts())).toEqual({ noun: '保存場所' })
  })
})
