import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── 【公開】(HanamiiPanel) の「🗑 この公開を破棄する」(H1) その1: 確認と、記録が作られない断り。段階1の1c ────────────
// 設計書: docs/teardown-unify-plan.md の 10.4.4（H1）・10.4.9（B・E）・10.4.11。
//
// H1 は、📡 一覧の行（TeardownRow）と同じ共通の破棄の流れ（teardown/flow.ts の runTeardownFlow）を通る。
// 入口が持つのは「押せる場所」と「画面の後始末」だけ（components/HanamiiTeardownSection.tsx）。確認の文・窓を閉じる警告・
// トークンの選び方は、共通の部品と仕様書（teardown/targets/hanamii.ts）が持つ。ここは**入口の振る舞い**を、
// 偽の React の上で HanamiiPanel を動かして固定する（偽の main は本物の記録・鍵の上。tests/ops-hanamiiVercel-harness.ts。
// パネルの取り付けは tests/hanamiiSectionHarness.ts）。その2（結果・切り替え・構造）は tests/hanamiiTeardownSectionResult.test.ts。
//
// 見ること:
//   ・確認は ConfirmModal で出る。答えが「破棄する」でなければ、main へ1本も出ず、窓を閉じる警告にも載らない（掟10）
//   ・確認の材料は**押した時点に**読む（保存場所は全件・名前つき。読めなかったときは言い落とさず注意を出す）。旧 placementAllPanels の ③ の置き換え
//   ・トークンは公開したときの登録だけで呼ぶ（D8）。見つからなければ呼ばずに止める（使用中のトークンへ倒さない）
//   ・記録が作られない断り（記録を読めない・消すものが無い・トークンが無い・例外）は、その場の結果欄に出る。別のプロジェクトの画面には出さない

vi.mock('react', async () => (await import('./ops-hanamiiVercel-harness')).reactModule)
vi.mock('react/jsx-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxRuntimeModule)
vi.mock('react/jsx-dev-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxDevRuntimeModule)
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AccessKeySection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/CredentialsModal', async () => (await import('./ops-hanamiiVercel-harness')).hanamiiCredentialsModalMock)

import { deferred, hanamiiTokens, settle, type World } from './ops-hanamiiVercel-harness'
import {
  createSectionHarness, confirmButton, cancelButton, DIR, DIR_B, PROJECT_ID, ENTRY, A, B,
} from './hanamiiSectionHarness'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { HANAMII_KEY_MISSING_MESSAGE } from '../src/renderer/teardown/targets/hanamii'
import { HANAMII_DELETION_ACCEPTED_WARNING } from '../src/shared/teardownResult'

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const h = createSectionHarness()
const { open, published, press, teardownCalls, lastBusy } = h
let world: World
beforeEach(() => { world = h.setup() })
afterEach(() => { h.cleanup() })
/** 確認の本文（ConfirmModal が描いた文字の全体）。 */
const confirmText = (m: { text(): string }): string => m.text()

describe('H1: 確認は ConfirmModal。「破棄する」と答えなければ、main へも窓の警告へも出ない（掟10）', () => {
  it('★★★ 入口を押すと確認が出る。main には1本も出ない。「やめる」で何も起きず、入口は押せるまま', async () => {
    published()
    world.placementReply = { ok: true, placement: A, placements: [A] }
    const screen = open()
    await settle()
    await press(screen)

    expect(screen.has('⚠️ HANAMII の公開を破棄します'), '確認（ConfirmModal）が出ていない').toBe(true)
    expect(confirmButton(screen), '確認の「破棄する」が無い').toBeDefined()
    expect(teardownCalls(), '確認の前に main へ出ている').toEqual([])
    expect(world.calls.setBusy, '確認の前に窓を閉じる警告へ載っている').toEqual([])

    cancelButton(screen)!.click()
    await settle()
    expect(confirmButton(screen), 'やめたのに確認が残っている').toBeUndefined()
    expect(teardownCalls(), 'やめたのに main へ出ている').toEqual([])
    expect(world.calls.setBusy, 'やめたのに窓を閉じる警告へ載っている').toEqual([])
    expect(world.calls.hanamiiTeardownTokens).toEqual([])
    expect(screen.button(ENTRY)?.disabled, 'やめたあと入口が押せない').toBe(false)
    // やめたことは失敗ではない（結果欄に何も出さない）
    expect(screen.has('破棄できませんでした'), 'やめたのに失敗の結果が出ている').toBe(false)
    expect(screen.has('エラーが発生しました'), 'やめたのにエラーが出ている').toBe(false)
  })

  it('★★★ 「破棄する」と答えると、公開したときの登録のトークンで main が呼ばれ、実行中は窓を閉じる警告が載り、終わると外れる', async () => {
    published()
    const screen = open()
    await settle()
    await press(screen)
    world.opGate = deferred()
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    confirmButton(screen)!.click()
    await settle()

    // 走っている最中: 窓を閉じる警告つきで活動に載っている（公開と同じ文）
    expect(teardownCalls()).toEqual([[PROJECT_ID, DIR]])
    expect(lastBusy(), '実行中の窓を閉じる警告が載っていない').toEqual([true, 'HANAMII の破棄', true, 'HANAMII の破棄', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel])
    expect(screen.button(ENTRY)?.disabled, '破棄が走っているのに、もう一度押せる').toBe(true)
    expect(screen.button('破棄中…')?.disabled, '破棄が走っているのに、公開が押せる').toBe(true)

    world.opGate.resolve()
    await settle()
    expect(lastBusy(), '終わったのに窓を閉じる警告が残っている').toEqual([false, '', false, '', '', ''])
    // 公開したときの登録のトークン（記録の tokenId）だけで呼ぶ。使用中のトークン・手順1で選んでいるトークンではない（D8）
    expect(world.calls.hanamiiTeardownTokens).toEqual(['tok-recorded'])
  })

  it('★★ 二重押し: 確認を待っている間にもう一度押しても、2つ目の流れは始まらない（確認の材料を読み直さず、確認も重ねない）。破棄は1回', async () => {
    // 入口の押せない条件（locked）は、確認のあと onStart まで立たない。確認を待つ間に二重起動を止めているのは、節の startedRef だけ。
    // 外れると、2つ目の確認が最初の確認を上書きして、最初の Promise が解決されないまま漏れる。
    published()
    world.placementReply = { ok: true, placement: A, placements: [A] }
    const screen = open()
    await settle()
    // 確認の材料を読むのは共通の流れ（loadTeardownFacts）だけ。目安の問い合わせ（stageTiming.estimates）は、画面のほかの部分は呼ばない。
    const stageTiming = (globalThis as any).window.electronAPI.stageTiming
    const estimates = stageTiming.estimates
    let factsReads = 0
    stageTiming.estimates = async (...a: unknown[]) => { factsReads++; return estimates(...a) }

    screen.button(ENTRY)!.click()
    screen.button(ENTRY)!.click() // 確認を待っている最中にもう一度
    await settle()
    expect(screen.button(ENTRY)?.disabled, '前提: 確認を待つ間は、入口はまだ押せる（locked は立っていない）').toBe(false)
    expect(factsReads, '確認を待っている間の2度目の押下で、2つ目の流れが始まった').toBe(1)

    world.teardownReply = { ok: false, appDeleted: false, message: '消せませんでした（テスト）' } // 入口が残る結果（成功だと画面は消えた状態になる）
    confirmButton(screen)!.click()
    await settle()
    expect(teardownCalls(), '破棄が2回走った／走らなかった').toEqual([[PROJECT_ID, DIR]])
    expect(factsReads).toBe(1)
    // 終わったあとは、また押せる（startedRef が戻る）
    expect(screen.button(ENTRY)?.disabled).toBe(false)
    screen.button(ENTRY)!.click()
    await settle()
    expect(factsReads, '終わったあとに押しても、流れが始まらない（二重押しの印が戻っていない）').toBe(2)
  })

  it('★★ 確認は、押した時点の記録から作る: 保存場所を全件・名前つきで言い、ほかの公開先と、元に戻せないことを言う。URL の文は言わない', async () => {
    published()
    world.meta.publish.targets = { ...world.meta.publish.targets, vercel: { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://app.vercel.test' } }
    world.placementReply = { ok: true, placement: A, placements: [A, B] }
    const screen = open()
    await settle()
    await press(screen)

    const t = confirmText(screen)
    expect(t).toContain('次を破棄します: HANAMII のプロジェクト『app』')
    // 2件あれば2件とも名指しする（名前が出なかった保存場所とデータまで消さない）
    expect(t).toContain(`『${A.bucket}』『${B.bucket}』`)
    expect(t).toContain('💾 ')
    expect(t, 'ほかの公開先で使っていることを言っていない').toContain(PUBLISH_TARGET_LABEL.vercel)
    expect(t).toContain('保存場所にあるデータの削除は元に戻せません。')
    // HANAMII は、共用型の「破棄したあとに公開し直すと別のURLになる」を言わない（原本に根拠が無い。10.4.6）
    expect(t, '共用型の URL の文が HANAMII の確認に出ている').not.toContain('別のURLになる')
    expect(t, '直す前の言い方（公開URLは無効になります）が戻っている').not.toContain('公開URLは無効になります')
    // HANAMII は保存場所を片づける公開先（teardownRemovesStorage('hanamii') が true）。残ると言う文は出ない（事実と逆になる）
    expect(t).toContain('にある、このプロジェクトのデータも削除します。')
    expect(t, '保存場所のデータが残ると言っている（事実と逆）').not.toContain('とその中のデータは残ります')
    // HANAMII のプロジェクトを消すと課金が止まるかは、原本で確かめていない
    expect(t, '原本で確かめていない課金の停止を言っている').not.toContain('の課金は止まります')
  })

  it('★★ 保存場所を使っていない回は「元に戻せません」と言わない（根拠にできるのは Koto が消す保存場所のデータだけ）', async () => {
    published()
    world.placementReply = { ok: true, placement: null, placements: [] }
    const screen = open()
    await settle()
    await press(screen)
    expect(confirmText(screen)).toContain('次を破棄します: HANAMII のプロジェクト『app』')
    expect(confirmText(screen), '保存場所が無いのに、元に戻せないと断定している').not.toContain('元に戻せません')
    expect(confirmText(screen)).not.toContain('💾')
  })

  it('★★ placements（全件）が無い古い応答でも、先頭の1件は名指しする（黙って空にしない）', async () => {
    published()
    world.placementReply = { ok: true, placement: A }
    const screen = open()
    await settle()
    await press(screen)
    expect(confirmText(screen)).toContain(`『${A.bucket}』`)
  })

  it('★★ 保存場所の設定を読めなかった回（ok:false）は、消えるものを勝手に作らず、注意を出す（保存場所の削除は行われない）', async () => {
    published()
    world.placementReply = { ok: false, message: '設定が壊れています', placement: A, placements: [A, B] }
    const screen = open()
    await settle()
    await press(screen)
    expect(confirmText(screen), '読めなかったのに名前を挙げている').not.toContain(A.bucket)
    expect(confirmText(screen)).toContain('保存場所の設定を読めないため、保存場所の削除は行われません。')
  })

  it('★★ 前回の破棄で保存場所だけが残った記録: 確認は、消えたプロジェクトの名前を挙げて「破棄します」と言わない', async () => {
    published({ storageLeftoverBuckets: [A.bucket] })
    world.placementReply = { ok: true, placement: A, placements: [A] }
    const screen = open()
    await settle()
    await press(screen)
    expect(confirmText(screen)).toContain(`前回の破棄で、HANAMII のプロジェクトは削除済みか見つからない状態でした。残っている保存場所『${A.bucket}』を削除します。`)
    expect(confirmText(screen), '消えたプロジェクトの名前を挙げて「破棄します」と言っている').not.toContain('次を破棄します')
  })
})

describe('H1: 記録が作られない断りは、その場の結果欄に出る。main へは出ない', () => {
  it('★★★ 公開に使ったトークンが見つからない: main を呼ばず、案内を出す。使用中のトークンへ倒さない', async () => {
    published({ tokenId: 'tk-gone' })                 // 記録のトークンの登録は消えている。使用中のトークン（tok-active）はある
    const screen = open()
    await settle()
    await press(screen)
    confirmButton(screen)!.click()
    await settle()

    expect(teardownCalls(), 'トークンが無いのに main を呼んでいる').toEqual([])
    expect(world.calls.hanamiiTeardownTokens, '使用中のトークンで別のアカウントを呼んでいる（D8）').toEqual([])
    expect(screen.count(HANAMII_KEY_MISSING_MESSAGE), '案内が出ていない／二重に出ている').toBe(1)
    expect(screen.has('⚠️ 破棄できませんでした')).toBe(true)
    expect(lastBusy(), '断ったあとに窓を閉じる警告が残っている').toEqual([false, '', false, '', '', ''])
    expect(screen.button(ENTRY)?.disabled, '断られたあと入口が押せない').toBe(false)
    expect(world.calls.forgetTarget).toEqual([])
  })

  it('★★ 記録に tokenId が無い旧い記録だけ、使用中のトークンで呼ぶ', async () => {
    published({ tokenId: undefined })
    const screen = open()
    await settle()
    await press(screen)
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    confirmButton(screen)!.click()
    await settle()
    expect(world.calls.hanamiiTeardownTokens).toEqual(['tok-active'])
  })

  it('★★ 消すものが記録に無い（開いたあとに記録の projectId が消えた）: 確認も main も出さず、案内を出す', async () => {
    published()
    const screen = open()
    await settle()
    world.meta.publish.hanamii.projectId = null       // 別の窓が破棄を終えて、記録が片づいた
    await press(screen)

    expect(confirmButton(screen), '消すものが無いのに破壊の確認を出している').toBeUndefined()
    expect(teardownCalls()).toEqual([])
    expect(world.calls.setBusy, '消すものが無いのに窓を閉じる警告へ載っている').toEqual([])
    expect(screen.has('HANAMII のプロジェクトIDが記録に無いため、ここからは削除できません。')).toBe(true)
  })

  it('★★ 公開の記録を読めない: 確認も main も出さず、読めなかったと言う（「消すものが無い」と取り違えない）', async () => {
    published()
    const screen = open()
    await settle()
    world.api.fs.readFile = async () => { throw new Error('EIO: 読めません') }
    await press(screen)

    expect(confirmButton(screen)).toBeUndefined()
    expect(teardownCalls()).toEqual([])
    expect(screen.has('破棄するものの記録を読めませんでした: EIO: 読めません')).toBe(true)
    expect(screen.has('記録が無いため')).toBe(false)
  })

  it('★★ main の呼び出しが例外で終わった: 「エラーが発生しました」と出し、入口は押せるように戻る（破棄中のまま固まらない）', async () => {
    published()
    const screen = open()
    await settle()
    world.api.hanamii.teardown = async () => { throw new Error('通信が切れました') }
    await press(screen)
    confirmButton(screen)!.click()
    await settle()

    expect(screen.count('破棄処理でエラーが発生しました: 通信が切れました')).toBe(1)
    expect(screen.button(ENTRY)?.disabled, '例外のあと入口が押せないまま').toBe(false)
    expect(screen.button('破棄中…'), '例外のあと「破棄中…」のまま').toBeUndefined()
    expect(lastBusy(), '例外のあと窓を閉じる警告が残っている').toEqual([false, '', false, '', '', ''])
  })

  it('★★ その場の結果は、別のプロジェクトの画面に出さない（掟11）。切り替えた直後の一瞬も', async () => {
    published({ tokenId: 'tk-gone' })
    world.metaByDir[DIR_B] = { publish: { hanamii: { workspaceId: 'ws1', name: 'b', projectId: 'prj_B', tokenId: 'tk-recorded' }, targets: {} } }
    const screen = open()
    await settle()
    await press(screen)
    confirmButton(screen)!.click()
    await settle()
    expect(screen.has(HANAMII_KEY_MISSING_MESSAGE), '前提: A の断りが出ている').toBe(true)

    // 切り替えた直後の最初の描き直し（記録を読み直す前。パネルはまだ A の projectId を持っている）でも、A の断りは B に出ない
    screen.rerender({ apiKey: 'k', projectDir: DIR_B, onOpenCredentials: () => {} })
    expect(screen.has(HANAMII_KEY_MISSING_MESSAGE), 'A の断りが B の画面に出ている（切り替えた直後の一瞬）').toBe(false)
    await settle()
    expect(screen.has(HANAMII_KEY_MISSING_MESSAGE), 'A の断りが B の画面に出ている').toBe(false)
  })

  it('★★ 次の破棄を始めると、前のその場の結果は片づく', async () => {
    published({ tokenId: 'tk-gone' })
    const screen = open()
    await settle()
    await press(screen)
    confirmButton(screen)!.click()
    await settle()
    expect(screen.has(HANAMII_KEY_MISSING_MESSAGE), '前提: 断りが出ている').toBe(true)

    // トークンを登録し直してもう一度押す。この回は HANAMII が受け付けただけ（入口の節は残るので、前の断りが片づいたかが見える）
    hanamiiTokens.byId.set('tk-gone', 'tok-gone')
    world.teardownReply = { ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING }
    await press(screen)
    confirmButton(screen)!.click()
    await settle()
    expect(screen.has('⏳ 破棄の途中です'), '前提: 新しい破棄の結果が出ている').toBe(true)
    expect(screen.has(HANAMII_KEY_MISSING_MESSAGE), '新しい破棄を始めたのに、前の断りが残っている').toBe(false)
    expect(world.calls.hanamiiTeardownTokens).toEqual(['tok-gone'])
  })
})

