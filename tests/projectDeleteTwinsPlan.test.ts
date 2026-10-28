import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── T-I6（0.6.24 I-3・作者の決定 K1）: プロジェクトの削除の判断（純関数）が、複製のある公開先を破棄から外す ────────────────────────────
// 複製（同じ親フォルダの別のフォルダで、同じ公開の記録を持つもの）は、元と同じ公開の記録を指す。複製のフォルダを移しても、記録は元の側に残るので、月額は元から止められる。
// 一方、複製から公開を破棄すると、元が公開している動いているアプリが消える。なのでプロジェクトの削除は、複製のある公開先を**破棄せずに、フォルダだけ移す**。
//   ・planProjectDeleteTeardown: 複製のある公開先は teardown から外れ twinned に入る。専有型の複製があれば止めを外す（H4 の行き止まりが解ける）
//   ・**複製を読めなかった回（facts.twins が null）は、何も外さない**。外すと、複製があるかも分からないまま破棄せずに移してしまう（外さなければ、main が断り、step が failed になって移らない）
//   ・projectDeleteBlockOf の必須の引数 dedicatedTwinned は、`true` のときだけ止めを外す。'running'（走っている操作）は、複製があっても止める
//   ・流れ（runProjectDelete・pressProjectDelete）: 複製のある公開先だけなら、破棄の要求は 0 回で、フォルダを移す
// 材料の読み方は tests/projectDeleteTwinsFacts.test.ts、画面は tests/projectDeleteTwinsDialog.test.ts、main の口は tests/recordTwinsHandler.test.ts。

import {
  planProjectDeleteTeardown, projectDeleteBlockOf, projectDeleteVerdict, type ProjectDeleteFacts,
} from '../src/renderer/teardown/projectDeletePlan'
import { splitByTwins, twinFoldersOf, twinnedNote, TWIN_TARGETS, type RecordTwinsFacts } from '../src/renderer/teardown/projectDeleteTwins'
import { runProjectDelete, pressProjectDelete } from '../src/renderer/teardown/projectDelete'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { TRASH, RUNNING, done, failed, facts as baseFacts, kinds, harness } from './projectDeleteRunHarness'

const NONE: RecordTwinsFacts = { hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] }
const twins = (over: Partial<RecordTwinsFacts> = {}): RecordTwinsFacts => ({ ...NONE, ...over })
const facts = (over: Partial<ProjectDeleteFacts> = {}): ProjectDeleteFacts => baseFacts({ twins: NONE, ...over })

describe('twinFoldersOf・splitByTwins: 複製のフォルダ名の読み方と、分け方', () => {
  it('★★★ 読めた公開先の名前をそのまま返す。null・undefined・知らない公開先・形の違う値は、空（外さない側）', () => {
    expect(twinFoldersOf(twins({ hanamii: ['a copy', 'b copy'] }), 'hanamii')).toEqual(['a copy', 'b copy'])
    expect(twinFoldersOf(null, 'hanamii')).toEqual([])
    expect(twinFoldersOf(undefined, 'hanamii')).toEqual([])
    expect(twinFoldersOf(twins({ hanamii: ['a'] }), 'vercel')).toEqual([])
    expect(twinFoldersOf(twins({ hanamii: ['a'] }), 'constructor' as any)).toEqual([])
    expect(twinFoldersOf({ hanamii: 'a copy' } as any, 'hanamii')).toEqual([])
    expect(twinFoldersOf({ hanamii: [1, '', null, 'ok'] } as any, 'hanamii')).toEqual(['ok'])
  })

  it('★★★ 並びを保って、複製のないもの（teardown）とあるもの（twinned）に分ける', () => {
    expect(splitByTwins(['hanamii', 'sakura-apprun'], twins({ hanamii: ['c'] }))).toEqual({
      teardown: ['sakura-apprun'], twinned: [{ target: 'hanamii', folders: ['c'] }],
    })
    expect(splitByTwins(['hanamii', 'sakura-apprun'], twins({ hanamii: ['c'], 'sakura-apprun': ['d', 'e'] }))).toEqual({
      teardown: [], twinned: [{ target: 'hanamii', folders: ['c'] }, { target: 'sakura-apprun', folders: ['d', 'e'] }],
    })
    expect(splitByTwins(['hanamii', 'sakura-apprun'], NONE)).toEqual({ teardown: ['hanamii', 'sakura-apprun'], twinned: [] })
    expect(splitByTwins(['hanamii', 'sakura-apprun'], null)).toEqual({ teardown: ['hanamii', 'sakura-apprun'], twinned: [] })
    expect(splitByTwins([], twins({ hanamii: ['c'] }))).toEqual({ teardown: [], twinned: [] })
  })

  it('複製を数える公開先は、書き下した3つ', () => {
    expect([...TWIN_TARGETS]).toEqual(['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'])
  })
})

describe('★★★ planProjectDeleteTeardown: 複製のある公開先は破棄から外れ、twinned に入る', () => {
  it('★★★ HANAMII だけ複製がある: teardown は共用型だけ。twinned は HANAMII と複製のフォルダ名。止めない', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun'], twins: twins({ hanamii: ['rc24-h'] }) }))
    expect(plan).toEqual({ block: null, teardown: ['sakura-apprun'], twinned: [{ target: 'hanamii', folders: ['rc24-h'] }] })
  })

  it('★★★ 共用型だけ複製がある: teardown は HANAMII だけ', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun'], twins: twins({ 'sakura-apprun': ['x'] }) }))
    expect(plan).toEqual({ block: null, teardown: ['hanamii'], twinned: [{ target: 'sakura-apprun', folders: ['x'] }] })
  })

  it('★★★ 両方に複製がある: teardown は空（破棄せずにフォルダだけ移す）。twinned は HANAMII → 共用型の順（targets の並びに依らない）', () => {
    for (const targets of [['hanamii', 'sakura-apprun'], ['sakura-apprun', 'hanamii']] as const) {
      const plan = planProjectDeleteTeardown(facts({ targets: [...targets], twins: twins({ hanamii: ['c'], 'sakura-apprun': ['c'] }) }))
      expect(plan.teardown, targets.join()).toEqual([])
      expect(plan.twinned.map(t => t.target), targets.join()).toEqual(['hanamii', 'sakura-apprun'])
      expect(plan.block).toBeNull()
    }
  })

  it('複製のフォルダが複数あれば、その全部を持つ', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['hanamii'], twins: twins({ hanamii: ['a copy', 'b copy'] }) }))
    expect(plan.twinned).toEqual([{ target: 'hanamii', folders: ['a copy', 'b copy'] }])
  })

  it('複製が無ければ、従来どおり（teardown は全部・twinned は空）', () => {
    expect(planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun'] }))).toEqual({ block: null, teardown: ['hanamii', 'sakura-apprun'], twinned: [] })
  })

  it('★★★ 公開先の行が無い公開先の複製は、言うことが無い（twinned に入れない）', () => {
    expect(planProjectDeleteTeardown(facts({ targets: [], twins: twins({ hanamii: ['c'], 'sakura-apprun': ['c'] }) }))).toEqual({ block: null, teardown: [], twinned: [] })
    expect(planProjectDeleteTeardown(facts({ targets: ['vercel'], twins: twins({ hanamii: ['c'] }) }))).toEqual({ block: null, teardown: [], twinned: [] })
  })

  it('★★★ 複製を読めなかった（twins が null）・facts に twins が無い・形が違う: 何も外さない（teardown は全部。twinned は空）', () => {
    const targets = ['hanamii', 'sakura-apprun'] as const
    for (const bad of [null, undefined, { hanamii: 'x' }, { hanamii: [], 'sakura-apprun': 5 }, []] as unknown[]) {
      const plan = planProjectDeleteTeardown(facts({ targets: [...targets], twins: bad as any }))
      expect(plan, JSON.stringify(bad)).toEqual({ block: null, teardown: ['hanamii', 'sakura-apprun'], twinned: [] })
    }
  })
})

describe('★★★ 専有型: 複製があれば止めを外す。複製を読めなかった回・複製が無い回は止める', () => {
  const ID = { clusterID: 'c-1' }

  it('★★★ 専有型の ID が残っていても、複製があれば止めない。twinned に専有型が入る（破棄はしない）', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['sakura-apprun-dedicated'], dedicated: ID, twins: twins({ 'sakura-apprun-dedicated': ['rc24-d'] }) }))
    expect(plan).toEqual({ block: null, teardown: [], twinned: [{ target: 'sakura-apprun-dedicated', folders: ['rc24-d'] }] })
  })

  it('★★★ 複製が無ければ、従来どおり止める（twinned も空）', () => {
    expect(planProjectDeleteTeardown(facts({ targets: ['sakura-apprun-dedicated'], dedicated: ID }))).toEqual({ block: { reason: 'dedicated' }, teardown: [], twinned: [] })
  })

  it('★★★ 複製を読めなかった回（twins が null）は、止めを外さない（H4 を「複製なし」と読んで外すと、記録の無い専有型のフォルダを移してしまう）', () => {
    for (const bad of [null, undefined] as const) {
      expect(planProjectDeleteTeardown(facts({ targets: ['sakura-apprun-dedicated'], dedicated: ID, twins: bad as any }))).toEqual({ block: { reason: 'dedicated' }, teardown: [], twinned: [] })
    }
  })

  it('保存場所だけが残った専有型も、複製があれば止めを外す', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: [], dedicated: { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a'] }, twins: twins({ 'sakura-apprun-dedicated': ['rc24-d'] }) }))
    expect(plan.block).toBeNull()
    expect(plan.twinned).toEqual([{ target: 'sakura-apprun-dedicated', folders: ['rc24-d'] }])
  })

  it('専有型の行だけがあり記録が空（幽霊の行）でも、複製があれば止めを外す。行も残りも無ければ、言うことが無い（twinned に入れない）', () => {
    expect(planProjectDeleteTeardown(facts({ targets: ['sakura-apprun-dedicated'], dedicated: {}, twins: twins({ 'sakura-apprun-dedicated': ['c'] }) }))).toMatchObject({ block: null, twinned: [{ target: 'sakura-apprun-dedicated' }] })
    expect(planProjectDeleteTeardown(facts({ targets: ['hanamii'], dedicated: null, twins: twins({ 'sakura-apprun-dedicated': ['c'] }) })).twinned).toEqual([])
  })

  it('★★★ 走っている操作は、専有型の複製があっても止める（running が最優先）。複製の行は言う', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['sakura-apprun-dedicated'], dedicated: ID, running: RUNNING('削除', 'sakura-apprun-dedicated'), twins: twins({ 'sakura-apprun-dedicated': ['c'] }) }))
    expect(plan.block).toEqual({ reason: 'running', op: '削除', target: 'sakura-apprun-dedicated' })
    expect(plan.twinned).toEqual([{ target: 'sakura-apprun-dedicated', folders: ['c'] }])
  })

  it('HANAMII の複製があっても、専有型の止めは外れない（外すのは専有型の複製だけ）', () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun-dedicated'], dedicated: ID, twins: twins({ hanamii: ['c'] }) }))
    expect(plan.block).toEqual({ reason: 'dedicated' })
    expect(plan.twinned.map(t => t.target)).toEqual(['hanamii'])
  })
})

describe('★★★ projectDeleteBlockOf の dedicatedTwinned（必須の引数）', () => {
  it('★★★ true のときだけ専有型の止めを外す（dedicated・dedicated-storage-leftover・幽霊の行のどれも）', () => {
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { clusterID: 'c-1' }, true)).toBeNull()
    expect(projectDeleteBlockOf([], { storageLeftoverBucket: 'koto-data' }, true)).toBeNull()
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], {}, true)).toBeNull()
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { clusterID: 'c-1' }, false)).toEqual({ reason: 'dedicated' })
    expect(projectDeleteBlockOf([], { storageLeftoverBucket: 'koto-data' }, false)).toEqual({ reason: 'dedicated-storage-leftover', buckets: ['koto-data'] })
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], {}, false)).toEqual({ reason: 'dedicated' })
  })

  it('★★★ true でないもの（渡し忘れ・文字列・1・オブジェクト）は外さない。false と同じ', () => {
    for (const bad of [undefined, null, 'true', 1, {}, []] as unknown[]) {
      expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { clusterID: 'c-1' }, bad as boolean), JSON.stringify(bad)).toEqual({ reason: 'dedicated' })
    }
  })

  it('★★★ running は複製があっても止める（順序: running を先に見る）', () => {
    expect(projectDeleteBlockOf(['sakura-apprun-dedicated'], { clusterID: 'c-1' }, true, { op: '削除', target: 'sakura-apprun-dedicated' })).toEqual({ reason: 'running', op: '削除', target: 'sakura-apprun-dedicated' })
    expect(projectDeleteBlockOf([], null, true, { op: '公開', target: 'hanamii' })).toEqual({ reason: 'running', op: '公開', target: 'hanamii' })
  })

  it('専有型でないものは、どちらの値でも止めない', () => {
    expect(projectDeleteBlockOf(['hanamii', 'sakura-apprun'], null, true)).toBeNull()
    expect(projectDeleteBlockOf(['hanamii', 'sakura-apprun'], null, false)).toBeNull()
  })
})

describe('twinnedNote: 赤い箱の1行', () => {
  it('★★★ 「{公開先}は破棄しません（フォルダ『C』にも同じ公開の記録があります）。」。複数なら『A』・『B』', () => {
    expect(twinnedNote({ target: 'hanamii', folders: ['rc24-h'] })).toBe(`${PUBLISH_TARGET_LABEL.hanamii}は破棄しません（フォルダ『rc24-h』にも同じ公開の記録があります）。`)
    expect(twinnedNote({ target: 'sakura-apprun', folders: ['a copy', 'b copy'] })).toBe(`${PUBLISH_TARGET_LABEL['sakura-apprun']}は破棄しません（フォルダ『a copy』・『b copy』にも同じ公開の記録があります）。`)
    expect(twinnedNote({ target: 'sakura-apprun-dedicated', folders: ['x'] })).toBe('📦 さくらのAppRun（専有型）は破棄しません（フォルダ『x』にも同じ公開の記録があります）。')
  })

  it('「破棄しません」と、複製のフォルダの名前を必ず言う（言わなければ、なぜ公開が残るのか分からない）', () => {
    const note = twinnedNote({ target: 'hanamii', folders: ['rc24-h'] })
    expect(note).toContain('破棄しません')
    expect(note).toContain('『rc24-h』')
    expect(note.split('（').length - 1, '括弧は1文に1つ（掟5）').toBe(1)
  })
})

describe('★★★ 流れ: 複製のある公開先は破棄の要求を出さずに、フォルダだけ移す', () => {
  const DIR = '/work/myapp'

  it('★★★ 公開先がすべて複製あり: 破棄 0 回・走っている操作を聞いてからゴミ箱へ 1 回（チェックがオンのままでも）', async () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun'], twins: twins({ hanamii: ['c'], 'sakura-apprun': ['c'] }) }))
    expect(projectDeleteVerdict(plan, true, [])).toEqual({ moveToTrash: true, hold: false })
    const { h, deps } = harness()
    const phase = await runProjectDelete(DIR, plan, true, deps)
    expect(phase.phase).toBe('trashed')
    expect(h.calls).toEqual(TRASH) // teardown は呼ばれない
    expect(h.teardownTargets).toEqual([])
    expect(h.trashed).toEqual([DIR])
  })

  it('★★★ 一部だけ複製あり: 複製のない公開先だけを破棄する（teardown には外れたものが入らない）', async () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['hanamii', 'sakura-apprun'], twins: twins({ hanamii: ['c'] }) }))
    const { h, deps } = harness()
    expect((await runProjectDelete(DIR, plan, true, deps)).phase).toBe('trashed')
    expect(h.teardownTargets).toEqual([['sakura-apprun']])
    expect(h.calls).toEqual(['teardown', ...TRASH])
  })

  it('★★★ 専有型の複製がある回: 止まらずに、フォルダを移す（H4 の行き止まりが解ける）。複製が無い回は、何も呼ばずに止まる', async () => {
    const withTwin = planProjectDeleteTeardown(facts({ targets: ['sakura-apprun-dedicated'], dedicated: { clusterID: 'c-1' }, twins: twins({ 'sakura-apprun-dedicated': ['c'] }) }))
    const a = harness()
    expect((await runProjectDelete(DIR, withTwin, true, a.deps)).phase).toBe('trashed')
    expect(a.h.calls).toEqual(TRASH)
    const without = planProjectDeleteTeardown(facts({ targets: ['sakura-apprun-dedicated'], dedicated: { clusterID: 'c-1' } }))
    const b = harness()
    expect((await runProjectDelete(DIR, without, true, b.deps)).phase).toBe('blocked')
    expect(b.h.calls).toEqual([])
  })

  it('★★★ 複製を読めなかった回（twins が null）: 破棄に残す。main が断って failed になれば、フォルダは移さない（安全側）', async () => {
    const plan = planProjectDeleteTeardown(facts({ targets: ['hanamii'], twins: null }))
    const { h, deps } = harness({ outcome: { hanamii: failed('hanamii') } })
    const phase = await runProjectDelete(DIR, plan, true, deps)
    expect(phase.phase).toBe('stopped')
    expect(h.teardownTargets).toEqual([['hanamii']])
    expect(h.calls).toEqual(['teardown'])
    expect(h.trashed).toEqual([])
  })

  it('★★★ 開いたあとに複製ができた回（画面は複製を知らなかった）: 1回目は main が断って止まり、読み直した材料で複製が見える。2回目は破棄せずにフォルダだけ移す', async () => {
    const before = facts({ targets: ['hanamii'], twins: NONE })
    const after = facts({ targets: ['hanamii'], twins: twins({ hanamii: ['rc24-h copy'] }) })
    const { h, deps } = harness({ outcome: { hanamii: failed('hanamii') }, nextFacts: after })
    const first = await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(before), run: null, seen: before }, true, deps)
    expect(first.run.phase).toBe('stopped')
    expect(kinds(first.run.steps)).toEqual(['hanamii:failed'])
    expect(first.facts).toBe(after) // 画面が箱を描き直す（複製の行が出る）
    expect(planProjectDeleteTeardown(first.facts!).twinned).toEqual([{ target: 'hanamii', folders: ['rc24-h copy'] }])
    expect(h.trashed).toEqual([])
    h.calls.length = 0; h.teardownTargets.length = 0
    const second = await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(before), run: first.run, seen: first.facts! }, true, deps)
    expect(second.run.phase).toBe('trashed')
    expect(h.teardownTargets, '破棄の要求は出ない').toEqual([])
    expect(h.calls).toEqual(['readFacts', ...TRASH])
    expect(h.trashed).toEqual([DIR])
  })

  it('済んだ公開先（done）の記録が外れ、残りが複製ありに変わった押し直し: 済んだ分は見せたまま、残りは破棄せずに移す', async () => {
    const seen = facts({ targets: ['hanamii', 'sakura-apprun'] })
    const fresh = facts({ targets: ['sakura-apprun'], twins: twins({ 'sakura-apprun': ['c'] }) })
    const stopped = { phase: 'stopped' as const, steps: [done('hanamii'), failed('sakura-apprun')] }
    const { h, deps } = harness({ nextFacts: fresh })
    const r = await pressProjectDelete(DIR, { plan: planProjectDeleteTeardown(seen), run: stopped, seen }, true, deps)
    expect(r.run.phase).toBe('trashed')
    expect(kinds(r.run.steps)).toEqual(['hanamii:done'])
    expect(h.teardownTargets).toEqual([])
  })
})

describe('配線: 複製の扱いは projectDeleteTwins.ts の1か所。plan・facts・ダイアログがそこを通る', () => {
  const ROOT = path.join(__dirname, '..')
  const code = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

  it('★★ projectDeletePlan.ts は 400 行以下（0.6.24 A で 300 から 400 に。文は projectDeleteWords.ts へ出した）。複製の部品は projectDeleteTwins.ts に置き、window・react・IPC に触らない', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src/renderer/teardown/projectDeletePlan.ts'), 'utf-8').split('\n').length).toBeLessThanOrEqual(400)
    const twinsSrc = code('src/renderer/teardown/projectDeleteTwins.ts')
    expect(twinsSrc).not.toMatch(/\bwindow\b/)
    expect(twinsSrc).not.toContain('electronAPI')
    expect(twinsSrc).not.toMatch(/from 'react'/)
  })

  it('★★ planProjectDeleteTeardown は splitByTwins で分け、projectDeleteBlockOf に dedicatedTwinned を渡す。呼び手は plan の1つだけ', () => {
    const plan = code('src/renderer/teardown/projectDeletePlan.ts')
    expect(plan).toContain('const { teardown, twinned } = splitByTwins([...ordered, ...rest], facts.twins)')
    expect(plan).toContain('projectDeleteBlockOf(facts.targets, facts.dedicated, dedicatedTwinned, facts.running)')
    for (const rel of ['src/renderer/components/ProjectDeleteDialog.tsx', 'src/renderer/teardown/projectDelete.ts', 'src/renderer/teardown/projectDeleteFacts.ts', 'src/renderer/components/Sidebar.tsx']) {
      expect(code(rel), rel).not.toContain('projectDeleteBlockOf(')
    }
  })
})
