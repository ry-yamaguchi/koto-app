import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 【公開】(HanamiiPanel) の「🗑 この公開を破棄する」(H1) その2: 切り替え・結果の出方・構造。段階1の1c ─────────────
// その1（確認と、記録が作られない断り）は tests/hanamiiTeardownSection.test.ts。パネルの取り付けは tests/hanamiiSectionHarness.ts。
//
// 見ること:
//   ・切り替え・やり直しでも、表示が混ざらない（掟11）
//   ・受付済み（HANAMII が削除を受け付けただけ）の結果の見え方。破棄を始めると前の表示（公開の結果・公開の失敗）は片づく
//   ・構造: 入口が流れを通る。仕様書の invoke・main の IPC を直接呼ばない。直す前の形が戻らない

vi.mock('react', async () => (await import('./ops-hanamiiVercel-harness')).reactModule)
vi.mock('react/jsx-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxRuntimeModule)
vi.mock('react/jsx-dev-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxDevRuntimeModule)
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AccessKeySection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/CredentialsModal', async () => (await import('./ops-hanamiiVercel-harness')).hanamiiCredentialsModalMock)

import { deferred, settle, type World } from './ops-hanamiiVercel-harness'
import {
  createSectionHarness, confirmButton, DIR, DIR_B, PROJECT_ID, ENTRY,
} from './hanamiiSectionHarness'
import { HANAMII_DELETION_ACCEPTED_WARNING, TEARDOWN_IN_PROGRESS_WARNING_HEAD } from '../src/shared/teardownResult'

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const h = createSectionHarness()
const { open, published, press, teardownCalls } = h
let world: World
beforeEach(() => { world = h.setup() })
afterEach(() => { h.cleanup() })

describe('H1: 切り替え・やり直しでも、表示が混ざらない（掟11）', () => {
  it('★★ 前のプロジェクトの破棄が終わっても、いまのプロジェクトの「破棄中」は下ろさない', async () => {
    published()
    world.metaByDir[DIR_B] = { publish: { hanamii: { workspaceId: 'ws1', name: 'b', projectId: 'prj_B', tokenId: 'tk-recorded' }, targets: {} } }
    const screen = open(DIR)
    await settle()
    // 画面は main の記録を待たず、自分の印（破棄中）だけで「破棄中」を知っている状況にする
    world.mutePush = true
    world.opGateByDir[DIR] = deferred()
    world.opGateByDir[DIR_B] = deferred()
    await press(screen)
    confirmButton(screen)!.click()
    await settle()                                      // A の破棄が main で止まっている
    screen.rerender({ apiKey: 'k', projectDir: DIR_B, onOpenCredentials: () => {} })
    await settle()
    await press(screen)
    confirmButton(screen)!.click()
    await settle()                                      // B の破棄も main で止まっている
    expect(teardownCalls()).toEqual([[PROJECT_ID, DIR], ['prj_B', DIR_B]])
    expect(screen.button(ENTRY)?.disabled, '前提: B の破棄が走っている').toBe(true)

    world.opGateByDir[DIR].resolve()
    await settle()                                      // A の破棄だけが終わる
    expect(screen.button(ENTRY)?.disabled, 'A の破棄が終わっただけで、B の「破棄中」が下りた').toBe(true)
    expect(screen.button('破棄中…'), 'A の破棄が終わっただけで、B の公開の「破棄中…」が消えた').toBeDefined()

    world.opGateByDir[DIR_B].resolve()
    await settle()
  })

  it('★★ 破棄を一度終えたあとの断り（消すものが記録に無い）も、その場の結果欄に出る（前の破棄の記録を、この断りの記録と取り違えない）', async () => {
    published()
    world.teardownReply = { ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING }
    const screen = open()
    await settle()
    await press(screen)
    confirmButton(screen)!.click()
    await settle()
    expect(screen.has('⏳ 破棄の途中です'), '前提: 1回目の破棄の記録が出ている').toBe(true)

    world.meta.publish.hanamii.projectId = null          // 別の窓が片づけて、記録の projectId が消えた
    await press(screen)
    expect(confirmButton(screen)).toBeUndefined()
    expect(screen.has('HANAMII のプロジェクトIDが記録に無いため、ここからは削除できません。'), '断りが出ていない（前の破棄の記録を、この断りの記録と取り違えている）').toBe(true)
    expect(teardownCalls()).toHaveLength(1)
  })
})

describe('H1: 結果は main の記録から出る（閉じて開き直しても同じ）', () => {
  it('★★★ HANAMII が削除を受け付けただけ（deletionAccepted）: 「途中」と出して文は1回だけ。専有型の「待ち切れずに止まりました」は出さない。入口と公開の記録は残す', async () => {
    published()
    world.teardownReply = { ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING }
    const screen = open()
    await settle()
    await press(screen)
    confirmButton(screen)!.click()
    await settle()

    expect(screen.has('⏳ 破棄の途中です')).toBe(true)
    expect(screen.count(HANAMII_DELETION_ACCEPTED_WARNING), '受付済みの文が出ていない／二重に出ている（message と警告は同じ文）').toBe(1)
    expect(screen.has(TEARDOWN_IN_PROGRESS_WARNING_HEAD), '専有型の「待ち切れずに止まりました」を HANAMII の受付済みに出している').toBe(false)
    expect(screen.has('✅ 破棄しました')).toBe(false)
    // 押し直せる（削除が済んでいれば先へ進む）。行・projectId は残す
    expect(screen.button(ENTRY), '受付済みなのに入口が消えている').toBeDefined()
    expect(screen.button(ENTRY)?.disabled).toBe(false)
    expect(world.calls.forgetTarget).toEqual([])
    expect(world.meta.publish.hanamii.projectId).toBe(PROJECT_ID)
  })

  it('★★ 破棄を始めると、前の公開の結果は片づく（破棄の結果の下に、前の「公開できました」が並ばない）', async () => {
    published()
    world.publishReply = { ok: true, projectId: PROJECT_ID, deploymentId: 'dpl_test1', deployState: 'ready', readyState: 'READY', url: 'https://app-test.example.test' }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.has('✅ 公開できました。'), '前提: 公開の結果が出ている').toBe(true)

    await press(screen)
    world.opGate = deferred()
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    confirmButton(screen)!.click()
    await settle()
    expect(screen.has('✅ 公開できました。'), '破棄を始めたのに、前の公開の結果が残っている').toBe(false)
    world.opGate.resolve()
    await settle()
  })
})

describe('H1: 破棄を始めたとき、前の表示を片づける', () => {
  it('★ 公開が断られた理由（msg 欄）は、破棄を始めると片づく', async () => {
    published()
    const screen = open()
    await settle()
    // 画面が知らないうちに別の操作が走り始めた（押し出しを止めて作る）。公開は main に断られ、理由が msg 欄に出る
    world.mutePush = true
    world.opGate = deferred()
    const other = world.api.vercel.publish(DIR, { token: 'tok', name: 'app' })
    await settle()
    screen.button('🚀 公開する（更新）')!.click()
    await settle()
    expect(screen.has('いま別の操作（公開）を実行中です'), '前提: 公開が断られた理由が出ている').toBe(true)
    world.mutePush = false                            // 別の操作が終わったことは、画面に届く
    world.opGate.resolve()
    await other
    await settle()
    world.opGate = null

    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    await press(screen)
    confirmButton(screen)!.click()
    await settle()
    expect(screen.has('いま別の操作（公開）を実行中です'), '破棄を始めたのに、前の公開の失敗の知らせが残っている').toBe(false)
    expect(teardownCalls()).toEqual([[PROJECT_ID, DIR]])
  })
})

describe('H1: 入口は共通の流れを通る。直す前の形が戻らない（構造）', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8')
  /** コメントを除いたコード（コメントの引用に当たらない）。 */
  const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const SECTION = 'src/renderer/components/HanamiiTeardownSection.tsx'
  const PANEL = 'src/renderer/components/HanamiiPanel.tsx'

  it('★★★ 節は共通の流れを、手本どおりの形で呼ぶ。仕様書の invoke も main の IPC も直接は呼ばない', () => {
    const s = code(SECTION)
    expect(s).toContain('runTeardownFlow(projectDir, hanamiiTeardownSpec, electronFlowDeps(projectDir, hanamiiTeardownSpec, {')
    // 仕様書の invoke を呼ぶのは flow.ts だけ（入口が迂回すると、確認・窓を閉じる警告・キーなしの失敗を飛ばせる）
    expect(s, '節が invoke を直接呼んでいる').not.toContain('.invoke(')
    expect(s).not.toContain('hanamiiTeardownSpec.invoke')
    expect(s, '節が main の IPC を直接呼んでいる').not.toContain('hanamii.teardown(')
    expect(s, '節が確認を飛ばす（confirm を渡している）').toContain('        confirm,\n')
    // 画面は公開の記録を消さない（消すのは main の1か所）
    for (const bad of ['clearPublishRecord', 'forgetTarget', 'forgetPublishTarget', 'publishMeta', 'mergeProjectMeta']) {
      expect(s, `節が公開の記録に触れている: ${bad}`).not.toContain(bad)
    }
  })

  it('★★ 直す前の形が、パネルにも節にも残っていない', () => {
    for (const f of [PANEL, SECTION]) {
      const c = code(f)
      expect(c, `${f}: 旧い確認の枠`).not.toContain('setConfirmDel(')
      expect(c, `${f}: 旧い確認の枠の状態`).not.toContain('confirmDel')
      expect(c, `${f}: 直す前の呼び形`).not.toContain('window.electronAPI.hanamii.teardown(')
      expect(c, `${f}: 直す前の確認の文`).not.toContain('この公開を破棄（削除）します。公開URLは無効になります。')
    }
    const p = code(PANEL)
    expect(p, '破棄の本体がパネルに残っている').not.toContain('const teardown = async')
    expect(p, '確認の💾の文をパネルが作っている（流れが作る）').not.toContain('teardownDataNoteForAll(')
    expect(p, '保存場所の全件をパネルが抱えている（確認は押した時点に流れが読む）').not.toContain('setPlacements')
    expect(p, '破棄の種類を立てている（msg 欄は公開の失敗だけ）').not.toContain('setMsgKind')
  })

  it('★★ パネルは節を置き、破棄の記録は節の結果の部品で描く。破棄の枝をパネルに残さない', () => {
    const p = code(PANEL)
    expect(p).toContain('<HanamiiTeardownSection')
    expect(p).toContain('locked={teardownLocked}')
    expect(p).toContain('onStart={() => { setMsg(\'\'); setMsgDetail(\'\'); setMsgOk(false); setTearingDown(true); ops.clearShown() }}')
    expect(p).toContain('onFinished={() => setTearingDown(false)}')
    expect(p).toContain('onTornDown={showTornDown}')
    // HanamiiOpResult は、先頭で削除の記録を節の部品へ渡す（公開の枝は変えない）
    const at = p.indexOf('function HanamiiOpResult(')
    expect(at).toBeGreaterThan(-1)
    const body = p.slice(at)
    expect(body.slice(0, 400)).toContain("if (rec.op === '削除') return <HanamiiTeardownResult rec={rec} />")
    expect(body, '破棄の枝がパネルの結果の部品に残っている').not.toContain('isDelete')
    expect(body).not.toContain("'✅ 破棄しました。'")
    // 節は記録の結果を共通の読み手に通す
    expect(code(SECTION)).toContain("resumedTeardownView('hanamii', rec.result)")
  })

  it('★★ 新しい節は 400 行以下。パネルは破棄の節の分だけ短くなった（直す前は1,188行）', () => {
    expect(read(SECTION).split('\n').length).toBeLessThanOrEqual(400)
    expect(read(PANEL).split('\n').length).toBeLessThan(1188)
  })

  it('★★ 画面に出る文に Markdown 記法を混ぜない（節のコードに ** が無い）', () => {
    const lines = code(SECTION).split('\n').filter(l => l.includes('**'))
    expect(lines, `画面に ** がそのまま出る: ${lines.join(' / ')}`).toEqual([])
  })
})
