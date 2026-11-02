import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// ── 削除の画面: 専有型の保存場所が全部「消さずに残す」回を、ダイアログが言い、止めずに走らせる（react の小さな代役の上で動かす。tests/projectDeleteKeepDialog.test.ts と同じ道具）──────────────
// 純関数（判断・文）は tests/projectDeleteDedicatedKeptPlan.test.ts、実フォルダ・本物の main に流す試験は tests/trashProjectDedicatedKept.test.ts・tests/dedicatedKeptRealMain.test.ts。ここは**ダイアログがそれらを配線している**ことを見る。
//   ・ふつうの形（共用型の記録を読めた）: 赤い箱の 💾 は既存の「残ります」の1行だけ。保存場所の名前と「残ります」は、それぞれちょうど1回
//   ・共用型の記録を読めなかった回（sharedLeftover が null）: 専有型の 💾 の1行が出る。文は teardownDataNoteForAll の答えそのもの
//   ・ボタンは押せる。押すと確認も破棄も無く、フォルダを移す口だけが1回
//   ・共用型の残りの段（plan.leftover）も立つ回（チェックがオン）: 同じ保存場所を 💾 の2行が重ねて言わない。チェックを外した回も同じ（表で固定）
//   ・止める回（keep の無い保存場所・資源の ID・走っている操作）は、今までどおり止める
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

import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'
import { PUBLISH_RECORD_UNCONFIRMED_NOTE, projectDeleteBlockNote } from '../src/renderer/teardown/projectDeletePlan'
import { FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'
import { teardownDataNoteForAll } from '../src/shared/teardownSupport'
import { createDialogHarness } from './projectDeleteDialogHarness'

const { t, api, reset, rerender, open, els, paragraphs, mainButton, checkbox, results, press, withFacts } = createDialogHarness(hooks, fake)
beforeEach(reset)

const KEEP = { risk: 'twin', folders: ['copy'] }
const A = { bucket: 'koto-a', prefix: 'p', shared: true, keep: KEEP }
const PLAIN = { bucket: 'koto-a', prefix: 'p', shared: true }
const MARK = { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a'] }
const ROW = 'sakura-apprun-dedicated'
const left = (over: Record<string, unknown> = {}) => ({ appNames: [] as string[], registryName: null as string | null, registryOrigin: 'unknown', registryUsers: [] as string[], placements: [] as unknown[], ...over })
const KEPT_LINE = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『copy』も同じデータを使っています。'
const lines = () => paragraphs().filter(p => p.startsWith('💾 '))
const count = (text: string, needle: string) => text.split(needle).length - 1
const uncheck = () => { checkbox().props.onChange({ target: { checked: false } }); rerender() }
const BLOCK_STORAGE = projectDeleteBlockNote({ reason: 'dedicated-storage-leftover', buckets: ['koto-a'] })

describe('★★★ ふつうの形（共用型の記録を読めた）: 赤い箱の 💾 は既存の「残ります」の1行だけ。専有型の行は重ねて言わない', () => {
  it('★★★ 💾 は1行（leftoverNote の経路）。保存場所の名前と「残ります」が、赤い箱の文にちょうど1回ずつ出る', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: left({ placements: [A] }) } as any); await open()
    expect(lines()).toEqual([`💾 ${KEPT_LINE}`])
    const box = lines().join('\n')
    expect(count(box, '『koto-a』'), '保存場所の名前').toBe(1)
    expect(count(box, '残ります'), '「残ります」').toBe(1)
    // 止める文は出ない・「データも削除します」も出ない・チェックは無い
    expect(paragraphs().some(p => p.includes('だけが残っています'))).toBe(false)
    expect(paragraphs().some(p => p.includes('データも削除します'))).toBe(false)
    expect(els('input')).toEqual([])
  })

  it('★★★ ボタンは押せる。押すと、破棄の関数 0回・確認 0回で、フォルダを移す口が1回（skippedForTwins は空）。結果の欄は描かない', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: left({ placements: [A] }) } as any); await open()
    expect(mainButton().props.disabled).toBe(false)
    await press()
    expect(fake.teardownCalls).toEqual([])
    expect(t.calls).toEqual(['runningOp', 'exists', 'trash', 'deleted', 'close'])
    expect(t.trashed).toEqual(['/tmp/ws/proj-a'])
    expect(t.trashOpts).toEqual([{ confirmed: true, skippedForTwins: [] }])
  })

  it('★★ 理由が確かめられなかった（unread）も同じ形。専有型の行が無く、印だけが残る回も同じ', async () => {
    const U = { ...A, keep: { risk: 'unread', folders: [] } }
    const UNREAD_LINE = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。'
    withFacts({ targets: [ROW], dedicated: MARK, placements: [U], sharedLeftover: left({ placements: [U] }) } as any); await open()
    expect(lines()).toEqual([`💾 ${UNREAD_LINE}`])
    withFacts({ targets: [], dedicated: MARK, placements: [A], sharedLeftover: left({ placements: [A] }) } as any); await open()
    expect(lines()).toEqual([`💾 ${KEPT_LINE}`])
    expect(mainButton().props.disabled).toBe(false)
  })
})

describe('★★★ 共用型の記録を読めなかった回など、ほかの行が名指ししない回: 専有型の 💾 の1行が出る', () => {
  it('★★★ sharedLeftover が null（共用型の記録を確かめられなかった）: 専有型の行が1つ。文は teardownDataNoteForAll の答えそのもの。弱い注意も出る。ボタンは押せる', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: null, unconfirmed: true } as any); await open()
    expect(lines()).toEqual([`💾 ${KEPT_LINE}`])
    expect(lines()[0]).toBe(`💾 ${teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', placements: [A] })}`)
    expect(paragraphs()).toContain(`⚠️ ${PUBLISH_RECORD_UNCONFIRMED_NOTE}`)
    expect(count(lines().join('\n'), '『koto-a』')).toBe(1)
    expect(count(lines().join('\n'), '残ります')).toBe(1)
    expect(mainButton().props.disabled).toBe(false)
    expect(els('input')).toEqual([])
  })

  it('★★★ 専有型の行が無く、共用型の記録を読めなかった回も、赤い箱が出て専有型の行が言う（箱を出す条件に足してある）', async () => {
    withFacts({ targets: [], dedicated: MARK, placements: [A], sharedLeftover: null } as any); await open()
    expect(lines()).toEqual([`💾 ${KEPT_LINE}`])
    expect(paragraphs().some(p => p.includes('公開されています'))).toBe(false)
  })

  it('★★ 共用型の記録が別のものしか言わない回（レジストリだけ）は、専有型の行がこの保存場所を言い、レジストリは赤い箱の注意が言う', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: left({ registryName: 'reg', registryOrigin: 'adopted', registryUsers: ['other'] }) } as any); await open()
    expect(lines()).toEqual([`💾 コンテナレジストリ『reg』も残ります。`, `💾 ${KEPT_LINE}`])
  })

  it('★★★ 押すと、専有型の行が出ている回も、確認 0回・破棄 0回でフォルダを移す口が1回', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: null } as any); await open()
    await press()
    expect(fake.teardownCalls).toEqual([])
    expect(t.calls).toEqual(['runningOp', 'exists', 'trash', 'deleted', 'close'])
    expect(t.trashOpts).toEqual([{ confirmed: true, skippedForTwins: [] }])
  })
})

describe('★★★ 止める回は今までどおり止める（専有型の 💾 は出ない。ボタンは押せない）', () => {
  it('★★★ keep の無い保存場所が混ざる回: 止める文（保存場所だけが残っています）が出て、💾 は無く、ボタンは押せない', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [PLAIN], sharedLeftover: left({ placements: [PLAIN] }) } as any); await open()
    expect(paragraphs()).toContain(`⚠️ ${BLOCK_STORAGE}`)
    expect(lines()).toEqual([])
    expect(mainButton().props.disabled).toBe(true)
  })

  it('★★★ 資源の ID が残る回は、保存場所が全部 keep でも dedicated で止まる', async () => {
    withFacts({ targets: [ROW], dedicated: { ...MARK, clusterID: 'c-1' }, placements: [A], sharedLeftover: left({ placements: [A] }) } as any); await open()
    expect(paragraphs().some(p => p.startsWith('⚠️ さくらのAppRun 専有型のリソースが残っているため'))).toBe(true)
    expect(lines()).toEqual([])
    expect(mainButton().props.disabled).toBe(true)
  })

  it('★★★ 走っている操作がある回は、保存場所が全部 keep でも running で止まる', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: left({ placements: [A] }), running: { op: '公開', target: 'sakura-apprun-dedicated' } } as any); await open()
    expect(paragraphs().some(p => p.includes('いまこのプロジェクト'))).toBe(true)
    expect(lines()).toEqual([])
    expect(mainButton().props.disabled).toBe(true)
  })

  it('★★ 覆う複製で外した回は、専有型の 💾 を重ねて出さない（複製の文だけ）。ボタンは押せて、skippedForTwins に専有型が入る', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: null, twins: { 'sakura-apprun-dedicated': ['copy'] } } as any); await open()
    expect(lines()).toEqual([])
    expect(paragraphs().some(p => p.includes('フォルダ『copy』'))).toBe(true)
    expect(mainButton().props.disabled).toBe(false)
    await press()
    expect(t.trashOpts).toEqual([{ confirmed: true, skippedForTwins: ['sakura-apprun-dedicated'] }])
  })
})

describe('★★★ 公開先の行（HANAMII）やチェックを外した行が同じ保存場所を言う回は、専有型の行を重ねて出さない', () => {
  it('★★★ HANAMII の行・チェックがオン: 💾 は「HANAMII: 残ります…」の1行だけ（専有型の行は出ない）', async () => {
    withFacts({ targets: ['hanamii', ROW], dedicated: MARK, placements: [A], sharedLeftover: null } as any); await open()
    expect(lines()).toEqual([`💾 ${PUBLISH_TARGET_LABEL['hanamii']}: ${KEPT_LINE}`])
  })

  it('★★ チェックを外すと、外したときの 💾 が1行だけ（専有型の行は出ない）', async () => {
    withFacts({ targets: ['hanamii', ROW], dedicated: MARK, placements: [A], sharedLeftover: null } as any); await open()
    uncheck()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toContain('保存場所「koto-a」とその中のデータは残ります')
    expect(lines().some(l => l.includes('フォルダ『copy』'))).toBe(false)
  })
})

describe('★★★ 共用型の残りの段（plan.leftover）も立つ回: 同じ保存場所を、専有型の行が重ねて言わない（チェックがオンでもオフでも）', () => {
  const C = { bucket: 'koto-c', prefix: 'p', shared: true }
  const countIn = (needle: string) => count(lines().join('\n'), needle)
  // 共用型の残りに消すアプリがあるので段が足される（plan.leftover が立つ）。専有型の印 koto-a は全部 keep。
  const APP = ['app']

  it('★★★ (a) 残りの段が keep の koto-a を言う回・チェックがオン: 💾 に koto-a の名指しがちょうど1回、「残ります」も1回（専有型の行は出ない）', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: left({ appNames: APP, placements: [A] }) } as any); await open()
    expect(checkbox().props.checked).toBe(true)
    expect(mainButton().props.disabled).toBe(false)
    expect(countIn('『koto-a』'), '保存場所 koto-a の名指し').toBe(1)
    expect(countIn('残ります'), '「残ります」').toBe(1)
    expect(lines().every(l => !l.includes('koto-a') || l.includes('フォルダ『copy』も同じデータを使っています')), 'koto-a の行は理由つきの「残ります」').toBe(true)
  })

  it('★★★ (b) 残りの段が keep の koto-a と、keep の無い koto-c を言う回・チェックがオン: koto-c は「削除します」、koto-a は「残ります」が合わせて1回', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: left({ appNames: APP, placements: [A, C] }) } as any); await open()
    expect(checkbox().props.checked).toBe(true)
    expect(countIn('『koto-a』'), '保存場所 koto-a の名指し').toBe(1)
    expect(countIn('『koto-c』'), '保存場所 koto-c の名指し').toBe(1)
    expect(countIn('残ります'), 'koto-a の「残ります」').toBe(1)
    expect(countIn('削除します'), 'koto-c の「削除します」').toBe(1)
    expect(lines().filter(l => l.includes('『koto-c』')).every(l => l.includes('削除します'))).toBe(true)
  })

  it('★★ チェックをオフにした回も、koto-a の名指しは赤い箱の 💾 にちょうど1回（外したときの行〔keptNote〕だけが言い、専有型の行は重ねない）。ボタンは押せる', async () => {
    for (const shared of [left({ appNames: APP, placements: [A] }), left({ appNames: APP, placements: [A, C] })]) {
      withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: shared } as any); await open()
      uncheck()
      expect(checkbox().props.checked).toBe(false)
      expect(countIn('koto-a'), `koto-a の名指し（残り ${JSON.stringify((shared as any).placements.map((p: any) => p.bucket))}）`).toBe(1)
      expect(mainButton().props.disabled).toBe(false)
    }
  })
})

describe('★★★ 開いたあとで複製が消えた回: main の断り（twins-gone）で材料を読み直し、止める文に変わってボタンを押せなくなる（古い「残ります」のまま押させ続けない）', () => {
  it('★★★ 押す → 移さない・材料を読み直す → 💾 の「残ります」が消え、止める文（保存場所だけが残っています）が出て、ボタンは押せない', async () => {
    withFacts({ targets: [ROW], dedicated: MARK, placements: [A], sharedLeftover: left({ placements: [A] }) } as any); await open()
    expect(lines()).toEqual([`💾 ${KEPT_LINE}`])
    expect(mainButton().props.disabled).toBe(false)
    // 押す前に複製が消えた（次に読むと keep が付かない）。main は印だけの回を twins-gone で断る
    withFacts({ targets: [ROW], dedicated: MARK, placements: [PLAIN], sharedLeftover: left({ placements: [PLAIN] }) } as any)
    api.trashAnswer = { ok: false, message: FS_TRASH_MESSAGES.dedicated, reason: 'twins-gone' }
    const readsBefore = fake.readCalls.length
    await press()
    expect(t.calls).toEqual(['runningOp', 'exists', 'trash'])
    expect(t.deleted).toEqual([])
    expect(fake.readCalls.length, '材料を読み直した').toBe(readsBefore + 1)
    expect(results()?.run.phase).toBe('twinsGone')
    expect(paragraphs()).toContain(`⚠️ ${BLOCK_STORAGE}`)
    expect(lines().some(l => l.includes('フォルダ『copy』も同じデータを使っています')), '古い「残ります」が残った').toBe(false)
    expect(mainButton().props.disabled).toBe(true)
  })
})
