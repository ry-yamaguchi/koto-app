import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── 公開の記録を読めない回（record-unreadable）と、確かめられなかっただけの回（unconfirmed）: ダイアログが何を描くか ──────────────────────
//   止める理由4つ（走っている操作・公開の記録を読めない・専有型の ID・専有型の保存場所だけ）はどれも、残りの材料（sharedLeftover・placements）を入れても
//   「💾」で始まる段落が0・チェックなし・ボタン不可・赤い ⚠️ の段落がちょうど1つ（止める文と注意の二重にしない）。
//   確かめられなかっただけの回は止めず、弱い注意を1つだけ出す（「削除できません」とは言わない）。
// 押したあとの流れは本物。代役は、材料を読む関数と公開先の破棄だけ（tests/projectDeleteDialogNotices.test.ts と同じ）。道具は tests/projectDeleteDialogHarness.ts。

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  effects: [] as { fn: () => void | (() => void); deps: unknown[] | undefined }[],
  index: 0,
  rendered: [] as { type: unknown; props: any; key: unknown }[],
}))
vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = hooks.index++
    if (hooks.states.length <= i) hooks.states.push(typeof init === 'function' ? (init as () => unknown)() : init)
    return [hooks.states[i], (v: unknown) => { hooks.states[i] = typeof v === 'function' ? (v as (p: unknown) => unknown)(hooks.states[i]) : v }]
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[] | undefined) => { hooks.effects.push({ fn, deps }) },
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (v: unknown) => ({ current: v }),
  default: {},
}))
vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: any, key?: unknown) => { hooks.rendered.push({ type, props, key }); return null }
  return { jsx, jsxs: jsx, Fragment: () => null }
})
vi.mock('react/jsx-dev-runtime', () => {
  const jsxDEV = (type: unknown, props: any, key?: unknown) => { hooks.rendered.push({ type, props, key }); return null }
  return { jsxDEV, Fragment: () => null }
})
const fake = vi.hoisted(() => ({
  facts: { targets: [], unreadable: false, unconfirmed: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null } as any,
  readCalls: [] as string[],
  gate: null as Promise<void> | null,
  teardownCalls: [] as Array<{ dir: string; targets: string[]; ctx: any; opts?: any }>,
  teardownResult: (() => Promise.resolve([])) as () => Promise<any[]>,
}))
vi.mock('../src/renderer/teardown/projectDeleteFacts', () => ({
  readProjectDeleteFacts: async (dir: string) => { fake.readCalls.push(dir); if (fake.gate) await fake.gate; return { ...fake.facts } },
}))
vi.mock('../src/renderer/teardown/projectDelete', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/teardown/projectDelete')>()),
  teardownPublished: async (dir: string, targets: string[], ctx: any, opts?: any) => { fake.teardownCalls.push({ dir, targets, ctx, opts }); return fake.teardownResult() },
}))
const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

import ProjectDeleteResults from '../src/renderer/components/teardown/ProjectDeleteResults'
import { projectDeleteBlockNote, PUBLISH_RECORD_UNREADABLE_NOTE, PUBLISH_RECORD_UNREADABLE_FIX_NOTE, PUBLISH_RECORD_UNCONFIRMED_NOTE } from '../src/renderer/teardown/projectDeletePlan'
import { createDialogHarness } from './projectDeleteDialogHarness'

const { t, api, reset, open, els, paragraphs, mainButton, results, press, withFacts } = createDialogHarness(hooks, fake)
beforeEach(reset)
afterEach(() => {
  expect(api.alerts, 'プロジェクト削除の window.alert・window.confirm は 0 件').toEqual([])
  expect(t.calls.includes('alert') || t.calls.includes('confirm')).toBe(false)
})

const A = { bucket: 'koto-a', prefix: 'projects/a/', shared: false }
const left = (over: Record<string, unknown> = {}) => ({ appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [], ...over })
const withPlacements = left({ placements: [A] })
const k2 = left({ registryName: 'R', registryOrigin: 'adopted', registryUsers: ['other'] }) // 段を足さない残り（借り手のいるレジストリだけ）
const hearts = () => paragraphs().filter(p => p.startsWith('💾 '))
const warnings = () => paragraphs().filter(p => p.startsWith('⚠️ '))
/** 止める理由と、その文。 */
const RUNNING = projectDeleteBlockNote({ reason: 'running', op: '削除', target: 'sakura-apprun' })
const DEDICATED = projectDeleteBlockNote({ reason: 'dedicated' })
const STORAGE_ONLY = projectDeleteBlockNote({ reason: 'dedicated-storage-leftover', buckets: ['koto-a'] })
/** 記録を読めない回の止める文は、止める文のすぐ後ろに直し方を続けた1つの段落。 */
const RECORD_UNREADABLE = `${PUBLISH_RECORD_UNREADABLE_NOTE}${PUBLISH_RECORD_UNREADABLE_FIX_NOTE}`

describe('止める理由4つすべて: 「💾」の段落0・チェック0・ボタン不可・赤い ⚠️ の段落がちょうど1つ', () => {
  const refusals: Array<{ name: string; facts: Record<string, unknown>; says: string }> = [
    { name: '走っている操作（running）', facts: { running: { op: '削除', target: 'sakura-apprun' } }, says: RUNNING },
    { name: '専有型の ID が残る（dedicated）', facts: { dedicated: { clusterID: 'c1' } }, says: DEDICATED },
    { name: '専有型の保存場所だけが残る（dedicated-storage-leftover）', facts: { dedicated: { storageLeftoverBucket: 'koto-a' } }, says: STORAGE_ONLY },
    { name: '公開の記録を読めない（record-unreadable。公開先の行なし）', facts: { unreadable: true }, says: RECORD_UNREADABLE },
    { name: '公開の記録を読めない（record-unreadable。HANAMII・共用型の行が読めた回＝state.json だけ壊れた形）', facts: { unreadable: true, targets: ['hanamii', 'sakura-apprun'] }, says: RECORD_UNREADABLE },
  ]

  for (const r of refusals) {
    for (const [what, sharedLeftover] of [['保存場所の残り', withPlacements], ['借り手のいるレジストリだけの残り', k2]] as const) {
      it(`★★★ ${r.name} × ${what}`, async () => {
        withFacts({ ...r.facts, placements: [A], sharedLeftover }); await open()
        expect(hearts()).toEqual([])
        expect(warnings(), '赤い ⚠️ の段落は止める文の1つだけ（止める文と注意を二重にしない）').toEqual([`⚠️ ${r.says}`])
        expect(els('input')).toHaveLength(0)
        expect(mainButton().props.disabled).toBe(true)
        await press() // 押せないので、押しても何も起きない（破棄も移す操作も走らせない）
        expect(fake.teardownCalls).toEqual([])
        expect(t.trashed).toEqual([])
        expect(t.calls).toEqual([])
        expect(results(), '押せないので、結果の欄も出ない（押したあとの流れに入らない）').toBeUndefined()
      })
    }
  }

  it('★★★ 対照（変異: 止めない側へ戻す）: 止めない・読める回は、今までどおり 💾 を1つ言い、ボタンは押せる。読める HANAMII の行はチェックつき', async () => {
    withFacts({ placements: [A], sharedLeftover: k2 }); await open()
    expect(hearts()).toEqual(['💾 コンテナレジストリ『R』も残ります。'])
    expect(warnings()).toEqual([])
    expect(mainButton().props.disabled).toBe(false)
    withFacts({ targets: ['hanamii'], placements: [A], sharedLeftover: null }); await open()
    expect(els('input')).toHaveLength(1)
    expect(mainButton().props.disabled).toBe(false)
    expect(warnings()).toEqual([])
  })

  it('★★ 止める理由が重なっても、止める文は1つ: 走っている操作と記録を読めない回は running の文だけ。記録を読めない回の専有型の ID は record の文だけ', async () => {
    withFacts({ running: { op: '削除', target: 'sakura-apprun' }, unreadable: true, targets: ['hanamii'] }); await open()
    expect(warnings()).toEqual([`⚠️ ${RUNNING}`])
    withFacts({ unreadable: true, dedicated: { clusterID: 'c1' }, targets: ['sakura-apprun-dedicated'] }); await open()
    expect(warnings()).toEqual([`⚠️ ${RECORD_UNREADABLE}`])
  })
})

describe('結果の欄の blocked の枝: 止める理由すべての文を描く（undefined を出さない）。赤い箱が同じ文を出しているときは重ねない', () => {
  const RUNS = [
    { reason: 'running', op: '削除', target: 'sakura-apprun' }, { reason: 'record-unreadable' }, { reason: 'dedicated' }, { reason: 'dedicated-storage-leftover', buckets: ['koto-a'] },
  ] as const
  const render = (block: (typeof RUNS)[number], showBlockNote: boolean) => {
    hooks.rendered = []
    ProjectDeleteResults({ run: { phase: 'blocked', block: block as any, steps: [] }, showBlockNote })
    return paragraphs()
  }

  it.each(RUNS)('★★★ %j: 「⚠️ 」＋止める文が1つ。showBlockNote が偽なら描かない', (block) => {
    const note = projectDeleteBlockNote(block as any)
    expect(render(block, true)).toEqual([`⚠️ ${note}`])
    expect(render(block, true).join('')).not.toContain('undefined')
    expect(render(block, false)).toEqual([])
  })

  it('★★★ 記録を読めない回の赤い段落は、ダイアログと結果欄（blocked）で同じ1つの文: 止める文のすぐ後ろに直し方が続く（文は書き下して固定）', async () => {
    const SAID = '公開の記録（.sakuraide.json・.sakura-cloud/）を読めないため、削除できません。記録を直してから、もう一度削除してください。'
      + 'Koto でこのプロジェクトを開き、ファイル一覧の 👁 で隠しファイルを表示すると、そのファイルを開いて直せます。直したら、この画面を開き直してください。'
    expect(RECORD_UNREADABLE).toBe(SAID)
    withFacts({ unreadable: true }); await open()
    expect(warnings(), 'ダイアログの赤い ⚠️ の段落は1つだけ').toEqual([`⚠️ ${SAID}`])
    expect(render({ reason: 'record-unreadable' }, true), '結果欄（blocked）も同じ文').toEqual([`⚠️ ${SAID}`])
    // 止める文そのもの（0.6.24 から変えない文）は、続きの前でそのまま言う
    expect(SAID.startsWith(PUBLISH_RECORD_UNREADABLE_NOTE)).toBe(true)
    expect(SAID.slice(PUBLISH_RECORD_UNREADABLE_NOTE.length)).toBe(PUBLISH_RECORD_UNREADABLE_FIX_NOTE)
  })
})

describe('確かめられなかっただけの回（unconfirmed）: 止めず、弱い注意を1つだけ出す', () => {
  it('★★★ 公開先も残りも無い回でも、箱ごと出る（外枠の条件）。弱い注意が1つ・「削除できません」を含まない・ボタンは押せる・チェックは出ない', async () => {
    withFacts({ unconfirmed: true }); await open()
    expect(warnings()).toEqual([`⚠️ ${PUBLISH_RECORD_UNCONFIRMED_NOTE}`])
    expect(warnings().join('')).not.toContain('削除できません')
    expect(mainButton().props.disabled).toBe(false)
    expect(els('input')).toHaveLength(0)
    const weak = els('p').find(el => String(el.props.className).includes('brand-yellow'))
    expect(weak, '弱い注意は黄色（赤い止める文と色を分ける）').toBeDefined()
    expect(String(weak!.props.className)).not.toContain('brand-red')
  })

  it('★★★ 公開先があれば、弱い注意とチェックが並ぶ。押すと破棄が走る（止めない）', async () => {
    withFacts({ unconfirmed: true, targets: ['hanamii'] }); await open()
    expect(warnings()).toEqual([`⚠️ ${PUBLISH_RECORD_UNCONFIRMED_NOTE}`])
    expect(els('input')).toHaveLength(1)
    expect(mainButton().props.disabled).toBe(false)
    fake.teardownResult = async () => [{ target: 'hanamii', kind: 'done', view: { warnings: [] }, words: {} }]
    await press()
    expect(fake.teardownCalls.map(c => c.targets)).toEqual([['hanamii']])
  })

  it('★★★ 対照（変異: catch を unreadable に戻す）: 公開の記録を読めない回は止める文だけ。弱い注意は出ない（unconfirmed が同時に立っていても）', async () => {
    withFacts({ unreadable: true, unconfirmed: true }); await open()
    expect(warnings()).toEqual([`⚠️ ${RECORD_UNREADABLE}`])
    expect(paragraphs().some(p => p.includes('確かめられませんでした'))).toBe(false)
    expect(mainButton().props.disabled).toBe(true)
  })

  it('★★ 止める理由（走っている操作）がある回は、弱い注意を重ねない。止める文だけ', async () => {
    withFacts({ unconfirmed: true, running: { op: '削除', target: 'sakura-apprun' } }); await open()
    expect(warnings()).toEqual([`⚠️ ${RUNNING}`])
  })

  it('★★ 何も無い回（unconfirmed も unreadable も偽）は、注意を出さない（偽の注意を出さない）', async () => {
    withFacts({}); await open()
    expect(warnings()).toEqual([])
    expect(mainButton().props.disabled).toBe(false)
  })
})
