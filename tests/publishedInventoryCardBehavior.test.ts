import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// ── 📡 公開したもの一覧の「💰 さくら側にあるものと、かかっている費用」（棚卸し）のカードを、振る舞いで固定する（0.6.22 3B-5）──────
//
// 3B-5 で、カードを PublishedListModal.tsx から PublishedInventoryCard.tsx へ切り出した（設計書 10.9.10・10.11.9 の D2-5）。
// 切り出す前の検査（tests/inventory.test.ts）は文字列を読むだけで、次の2つの壊れ方を素通りした（変異試験で確かめた）:
//   ・画面を開いた時点でさくらへ問い合わせる（「押したときだけ問い合わせる」＝勝手に通信しない、が崩れる。`useEffect(() => { void runInventory() }, …)`）
//   ・問い合わせに Koto の記録（fs.publishedRecords の projects）を渡さない（全部が「Koto の記録にありません」と出て、心当たりのないものとして見える）
// 文字列の一致は「そう書いてあるか」しか見えないので、カードを react の小さな代役の上で**実際に動かし**、さくらへの問い合わせ（偽）の呼ばれ方を見る。
// 代役のやり方は tests/publishedListDedicatedRow.test.ts と同じ（画面は作らず、何を描いたか＝type と props を残す）。

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

/** fs.publishedRecords が返すもの（上書きして、記録を読めなかった回も作る）と、読まれた時の引数。 */
let records: any = { ok: true, projects: [] }
const recordsCalledWith: unknown[] = []
/** cloud.inventory（さくらへの問い合わせの偽）が受け取った引数。 */
const inventoryCalls: unknown[] = []
let inventoryReply: any = { ok: true, rows: [], totalYen: 0, notice: '' }
/** 文字列を入れると、cloud.inventory が投げる（通信そのものが失敗した回）。 */
let inventoryThrows: string | null = null

function fakeElectronApi(): any {
  const anything: any = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: () => Promise.resolve({}),
  })
  const own: any = {
    fs: { publishedRecords: async (dir: unknown) => { recordsCalledWith.push(dir); return records } },
    cloud: { inventory: async (projects: unknown) => { inventoryCalls.push(projects); if (inventoryThrows !== null) throw new Error(inventoryThrows); return inventoryReply } },
  }
  return new Proxy(own, { get: (t, key) => (key in t ? t[key] : anything) })
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

import PublishedInventoryCard from '../src/renderer/components/PublishedInventoryCard'

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}
/** カードを描き、開いた時点で走る effect をすべて回す（画面が開いた瞬間の動き）。 */
async function openCard(workspace = '/tmp/ws'): Promise<void> {
  hooks.states = []; hooks.effects = []; hooks.index = 0; hooks.rendered = []
  PublishedInventoryCard({ workspace })
  for (const e of hooks.effects) {
    try { e.fn() } catch { /* この画面の別の配線は見送る */ }
  }
  await settle()
}
/** 今の状態のまま描き直す（state は持ち越す。effect は回さない）。 */
function rerender(workspace = '/tmp/ws'): void {
  hooks.index = 0; hooks.effects = []; hooks.rendered = []
  PublishedInventoryCard({ workspace })
}
const textOf = (p: any): string => {
  const c = p?.children
  return (Array.isArray(c) ? c : [c]).filter(x => typeof x === 'string' || typeof x === 'number').join('')
}
const checkButton = () => hooks.rendered.find(el => el.type === 'button' && typeof el.props.onClick === 'function' && textOf(el.props).includes('調べ'))

const PROJECTS = [{ dir: '/tmp/ws/alpha', name: 'alpha', apprunState: { resources: [{ kind: 'apprun-app', id: 'app-1' }] } }]

beforeEach(() => {
  store.clear()
  records = { ok: true, projects: PROJECTS }
  recordsCalledWith.length = 0
  inventoryCalls.length = 0
  inventoryReply = { ok: true, rows: [], totalYen: 0, notice: '' }
  inventoryThrows = null
})

describe('📡 棚卸しのカード（PublishedInventoryCard）: 押したときだけ、Koto の記録を渡してさくらへ問い合わせる', () => {
  it('★★★ 画面を開いただけでは、記録も読まず、さくらへも問い合わせない（勝手に通信しない）', async () => {
    await openCard()
    expect(inventoryCalls, '開いた時点で、さくらへ問い合わせている').toEqual([])
    expect(recordsCalledWith, '開いた時点で、公開の記録を読んでいる').toEqual([])
    // 押せるボタンは出ている（押したときだけ調べる）
    expect(checkButton(), '「↻ 調べる」のボタンが無い').toBeTruthy()
  })

  it('★★★ 「↻ 調べる」を押すと、公開の記録（projects）をそのまま渡して、さくらへ1回だけ問い合わせる', async () => {
    await openCard()
    await checkButton()!.props.onClick()
    await settle()
    expect(recordsCalledWith).toEqual(['/tmp/ws'])
    expect(inventoryCalls).toHaveLength(1)
    // 記録を渡さないと、さくら側のものが全部「Koto の記録にありません」（心当たりが無ければ消せる）と出てしまう
    expect(inventoryCalls[0]).toBe(PROJECTS)
  })

  it('★★ 公開の記録を読めなかった回は、空の記録で問い合わせる（読めなかった記録を、あるものとして渡さない）', async () => {
    records = { ok: false, message: '読めません', projects: PROJECTS }
    await openCard()
    await checkButton()!.props.onClick()
    await settle()
    expect(inventoryCalls).toEqual([[]])
  })

  it('★★ 問い合わせが失敗したら、その文をカードに出す（黙って空にしない）', async () => {
    inventoryReply = { ok: false, message: 'さくらに接続できませんでした', rows: [] }
    await openCard()
    await checkButton()!.props.onClick()
    await settle()
    rerender()
    const shown = hooks.rendered.filter(el => el.type === 'p').map(el => textOf(el.props))
    expect(shown.some(t => t.includes('さくらに接続できませんでした'))).toBe(true)
  })

  it('★★ 問い合わせそのものが投げた回も、その文をカードに出す（黙って「見つかりませんでした」にしない）', async () => {
    inventoryThrows = 'ネットワークに接続できません'
    await openCard()
    await checkButton()!.props.onClick()
    await settle()
    rerender()
    const shown = hooks.rendered.filter(el => el.type === 'p').map(el => textOf(el.props))
    expect(shown.some(t => t.includes('ネットワークに接続できません'))).toBe(true)
    expect(shown.some(t => t.includes('費用のかかるものは見つかりませんでした')), '失敗を「0件」と読んでいる').toBe(false)
  })
})
