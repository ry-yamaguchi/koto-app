import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── 【公開】(HanamiiPanel) の「🗑 この公開を破棄する」(H1) が、何も消さないと分かっている回を受け取る ────────────────────────────
// HANAMII のプロジェクトが前回の破棄で消えていて、保存場所だけが残り、その保存場所が全部「消さずに残す」（cloud:twinFacts の答え）の回。
// 流れは確認も main も窓を閉じる警告も出さず、結果「⚠️ 破棄していません」を返す。この節は、その結果を**消えた状態にしない**:
// main が走っていないので、プロジェクトの記録（projectId・公開の記録）は残っている。「消えた」表示にすると、入口の 🗑 が消え、記録が残るのに押す場所が無くなる。
// 偽の React の上で HanamiiPanel を動かして固定する（偽の main は本物の記録・鍵の上。tests/ops-hanamiiVercel-harness.ts。パネルの取り付けは tests/hanamiiSectionHarness.ts）。
// 変異: 何も消さない回も onTornDown を呼ぶ／何も消さない回の結果を出さない。

vi.mock('react', async () => (await import('./ops-hanamiiVercel-harness')).reactModule)
vi.mock('react/jsx-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxRuntimeModule)
vi.mock('react/jsx-dev-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxDevRuntimeModule)
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AccessKeySection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/CredentialsModal', async () => (await import('./ops-hanamiiVercel-harness')).hanamiiCredentialsModalMock)

import { settle, type World } from './ops-hanamiiVercel-harness'
import { createSectionHarness, confirmButton, PROJECT_ID, ENTRY, A } from './hanamiiSectionHarness'

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const h = createSectionHarness()
const { open, published, press, teardownCalls } = h
let world: World
let twinFactsCalls = 0
/** cloud:twinFacts の偽の答え。渡された保存場所を、全件「複製がいる」（keep: twin）にして返す。 */
const allTwin = async (_dir: string, args: { placements: Array<{ bucket: string; prefix: string }> }) => {
  twinFactsCalls++
  return { ok: true, refusal: null, placements: args.placements.map(p => ({ ...p, keep: { risk: 'twin', folders: ['myapp copy'] } })) }
}
beforeEach(() => {
  world = h.setup()
  twinFactsCalls = 0
  world.placementReply = { ok: true, placement: A, placements: [A] }
  ;(world.api as any).cloud = { twinFacts: allTwin }
})
afterEach(() => { h.cleanup() })

describe('H1: 保存場所だけが残り、全件 keep の回は、確認なし・main なし。結果を出し、消えた状態にしない', () => {
  it('★★★ 確認が出ない。main へも窓を閉じる警告へも出ない。結果「⚠️ 破棄していません」と残した行が出て、入口の 🗑 は残り、記録（projectId）も残る', async () => {
    published({ storageLeftoverBuckets: [A.bucket] })
    const screen = open()
    await settle()
    await press(screen)

    expect(twinFactsCalls, '前提: keep を読んだ').toBeGreaterThan(0)
    expect(screen.has('⚠️ HANAMII の公開を破棄します'), '確認が出た').toBe(false)
    expect(screen.has('保存場所は残ります'), '何も消さない確認が出た').toBe(false)
    expect(confirmButton(screen), '確認の「破棄する」がある').toBeUndefined()
    expect(teardownCalls(), 'main へ出た').toEqual([])
    expect(world.calls.setBusy, '窓を閉じる警告へ載った').toEqual([])
    expect(world.calls.hanamiiTeardownTokens, 'トークンを読んで main を呼んだ').toEqual([])

    expect(screen.has('⚠️ 破棄していません'), '結果の見出しが出ていない').toBe(true)
    expect(screen.has('✅ 破棄しました'), '何も消していないのに「破棄しました」と言った').toBe(false)
    expect(screen.has(`保存場所『${A.bucket}』のデータは残しました — フォルダ『myapp copy』も同じデータを使っています。`)).toBe(true)
    expect(screen.has('月額495円（税込）'), '月額の警告（お金を削らない）').toBe(true)

    // 消えた状態にしない: 入口の 🗑 は押せるまま残り、記録（projectId）も消えていない
    expect(screen.button(ENTRY), '入口の 🗑 が消えた（消えた状態にした）').toBeDefined()
    expect(world.meta.publish.hanamii.projectId).toBe(PROJECT_ID)
  })

  it('★★ 対照: 複製がいなければ（keep が付かない）、今までどおり確認が出る', async () => {
    ;(world.api as any).cloud = { twinFacts: async (_d: string, args: { placements: Array<{ bucket: string; prefix: string }> }) => ({ ok: true, refusal: null, placements: args.placements.map(p => ({ ...p, keep: null })) }) }
    published({ storageLeftoverBuckets: [A.bucket] })
    const screen = open()
    await settle()
    await press(screen)

    expect(confirmButton(screen), '確認が出ていない').toBeDefined()
    expect(screen.has('⚠️ 破棄していません')).toBe(false)
    expect(teardownCalls()).toEqual([])
  })
})
