import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── 📡 公開したもの一覧が、専有型の行の部品（DedicatedTeardownRow）につなぐ配線を、振る舞いで固定する（2026-10-08 検分）──────
//
// 検分で、この配線の多くを壊しても試験が1本も落ちないことが分かった:
//   ・onOutcome を空にする（結果欄が出ない＝残っている資源・課金の警告が利用者に届かない）
//   ・onFinished を空にする（終わっても一覧が読み直されない）
//   ・blocked を false に固定する／onBusyChange の setBusyKey を消す（別の行の 🗑 が止まらない）
//   ・行が確認ダイアログを描かない（🗑 が無反応になる）←これは tests/dedicatedTeardownEntries.test.ts の (E3)
// 文字列の一致だけでは「そう書いてあるか」しか見えないので、一覧（PublishedListModal）を react の小さな代役の上で**実際に動かし**、
// 行に渡した props（onOutcome・onBusyChange・onFinished・blocked・render）を呼んで、一覧が何を描き直すかを見る。
//
// 代役のやり方は tests/placementAllPanels.test.ts と同じ（画面は作らず、**何を描いたか**＝type と props と key を残す）。

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  effects: [] as { fn: () => void | (() => void); deps: unknown[] | undefined }[],
  index: 0,
  /** 描いた要素（type・props・key）。 */
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

/** 📡 が読む公開の記録（`fs.publishedRecords` の中身）と、読まれた回数。 */
let records: any = { ok: true, projects: [] }
let publishedRecordsCalls = 0

function fakeElectronApi(): any {
  const anything: any = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: () => Promise.resolve({}),
  })
  return new Proxy({
    fs: new Proxy({ publishedRecords: async () => { publishedRecordsCalls++; return records } } as any, {
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
import DedicatedTeardownRow from '../src/renderer/components/DedicatedTeardownRow'
import { DedicatedTeardownResultView } from '../src/renderer/components/DedicatedTeardownView'
import type { DedicatedTeardownResult } from '../src/renderer/dedicatedTeardownFlow'

/** 「プロジェクトを開く」系のボタンが呼んだ順（onOpenProject → onClose）。 */
const spy = { opened: [] as string[], order: [] as string[] }
const props = {
  onClose: () => { spy.order.push('close') },
  onOpenProject: (dir: string) => { spy.opened.push(dir); spy.order.push('open') },
}

const project = (name: string) => ({
  dir: `/tmp/ws/${name}`, name,
  publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: '2026-09-28T00:00:00.000Z', url: `https://${name}.example.com/` } } },
})

let mounted: Array<() => void> = []
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}
async function openList(): Promise<void> {
  hooks.states = []; hooks.effects = []; hooks.index = 0; hooks.rendered = []
  PublishedListModal(props)
  for (const e of hooks.effects) {
    try { const c = e.fn(); if (typeof c === 'function') mounted.push(c) } catch { /* この画面の別の配線は見送る */ }
  }
  await settle()
  rerender()
}
/** 今の状態のまま描き直す（state は持ち越す。effect は回さない）。 */
function rerender(): void {
  hooks.index = 0; hooks.effects = []; hooks.rendered = []
  PublishedListModal(props)
}
const rows = () => hooks.rendered.filter(el => el.type === DedicatedTeardownRow)
const rowOf = (name: string) => rows().find(el => el.props.entry.projectName === name)!
const textOf = (p: any): string => {
  const c = p?.children
  return (Array.isArray(c) ? c : [c]).filter(x => typeof x === 'string' || typeof x === 'number').join('')
}
const FAILED: DedicatedTeardownResult = {
  ok: false, executed: [], message: 'ロードバランサの削除に失敗しました',
  remaining: { loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' },
}
/** アプリ以下は消えたが、保存場所だけが残った（アプリが消えた時点で main が公開の記録＝一覧の行を外すので、行はもう無い）。 */
const STORAGE_ONLY: DedicatedTeardownResult = {
  ok: false, executed: [], message: '保存場所を削除できませんでした', remaining: { storageBucket: 'koto-data-x' }, appDeleted: true,
}

beforeEach(() => {
  store.set('sakura_workspace', '/tmp/ws')
  records = { ok: true, projects: [project('alpha'), project('beta')] }
  publishedRecordsCalls = 0
  spy.opened = []; spy.order = []
})
afterEach(() => { for (const c of mounted) { try { c() } catch { /* 片づけの失敗は無視 */ } } mounted = [] })

describe('📡 一覧 → 専有型の行（DedicatedTeardownRow）の配線', () => {
  it('★ 専有型の記録が2件あれば、行の部品が2つ描かれる。どちらも最初は押せる（blocked:false）', async () => {
    await openList()
    expect(rows()).toHaveLength(2)
    expect(rows().map(r => r.props.blocked)).toEqual([false, false])
  })

  it('★★★ 行の onOutcome を呼ぶと、一覧の上に結果欄（data-dedicated-outcome）が出て、手順6と同じ結果の部品に結果が渡る', async () => {
    await openList()
    expect(hooks.rendered.some(el => el.props?.['data-dedicated-outcome'])).toBe(false)
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, { result: FAILED, notes: [] })
    rerender()
    const box = hooks.rendered.find(el => el.props?.['data-dedicated-outcome'])
    expect(box, '結果欄が出ない（残っている資源・課金の警告が利用者に届かない）').toBeTruthy()
    const view = hooks.rendered.find(el => el.type === DedicatedTeardownResultView)
    expect(view, '結果の部品が描かれない').toBeTruthy()
    expect(view!.props.result).toBe(FAILED)
    expect(view!.props.notes).toEqual([])
    expect(view!.props.retryHint).toBe('この一覧の 🗑 破棄')
    // どのプロジェクトの結果かを見出しに出す（行が消えても残る）
    const heading = hooks.rendered.find(el => el.type === 'p' && textOf(el.props).includes('alpha'))
    expect(heading).toBeTruthy()
  })

  // 2026-10-08 検分 C: 保存場所だけが残ったあとの案内は「プロジェクトを開く」から手順6を押す、だったが、その時点で行は一覧から消えていて、
  // 案内した「プロジェクトを開く」ボタンがどこにも無かった。結果欄に「このプロジェクトを開く」を足し、行のボタンと同じ処理にする。
  it('★★★ 保存場所だけが残った結果欄に「このプロジェクトを開く」があり、行の「プロジェクトを開く」と同じ処理（onOpenProject(dir) → onClose）を呼ぶ。案内の文が指す名前と一致する', async () => {
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, { result: STORAGE_ONLY, notes: [] })
    rerender()
    const view = hooks.rendered.find(el => el.type === DedicatedTeardownResultView)
    expect(view, '結果の部品が描かれない').toBeTruthy()
    const action = view!.props.storageRetryAction
    expect(action, '案内が指す「このプロジェクトを開く」ボタンが渡されていない').toBeTruthy()
    expect(action.label).toBe('このプロジェクトを開く')
    // 案内の文は、画面に実在するボタンの名前で言う（もう無いボタンを指さない）
    expect(view!.props.storageRetryHint).toContain(`「${action.label}」`)
    expect(view!.props.storageRetryHint).not.toContain('「プロジェクトを開く」から')

    spy.opened = []; spy.order = []
    action.onClick()
    expect(spy.opened).toEqual(['/tmp/ws/alpha'])
    expect(spy.order, '開いてから一覧を閉じる').toEqual(['open', 'close'])

    // 行の「プロジェクトを開く」と同じ処理（同じ順・同じ引数）
    spy.opened = []; spy.order = []
    hooks.rendered = []
    alpha.props.render({ button: 'BTN', below: 'BELOW', busy: false })
    const rowOpen = hooks.rendered.find(el => el.type === 'button' && textOf(el.props).trim() === 'プロジェクトを開く')
    expect(rowOpen, '行の「プロジェクトを開く」が無い').toBeTruthy()
    rowOpen!.props.onClick()
    expect(spy.opened).toEqual(['/tmp/ws/alpha'])
    expect(spy.order).toEqual(['open', 'close'])
  })

  it('★★ 結果欄のボタンが開くのは、その結果のプロジェクト（beta の結果なら beta）', async () => {
    await openList()
    const beta = rowOf('beta')
    beta.props.onOutcome(beta.props.entry, { result: STORAGE_ONLY, notes: [] })
    rerender()
    const view = hooks.rendered.find(el => el.type === DedicatedTeardownResultView)
    spy.opened = []
    view!.props.storageRetryAction.onClick()
    expect(spy.opened).toEqual(['/tmp/ws/beta'])
  })

  it('★★★ 行の onBusyChange(true) で、ほかの行の 🗑 が止まる（blocked）。実行中の行自身は止めない。false で戻る。前の結果欄は片づく', async () => {
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, { result: FAILED, notes: [] }) // 前の結果
    rerender()
    expect(hooks.rendered.some(el => el.props?.['data-dedicated-outcome'])).toBe(true)

    rowOf('alpha').props.onBusyChange(true)
    rerender()
    expect(rowOf('alpha').props.blocked, '実行中の行自身が止まっている').toBe(false)
    expect(rowOf('beta').props.blocked, '別の行の削除が走っているのに、この行の 🗑 が押せる').toBe(true)
    expect(hooks.rendered.some(el => el.props?.['data-dedicated-outcome']), '新しい削除が始まったのに前の結果が残っている').toBe(false)

    rowOf('alpha').props.onBusyChange(false)
    rerender()
    expect(rows().map(r => r.props.blocked)).toEqual([false, false])
  })

  it('★★ 別の行の onBusyChange(false) は、いま実行中の行の印を下ろさない（二重に走らせない）', async () => {
    await openList()
    rowOf('alpha').props.onBusyChange(true)
    rowOf('beta').props.onBusyChange(false) // beta は走っていない（アンマウントなどで呼ばれうる）
    rerender()
    expect(rowOf('beta').props.blocked).toBe(true)
  })

  it('★★ 行の onFinished を呼ぶと、一覧が公開の記録を読み直す（終わったら行が消える・残る、を反映する）', async () => {
    await openList()
    const before = publishedRecordsCalls
    await rowOf('alpha').props.onFinished()
    expect(publishedRecordsCalls, '終わっても一覧を読み直していない').toBe(before + 1)
  })

  it('★★ 行の本体（render）: 「一覧から削除」は、その行の削除が走っている間は押せない（削除の最中に公開の記録だけを消さない）', async () => {
    await openList()
    const forgetButtons = () => hooks.rendered.filter(el => el.type === 'button' && textOf(el.props).trim() === '一覧から削除')
    const alpha = rowOf('alpha')
    hooks.rendered = []
    alpha.props.render({ button: 'BTN', below: 'BELOW', busy: true })
    const busyBtn = forgetButtons()
    expect(busyBtn).toHaveLength(1)
    expect(busyBtn[0].props.disabled, '削除が走っているのに「一覧から削除」が押せる').toBe(true)
    hooks.rendered = []
    alpha.props.render({ button: 'BTN', below: 'BELOW', busy: false })
    expect(forgetButtons()[0].props.disabled).toBe(false)
  })

  it('★★ 行の key は添字を含めない（上の行が消えても、下の行の部品＝確認ダイアログ・フック状態が作り直されない）', async () => {
    await openList()
    const beta0 = rowOf('beta')
    // 上の行（alpha）が消えた再読み込み
    records = { ok: true, projects: [project('beta')] }
    await rowOf('alpha').props.onFinished()
    rerender()
    const beta1 = rowOf('beta')
    expect(rows()).toHaveLength(1)
    expect(beta1.key, '行の位置が変わって key が変わった（部品が作り直される）').toBe(beta0.key)
    expect(String(beta1.key)).toBe('/tmp/ws/beta-sakura-apprun-dedicated')
  })
})
