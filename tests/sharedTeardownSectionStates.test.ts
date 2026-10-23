import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階2（2c）: 【公開】(AppRunPanel) の 🗑（S1・S2）その2: 消すものが記録に無い回・記録に無い残骸（P11）・ほかの公開先（P2）・記録が読めない回・
//    プロジェクトの切り替え・閉じて開き直したあとの結果 ──────────────────────────────────────────────
// 設計書: docs/teardown-unify-plan.md の 10.7.12 の S1・S2、10.7.16 末尾の親の判断（2026-10-10）の 4（nothingToDoIsOk）・8（M1 の広がり）。
// 続き元は tests/sharedTeardownSection.test.ts（確認・破棄・結果）。取り付けは tests/sharedSectionHarness.ts。
//
//   ・消すものが記録に無い（幽霊の行）: 確認も IPC も出さず、「破棄するものはありません」を失敗の枠でなく成功の枠で出す。窓を閉じる警告も立たない
//   ・記録に無い残骸（レジストリだけ・保存場所だけ）でも確認を出す（P11。今の S1 の判断を残した）
//   ・★ 同じ保存場所を使うほかの公開先（HANAMII）があれば、S1 でも確認に P2 の段落が出る（共用型が幽霊の行でも）
//   ・記録（env.json）が読めない回は、確認も要求も出さず、読めなかった旨の失敗を出す（消すものが分からないまま消させない）
//   ・待っている間にプロジェクトが切り替わったら、前のプロジェクトの結果を出さない。実行中の印は下ろす。戻れば記録から続きが見える（掟11）
//   ・閉じている間に終わった破棄の結果は、その場の結果と同じ文・同じ警告の枠で出る（TeardownView が1つ）

vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())
vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { RT } from './appRunPanelRt'
import { A, B, APP, bucketRef, h, newProjectDir, setup as setupProject, stateKinds } from './sharedTeardownHarness'
import { createSectionHarness, settle, TEARDOWN_BUTTON, CLOSE_WARNING_CLEARED } from './sharedSectionHarness'
import { getOps, beginOp, finishOp } from '../src/main/projectOps'
import { registryUnknownNotice } from '../src/shared/cloudCost'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const H = createSectionHarness()
const ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' }
const DELETE_APP = 'deleteApp app-1'
const DELETE_REGISTRY = 'deleteContainerRegistry reg-1'
const NOTHING = sharedTeardownSpec.words.nothingToDo
const P2_ONE = '⚠️ この保存場所は 🌸 HANAMII でも使っているため、そちらで公開中のアプリのデータも消えます'
const until = async (cond: () => boolean, what: string) => {
  for (let k = 0; k < 200 && !cond(); k++) await settle()
  expect(cond(), what).toBe(true)
}
/** 結果欄の、黄色の警告の枠の文字（無ければ空）。 */
const warningsOf = (v: { tree(): any }): string => RT.findAll(v.tree(), (n: any) => n.type === 'div' && n.props['data-teardown-warnings'] !== undefined).map(RT.textOf).join('\n')

beforeEach(async () => { await H.setup({ meta: { registryName: 'myreg', registryAdopted: false } }) })
afterEach(() => { H.cleanup() })

// ═══════════════════════════════════════════════════════════════════════════════
// 消すものが記録に無い（幽霊の行）
// ═══════════════════════════════════════════════════════════════════════════════

describe('S1・S2: 消すものが記録に無い回は、確認も IPC も出さず、中立の知らせで終える', () => {
  it('★★★ 幽霊の行（公開の記録に共用型の行があるが、アプリ・保存場所・レジストリの記録が空）: 確認0・IPC 0・要求0件・窓を閉じる警告なし。「破棄するものはありません」を成功の枠で出し、失敗とは言わない', async () => {
    await H.setup({ env: [], resources: [], meta: {} })
    const v = H.mount()
    await settle()
    v.disabledTrace.length = 0 // 開いた直後（キーの確認が済むまで押せない）は数えない。押してからの描き直しを見る
    v.button(TEARDOWN_BUTTON).props.onClick()
    await until(() => v.text().includes(NOTHING), '「破棄するものはありません」が出ない')
    await settle()
    expect(v.confirm(), '消すものが無いのに確認が出た').toBeNull()
    expect(v.disabledTrace.length, '前提: 描き直しを控えている').toBeGreaterThan(1)
    expect(v.disabledTrace.some(d => d), '消すものが無いのに、実行中の印が立った（🗑 が押せなくなった）').toBe(false)
    expect(H.win.teardownArgs, '消すものが無いのに破棄の IPC を呼んだ').toEqual([])
    expect(h.calls).toEqual([])
    expect(H.win.busy, '消すものが無いのに窓を閉じる警告が載った').toEqual([])
    expect(getOps(H.dir).last, '消すものが無いのに処理の記録ができた').toBeNull()
    // 失敗の枠ではない（赤い見出し・AI 相談が出ない）。今の成功の枠で出す。
    expect(v.text()).toContain('✅ 完了しました')
    expect(v.text()).not.toContain('⚠️ 失敗しました')
    expect(v.text()).not.toContain('破棄できませんでした')
    expect(v.text()).not.toContain('AIに相談する')
    // 公開の記録（行）はそのまま（画面は触らない。行を片づけるのは📡の「一覧から削除」）
    expect(H.publishedTargets()).toEqual(['sakura-apprun'])
    expect(H.win.publishMetaCalls).toEqual([])
    expect(v.button(TEARDOWN_BUTTON).props.disabled).toBe(false)
  })

  it('★★ 期限切れのバナーの 🗑（S2）も、消すものが無ければ同じ（確認も IPC も出さない）', async () => {
    await H.setup({ env: [], resources: [], meta: {} })
    H.setExpired(true)
    const v = H.mount()
    await settle()
    v.button('🗑 破棄する', { exact: true }).props.onClick()
    await until(() => v.text().includes(NOTHING), '「破棄するものはありません」が出ない')
    expect(v.confirm()).toBeNull()
    expect(H.win.teardownArgs).toEqual([])
    expect(h.calls).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// P11: 記録に無い残骸でも確認を出す
// ═══════════════════════════════════════════════════════════════════════════════

describe('S1・S2: 記録に無い残骸（P11）でも確認が出る', () => {
  it('★★★ レジストリだけ（アプリも保存場所も記録に無い）: 確認の先頭にレジストリを挙げ、選んで消せる。「記録がない」の注意は出ない（公開した形跡が無い）', async () => {
    await H.setup({ env: [], resources: [], meta: { registryName: 'myreg', registryAdopted: false } })
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    expect(c.props.body).toContain('次を破棄します: コンテナレジストリ『myreg』（下のチェックで選んだとき）')
    expect(c.props.body).not.toContain(registryUnknownNotice())
    expect(c.props.choices.map((x: any) => x.id)).toEqual(['deleteRegistry'])
    expect(h.calls).toEqual([])
    c.props.onConfirm()
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    expect(h.calls).toContain(DELETE_REGISTRY)
    expect(h.calls).not.toContain(DELETE_APP) // アプリは記録に無い
  })

  it('★★★ 保存場所だけ（アプリが記録に無い。設定には保存場所がある）: 確認が保存場所の名前を挙げ、🔗 は出さず、消せる', async () => {
    await H.setup({ env: [A], resources: [], meta: {} })
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    expect(c.props.body).toContain(`次を破棄します: 保存場所『${A}』にある、このプロジェクトのデータ`)
    expect(c.props.body).not.toContain('🔗')
    expect(c.props.body).not.toContain(registryUnknownNotice())
    c.props.onConfirm()
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    expect(h.calls).toEqual(expect.arrayContaining([`listAllKeys ${A}`, `deleteKeys ${A}`, `deleteBucket ${A}`]))
    expect(h.calls).not.toContain(DELETE_APP)
  })

  it('★★ 設定から外した保存場所（state にだけある）も、確認が言って消す（親の判断・M2）', async () => {
    await H.setup({ env: [A], resources: [APP, bucketRef(A), bucketRef(B)], meta: {} })
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    expect(c.props.body).toContain(`『${A}』『${B}』`)
    expect(c.props.body).toContain(`⚠️ 設定から外した保存場所『${B}』も削除します。`)
    c.props.onConfirm()
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    // 確認が言った保存場所だけを消す（言わなかった名前に触れない）
    expect(h.calls).toEqual(expect.arrayContaining([`listAllKeys ${A}`, `listAllKeys ${B}`, `deleteBucket ${A}`, `deleteBucket ${B}`]))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// P2: 同じ保存場所を使うほかの公開先がある（親の判断 8・M1 の広がり）
// ═══════════════════════════════════════════════════════════════════════════════

describe('S1・S2: 同じ保存場所を使うほかの公開先（HANAMII）があれば、確認に P2 の段落が出る', () => {
  it('★★★ HANAMII が公開中で、共用型は幽霊の行（アプリが記録に無く、保存場所だけ設定にある）: 確認が保存場所を言い、P2 の段落で HANAMII のデータも消えることを言う。押すと保存場所は消える（確認が言ったとおり）', async () => {
    await H.setup({
      env: [A], resources: [], meta: {},
      publish: { hanamii: { projectId: 'hnm-1', name: 'myapp' }, targets: { 'sakura-apprun': ROW, hanamii: ROW } },
    })
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    expect(c.props.body).toContain(`保存場所『${A}』`)
    expect(c.props.body).toContain(P2_ONE)
    c.props.onConfirm()
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    expect(h.calls).toContain(`deleteBucket ${A}`)
  })

  it('★★★ アプリがあるふつうの共用型でも、HANAMII が同じ保存場所を使っていれば P2 の段落が出る（期限切れの 🗑 でも同じ）', async () => {
    await H.setup({
      env: [A], resources: [APP, bucketRef(A)], meta: {},
      publish: { hanamii: { projectId: 'hnm-1', name: 'myapp' }, targets: { 'sakura-apprun': ROW, hanamii: ROW } },
    })
    H.setExpired(true)
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v, '🗑 破棄する', { exact: true })
    expect(c.props.body).toContain(P2_ONE)
    c.props.onCancel()
    await settle()
  })

  it('★★ 公開の記録に行が無い旧い HANAMII（hanamii.projectId だけ）も、名前で言う', async () => {
    await H.setup({ env: [A], resources: [APP], meta: {}, publish: { hanamii: { projectId: 'hnm-old' }, targets: { 'sakura-apprun': ROW } } })
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    expect(c.props.body).toContain(P2_ONE)
    c.props.onCancel()
    await settle()
  })

  it('★★ 消す保存場所が無い（アプリだけ）なら、ほかの公開先がいても P2 の段落は出ない（消えるデータが無い）。ほかの公開先が無いときも出ない', async () => {
    await H.setup({ env: [], resources: [APP], meta: {}, publish: { hanamii: { projectId: 'hnm-1' }, targets: { 'sakura-apprun': ROW, hanamii: ROW } } })
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    expect(c.props.body).not.toContain('HANAMII でも使っているため')
    c.props.onCancel()
    await settle()
    v.close()

    await H.setup({ env: [A], resources: [APP] })
    const solo = H.mount()
    await settle()
    const c2 = await H.pressAndWaitConfirm(solo)
    expect(c2.props.body).not.toContain('でも使っているため')
    c2.props.onCancel()
    await settle()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 記録が読めない回
// ═══════════════════════════════════════════════════════════════════════════════

describe('S1: 破棄するものの記録が読めない回は、確認も要求も出さない', () => {
  it('★★★ env.json が壊れている: 確認は開かず、要求0件。読めなかった旨の失敗が結果になる（「破棄するものはありません」ではない）', async () => {
    fs.writeFileSync(path.join(H.dir, '.sakura-cloud', 'env.json'), '{ これは壊れた JSON', 'utf-8')
    const v = H.mount()
    await settle()
    v.button(TEARDOWN_BUTTON).props.onClick()
    await until(() => v.text().includes('破棄できませんでした'), '失敗の結果が届かない')
    expect(v.text()).toContain(sharedTeardownSpec.words.factsUnreadable)
    expect(v.text()).not.toContain(NOTHING)
    expect(v.confirm()).toBeNull()
    expect(H.win.teardownArgs).toEqual([])
    expect(h.calls).toEqual([])
    expect(H.win.busy).toEqual([])
    expect(getOps(H.dir).last).toBeNull()
    expect(v.button(TEARDOWN_BUTTON).props.disabled).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// プロジェクトの切り替え（掟11）・閉じて開き直したあとの結果
// ═══════════════════════════════════════════════════════════════════════════════

describe('S1: 待っている間にプロジェクトが切り替わったら、前のプロジェクトの結果を出さない', () => {
  it('★★★ 実行中に別のプロジェクトへ切り替える: 終わっても、いまの画面に前の結果を出さない。実行中の印は下りる。戻ると、記録から続きが見える', async () => {
    const gate = H.holdTeardown()
    const first = H.dir
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    expect(H.win.busy.at(-1), '前提: 実行中の窓を閉じる警告').not.toEqual(CLOSE_WARNING_CLEARED)

    // 別のプロジェクトへ切り替わる
    const other = newProjectDir()
    try {
      setupProject(other, { env: [], resources: [] })
      await v.switchTo(other)
      gate.open()
      await until(() => getOps(first).last !== null, '破棄が終わらない')
      await settle()
      expect(v.text(), '前のプロジェクトの結果が、切り替えた先の画面に出ている').not.toContain('✅ 破棄しました')
      expect(v.text()).not.toContain('破棄できませんでした')
      expect(H.win.busy.at(-1), '終わったのに窓を閉じる警告が残っている').toEqual(CLOSE_WARNING_CLEARED)
      expect(v.button(TEARDOWN_BUTTON).props.disabled, '切り替えた先で 🗑 が押せないまま').toBe(false)

      // 前のプロジェクトへ戻ると、見ていない結果が記録から出る
      await v.switchTo(first)
      await until(() => v.text().includes('破棄の結果'), '戻っても、見ていない結果が出ない')
      expect(v.text()).toContain('✅ 破棄しました')
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('S1: ほかの確認（公開の確認・全面表示）と重なっても、破棄の確認は詰まらない', () => {
  it('★★ 破棄の確認を待っている間に公開の確認が全面で出ても、破棄の確認は消えない。公開の確認を閉じれば戻り、答えれば破棄は続く（早期 return の枝には描かない）', async () => {
    // 流れの確認（ConfirmModal）の状態は、フック（useConfirmChoices）が持つ。公開の確認が全面表示（早期 return）の間は描かれないが、状態は残る。
    H.setPlanActions([{ type: 'create', kind: 'apprun-app', name: 'myapp', description: 'アプリを作成' }])
    const v = H.mount()
    await settle()
    v.button(TEARDOWN_BUTTON).props.onClick()
    expect(await H.waitConfirm(v), '前提: 破棄の確認が出ている').not.toBeNull()
    v.button('🚀 公開する').props.onClick() // 破棄の確認を待つ間に、公開を始める
    await until(() => v.text().includes('以下の内容で さくらのAppRun に公開します'), '公開の確認が出ない')
    expect(v.confirm(), '前提: 公開の確認の全面表示の間は、破棄の確認は描かれない').toBeNull()
    expect(h.calls, '確認の答えを待つ間に、外へ出た').toEqual([])
    v.button('やめる').props.onClick() // 公開の確認をやめる
    await settle()
    const back = v.confirm()
    expect(back, '公開の確認を閉じても、破棄の確認が戻らない（詰まる）').not.toBeNull()
    back!.props.onConfirm()
    await until(() => v.text().includes('✅ 破棄しました'), '破棄が続かない')
    expect(h.calls).toContain(DELETE_APP)
  })
})

describe('S1: 切り替えたあとに終わった破棄は、切り替えた先の記録を「出した」ことにしない', () => {
  it('★★ 前のプロジェクトの破棄が走っている間に、切り替えた先で終わった公開の結果は、破棄が終わったあとも見落とさない', async () => {
    const other = newProjectDir()
    try {
      const gate = H.holdTeardown()
      const first = H.dir
      const v = H.mount()
      await settle()
      await H.pressAndConfirm(v)
      setupProject(other, { env: [], resources: [] })
      await v.switchTo(other)
      // 前のプロジェクトの破棄が走っている間に、切り替えた先で公開が終わる（この画面が動かしている操作の最中なので、まだ出さない）
      beginOp(other, '公開', { target: 'sakura-apprun', handler: 'cloud:apply' })
      finishOp(other, { value: { ok: true, message: '切り替えた先の結果' } })
      await settle()
      expect(v.text(), '前提: 動かしている操作の最中は、見ていない結果をまだ出さない').not.toContain('切り替えた先の結果')
      gate.open()
      await until(() => getOps(first).last !== null, '破棄が終わらない')
      await settle()
      // 次の知らせで、切り替えた先の見ていない結果が出る。前のプロジェクトの破棄が終わったことで「出した」ことにされていない。
      H.notifyOps(other, getOps(other))
      await until(() => v.text().includes('切り替えた先の結果'), '前のプロジェクトの破棄が、切り替えた先の記録を「出した」ことにしている')
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('S1: 閉じている間に終わった破棄の結果は、その場の結果と同じ文・同じ警告の枠で出る', () => {
  it('★★★ レジストリを残した破棄: その場の結果の警告と、閉じて開き直して記録から読んだ結果の警告が一致する（見出しは記録の方に「破棄の結果」が付く）', async () => {
    // その場の結果
    const live = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(live)
    c.props.onToggleChoice('deleteRegistry', false)
    await settle()
    c.props.onConfirm()
    await until(() => live.text().includes('✅ 破棄しました'), '結果が届かない')
    const liveWarnings = warningsOf(live)
    const liveText = live.text()
    expect(liveWarnings).toContain('myreg')
    expect(liveText).not.toContain('破棄の結果')

    // 画面の外で終わった破棄（同じ形のプロジェクト）を、開き直して読む
    live.close()
    await H.setup({ meta: { registryName: 'myreg', registryAdopted: false } })
    await H.mainTeardown({ confirmed: true, deleteRegistry: false, registryName: 'myreg' })
    const resumed = H.mount()
    await settle()
    expect(resumed.text()).toContain('破棄の結果')
    expect(resumed.text()).toContain('✅ 破棄しました')
    expect(warningsOf(resumed), '開き直した結果の警告が、その場の結果と食い違う').toBe(liveWarnings)
    expect(stateKinds(H.dir)).toEqual([])
    expect(H.win.publishMetaCalls).toEqual([])
  })
})
