import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階2（2b-2）: 一覧の共用型（さくらのAppRun）の行（TeardownRow）の、残った回・開き直し・ほかの公開先・何もしなかった回 ───────────────────────────
// 設計書: docs/teardown-unify-plan.md の 10.7.12 の E（S3）と、10.7.16 末尾の親の判断 8（M1 の広がり）。前半は tests/sharedTeardownRow.test.ts（押す → 確認 → 破棄 → 結果）。
//   ・保存場所だけ残った回 → 行が残り、押し直しの確認は保存場所だけを言う。全部片づけば行も消える
//   ・閉じて開き直したとき: 記録から結果を1回だけ出す／走っている破棄は「破棄しています…」で押せない
//   ・★ 親の判断 8: HANAMII など、同じ保存場所を使うほかの公開先があるプロジェクトの共用型の行を押すと、確認に P2 の段落が出る（共用型が幽霊の行でも）
//   ・消すものが記録に無い（nothingToDo）／記録が読めない／キー未登録 → 確認も要求も出さない
// 本物の仕様書（sharedTeardownSpec）・本物の流れ・本物の main・偽の client／保存場所。窓・記録・行の取り付けは tests/sharedTeardownRowHarness.ts。

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) } | undefined>,
  queue: [] as Array<{ idx: number; fn: () => void | (() => void); deps?: readonly unknown[] }>,
  i: 0, r: 0, e: 0,
  rerender: () => {},
}))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const idx = rt.i++
      if (!(idx in rt.slots)) rt.slots[idx] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[idx]) : v
        if (Object.is(next, rt.slots[idx])) return
        rt.slots[idx] = next
        rt.rerender()
      }
      return [rt.slots[idx], set]
    },
    useRef: (init: unknown) => {
      const idx = rt.r++
      if (!rt.refs[idx]) rt.refs[idx] = { current: init }
      return rt.refs[idx]
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const idx = rt.e++
      const prev = rt.effects[idx]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]))
      if (changed) rt.queue.push({ idx, fn, deps })
    },
  }
})

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { A, APP, bucketRef, h, stateKinds } from './sharedTeardownHarness'
import { createSharedRowHarness, tick, until, holdGate, type RowRt } from './sharedTeardownRowHarness'
import { getOps } from '../src/main/projectOps'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import { registryUnknownNotice } from '../src/shared/cloudCost'

const H = createSharedRowHarness(rt as RowRt)
beforeEach(() => H.setup())
afterEach(H.cleanup)

const DELETE_APP = 'deleteApp app-1'
const LIST_A = `listAllKeys ${A}`
const ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' }
const paragraphs = (body: string) => body.split('\n\n')

// ═══════════════════════════════════════════════════════════════════════════════
// 保存場所だけ残った回 → 押し直し
// ═══════════════════════════════════════════════════════════════════════════════

describe('保存場所だけ残った回 → 押し直し', () => {
  it('★★★ 保存場所の一覧に失敗して残った回は、アプリは消え、行（公開の記録）は残る。押し直しの確認は保存場所だけを言い、片づけば行が消える', async () => {
    h.fail[LIST_A] = 'throw'
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '1回目の結果が届かない')
    await tick()

    // 1回目: アプリは消えて、保存場所だけ残った。
    const first = m.outcomes[0].outcome.view
    expect(first.state).toBe('failed')
    expect(first.ok).toBe(false)
    expect(first.appDeleted).toBe(true)
    expect(first.remaining.some(l => l.kind === 'storage' && l.label.includes(A))).toBe(true)
    expect(H.publishedTargets()).toEqual(['sakura-apprun']) // 行が残る（D1=1。行から押し直せる）
    expect(stateKinds(H.dir)).not.toContain('apprun-app') // 消したアプリが記録に残らない
    expect(H.win.publishMetaCalls).toEqual([])

    // 2回目: 押し直す。確認は、アプリを挙げず、残った保存場所だけを言う。
    delete h.fail[LIST_A]; h.calls = []
    const props = await H.pressAndWaitConfirm(m)
    expect(paragraphs(props.body)[1]).toBe(`次を破棄します: 保存場所『${A}』にある、このプロジェクトのデータ`)
    expect(props.body).not.toContain('🔗') // アプリが無いので、URL の話はしない
    expect(props.body).not.toContain(registryUnknownNotice()) // 押し直しの回に、ありもしない月額の話をしない
    expect(props.body).not.toContain('月額220円')
    expect(props.choices).toEqual([])
    props.onConfirm()
    await until(() => m.outcomes.length === 2, '2回目の結果が届かない')
    await tick()

    expect(m.outcomes[1].outcome.view.state).toBe('done')
    expect(h.calls).toContain(`deleteBucket ${A}`)
    expect(h.calls.some(c => c.startsWith('deleteApp'))).toBe(false)
    expect(H.publishedTargets()).toEqual([]) // 全部片づいたので行が消えた（消したのは main）
    m.unmount()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 閉じて開き直す
// ═══════════════════════════════════════════════════════════════════════════════

describe('E-5 閉じて開き直したとき: 記録から結果を出す', () => {
  it('★★★ 画面を閉じている間に終わった破棄: 開き直すと、記録から結果と知らせが1回だけ行の onOutcome に届く。見た記録は、もう一度開き直しても出ない', async () => {
    H.writeProject({ meta: { registryName: 'myreg' } })
    // 画面が無い状態で破棄が走って終わる（main は最後まで進める）。警告の無い回（レジストリも消した）。
    const direct = await H.mainTeardown({ confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    expect(direct.ok).toBe(true)
    expect(getOps(H.dir).last?.seen).toBe(false)

    const m = H.mountRow()
    await tick()
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].entry).toBe(m.entry)
    expect(m.outcomes[0].outcome.view.state).toBe('done')
    expect(m.outcomes[0].outcome.notes).toHaveLength(1)
    expect(m.outcomes[0].outcome.notes[0].headline).toMatch(/^🔔 破棄の結果(（.+）)?$/) // T162: 「です」と句点が無い
    expect(m.finished).toEqual([1])
    await tick()
    expect(H.win.acks.map(a => a[0]), '画面に出したのに「見た」と伝えていない').toEqual([H.dir])
    m.unmount()

    // 見た記録は、開き直しても二度と出ない。
    const again = H.mountRow()
    await tick()
    expect(again.outcomes).toEqual([])
    again.unmount()
  })

  it('★★ 警告つきの記録（レジストリを残した＝月額が続く）は、見たことにならない。開き直すたびに出る（見逃すより、二度見えるほうを選ぶ）', async () => {
    H.writeProject({ meta: { registryName: 'myreg' } })
    const direct = await H.mainTeardown({ confirmed: true, deleteRegistry: false, registryName: 'myreg' })
    expect(direct.ok).toBe(true)
    for (const round of [1, 2]) {
      const m = H.mountRow()
      await tick()
      expect(m.outcomes, `${round}回目の開き直し`).toHaveLength(1)
      expect(m.outcomes[0].outcome.view.warnings.join('\n')).toContain('myreg')
      expect(getOps(H.dir).last?.seen).toBe(false)
      m.unmount()
    }
  })

  it('★★ 画面を閉じている間に終わった破棄（保存場所が残った回）: 開き直すと「残っている」旨が結果と知らせに出る', async () => {
    h.fail[LIST_A] = 'throw'
    const direct = await H.mainTeardown({ confirmed: true, deleteRegistry: false, registryName: null })
    expect(direct.ok).toBe(false)

    const m = H.mountRow()
    await tick()
    expect(m.outcomes).toHaveLength(1)
    const view = m.outcomes[0].outcome.view
    expect(view.state).toBe('failed')
    expect(view.remaining.some(l => l.kind === 'storage' && l.label.includes(A))).toBe(true)
    m.unmount()
  })

  it('★★ 画面を閉じている間に走っている破棄: 開き直した行は「破棄しています…」で押せない。押しても確認も要求も出ない', async () => {
    const g = holdGate()
    let entered = false
    h.hold = { entered: () => { entered = true }, gate: g.p }
    const first = H.mountRow()
    await H.pressAndConfirm(first)
    await until(() => entered, '破棄が走り出さない')
    first.unmount() // 画面を閉じる。破棄は main が最後まで進める。

    const reopened = H.mountRow()
    await until(() => reopened.parts.busy === true, '記録から「走っている」を読み戻せない')
    expect(reopened.parts.button.props.disabled).toBe(true)
    reopened.parts.button.props.onClick()
    await tick()
    expect(reopened.confirm.props.open).toBe(false)
    expect(h.calls.filter(c => c.startsWith('deleteApp '))).toEqual([DELETE_APP])
    reopened.unmount()
    g.open()
    await until(() => getOps(H.dir).running === null, '破棄が終わらない')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 親の判断 8: ほかの公開先が同じ保存場所を使うとき、確認に P2 の段落が出る
// ═══════════════════════════════════════════════════════════════════════════════

describe('P2: 同じ保存場所を使うほかの公開先があるプロジェクトの共用型の行（M1 の広がり・親の判断 8）', () => {
  const P2_ONE = '⚠️ この保存場所は 🌸 HANAMII でも使っているため、そちらで公開中のアプリのデータも消えます'

  it('★★★ HANAMII が公開中で、共用型は幽霊の行（アプリが記録に無く、保存場所だけ env.json にある）: 確認が保存場所を言い、P2 の段落で HANAMII のデータも消えることを言う', async () => {
    H.writeProject({
      env: [A], resources: [],
      publish: { hanamii: { projectId: 'hnm-1', name: 'myapp' }, targets: { 'sakura-apprun': ROW, hanamii: ROW } },
    })
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(paragraphs(props.body)[1]).toBe(`次を破棄します: 保存場所『${A}』にある、このプロジェクトのデータ`)
    expect(props.body).toContain(P2_ONE)
    props.onCancel()
    await tick()
    expect(h.calls).toEqual([]) // やめれば何も出ない
    m.unmount()
  })

  it('★★★ アプリがあるふつうの共用型の行でも、HANAMII が同じ保存場所を使っていれば P2 の段落が出る。押すと保存場所は消える（確認が言ったとおり）', async () => {
    H.writeProject({
      env: [A], resources: [APP, bucketRef(A)],
      publish: { hanamii: { projectId: 'hnm-1', name: 'myapp' }, targets: { 'sakura-apprun': ROW, hanamii: ROW } },
    })
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.body).toContain(P2_ONE)
    props.onConfirm()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(h.calls).toContain(`deleteBucket ${A}`)
    m.unmount()
  })

  it('★★ 公開先の行（publish.targets）が無い旧い HANAMII の記録（hanamii.projectId だけ）も、名前で言う', async () => {
    H.writeProject({ env: [A], resources: [APP], publish: { hanamii: { projectId: 'hnm-old' }, targets: { 'sakura-apprun': ROW } } })
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.body).toContain(P2_ONE)
    props.onCancel()
    await tick()
    m.unmount()
  })

  it('★★ 保存場所を使わない公開先（レンタルサーバ）は挙げない。Vercel は挙げる。2つ以上ならまとめて言う', async () => {
    H.writeProject({ env: [A], resources: [APP], publish: { targets: { 'sakura-apprun': ROW, 'sakura-rental': ROW, vercel: ROW } } })
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.body).toContain('▲ Vercel でも使っているため')
    expect(props.body).not.toContain('レンタルサーバ')
    props.onCancel()
    await tick()
    m.unmount()

    H.writeProject({ env: [A], resources: [APP], publish: { hanamii: { projectId: 'hnm-1' }, targets: { 'sakura-apprun': ROW, hanamii: ROW, vercel: ROW } } })
    const both = H.mountRow()
    const bothProps = await H.pressAndWaitConfirm(both)
    expect(bothProps.body).toContain('🌸 HANAMII・▲ Vercel でも使っているため')
    bothProps.onCancel()
    await tick()
    both.unmount()
  })

  it('★★ 消す保存場所が無い（アプリだけ）なら、ほかの公開先がいても P2 の段落は出ない（消えるデータが無い）', async () => {
    H.writeProject({
      env: [], resources: [APP],
      publish: { hanamii: { projectId: 'hnm-1' }, targets: { 'sakura-apprun': ROW, hanamii: ROW } },
    })
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.body).not.toContain('でも使っているため')
    props.onCancel()
    await tick()
    m.unmount()
  })

  it('★★ ほかの公開先が無ければ、P2 の段落は出ない', async () => {
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.body).not.toContain('でも使っているため')
    props.onCancel()
    await tick()
    m.unmount()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 何もしなかった・読めない・キー未登録
// ═══════════════════════════════════════════════════════════════════════════════

describe('消すものが無い／記録が読めない／キー未登録', () => {
  it('★★★ 消すものが記録に無い（幽霊の行）: 確認は開かず、要求0件、窓を閉じる警告も立たない。結果は nothingToDo の印つきで、行（公開の記録）はそのまま', async () => {
    H.writeProject({ env: [], resources: [] })
    const m = H.mountRow()
    m.parts.button.props.onClick()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(m.confirm.props.open).toBe(false)
    expect(h.calls).toEqual([])
    expect(H.win.busy).toEqual([])
    expect(m.busy).not.toContain(true)
    const out = m.outcomes[0].outcome
    expect(out.nothingToDo).toBe(true)
    expect(out.view.message).toBe(sharedTeardownSpec.words.nothingToDo)
    expect(out.notes).toEqual([])
    expect(H.publishedTargets()).toEqual(['sakura-apprun'])
    expect(H.win.publishMetaCalls).toEqual([])
    m.unmount()
  })

  it('★★ 記録（env.json）が壊れていて読めない: 確認は開かず、要求0件。読めなかった旨の失敗が結果になる（nothingToDo ではない）', async () => {
    fs.writeFileSync(path.join(H.dir, '.sakura-cloud', 'env.json'), '{ 壊れた JSON', 'utf-8')
    const m = H.mountRow()
    m.parts.button.props.onClick()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(m.confirm.props.open).toBe(false)
    expect(h.calls).toEqual([])
    expect(m.outcomes[0].outcome.view.ok).toBe(false)
    expect(m.outcomes[0].outcome.view.message).toMatch(/^破棄するものの記録を読めませんでした: /)
    expect('nothingToDo' in m.outcomes[0].outcome).toBe(false)
    expect(H.win.busy).toEqual([])
    m.unmount()
  })

  it('★★ キーが未登録: 確認のあと main が断る。さくらのクラウドへ要求0件。入口の案内でなく main の断りが結果になり、窓の警告は外れ、行はそのまま', async () => {
    h.creds = null
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(h.calls).toEqual([])
    expect(m.outcomes[0].outcome.view.ok).toBe(false)
    expect(m.outcomes[0].outcome.view.message).toContain('APIキー未登録')
    expect(H.win.busy[H.win.busy.length - 1][0]).toBe(false)
    expect(H.publishedTargets()).toEqual(['sakura-apprun'])
    expect(stateKinds(H.dir)).toContain('apprun-app')
    m.unmount()
  })
})
