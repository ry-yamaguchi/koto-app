import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── 📡 公開したもの一覧は、何も消さないと分かっていた回（keptNothing）の結果に、行の消し方の一言を添える（3つの公開先とも）────────────────────
// 一覧（PublishedListModal）を react の小さな代役の上で**実際に動かし**、行（TeardownRow）の onOutcome を呼んで、結果欄が何を描くかを見る
// （tests/publishedListSharedRow.test.ts と同じ作り方）。一言の文そのものと「出す・出さない」は tests/keptNothingGate.test.ts（KeptNothingHint）。
//   ・共用型・HANAMII・専有型のどの結果欄も、同じ部品（KeptNothingHint）に、その回の outcome を渡す（1つの欄だけ一言が消える、を作らない）
//   ・共用型の「消すものが記録に無かった」回（nothingToDo）の一言は、同じ文（LIST_ROW_FORGET_HINT）のまま
// 変異: 3つの結果欄のうち1つから一言の部品を外す。

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  effects: [] as { fn: () => void | (() => void); deps: unknown[] | undefined }[],
  /** React と同じく、前の描画と依存が変わった effect だけを動かすための、前回の依存（effect の位置ごと）。 */
  prevDeps: [] as Array<unknown[] | undefined>,
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

let records: any = { ok: true, projects: [] }
let publishedRecordsCalls = 0
/** 画面が公開の記録を消そうとした回数（forgetTarget）。共用型の行のどの経路でも 0。 */
let forgetCalls: unknown[][] = []

function fakeElectronApi(): any {
  const anything: any = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: () => Promise.resolve({}),
  })
  return new Proxy({
    fs: new Proxy({ publishedRecords: async () => { publishedRecordsCalls++; return records } } as any, {
      get: (t, key) => (key in t ? t[key] : anything),
    }),
    publishMeta: new Proxy({ forgetTarget: async (...a: unknown[]) => { forgetCalls.push(a); return { ok: true, meta: {} } } } as any, {
      get: (t, key) => (key in t ? t[key] : anything),
    }),
  } as any, { get: (t, key) => (key in t ? (t as any)[key] : anything) })
}

const store = new Map<string, string>()
const win: any = new EventTarget()
win.electronAPI = fakeElectronApi()
win.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}
win.addEventListener = EventTarget.prototype.addEventListener.bind(win)
win.removeEventListener = EventTarget.prototype.removeEventListener.bind(win)
win.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(win)
;(globalThis as any).window = win
;(globalThis as any).localStorage = win.localStorage

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

import PublishedListModal from '../src/renderer/components/PublishedListModal'
import TeardownRow from '../src/renderer/components/teardown/TeardownRow'
import TeardownResultView from '../src/renderer/components/teardown/TeardownResultView'
import ManualTeardownNote from '../src/renderer/components/teardown/ManualTeardownNote'
import KeptNothingHint, { LIST_ROW_FORGET_HINT } from '../src/renderer/components/teardown/KeptNothingHint'
import { hanamiiTeardownSpec } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec } from '../src/renderer/teardown/targets/dedicated'
import { sharedTeardownSpec, SHARED_KEY_MISSING_MESSAGE } from '../src/renderer/teardown/targets/shared'
import { toTeardownView } from '../src/shared/teardownResult'
import type { TeardownFlowOutcome } from '../src/renderer/teardown/useTeardownFlow'

const spy = { opened: [] as string[], order: [] as string[] }
const props = {
  onClose: () => { spy.order.push('close') },
  onOpenProject: (dir: string) => { spy.opened.push(dir); spy.order.push('open') },
}

const T = '2026-09-26T00:00:00.000Z'
const sharedProject = (name: string) => ({
  dir: `/tmp/ws/${name}`, name,
  publish: { targets: { 'sakura-apprun': { publishedAt: T, url: `https://${name}.example.com/` } } },
})
const hanamiiProject = (name: string) => ({
  dir: `/tmp/ws/${name}`, name,
  publish: { hanamii: { projectId: `prj-${name}` }, targets: { hanamii: { publishedAt: T, url: `https://${name}.example.com/` } } },
})
const dedicatedProject = (name: string) => ({
  dir: `/tmp/ws/${name}`, name,
  publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: T, url: `https://${name}.example.com/` } } },
})
const rentalProject = (name: string) => ({
  dir: `/tmp/ws/${name}`, name,
  publish: { targets: { 'sakura-rental': { publishedAt: T, url: `https://${name}.example.com/` } } },
})

let mounted: Array<() => void> = []
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}
/** 描いて、React と同じく依存が変わった effect だけを動かす。effect が state を変えたら（React と同じく）もう一度描く（最大5回）。 */
function renderOnce(): void {
  for (let pass = 0; pass < 5; pass++) {
    hooks.index = 0; hooks.effects = []; hooks.rendered = []
    PublishedListModal(props)
    const statesBefore = JSON.stringify(hooks.states, (_k, v) => (typeof v === 'function' ? 'fn' : v))
    let ran = false
    hooks.effects.forEach((e, i) => {
      const prev = hooks.prevDeps[i]
      const changed = !(i in hooks.prevDeps) || !e.deps || !prev || e.deps.length !== prev.length || e.deps.some((d, k) => !Object.is(d, prev[k]))
      hooks.prevDeps[i] = e.deps
      if (!changed) return
      ran = true
      try { const c = e.fn(); if (typeof c === 'function') mounted.push(c) } catch { /* この画面の別の配線は見送る */ }
    })
    if (!ran || JSON.stringify(hooks.states, (_k, v) => (typeof v === 'function' ? 'fn' : v)) === statesBefore) return
  }
}
async function openList(): Promise<void> {
  hooks.states = []; hooks.prevDeps = []
  renderOnce()
  await settle()
  renderOnce()
}
/** 今の状態のまま描き直す（state は持ち越す。変わった effect は動かす）。 */
const rerender = renderOnce

const teardownRows = () => hooks.rendered.filter(el => el.type === TeardownRow)
const rowOf = (name: string) => teardownRows().find(el => el.props.spec === sharedTeardownSpec && el.props.entry.projectName === name)!
const hanamiiRowOf = (name: string) => teardownRows().find(el => el.props.spec === hanamiiTeardownSpec && el.props.entry.projectName === name)!
const dedicatedRowOf = (name: string) => teardownRows().find(el => el.props.spec === dedicatedTeardownSpec && el.props.entry.projectName === name)!
const textOf = (p: any): string => {
  const c = p?.children
  return (Array.isArray(c) ? c : [c]).filter(x => typeof x === 'string' || typeof x === 'number').join('')
}
const hanamiiBox = () => hooks.rendered.find(el => el.props?.['data-hanamii-outcome'])
const resultView = () => hooks.rendered.find(el => el.type === TeardownResultView && el.props.words === sharedTeardownSpec.words)
const hintsOf = () => hooks.rendered.filter(el => el.type === KeptNothingHint)

beforeEach(() => {
  store.set('sakura_workspace', '/tmp/ws')
  records = { ok: true, projects: [sharedProject('alpha'), hanamiiProject('beta'), dedicatedProject('gamma')] }
  publishedRecordsCalls = 0
  forgetCalls = []
  spy.opened = []; spy.order = []
})
afterEach(() => { for (const c of mounted) { try { c() } catch { /* 片づけの失敗は無視 */ } } mounted = [] })

const KEPT_SHARED = toTeardownView('sakura-apprun', { ok: true, executed: ['x'], keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptOnly: true })
const KEPT_HANAMII = toTeardownView('hanamii', { ok: true, executed: ['x'], keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'] })
const KEPT_DEDICATED = toTeardownView('sakura-apprun-dedicated', { ok: true, executed: ['x'], message: '', remaining: {}, keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptOnly: true })
const outcomeOf = (view: ReturnType<typeof toTeardownView>, over: Partial<TeardownFlowOutcome> = {}): TeardownFlowOutcome => ({ view, notes: [], ...over })

describe('★★★ 📡 一覧: 何も消さないと分かっていた回の結果欄に、行の消し方の一言の部品が付く（3つの公開先とも）', () => {
  it('★★★ 共用型の行の onOutcome: 結果欄の部品と一言の部品が、その回の outcome を受け取る', async () => {
    await openList()
    const row = rowOf('alpha')
    const outcome = outcomeOf(KEPT_SHARED, { keptNothing: true })
    row.props.onOutcome(row.props.entry, outcome)
    rerender()
    expect(hintsOf()).toHaveLength(1)
    expect(hintsOf()[0].props.outcome).toBe(outcome)
    expect(resultView()?.props.view).toBe(KEPT_SHARED)
  })

  it('★★★ HANAMII の行の onOutcome: 同じ部品が、その回の outcome を受け取る', async () => {
    await openList()
    const row = hanamiiRowOf('beta')
    const outcome = outcomeOf(KEPT_HANAMII, { keptNothing: true })
    row.props.onOutcome(row.props.entry, outcome)
    rerender()
    expect(hanamiiBox(), 'HANAMII の結果欄が出ない').toBeTruthy()
    expect(hintsOf()).toHaveLength(1)
    expect(hintsOf()[0].props.outcome).toBe(outcome)
  })

  it('★★★ 専有型の行の onOutcome: 同じ部品が、その回の outcome を受け取る', async () => {
    await openList()
    const row = dedicatedRowOf('gamma')
    const outcome = outcomeOf(KEPT_DEDICATED, { keptNothing: true })
    row.props.onOutcome(row.props.entry, outcome)
    rerender()
    expect(hooks.rendered.find(el => el.props?.['data-dedicated-outcome']), '専有型の結果欄が出ない').toBeTruthy()
    expect(hintsOf()).toHaveLength(1)
    expect(hintsOf()[0].props.outcome).toBe(outcome)
  })

  it('★★ 共用型の「消すものが記録に無かった」回（nothingToDo）の一言は、同じ文（LIST_ROW_FORGET_HINT）。一言の部品は keptNothing の回だけが使う', async () => {
    await openList()
    const row = rowOf('alpha')
    row.props.onOutcome(row.props.entry, outcomeOf(toTeardownView('sakura-apprun', { ok: false, message: sharedTeardownSpec.words.nothingToDo }), { nothingToDo: true }))
    rerender()
    const note = hooks.rendered.find(el => el.props?.['data-shared-nothing-to-do'])
    expect(textOf(note!.props)).toBe(`${sharedTeardownSpec.words.nothingToDo} この行は「一覧から削除」で消せます。`)
    // この回の outcome に keptNothing は無いので、一言の部品が出す一言は無い（部品は keptNothing:true のときだけ描く）
    for (const el of hintsOf()) expect(el.props.outcome.keptNothing).toBeUndefined()
  })
})

describe('★★★ 📡 一覧: main まで届いて何も消さなかった回（view が keptOnly）の結果欄にも、同じ一言を添える', () => {
  /** 結果欄が一言の部品へ渡した outcome で、部品が一言を出すか（部品を呼んで、描いた段落に印があるか）。 */
  const hintShown = (outcome: unknown): boolean => {
    hooks.rendered = []
    KeptNothingHint({ outcome } as any)
    return hooks.rendered.some(el => el.props?.['data-kept-nothing-hint'] !== undefined && String(textOf(el.props)) === LIST_ROW_FORGET_HINT)
  }

  it('★★★ 共用型の行: keptNothing が付かない keptOnly の回でも、その outcome を一言の部品へ渡し、一言が出る。keptOnly でない成功には出ない', async () => {
    await openList()
    const row = rowOf('alpha')
    const kept = outcomeOf(KEPT_SHARED)
    row.props.onOutcome(row.props.entry, kept)
    rerender()
    expect(hintsOf()).toHaveLength(1)
    expect(hintsOf()[0].props.outcome).toBe(kept)
    expect(hintShown(hintsOf()[0].props.outcome)).toBe(true)
    const erased = outcomeOf(toTeardownView('sakura-apprun', { ok: true, executed: ['アプリを削除'] }))
    row.props.onOutcome(row.props.entry, erased)
    rerender()
    expect(hintShown(hintsOf()[0].props.outcome)).toBe(false)
  })

  it('★★★ 専有型の行: 同じ（keptOnly の回は一言が出る・keptOnly でない成功には出ない）', async () => {
    await openList()
    const row = dedicatedRowOf('gamma')
    const kept = outcomeOf(KEPT_DEDICATED)
    row.props.onOutcome(row.props.entry, kept)
    rerender()
    expect(hintsOf()).toHaveLength(1)
    expect(hintShown(hintsOf()[0].props.outcome)).toBe(true)
    row.props.onOutcome(row.props.entry, outcomeOf(toTeardownView('sakura-apprun-dedicated', { ok: true, executed: ['x'], message: '', remaining: {} })))
    rerender()
    expect(hintShown(hintsOf()[0].props.outcome)).toBe(false)
  })

  it('★★ HANAMII の行: main が返す結果は keptOnly を持たない（付けない公開先）ので、keptNothing でない回に一言は出ない。keptNothing の回は今までどおり出る', async () => {
    await openList()
    const row = hanamiiRowOf('beta')
    const view = toTeardownView('hanamii', { ok: true, executed: ['x'], keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptOnly: true })
    expect('keptOnly' in view).toBe(false) // 返り値に keptOnly が混じっても、HANAMII の view は読まない
    row.props.onOutcome(row.props.entry, outcomeOf(view))
    rerender()
    expect(hintShown(hintsOf()[0].props.outcome)).toBe(false)
    row.props.onOutcome(row.props.entry, outcomeOf(KEPT_HANAMII, { keptNothing: true }))
    rerender()
    expect(hintShown(hintsOf()[0].props.outcome)).toBe(true)
  })
})
