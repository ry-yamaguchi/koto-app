import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── 📡 公開したもの一覧が、専有型の行の部品（TeardownRow＋専有型の仕様書 dedicatedTeardownSpec）につなぐ配線を、振る舞いで固定する（2026-10-08 検分・0.6.22 3B-5 で向け直し）──────
//
// 3B-5: 専有型の行は、手本の DedicatedTeardownRow から共通の行 TeardownRow に替わった（見る先を向け直しただけ。期待を変えたのは V1・V9 に当たる所だけ。設計書 10.11.13）。
//   ・V1: 押し直しの呼び方が「この一覧の 🗑 削除」（旧「🗑 破棄」）・行のボタンが「🗑 削除」
//   ・V9: 保存場所だけが残った回は行が残るので、案内が「この行の「🗑 削除」をもう一度押すと…」（旧「この行は一覧から消えます。…手順6を押してください」）
//
// 検分で、この配線の多くを壊しても試験が1本も落ちないことが分かった:
//   ・onOutcome を空にする（結果欄が出ない＝残っている資源・課金の警告が利用者に届かない）
//   ・onFinished を空にする（終わっても一覧が読み直されない）
//   ・blocked を false に固定する／onBusyChange の setBusyKey を消す（別の行の 🗑 が止まらない）
//   ・行が確認ダイアログを描かない（🗑 が無反応になる）←これは tests/dedicatedTeardownEntries.test.ts の (E3)（TeardownRow の中身は tests/teardownHookCommon.test.ts の E-6）
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

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import PublishedListModal from '../src/renderer/components/PublishedListModal'
import TeardownRow from '../src/renderer/components/teardown/TeardownRow'
import TeardownResultView from '../src/renderer/components/teardown/TeardownResultView'
import { dedicatedTeardownSpec, DEDICATED_LIST_KEY_MISSING_MESSAGE } from '../src/renderer/teardown/targets/dedicated'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec } from '../src/renderer/teardown/targets/hanamii'
import { toTeardownView } from '../src/shared/teardownResult'
import { PUBLISH_TARGET_CONSOLE } from '../src/renderer/publishStatus'
import { CONTROL_PANEL_URL } from '../src/renderer/components/ServicePrincipalSection'
import type { TeardownFlowOutcome } from '../src/renderer/teardown/useTeardownFlow'

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
/** 専有型の行（TeardownRow のうち、専有型の仕様書を渡されているもの）。 */
const rows = () => hooks.rendered.filter(el => el.type === TeardownRow && el.props.spec === dedicatedTeardownSpec)
const rowOf = (name: string) => rows().find(el => el.props.entry.projectName === name)!
const textOf = (p: any): string => {
  const c = p?.children
  return (Array.isArray(c) ? c : [c]).filter(x => typeof x === 'string' || typeof x === 'number').join('')
}
const FAILED = toTeardownView('sakura-apprun-dedicated', {
  ok: false, executed: [], message: 'ロードバランサの削除に失敗しました',
  remaining: { loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' },
})
/** アプリ以下は消えたが、保存場所だけが残った（V9: 行は残る。main は保存場所まで片づくまで公開の記録を消さない）。 */
const STORAGE_ONLY = toTeardownView('sakura-apprun-dedicated', {
  ok: false, executed: [], message: '保存場所を削除できませんでした', remaining: { storageBucket: 'koto-data-x' }, appDeleted: true,
})
const outcomeOf = (view = FAILED): TeardownFlowOutcome => ({ view, notes: [] })

beforeEach(() => {
  store.set('sakura_workspace', '/tmp/ws')
  records = { ok: true, projects: [project('alpha'), project('beta')] }
  publishedRecordsCalls = 0
  spy.opened = []; spy.order = []
})
afterEach(() => { for (const c of mounted) { try { c() } catch { /* 片づけの失敗は無視 */ } } mounted = [] })

describe('📡 一覧 → 専有型の行（TeardownRow＋dedicatedTeardownSpec）の配線', () => {
  it('★ 専有型の記録が2件あれば、行の部品が2つ描かれる。どちらも最初は押せる（blocked:false）。専有型の仕様書と、📡 用のキー未登録の案内を渡す', async () => {
    await openList()
    expect(rows()).toHaveLength(2)
    expect(rows().map(r => r.props.blocked)).toEqual([false, false])
    expect(rows().map(r => r.props.keyMissingMessage)).toEqual([DEDICATED_LIST_KEY_MISSING_MESSAGE, DEDICATED_LIST_KEY_MISSING_MESSAGE])
    // 専有型の行に、HANAMII・共用型の仕様書を渡していない（取り違えない）
    expect(hooks.rendered.filter(el => el.type === TeardownRow && (el.props.spec === hanamiiTeardownSpec || el.props.spec === sharedTeardownSpec))).toHaveLength(0)
  })

  // V1: 専有型の行のボタンは「🗑 削除」（HANAMII・共用型は「🗑 破棄」のまま）。押し直しの呼び方も合わせる。
  it('★★ V1: 専有型の行のボタンは「🗑 削除」で、HANAMII・共用型の言葉は「🗑 破棄」のまま', () => {
    expect(dedicatedTeardownSpec.words.rowButton).toBe('🗑 削除')
    expect(hanamiiTeardownSpec.words.rowButton).toBe('🗑 破棄')
    expect(sharedTeardownSpec.words.rowButton).toBe('🗑 破棄')
  })

  it('★★★ 行の onOutcome を呼ぶと、一覧の上に結果欄（data-dedicated-outcome）が出て、HANAMII・共用型と同じ結果の部品（TeardownResultView）に結果が渡る', async () => {
    await openList()
    expect(hooks.rendered.some(el => el.props?.['data-dedicated-outcome'])).toBe(false)
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf())
    rerender()
    const box = hooks.rendered.find(el => el.props?.['data-dedicated-outcome'])
    expect(box, '結果欄が出ない（残っている資源・課金の警告が利用者に届かない）').toBeTruthy()
    const view = hooks.rendered.find(el => el.type === TeardownResultView)
    expect(view, '結果の部品が描かれない').toBeTruthy()
    expect(view!.props.view).toBe(FAILED)
    expect(view!.props.notes).toEqual([])
    expect(view!.props.words).toBe(dedicatedTeardownSpec.words)
    // V1: 押し直す場所の呼び方は「この一覧の 🗑 削除」。専有型の行のボタンの名前と同じ
    expect(view!.props.retryHint).toBe('この一覧の 🗑 削除')
    expect(view!.props.retryHint).toContain(dedicatedTeardownSpec.words.rowButton)
    // 管理画面の行き先: 公開先もコントロールパネルも、さくらのクラウドのコントロールパネル（専有型は同じ入口）
    expect(view!.props.serviceConsoleUrl).toBe(PUBLISH_TARGET_CONSOLE['sakura-apprun-dedicated'])
    expect(view!.props.storageConsoleUrl).toBe(CONTROL_PANEL_URL)
    // どのプロジェクトの結果かを見出しに出す（行が消えても残る）
    const heading = hooks.rendered.find(el => el.type === 'p' && textOf(el.props).includes('alpha'))
    expect(heading).toBeTruthy()
  })

  // 2026-10-08 検分 C: 保存場所だけが残ったあとの案内は「プロジェクトを開く」から手順6を押す、だったが、その時点で行は一覧から消えていて、
  // 案内した「プロジェクトを開く」ボタンがどこにも無かった。結果欄に「このプロジェクトを開く」を足し、行のボタンと同じ処理にする。
  it('★★★ 保存場所だけが残った結果欄に「このプロジェクトを開く」があり、行の「プロジェクトを開く」と同じ処理（onOpenProject(dir) → onClose）を呼ぶ。案内の文が指す名前と一致する', async () => {
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf(STORAGE_ONLY))
    rerender()
    const view = hooks.rendered.find(el => el.type === TeardownResultView)
    expect(view, '結果の部品が描かれない').toBeTruthy()
    const action = view!.props.storageRetryAction
    expect(action, '案内の下に出す「このプロジェクトを開く」ボタンが渡されていない').toBeTruthy()
    expect(action.label).toBe('このプロジェクトを開く')
    // V9: 保存場所だけが残った回は行が残る（main は保存場所まで片づくまで公開の記録を消さない）。案内は、この行のボタンでもう一度押すと言う。
    // 案内の文は、画面に実在するボタンの名前で言う（もう無いボタンを指さない）: 行のボタン（words.rowButton）と、専有型タブの手順6「すべて削除する」
    const hint: string = view!.props.storageRetryHint
    expect(hint).toBe('保存場所だけが残りました。この行の「🗑 削除」をもう一度押すと、残った保存場所だけを削除します。専有型タブの手順6「すべて削除する」からも削除できます。')
    expect(hint).toContain(`この行の「${dedicatedTeardownSpec.words.rowButton}」をもう一度押す`)
    expect(hint).not.toContain('破棄')
    expect(hint, '行が一覧から消えると言う旧い文へ戻っている').not.toContain('一覧から消えます')
    const panelFiles = ['src/renderer/components/AppRunDedicatedPanel.tsx', 'src/renderer/components/DedicatedTeardownSection.tsx']
    const panelSrc = panelFiles.filter(f => existsSync(join(__dirname, '..', f))).map(f => readFileSync(join(__dirname, '..', f), 'utf-8')).join('\n')
    expect(panelSrc, '案内が指す手順6のボタン「すべて削除する」が画面に無い').toContain('すべて削除する')

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
    beta.props.onOutcome(beta.props.entry, outcomeOf(STORAGE_ONLY))
    rerender()
    const view = hooks.rendered.find(el => el.type === TeardownResultView)
    spy.opened = []
    view!.props.storageRetryAction.onClick()
    expect(spy.opened).toEqual(['/tmp/ws/beta'])
  })

  it('★★★ 行の onBusyChange(true) で、ほかの行の 🗑 が止まる（blocked）。実行中の行自身は止めない。false で戻る。前の結果欄は片づく', async () => {
    await openList()
    const alpha = rowOf('alpha')
    alpha.props.onOutcome(alpha.props.entry, outcomeOf()) // 前の結果
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

// 3B の検分: 「一覧から削除」のツールチップは、全部の行で「先に「破棄」してください」と直書きだった。専有型の行のボタンは「🗑 削除」で食い違い、
// レンタルサーバ・Vercel の行には破棄のボタン自体が無い（V1 の言い換えは「🗑 破棄」の完全一致で数えたため、この言い回しは拾えていなかった）。
describe('「一覧から削除」のツールチップは、その行の公開先のボタン名で、先に消す操作を言う', () => {
  const HEAD = '記録だけを消します。公開したもの自体は消えません'
  const forgetTitle = (): string => {
    const b = hooks.rendered.find(el => el.type === 'button' && textOf(el.props).trim() === '一覧から削除')
    expect(b, '「一覧から削除」が描かれていない').toBeTruthy()
    return b!.props.title
  }
  const only = (target: string) => {
    records = { ok: true, projects: [{ dir: '/tmp/ws/p', name: 'p', publish: { targets: { [target]: { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://p.example.com/' } } } }] }
  }

  it.each([
    ['sakura-apprun-dedicated', dedicatedTeardownSpec, '「🗑 削除」'],
    ['sakura-apprun', sharedTeardownSpec, '「🗑 破棄」'],
    ['hanamii', hanamiiTeardownSpec, '「🗑 破棄」'],
  ] as const)('★★★ %s の行（🗑 がある）: 先に%sを押す、と言う。行のボタンの名前（words.rowButton）と同じ', async (target, spec, quoted) => {
    only(target)
    await openList()
    const row = hooks.rendered.find(el => el.type === TeardownRow && el.props.spec === spec)
    expect(row, `${target} の行が描かれていない`).toBeTruthy()
    hooks.rendered = []
    row!.props.render({ button: 'BTN', below: null, busy: false })
    expect(forgetTitle()).toBe(`${HEAD}（先に${quoted}を押してください）`)
    expect(forgetTitle()).toContain(`「${spec.words.rowButton}」`)
  })

  it.each(['vercel', 'sakura-rental'])('★★★ %s の行（🗑 が無い）: 存在しない「破棄」を指さず、上の案内に従うと言う', async (target) => {
    only(target)
    await openList()
    expect(hooks.rendered.filter(el => el.type === TeardownRow), '前提: この公開先に 🗑 は無い').toHaveLength(0)
    expect(forgetTitle()).toBe(`${HEAD}（先に上の案内のとおり、サービス側で消してください）`)
    expect(forgetTitle()).not.toContain('破棄')
  })
})
