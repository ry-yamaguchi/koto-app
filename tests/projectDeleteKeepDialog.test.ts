import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// ── 削除の画面: 保存場所が全部「消さずに残す」（keep）回を、ダイアログが言い、走らせる（react の小さな代役の上で動かす。tests/projectDeleteLeftoverDialog.test.ts と同じ道具）──────────────
// 純関数（門・文）は tests/projectDeleteKeepPlan.test.ts、実フォルダ・本物の main に流す試験は tests/projectDeleteKeepRun.test.ts。ここは**ダイアログがそれらを配線している**ことを見る。
//   ・全部 keep: チェックも段も無く、赤い箱の 💾（leftoverNote の経路）が「残ります」と理由を言い、「データも削除します」は出ない。押すと確認も破棄も無く、フォルダを移す口だけが1回
//   ・混在: チェックと段が出て、💾 の行（leftoverLine の経路）は消す保存場所と残す保存場所を言い分ける
//   ・HANAMII の行の 💾（rowNotes の経路）・外したときの 💾・Vercel の案内（保存場所が全部 keep なら「残ります」を言う）
// 材料を読む関数と、公開先の破棄（teardownPublished）は代役。判断（plan）と押したあとの流れは本物。

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

import ManualTeardownNote from '../src/renderer/components/teardown/ManualTeardownNote'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { createDialogHarness } from './projectDeleteDialogHarness'

const { t, reset, rerender, open, els, textOf, paragraphs, mainButton, checkbox, press, withFacts } = createDialogHarness(hooks, fake)
beforeEach(reset)

const KEEP = { risk: 'twin', folders: ['copy'] }
const A = { bucket: 'koto-a', prefix: 'p', shared: false, keep: KEEP }
const B = { bucket: 'koto-b', prefix: 'p', shared: false }
const left = (over: Record<string, unknown> = {}) => ({ appNames: [] as string[], registryName: null as string | null, registryOrigin: 'unknown', registryUsers: [] as string[], placements: [] as unknown[], ...over })
const KEPT_LINE = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『copy』も同じデータを使っています。'
const REMOVE_B = '保存場所『koto-b』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。残るものが無ければ、保存場所そのものも削除して月額を止めます。'
const lines = () => paragraphs().filter(p => p.startsWith('💾 '))
const noteProp = () => els(ManualTeardownNote).map(el => el.props.storageTornDown)
const uncheck = () => { checkbox().props.onChange({ target: { checked: false } }); rerender() }

describe('全部 keep（R4 の形）: 段もチェックも無く、赤い箱が「残ります」と理由を言う。押すとフォルダだけ移る', () => {
  it('★★★ 赤い箱に 💾 が1つ（leftoverNote の経路）。「データも削除します」は出ない。チェック（input）は無い', async () => {
    withFacts({ targets: [], placements: [A], sharedLeftover: left({ placements: [A] }) } as any); await open()
    expect(lines()).toEqual([`💾 ${KEPT_LINE}`])
    expect(paragraphs().some(p => p.includes('データも削除します'))).toBe(false)
    expect(els('input')).toEqual([])
    expect(paragraphs().some(p => p.includes('一緒に破棄する'))).toBe(false)
  })

  it('★★★ ボタンは押せる。押すと、破棄の関数（teardownPublished）0回・確認0回で、フォルダを移す口が1回（skippedForTwins は空）。結果の欄は描かない', async () => {
    withFacts({ targets: [], placements: [A], sharedLeftover: left({ placements: [A] }) } as any); await open()
    expect(mainButton().props.disabled).toBe(false)
    await press()
    expect(fake.teardownCalls).toEqual([])
    expect(t.calls).toEqual(['runningOp', 'exists', 'trash', 'deleted', 'close'])
    expect(t.trashed).toEqual(['/tmp/ws/proj-a'])
    expect(t.trashOpts).toEqual([{ confirmed: true, skippedForTwins: [] }])
  })

  it('★★ 理由が確かめられなかった（unread）も同じ形で言う', async () => {
    const U = { ...A, keep: { risk: 'unread', folders: [] } }
    withFacts({ targets: [], placements: [U], sharedLeftover: left({ placements: [U] }) } as any); await open()
    expect(lines()).toEqual(['💾 保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。'])
    expect(els('input')).toEqual([])
  })

  it('★★★ 対照: keep が付かない（読めなかった）回は、今までどおりチェックと段が出て、💾 は「データも削除します」', async () => {
    const plain = { bucket: 'koto-a', prefix: 'p', shared: false }
    withFacts({ targets: [], placements: [plain], sharedLeftover: left({ placements: [plain] }) } as any); await open()
    expect(els('input')).toHaveLength(1)
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toContain('にある、このプロジェクトのデータも削除します。')
  })
})

describe('混在: チェックと段が出て、💾 の行は消す保存場所と残す保存場所を言い分ける（leftoverLine の経路）', () => {
  it('★★★ チェックがオン: 💾 は1行で、消す B の文のあとに、残す A の文。A を「削除します」と言わない。ボタンは破棄を呼ぶ（残りの段の印つき）', async () => {
    withFacts({ targets: [], placements: [A, B], sharedLeftover: left({ placements: [A, B] }) } as any); await open()
    expect(els('input')).toHaveLength(1)
    expect(lines()).toEqual([`💾 ${REMOVE_B}${KEPT_LINE}`])
    expect(paragraphs().some(p => p.includes('保存場所『koto-a』にある、このプロジェクトのデータも削除します。'))).toBe(false)
    await press()
    expect(fake.teardownCalls.map(c => ({ targets: c.targets, opts: c.opts }))).toEqual([{ targets: ['sakura-apprun'], opts: { leftover: { noun: '保存場所' } } }])
  })

  it('★★ チェックを外すと、外したときの 💾（keptNote の経路）が、全部の保存場所が残ることを今の文で言う（keep の理由は言わない）', async () => {
    withFacts({ targets: [], placements: [A, B], sharedLeftover: left({ placements: [A, B] }) } as any); await open()
    uncheck()
    expect(lines()).toEqual(['💾 保存場所「koto-a・koto-b」とその中のデータは残ります（消すまで1つにつき月額495円・税込が続きます）。'])
  })
})

describe('HANAMII の行の 💾（rowNotes の経路）と Vercel の案内', () => {
  it('★★★ HANAMII の行・保存場所が keep: 💾 は「HANAMII: 残ります…」の1行だけ（赤い箱の注意で同じ保存場所を言い直さない）。「データも削除します」は出ない', async () => {
    withFacts({ targets: ['hanamii'], placements: [A], sharedLeftover: left({ placements: [A] }) } as any); await open()
    expect(lines()).toEqual([`💾 ${PUBLISH_TARGET_LABEL['hanamii']}: ${KEPT_LINE}`])
    expect(paragraphs().some(p => p.includes('データも削除します'))).toBe(false)
  })

  it('★★ 同じ回でチェックを外すと、外したときの 💾 が1行だけ（公開先の行は消える）。レジストリが残る回は、保存場所は公開先の行・レジストリは赤い箱の注意が言う', async () => {
    withFacts({ targets: ['hanamii'], placements: [A], sharedLeftover: left({ placements: [A] }) } as any); await open()
    uncheck()
    expect(lines()).toEqual(['💾 保存場所「koto-a」とその中のデータは残ります（消すまで月額495円・税込が続きます）。'])
    // 借り手のいるレジストリ（段を足さない）が加わる回: 保存場所は公開先の行、レジストリは赤い箱の注意が言う
    withFacts({ targets: ['hanamii'], placements: [A], sharedLeftover: left({ placements: [A], registryName: 'reg', registryOrigin: 'adopted', registryUsers: ['other'] }) } as any); await open()
    expect(lines()).toEqual([`💾 ${PUBLISH_TARGET_LABEL['hanamii']}: ${KEPT_LINE}`, '💾 コンテナレジストリ『reg』も残ります。'])
  })

  it('★★★ Vercel の行・保存場所が全部 keep・数えるレジストリあり（段は足される）: 保存場所は残るので、案内の最後の文を言う（storageTornDown は偽）。keep の無い回は真', async () => {
    withFacts({ targets: ['vercel'], placements: [A], sharedLeftover: left({ placements: [A], registryName: 'reg', registryOrigin: 'owned' }) } as any); await open()
    expect(noteProp()).toEqual([false])
    withFacts({ targets: ['vercel'], placements: [B], sharedLeftover: left({ placements: [B], registryName: 'reg', registryOrigin: 'owned' }) } as any); await open()
    expect(noteProp()).toEqual([true])
  })
})
