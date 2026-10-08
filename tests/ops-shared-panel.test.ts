import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'

// ── 共用型 AppRun: 閉じて開き直しても、進み具合と結果が続きから見える（2026-09-29・作者の決定 ②）──────────
//
// 公開・破棄の本体は main の1回の IPC で最後まで進み、記録も main が書く。だから**ダイアログを閉じても
// 処理は止まらない**。失われていたのは画面の表示だけ——進み具合・結果・警告（「保存場所が残ったので月額が
// 続きます」など）は、この画面の React の状態にしか無く、閉じて開き直すと消えた。
//
// ここで固定するのは、その**振る舞い**（ソースの文字列は読まない・掟10）:
//   ・偽の React（フックを実際に回し、状態の更新で描き直す小さな実行環境）で AppRunPanel を**本当に動かす**
//   ・main 側は**本物の projectOps.ts／projectLock.ts**（偽物ではなく、実際の記録・ack の意味どおり）
//   ・electronAPI だけ偽物（cloud.* と projectOps の受け口）
//   ・「閉じる」＝コンポーネントを外す（unmount）、「開き直す」＝新しく付け直す（mount）
//
// 見ているもの:
//   走っていれば進み具合が出る／終わっていれば結果と警告が出る／見た（閉じる）あとは出ない／
//   ほかの公開先・ほかのプロジェクトのものは出さず、巻き込んで「見た」ことにもしない（掟11）／
//   この画面が動かした操作の結果を二重に出さない／閉じている間に終わった公開の結果が、開き直すと出る。

/**
 * 偽の React。フックを回し、setState で描き直す（React 18 と同じく、更新はまとめて次のマイクロタスクで描く）。
 * 画面は作らない: jsx は `{ type, props }` を返すだけ。expand() で（フックを持たない）自作の部品だけを
 * 展開して、画面に出る文字・ボタンを読む。
 */
const RT = vi.hoisted(() => {
  const Fragment = Symbol('Fragment')
  type EffSlot = { kind: 'effect'; deps: unknown[] | undefined; cleanup?: () => void; first: boolean }
  class Inst {
    slots: any[] = []
    idx = 0
    mounted = true
    queued = false
    tree: any = null
    renders = 0
    queue: { slot: EffSlot; fn: () => void | (() => void) }[] = []
    constructor(public fn: (p: any) => any, public props: any) {}
  }
  let current: Inst | null = null
  const depsChanged = (a?: unknown[], b?: unknown[]) =>
    !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]))

  function renderOnce(inst: Inst) {
    current = inst
    inst.idx = 0
    inst.queue = []
    try { inst.tree = inst.fn(inst.props) } finally { current = null }
    inst.renders++
    const pend = inst.queue
    for (const q of pend) if (q.slot.cleanup) { const c = q.slot.cleanup; q.slot.cleanup = undefined; try { c() } catch { /* 解除の失敗は無視 */ } }
    for (const q of pend) { const c = q.fn(); q.slot.cleanup = typeof c === 'function' ? c : undefined }
  }
  function schedule(inst: Inst) {
    if (inst.queued) return
    inst.queued = true
    queueMicrotask(() => { inst.queued = false; if (inst.mounted) renderOnce(inst) })
  }
  const need = () => { if (!current) throw new Error('フックが描画の外で呼ばれた'); return current }

  const useState = (init: unknown) => {
    const inst = need()
    const i = inst.idx++
    if (!(i in inst.slots)) inst.slots[i] = { v: typeof init === 'function' ? (init as () => unknown)() : init }
    const slot = inst.slots[i]
    if (!slot.set) {
      slot.set = (nv: unknown) => {
        if (!inst.mounted) return // 外れたあとの更新は捨てる（React 18 と同じ）
        const next = typeof nv === 'function' ? (nv as (p: unknown) => unknown)(slot.v) : nv
        if (Object.is(next, slot.v)) return
        slot.v = next
        schedule(inst)
      }
    }
    return [slot.v, slot.set]
  }
  const useRef = (init: unknown) => {
    const inst = need()
    const i = inst.idx++
    if (!(i in inst.slots)) inst.slots[i] = { current: init }
    return inst.slots[i]
  }
  const useMemo = (fn: () => unknown, deps?: unknown[]) => {
    const inst = need()
    const i = inst.idx++
    const slot = inst.slots[i]
    if (!slot || depsChanged(slot.deps, deps)) inst.slots[i] = { deps, v: fn() }
    return inst.slots[i].v
  }
  const useCallback = (fn: unknown, deps?: unknown[]) => useMemo(() => fn, deps)
  const useEffect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const inst = need()
    const i = inst.idx++
    if (!(i in inst.slots)) inst.slots[i] = { kind: 'effect', deps: undefined, first: true } as EffSlot
    const slot = inst.slots[i] as EffSlot
    if (slot.first || depsChanged(slot.deps, deps)) {
      slot.deps = deps
      slot.first = false
      inst.queue.push({ slot, fn })
    }
  }

  const jsx = (type: unknown, props: any, key?: unknown) => ({ $$: 'el', type, props: props ?? {}, key })
  const jsxDEV = (type: unknown, props: any, key?: unknown) => jsx(type, props, key)

  function mount(fn: (p: any) => any, props: any): Inst {
    const inst = new Inst(fn, props)
    renderOnce(inst)
    return inst
  }
  function setProps(inst: Inst, props: any) {
    inst.props = props
    renderOnce(inst)
  }
  function unmount(inst: Inst) {
    if (!inst.mounted) return
    inst.mounted = false
    for (const s of inst.slots) if (s && s.kind === 'effect' && s.cleanup) { const c = s.cleanup; s.cleanup = undefined; try { c() } catch { /* 解除の失敗は無視 */ } }
  }

  /** フックを持たない自作の部品だけ展開する（OpResultView・StoppedResultView・WarningsBlock・CaptionLine・ConfirmDialog）。ほかの部品は箱のまま。 */
  const EXPAND = new Set(['OpResultView', 'StoppedResultView', 'WarningsBlock', 'CaptionLine', 'ConfirmDialog'])
  function expand(node: any): any {
    if (node == null || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(expand).filter(x => x !== null)
    if (node.$$ === 'el') {
      const { type, props } = node
      if (type === Fragment) return expand(props.children)
      if (typeof type === 'function' && EXPAND.has(type.name)) return expand(type(props))
      return { type: typeof type === 'string' ? type : (type?.name || 'Component'), props, kids: expand(props.children) }
    }
    return null
  }
  function textOf(n: any): string {
    if (n == null) return ''
    if (typeof n === 'string') return n
    if (Array.isArray(n)) return n.map(textOf).join('')
    return textOf(n.kids)
  }
  function findAll(n: any, pred: (x: any) => boolean, out: any[] = []): any[] {
    if (n == null || typeof n === 'string') return out
    if (Array.isArray(n)) { for (const c of n) findAll(c, pred, out); return out }
    if (pred(n)) out.push(n)
    findAll(n.kids, pred, out)
    return out
  }

  return { Fragment, useState, useRef, useMemo, useCallback, useEffect, jsx, jsxDEV, mount, setProps, unmount, expand, textOf, findAll }
})

vi.mock('react', () => ({
  useState: RT.useState, useRef: RT.useRef, useMemo: RT.useMemo, useCallback: RT.useCallback, useEffect: RT.useEffect,
  default: {},
}))
vi.mock('react/jsx-runtime', () => ({ jsx: RT.jsx, jsxs: RT.jsx, Fragment: RT.Fragment }))
vi.mock('react/jsx-dev-runtime', () => ({ jsxDEV: RT.jsxDEV, Fragment: RT.Fragment }))

// ── 偽の electronAPI（cloud.* と projectOps の受け口。projectOps の中身は本物の main 側の記録）────────

let mainOps: typeof import('../src/main/projectOps')
let mainLock: typeof import('../src/main/projectLock')
let Panel: (p: any) => unknown
let panelMod: typeof import('../src/renderer/components/AppRunPanel')
let costMod: typeof import('../src/shared/cloudCost')

const DIR = '/tmp/koto-ops-shared/proj-a'
const OTHER = '/tmp/koto-ops-shared/proj-b'

/** 呼ばれた記録（検査の対象）。 */
const log = {
  acks: [] as Array<[string, number | undefined]>,
  gets: [] as string[],
  cloud: [] as string[],
  applyArgs: [] as unknown[],
  progressCbs: new Set<(m: string) => void>(),
}
/** onChanged の購読（解除されたかを見る）。 */
const subs = new Set<(p: any) => void>()
/** get を遅らせたいテスト用（null なら即答）。 */
let getGate: { promise: Promise<void>; snapshotOverride?: () => unknown } | null = null

/** 公開・破棄・片づけを「終わらせない」ための門（テストが開ける）。 */
type Gate = { promise: Promise<void>; open: () => void }
const newGate = (): Gate => { let open!: () => void; const promise = new Promise<void>(r => { open = r }); return { promise, open } }
let applyGate: Gate | null = null
let teardownGate: Gate | null = null
let cleanupGate: Gate | null = null
let applyValue: Record<string, unknown> = { ok: true, executed: ['アプリを更新'], message: '公開しました' }
let teardownValue: Record<string, unknown> = { ok: true, executed: ['アプリを削除'], keptBucketName: null }

const SPEC = {
  name: 'myapp', backend: 'apprun', region: 'is1a',
  service: { port: 8080, source: { type: 'image', ref: 'x' }, scale: { min: 0, max: 10 } },
  persistence: { objectStorage: [] }, guardrails: { ttlHours: 0 },
}

function installWindow() {
  const called = (name: string, v: unknown) => async () => { log.cloud.push(name); return v }
  const cloud: any = {
    hasKey: called('hasKey', true),
    loadEnv: called('loadEnv', { ok: true, spec: SPEC }),
    checkPrereqs: called('checkPrereqs', { sourceType: 'image', builderMode: 'builtin', builder: true, registry: true }),
    checkExpiry: called('checkExpiry', { ok: true, expired: false, createdAt: null, ttlHours: 0 }),
    appUrl: called('appUrl', { ok: true, url: null }),
    isPublished: called('isPublished', { ok: true, published: false }),
    getAccessLimit: called('getAccessLimit', { ok: true, deployed: false }),
    registryName: called('registryName', { ok: true, name: 'koto-reg', adopted: false }),
    preflight: called('preflight', { ok: true, canPublish: true, summary: '確認できました', checks: [] }),
    plan: called('plan', {
      ok: true,
      plan: { actions: [{ type: 'update', kind: 'apprun-app', name: 'myapp', description: 'アプリを更新' }], hasDestructive: false, hasStatefulDelete: false },
    }),
    getTraffics: called('getTraffics', { ok: true, state: { kind: 'latest' } }),
    onApplyProgress: (cb: (m: string) => void) => { log.progressCbs.add(cb); return () => { log.progressCbs.delete(cb) } },
    // 本物の projectLock を通す（＝本物の記録が作られる）。走っている間は門で止める
    apply: async (dir: string, opts: unknown) => {
      log.cloud.push('apply'); log.applyArgs.push(opts)
      // 本物と同じ送り口（記録の更新＋従来の進捗チャンネル）
      const progress = mainOps.progressReporter(dir, m => { for (const cb of [...log.progressCbs]) cb(m) })
      const r = await mainLock.withProjectLock(dir, '公開', async () => {
        progress('🚀 AppRun に反映しています…')
        if (applyGate) await applyGate.promise
        return applyValue
      }, { target: 'sakura-apprun', handler: 'cloud:apply' })
      return r.busy ? { ok: false, message: mainLock.projectBusyMessage(r.running) } : r.value
    },
    teardown: async (dir: string) => {
      log.cloud.push('teardown')
      const progress = mainOps.progressReporter(dir)
      const r = await mainLock.withProjectLock(dir, '削除', async () => {
        progress('🗑 公開したものを削除しています…')
        if (teardownGate) await teardownGate.promise
        return teardownValue
      }, { target: 'sakura-apprun', handler: 'cloud:teardown' })
      return r.busy ? { ok: false, message: mainLock.projectBusyMessage(r.running) } : r.value
    },
    // 片づけ: 1回目（confirmed なし）は計画だけ、2回目（confirmed）は門で止めてから消したことにする
    cleanupImages: async (_dir: string, opts?: { confirmed?: boolean }) => {
      log.cloud.push(opts?.confirmed ? 'cleanup-confirmed' : 'cleanup-plan')
      if (!opts?.confirmed) return { ok: true, plan: { remove: ['v1', 'v2'], keep: ['v3'], untouched: [] }, keep: 5, currentTag: 'v3' }
      if (cleanupGate) await cleanupGate.promise
      return { ok: true, message: '2件のイメージを片づけました。' }
    },
  }
  const api: any = {
    cloud,
    storage: { placement: async () => ({ ok: true, placements: [] }) },
    fs: { readFile: async () => '{}', trash: async () => {} },
    publishMeta: { forgetTarget: async () => ({ ok: true, meta: {} }) },
    win: { setBusy: () => {} },
    secure: { decrypt: async () => '' },
    projectOps: {
      get: async (dir: string) => {
        log.gets.push(dir)
        if (getGate) { await getGate.promise; if (getGate.snapshotOverride) return getGate.snapshotOverride() }
        return mainOps.getOps(dir)
      },
      ack: async (dir: string, upTo?: number) => {
        log.acks.push([dir, upTo])
        return { ok: true, acked: mainOps.ackOps(dir, upTo) }
      },
      onChanged: (cb: (p: any) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
    },
  }
  const store = new Map<string, string>()
  const win: any = new EventTarget()
  win.electronAPI = api
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
}

// 動かす場所が画面ではないので、拾われなかった Promise は無視する
const onUnhandled = () => {}
beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)
  installWindow()
  mainOps = await import('../src/main/projectOps')
  mainLock = await import('../src/main/projectLock')
  costMod = await import('../src/shared/cloudCost')
  panelMod = await import('../src/renderer/components/AppRunPanel')
  Panel = panelMod.default as unknown as (p: any) => unknown
})
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

// ── 画面を動かす道具 ───────────────────────────────────────────────────────────

type Mounted = ReturnType<typeof mountPanel>
let opened: Mounted[] = []

/** 描いて・effect を回して・非同期の読み込みが落ち着くまで待つ。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); await Promise.resolve() }
}

/** 「開く」。`visible` は、共用型のタブが目の前に出ているか（隠れているタブのパネルは、隠れたまま付いている）。 */
function mountPanel(projectDir: string = DIR, opts: { visible?: boolean } = {}) {
  let visible = opts.visible ?? true
  let dir = projectDir
  const inst = RT.mount(Panel, { apiKey: 'k', projectDir, onOpenCredentials: () => {}, visible })
  const view = {
    inst,
    tree: () => RT.expand(inst.tree),
    text: () => RT.textOf(RT.expand(inst.tree)),
    buttons: () => RT.findAll(RT.expand(inst.tree), (n: any) => n.type === 'button'),
    /** ラベルに文字を含むボタン（1つだけであること）。 */
    button: (label: string) => {
      const hits = RT.findAll(RT.expand(inst.tree), (n: any) => n.type === 'button' && RT.textOf(n).includes(label))
      if (hits.length !== 1) throw new Error(`ボタン「${label}」が ${hits.length} 件（1件のはず）。いまの文字: ${RT.textOf(RT.expand(inst.tree)).slice(0, 600)}`)
      return hits[0]
    },
    /** 「閉じる」。 */
    close: () => { RT.unmount(inst) },
    /** 同じ画面のまま、別のプロジェクトへ切り替わる（props が変わる）。 */
    async switchTo(projectDir: string) { dir = projectDir; RT.setProps(inst, { apiKey: 'k', projectDir, onOpenCredentials: () => {}, visible }); await settle() },
    /** タブが隠れた／また目の前に出た（パネルは外さずに、渡す visible だけが変わる）。 */
    async setVisible(v: boolean) { visible = v; RT.setProps(inst, { apiKey: 'k', projectDir: dir, onOpenCredentials: () => {}, visible }); await settle() },
    async click(label: string) { view.button(label).props.onClick(); await settle() },
  }
  opened.push(view)
  return view
}

/** main 側で記録を作る（本物の projectOps）。 */
function mainStart(dir: string, op: '公開' | '削除' | '作成', target: string, handler: string, progress?: string) {
  mainOps.beginOp(dir, op, { target: target as any, handler })
  if (progress) mainOps.reportProgress(dir, progress)
}
function mainFinish(dir: string, value: Record<string, unknown>) {
  mainOps.finishOp(dir, { value })
}
/** 開始から終了まで一気に（画面が閉じている間に終わったことにする）。 */
function mainRun(dir: string, op: '公開' | '削除' | '作成', target: string, handler: string, value: Record<string, unknown>) {
  mainStart(dir, op, target, handler)
  mainFinish(dir, value)
}

beforeEach(() => {
  mainOps.resetProjectOpsForTests()
  panelMod.resetCleanupJobsForTests()
  subs.clear()
  mainOps.setProjectOpsListener((dir, snap) => { for (const cb of [...subs]) cb({ projectDir: dir, ...snap }) })
  log.acks = []; log.gets = []; log.cloud = []; log.applyArgs = []; log.progressCbs.clear()
  getGate = null; applyGate = null; teardownGate = null; cleanupGate = null
  applyValue = { ok: true, executed: ['アプリを更新'], message: '公開しました' }
  teardownValue = { ok: true, executed: ['アプリを削除'], keptBucketName: null }
})
afterEach(() => {
  for (const m of opened) m.close()
  opened = []
  mainOps.setProjectOpsListener(null)
})

// 保存場所とレジストリが残った破棄の結果（警告の文は、画面が使う remainingCostWarning そのもの）
const KEPT = { ok: true, executed: ['アプリを削除'], keptBucketName: 'koto-data-x', keptRegistryName: 'koto-reg', message: '保存場所にあった、このプロジェクトのデータを削除しました。' }
const keptWarning = () => costMod.remainingCostWarning({ deleteRegistry: false, registryName: 'koto-reg', keptBucketName: 'koto-data-x' }) as string
// 警告の無い破棄の結果。**警告つきの結果（KEPT）は、画面が出しても「見た」と伝えない**（上部の「結果を確認しました」まで残す・
// 2026-09-30 検分）ので、「見たと伝わる／出し直さない」を確かめるテストは、警告の無い結果で行う。
const PLAIN_DELETED = { ok: true, executed: ['アプリを削除'], keptBucketName: null, message: '破棄が終わりました（テスト用）' }
const PLAIN_DELETED_TEXT = '破棄が終わりました（テスト用）'

// ═══════════════════════════════════════════════════════════════════════════
// ① 走っていれば、進み具合が出る
// ═══════════════════════════════════════════════════════════════════════════
describe('開き直したとき: 走っていれば、busy と進み具合が出る', () => {
  it('★ 走っている公開の「いまやっていること」が出て、公開・破棄・片づけは押せない', async () => {
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 AppRun に反映しています…')
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('公開が進んでいます')
    expect(v.text()).toContain('🚀 AppRun に反映しています…')
    // 押せない（同じプロジェクトの同時実行は main も断る。押させない）
    expect(v.button('🚀 公開する').props.disabled, '公開ボタンが押せてしまう').toBe(true)
    expect(v.button('破棄する（削除）').props.disabled, '破棄ボタンが押せてしまう').toBe(true)
    expect(v.button('古いイメージを片づける').props.disabled, '片づけボタンが押せてしまう').toBe(true)
  })

  it('★ 開いている間は、進み具合が知らせで置き換わる（購読を続ける）', async () => {
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 AppRun に反映しています…')
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('AppRun に反映しています')
    mainOps.reportProgress(DIR, '🩺 アプリが動いているか確かめています…')
    await settle()
    expect(v.text()).toContain('アプリが動いているか確かめています')
    expect(v.text(), '古い進み具合が残っている').not.toContain('AppRun に反映しています')
  })

  it('★★ 走っていた操作が開いている間に終わると、結果が出て、押せるようになる', async () => {
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 AppRun に反映しています…')
    const v = mountPanel()
    await settle()
    mainFinish(DIR, { ok: true, message: '公開しました', url: 'https://x.example/' })
    await settle()
    expect(v.text()).not.toContain('が進んでいます')
    expect(v.text()).toContain('公開の結果')
    expect(v.text()).toContain('完了しました')
    expect(v.text()).toContain('公開しました')
    expect(v.button('🚀 公開する').props.disabled, '終わったのに押せないまま').toBe(false)
  })

  it('★ 閉じたあとは知らせを聞かない（購読を解除する）', async () => {
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 …')
    const v = mountPanel()
    await settle()
    expect(subs.size).toBe(1)
    v.close()
    expect(subs.size, '閉じたあとも購読が残っている').toBe(0)
  })

  it('★ 閉じて→終わって→開き直すと、終わった結果が出る（中核の道筋）', async () => {
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 AppRun に反映しています…')
    const first = mountPanel()
    await settle()
    expect(first.text()).toContain('公開が進んでいます')
    first.close()
    mainFinish(DIR, { ok: true, message: '公開しました', url: 'https://x.example/' })
    const second = mountPanel()
    await settle()
    expect(second.text()).toContain('公開の結果')
    expect(second.text()).toContain('公開しました')
    expect(second.text()).not.toContain('が進んでいます')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ② 終わっていれば、結果と警告が出る
// ═══════════════════════════════════════════════════════════════════════════
describe('開き直したとき: 終わっていれば、結果と警告が出る', () => {
  it('★★ 破棄で残ったもの（月額が続く）の警告を、見逃さず出す', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', KEPT)
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('破棄の結果')
    expect(v.text(), '課金が続く警告が出ていない').toContain(keptWarning())
    expect(v.text()).toContain('koto-data-x')
    expect(v.text()).toContain('koto-reg')
    expect(v.text()).toContain('課金は続きます')
  })

  it('失敗した結果は、失敗として出す（うまくいったことにしない）', async () => {
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: false, message: 'レジストリに push できませんでした' })
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('失敗しました')
    expect(v.text()).toContain('レジストリに push できませんでした')
    expect(v.text()).not.toContain('完了しました')
  })

  it('例外で止まった公開も、失敗として出る', async () => {
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply')
    mainOps.finishOp(DIR, { error: new Error('ネットワークが切れました') })
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('失敗しました')
    expect(v.text()).toContain('ネットワークが切れました')
  })

  it('★★ 見ていない結果が2件あるとき、前のものの警告も見逃さない', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', KEPT) // 警告つき（前）
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '公開しました' }) // その後の公開（新しい）
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('公開しました')
    expect(v.text(), '新しい結果に隠れて、前の警告が消えている').toContain(keptWarning())
    expect(v.text()).toContain('破棄の結果')
    expect(v.text()).toContain('公開の結果')
  })

  it('★ 見ていない結果が複数あるとき、いちばん新しいものが先（主）で、前のものはその次に出る', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', KEPT) // 前
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '公開しました' }) // 新しい
    const v = mountPanel()
    await settle()
    const t = v.text()
    expect(t.indexOf('公開の結果'), '新しい結果が前の結果より後ろに出ている').toBeLessThan(t.indexOf('破棄の結果'))
  })

  it('開き直した結果は、画面のいちばん上（⑥ より前）に出す — 下までスクロールしないと見逃す', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', KEPT)
    const v = mountPanel()
    await settle()
    const t = v.text()
    expect(t.indexOf('破棄の結果')).toBeGreaterThan(-1)
    expect(t.indexOf('② 公開の設定'), '目印の見出しが見つからない').toBeGreaterThan(-1)
    expect(t.indexOf('破棄の結果'), '結果が ② より下に出ている').toBeLessThan(t.indexOf('② 公開の設定'))
  })

  it('★ 起動のしかたを選ぶ段階で止まった公開は、失敗と言わず、押し直す案内を出す（選ぶ画面は出さない）', async () => {
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', {
      ok: false,
      message: '起動のしかたが、さくら側と Koto の設定で違います。どちらで公開するか選んでください。',
      needsScaleDecision: { appId: 'app-1', recorded: 0, actual: 1 },
    })
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('起動のしかたを選ぶ段階で止まりました')
    expect(v.text()).toContain('もう一度「公開する」を押してください')
    expect(v.text(), '失敗と言っている').not.toContain('失敗しました')
    // 選ぶ画面（確認を通らずに公開を呼び直す口）は開き直しでは出さない
    expect(v.text()).not.toContain('Koto の設定で公開する')
    expect(log.cloud).not.toContain('apply')
  })

  it('起動を確認できなかった公開は、回復の導線（↻ 更新・AIに調べてもらう）まで続きから出る', async () => {
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', {
      ok: false, message: 'アプリの起動を確認できていません', hint: 'app-unhealthy', pending: true,
      logUrl: 'https://secure.sakura.ad.jp/cloud/logs', askAi: '起動しないので相談',
    })
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('アプリの起動をまだ確認できていません')
    expect(v.text()).toContain('↻ 更新')
    expect(v.text()).toContain('AIに調べてもらう')
    expect(v.text()).toContain('さくらのコントロールパネルでログを見る')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ③ 見た（閉じる・次の操作）あとは出ない
// ═══════════════════════════════════════════════════════════════════════════
describe('見たら「見た」と伝え、そのあとは出ない', () => {
  it('★★ 結果を出している間は、まだ「見た」と伝えない（出しただけ・閉じるまでは残す）', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', KEPT)
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain(keptWarning())
    expect(log.acks, '出した瞬間に「見た」と伝えている（見る前に消える）').toEqual([])
    expect(mainOps.getOps(DIR).last, '出している間に main の記録が消えている').not.toBeNull()
  })

  it('★★★ 閉じると、出した記録の startedAt まで「見た」と伝え、開き直しても出ない（警告なしの結果）', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', PLAIN_DELETED)
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    const first = mountPanel()
    await settle()
    expect(first.text()).toContain(PLAIN_DELETED_TEXT)
    first.close()
    await settle()
    expect(log.acks, '閉じても「見た」と伝えていない（次に開くたび同じ結果が出る）').toEqual([[DIR, startedAt]])
    expect(mainOps.getOps(DIR).last).toBeNull()
    const second = mountPanel()
    await settle()
    expect(second.text(), '見たあとも同じ結果が出ている').not.toContain('破棄の結果')
    expect(second.text()).not.toContain(PLAIN_DELETED_TEXT)
  })

  // 結果は画面のいちばん上に出す（下のテスト）が、警告つきの結果は、閉じたときにも「見た」と伝えない
  // （2026-09-30 検分）。上部の「結果を確認しました」（PublishModal）を押したときにだけ見たことになる。
  it('★★★ 警告つきの結果（月額が続く）は、閉じても「見た」と伝えない。開き直すたびに出る（上部の確認まで）', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', KEPT)
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    const first = mountPanel()
    await settle()
    expect(first.text()).toContain(keptWarning())
    first.close()
    await settle()
    expect(log.acks, '警告つきの結果を、画面を閉じたときに「見た」と伝えた（確認していないのに、二度と出なくなる）').toEqual([])
    expect(mainOps.getOps(DIR).last?.startedAt, '警告つきの記録が main から消えた').toBe(startedAt)
    const second = mountPanel()
    await settle()
    expect(second.text(), '確認しないまま閉じたのに、開き直すと月額が続く警告が消えている').toContain(keptWarning())
    second.close()
    await settle()
    // 上部の「結果を確認しました」が伝える ack（見せた記録の startedAt まで）
    mainOps.ackOps(DIR, startedAt)
    const third = mountPanel()
    await settle()
    expect(third.text(), '確認したのに、また出る').not.toContain(keptWarning())
  })

  it('★ 結果を出していなければ、閉じても ack しない（何も見ていない）', async () => {
    const v = mountPanel()
    await settle()
    v.close()
    await settle()
    expect(log.acks).toEqual([])
  })

  it('★★ 2件出したなら、閉じたとき2件とも「見た」ことになる（新しいほうの startedAt まで）', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', PLAIN_DELETED)
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '公開しました' })
    const newest = mainOps.getOps(DIR).last!.startedAt
    const v = mountPanel()
    await settle()
    v.close()
    await settle()
    expect(log.acks).toEqual([[DIR, newest]])
    expect(mainOps.getOps(DIR)).toEqual({ running: null, last: null, earlier: [] })
  })

  it('★ 次の操作（公開）を始めたら、出していた結果は消え、「見た」と伝わる（警告なしの結果）', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', PLAIN_DELETED)
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain(PLAIN_DELETED_TEXT)
    applyGate = newGate()
    await v.click('公開する')
    expect(v.text(), '次の操作を始めたのに前の結果が残っている').not.toContain(PLAIN_DELETED_TEXT)
    expect(log.acks).toContainEqual([DIR, startedAt])
    applyGate.open()
    await settle()
  })

  it('★★ 次の操作（公開）を始めても、警告つきの結果は「見た」と伝えない（画面からは消える。上部の確認まで main に残る）', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', KEPT)
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain(keptWarning())
    applyGate = newGate()
    await v.click('公開する')
    expect(v.text()).not.toContain(keptWarning())
    expect(log.acks, '警告つきの結果を、次の操作を始めただけで見たことにした').toEqual([])
    expect(mainOps.getOps(DIR).earlier.concat(mainOps.getOps(DIR).last ? [mainOps.getOps(DIR).last!] : []).some(r => r.startedAt === startedAt)).toBe(true)
    applyGate.open()
    await settle()
  })

  it('開いたまま、同じ結果を何度も出し直さない（ack 前の知らせが来ても、出した結果は増えない）', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', KEPT)
    const v = mountPanel()
    await settle()
    // 別の操作が始まって終わる知らせが届いても、前の結果を重ねて出さない
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply')
    await settle()
    mainFinish(DIR, { ok: true, message: '2回目の公開' })
    await settle()
    const t = v.text()
    expect(t.split('破棄の結果').length - 1, '同じ結果が2回出ている').toBe(1)
    expect(t).toContain(keptWarning())
    expect(t).toContain('2回目の公開')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 隠れているタブのパネルは、結果を「見た」に数えない（2026-09-30 検分）
//   共用型・専有型のタブは、切り替えても**パネルを外さずに隠す**（PublishModal）。隠れている間に終わった結果は、
//   画面の状態には入っても利用者は見ていない。以前は、隠れたままでも閉じるとき ack していたので、見ないまま閉じると
//   開き直しても出なかった。
// ═══════════════════════════════════════════════════════════════════════════
describe('★★★ 隠れているタブ（visible: false）では、出した結果を「見た」に数えない', () => {
  it('★★★ 隠れている間に終わった結果: 画面の状態には入るが、閉じても ack しない。main の記録に残り、開き直すと出る', async () => {
    const v = mountPanel(DIR, { visible: false })          // 専有型のタブを見ている（共用型のパネルは隠れて付いている）
    await settle()
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '隠れている間の公開結果' })
    await settle()
    expect(v.text(), '前提: 画面の状態には入っている').toContain('隠れている間の公開結果')
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    v.close()
    await settle()
    expect(log.acks, '隠れたタブが、利用者が見ていない結果を、閉じるときに「見た」と伝えた').toEqual([])
    expect(mainOps.getOps(DIR).last?.startedAt).toBe(startedAt)

    const again = mountPanel(DIR)                            // 開き直す（共用型のタブが目の前）。同じ結果が出る
    await settle()
    expect(again.text()).toContain('隠れている間の公開結果')
    again.close()
    await settle()
    expect(log.acks, '目の前で出した結果は、閉じるときに見たことになる').toEqual([[DIR, startedAt]])
  })

  it('★★★ 隠れている間に出した結果は、タブがまた出たあと（見えるようになったあと）に閉じれば、見たことになる', async () => {
    const v = mountPanel(DIR, { visible: false })
    await settle()
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '隠れている間の公開結果' })
    await settle()
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    await v.setVisible(true)                                 // 共用型のタブへ移った＝結果が目に入る
    v.close()
    await settle()
    expect(log.acks).toEqual([[DIR, startedAt]])
    expect(mainOps.getOps(DIR).last).toBeNull()
  })

  it('★★ 出たあとにまた隠れても、見たものは取り消さない。隠れている間に届いた分だけ、見たことにしない', async () => {
    const v = mountPanel(DIR, { visible: true })
    await settle()
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', PLAIN_DELETED)
    await settle()
    const seen = mainOps.getOps(DIR).last!.startedAt
    await v.setVisible(false)
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '隠れている間の公開結果' })
    await settle()
    v.close()
    await settle()
    expect(log.acks, '目の前で見た分（破棄）だけが見たことになる。隠れている間の分は残る').toEqual([[DIR, seen]])
    expect(mainOps.getOps(DIR).last?.handler).toBe('cloud:apply')
  })

  it('★★ 隠れている間は、次の操作を始めても（ふつうは目の前でしか押せないが）、見ていない結果を ack しない', async () => {
    const v = mountPanel(DIR, { visible: false })
    await settle()
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', PLAIN_DELETED)
    await settle()
    applyGate = newGate()
    await v.click('公開する')
    expect(log.acks).toEqual([])
    applyGate.open()
    await settle()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ④ ほかの公開先・ほかのプロジェクトのものは出さず、巻き込まない（掟11）
// ═══════════════════════════════════════════════════════════════════════════
describe('別の公開先・別のプロジェクト（掟11）', () => {
  it('★★ 別の公開先の操作が走っているとき、詳細は出さず1行だけ・押せない', async () => {
    mainStart(DIR, '公開', 'vercel', 'vercel:publish', '☁ Vercel へアップロードしています（3/10）')
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('このプロジェクトでは別の操作（公開）が進んでいます')
    expect(v.text(), '別の公開先の進み具合を出している').not.toContain('Vercel へアップロード')
    expect(v.text(), '別の公開先の操作なのに、この画面の進み具合の枠が出ている').not.toContain('公開が進んでいます')
    expect(v.button('🚀 公開する').props.disabled).toBe(true)
    expect(v.button('破棄する（削除）').props.disabled).toBe(true)
  })

  it('★★ 別の公開先の終わった結果は、この画面に出さない', async () => {
    mainRun(DIR, '公開', 'hanamii', 'hanamii:publish', { ok: true, message: 'HANAMII に公開しました', warnings: ['HANAMII の新しい版は、まだ動いていません'] })
    const v = mountPanel()
    await settle()
    expect(v.text()).not.toContain('HANAMII')
    expect(v.text()).not.toContain('まだ動いていません')
    expect(v.text()).not.toContain('公開の結果')
  })

  it('★★★ 別の公開先の結果を「見た」ことにしない（別の画面が出すはずの警告を消さない）', async () => {
    // 古い順: HANAMII（警告つき・この画面は出さない）→ 共用型
    mainRun(DIR, '公開', 'hanamii', 'hanamii:publish', { ok: true, warnings: ['HANAMII の新しい版は、まだ動いていません'] })
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '公開しました' })
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('公開しました')
    v.close()
    await settle()
    // HANAMII の記録より後ろの共用型は、巻き込まないよう ack しない（HANAMII の記録が黙って消える）
    expect(log.acks, 'ack が別の公開先の記録まで巻き込む').toEqual([])
    const snap = mainOps.getOps(DIR)
    const targets = [...snap.earlier, ...(snap.last ? [snap.last] : [])].map(r => r.target)
    expect(targets, 'HANAMII の見られていない結果が消えた').toContain('hanamii')
  })

  it('★ 共用型のほうが古いなら、共用型だけを見たことにする（別の公開先は残る）', async () => {
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '公開しました' })
    const own = mainOps.getOps(DIR).last!.startedAt
    mainRun(DIR, '公開', 'vercel', 'vercel:publish', { ok: true, notice: 'Vercel: 保存場所の設定は次の公開から効きます' })
    const v = mountPanel()
    await settle()
    v.close()
    await settle()
    expect(log.acks).toEqual([[DIR, own]])
    const snap = mainOps.getOps(DIR)
    expect(snap.last?.target, 'Vercel の結果が消えた').toBe('vercel')
    expect(snap.earlier).toEqual([])
  })

  it('★★ 別のプロジェクトの知らせは無視する', async () => {
    const v = mountPanel(DIR)
    await settle()
    mainStart(OTHER, '公開', 'sakura-apprun', 'cloud:apply', '🚀 別のプロジェクトを公開中')
    await settle()
    expect(v.text(), '別のプロジェクトの進み具合が出ている').not.toContain('別のプロジェクトを公開中')
    expect(v.text()).not.toContain('が進んでいます')
    mainFinish(OTHER, { ok: true, message: '別のプロジェクトの結果' })
    await settle()
    expect(v.text(), '別のプロジェクトの結果が出ている').not.toContain('別のプロジェクトの結果')
    expect(v.button('🚀 公開する').props.disabled).toBe(false)
  })

  it('★ 自分の projectDir の末尾の / は取って比べる（main は取った形で知らせる）', async () => {
    const v = mountPanel(`${DIR}/`)
    await settle()
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 AppRun に反映しています…')
    await settle()
    expect(v.text(), '末尾の / の違いで、自分の知らせを取りこぼしている').toContain('AppRun に反映しています')
  })

  it('★ 閉じるときの ack も、別のプロジェクトの記録には触れない', async () => {
    mainRun(OTHER, '削除', 'sakura-apprun', 'cloud:teardown', KEPT)
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '公開しました' })
    const v = mountPanel(DIR)
    await settle()
    expect(v.text()).not.toContain(keptWarning())
    v.close()
    await settle()
    expect(log.acks.every(([d]) => d === DIR)).toBe(true)
    expect(mainOps.getOps(OTHER).last, '別のプロジェクトの結果が消えた').not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ④' 開いたまま、別のプロジェクトへ切り替わったとき（掟11）
// ═══════════════════════════════════════════════════════════════════════════
describe('プロジェクトの切り替え（掟11）', () => {
  it('★★ 前のプロジェクトの結果は、切り替えたあとの画面に残らない。前のプロジェクトの分は見たことになる（警告なしの結果）', async () => {
    mainRun(DIR, '削除', 'sakura-apprun', 'cloud:teardown', PLAIN_DELETED)
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '前のプロジェクトの公開結果' })
    const newest = mainOps.getOps(DIR).last!.startedAt
    const v = mountPanel(DIR)
    await settle()
    expect(v.text()).toContain('前のプロジェクトの公開結果')
    expect(v.text()).toContain(PLAIN_DELETED_TEXT) // 前の破棄（earlier）も出ている
    await v.switchTo(OTHER)
    expect(v.text(), '切り替えたのに、前のプロジェクトの結果が残っている').not.toContain('前のプロジェクトの公開結果')
    expect(v.text(), '切り替えたのに、前のプロジェクトの前の結果が残っている').not.toContain(PLAIN_DELETED_TEXT)
    expect(v.text()).not.toContain('公開の結果')
    expect(log.acks, '前のプロジェクトで出した結果を、見たことにしていない').toEqual([[DIR, newest]])
  })

  it('★★ 切り替えた先の結果を出す。前のプロジェクトの進み具合は、応答を待つ間にも残さない', async () => {
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 前のプロジェクトを反映中')
    mainRun(OTHER, '削除', 'sakura-apprun', 'cloud:teardown', KEPT)
    const v = mountPanel(DIR)
    await settle()
    expect(v.text()).toContain('前のプロジェクトを反映中')
    // 切り替え先の get を遅らせる（応答が届くまでの間）
    let release!: () => void
    getGate = { promise: new Promise<void>(r => { release = r }) }
    await v.switchTo(OTHER)
    expect(v.text(), '応答を待つ間、前のプロジェクトの進み具合が残っている').not.toContain('前のプロジェクトを反映中')
    expect(v.button('🚀 公開する').props.disabled, '前のプロジェクトが走っているせいで押せない').toBe(false)
    release()
    await settle()
    expect(v.text()).toContain('破棄の結果')
    expect(v.text()).toContain(keptWarning())
    expect(v.text()).not.toContain('前のプロジェクトを反映中')
  })

  it('★ 出した印（startedAt）はプロジェクトごと。切り替えた先の記録が、同じ startedAt でも見落とさない', async () => {
    // startedAt が同じプロジェクトで増えることは保証されているが、プロジェクトをまたいで同じ値にならない保証は無い
    mainRun(DIR, '公開', 'sakura-apprun', 'cloud:apply', { ok: true, message: '元のプロジェクトの結果' })
    const rec = mainOps.getOps(DIR).last!
    const v = mountPanel(DIR)
    await settle()
    expect(v.text()).toContain('元のプロジェクトの結果')
    getGate = {
      promise: Promise.resolve(),
      snapshotOverride: () => ({ running: null, earlier: [], last: { ...rec, result: { ...rec.result!, message: '切り替えた先の結果' } } }),
    }
    await v.switchTo(OTHER)
    expect(v.text(), '同じ startedAt の記録を、出した印で隠している（結果が見えない）').toContain('切り替えた先の結果')
  })

  it('切り替えたあと、前のプロジェクトの知らせは届かない（購読が付け替わる）', async () => {
    const v = mountPanel(DIR)
    await settle()
    await v.switchTo(OTHER)
    expect(subs.size, '購読が1つに保たれていない').toBe(1)
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 前のプロジェクト')
    await settle()
    expect(v.text()).not.toContain('前のプロジェクト')
    mainStart(OTHER, '公開', 'sakura-apprun', 'cloud:apply', '🚀 いまのプロジェクト')
    await settle()
    expect(v.text()).toContain('いまのプロジェクト')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 読み込みの競合・堅さ
// ═══════════════════════════════════════════════════════════════════════════
describe('読み込みの競合', () => {
  it('★★ 先に知らせが届いたら、遅れて届いた古い get の応答で上書きしない', async () => {
    let release!: () => void
    getGate = { promise: new Promise<void>(r => { release = r }), snapshotOverride: () => ({ running: null, last: null, earlier: [] }) }
    const v = mountPanel()
    await settle() // get はまだ返らない
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 AppRun に反映しています…')
    await settle()
    expect(v.text()).toContain('AppRun に反映しています')
    release() // 古い（何も走っていない）応答が、いまごろ届く
    await settle()
    expect(v.text(), '古い get の応答が、新しい知らせを上書きした').toContain('AppRun に反映しています')
    expect(v.button('🚀 公開する').props.disabled).toBe(true)
  })

  it('記録が読めなくても（get が失敗）、画面は開ける', async () => {
    getGate = { promise: Promise.reject(new Error('IPC failed')) }
    getGate.promise.catch(() => {})
    const v = mountPanel()
    await settle()
    expect(v.text()).toContain('公開')
    expect(v.button('🚀 公開する').props.disabled).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ この画面が動かした操作（live）— 二重に出さない・閉じても進む
// ═══════════════════════════════════════════════════════════════════════════
describe('この画面が動かした操作', () => {
  it('★★ 返り値で出した結果を、開き直して読む結果として二重に出さない', async () => {
    const v = mountPanel()
    await settle()
    await v.click('公開する')
    await settle()
    const t = v.text()
    expect(t).toContain('完了しました')
    expect(t.split('完了しました').length - 1, '同じ結果が2回出ている（返り値と記録）').toBe(1)
    expect(t, '「前の結果」として出し直している').not.toContain('公開の結果')
  })

  it('★★★ 動かした結果は、閉じたとき「見た」と伝わり、開き直しても出ない', async () => {
    const v = mountPanel()
    await settle()
    await v.click('公開する')
    await settle()
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    expect(log.acks, '結果を出しただけで ack している').toEqual([])
    v.close()
    await settle()
    expect(log.acks).toEqual([[DIR, startedAt]])
    const again = mountPanel()
    await settle()
    expect(again.text()).not.toContain('完了しました')
    expect(again.text()).not.toContain('公開の結果')
  })

  it('★★★ 公開の途中で閉じても処理は進み、開き直すと進み具合が出て、終われば結果が出る', async () => {
    applyGate = newGate()
    const first = mountPanel()
    await settle()
    await first.click('公開する')
    await settle()
    // 走っている（この画面が動かしている・従来どおり⑥に進み具合）
    expect(first.text()).toContain('AppRun に反映しています')
    // 閉じる（処理は止まらない）
    first.close()
    await settle()
    expect(mainOps.getOps(DIR).running?.op).toBe('公開')
    // 開き直す: 続きの進み具合が出て、押せない
    const second = mountPanel()
    await settle()
    expect(second.text()).toContain('公開が進んでいます')
    expect(second.text()).toContain('AppRun に反映しています')
    expect(second.button('🚀 公開する').props.disabled).toBe(true)
    applyGate.open()
    await settle()
    expect(second.text()).toContain('公開の結果')
    expect(second.text()).toContain('公開しました')
    expect(second.text()).not.toContain('が進んでいます')
    expect(second.button('🚀 公開する').props.disabled).toBe(false)
  })

  it('★★ 開いたあとに、外（閉じる前の画面）で始めた操作が終わったら、画面の状態（公開URL・公開済み・プラン）を取り直す', async () => {
    // 閉じる前の画面の続きが動いていない形（main だけが動かしている）で確かめる
    mainStart(DIR, '公開', 'sakura-apprun', 'cloud:apply', '🚀 AppRun に反映しています…')
    const v = mountPanel()
    await settle()
    const count = (name: string) => log.cloud.filter(c => c === name).length
    const before = { url: count('appUrl'), published: count('isPublished'), plan: count('plan'), env: count('loadEnv') }
    mainFinish(DIR, { ok: true, message: '公開しました' })
    await settle()
    expect(count('appUrl'), '終わったのに公開URLを取り直していない').toBeGreaterThan(before.url)
    expect(count('isPublished'), '公開済みかを取り直していない').toBeGreaterThan(before.published)
    expect(count('plan'), 'プランを取り直していない').toBeGreaterThan(before.plan)
    expect(count('loadEnv'), '設定（env.json）を読み直していない').toBeGreaterThan(before.env)
    expect(v.text()).toContain('公開の結果')
  })

  it('この画面が動かした操作は、外で終わった扱いの取り直しをしない（返り値の続きで取り直す。二重に取り直さない）', async () => {
    const v = mountPanel()
    await settle()
    const envAtMount = log.cloud.filter(c => c === 'loadEnv').length
    await v.click('🚀 公開する')
    await settle()
    expect(v.text()).toContain('完了しました')
    expect(log.cloud.filter(c => c === 'loadEnv').length, '自分が動かした公開のあとに、外で終わった扱いで設定を読み直している')
      .toBe(envAtMount)
  })

  it('★★★ 破棄の途中で閉じても、開き直すと「月額が続きます」の警告つきの結果が出る', async () => {
    teardownGate = newGate()
    teardownValue = KEPT
    const first = mountPanel()
    await settle()
    await first.click('破棄する（削除）') // 確認画面
    // 確認画面（ConfirmDialog）の実行ボタン
    const doIt = RT.findAll(first.tree(), (n: any) => n.type === 'button' && RT.textOf(n).includes('理解した上で破棄する'))
    expect(doIt.length, '破棄の確認画面が出ていない').toBe(1)
    doIt[0].props.onClick()
    await settle()
    expect(mainOps.getOps(DIR).running?.op).toBe('削除')
    first.close() // 閉じる
    await settle()
    teardownGate.open()
    await settle()
    const second = mountPanel() // 開き直す
    await settle()
    expect(second.text()).toContain('破棄の結果')
    expect(second.text(), '閉じている間に終わった破棄の警告が消えている').toContain(keptWarning())
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    // 警告つきなので、画面を閉じただけでは見たことにならない（上部の「結果を確認しました」まで、開き直すたびに出る）
    second.close()
    await settle()
    const third = mountPanel()
    await settle()
    expect(third.text(), '確認していない月額の警告が、閉じて開き直したら消えている').toContain(keptWarning())
    third.close()
    await settle()
    // 上部で確認したら、次は出ない
    mainOps.ackOps(DIR, startedAt)
    const fourth = mountPanel()
    await settle()
    expect(fourth.text()).not.toContain(keptWarning())
  })

  it('★★ 動かした破棄の結果も、閉じたとき「見た」と伝わり、開き直しても出ない（警告なしの結果）', async () => {
    teardownValue = PLAIN_DELETED
    const v = mountPanel()
    await settle()
    await v.click('破棄する（削除）')
    RT.findAll(v.tree(), (n: any) => n.type === 'button' && RT.textOf(n).includes('理解した上で破棄する'))[0].props.onClick()
    await settle()
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    v.close()
    await settle()
    expect(log.acks, '動かした破棄の結果に「見た」と伝えていない（開き直すたびに同じ結果が出る）').toEqual([[DIR, startedAt]])
    const again = mountPanel()
    await settle()
    expect(again.text()).not.toContain('破棄の結果')
    expect(again.text()).not.toContain(PLAIN_DELETED_TEXT)
  })

  it('★★★ 動かした破棄の結果（月額が続く警告つき）は、閉じても「見た」と伝えない。開き直すと警告が出る', async () => {
    teardownValue = KEPT
    const v = mountPanel()
    await settle()
    await v.click('破棄する（削除）')
    RT.findAll(v.tree(), (n: any) => n.type === 'button' && RT.textOf(n).includes('理解した上で破棄する'))[0].props.onClick()
    await settle()
    const startedAt = mainOps.getOps(DIR).last!.startedAt
    v.close()
    await settle()
    expect(log.acks, '警告つきの結果を、画面を閉じたときに見たことにした').toEqual([])
    const again = mountPanel()
    await settle()
    expect(again.text(), '動かした破棄の月額の警告が、閉じて開き直したら消えている').toContain(keptWarning())
    expect(mainOps.getOps(DIR).last?.startedAt).toBe(startedAt)
  })

  it('★★ 起動のしかたを聞かれて止まった公開は、選ぶ画面を出し、閉じて選び直したあとに「前の結果」として出し直さない', async () => {
    applyValue = {
      ok: false,
      message: '起動のしかたが、さくら側と Koto の設定で違います。どちらで公開するか選んでください。',
      needsScaleDecision: { appId: 'app-1', recorded: 0, actual: 1 },
    }
    const v = mountPanel()
    await settle()
    await v.click('🚀 公開する')
    await settle()
    expect(v.text(), '選ぶ画面が出ていない').toContain('Koto の設定で公開する')
    await v.click('やめる')
    expect(v.text()).not.toContain('Koto の設定で公開する')
    expect(v.text(), '選ぶ画面で扱った記録を、前の結果として出し直している').not.toContain('止まりました')
    expect(v.text()).not.toContain('公開の結果')
  })

  it('この画面が動かしている破棄の結果も、警告は黄色の知らせの枠で出る（本文に埋もれない）', async () => {
    teardownValue = KEPT
    const v = mountPanel()
    await settle()
    await v.click('破棄する（削除）')
    const doIt = RT.findAll(v.tree(), (n: any) => n.type === 'button' && RT.textOf(n).includes('理解した上で破棄する'))
    doIt[0].props.onClick()
    await settle()
    // 破棄の結果（この画面の選択どおり、レジストリも消す既定＝残るのは保存場所だけ）
    const t = v.text()
    expect(t).toContain('完了しました')
    expect(t).toContain('データの保存場所『koto-data-x』')
    expect(t).toContain('課金は続きます')
    expect(t, '返り値で出した結果を前の結果として出し直している').not.toContain('破棄の結果')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ 古いイメージの片づけ（main の記録に載らない・画面のプロセス内で続きを持つ）
// ═══════════════════════════════════════════════════════════════════════════
describe('古いイメージの片づけ', () => {
  async function startCleanup(v: Mounted) {
    await v.click('古いイメージを片づける') // 計画だけ（何も消さない）
    const go = RT.findAll(v.tree(), (n: any) => n.type === 'button' && RT.textOf(n).includes('理解した上で消す'))
    expect(go.length, '片づけの確認画面が出ていない').toBe(1)
    expect(log.cloud).not.toContain('cleanup-confirmed')
    go[0].props.onClick()
    await settle()
  }

  it('★★ 走っている間に閉じて開き直すと、片づけ中と出て、公開・破棄は押せない', async () => {
    cleanupGate = newGate()
    const first = mountPanel()
    await settle()
    await startCleanup(first)
    expect(log.cloud).toContain('cleanup-confirmed')
    first.close()
    await settle()
    const second = mountPanel()
    await settle()
    expect(second.text()).toContain('古いイメージの片づけが進んでいます')
    expect(second.button('🚀 公開する').props.disabled, 'レジストリを触っている最中に公開できてしまう').toBe(true)
    expect(second.button('破棄する（削除）').props.disabled).toBe(true)
    cleanupGate.open()
    await settle()
    expect(second.text()).toContain('古いイメージの片づけの結果')
    expect(second.text()).toContain('2件のイメージを片づけました。')
    expect(second.text()).not.toContain('片づけが進んでいます')
    expect(second.button('🚀 公開する').props.disabled).toBe(false)
  })

  it('★ 閉じている間に終わった片づけの結果は、開き直したとき出る（1回だけ）', async () => {
    cleanupGate = newGate()
    const first = mountPanel()
    await settle()
    await startCleanup(first)
    first.close()
    await settle()
    cleanupGate.open()
    await settle()
    const second = mountPanel()
    await settle()
    expect(second.text()).toContain('古いイメージの片づけの結果')
    expect(second.text()).toContain('2件のイメージを片づけました。')
    second.close()
    const third = mountPanel()
    await settle()
    expect(third.text(), '見たあとも同じ片づけの結果が出ている').not.toContain('2件のイメージを片づけました。')
  })

  it('開いたままなら、返り値で出した結果を前の結果として出し直さない', async () => {
    cleanupGate = newGate()
    const v = mountPanel()
    await settle()
    await startCleanup(v)
    cleanupGate.open()
    await settle()
    const t = v.text()
    expect(t).toContain('2件のイメージを片づけました。')
    expect(t.split('2件のイメージを片づけました。').length - 1).toBe(1)
    expect(t).not.toContain('古いイメージの片づけの結果')
  })

  it('★ 別のプロジェクトの片づけ中は、こちらを止めない（掟11）', async () => {
    cleanupGate = newGate()
    const a = mountPanel(OTHER)
    await settle()
    await startCleanup(a)
    a.close()
    await settle()
    const b = mountPanel(DIR)
    await settle()
    expect(b.text()).not.toContain('片づけが進んでいます')
    expect(b.button('🚀 公開する').props.disabled).toBe(false)
    cleanupGate.open()
    await settle()
  })
})
