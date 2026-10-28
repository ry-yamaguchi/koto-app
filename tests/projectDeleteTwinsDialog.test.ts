import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── T-I6（画面）: プロジェクトの削除ダイアログが、複製のある公開先を「破棄しません」と見せ、破棄せずにフォルダだけ移す（0.6.24 I-3・作者の決定 K1）──────
// react の小さな代役の上で本物のダイアログを動かし、**何を描いたか**と、**呼ばれた口の順**で見る（ソースの文字列は読まない）。
// 材料を読む関数（readProjectDeleteFacts）と、公開先の破棄（teardownPublished）は代役。判断（plan）と押したあとの流れ（pressProjectDelete）は本物。
// 道具は tests/projectDeleteDialogHarness.ts（vi.mock と入れ物 hooks・fake はこのファイルの先頭に置く）。判断そのものは tests/projectDeleteTwinsPlan.test.ts。

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
  facts: { targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null, twins: null } as any,
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

import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { projectDeleteBlockNote } from '../src/renderer/teardown/projectDeletePlan'
import { createDialogHarness, DIR } from './projectDeleteDialogHarness'

const { t, api, reset, rerender, open, els, paragraphs, mainButton, checkbox, results, press, failed, done, withFacts } = createDialogHarness(hooks, fake)
beforeEach(reset)
afterEach(() => {
  expect(api.alerts, 'プロジェクト削除の window.alert・window.confirm は 0 件').toEqual([])
})

const NONE = { hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] }
const twins = (over: Record<string, string[]>) => ({ ...NONE, ...over })
const MOVE = ['runningOp', 'exists', 'trash', 'deleted', 'close']
const HANAMII_NOTE = `${PUBLISH_TARGET_LABEL.hanamii}は破棄しません（フォルダ『rc24-h』にも同じ公開の記録があります）。`
const SHARED_NOTE = `${PUBLISH_TARGET_LABEL['sakura-apprun']}は破棄しません（フォルダ『rc24-h』にも同じ公開の記録があります）。`
const DEDICATED_NOTE = `${PUBLISH_TARGET_LABEL['sakura-apprun-dedicated']}は破棄しません（フォルダ『rc24-d』にも同じ公開の記録があります）。`
const hasNote = (note: string) => paragraphs().includes(note)

describe('★★★ 赤い箱: 複製のある公開先は「破棄しません」と言う', () => {
  it('★★★ HANAMII の複製がある: 1行を出す（フォルダ名つき）。破棄するものが無いので、チェックは出ない。押せる', async () => {
    withFacts({ targets: ['hanamii'], twins: twins({ hanamii: ['rc24-h'] }) })
    await open()
    expect(hasNote(HANAMII_NOTE)).toBe(true)
    expect(paragraphs()).toContain('このプロジェクトは公開されています') // 公開されていること自体は言う
    expect(els('input')).toHaveLength(0) // 破棄する公開先が無い
    expect(mainButton().props.disabled).toBe(false)
  })

  it('★★★ HANAMII・共用型の両方に複製がある: 2行（HANAMII が先）。チェックは出ない', async () => {
    withFacts({ targets: ['sakura-apprun', 'hanamii'], twins: twins({ hanamii: ['rc24-h'], 'sakura-apprun': ['rc24-h'] }) })
    await open()
    const notes = paragraphs().filter(p => p.includes('は破棄しません（'))
    expect(notes).toEqual([HANAMII_NOTE, SHARED_NOTE])
    expect(els('input')).toHaveLength(0)
  })

  it('★★★ 複製が無い・読めなかった（twins が null）回は、この行を出さない。チェックは従来どおり出る', async () => {
    for (const tw of [NONE, null]) {
      withFacts({ targets: ['hanamii', 'sakura-apprun'], twins: tw })
      await open()
      expect(paragraphs().some(p => p.includes('は破棄しません（')), JSON.stringify(tw)).toBe(false)
      expect(els('input')).toHaveLength(1)
    }
  })

  it('★★★ 赤い箱は、複製の行だけでも出る（公開先の一覧が空・止める理由が無くても）。専有型の複製だけの回', async () => {
    // 専有型の ID があり（記録は残っている）、公開先の行は無く、複製がある。箱を出す条件が複製の行を数えないと、この行が画面から消える
    withFacts({ targets: [], dedicated: { clusterID: 'cl-1' }, twins: twins({ 'sakura-apprun-dedicated': ['rc24-d'] }) })
    await open()
    expect(hasNote(DEDICATED_NOTE)).toBe(true)
    expect(paragraphs()).not.toContain('このプロジェクトは公開されています')
    expect(mainButton().props.disabled).toBe(false)
  })
})

describe('★★★ 専有型: 複製があれば止めの文が消え、押せる。複製が無い・読めなかった回は止まる', () => {
  const DEDICATED = { applicationID: 'ap-1', clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1' }
  const BLOCK = `⚠️ ${projectDeleteBlockNote({ reason: 'dedicated' })}`

  it('★★★ 複製あり: 止めの文は出ない。複製の行が出て、押せる。押すと破棄は呼ばれず、fs.trashProject が確認の印つきで1回だけ', async () => {
    withFacts({ targets: ['sakura-apprun-dedicated'], dedicated: DEDICATED, twins: twins({ 'sakura-apprun-dedicated': ['rc24-d'] }) })
    await open()
    expect(paragraphs()).not.toContain(BLOCK)
    expect(hasNote(DEDICATED_NOTE)).toBe(true)
    expect(mainButton().props.disabled).toBe(false)
    await press()
    expect(fake.teardownCalls).toEqual([])
    expect(t.calls).toEqual(MOVE)
    expect(t.trashed).toEqual([DIR])
    expect(t.trashOpts).toEqual([{ confirmed: true, skippedForTwins: ['sakura-apprun-dedicated'] }]) // 画面が破棄を外した公開先を main へ渡す（R2-e。main が移す直前に覆う複製を読み直す）
  })

  it('★★★ 複製なし・読めなかった（null）: 止めの文が出て、ボタンは押せず、押しても何も呼ばれない', async () => {
    for (const tw of [NONE, null]) {
      t.calls.length = 0
      withFacts({ targets: ['sakura-apprun-dedicated'], dedicated: DEDICATED, twins: tw })
      await open()
      expect(paragraphs(), JSON.stringify(tw)).toContain(BLOCK)
      expect(mainButton().props.disabled).toBe(true)
      await press()
      expect(t.calls).toEqual([])
      expect(fake.teardownCalls).toEqual([])
    }
  })

  it('★★★ 走っている操作は、専有型の複製があっても止める（running が最優先）。ボタンは押せない', async () => {
    withFacts({ targets: ['sakura-apprun-dedicated'], dedicated: DEDICATED, running: { op: '削除', target: 'sakura-apprun-dedicated' }, twins: twins({ 'sakura-apprun-dedicated': ['rc24-d'] }) })
    await open()
    expect(paragraphs().some(p => p.startsWith('⚠️ いまこのプロジェクトの'))).toBe(true)
    expect(mainButton().props.disabled).toBe(true)
    await press()
    expect(t.calls).toEqual([])
  })
})

describe('★★★ 押す: 複製のある公開先は破棄の要求を出さずに、フォルダだけ移す', () => {
  it('★★★ すべて複製あり: teardown は呼ばれず、走っている操作を聞き直してフォルダを移す → 後始末 → 閉じる。結果の欄は出さない', async () => {
    withFacts({ targets: ['hanamii', 'sakura-apprun'], twins: twins({ hanamii: ['rc24-h'], 'sakura-apprun': ['rc24-h'] }) })
    await open(); await press()
    expect(fake.teardownCalls).toEqual([])
    expect(t.calls).toEqual(MOVE)
    expect(t.trashed).toEqual([DIR])
    expect(results()).toBeUndefined()
  })

  it('★★★ HANAMII だけ複製あり: 共用型だけを破棄に渡す（HANAMII は渡さない）。チェックは出る。HANAMII の行は「破棄しません」', async () => {
    withFacts({ targets: ['hanamii', 'sakura-apprun'], twins: twins({ hanamii: ['rc24-h'] }) })
    fake.teardownResult = async () => [{ target: 'sakura-apprun', kind: 'done', view: { warnings: [] }, words: {} }]
    await open()
    expect(hasNote(HANAMII_NOTE)).toBe(true)
    expect(els('input')).toHaveLength(1)
    // 💾 の行も、破棄する共用型だけ（複製のある HANAMII の「データも消えます」は言わない）
    expect(paragraphs().some(p => p.startsWith('💾') && p.includes(PUBLISH_TARGET_LABEL.hanamii))).toBe(false)
    await press()
    expect(fake.teardownCalls.map(c => c.targets)).toEqual([['sakura-apprun']])
  })

  it('★★★ チェックを外すと、複製のない公開先も破棄せずに移す（従来どおり）。複製の行は変わらず出る', async () => {
    withFacts({ targets: ['hanamii', 'sakura-apprun'], twins: twins({ hanamii: ['rc24-h'] }) })
    await open()
    checkbox().props.onChange({ target: { checked: false } }); rerender()
    expect(hasNote(HANAMII_NOTE)).toBe(true)
    await press()
    expect(fake.teardownCalls).toEqual([])
    expect(t.trashed).toEqual([DIR])
  })

  it('★★★ 複製を読めなかった回（twins が null）: HANAMII も破棄の対象に残る。main が断って failed なら、フォルダは移さない', async () => {
    withFacts({ targets: ['hanamii'], twins: null })
    fake.teardownResult = async () => [failed('hanamii', '🌸 HANAMII: フォルダ『c』にも同じ公開の記録があるため、何も破棄していません。')]
    await open(); await press()
    expect(fake.teardownCalls.map(c => c.targets)).toEqual([['hanamii']])
    expect(t.trashed).toEqual([])
    expect(t.calls).toEqual([])
    expect(results()?.run.phase).toBe('stopped')
  })

  it('★★★ 開いたあとに複製ができた回: 1回目は main が断って止まり、読み直した材料で「破棄しません」の行が出る。2回目は破棄せずにフォルダだけ移す', async () => {
    withFacts({ targets: ['hanamii'], twins: NONE })
    fake.teardownResult = async () => [failed('hanamii', '🌸 HANAMII: フォルダ『rc24-h』にも同じ公開の記録があるため、何も破棄していません。')]
    await open()
    expect(hasNote(HANAMII_NOTE)).toBe(false)
    withFacts({ targets: ['hanamii'], twins: twins({ hanamii: ['rc24-h'] }) }) // 押している間に、複製ができた
    await press()
    expect(fake.teardownCalls).toHaveLength(1)
    expect(results()?.run.phase).toBe('stopped')
    expect(hasNote(HANAMII_NOTE), '読み直した材料で、箱が複製の行に変わる').toBe(true)
    expect(t.trashed).toEqual([])
    await press()
    expect(fake.teardownCalls, '2回目は破棄の要求を出さない').toHaveLength(1)
    expect(t.trashed).toEqual([DIR])
    expect(t.calls.slice(-5)).toEqual(MOVE)
  })
})

// ── 0.6.24 R2-e: main が「覆う複製が見つからなくなった」と断ったら、材料を読み直して赤い箱を描き直す。押し直すと破棄から始める ──────────────────────────
describe('★★★ 複製が消えたあとの最初の押下: main の断りで移さず、材料を読み直す。もう一度押すと破棄から始める', () => {
  const MESSAGE = '同じ公開の記録を持つフォルダが見つからなくなったため、移していません。もう一度「ゴミ箱に移動」を押すと、破棄から始めます。'
  const TRASH = ['runningOp', 'exists', 'trash']

  it('★★★ HANAMII: 開いたときは複製あり → 押す前に複製が消えた → 押す: 移さない・文を出す・赤い箱が破棄の対象に戻る → もう一度押すと破棄 → 済んだら移す', async () => {
    withFacts({ targets: ['hanamii'], twins: twins({ hanamii: ['rc24-h'] }) })
    await open()
    expect(hasNote(HANAMII_NOTE)).toBe(true)
    expect(els('input')).toHaveLength(0)
    // 押す前に複製が消えた（次に読むと、複製は無い）。main は覆う複製が無いと断る
    withFacts({ targets: ['hanamii'], twins: NONE })
    api.trashAnswer = { ok: false, message: MESSAGE, reason: 'twins-gone' }
    const readsBefore = fake.readCalls.length
    await press()
    expect(t.calls).toEqual(TRASH) // 移そうとして断られた。閉じない・後始末もしない
    expect(t.trashOpts).toEqual([{ confirmed: true, skippedForTwins: ['hanamii'] }])
    expect(t.deleted).toEqual([])
    expect(fake.teardownCalls, 'この押下では破棄を始めない（見せてから、もう一度押させる）').toEqual([])
    expect(fake.readCalls.length, '材料を読み直した').toBe(readsBefore + 1)
    expect(results()?.run.phase).toBe('twinsGone')
    expect(results()?.run.message).toBe(MESSAGE)
    // 赤い箱が描き直された: 複製の行は消え、HANAMII は破棄の対象に戻る（チェックが出る）
    expect(hasNote(HANAMII_NOTE)).toBe(false)
    expect(els('input')).toHaveLength(1)
    expect(mainButton().props.disabled).toBe(false)

    // もう一度押す: 読み直した材料で破棄から始め、済んだら移す（外した公開先は無いので空）
    api.trashAnswer = undefined
    t.calls.length = 0
    fake.teardownResult = async () => [done('hanamii')]
    await press()
    expect(fake.teardownCalls.map(c => c.targets)).toEqual([['hanamii']])
    expect(t.trashOpts[1]).toEqual({ confirmed: true, skippedForTwins: [] })
    expect(t.trashed).toEqual([DIR, DIR])
    expect(t.calls).toContain('deleted')
  })

  it('★★★ 専有型: 複製が消えたあとの押下 → 移さない。読み直すと止める理由（専有型が残っている）が出て、ボタンは押せなくなる', async () => {
    const DEDICATED = { applicationID: 'ap-1', clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1' }
    withFacts({ targets: ['sakura-apprun-dedicated'], dedicated: DEDICATED, twins: twins({ 'sakura-apprun-dedicated': ['rc24-d'] }) })
    await open()
    expect(mainButton().props.disabled).toBe(false)
    withFacts({ targets: ['sakura-apprun-dedicated'], dedicated: DEDICATED, twins: NONE })
    api.trashAnswer = { ok: false, message: MESSAGE, reason: 'twins-gone' }
    await press()
    expect(t.trashOpts).toEqual([{ confirmed: true, skippedForTwins: ['sakura-apprun-dedicated'] }])
    expect(t.deleted).toEqual([])
    expect(results()?.run.phase).toBe('twinsGone')
    expect(paragraphs()).toContain(`⚠️ ${projectDeleteBlockNote({ reason: 'dedicated' })}`)
    expect(mainButton().props.disabled).toBe(true)
  })

  it('★★ 対照: ふつうの移せない（reason なし）は、材料を読み直さず、移せなかった文を出す（trashFailed）', async () => {
    withFacts({ targets: ['hanamii'], twins: twins({ hanamii: ['rc24-h'] }) })
    await open()
    api.trashAnswer = { ok: false, message: 'ほかの理由' }
    const readsBefore = fake.readCalls.length
    await press()
    expect(results()?.run.phase).toBe('trashFailed')
    expect(fake.readCalls.length).toBe(readsBefore)
  })
})
