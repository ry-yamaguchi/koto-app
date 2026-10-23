import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── 📡 公開したもの一覧が、共用型（さくらのAppRun）の行の部品（TeardownRow）につなぐ配線を、振る舞いで固定する（段階2の2b-2・設計書 10.7.9 の S3 と 10.7.12 の E）──────
//
// 一覧（PublishedListModal）を react の小さな代役の上で**実際に動かし**、共用型の行に渡した props（spec・onOutcome・onBusyChange・onFinished・blocked・render・key）を呼んで、
// 一覧が何を描き直すかを見る（tests/publishedListHanamiiRow.test.ts と同じ作り方）。行そのものの中身（確認 → 破棄 → 結果）は tests/sharedTeardownRow.test.ts・sharedTeardownRowStates.test.ts。
//
//   ・共用型の記録は TeardownRow（仕様書は sharedTeardownSpec）で描かれる。一覧自身の確認（askConfirm）と 🗑 のボタンは無い
//   ・行の key は添字を含めない。結果は行の外（一覧の上）に、共通の結果の部品（TeardownResultView）で出す。管理画面の行き先は2つ
//   ・保存場所だけが残った失敗の結果には、押し直せる場所（「このプロジェクトを開く」）を添える。消すものが記録に無かった回は失敗でなく中立の知らせで出す
//   ・どの行でも破棄が始まったら、共用型の前の結果は片づく。ほかの行は、走っている行があるあいだ押せない
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
const sharedRows = () => teardownRows().filter(el => el.props.spec === sharedTeardownSpec)
const rowOf = (name: string) => sharedRows().find(el => el.props.entry.projectName === name)!
const hanamiiRowOf = (name: string) => teardownRows().find(el => el.props.spec === hanamiiTeardownSpec && el.props.entry.projectName === name)!
const dedicatedRowOf = (name: string) => teardownRows().find(el => el.props.spec === dedicatedTeardownSpec && el.props.entry.projectName === name)!
const textOf = (p: any): string => {
  const c = p?.children
  return (Array.isArray(c) ? c : [c]).filter(x => typeof x === 'string' || typeof x === 'number').join('')
}
const outcomeBox = () => hooks.rendered.find(el => el.props?.['data-shared-outcome'])
const hanamiiBox = () => hooks.rendered.find(el => el.props?.['data-hanamii-outcome'])
const nothingToDoNote = () => hooks.rendered.find(el => el.props?.['data-shared-nothing-to-do'])
const resultView = () => hooks.rendered.find(el => el.type === TeardownResultView && el.props.words === sharedTeardownSpec.words)

const DONE = toTeardownView('sakura-apprun', { ok: true, appDeleted: true, executed: [] })
/** アプリは消えて、保存場所だけ残った回。 */
const LEFTOVER = toTeardownView('sakura-apprun', { ok: false, appDeleted: true, remainingBuckets: ['koto-data-x'], message: '保存場所を削除できませんでした' })
const NOTHING = toTeardownView('sakura-apprun', { ok: false, message: sharedTeardownSpec.words.nothingToDo })
const outcomeOf = (view = LEFTOVER, over: Partial<TeardownFlowOutcome> = {}): TeardownFlowOutcome => ({ view, notes: [], ...over })

beforeEach(() => {
  store.set('sakura_workspace', '/tmp/ws')
  records = { ok: true, projects: [sharedProject('alpha'), sharedProject('beta')] }
  publishedRecordsCalls = 0
  forgetCalls = []
  spy.opened = []; spy.order = []
})
afterEach(() => { for (const c of mounted) { try { c() } catch { /* 片づけの失敗は無視 */ } } mounted = [] })

describe('📡 一覧 → 共用型の行（TeardownRow）の配線', () => {
  it('★★★ 共用型の記録は TeardownRow で描かれ、仕様書は sharedTeardownSpec。最初はどれも押せる。一覧自身の確認（askConfirm）と 🗑 のボタンは無い', async () => {
    await openList()
    expect(sharedRows()).toHaveLength(2)
    expect(teardownRows(), 'HANAMII の仕様書の行が混じっている').toHaveLength(2)
    for (const r of sharedRows()) {
      expect(r.props.entry.target).toBe('sakura-apprun')
      expect(r.props.blocked).toBe(false)
    }
    expect(hooks.rendered.some(el => el.type === 'p' && textOf(el.props).includes('公開を破棄します'))).toBe(false)
    expect(hooks.rendered.some(el => el.type === 'button' && textOf(el.props).trim() === '🗑 破棄')).toBe(false)
    expect(hooks.rendered.some(el => el.type === 'input'), '一覧がレジストリのチェックを自分で出している').toBe(false)
  })

  it('★★ キーが無いときの案内は、共用型の仕様書の定数（HANAMII の案内ではない）', async () => {
    await openList()
    expect(rowOf('alpha').props.keyMissingMessage).toBe(SHARED_KEY_MISSING_MESSAGE)
    expect(rowOf('alpha').props.keyMissingMessage).toContain('さくらのクラウドのAPIキー')
  })

  it('★★★ 行の onOutcome を呼ぶと、一覧の上に結果欄が出て、共通の結果の部品に view・notes・言葉・管理画面の行き先が渡る。見出しにプロジェクト名', async () => {
    await openList()
    expect(outcomeBox()).toBeUndefined()
    const alpha = rowOf('alpha')
    const outcome = outcomeOf(LEFTOVER)
    alpha.props.onOutcome(alpha.props.entry, outcome)
    rerender()
    expect(outcomeBox(), '結果欄が出ない（残った保存場所の月額が利用者に届かない）').toBeTruthy()
    const view = resultView()
    expect(view, '結果の部品が描かれない').toBeTruthy()
    expect(view!.props.view).toBe(LEFTOVER)
    expect(view!.props.notes).toBe(outcome.notes)
    // 管理画面の行き先は2つ: 公開先は AppRun の画面、保存場所はさくらのクラウドのコントロールパネル
    expect(view!.props.serviceConsoleUrl).toBe('https://secure.sakura.ad.jp/cloud/apprun/')
    expect(view!.props.storageConsoleUrl).toBe('https://secure.sakura.ad.jp/cloud/')
    expect(hooks.rendered.find(el => el.type === 'p' && textOf(el.props).includes('alpha'))).toBeTruthy()
    expect(nothingToDoNote()).toBeUndefined()
  })

  it('★★★ 保存場所だけが残った失敗の結果には、押し直せる場所の案内と「このプロジェクトを開く」が付く。押すとそのプロジェクトを開いて一覧を閉じる', async () => {
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf(LEFTOVER))
    rerender()
    const view = resultView()!
    expect(view.props.storageRetryHint).toContain('保存場所だけが残った場合、この行が一覧から消えることがあります')
    expect(view.props.storageRetryHint).toContain('📦 さくらのAppRun の「🗑 破棄する（削除）」')
    expect(view.props.storageRetryAction.label).toBe('このプロジェクトを開く')
    view.props.storageRetryAction.onClick()
    expect(spy.opened).toEqual(['/tmp/ws/alpha'])
    expect(spy.order).toEqual(['open', 'close'])
  })

  it('★★★ 消すものが記録に無かった回（nothingToDo）は、失敗の結果の部品ではなく中立の知らせで出す。次の操作（一覧から削除）を添える', async () => {
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf(NOTHING, { nothingToDo: true }))
    rerender()
    expect(outcomeBox()).toBeTruthy()
    expect(resultView(), '何もしなかった回を失敗の結果として出している').toBeUndefined()
    const note = nothingToDoNote()
    expect(note, '中立の知らせが出ない').toBeTruthy()
    expect(textOf(note!.props)).toBe(`${sharedTeardownSpec.words.nothingToDo} この行は「一覧から削除」で消せます。`)
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
    expect(forgetCalls, 'ok:true の結果を受けて、画面が公開の記録を消そうとした（main が消したあとの二重消し）').toEqual([])
    expect(resultView()?.props.view, '成功の結果が出ていない').toBe(DONE)
  })

  it('★★★ 行の onBusyChange(true) で、ほかの行の 🗑 が止まる。実行中の行自身は止めない。false で戻る。前の結果欄は片づく', async () => {
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf())
    rerender()
    expect(outcomeBox()).toBeTruthy()

    rowOf('alpha').props.onBusyChange(true)
    rerender()
    expect(rowOf('alpha').props.blocked, '実行中の行自身が止まっている').toBe(false)
    expect(rowOf('beta').props.blocked, '別の行の破棄が走っているのに、この行の 🗑 が押せる').toBe(true)
    expect(outcomeBox(), '新しい破棄が始まったのに前の結果が残っている').toBeUndefined()

    rowOf('alpha').props.onBusyChange(false)
    rerender()
    expect(sharedRows().map(r => r.props.blocked)).toEqual([false, false])
  })

  it('★★ 別の行の onBusyChange(false) は、いま実行中の行の印を下ろさない（二重に走らせない）', async () => {
    await openList()
    rowOf('alpha').props.onBusyChange(true)
    rowOf('beta').props.onBusyChange(false)
    rerender()
    expect(rowOf('beta').props.blocked).toBe(true)
  })

  it('★★★ 専有型・HANAMII の行の破棄が始まっても、共用型の前の結果は片づく（それぞれの行の onBusyChange が片づける）。共用型の行も、それらが走っているあいだ止まる', async () => {
    records = { ok: true, projects: [sharedProject('alpha'), dedicatedProject('gamma'), hanamiiProject('eta')] }
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf())
    rerender()
    expect(outcomeBox()).toBeTruthy()

    dedicatedRowOf('gamma').props.onBusyChange(true)
    rerender()
    expect(outcomeBox(), '専有型の破棄が始まったのに、共用型の前の結果が残っている').toBeUndefined()
    expect(rowOf('alpha').props.blocked, '専有型の行が走っているのに共用型の 🗑 が押せる').toBe(true)
    dedicatedRowOf('gamma').props.onBusyChange(false)
    rerender()
    expect(rowOf('alpha').props.blocked).toBe(false)

    rowOf('alpha').props.onOutcome(alpha.props.entry, outcomeOf())
    rerender()
    expect(outcomeBox()).toBeTruthy()
    hanamiiRowOf('eta').props.onBusyChange(true)
    rerender()
    expect(outcomeBox(), 'HANAMII の破棄が始まったのに、共用型の前の結果が残っている').toBeUndefined()
    expect(rowOf('alpha').props.blocked).toBe(true)
  })

  it('★★ 共用型の破棄が始まったら、HANAMII・専有型の前の結果欄も片づく（新しい破棄が始まったら、前の結果は残さない）', async () => {
    records = { ok: true, projects: [sharedProject('alpha'), hanamiiProject('eta'), dedicatedProject('gamma')] }
    await openList()
    const eta = hanamiiRowOf('eta')
    eta.props.onOutcome(eta.props.entry, outcomeOf(toTeardownView('hanamii', { ok: true, appDeleted: true, executed: [] })))
    const gamma = dedicatedRowOf('gamma')
    gamma.props.onOutcome(gamma.props.entry, {
      view: toTeardownView('sakura-apprun-dedicated', { ok: false, executed: [], message: 'ロードバランサの削除に失敗しました', remaining: { loadBalancerID: 'l1' } }),
      notes: [],
    })
    rerender()
    expect(hanamiiBox()).toBeTruthy()
    expect(hooks.rendered.some(el => el.props?.['data-dedicated-outcome'])).toBe(true)
    rowOf('alpha').props.onBusyChange(true)
    rerender()
    expect(hanamiiBox(), '共用型の破棄が始まったのに、HANAMII の前の結果が残っている').toBeUndefined()
    expect(hooks.rendered.some(el => el.props?.['data-dedicated-outcome']), '共用型の破棄が始まったのに、専有型の前の結果が残っている').toBe(false)
  })

  it('★★ 共用型の結果を出したあとで busyKey が null のままなら、結果は消えない（結果を消すのは、別の行の破棄が走り出したときだけ）', async () => {
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
    expect(forgetCalls, '共用型の行の経路で、画面が公開の記録を消そうとした').toEqual([])
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

  it('★★★ 行の key は添字を含めない（上の行が消えても、下の行の部品＝確認ダイアログ・フック状態が作り直されない）', async () => {
    await openList()
    const beta0 = rowOf('beta')
    records = { ok: true, projects: [sharedProject('beta')] } // 上の行（alpha）が消えた再読み込み
    await rowOf('alpha').props.onFinished()
    rerender()
    const beta1 = rowOf('beta')
    expect(sharedRows()).toHaveLength(1)
    expect(beta1.key, '行の位置が変わって key が変わった（部品が作り直される）').toBe(beta0.key)
    expect(String(beta1.key)).toBe('/tmp/ws/beta-sakura-apprun')
  })
})

describe('📡 一覧: 破棄の口が無い公開先の行', () => {
  it('★★ レンタルサーバは TeardownRow（どの公開先の仕様書でも）ではなく、🗑 のボタンも出ない（押しても何も起きないボタンを並べない）。案内は出る', async () => {
    records = { ok: true, projects: [rentalProject('zeta')] }
    await openList()
    expect(teardownRows()).toHaveLength(0)
    expect(hooks.rendered.some(el => el.type === 'button' && textOf(el.props).includes('🗑'))).toBe(false)
    // 案内は ManualTeardownNote が描く（この代役は部品の中までは描かないので、部品を呼んで中身を見る）。
    const guides = hooks.rendered.filter(el => el.type === ManualTeardownNote && el.props.target === 'sakura-rental')
    expect(guides).toHaveLength(1)
    const before = hooks.rendered.length
    ManualTeardownNote(guides[0].props) // この代役の jsx は要素を記録して null を返す
    const drawn = hooks.rendered.slice(before)
    expect(drawn.some(el => el.type === 'p' && textOf(el.props).includes('Koto からは削除できません'))).toBe(true)
  })
})
