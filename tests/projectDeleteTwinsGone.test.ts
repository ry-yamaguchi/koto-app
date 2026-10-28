import { describe, it, expect } from 'vitest'

// ── 0.6.24 R2-e（画面の流れ）: main の「覆う複製が見つからなくなった」という断りが返ったら、材料を読み直して plan を作り直す ─────────────────────
// 開いたときの複製の判断は、最初の押下まで使い回される。開いたあとに複製を消すと、plan は「破棄しない」のまま。main は移す直前に、外した公開先（skippedForTwins）の覆う複製を読み直して断る。
// 画面（pressProjectDelete）は:
//   ・plan が外した公開先（plan.twinned）を、そのまま main へ渡す（moveProjectToTrash の skippedForTwins。移す口の4つの入り口すべて）
//   ・断り（TwinsGoneError）は trashFailed でなく twinsGone。直後に材料を読み直して返す（走っている操作の聞き直しと同じ形。画面が赤い箱を描き直す）
//   ・押し直すと、読み直した材料で plan を作り直し、破棄から始める（複製が消えた公開先は、今度は plan.teardown に入る）。行き止まりにならない
// 偽の deps の呼ばれた順・渡された skippedForTwins で見る（掟10）。判断（plan・verdict）は本物。main 側の振る舞いは tests/trashSkippedForTwins.test.ts。
// 変異: 外した公開先を渡さない（空にする）／TwinsGoneError を trashFailed にする／twinsGone の直後に読み直さない／twinsGone の押し直しを読み直さずに前の plan で走らせる。
import { runProjectDelete, moveProjectToTrash, pressProjectDelete, skippedForTwinsOf, TwinsGoneError } from '../src/renderer/teardown/projectDelete'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import { DIR, TRASH, TWINS_GONE_MESSAGE, done, failed, facts, plan, kinds, harness } from './projectDeleteRunHarness'

const NONE = { hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] }
/** 複製がいる材料（開いたとき）。HANAMII の複製『copy』。 */
const withTwin = () => facts({ targets: ['hanamii'], twins: { ...NONE, hanamii: ['copy'] } })
/** 複製が消えたあとの材料（読み直したもの）。 */
const noTwin = () => facts({ targets: ['hanamii'], twins: NONE })

describe('★★★ skippedForTwinsOf: plan が覆う複製のために破棄を外した公開先（plan.twinned の公開先の並び）', () => {
  it('twinned の公開先をそのまま。無ければ空', () => {
    expect(skippedForTwinsOf(plan([]))).toEqual([])
    expect(skippedForTwinsOf(plan([], null, [{ target: 'hanamii', folders: ['a'] }, { target: 'sakura-apprun-dedicated', folders: ['b'] }]))).toEqual(['hanamii', 'sakura-apprun-dedicated'])
    expect(skippedForTwinsOf(planProjectDeleteTeardown(withTwin()))).toEqual(['hanamii'])
    expect(skippedForTwinsOf(planProjectDeleteTeardown(noTwin()))).toEqual([])
  })
})

describe('★★★ 移す口へ、外した公開先を渡す（runProjectDelete・押し直しの review／trashFailed の枝）', () => {
  it('★★★ 外した公開先がある plan: 破棄は呼ばれず、trash には plan.twinned の公開先が渡る', async () => {
    const p = planProjectDeleteTeardown(withTwin())
    const { h, deps } = harness()
    const r = await runProjectDelete(DIR, p, true, deps)
    expect(r.phase).toBe('trashed')
    expect(h.calls).toEqual(TRASH)
    expect(h.skipped, '外した公開先を main へ渡していない（main が移す直前に読み直せない）').toEqual([['hanamii']])
  })

  it('★★★ 外した公開先が無い plan（通常）: 空の配列を渡す（必須）。チェックを外して破棄しない回も、plan の外した公開先を渡す', async () => {
    const { h, deps } = harness()
    await runProjectDelete(DIR, planProjectDeleteTeardown(noTwin()), true, deps)
    expect(h.skipped).toEqual([[]])
    const b = harness()
    await runProjectDelete(DIR, planProjectDeleteTeardown(withTwin()), false, b.deps)
    expect(b.h.skipped).toEqual([['hanamii']])
  })

  it('★★★ moveProjectToTrash は渡された公開先をそのまま trash へ。走っている操作があれば trash は呼ばれない', async () => {
    const { h, deps } = harness()
    await moveProjectToTrash(DIR, [], deps, ['hanamii', 'sakura-apprun-dedicated'])
    expect(h.skipped).toEqual([['hanamii', 'sakura-apprun-dedicated']])
  })

  it('★★★ review・trashFailed からの押し直し（移すだけ）も、prev.plan の外した公開先を渡す', async () => {
    const p = planProjectDeleteTeardown(withTwin())
    for (const phase of ['review', 'trashFailed'] as const) {
      const { h, deps } = harness()
      const prev = { plan: p, run: phase === 'review' ? { phase, steps: [] } : { phase, steps: [], message: 'x' }, seen: withTwin() }
      const r = await pressProjectDelete(DIR, prev, true, deps)
      expect(r.run.phase, phase).toBe('trashed')
      expect(h.skipped, phase).toEqual([['hanamii']])
      expect(h.calls, phase).toEqual(TRASH)
    }
  })

  it('★★★ stopped・blocked・twinsGone からの押し直し: 読み直した材料の plan の外した公開先を渡す（前の plan ではない）', async () => {
    const stale = planProjectDeleteTeardown(withTwin()) // 前の plan: hanamii を外していた
    for (const phase of ['stopped', 'blocked', 'twinsGone'] as const) {
      const run = phase === 'blocked' ? { phase, block: { reason: 'dedicated' as const }, steps: [] } : phase === 'twinsGone' ? { phase, steps: [], message: TWINS_GONE_MESSAGE } : { phase, steps: [] }
      const { h, deps } = harness({ nextFacts: noTwin() })
      const r = await pressProjectDelete(DIR, { plan: stale, run, seen: withTwin() }, true, deps)
      expect(h.calls.slice(0, 2), phase).toEqual(['readFacts', 'teardown'])
      expect(h.teardownTargets, `${phase}: 複製が消えた公開先は、今度は破棄に入る`).toEqual([['hanamii']])
      expect(h.skipped, phase).toEqual([[]])
      expect(r.run.phase, phase).toBe('trashed')
    }
  })
})

describe('★★★ main の断り（覆う複製が見つからなくなった）: twinsGone。直後に材料を読み直して返す。ほかの失敗は trashFailed のまま', () => {
  it('★★★ moveProjectToTrash: TwinsGoneError → twinsGone（main の文そのまま）。steps は失わない。trashFailed にしない', async () => {
    const { deps } = harness({ trashTwinsGone: 1 })
    const steps = [done('sakura-apprun')]
    expect(await moveProjectToTrash(DIR, steps, deps, ['hanamii'])).toEqual({ phase: 'twinsGone', steps, message: TWINS_GONE_MESSAGE })
  })

  it('対照: ふつうの失敗は trashFailed（文の頭は今のまま）。TwinsGoneError は Error の一種だが、クラスで見分ける', async () => {
    const { deps } = harness({ trashThrows: 'EPERM（テスト）' })
    expect(await moveProjectToTrash(DIR, [], deps, [])).toEqual({ phase: 'trashFailed', steps: [], message: 'プロジェクトを削除できませんでした: EPERM（テスト）' })
    expect(new TwinsGoneError('x')).toBeInstanceOf(Error)
  })

  it('★★★ 最初の押下（run が null）で断られる: twinsGone と、読み直した材料（facts）を返す。破棄は呼ばれない。フォルダは移っていない', async () => {
    const { h, deps } = harness({ trashTwinsGone: 1, nextFacts: noTwin() })
    const r = await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(withTwin()), run: null, seen: withTwin() }, true, deps)
    expect(r.run).toEqual({ phase: 'twinsGone', steps: [], message: TWINS_GONE_MESSAGE })
    expect(r.facts, '材料を読み直して返す（画面が赤い箱を描き直す）').toEqual(noTwin())
    expect(h.calls).toEqual([...TRASH, 'readFacts'])
    expect(h.trashed, 'フォルダを移した').toEqual([])
    expect(h.teardownTargets).toEqual([])
  })

  it('★★★ 読み直しに失敗しても、断りの結果（twinsGone）は失わない（facts は渡さない）', async () => {
    const { h, deps } = harness({ trashTwinsGone: 1 })
    deps.readFacts = async () => { h.calls.push('readFacts'); throw new Error('読めない（テスト）') }
    const r = await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(withTwin()), run: null, seen: withTwin() }, true, deps)
    expect(r.run.phase).toBe('twinsGone')
    expect(r.facts).toBeNull()
  })

  it('★★★ 断られたあと、もう一度押すと、読み直した材料で plan を作り直し、破棄から始める → 済んだら移す。行き止まりにならない', async () => {
    const { h, deps } = harness({ trashTwinsGone: 1, nextFacts: noTwin() })
    const first = await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(withTwin()), run: null, seen: withTwin() }, true, deps)
    expect(first.run.phase).toBe('twinsGone')
    h.calls.length = 0
    // 画面は読み直した材料（first.facts）を seen にして、plan を作り直して、もう一度押す
    const again = await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(first.facts!), run: first.run, seen: first.facts! }, true, deps)
    expect(h.teardownTargets, '複製が消えたので、今度は HANAMII を破棄する').toEqual([['hanamii']])
    expect(h.calls).toEqual(['readFacts', 'teardown', ...TRASH])
    expect(again.run.phase).toBe('trashed')
    expect(h.trashed).toEqual([DIR])
    expect(h.skipped).toEqual([['hanamii'], []]) // 1回目は外した公開先つき。2回目（作り直した plan）は空
  })

  it('★★★ 断られたあと、破棄が失敗すれば stopped（移さない）。済んだ公開先は carried で結果に残る', async () => {
    const stale = planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun'], twins: { ...NONE, hanamii: ['copy'] } }))
    const { h, deps } = harness({ trashTwinsGone: 1, nextFacts: facts({ targets: ['hanamii', 'sakura-apprun'], twins: NONE }), outcome: { hanamii: failed('hanamii') } })
    const first = await pressProjectDelete(DIR, { plan: stale, run: null, seen: facts({ targets: ['hanamii', 'sakura-apprun'] }) }, true, deps)
    expect(first.run.phase).toBe('twinsGone')
    expect(kinds(first.run.steps)).toEqual(['sakura-apprun:done']) // 共用型は破棄できた。HANAMII は複製のために外していた
    const again = await pressProjectDelete(DIR, { plan: stale, run: first.run, seen: first.facts! }, true, deps)
    expect(again.run.phase).toBe('stopped')
    expect(h.trashed).toEqual([])
  })

  it('★★ review・trashFailed からの押し直しで断られても twinsGone。直後に材料を読み直す', async () => {
    const { h, deps } = harness({ trashTwinsGone: 1, nextFacts: noTwin() })
    const prev = { plan: planProjectDeleteTeardown(withTwin()), run: { phase: 'review' as const, steps: [done('sakura-apprun')] }, seen: withTwin() }
    const r = await pressProjectDelete(DIR, prev, true, deps)
    expect(r.run).toEqual({ phase: 'twinsGone', steps: [done('sakura-apprun')], message: TWINS_GONE_MESSAGE })
    expect(r.facts).toEqual(noTwin())
    expect(h.calls).toEqual([...TRASH, 'readFacts'])
  })

  it('★★ 対照: ふつうの失敗（trashFailed）は材料を読み直さない（facts は null のまま・readFacts は呼ばれない）', async () => {
    const { h, deps } = harness({ trashThrows: 'EPERM（テスト）', nextFacts: noTwin() })
    const r = await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(noTwin()), run: null, seen: noTwin() }, true, deps)
    expect(r.run.phase).toBe('trashFailed')
    expect(r.facts).toBeNull()
    expect(h.calls).not.toContain('readFacts')
  })
})
