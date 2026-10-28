import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import path from 'node:path'

// ── 段階2（2c）: 【公開】(AppRunPanel) の「🗑 破棄する（削除）」S1（手順6）・S2（期限切れのバナー）を、本物の画面（偽の React の上）・
//    本物の流れ・本物の main（cloud:teardown・cloud:teardownRecord）・偽の client/偽の保存場所に通す（押す → 確認 → 破棄 → 結果）─────
// 設計書: docs/teardown-unify-plan.md の 10.7.12 の S1・S2、10.7.9（S1・S2）。続きは tests/sharedTeardownSectionStates.test.ts
// （消すものが記録に無い回・P11・P2・記録が読めない回・切り替え・開き直し）。
//
// S1・S2 は 📡 一覧の行（TeardownRow）と同じ流れ（runTeardownFlow）を、共用型の仕様書（sharedTeardownSpec）で通る。画面（AppRunPanel）が持つのは
// 押せる場所と、実行中の印・終わったあとの取り直しだけ。確認の文・窓を閉じる警告・キー・IPC の呼び形は、流れと仕様書が持つ。
//   ・確認は共通の ConfirmModal（選択つき）。答えが「破棄する」でなければ、外へ1本も出ない（さくらのクラウドへも保存場所へも）
//   ・実行中は窓を閉じる警告が載り（公開と同じ文）、終われば外れる
//   ・結果は共通の結果欄（✅ 破棄しました・警告の枠）。画面は公開の記録（📡 の行）に一度も触れない——消すのは main の1か所
//   ・出る要求を1本の並び（h.calls）で見る（ソースの文字列は読まない・掟10）
// 画面は偽の React（tests/appRunPanelRt.ts）の上で本当に動かす。main 側の偽（client・保存場所・鍵）は tests/sharedTeardownHarness.ts、
// 画面の取り付けは tests/sharedSectionHarness.ts。

vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())
vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { RT } from './appRunPanelRt'
import { A, APP, PREFIX, bucketRef, h, stateKinds } from './sharedTeardownHarness'
import {
  createSectionHarness, settle, TEARDOWN_BUTTON, EXPIRED_BUTTON, CLOSE_WARNING_CALL, CLOSE_WARNING_CLEARED,
} from './sharedSectionHarness'
import { getOps } from '../src/main/projectOps'
import { adoptedRegistryNote, registryDeleteLabel, registryUnknownNotice, unknownOriginRegistryNote, urlChangesOnTeardownNotice } from '../src/shared/cloudCost'

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const H = createSectionHarness()
/** 全部入りの形: アプリ・保存場所 A・Koto が作ったレジストリ myreg（印は false）。`adopted` は借りたもの、`unmarked` は印が無いもの。 */
const withRegistry = (over: { adopted?: boolean; unmarked?: boolean } = {}) =>
  ({ meta: { registryName: 'myreg', ...(over.unmarked ? {} : { registryAdopted: over.adopted === true }) } })
const DELETE_APP = 'deleteApp app-1'
const DELETE_REGISTRY = 'deleteContainerRegistry reg-1'
const STORAGE_A = ['connect', `listAllKeys ${A}`, `deleteKeys ${A}`, `deleteBucket ${A}`]
/** 確認で見せた保存場所（名前と prefix の組）。確認の 💾 が名指しした A を、記録の prefix のまま main へ運ぶ（0.6.24 F）。 */
const SHOWN_A = [{ bucket: A, prefix: PREFIX }]
const until = async (cond: () => boolean, what: string) => {
  for (let k = 0; k < 200 && !cond(); k++) await settle()
  expect(cond(), what).toBe(true)
}

beforeEach(async () => { await H.setup(withRegistry()) })
afterEach(() => { H.cleanup() })

// ═══════════════════════════════════════════════════════════════════════════════
// 押す → 確認
// ═══════════════════════════════════════════════════════════════════════════════

describe('S1 手順6の 🗑 → 流れ → 本物の main: 確認', () => {
  it('★★★ 押すと確認が出て、「キャンセル」では、さくらのクラウドへも保存場所へも要求0件。窓を閉じる警告も立たず、記録も増えず、ボタンは押せるまま、結果も出ない', async () => {
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    expect(c.props.title).toBe('さくらのAppRun の公開を破棄します')
    expect(c.props.confirmLabel).toBe('破棄する')
    expect(c.props.danger).toBe(true)
    // 確認の前に、外へ1本も出ていない
    expect(h.calls).toEqual([])
    expect(H.win.busy).toEqual([])
    c.props.onCancel()
    await settle()
    expect(v.confirm(), 'やめたのに確認が残っている').toBeNull()
    expect(h.calls).toEqual([])
    expect(H.win.busy).toEqual([])
    expect(H.win.teardownArgs, 'やめたのに破棄の IPC が呼ばれた').toEqual([])
    expect(getOps(H.dir).last).toBeNull()
    expect(H.publishedTargets()).toEqual(['sakura-apprun'])
    expect(stateKinds(H.dir)).toEqual(['apprun-app', 'bucket'])
    expect(v.button(TEARDOWN_BUTTON).props.disabled, 'やめたあとに押せない').toBe(false)
    expect(v.text()).not.toContain('✅ 破棄しました')
    expect(v.text()).not.toContain('破棄できませんでした')
    expect(H.win.publishMetaCalls).toEqual([])
  })

  it('★★★ 確認の文は共通の文の作り手が、押した時点の main の記録から作る: アプリ・保存場所の名前・「元に戻せません」・🔗（URL が変わる）を言う。旧い文（環境を破棄します）は出ない', async () => {
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    expect(c.props.body).toContain(`対象のプロジェクト: 『${path.basename(H.dir)}』`)
    expect(c.props.body).toContain('次を破棄します: AppRun アプリ『myapp』・保存場所『koto-data-a』にある、このプロジェクトのデータ')
    expect(c.props.body).toContain('この操作は元に戻せません。')
    expect(c.props.body).toContain(`🔗 ${urlChangesOnTeardownNotice()}`)
    // 原本で確かめていない課金の停止は言わない
    expect(c.props.body).not.toContain('の課金は止まります')
    // T069: 旧い赤い確認の文（「（作成済みリソース）」つき）は、共通の確認に置き換わって出ない
    expect(c.props.body).not.toContain('作成済みリソース')
    expect(c.props.title).not.toContain('環境を破棄します')
    c.props.onCancel()
    await settle()
  })

  it('★★★ 確認にレジストリの選択の欄が出る（Koto が作ったものは既定オン）。借り物は既定オフで、外した理由が出る', async () => {
    const own = H.mount()
    await settle()
    const c1 = await H.pressAndWaitConfirm(own)
    expect(c1.props.choices.map((c: any) => c.id)).toEqual(['deleteRegistry'])
    expect(c1.props.choices[0].label).toBe(registryDeleteLabel('myreg'))
    expect(c1.props.choices[0].note).toBeUndefined()
    expect(c1.props.choiceValues).toEqual({ deleteRegistry: true })
    c1.props.onCancel()
    await settle()
    own.close()

    await H.setup(withRegistry({ adopted: true }))
    const adopted = H.mount()
    await settle()
    const c2 = await H.pressAndWaitConfirm(adopted)
    expect(c2.props.choiceValues).toEqual({ deleteRegistry: false })
    expect(c2.props.choices[0].note).toBe(adoptedRegistryNote('myreg'))
    c2.props.onCancel()
    await settle()
    expect(h.calls).toEqual([])
  })

  // 印が無い（作者の手元の実例の形）は「Koto が作った」と読まない。既定オフで、作ったか分からないことを言う。
  it('★★★ 印が無いレジストリ（作ったか分からない）: 既定オフで、借り物とは別の注意が出る', async () => {
    await H.setup(withRegistry({ unmarked: true }))
    const c = await H.pressAndWaitConfirm(H.mount())
    expect(c.props.choiceValues).toEqual({ deleteRegistry: false })
    expect(c.props.choices[0].note).toBe(unknownOriginRegistryNote('myreg'))
    c.props.onCancel()
    await settle()
    expect(h.calls).toEqual([])
  })

  it('★★ レジストリの記録が無い（アプリはある）: 選択の欄は出ず、「記録がない」の注意が出る。消せないものを選ばせない', async () => {
    await H.setup()
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    expect(c.props.choices).toEqual([])
    expect(c.props.body).toContain(`⚠️ ${registryUnknownNotice()}`)
    c.props.onCancel()
    await settle()
  })

  it('★★ 二重押し: 確認を待っている間にもう一度押しても、2つ目の確認は重ならない。破棄は1回', async () => {
    const v = H.mount()
    await settle()
    v.button(TEARDOWN_BUTTON).props.onClick()
    v.button(TEARDOWN_BUTTON).props.onClick() // 確認を待っている最中にもう一度
    const c = await H.waitConfirm(v)
    expect(c).not.toBeNull()
    await settle()
    // 確認の材料を読むのは共通の流れだけ。2つ目の流れが始まっていれば、材料の読み出しが2回になる（確認が重なり、最初の答えは漏れる）
    expect(H.win.reads.estimates, '確認を待っている間の2度目の押下で、2つ目の流れが始まった').toBe(1)
    c!.props.onConfirm()
    await until(() => getOps(H.dir).last !== null, '破棄が走らない')
    await settle()
    expect(h.calls.filter(x => x === DELETE_APP), '破棄が2回走った').toEqual([DELETE_APP])
    expect(H.win.teardownArgs).toHaveLength(1)
    // 終わったあとは、また押せる（門が戻っている）
    expect(v.button(TEARDOWN_BUTTON).props.disabled).toBe(false)
    v.button(TEARDOWN_BUTTON).props.onClick()
    await settle()
    // （破棄は済んでいるので、2回目は「破棄するものはありません」で終わる。確認は出ない）
    expect(H.win.reads.estimates, '終わったあとに押しても、流れが始まらない（二重押しの印が戻っていない）').toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 破棄する → 結果
// ═══════════════════════════════════════════════════════════════════════════════

describe('S1 手順6の 🗑 → 流れ → 本物の main: 破棄 → 結果', () => {
  it('★★★ 破棄する（全部片づく回・選択は触らない）: アプリ → レジストリ → 保存場所の順に要求が出て、結果が共通の結果欄に1回。公開の記録を消したのは main で、画面は触れていない', async () => {
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    await settle()

    expect(h.calls.slice(0, 3)).toEqual([DELETE_APP, 'listContainerRegistries', DELETE_REGISTRY])
    expect(h.calls).toEqual(expect.arrayContaining(STORAGE_A))
    expect(h.calls.indexOf(DELETE_APP)).toBeLessThan(h.calls.indexOf(`deleteBucket ${A}`))
    // IPC は新しい呼び形で1回（認証の印・確認の印・レジストリの選択・確認した時点の名前）
    expect(H.win.teardownArgs).toEqual([[H.dir, { heldByMain: true }, { confirmed: true, deleteRegistry: true, registryName: 'myreg', shownPlacements: SHOWN_A }]])
    expect(v.text()).toContain('✅ 破棄しました')
    expect(v.text()).not.toContain('破棄できませんでした')
    // 公開の記録（📡 の行）は main が消した。画面は publishMeta に1回も触れていない。
    expect(H.publishedTargets()).toEqual([])
    expect(H.win.publishMetaCalls).toEqual([])
    expect(stateKinds(H.dir)).toEqual([])
    // 画面は実行中の印を下ろし、また押せる
    expect(v.button(TEARDOWN_BUTTON).props.disabled).toBe(false)
  })

  it('★★★ 実行中は窓を閉じる警告が載り（公開と同じ文）、終わると外れる。実行中は 🗑 が押せない', async () => {
    const gate = H.holdTeardown()
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    // 走っている最中
    expect(H.win.busy.at(-1), '実行中の窓を閉じる警告が載っていない').toEqual(CLOSE_WARNING_CALL)
    expect(v.button(TEARDOWN_BUTTON).props.disabled, '破棄が走っているのに、もう一度押せる').toBe(true)
    gate.open()
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    expect(H.win.busy.at(-1), '終わったのに窓を閉じる警告が残っている').toEqual(CLOSE_WARNING_CLEARED)
    expect(v.button(TEARDOWN_BUTTON).props.disabled).toBe(false)
  })

  it('★★★ レジストリのチェックを外して破棄: レジストリへの削除の要求は0件。結果は「残した」旨の警告つき（黄色の枠）で、行（公開の記録）は消える', async () => {
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    c.props.onToggleChoice('deleteRegistry', false)
    await settle()
    expect(v.confirm()!.props.choiceValues).toEqual({ deleteRegistry: false })
    c.props.onConfirm()
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')

    expect(h.calls).not.toContain(DELETE_REGISTRY)
    expect(h.calls).not.toContain('listContainerRegistries')
    expect(h.calls).toContain(DELETE_APP)
    expect(H.win.teardownArgs[0][2]).toEqual({ confirmed: true, deleteRegistry: false, registryName: 'myreg', shownPlacements: SHOWN_A })
    const box = RT.findAll(v.tree(), (n: any) => n.type === 'div' && n.props['data-teardown-warnings'] !== undefined)
    expect(box.length, '月額が続く警告が、黄色の知らせの枠に出ていない').toBe(1)
    expect(RT.textOf(box[0])).toContain('myreg')
    expect(RT.textOf(box[0])).toContain('月額')
    expect(H.publishedTargets()).toEqual([])
  })

  it('★★★ 借り物のレジストリを、選択を触らずに破棄: 既定オフのまま、レジストリへの削除の要求は0件（引き継いだ置き場を勝手に消さない）', async () => {
    await H.setup(withRegistry({ adopted: true }))
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    expect(h.calls).not.toContain(DELETE_REGISTRY)
    expect(h.calls).not.toContain('listContainerRegistries')
    expect(H.win.teardownArgs[0][2]).toEqual({ confirmed: true, deleteRegistry: false, registryName: 'myreg', shownPlacements: SHOWN_A })
  })

  it('★★ S2 期限切れのバナーの 🗑 も、手順6の 🗑 と同じ流れ・同じ確認・同じ要求（入口が違っても同じ）', async () => {
    // 手順6から押した確認の文（同じプロジェクトで比べる）
    const s1 = H.mount()
    await settle()
    const c1 = await H.pressAndWaitConfirm(s1)
    const bodyOfS1 = c1.props.body
    c1.props.onCancel()
    await settle()
    s1.close()
    expect(h.calls).toEqual([])

    H.setExpired(true)
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v, EXPIRED_BUTTON, { exact: true })
    expect(c.props.title).toBe('さくらのAppRun の公開を破棄します')
    expect(c.props.body).toContain('次を破棄します: AppRun アプリ『myapp』・保存場所『koto-data-a』にある、このプロジェクトのデータ')
    expect(c.props.body, '入口が違うと確認の文が変わる').toBe(bodyOfS1)
    c.props.onConfirm()
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    expect(h.calls.slice(0, 3)).toEqual([DELETE_APP, 'listContainerRegistries', DELETE_REGISTRY])
    expect(H.win.teardownArgs).toEqual([[H.dir, { heldByMain: true }, { confirmed: true, deleteRegistry: true, registryName: 'myreg', shownPlacements: SHOWN_A }]])
    expect(H.win.publishMetaCalls).toEqual([])
    expect(H.publishedTargets()).toEqual([])
  })

  it('★★ 保存場所の一覧に失敗した回: 結果は「破棄できませんでした」で、残った保存場所を言う。公開の記録（行）と state は残り、押し直して片づく', async () => {
    h.fail[`listAllKeys ${A}`] = 'throw'
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('破棄できませんでした'), '失敗の結果が届かない')
    expect(v.text()).toContain(A)
    expect(v.text()).toContain('🤖 AIに相談する')
    // 保存場所が残ったので、保存場所を消せるコントロールパネルへ案内する（アプリは消えているので、AppRun の管理画面へは案内しない）
    const storageLink = RT.findAll(v.tree(), (n: any) => n.type === 'a' && n.props['data-teardown-storage-console'] !== undefined)
    expect(storageLink.map((n: any) => n.props.href)).toEqual(['https://secure.sakura.ad.jp/cloud/'])
    expect(RT.findAll(v.tree(), (n: any) => n.type === 'a' && n.props['data-teardown-service-console'] !== undefined)).toEqual([])
    // 失敗の回は、公開の記録（📡 の行）を消さない（押し直す場所を残す）
    expect(H.publishedTargets()).toEqual(['sakura-apprun'])
    // 画面は実行中の印を下ろし、押し直せる
    expect(v.button(TEARDOWN_BUTTON).props.disabled).toBe(false)
    expect(H.win.busy.at(-1)).toEqual(CLOSE_WARNING_CLEARED)

    delete h.fail[`listAllKeys ${A}`]
    h.calls.length = 0
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('✅ 破棄しました'), '押し直しの結果が届かない')
    expect(h.calls).not.toContain(DELETE_APP) // アプリは消えている
    expect(h.calls).toEqual(expect.arrayContaining(STORAGE_A))
    expect(H.publishedTargets()).toEqual([])
  })

  it('★★ 失敗の結果の「🤖 AIに相談する」は、共用型の言葉で相談の文を作って渡す', async () => {
    h.fail[DELETE_APP] = 'throw'
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('破棄できませんでした'), '失敗の結果が届かない')
    v.button('AIに相談する').props.onClick()
    expect(H.win.askAi).toHaveLength(1)
    expect(H.win.askAi[0]).toContain('さくらのAppRun')
    expect(H.win.askAi[0]).toContain('破棄')
    // アプリを消せたと分からない失敗は、AppRun の管理画面へ案内する
    const serviceLink = RT.findAll(v.tree(), (n: any) => n.type === 'a' && n.props['data-teardown-service-console'] !== undefined)
    expect(serviceLink.map((n: any) => n.props.href)).toEqual(['https://secure.sakura.ad.jp/cloud/apprun/'])
  })

  it('★★ キー未登録: main が外へ出さずに断る。結果は失敗で、行（公開の記録）はそのまま', async () => {
    h.creds = null
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('破棄できませんでした'), '失敗の結果が届かない')
    expect(v.text()).toContain('APIキー未登録')
    expect(h.calls).toEqual([])
    expect(H.publishedTargets()).toEqual(['sakura-apprun'])
  })

  it('★★ IPC 自体が投げた回（画面の外で起きる失敗）: 「破棄処理でエラーが発生しました」を結果に出す。実行中の印は下りる', async () => {
    H.failTeardownWith(new Error('接続が切れました（テスト）'))
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('破棄できませんでした'), '失敗の結果が届かない')
    expect(v.text()).toContain('破棄処理でエラーが発生しました: 接続が切れました（テスト）')
    expect(H.win.busy.at(-1)).toEqual(CLOSE_WARNING_CLEARED)
    expect(v.button(TEARDOWN_BUTTON).props.disabled).toBe(false)
  })

  it('★★ 次の操作を始めると、前の結果は片づく（もう一度 🗑 を押したとき、前の結果が残らない）', async () => {
    h.fail[DELETE_APP] = 'throw'
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('破棄できませんでした'), '失敗の結果が届かない')
    delete h.fail[DELETE_APP]
    v.button(TEARDOWN_BUTTON).props.onClick() // 押した時点で、前の結果を片づける（確認はまだ答えていない）
    await settle()
    expect(v.text(), '前の失敗が残っている').not.toContain('破棄できませんでした')
    ;(await H.waitConfirm(v))!.props.onCancel()
    await settle()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 終わったあとの取り直し
// ═══════════════════════════════════════════════════════════════════════════════

describe('S1: 終わったあと、画面の状態を取り直す（実行を始めた回だけ）', () => {
  const hasRollback = (v: { tree(): any }) => RT.findAll(v.tree(), (n: any) => n.type === 'RollbackSection').length
  const staleImagesButton = '古いイメージを削除する'

  it('★★★ アプリが消えると、公開URL（前のバージョンへ戻す）の節と「（更新）」が消える。レジストリを消したので古いイメージの片づけも消える。期限と計画は取り直す', async () => {
    H.setAppUrl('https://myapp.example.test')
    const v = H.mount()
    await settle()
    expect(hasRollback(v), '前提: 公開URLがあれば戻す節が出る').toBe(1)
    expect(v.text()).toContain('🚀 公開する（更新）')
    expect(v.text()).toContain(staleImagesButton)
    const before = { ...H.win.reads }
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    await settle()
    expect(hasRollback(v), '破棄したのに公開URLの節が残っている').toBe(0)
    expect(v.text(), '破棄したのに「（更新）」のまま（公開済みを取り直していない）').not.toContain('🚀 公開する（更新）')
    expect(v.text(), 'レジストリを消したのに古いイメージの片づけが残っている（レジストリ名を取り直していない）').not.toContain(staleImagesButton)
    expect(H.win.reads.checkExpiry, '期限を取り直していない').toBeGreaterThan(before.checkExpiry)
    expect(H.win.reads.plan, '計画を取り直していない').toBeGreaterThan(before.plan)
  })

  it('★★ アプリを消せなかった回は、公開URLの節も「（更新）」もそのまま残す（消えていないものを消えたと見せない）', async () => {
    H.setAppUrl('https://myapp.example.test')
    h.fail[DELETE_APP] = 'throw'
    const v = H.mount()
    await settle()
    await H.pressAndConfirm(v)
    await until(() => v.text().includes('破棄できませんでした'), '失敗の結果が届かない')
    await settle()
    expect(hasRollback(v), 'アプリが残っているのに公開URLの節を消した').toBe(1)
    expect(v.text()).toContain('🚀 公開する（更新）')
  })

  it('★★ レジストリを残した回は、古いイメージの片づけ（レジストリがある間だけ出る）が残る', async () => {
    const v = H.mount()
    await settle()
    const c = await H.pressAndWaitConfirm(v)
    c.props.onToggleChoice('deleteRegistry', false)
    await settle()
    c.props.onConfirm()
    await until(() => v.text().includes('✅ 破棄しました'), '結果が届かない')
    await settle()
    expect(v.text()).toContain(staleImagesButton)
  })
})
