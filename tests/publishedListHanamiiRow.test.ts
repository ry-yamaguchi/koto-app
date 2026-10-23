import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── 📡 公開したもの一覧が、HANAMII の行の部品（TeardownRow）につなぐ配線を、振る舞いで固定する（段階1の1b・設計書 10.4.4 の H2）──────
//
// 一覧（PublishedListModal）を react の小さな代役の上で**実際に動かし**、HANAMII の行に渡した props（spec・onOutcome・onBusyChange・
// onFinished・blocked・render・key）を呼んで、一覧が何を描き直すかを見る（tests/publishedListDedicatedRow.test.ts と同じ作り方）。
// 行そのものの中身（確認 → 破棄 → 結果）は tests/hanamiiTeardownRow.test.ts。
//
//   ・HANAMII の記録は TeardownRow（仕様書は hanamiiTeardownSpec）で描かれる。🗑 を押して一覧自身が確認を出す道（askConfirm）は通らない
//   ・行の key は添字を含めない（確認ダイアログを持つ行が、上の行が消えたときに作り直されない）
//   ・結果は行の外（一覧の上）に、共通の結果の部品（TeardownResultView）で出す。管理画面の行き先は2つ
//   ・どの行でも破棄が始まったら、HANAMII の前の結果は片づく。ほかの行は、走っている行があるあいだ押せない
//   ・一覧は公開の記録を消さない（消すのは main の1か所）。終わったら読み直すだけ

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
/** 画面が公開の記録を消そうとした回数（forgetTarget）。HANAMII の行のどの経路でも 0。 */
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
import { hanamiiTeardownSpec, HANAMII_KEY_MISSING_MESSAGE } from '../src/renderer/teardown/targets/hanamii'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import { dedicatedTeardownSpec, DEDICATED_LIST_KEY_MISSING_MESSAGE } from '../src/renderer/teardown/targets/dedicated'
import { toTeardownView, HANAMII_DELETION_ACCEPTED_WARNING } from '../src/shared/teardownResult'
import type { TeardownFlowOutcome } from '../src/renderer/teardown/useTeardownFlow'

const spy = { opened: [] as string[], order: [] as string[] }
const props = {
  onClose: () => { spy.order.push('close') },
  onOpenProject: (dir: string) => { spy.opened.push(dir); spy.order.push('open') },
}

const hanamiiProject = (name: string) => ({
  dir: `/tmp/ws/${name}`, name,
  publish: {
    hanamii: { projectId: `prj-${name}` },
    targets: { hanamii: { publishedAt: '2026-09-28T00:00:00.000Z', url: `https://${name}.example.com/` } },
  },
})
const dedicatedProject = (name: string) => ({
  dir: `/tmp/ws/${name}`, name,
  publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: '2026-09-27T00:00:00.000Z', url: `https://${name}.example.com/` } } },
})
const sharedProject = (name: string) => ({
  dir: `/tmp/ws/${name}`, name,
  publish: { targets: { 'sakura-apprun': { publishedAt: '2026-09-26T00:00:00.000Z', url: `https://${name}.example.com/` } } },
})

let mounted: Array<() => void> = []
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}
/**
 * 描いて、React と同じく依存が変わった effect だけを動かす。effect が state を変えたら（React と同じく）もう一度描く。
 * 描き直しは effect が落ち着くまで（最大5回）。
 */
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

/** 行の部品（TeardownRow）で描かれた行すべて（HANAMII も共用型も）。 */
const teardownRows = () => hooks.rendered.filter(el => el.type === TeardownRow)
const hanamiiRows = () => teardownRows().filter(el => el.props.spec === hanamiiTeardownSpec)
const rowOf = (name: string) => hanamiiRows().find(el => el.props.entry.projectName === name)!
const dedicatedRows = () => teardownRows().filter(el => el.props.spec === dedicatedTeardownSpec)
const dedicatedRowOf = (name: string) => dedicatedRows().find(el => el.props.entry.projectName === name)!
const textOf = (p: any): string => {
  const c = p?.children
  return (Array.isArray(c) ? c : [c]).filter(x => typeof x === 'string' || typeof x === 'number').join('')
}
const outcomeBox = () => hooks.rendered.find(el => el.props?.['data-hanamii-outcome'])
const resultView = () => hooks.rendered.find(el => el.type === TeardownResultView)

const ACCEPTED = toTeardownView('hanamii', { ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING })
const LEFTOVER = toTeardownView('hanamii', { ok: false, appDeleted: true, remainingBuckets: ['koto-data-x'], message: '保存場所を削除できませんでした' })
/** 全部片づいた回（ok:true）。画面が公開の記録を消したくなるのは、この回。 */
const DONE = toTeardownView('hanamii', { ok: true, appDeleted: true, executed: [] })
const outcomeOf = (view = ACCEPTED): TeardownFlowOutcome => ({ view, notes: [] })

beforeEach(() => {
  store.set('sakura_workspace', '/tmp/ws')
  records = { ok: true, projects: [hanamiiProject('alpha'), hanamiiProject('beta')] }
  publishedRecordsCalls = 0
  forgetCalls = []
  spy.opened = []; spy.order = []
})
afterEach(() => { for (const c of mounted) { try { c() } catch { /* 片づけの失敗は無視 */ } } mounted = [] })

describe('📡 一覧 → HANAMII の行（TeardownRow）の配線', () => {
  it('★★★ HANAMII の記録は TeardownRow で描かれ、仕様書は hanamiiTeardownSpec。最初はどれも押せる。一覧自身の確認の道（askConfirm）は通らない', async () => {
    await openList()
    expect(hanamiiRows()).toHaveLength(2)
    for (const r of hanamiiRows()) {
      expect(r.props.spec).toBe(hanamiiTeardownSpec)
      expect(r.props.entry.target).toBe('hanamii')
      expect(r.props.blocked).toBe(false)
    }
    // 一覧が自分で出す確認のオーバーレイ（⚠️ 公開を破棄します）は出ていない
    expect(hooks.rendered.some(el => el.type === 'p' && textOf(el.props).includes('公開を破棄します'))).toBe(false)
  })

  it('★★ 旧い記録（targets が無く hanamii.projectId だけ）でも、HANAMII の行は TeardownRow で描かれる', async () => {
    records = { ok: true, projects: [{ dir: '/tmp/ws/old', name: 'old', publish: { hanamii: { projectId: 'prj-old' } } }] }
    await openList()
    expect(hanamiiRows()).toHaveLength(1)
    expect(hanamiiRows()[0].props.entry.projectName).toBe('old')
  })

  it('★★ キーが無いときの案内は、トークンが見つからない旨と、通る道（同じ登録に入れ直す／登録を消したなら管理画面で削除）。別のトークンを選び直す案内ではない', async () => {
    await openList()
    const msg: string = rowOf('alpha').props.keyMissingMessage
    expect(msg).toContain('HANAMII のトークンが見つかりません')
    expect(msg).toContain('認証情報')
    expect(msg).toBe(HANAMII_KEY_MISSING_MESSAGE)
  })

  it('★★★ 行の onOutcome を呼ぶと、一覧の上に結果欄が出て、共通の結果の部品に view・notes・言葉・管理画面の行き先が渡る。見出しにプロジェクト名', async () => {
    await openList()
    expect(outcomeBox()).toBeUndefined()
    const alpha = rowOf('alpha')
    const outcome = outcomeOf(LEFTOVER)
    alpha.props.onOutcome(alpha.props.entry, outcome)
    rerender()
    expect(outcomeBox(), '結果欄が出ない（残った保存場所の月額・受付済みの旨が利用者に届かない）').toBeTruthy()
    const view = resultView()
    expect(view, '結果の部品が描かれない').toBeTruthy()
    expect(view!.props.view).toBe(LEFTOVER)
    expect(view!.props.notes).toBe(outcome.notes)
    expect(view!.props.words).toBe(hanamiiTeardownSpec.words)
    // 管理画面の行き先は2つ: 公開先は HANAMII の管理画面、保存場所はさくらのクラウドのコントロールパネル
    expect(view!.props.serviceConsoleUrl).toBe('https://hanamii.jp/')
    expect(view!.props.storageConsoleUrl).toBe('https://secure.sakura.ad.jp/cloud/')
    expect(hooks.rendered.find(el => el.type === 'p' && textOf(el.props).includes('alpha'))).toBeTruthy()
  })

  it('★★★ 全部片づいた回（ok:true）の結果が届いても、一覧は公開の記録を消さない。結果は出す（消すのは main の1か所。成功の回こそ、画面が消したくなる）', async () => {
    await openList()
    const alpha = rowOf('alpha')
    // 実際の順: 走り出す（前の結果を片づける）→ 結果が届く → 走り終わる → 一覧を読み直す
    alpha.props.onBusyChange(true)
    alpha.props.onOutcome(alpha.props.entry, outcomeOf(DONE))
    alpha.props.onBusyChange(false)
    await alpha.props.onFinished()
    await settle()
    rerender()
    expect(DONE.ok, '前提: 全部片づいた結果').toBe(true)
    expect(forgetCalls, 'ok:true の結果を受けて、画面が公開の記録を消そうとした（main が消したあとの二重消し・消えるべきでない行の消去）').toEqual([])
    expect(resultView()?.props.view, '成功の結果が出ていない').toBe(DONE)
  })

  it('★★★ 行の onBusyChange(true) で、ほかの行の 🗑 が止まる。実行中の行自身は止めない。false で戻る。前の結果欄は片づく', async () => {
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf()) // 前の結果
    rerender()
    expect(outcomeBox()).toBeTruthy()

    rowOf('alpha').props.onBusyChange(true)
    rerender()
    expect(rowOf('alpha').props.blocked, '実行中の行自身が止まっている').toBe(false)
    expect(rowOf('beta').props.blocked, '別の行の破棄が走っているのに、この行の 🗑 が押せる').toBe(true)
    expect(outcomeBox(), '新しい破棄が始まったのに前の結果が残っている').toBeUndefined()

    rowOf('alpha').props.onBusyChange(false)
    rerender()
    expect(hanamiiRows().map(r => r.props.blocked)).toEqual([false, false])
  })

  it('★★ 別の行の onBusyChange(false) は、いま実行中の行の印を下ろさない（二重に走らせない）', async () => {
    await openList()
    rowOf('alpha').props.onBusyChange(true)
    rowOf('beta').props.onBusyChange(false)
    rerender()
    expect(rowOf('beta').props.blocked).toBe(true)
  })

  it('★★★ 専有型の行の破棄が始まっても、HANAMII の前の結果は片づく（専有型の行の onBusyChange が片づける）。HANAMII の行も、専有型の行が走っているあいだ止まる', async () => {
    records = { ok: true, projects: [hanamiiProject('alpha'), dedicatedProject('gamma')] }
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf())
    rerender()
    expect(outcomeBox()).toBeTruthy()

    dedicatedRowOf('gamma').props.onBusyChange(true)
    rerender()
    expect(outcomeBox(), '専有型の破棄が始まったのに、HANAMII の前の結果が残っている').toBeUndefined()
    expect(rowOf('alpha').props.blocked, '専有型の行が走っているのに HANAMII の 🗑 が押せる').toBe(true)

    dedicatedRowOf('gamma').props.onBusyChange(false)
    rerender()
    expect(rowOf('alpha').props.blocked).toBe(false)
    // 専有型の行から見ても、HANAMII の行が走っていれば止まる
    rowOf('alpha').props.onBusyChange(true)
    rerender()
    expect(dedicatedRowOf('gamma').props.blocked).toBe(true)
  })

  it('★★ HANAMII の破棄が始まったら、専有型の前の結果欄も片づく（新しい破棄が始まったら、前の結果は残さない）', async () => {
    records = { ok: true, projects: [hanamiiProject('alpha'), dedicatedProject('gamma')] }
    await openList()
    const gamma = dedicatedRowOf('gamma')
    gamma.props.onOutcome(gamma.props.entry, {
      view: toTeardownView('sakura-apprun-dedicated', { ok: false, executed: [], message: 'ロードバランサの削除に失敗しました', remaining: { loadBalancerID: 'l1' } }),
      notes: [],
    })
    rerender()
    expect(hooks.rendered.some(el => el.props?.['data-dedicated-outcome'])).toBe(true)
    rowOf('alpha').props.onBusyChange(true)
    rerender()
    expect(hooks.rendered.some(el => el.props?.['data-dedicated-outcome']), 'HANAMII の破棄が始まったのに、専有型の前の結果が残っている').toBe(false)
  })

  it('★★ HANAMII の結果を出したあとで busyKey が null のままなら、結果は消えない（結果を消すのは、別の行の破棄が走り出したときだけ）', async () => {
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf())
    rerender(); rerender()
    expect(outcomeBox()).toBeTruthy()
  })

  it('★★ 行の onFinished を呼ぶと、一覧が公開の記録を読み直す。一覧は公開の記録を消さない（消すのは main の1か所）', async () => {
    await openList()
    const before = publishedRecordsCalls
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf(LEFTOVER))
    alpha.props.onBusyChange(true)
    alpha.props.onBusyChange(false)
    await alpha.props.onFinished()
    expect(publishedRecordsCalls, '終わっても一覧を読み直していない').toBe(before + 1)
    expect(forgetCalls, 'HANAMII の行の経路で、画面が公開の記録を消そうとした').toEqual([])
  })

  it('★★ 行の本体（render）: 「一覧から削除」は、その行の破棄が走っている間は押せない（破棄の最中に記録だけを消すと、途中で止まったとき押し直せなくなる）', async () => {
    await openList()
    const forgetButtons = () => hooks.rendered.filter(el => el.type === 'button' && textOf(el.props).trim() === '一覧から削除')
    const alpha = rowOf('alpha')
    hooks.rendered = []
    alpha.props.render({ button: 'BTN', below: 'BELOW', busy: true })
    expect(forgetButtons()).toHaveLength(1)
    expect(forgetButtons()[0].props.disabled, '破棄が走っているのに「一覧から削除」が押せる').toBe(true)
    hooks.rendered = []
    alpha.props.render({ button: 'BTN', below: 'BELOW', busy: false })
    expect(forgetButtons()[0].props.disabled).toBe(false)
  })

  it('★★ 行の本体（render）は、行の部品が渡した 🗑 のボタンと進み具合を、そのまま行に置く（共用型の 🗑 を重ねない）', async () => {
    await openList()
    const alpha = rowOf('alpha')
    hooks.rendered = []
    alpha.props.render({ button: 'BTN', below: 'BELOW', busy: false })
    expect(hooks.rendered.some(el => el.type === 'button' && textOf(el.props).includes('🗑'))).toBe(false)
  })

  it('★★★ 行の key は添字を含めない（上の行が消えても、下の行の部品＝確認ダイアログ・フック状態が作り直されない）', async () => {
    await openList()
    const beta0 = rowOf('beta')
    records = { ok: true, projects: [hanamiiProject('beta')] } // 上の行（alpha）が消えた再読み込み
    await rowOf('alpha').props.onFinished()
    rerender()
    const beta1 = rowOf('beta')
    expect(hanamiiRows()).toHaveLength(1)
    expect(beta1.key, '行の位置が変わって key が変わった（部品が作り直される）').toBe(beta0.key)
    expect(String(beta1.key)).toBe('/tmp/ws/beta-hanamii')
  })
})

describe('📡 一覧: HANAMII 以外の行', () => {
  // 段階2の2b-2: 共用型 AppRun の行も TeardownRow（共通の流れ）。仕様書は共用型のもので、HANAMII の仕様書ではない。
  // 一覧自身の確認（askConfirm）と 🗑 のボタンは無い。共用型の行の配線は tests/publishedListSharedRow.test.ts。
  it('★★ 共用型 AppRun は TeardownRow だが、仕様書は共用型のもの（sharedTeardownSpec）。HANAMII の仕様書ではなく、一覧自身の 🗑 破棄のボタンも無い', async () => {
    records = { ok: true, projects: [sharedProject('delta')] }
    await openList()
    expect(teardownRows()).toHaveLength(1)
    expect(teardownRows()[0].props.spec).toBe(sharedTeardownSpec)
    expect(hanamiiRows(), 'HANAMII の仕様書で共用型の行を描いている').toHaveLength(0)
    expect(dedicatedRows()).toHaveLength(0)
    expect(hooks.rendered.some(el => el.type === 'button' && textOf(el.props).trim() === '🗑 破棄')).toBe(false)
  })

  it('★★ HANAMII と共用型の両方がある一覧では、行ごとに自分の仕様書を渡す（取り違えない）', async () => {
    records = { ok: true, projects: [hanamiiProject('alpha'), sharedProject('delta')] }
    await openList()
    expect(teardownRows().map(r => [r.props.entry.projectName, r.props.spec === hanamiiTeardownSpec ? 'hanamii' : r.props.spec === sharedTeardownSpec ? 'shared' : '?'])).toEqual([['alpha', 'hanamii'], ['delta', 'shared']])
  })

  it('★★ 専有型も TeardownRow（専有型の仕様書 dedicatedTeardownSpec・📡 用のキー未登録の案内）。HANAMII の仕様書は渡さない。ボタンは「🗑 破棄」ではなく「🗑 削除」（V1）', async () => {
    records = { ok: true, projects: [dedicatedProject('gamma')] }
    await openList()
    expect(hanamiiRows()).toHaveLength(0)
    expect(teardownRows()).toHaveLength(1)
    expect(dedicatedRows()).toHaveLength(1)
    expect(dedicatedRowOf('gamma').props.keyMissingMessage).toBe(DEDICATED_LIST_KEY_MISSING_MESSAGE)
    expect(dedicatedRowOf('gamma').props.spec.words.rowButton).toBe('🗑 削除')
    expect(hanamiiTeardownSpec.words.rowButton).toBe('🗑 破棄')
  })
})
