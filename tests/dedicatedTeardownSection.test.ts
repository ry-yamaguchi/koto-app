import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階3B（3B-6a）: 専有型タブの手順6「作ったものを削除する」の節（components/DedicatedTeardownSection.tsx）を、偽の React の上で本物の流れに通す ──
// 設計書: docs/teardown-unify-plan.md の 10.11.9（D1 手順6）・10.11.14 の F-3、10.11.13 (A)（手順6を読む配線のテスト）。
// 画面が持つのは「押せる場所」と、画面の後始末の受け渡し（onStart・onDone）だけ。確認の文・窓を閉じる警告・キーの読み方・IPC の呼び形は、
// 共通の流れ（teardown/flow.ts）と専有型の仕様書（targets/dedicated.ts）が持つ。ここは、その流れを**節が正しい順序で通している**ことを、
// 本物の流れ・本物の仕様書・偽の window（electronAPI）で固定する（文字列は読まない。掟10）。
//   確認が no なら IPC・onStart・onDone・窓を閉じる警告は起きない／onStart は確認のあと・IPC の前に1回／二重押し・locked は何も起きない／
//   キー無し・例外・幽霊の行・プロジェクトの切り替え（stale）／進み具合の購読（subscribeProgress）と、節の見た目の出し分け

vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())

import { RT } from './appRunPanelRt'
import DedicatedTeardownSection from '../src/renderer/components/DedicatedTeardownSection'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import { DEDICATED_PANEL_KEY_MISSING_MESSAGE, DEDICATED_NOTHING_TO_DELETE_MESSAGE } from '../src/renderer/teardown/targets/dedicated'
import { toTeardownView, type TeardownView } from '../src/shared/teardownResult'

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise<void>(r => setTimeout(r, 0)); await Promise.resolve() } }
const until = async (cond: () => boolean, what: string) => {
  for (let k = 0; k < 200 && !cond(); k++) await settle()
  expect(cond(), what).toBe(true)
}

const FULL_RECORD = {
  clusterID: 'c-1', asgID: 'a-1', loadBalancerID: 'lb-1', applicationID: 'app-1', applicationName: 'myapp', activeVersion: 3, hosts: ['app.example.com'],
}
const KEY = { token: 'tok', secret: 'sec' }
const DONE_REPLY = { ok: true, executed: ['クラスタ『c-1』を削除しました'], message: '', remaining: {} }
const CLEARED = [false, '', false, '', '', '']
const ACTIVITY_ON = [true, '専有型クラスタの削除', true, '専有型クラスタの削除', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel]

// ── 偽の window ──────────────────────────────────────────────────────────────
let events: string[]
let ipcCalls: unknown[][]
let busy: unknown[][]
let record: any
let key: any
let reply: () => Promise<unknown>
let gate: { p: Promise<void>; open: () => void } | null
let progressCb: ((m: string) => void) | null
let placementsReply: any[]

function installWindow() {
  events = []; ipcCalls = []; busy = []; record = { ...FULL_RECORD }; key = { ...KEY }
  reply = async () => ({ ...DONE_REPLY }); gate = null; progressCb = null; placementsReply = []
  const w: any = new EventTarget()
  w.electronAPI = {
    apprunDedicated: {
      state: async () => record,
      teardown: async (...a: unknown[]) => {
        events.push('ipc'); ipcCalls.push(a)
        if (gate) await gate.p
        return reply()
      },
      onTeardownProgress: (cb: (m: string) => void) => { progressCb = cb; return () => { progressCb = null } },
    },
    cloud: { loadKey: async () => key },
    storage: { placement: async () => ({ ok: true, placements: placementsReply }) },
    // 確認の「ほかの公開先」の材料（記録は空＝ほかに公開先なし）。state.json は無い。
    fs: { readFile: async () => '{}', exists: async (p: string) => String(p).endsWith('/.sakuraide.json') },
    stageTiming: { estimates: async () => null },
    win: { setBusy: (...a: unknown[]) => { busy.push(a) } },
  }
  w.addEventListener = EventTarget.prototype.addEventListener.bind(w)
  w.removeEventListener = EventTarget.prototype.removeEventListener.bind(w)
  w.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(w)
  ;(globalThis as any).window = w
}

let opened: Array<{ close: () => void }> = []
beforeEach(() => { installWindow() })
afterEach(() => { for (const m of opened) m.close(); opened = []; delete (globalThis as any).window })

type Over = Record<string, unknown>
function mount(over: Over = {}) {
  const onStart = vi.fn(() => { events.push('onStart') })
  const onDone = vi.fn(async (_view: TeardownView, _stale: boolean) => { events.push('onDone') })
  const props: Over = {
    projectDir: '/tmp/proj-a', locked: false, showButton: true, tearingDown: false, running: false, runningRecord: null, nowMs: 0,
    apprunState: record, appRecord: null, summaryLines: [], view: null, notes: [], onStart, onDone, ...over,
  }
  const inst = RT.mount(DedicatedTeardownSection as any, props)
  const tree = () => RT.expand(inst.tree)
  const view = {
    inst, onStart, onDone,
    text: () => RT.textOf(tree()),
    button: (label: string) => {
      const hits = RT.findAll(tree(), (n: any) => n.type === 'button' && RT.textOf(n).includes(label))
      if (hits.length !== 1) throw new Error(`ボタン「${label}」が ${hits.length} 件（1件のはず）。いまの文字: ${RT.textOf(tree()).slice(0, 400)}`)
      return hits[0]
    },
    hasButton: (label: string) => RT.findAll(tree(), (n: any) => n.type === 'button' && RT.textOf(n).includes(label)).length > 0,
    confirm: (): { props: any } | null => RT.findAll(tree(), (n: any) => n.type === 'ConfirmModal' && n.props.open === true)[0] ?? null,
    progressBox: () => RT.findAll(tree(), (n: any) => n.type === 'TeardownProgress')[0] ?? null,
    setProps: (next: Over) => { RT.setProps(inst, { ...inst.props, ...next }) },
    close: () => { RT.unmount(inst) },
  }
  opened.push(view)
  return view
}
const press = (v: ReturnType<typeof mount>) => { v.button('すべて削除する').props.onClick() }
async function pressAndWaitConfirm(v: ReturnType<typeof mount>) {
  press(v)
  await until(() => v.confirm() !== null, '確認が出ない')
  return v.confirm()!
}

// ═══════════════════════════════════════════════════════════════════════════════
describe('手順6の節: 確認 → 実行は共通の流れを、決まった順序で通る', () => {
  it('★★★ 確認に「やめる」と答えたら、さくらへの要求も onStart も onDone も窓を閉じる警告も起きない', async () => {
    const v = mount()
    const c = await pressAndWaitConfirm(v)
    c.props.onCancel()
    await settle(); await settle()
    expect(ipcCalls, '確認をやめたのに削除の IPC を呼んだ').toEqual([])
    expect(v.onStart).not.toHaveBeenCalled()
    expect(v.onDone).not.toHaveBeenCalled()
    expect(busy, '確認をやめたのに窓を閉じる警告が載った').toEqual([])
    expect(v.confirm()).toBeNull()
    expect(await pressAndWaitConfirm(v)).not.toBeNull() // やめたあとは、もう一度押せる（二重押しの印が残っていない）
  })

  it('★★★ 確認の中身は共通の確認（題・ボタン・danger・消すものの名前・D10 の DNS の1行）。「削除する」と答えると、onStart → IPC（{confirmed:true} を1回）→ onDone の順', async () => {
    const v = mount()
    const c = await pressAndWaitConfirm(v)
    expect(c.props.title).toBe('専有型クラスタを削除します')
    expect(c.props.confirmLabel).toBe('削除する')
    expect(c.props.danger).toBe(true)
    expect(c.props.body).toContain("クラスタ『c-1』")
    expect(c.props.body).toContain('app.example.com の A レコード') // D10: ロードバランサが記録にあるとき、記録のホスト名で
    expect(ipcCalls, '確認の答えを待たずに IPC を呼んだ').toEqual([])
    expect(v.onStart, '確認の答えを待たずに画面へ「始まった」と知らせた').not.toHaveBeenCalled()
    c.props.onConfirm()
    await until(() => v.onDone.mock.calls.length === 1, 'onDone が呼ばれない')
    expect(events).toEqual(['onStart', 'ipc', 'onDone'])
    expect(ipcCalls).toEqual([['/tmp/proj-a', KEY, { confirmed: true }]])
    const [view, stale] = v.onDone.mock.calls[0] as [TeardownView, boolean]
    expect(stale).toBe(false)
    expect(view.ok).toBe(true)
    expect(view.state).toBe('done')
    expect(view.executed).toEqual(['クラスタ『c-1』を削除しました'])
    expect(busy).toEqual([ACTIVITY_ON, CLEARED]) // 窓を閉じる警告は IPC の間だけ載り、終わったら下りる
  })

  it('★★ IPC が失敗を返した回（ok:false）も、結果を onDone へ渡して終わる。窓を閉じる警告は必ず下りる', async () => {
    reply = async () => ({ ok: false, executed: [], message: 'アプリの削除に失敗しました', remaining: { applicationID: 'app-1' } })
    const v = mount()
    ;(await pressAndWaitConfirm(v)).props.onConfirm()
    await until(() => v.onDone.mock.calls.length === 1, 'onDone が呼ばれない')
    const [view] = v.onDone.mock.calls[0] as [TeardownView, boolean]
    expect(view.ok).toBe(false)
    expect(view.state).toBe('failed')
    expect(view.message).toContain('アプリの削除に失敗しました')
    expect(busy[busy.length - 1]).toEqual(CLEARED)
  })

  it('★★ 例外のときの文は素の message（専有型の流れに「破棄処理でエラーが発生しました」を出さない）。窓を閉じる警告は下りる', async () => {
    reply = async () => { throw new Error('ネットワークが切れました') }
    const v = mount()
    ;(await pressAndWaitConfirm(v)).props.onConfirm()
    await until(() => v.onDone.mock.calls.length === 1, 'onDone が呼ばれない')
    const [view, stale] = v.onDone.mock.calls[0] as [TeardownView, boolean]
    expect(stale).toBe(false)
    expect(view.state).toBe('failed')
    expect(view.message).toBe('ネットワークが切れました')
    expect(view.message).not.toContain('破棄処理でエラーが発生しました')
    expect(busy[busy.length - 1]).toEqual(CLEARED)
  })

  it('★★ キーが無い回（token か secret が空）は IPC を呼ばず、手順6の文（手順1で登録）で失敗を返す', async () => {
    for (const k of [null, { token: 'tok', secret: '' }, { token: '', secret: 'sec' }]) {
      installWindow(); key = k
      const v = mount()
      ;(await pressAndWaitConfirm(v)).props.onConfirm()
      await until(() => v.onDone.mock.calls.length === 1, `onDone が呼ばれない: ${JSON.stringify(k)}`)
      expect(ipcCalls, `キーが無いのに IPC を呼んだ: ${JSON.stringify(k)}`).toEqual([])
      const [view] = v.onDone.mock.calls[0] as [TeardownView, boolean]
      expect(view.message).toBe(DEDICATED_PANEL_KEY_MISSING_MESSAGE)
      expect(busy[busy.length - 1]).toEqual(CLEARED)
    }
  })

  it('★★★ 消すものが記録に無い行（幽霊の行）は、確認も IPC も窓を閉じる警告も出さず、「記録にありません」の案内で終わる', async () => {
    record = {}
    const v = mount({ apprunState: record })
    press(v)
    await until(() => v.onDone.mock.calls.length === 1, 'onDone が呼ばれない')
    expect(v.confirm(), '消すものが無いのに確認が出た').toBeNull()
    expect(ipcCalls).toEqual([])
    expect(busy).toEqual([])
    expect(v.onStart).not.toHaveBeenCalled()
    const [view] = v.onDone.mock.calls[0] as [TeardownView, boolean]
    expect(view.message).toBe(DEDICATED_NOTHING_TO_DELETE_MESSAGE)
  })

  it('★★ 二重押し: 確認を待つ間に押し直しても、確認も IPC も1回だけ', async () => {
    const v = mount()
    press(v)
    press(v)
    await until(() => v.confirm() !== null, '確認が出ない')
    press(v)
    v.confirm()!.props.onConfirm()
    await until(() => v.onDone.mock.calls.length === 1, 'onDone が呼ばれない')
    await settle(); await settle()
    expect(ipcCalls.length, '二重に IPC を呼んだ').toBe(1)
    expect(v.onStart).toHaveBeenCalledTimes(1)
    expect(v.onDone).toHaveBeenCalledTimes(1)
  })

  it('★★★ 実行中（IPC が返る前）に押し直しても、確認も二度目の IPC も出ない（二重押しの印は、流れの終わりまで立つ）', async () => {
    let open!: () => void
    gate = { p: new Promise<void>(r => { open = r }), open }
    const v = mount()
    ;(await pressAndWaitConfirm(v)).props.onConfirm()
    await until(() => ipcCalls.length === 1, 'IPC が呼ばれない')
    press(v)
    press(v)
    await settle(); await settle()
    expect(v.confirm(), '実行中に押し直したら、二度目の確認が出た').toBeNull()
    expect(ipcCalls.length, '実行中に押し直したら、二度目の IPC を呼んだ').toBe(1)
    expect(v.onStart).toHaveBeenCalledTimes(1)
    gate.open()
    await until(() => v.onDone.mock.calls.length === 1, 'onDone が呼ばれない')
    expect(v.onDone).toHaveBeenCalledTimes(1)
  })

  it('★★ 押せない間（locked）は、確認も出さず何も起きない（実行の入口が、ボタンの disabled とは別に止める）', async () => {
    const v = mount({ locked: true })
    expect(v.button('すべて削除する').props.disabled).toBe(true)
    press(v) // disabled を迂回して onClick を呼んでも、流れは始まらない
    await settle(); await settle()
    expect(v.confirm()).toBeNull()
    expect(ipcCalls).toEqual([])
    expect(v.onStart).not.toHaveBeenCalled()
    v.setProps({ locked: false }) // 押せるようになれば始まる（locked は最新の値を読む）
    const c = await pressAndWaitConfirm(v)
    expect(c).not.toBeNull()
  })

  it('★★ 待っている間にプロジェクトが切り替わったら、onDone に stale を渡す（前のプロジェクトの結果を画面へ入れさせない）。IPC は元のプロジェクトで呼ばれている', async () => {
    let open!: () => void
    gate = { p: new Promise<void>(r => { open = r }), open }
    const v = mount()
    ;(await pressAndWaitConfirm(v)).props.onConfirm()
    await until(() => ipcCalls.length === 1, 'IPC が呼ばれない')
    v.setProps({ projectDir: '/tmp/proj-b' })
    gate.open()
    await until(() => v.onDone.mock.calls.length === 1, 'onDone が呼ばれない')
    const [, stale] = v.onDone.mock.calls[0] as [TeardownView, boolean]
    expect(stale, '切り替わったのに stale が立たない').toBe(true)
    expect(ipcCalls[0][0], '削除は押したプロジェクトで呼ばれる').toBe('/tmp/proj-a')
    expect(busy[busy.length - 1]).toEqual(CLEARED)
  })

  it('★ 終わったあとは、もう一度押せる（二重押しの印が残らない）', async () => {
    const v = mount()
    ;(await pressAndWaitConfirm(v)).props.onConfirm()
    await until(() => v.onDone.mock.calls.length === 1, 'onDone が呼ばれない')
    const c = await pressAndWaitConfirm(v)
    c.props.onConfirm()
    await until(() => v.onDone.mock.calls.length === 2, '2回目の onDone が呼ばれない')
    expect(ipcCalls.length).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('手順6の節: 進み具合の購読（仕様書の subscribeProgress）', () => {
  it('★★ 届いた行は、実行中の節の進み具合に出る。実行が始まるたびに前回の行を消す。外れたら購読を解く', async () => {
    const v = mount({ tearingDown: true })
    await settle()
    expect(progressCb, '進み具合を購読していない').not.toBeNull()
    progressCb!('ロードバランサの削除を待っています（1分経過）')
    await settle()
    expect(v.progressBox()!.props.progress).toBe('ロードバランサの削除を待っています（1分経過）')
    // 次の削除が始まったら、前回の最後の1行は消える
    v.setProps({ tearingDown: false })
    ;(await pressAndWaitConfirm(v)).props.onConfirm()
    await until(() => v.onDone.mock.calls.length === 1, 'onDone が呼ばれない')
    v.setProps({ tearingDown: true })
    await settle()
    expect(v.progressBox()!.props.progress, '前回の進み具合の行が残っている').toBeNull()
    v.close()
    expect(progressCb, '外れたのに購読が残っている').toBeNull()
  })

  it('★ 記録が「削除が走っている」と言うときは、記録の文（別の窓で始めたものも読める）。走っていなければこの画面に届いた行', async () => {
    const rec = { startedAt: 1, progress: { label: '記録の文', stage: 'teardownLb' } }
    const v = mount({ tearingDown: true, running: true, runningRecord: rec })
    await settle()
    progressCb!('手元の文')
    await settle()
    expect(v.progressBox()!.props.progress).toContain('記録の文')
    expect(v.progressBox()!.props.running).toBe(true)
    v.setProps({ running: false, runningRecord: null })
    expect(v.progressBox()!.props.progress).toBe('手元の文')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
describe('手順6の節: 見た目の出し分け', () => {
  it('★ ボタンの文字と押せる条件: 実行中は「削除しています…」・locked の間は押せない', () => {
    const v = mount()
    expect(v.button('すべて削除する').props.disabled).toBe(false)
    expect(v.text()).toContain('⚠️ 消さない限り課金が続きます。この操作は元に戻せません。')
    v.setProps({ tearingDown: true, locked: true })
    expect(v.hasButton('すべて削除する')).toBe(false)
    expect(v.button('削除しています…').props.disabled).toBe(true)
  })

  it('★★ 消すものの一覧は記録（apprunState）から出す。アプリの行は appRecord が無くても出る（先頭・アプリ → LB → ASG → クラスタ）', () => {
    const v = mount()
    const t = v.text()
    expect(t).toContain('アプリ『myapp』（バージョン 3）')
    const order = ["アプリ『", "ロードバランサ『", "オートスケーリンググループ『", "クラスタ『"].map(k => t.indexOf(k))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('★★ 保存場所だけが残った記録は、一覧を出さず、残りの名前と押し直せることを言う（🗄️）。ボタンは出る', () => {
    record = { storageLeftoverBucket: 'koto-data-left', storageLeftoverBuckets: ['koto-data-left', 'koto-data-left2'] }
    const v = mount({ apprunState: record })
    const t = v.text()
    expect(v.hasButton('すべて削除する')).toBe(true)
    expect(t).toContain('🗄️ 保存場所『koto-data-left』『koto-data-left2』だけが残っています')
    expect(t).not.toContain('オートスケーリンググループ『')
    expect(t).not.toContain('クラスタ『')
  })

  it('★ 「いまの構成と月額目安」は、パネルが作った行（summaryLines）があるときだけ出す', () => {
    const a = mount({ summaryLines: [] })
    expect(a.text()).not.toContain('いまの構成と月額目安')
    const b = mount({ summaryLines: ['名前: myapp', '月額目安: 22,000円'] })
    expect(b.text()).toContain('いまの構成と月額目安')
    expect(b.text()).toContain('月額目安: 22,000円')
  })

  it('★★ 保存場所は全件、💾 の行で名指しする（用意した保存場所を読んで抱える）。読めた全件が出る', async () => {
    placementsReply = [
      { bucket: 'koto-data-aaa', prefix: 'projects/myapp/', shared: true },
      { bucket: 'koto-data-bbb', prefix: 'projects/myapp/', shared: true },
    ]
    const v = mount()
    await until(() => v.text().includes('koto-data-bbb'), '保存場所が出ない')
    const t = v.text()
    expect(t).toContain('koto-data-aaa')
    expect(t).toContain('💾')
    // 「保存場所が用意された」知らせで読み直す（開いたあとに用意されることがある）
    placementsReply = [placementsReply[0], placementsReply[1], { bucket: 'koto-data-ccc', prefix: 'projects/myapp/', shared: true }]
    window.dispatchEvent(new Event('sakura:storage-prepared'))
    await until(() => v.text().includes('koto-data-ccc'), '用意されたあとに読み直さない')
  })

  it('★★ 結果だけを出す（ボタンの条件が偽でも、結果は消えない）。✅ すべて削除しました・知らせ・コントロールパネルへの導線', () => {
    const view = toTeardownView('sakura-apprun-dedicated', { ...DONE_REPLY })
    const v = mount({ showButton: false, view })
    expect(v.hasButton('すべて削除する')).toBe(false)
    expect(v.text()).toContain('✅ すべて削除しました')
    expect(v.text()).toContain('クラスタ『c-1』を削除しました')
    expect(v.text()).not.toContain('消さない限り課金が続きます')
  })

  it('★ 失敗の結果には「🤖 AIに相談する」が出る。押すと専有型を指す相談の文が飛ぶ', () => {
    const asked: string[] = []
    const w = (globalThis as any).window
    const orig = w.dispatchEvent
    w.dispatchEvent = (e: any) => { if (e?.type === 'sakura:ask-ai') asked.push(String(e.detail?.text ?? '')); return orig(e) }
    const view = toTeardownView('sakura-apprun-dedicated', { ok: false, executed: [], message: '削除できませんでした（テスト）', remaining: { clusterID: 'c-1' } })
    const v = mount({ showButton: false, view })
    v.button('AIに相談する').props.onClick()
    expect(asked.length).toBe(1)
    expect(asked[0]).toContain('さくらのAppRun（専有型）')
    expect(asked[0]).toContain('削除できませんでした（テスト）')
  })
})

describe('手順6の節: 読み込みの前提（節は専有型のパネル本体を import しない）', () => {
  it('★ 節のファイルは AppRunDedicatedPanel を import しない（パネル → 節 → パネルの循環になる）。手本の流れ・手本の見た目も使わない', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer/components/DedicatedTeardownSection.tsx'), 'utf-8')
    const imports = [...src.matchAll(/^import[^'"\n]*from\s*['"]([^'"]+)['"]/gm)].map(m => m[1])
    expect(imports.length).toBeGreaterThan(5)
    for (const spec of imports) {
      expect(spec, `節が ${spec} を import している`).not.toMatch(/AppRunDedicatedPanel/)
      expect(spec).not.toMatch(/dedicatedTeardownFlow|useDedicatedTeardown|DedicatedTeardownView|DedicatedTeardownRow/)
    }
  })
})
