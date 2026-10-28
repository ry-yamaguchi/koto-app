import { describe, it, expect } from 'vitest'

// ── 段階3A の検分: 押し直しの経路（pressProjectDelete）の2つの約束 ─────────────────────────────────────────────
//   1. 破棄が済まなかった直後（stopped）は、材料を読み直して返す。済んだ公開先の記録は main が外すので、開いたときの材料のままだと、
//      画面の赤い箱とチェックが、済んだ破棄を「これから消す」と言い続ける（それ以外の phase では読み直さない）
//   2. stopped・blocked の押し直しで読み直した材料に、利用者がまだ見ていない注意（記録が読めなくなった・共用型の残りが出てきた）が増えていたら、
//      破棄も移すこともせずに、新しい材料だけを返す（画面が赤い箱を描き直し、見てからもう一度押させる）。見せたあとの押し（seen）では増えていない
// 偽の deps は tests/projectDeleteRunHarness.ts（呼ばれた順 calls で見る）。流れの場合分けは tests/projectDeleteRun.test.ts。

import { pressProjectDelete, type ProjectDeletePhase } from '../src/renderer/teardown/projectDelete'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import { TRASH, RUNNING, done, failed, facts, plan, kinds, harness } from './projectDeleteRunHarness'

const DIR = '/work/myapp'

describe('R pressProjectDelete: 破棄が済まなかった直後は材料を読み直して返す（検分: 済んだ破棄を「これから消す」と言わない）', () => {
  it('★★★ 1回目で stopped になった直後に、材料を読み直して返す。破棄のあとなので teardown → readFacts の順', async () => {
    const fresh = facts({ targets: ['sakura-apprun'] }) // 済んだ HANAMII の記録は main が外した
    const { h, deps } = harness({ outcome: { 'sakura-apprun': failed('sakura-apprun') }, nextFacts: fresh })
    const r = await pressProjectDelete(DIR, { plan: plan(['hanamii', 'sakura-apprun']), run: null, seen: facts({ targets: ['hanamii', 'sakura-apprun'] }) }, true, deps)
    expect(r.run.phase).toBe('stopped')
    expect(kinds(r.run.steps)).toEqual(['hanamii:done', 'sakura-apprun:failed'])
    expect(h.calls).toEqual(['teardown', 'readFacts'])
    expect(r.facts).toBe(fresh)
  })

  it('★★ stopped 以外（trashed・review・trashFailed・blocked）の直後は読み直さない（facts は null）', async () => {
    const trashed = harness()
    expect((await pressProjectDelete(DIR, { plan: plan(['hanamii']), run: null, seen: facts() }, true, trashed.deps)).facts).toBeNull()
    expect(trashed.h.calls).toEqual(['teardown', ...TRASH])
    const review = harness({ outcome: { hanamii: done('hanamii', ['残り']) } })
    const r = await pressProjectDelete(DIR, { plan: plan(['hanamii']), run: null, seen: facts() }, true, review.deps)
    expect(r).toMatchObject({ run: { phase: 'review' }, facts: null })
    expect(review.h.calls).toEqual(['teardown'])
    const failedTrash = harness({ trashThrows: 'EPERM' })
    expect(await pressProjectDelete(DIR, { plan: plan(['hanamii']), run: null, seen: facts() }, true, failedTrash.deps)).toMatchObject({ run: { phase: 'trashFailed' }, facts: null })
    expect(failedTrash.h.calls).toEqual(['teardown', ...TRASH])
    const blocked = harness({ running: RUNNING('公開') })
    expect(await pressProjectDelete(DIR, { plan: plan(['hanamii']), run: null, seen: facts() }, true, blocked.deps)).toMatchObject({ run: { phase: 'blocked' }, facts: null })
    expect(blocked.h.calls).toEqual(['teardown', 'runningOp'])
  })

  it('★★ 直後の読み直しが投げても、結果（steps）は失わない（facts は null＝画面は前の材料のまま）', async () => {
    const { h, deps } = harness({ outcome: { hanamii: failed('hanamii') } })
    deps.readFacts = async () => { h.calls.push('readFacts'); throw new Error('読めない（テスト）') }
    const r = await pressProjectDelete(DIR, { plan: plan(['hanamii']), run: null, seen: facts() }, true, deps)
    expect(r).toEqual({ run: { phase: 'stopped', steps: [failed('hanamii')] }, facts: null })
    expect(h.calls).toEqual(['teardown', 'readFacts'])
  })
})

describe('R pressProjectDelete: 押し直しで増えた注意は、移す前に見せる（検分: 読めない記録・共用型の残りを見せないまま移さない）', () => {
  const stopped: ProjectDeletePhase = { phase: 'stopped', steps: [failed('sakura-apprun')] }
  const SEEN = facts({ targets: ['sakura-apprun'] })
  const PL = { bucket: 'koto-a', prefix: 'projects/x/', shared: true }

  it('★★★ 読み直したら公開の記録が読めなくなっていた（公開先が空）: 破棄も移すこともしない。run はそのまま、新しい材料を返す（前回失敗した公開先を黙って飛ばして移さない）', async () => {
    const fresh = facts({ unreadable: true })
    const { h, deps } = harness({ nextFacts: fresh })
    const r = await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run: stopped, seen: SEEN }, true, deps)
    expect(r.run).toBe(stopped)
    expect(r.facts).toBe(fresh)
    expect(h.calls).toEqual(['readFacts'])
    expect(h.trashed).toEqual([])
  })

  it('★★★ 見せたあとの押し（seen が、見せた材料）は先へ進む。破棄する公開先が無いので移す（行き止まりにならない）', async () => {
    const fresh = facts({ unreadable: true })
    const { h, deps } = harness({ nextFacts: fresh })
    const r = await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(fresh), run: stopped, seen: fresh }, true, deps)
    expect(h.calls).toEqual(['readFacts', ...TRASH])
    expect(r.run.phase).toBe('trashed')
  })

  const LEFT = { appNames: [], registryName: 'reg', registryOrigin: 'owned' as const, registryUsers: [], placements: [PL] }

  it('★★★ チェックを外している回: 共用型の残り（レジストリ・保存場所）だけが新しく出てきた回も、移さずに見せる。移すのは見せたあと（0.6.24 A-6）', async () => {
    const fresh = facts({ sharedLeftover: LEFT })
    const first = harness({ nextFacts: fresh })
    const r = await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run: stopped, seen: SEEN }, false, first.deps)
    expect(r).toEqual({ run: stopped, facts: fresh })
    expect(first.h.calls).toEqual(['readFacts'])
    const second = harness({ nextFacts: fresh })
    expect((await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(fresh), run: stopped, seen: fresh }, false, second.deps)).run.phase).toBe('trashed')
    expect(second.h.calls).toEqual(['readFacts', ...TRASH])
  })

  it('★★★ チェックがオンの回は、共用型の残りが増えても止めない。残りも破棄の段に入り、続く確認が名指しする（0.6.24 A-6）。アプリが残っていた回も同じ', async () => {
    for (const fresh of [facts({ sharedLeftover: LEFT }), facts({ sharedLeftover: { ...LEFT, appNames: ['myapp-app'], placements: [] } })]) {
      const { h, deps } = harness({ nextFacts: fresh })
      const r = await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run: stopped, seen: SEEN }, true, deps)
      expect(h.teardownTargets, '残りの段（sakura-apprun）を破棄する').toEqual([['sakura-apprun']])
      expect(h.calls).toEqual(['readFacts', 'teardown', ...TRASH])
      expect(r.run.phase).toBe('trashed')
    }
  })

  it('★★ blocked のあとの押し直しでも、増えた注意は先に見せる', async () => {
    const blocked: ProjectDeletePhase = { phase: 'blocked', block: { reason: 'running', op: '公開', target: 'hanamii' }, steps: [done('hanamii')] }
    const fresh = facts({ unreadable: true })
    const { h, deps } = harness({ nextFacts: fresh })
    const r = await pressProjectDelete(DIR, { plan: plan([]), run: blocked, seen: facts() }, true, deps)
    expect(r).toEqual({ run: blocked, facts: fresh })
    expect(h.calls).toEqual(['readFacts'])
  })

  it('★★★ 見せた材料と同じ注意（読めない記録を、すでに見せていた）は止めない。読めた分の公開先は、いつもどおり破棄する', async () => {
    const fresh = facts({ targets: ['sakura-apprun'], unreadable: true })
    const { h, deps } = harness({ nextFacts: fresh })
    const r = await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run: stopped, seen: facts({ targets: ['sakura-apprun'], unreadable: true }) }, true, deps)
    expect(h.calls).toEqual(['readFacts', 'teardown', ...TRASH])
    expect(r.run.phase).toBe('trashed')
  })

  it('★★ 増えたのが公開先だけなら止めない（破棄の確認が、消すものを名指しで見せる）', async () => {
    const fresh = facts({ targets: ['hanamii', 'sakura-apprun'] })
    const { h, deps } = harness({ nextFacts: fresh })
    const r = await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run: stopped, seen: SEEN }, true, deps)
    expect(h.teardownTargets).toEqual([['hanamii', 'sakura-apprun']])
    expect(r.run.phase).toBe('trashed')
  })
})
