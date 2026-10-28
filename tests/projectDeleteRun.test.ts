import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階3A（3A-4b）R: プロジェクトの削除を走らせる関数（projectDelete.ts の runProjectDelete・moveProjectToTrash・pressProjectDelete）─────────
// 設計書: docs/teardown-unify-plan.md の 10.9.4 の(4)・10.9.13 の R。偽の deps で呼び、**呼ばれた順の一覧 calls**で見る（掟10。ソースの文字列は読まない）。
//   ・止める理由があれば、破棄も移す操作も0回
//   ・移してよいかは projectDeleteVerdict（4a）。移す直前に runningOp を聞き直す。先に trash しない
//   ・押し直し（pressProjectDelete）は前回の phase で経路が決まる:
//       review・trashFailed → 移すだけ（破棄も材料の読み直しもしない）／ stopped・blocked → 材料を読み直し、残った公開先の破棄だけをやり直す
//   ・読み直したら出てこない済みの公開先は carried として結果に残し、見せてから移すか（hold）には効くが、移してよいかには効かない

import { runProjectDelete, moveProjectToTrash, pressProjectDelete, type ProjectDeletePhase } from '../src/renderer/teardown/projectDelete'
import { planProjectDeleteTeardown, type ProjectDeleteStep } from '../src/renderer/teardown/projectDeletePlan'

import { DIR, TRASH, RUNNING, done, nothing, failed, cancelled, facts, plan, kinds, harness } from './projectDeleteRunHarness'

describe('R runProjectDelete: 止める理由があれば何もしない。破棄が済んだ公開先だけで、フォルダを移す', () => {
  it('★★★ 止める理由がある（block）: teardown も runningOp も exists も trash も呼ばれない。済んだ分（carried）は結果に残る', async () => {
    const { h, deps } = harness()
    const r = await runProjectDelete(DIR, plan(['hanamii'], { reason: 'dedicated' }), true, deps)
    expect(r).toEqual({ phase: 'blocked', block: { reason: 'dedicated' }, steps: [] })
    expect(h.calls).toEqual([])
    const kept = [done('hanamii')]
    expect(await runProjectDelete(DIR, plan([], { reason: 'running', op: '公開', target: 'hanamii' }), true, deps, kept)).toEqual({ phase: 'blocked', block: { reason: 'running', op: '公開', target: 'hanamii' }, steps: kept })
    expect(h.calls).toEqual([])
  })

  it('★★★ 全部 done（警告なし）: 破棄 → 走っている操作を聞く → フォルダがあるか → ゴミ箱、の順。破棄には plan.teardown をそのまま渡す', async () => {
    const { h, deps } = harness()
    const r = await runProjectDelete(DIR, plan(['hanamii', 'sakura-apprun']), true, deps)
    expect(h.calls).toEqual(['teardown', ...TRASH])
    expect(h.teardownTargets).toEqual([['hanamii', 'sakura-apprun']])
    expect(h.trashed).toEqual([DIR])
    expect(r.phase).toBe('trashed')
    expect(kinds(r.steps)).toEqual(['hanamii:done', 'sakura-apprun:done'])
  })

  it('★★★ nothingToDo（幽霊の行）は失敗ではない。移す', async () => {
    const { h, deps } = harness({ outcome: { 'sakura-apprun': nothing('sakura-apprun') } })
    const r = await runProjectDelete(DIR, plan(['sakura-apprun']), true, deps)
    expect(r.phase).toBe('trashed')
    expect(kinds(r.steps)).toEqual(['sakura-apprun:nothingToDo'])
    expect(h.calls).toEqual(['teardown', ...TRASH])
  })

  it('★★★ やめた（cancelled）: 移さない（stopped）。ゴミ箱は呼ばれず、走っている操作も聞かない', async () => {
    const { h, deps } = harness({ outcome: { hanamii: cancelled('hanamii') } })
    const r = await runProjectDelete(DIR, plan(['hanamii', 'sakura-apprun']), true, deps)
    expect(r.phase).toBe('stopped')
    expect(h.calls).toEqual(['teardown'])
    expect(h.trashed).toEqual([])
  })

  it('★★★ 失敗（failed）: 移さない（stopped）。steps は失敗を含んで返る', async () => {
    const { h, deps } = harness({ outcome: { 'sakura-apprun': failed('sakura-apprun') } })
    const r = await runProjectDelete(DIR, plan(['hanamii', 'sakura-apprun']), true, deps)
    expect(r.phase).toBe('stopped')
    expect(kinds(r.steps)).toEqual(['hanamii:done', 'sakura-apprun:failed'])
    expect(h.calls).toEqual(['teardown'])
  })

  it('★★★ step が足りない（HANAMII の step だけで共用型の step が無い）・同じ公開先の step が2つ: 移さない（不明な形を移す側に倒さない）', async () => {
    const a = harness()
    a.deps.teardown = async () => { a.h.calls.push('teardown'); return [done('hanamii')] }
    expect((await runProjectDelete(DIR, plan(['hanamii', 'sakura-apprun']), true, a.deps)).phase).toBe('stopped')
    expect(a.h.calls).toEqual(['teardown'])
    const b = harness()
    b.deps.teardown = async () => { b.h.calls.push('teardown'); return [done('hanamii'), done('hanamii')] }
    expect((await runProjectDelete(DIR, plan(['hanamii']), true, b.deps)).phase).toBe('stopped')
    expect(b.h.calls).toEqual(['teardown'])
  })

  it('★★★ 済んだが残ったもの（done に警告）がある: 移さずに見せる（review）。ゴミ箱は呼ばれず、走っている操作も聞かない', async () => {
    const { h, deps } = harness({ outcome: { hanamii: done('hanamii', ['保存場所『x』は残しました']) } })
    const r = await runProjectDelete(DIR, plan(['hanamii', 'sakura-apprun']), true, deps)
    expect(r.phase).toBe('review')
    expect(kinds(r.steps)).toEqual(['hanamii:done', 'sakura-apprun:done'])
    expect(h.calls).toEqual(['teardown'])
  })

  it('★★★ 「公開も一緒に破棄する」を外した・破棄する公開先が無い: 破棄を呼ばずに移す', async () => {
    const off = harness()
    expect((await runProjectDelete(DIR, plan(['hanamii']), false, off.deps)).phase).toBe('trashed')
    expect(off.h.calls).toEqual(TRASH)
    const none = harness()
    const r = await runProjectDelete(DIR, plan([]), true, none.deps)
    expect(r).toEqual({ phase: 'trashed', steps: [] })
    expect(none.h.calls).toEqual(TRASH)
  })

  it('★★ チェックの値が真偽でない（不明）とき、破棄を飛ばして移さない（stopped）', async () => {
    const { h, deps } = harness()
    const r = await runProjectDelete(DIR, plan(['hanamii']), undefined as unknown as boolean, deps)
    expect(r.phase).toBe('stopped')
    expect(h.calls).toEqual([])
  })

  it('★★ 破棄の関数が投げたら、そのまま投げ直す。フォルダは移さない（握りつぶして移す側に倒さない）', async () => {
    const { h, deps } = harness()
    h.teardownThrows = true
    await expect(runProjectDelete(DIR, plan(['hanamii']), true, deps)).rejects.toThrow('破棄が投げた（テスト）')
    expect(h.calls).toEqual(['teardown'])
  })

  it('★★★ carried（前の押しで済んだ公開先）: 移してよいかには効かない。ただし警告があれば、見せてから移す（review）', async () => {
    const clean = harness()
    const r = await runProjectDelete(DIR, plan(['sakura-apprun']), true, clean.deps, [done('hanamii')])
    expect(r.phase).toBe('trashed')
    expect(kinds(r.steps)).toEqual(['hanamii:done', 'sakura-apprun:done']) // carried が先
    const warned = harness()
    const w = await runProjectDelete(DIR, plan(['sakura-apprun']), true, warned.deps, [done('hanamii', ['保存場所『x』は残しました'])])
    expect(w.phase).toBe('review')
    expect(kinds(w.steps)).toEqual(['hanamii:done', 'sakura-apprun:done'])
    expect(warned.h.calls).toEqual(['teardown'])
    const onlyCarried = harness()
    expect((await runProjectDelete(DIR, plan([]), true, onlyCarried.deps, [done('hanamii', ['残り'])])).phase).toBe('review')
    expect(onlyCarried.h.calls).toEqual([])
  })
})

describe('R moveProjectToTrash: 移す直前に、走っている操作をもう一度聞く', () => {
  it.each(['作成', '削除', '公開'] as const)('★★★ %s が走っている: 移さない（blocked）。exists も trash も呼ばれない。steps は残る', async (op) => {
    const { h, deps } = harness({ running: RUNNING(op, 'sakura-apprun') })
    const steps = [done('hanamii')]
    expect(await moveProjectToTrash(DIR, steps, deps, [])).toEqual({ phase: 'blocked', block: { reason: 'running', op, target: 'sakura-apprun' }, steps })
    expect(h.calls).toEqual(['runningOp'])
  })

  it('★★ 走っていない・聞けない（投げた）: 走っていない扱いで、移す', async () => {
    const a = harness()
    expect((await moveProjectToTrash(DIR, [], a.deps, [])).phase).toBe('trashed')
    expect(a.h.calls).toEqual(TRASH)
    const b = harness({ running: 'throws' })
    expect((await moveProjectToTrash(DIR, [], b.deps, [])).phase).toBe('trashed')
    expect(b.h.calls).toEqual(TRASH)
  })

  it('★★ もうフォルダが無い（一覧が古かった）: ゴミ箱は呼ばず、成功扱い', async () => {
    const { h, deps } = harness({ exists: false })
    expect(await moveProjectToTrash(DIR, [], deps, [])).toEqual({ phase: 'trashed', steps: [] })
    expect(h.calls).toEqual(['runningOp', 'exists'])
  })

  it('★★★ ゴミ箱が投げた・exists が投げた: trashFailed。message に元の文。steps は残る', async () => {
    const a = harness({ trashThrows: 'EPERM（テスト）' })
    const steps = [done('sakura-apprun')]
    expect(await moveProjectToTrash(DIR, steps, a.deps, [])).toEqual({ phase: 'trashFailed', steps, message: 'プロジェクトを削除できませんでした: EPERM（テスト）' })
    const b = harness()
    b.deps.exists = async () => { throw new Error('存在を確かめられない（テスト）') }
    const r = await moveProjectToTrash(DIR, steps, b.deps, [])
    expect(r).toMatchObject({ phase: 'trashFailed', message: 'プロジェクトを削除できませんでした: 存在を確かめられない（テスト）' })
    expect(b.h.trashed).toEqual([])
  })
})

describe('R pressProjectDelete: 押し直しは前回の phase で経路が決まる（行き止まりにならない）', () => {
  it('★★★ まだ押していない（run が null）: 最初から走らせる。材料は読み直さない', async () => {
    const { h, deps } = harness()
    const r = await pressProjectDelete(DIR, { plan: plan(['hanamii']), run: null, seen: facts() }, true, deps)
    expect(r.run.phase).toBe('trashed')
    expect(r.facts).toBeNull()
    expect(h.calls).toEqual(['teardown', ...TRASH])
  })

  it('★★★ review の2回目: 移すだけ（teardown も readFacts も呼ばれない）。steps はそのまま', async () => {
    const { h, deps } = harness()
    const run: ProjectDeletePhase = { phase: 'review', steps: [done('hanamii', ['残り'])] }
    const r = await pressProjectDelete(DIR, { plan: plan(['hanamii']), run, seen: facts() }, true, deps)
    expect(r).toEqual({ run: { phase: 'trashed', steps: run.steps }, facts: null })
    expect(h.calls).toEqual(TRASH)
    expect(h.trashed).toEqual([DIR])
  })

  it('★★ review の2回目に、公開などが始まっていた: 移さない（blocked）', async () => {
    const { h, deps } = harness({ running: RUNNING('公開') })
    const run: ProjectDeletePhase = { phase: 'review', steps: [done('hanamii', ['残り'])] }
    const r = await pressProjectDelete(DIR, { plan: plan(['hanamii']), run, seen: facts() }, true, deps)
    expect(r.run).toEqual({ phase: 'blocked', block: { reason: 'running', op: '公開', target: 'hanamii' }, steps: run.steps })
    expect(h.calls).toEqual(['runningOp'])
  })

  it('★★★ trashFailed の2回目: 破棄を走らせ直さず、移すだけ（teardown 0回）。移せたら trashed', async () => {
    const { h, deps } = harness()
    const run: ProjectDeletePhase = { phase: 'trashFailed', steps: [done('sakura-apprun')], message: 'プロジェクトを削除できませんでした: EPERM' }
    const r = await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run, seen: facts() }, true, deps)
    expect(r).toEqual({ run: { phase: 'trashed', steps: run.steps }, facts: null })
    expect(h.calls).toEqual(TRASH)
    const again = harness({ trashThrows: 'まだ EPERM' })
    expect((await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run, seen: facts() }, true, again.deps)).run).toMatchObject({ phase: 'trashFailed', message: 'プロジェクトを削除できませんでした: まだ EPERM' })
    expect(again.h.calls).toEqual(TRASH)
  })

  it('★★★ stopped の2回目（検分 1）: 材料を読み直し、残った共用型の破棄だけをやり直す。済んだ HANAMII は走らせ直さず、結果に残す', async () => {
    const first = harness({ outcome: { 'sakura-apprun': failed('sakura-apprun') } })
    const r1 = await pressProjectDelete(DIR, { plan: plan(['hanamii', 'sakura-apprun']), run: null, seen: facts() }, true, first.deps)
    expect(r1.run.phase).toBe('stopped')
    expect(kinds(r1.run.steps)).toEqual(['hanamii:done', 'sakura-apprun:failed'])
    // 2回目: HANAMII の破棄が済んだので、読み直した材料に HANAMII は出てこない
    const fresh = facts({ targets: ['sakura-apprun'] })
    const second = harness({ nextFacts: fresh })
    const r2 = await pressProjectDelete(DIR, { plan: plan(['hanamii', 'sakura-apprun']), run: r1.run, seen: facts() }, true, second.deps)
    expect(second.h.calls).toEqual(['readFacts', 'teardown', ...TRASH])
    expect(second.h.teardownTargets).toEqual([['sakura-apprun']]) // 古い plan の HANAMII を走らせ直さない
    expect(second.h.dirs).toEqual([DIR, DIR])
    expect(r2.run.phase).toBe('trashed')
    expect(kinds(r2.run.steps)).toEqual(['hanamii:done', 'sakura-apprun:done']) // 1回目の HANAMII の done が残る
    expect(r2.facts).toBe(fresh)
  })

  it('★★★ stopped の2回目: 済んだ HANAMII に警告があれば、共用型が済んでも見せてから移す（review）', async () => {
    const run: ProjectDeletePhase = { phase: 'stopped', steps: [done('hanamii', ['保存場所『x』は残しました']), failed('sakura-apprun')] }
    const { h, deps } = harness({ nextFacts: facts({ targets: ['sakura-apprun'] }) })
    const r = await pressProjectDelete(DIR, { plan: plan(['hanamii', 'sakura-apprun']), run, seen: facts() }, true, deps)
    expect(r.run.phase).toBe('review')
    expect(h.calls).toEqual(['readFacts', 'teardown'])
    expect(kinds(r.run.steps)).toEqual(['hanamii:done', 'sakura-apprun:done'])
  })

  it('★★★ stopped の2回目に、読み直した材料にまだ HANAMII がある: やり直す（走らせる）。同じ公開先の step を2つ残さない', async () => {
    const run: ProjectDeletePhase = { phase: 'stopped', steps: [done('hanamii'), failed('sakura-apprun')] }
    const { h, deps } = harness({ nextFacts: facts({ targets: ['hanamii', 'sakura-apprun'] }) })
    const r = await pressProjectDelete(DIR, { plan: plan(['hanamii', 'sakura-apprun']), run, seen: facts() }, true, deps)
    expect(h.teardownTargets).toEqual([['hanamii', 'sakura-apprun']])
    expect(kinds(r.run.steps)).toEqual(['hanamii:done', 'sakura-apprun:done'])
    expect(r.run.phase).toBe('trashed')
  })

  it('★★ stopped の2回目に失敗した公開先は carried に入らない（また失敗なら stopped のまま。新しい失敗だけが残る）', async () => {
    const run: ProjectDeletePhase = { phase: 'stopped', steps: [failed('sakura-apprun')] }
    const { h, deps } = harness({ nextFacts: facts({ targets: ['sakura-apprun'] }), outcome: { 'sakura-apprun': failed('sakura-apprun') } })
    const r = await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run, seen: facts() }, true, deps)
    expect(r.run).toEqual({ phase: 'stopped', steps: [failed('sakura-apprun')] })
    expect(h.calls).toEqual(['readFacts', 'teardown', 'readFacts']) // また stopped になったので、材料をもう一度読み直して返す
  })

  it('★★★ stopped の2回目に、読み直した材料が止める理由を持つ・公開が走っている: blocked。teardown も trash も呼ばれない。済んだ分は残る', async () => {
    const run: ProjectDeletePhase = { phase: 'stopped', steps: [done('hanamii'), failed('sakura-apprun')] }
    const dedicated = harness({ nextFacts: facts({ targets: ['sakura-apprun-dedicated'] }) })
    const a = await pressProjectDelete(DIR, { plan: plan(['hanamii', 'sakura-apprun']), run, seen: facts() }, true, dedicated.deps)
    expect(a.run).toEqual({ phase: 'blocked', block: { reason: 'dedicated' }, steps: [done('hanamii')] })
    expect(dedicated.h.calls).toEqual(['readFacts'])
    const running = harness({ nextFacts: facts({ targets: ['sakura-apprun'], running: RUNNING('公開') }) })
    const b = await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run, seen: facts() }, true, running.deps)
    expect(b.run).toMatchObject({ phase: 'blocked', block: { reason: 'running', op: '公開', target: 'hanamii' } })
    expect(running.h.calls).toEqual(['readFacts'])
  })

  it('★★★ blocked（移す直前に走っていた）の次の押し: 材料を読み直す。破棄が済んでいれば（材料に公開先が無い）、破棄せず移す。済んだ分は残る', async () => {
    const first = harness({ running: RUNNING('削除', 'sakura-apprun') })
    const r1 = await pressProjectDelete(DIR, { plan: plan(['hanamii', 'sakura-apprun']), run: null, seen: facts() }, true, first.deps)
    expect(r1.run).toMatchObject({ phase: 'blocked', block: { reason: 'running', op: '削除', target: 'sakura-apprun' } })
    expect(first.h.calls).toEqual(['teardown', 'runningOp'])
    const second = harness({ nextFacts: facts() }) // 破棄が済み、材料に公開先は出てこない
    const r2 = await pressProjectDelete(DIR, { plan: plan(['hanamii', 'sakura-apprun']), run: r1.run, seen: facts() }, true, second.deps)
    expect(second.h.calls).toEqual(['readFacts', ...TRASH]) // 破棄は走らない
    expect(r2.run.phase).toBe('trashed')
    expect(kinds(r2.run.steps)).toEqual(['hanamii:done', 'sakura-apprun:done'])
    // まだ走っているなら、また blocked（破棄も移す操作も0回）
    const still = harness({ nextFacts: facts({ running: RUNNING('削除', 'sakura-apprun') }) })
    const r3 = await pressProjectDelete(DIR, { plan: plan([]), run: r1.run, seen: facts() }, true, still.deps)
    expect(r3.run).toMatchObject({ phase: 'blocked', block: { reason: 'running', op: '削除', target: 'sakura-apprun' } })
    expect(still.h.calls).toEqual(['readFacts'])
  })

  it('★★ 押し直しのときのチェックの値が使われる: 外したなら、残った公開先の破棄をせずに移す', async () => {
    const run: ProjectDeletePhase = { phase: 'stopped', steps: [failed('sakura-apprun')] }
    const { h, deps } = harness({ nextFacts: facts({ targets: ['sakura-apprun'] }) })
    const r = await pressProjectDelete(DIR, { plan: plan(['sakura-apprun']), run, seen: facts() }, false, deps)
    expect(r.run.phase).toBe('trashed')
    expect(h.calls).toEqual(['readFacts', ...TRASH])
  })

  it('★★ trashed・知らない phase: 何もしない（材料も読まず、何も呼ばない）', async () => {
    const { h, deps } = harness()
    const trashed: ProjectDeletePhase = { phase: 'trashed', steps: [] }
    expect(await pressProjectDelete(DIR, { plan: plan([]), run: trashed, seen: facts() }, true, deps)).toEqual({ run: trashed, facts: null })
    const odd = { phase: '知らない', steps: [] } as unknown as ProjectDeletePhase
    expect((await pressProjectDelete(DIR, { plan: plan([]), run: odd, seen: facts() }, true, deps)).run).toBe(odd)
    expect(h.calls).toEqual([])
  })

  it('★★ 材料の running が止める理由として効く（planProjectDeleteTeardown を通す）: 公開が走っていれば、最初の押しでも何も呼ばれない', async () => {
    const { h, deps } = harness()
    const p = planProjectDeleteTeardown(facts({ targets: ['hanamii'], running: RUNNING('公開') }))
    const r = await pressProjectDelete(DIR, { plan: p, run: null, seen: facts() }, true, deps)
    expect(r.run).toEqual({ phase: 'blocked', block: { reason: 'running', op: '公開', target: 'hanamii' }, steps: [] })
    expect(h.calls).toEqual([])
  })
})

describe('R 配線: 走らせる関数は React・window を持たず、1つの経路だけを持つ', () => {
  const ROOT = path.join(__dirname, '..')
  const rel = 'src/renderer/teardown/projectDelete.ts'
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

  it('★★ projectDelete.ts は400行以下。公開の記録の読み口・window・React を持たない（口は deps で渡す）', () => {
    expect(raw.split('\n').length).toBeLessThanOrEqual(400)
    for (const w of ['publishRecord', 'window.', 'electronAPI', "from 'react'", 'useState', 'projectMeta']) expect(code, w).not.toContain(w)
  })

  it('★★★ 材料を読み直す・フォルダを移す・破棄を走らせるのは、それぞれ1か所（経路は pressProjectDelete の1つ）', () => {
    // 材料を読み直すのは2か所だけ: stopped・blocked・twinsGone の押し直しの枝と、stopped・twinsGone になった直後（withFreshFactsIfStopped）
    expect(code.match(/deps\.readFacts\(/g)).toHaveLength(2)
    expect(code.match(/deps\.trash\(/g)).toHaveLength(1)
    expect(code.match(/deps\.teardown\(/g)).toHaveLength(1)
    expect(code.match(/deps\.runningOp\(/g)).toHaveLength(1)
    // 押し直しの読み直しは stopped・blocked の枝の中だけ
    const at = code.indexOf('deps.readFacts(', code.indexOf('export async function pressProjectDelete'))
    expect(code.lastIndexOf("case 'stopped':", at)).toBeGreaterThan(code.lastIndexOf("case 'review':", at))
    expect(code.slice(code.lastIndexOf("case 'stopped':", at), at)).toContain("case 'blocked'")
    // 直後の読み直しは、stopped・twinsGone のときだけ（それ以外の phase では読まない）
    const helper = code.slice(code.indexOf('async function withFreshFactsIfStopped'), code.indexOf('export async function pressProjectDelete'))
    expect(helper).toContain("if (next.phase !== 'stopped' && next.phase !== 'twinsGone') return { run: next, facts: current }")
    expect(helper.indexOf("next.phase !== 'stopped'")).toBeLessThan(helper.indexOf('deps.readFacts('))
  })
})
