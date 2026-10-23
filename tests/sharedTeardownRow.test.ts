import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'

// ── 段階2（2b-2）: 一覧の共用型（さくらのAppRun）の行（TeardownRow）を、本物の流れ・本物の main・偽の client/偽の保存場所に通す（押す → 確認 → 破棄 → 結果）─────
// 設計書: docs/teardown-unify-plan.md の 10.7.12 の E（S3）。続きは tests/sharedTeardownRowStates.test.ts（残った回・開き直し・P2・何もしなかった回）。
// 一覧が行に渡す props の配線は tests/publishedListSharedRow.test.ts。
//
// 共通の部品の E（tests/teardownHookCommon.test.ts・teardownHookChoices.test.ts）は偽の仕様書で書いてある。ここは**本物の仕様書（sharedTeardownSpec）**で:
//   ・行（TeardownRow）→ フック → 流れ（runTeardownFlow）→ 仕様書の readRecord/loadAuth/invoke → 本物の main の cloud:teardownRecord／cloud:teardown → 偽の client・保存場所
//   ・画面は公開の記録を一度も消さない（publishMeta の口が0回）。消すのは main の1か所
//   ・出る要求を1本の並び（h.calls）で見る（ソースの文字列は読まない・掟10）
// React は DOM 環境を入れていないので、react の useState／useRef／useCallback／useEffect だけを試験用の小さな実装に差し替える（tests/hanamiiTeardownRow.test.ts と同じやり方）。
// 窓・記録・行の取り付けは tests/sharedTeardownRowHarness.ts。

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
import { createSharedRowHarness, tick, until, holdGate, CLOSE_WARNING_CALL, type RowRt } from './sharedTeardownRowHarness'
import { withProjectLock } from '../src/main/projectLock'
import { getOps } from '../src/main/projectOps'
import { adoptedRegistryNote, registryDeleteLabel, registryUnknownNotice, unknownOriginRegistryNote, urlChangesOnTeardownNotice } from '../src/shared/cloudCost'

const H = createSharedRowHarness(rt as RowRt)
beforeEach(() => H.setup())
afterEach(H.cleanup)

/** 全部入りの形: アプリ・保存場所 A・Koto が作ったレジストリ myreg（印は false）。`adopted` は借りたもの、`unmarked` は印が無いもの（作ったか分からない）。 */
const withRegistry = (over: { adopted?: boolean; unmarked?: boolean } = {}) =>
  H.writeProject({ meta: { registryName: 'myreg', ...(over.unmarked ? {} : { registryAdopted: over.adopted === true }) } })
const DELETE_APP = 'deleteApp app-1'
const DELETE_REGISTRY = 'deleteContainerRegistry reg-1'
const STORAGE_A = ['connect', `listAllKeys ${A}`, `deleteKeys ${A}`, `deleteBucket ${A}`]

// ═══════════════════════════════════════════════════════════════════════════════
// 押す → 確認
// ═══════════════════════════════════════════════════════════════════════════════

describe('E 行 → 流れ → 本物の main: 確認', () => {
  it('★★★ E-1 やめる: さくらのクラウドへも保存場所へも要求0件。結果も出ず、窓を閉じる警告も立たず、処理の記録も増えず、公開の記録はそのまま', async () => {
    withRegistry()
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.title).toBe('さくらのAppRun の公開を破棄します')
    expect(props.confirmLabel).toBe('破棄する')
    props.onCancel()
    await tick()
    expect(h.calls).toEqual([])
    expect(m.outcomes).toEqual([])
    expect(m.finished).toEqual([])
    expect(H.win.busy).toEqual([])
    expect(H.win.publishMetaCalls).toEqual([])
    expect(getOps(H.dir).last).toBeNull()
    expect(H.publishedTargets()).toEqual(['sakura-apprun'])
    expect(stateKinds(H.dir)).toEqual(['apprun-app', 'bucket'])
    m.unmount()
  })

  it('★★★ 確認の文は共通の文の作り手が、main の記録から作る: アプリ・保存場所の名前・「元に戻せません」・🔗（URL が変わる）を言う。共通の読み口（storage:placement）は呼ばない', async () => {
    withRegistry()
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.body).toContain(`対象のプロジェクト: 『${path.basename(H.dir)}』`)
    expect(props.body).toContain("次を破棄します: AppRun アプリ『myapp』・保存場所『koto-data-a』にある、このプロジェクトのデータ")
    expect(props.body).toContain('この操作は元に戻せません。')
    expect(props.body).toContain(`🔗 ${urlChangesOnTeardownNotice()}`)
    expect(props.body).not.toContain('の課金は止まります')
    expect(H.win.commonPlacementReads).toBe(0)
    props.onCancel()
    await tick()
    m.unmount()
  })

  it('★★★ 確認にレジストリの選択の欄が出る（Koto が作ったものは既定オン）。借り物は既定オフで、外した理由が出る', async () => {
    withRegistry()
    const own = H.mountRow()
    const ownProps = await H.pressAndWaitConfirm(own)
    expect(ownProps.choices.map((c: any) => c.id)).toEqual(['deleteRegistry'])
    expect(ownProps.choices[0].label).toBe(registryDeleteLabel('myreg'))
    expect(ownProps.choices[0].note).toBeUndefined()
    expect(ownProps.choiceValues).toEqual({ deleteRegistry: true })
    ownProps.onCancel()
    await tick()
    own.unmount()

    withRegistry({ adopted: true })
    const adopted = H.mountRow()
    const adoptedProps = await H.pressAndWaitConfirm(adopted)
    expect(adoptedProps.choiceValues).toEqual({ deleteRegistry: false })
    expect(adoptedProps.choices[0].note).toBe(adoptedRegistryNote('myreg'))
    adoptedProps.onCancel()
    await tick()
    adopted.unmount()
    expect(h.calls).toEqual([])
  })

  it('★★★ 印が無いレジストリ（作者の手元の実例の形）: 既定オフで、作ったか分からないことを言う', async () => {
    withRegistry({ unmarked: true })
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.choices.map((c: any) => c.id)).toEqual(['deleteRegistry'])
    expect(props.choiceValues).toEqual({ deleteRegistry: false })
    expect(props.choices[0].note).toBe(unknownOriginRegistryNote('myreg'))
    props.onCancel()
    await tick()
    m.unmount()
    expect(h.calls).toEqual([])
  })

  it('★★ レジストリの記録が無い（アプリはある）: 選択の欄は出ず、「記録がない」の注意が出る。消せないものを選ばせない', async () => {
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    expect(props.choices).toEqual([])
    expect(props.body).toContain(`⚠️ ${registryUnknownNotice()}`)
    props.onCancel()
    await tick()
    m.unmount()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 破棄する → 結果
// ═══════════════════════════════════════════════════════════════════════════════

describe('E 行 → 流れ → 本物の main: 破棄 → 結果', () => {
  it('★★★ E-2 破棄する（全部片づく回・選択は触らない）: アプリ → レジストリ → 保存場所の順に要求が出て、結果が1回。公開の記録を消したのは main で、画面は触れていない', async () => {
    withRegistry()
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '結果が届かない')
    await tick()

    expect(h.calls.slice(0, 3)).toEqual([DELETE_APP, 'listContainerRegistries', DELETE_REGISTRY])
    expect(h.calls).toEqual(expect.arrayContaining(STORAGE_A))
    expect(h.calls.indexOf(DELETE_APP)).toBeLessThan(h.calls.indexOf(`deleteBucket ${A}`))
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].entry).toBe(m.entry)
    expect(m.outcomes[0].outcome.view.state).toBe('done')
    expect(m.outcomes[0].outcome.view.ok).toBe(true)
    expect(m.outcomes[0].outcome.notes).toEqual([])
    expect('nothingToDo' in m.outcomes[0].outcome).toBe(false)
    // 公開の記録（📡 の行）は main が消した。画面は publishMeta に1回も触れていない。
    expect(H.publishedTargets()).toEqual([])
    expect(H.win.publishMetaCalls).toEqual([])
    expect(m.finished).toEqual([1]) // 結果を出したあとで一覧を読み直す
    expect(H.win.dispatched).toContain('sakura-meta-changed')
    m.unmount()
  })

  it('★★★ レジストリのチェックを外して破棄: レジストリへの削除の要求は0件。結果は「残した」旨の警告つきで、行（公開の記録）は消える', async () => {
    withRegistry()
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    props.onToggleChoice('deleteRegistry', false)
    expect(m.confirm.props.choiceValues).toEqual({ deleteRegistry: false })
    m.confirm.props.onConfirm()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    await tick()

    expect(h.calls).not.toContain(DELETE_REGISTRY)
    expect(h.calls).not.toContain('listContainerRegistries')
    expect(h.calls).toContain(DELETE_APP)
    const view = m.outcomes[0].outcome.view
    expect(view.ok).toBe(true)
    expect(view.warnings.join('\n')).toContain('myreg')
    expect(view.warnings.join('\n')).toContain('月額')
    expect(H.publishedTargets()).toEqual([])
    m.unmount()
  })

  it('★★★ 借り物のレジストリを、選択を触らずに破棄: 既定オフのまま、レジストリへの削除の要求は0件（引き継いだ置き場を勝手に消さない）', async () => {
    withRegistry({ adopted: true })
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(h.calls).not.toContain(DELETE_REGISTRY)
    expect(h.calls).toContain(DELETE_APP)
    expect(m.outcomes[0].outcome.view.warnings.join('\n')).toContain('myreg')
    m.unmount()
  })

  it('★★ 借り物でも、利用者がチェックを入れて破棄すれば消す（利用者が選んだ）', async () => {
    withRegistry({ adopted: true })
    const m = H.mountRow()
    const props = await H.pressAndWaitConfirm(m)
    props.onToggleChoice('deleteRegistry', true)
    m.confirm.props.onConfirm()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(h.calls).toContain(DELETE_REGISTRY)
    m.unmount()
  })

  it('★★★ E-3 窓を閉じる警告: deleteApp が走っている間だけ立つ（名前は「さくらのAppRun の破棄」・PUBLISH_CLOSE_WARNING）。終われば外れる', async () => {
    withRegistry()
    const g = holdGate()
    let entered = false
    h.hold = { entered: () => { entered = true }, gate: g.p }
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => entered, '破棄が走り出さない')

    expect(H.win.busy[0]).toEqual(CLOSE_WARNING_CALL)
    expect(m.parts.busy).toBe(true)
    expect(m.parts.button.props.disabled).toBe(true)
    expect(m.parts.button.props.children).toBe('破棄しています…')
    expect(m.busy).toContain(true) // 一覧へ「実行中」を伝えた

    g.open()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    const last = H.win.busy[H.win.busy.length - 1]
    expect(last[0]).toBe(false)
    expect(last[2]).toBe(false)
    expect(m.busy[m.busy.length - 1]).toBe(false)
    m.unmount()
  })

  it('★★ E-4 二重押し: 確認を待っている間・実行中にもう一度押しても、deleteApp は1本', async () => {
    const g = holdGate()
    let entered = false
    h.hold = { entered: () => { entered = true }, gate: g.p }
    const m = H.mountRow()
    m.parts.button.props.onClick()
    m.parts.button.props.onClick() // 確認を待っている最中にもう一度
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが開かない')
    m.confirm.props.onConfirm()
    await until(() => entered, '破棄が走り出さない')
    m.parts.button.props.onClick() // 実行中にもう一度
    await tick()
    expect(m.confirm.props.open).toBe(false) // 2つ目の確認は開かない
    g.open()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(h.calls.filter(c => c.startsWith('deleteApp '))).toEqual([DELETE_APP])
    expect(m.outcomes).toHaveLength(1)
    m.unmount()
  })

  it('★★ 🗑 の文字と title: 「🗑 破棄」。title は「破棄します」。別の行の破棄が走っている（blocked）あいだは押せない', () => {
    const m = H.mountRow()
    expect(m.parts.button.props.children).toBe('🗑 破棄')
    expect(m.parts.button.props.title).toContain('破棄します')
    expect(m.parts.button.props.disabled).toBe(false)
    m.unmount()
    const blocked = H.mountRow({ blocked: true })
    expect(blocked.parts.button.props.disabled).toBe(true)
    blocked.unmount()
  })

  it('★★ 行が一覧から消えた（アンマウント）とき、実行中の印を必ず下ろす', async () => {
    const g = holdGate()
    let entered = false
    h.hold = { entered: () => { entered = true }, gate: g.p }
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => entered && m.busy.includes(true), '実行中の印が上がらない')
    m.unmount()
    expect(m.busy[m.busy.length - 1]).toBe(false)
    g.open()
    await tick()
  })

  it('★★ 別の操作（公開など）が走っているあいだ: 🗑 は押せない。title が理由を言う', async () => {
    const g = holdGate()
    const holder = withProjectLock(H.dir, '公開', () => g.p, { target: 'sakura-apprun', handler: 'cloud:apply', secrets: [] })
    const m = H.mountRow()
    await until(() => m.parts.button.props.disabled === true, '別の操作が走っているのに押せる')
    expect(m.parts.button.props.title).toContain('別の操作')
    g.open(); await holder
    m.unmount()
  })

  it('★★ アプリの削除に失敗: 結果は失敗。保存場所・レジストリへは触れず、公開の記録（行）は残る。state にアプリが残る', async () => {
    withRegistry()
    h.fail[DELETE_APP] = 'http500'
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(h.calls.filter(c => c !== 'dispose')).toEqual([DELETE_APP])
    const view = m.outcomes[0].outcome.view
    expect(view.ok).toBe(false)
    expect(view.appDeleted).toBe(false)
    expect(H.publishedTargets()).toEqual(['sakura-apprun'])
    expect(stateKinds(H.dir)).toContain('apprun-app')
    m.unmount()
  })

  it('★★ アプリと保存場所の bucket が state に残っていても、確認が言った保存場所（A）だけを消す', async () => {
    H.writeProject({ env: [A], resources: [APP, bucketRef(A)] })
    const m = H.mountRow()
    await H.pressAndConfirm(m)
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(h.calls.filter(c => c.startsWith('listAllKeys '))).toEqual([`listAllKeys ${A}`])
    m.unmount()
  })
})
