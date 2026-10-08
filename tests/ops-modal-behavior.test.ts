import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import ReactDefault from 'react'
import * as React from 'react'

// ── なぜこのテストが要るか（2026-09-29・作者の決定 ①②）────────────────────────────────────
// 公開・破棄・作成の本体は main の1回の IPC で最後まで進む。公開ダイアログを閉じても処理は止まらないが、
//   ① 処理中にダイアログの**外側をクリックすると閉じてしまい**、進み具合も結果も見えなくなった
//   ② 閉じて開き直すと、進み具合・結果・「保存場所が残ったので月額が続きます」のような警告が**消えていた**
//      （画面の React の状態にしか無かったため）
// 直し方: main が持つ処理の記録（projectOps。withProjectLock が自動で書く）を、ダイアログが開いたときに読み、
// 開いている間は押し出し（onChanged）と3秒ごとの聞き直しで最新にする。
//
// ここは**ソースの文字列ではなく、振る舞い**を固定する（掟10）。
//   ・electronAPI は偽物だが、projectOps は**本物の main の記録**（src/main/projectOps.ts・本物の鍵 withProjectLock）を
//     そのまま通す。get／ack／onChanged の返り方は本物と同じ（写しを返す・ack すると消える・押し出す）。
//   ・PublishModal は**本物のコンポーネント**を、下の小さな描画器（フック対応）で動かす。
//     「閉じて開き直す」＝描画器から外して、付け直す。
//   ・子のパネル（HANAMII・Vercel・AppRun…）は本題ではないので空の部品に差し替える。
//
// ⚠️ DOM（jsdom）も testing-library も入っていない環境なので、React の内部の dispatcher を差し替える
// 小さな描画器を、このファイルの中に持つ。使うフックは useState / useEffect / useMemo / useCallback / useRef だけ。
// 足りないフックを PublishModal が使い始めたら、描画器が「未対応」と言って落ちる（黙って通らない）。

vi.mock('../src/renderer/components/StorageNotice', () => ({ default: () => null }))
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/HanamiiPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VercelPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VpsPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunDedicatedPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/publishRootRenderer', () => ({ resolvePublishRoot: async () => '' }))

import PublishModal from '../src/renderer/components/PublishModal'
import { withProjectLock } from '../src/main/projectLock'
import {
  getOps, ackOps, reportProgress, runningOpName,
  setProjectOpsListener, resetProjectOpsForTests,
  type ProjectOp, type OpTarget,
} from '../src/main/projectOps'

// ═════════════════════════════════════════════════════════════════════════════
// 小さな描画器（フック対応・DOM なし）
// ═════════════════════════════════════════════════════════════════════════════

type HostNode = { type: string; props: Record<string, any>; children: (HostNode | string)[]; parent: HostNode | null }
type EffectRec = { deps: readonly unknown[] | undefined; create: () => void | (() => void); cleanup: void | (() => void); pending: boolean }
type Inst = { hooks: any[] }

const internals = (ReactDefault as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
if (!internals?.ReactCurrentDispatcher) throw new Error('React の内部の形が想定と違います（描画器を直してください）')

let cur: { root: MiniRoot; inst: Inst; i: number } | null = null

const depsEqual = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
  !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))

const unsupported = (name: string) => () => { throw new Error(`描画器は ${name} に未対応です`) }

const dispatcher: Record<string, any> = {
  useState(init: any) {
    const { inst, root } = cur!
    const i = cur!.i++
    if (!(i in inst.hooks)) inst.hooks[i] = { v: typeof init === 'function' ? init() : init }
    const h = inst.hooks[i]
    h.set ??= (nv: any) => {
      const next = typeof nv === 'function' ? nv(h.v) : nv
      if (Object.is(next, h.v)) return
      h.v = next
      root.schedule()
    }
    return [h.v, h.set]
  },
  useRef(init: any) {
    const { inst } = cur!
    const i = cur!.i++
    if (!(i in inst.hooks)) inst.hooks[i] = { current: init }
    return inst.hooks[i]
  },
  useMemo(fn: () => any, deps: any[]) {
    const { inst } = cur!
    const i = cur!.i++
    const h = inst.hooks[i]
    if (h && depsEqual(h.deps, deps)) return h.v
    const v = fn()
    inst.hooks[i] = { v, deps }
    return v
  },
  useCallback(fn: any, deps: any[]) { return dispatcher.useMemo(() => fn, deps) },
  useEffect(create: any, deps?: any[]) {
    const { inst, root } = cur!
    const i = cur!.i++
    const rec: EffectRec | undefined = inst.hooks[i]
    if (!rec) {
      const fresh: EffectRec = { deps, create, cleanup: undefined, pending: true }
      inst.hooks[i] = fresh
      root.queue.push(fresh)
    } else if (deps === undefined || !depsEqual(rec.deps, deps)) {
      rec.deps = deps; rec.create = create; rec.pending = true
      root.queue.push(rec)
    }
  },
  useLayoutEffect(create: any, deps?: any[]) { return dispatcher.useEffect(create, deps) },
  useContext: unsupported('useContext'),
  useReducer: unsupported('useReducer'),
  useId: unsupported('useId'),
  useSyncExternalStore: unsupported('useSyncExternalStore'),
  useTransition: unsupported('useTransition'),
  useDeferredValue: unsupported('useDeferredValue'),
  useImperativeHandle: unsupported('useImperativeHandle'),
  useInsertionEffect: unsupported('useInsertionEffect'),
  useDebugValue() { /* 何もしない */ },
}

class MiniRoot {
  insts = new Map<string, Inst>()
  visited = new Set<string>()
  queue: EffectRec[] = []
  tree: (HostNode | string)[] = []
  private scheduled = false
  private unmounted = false

  constructor(private element: React.ReactElement) { this.renderRoot() }

  schedule() {
    if (this.scheduled || this.unmounted) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; if (!this.unmounted) this.renderRoot() })
  }

  private renderRoot() {
    this.visited = new Set()
    this.queue = []
    this.tree = this.build(this.element, 'root', null)
    // 使われなくなった部品の後始末
    for (const [path, inst] of [...this.insts]) {
      if (this.visited.has(path)) continue
      for (const h of inst.hooks) if (h && 'cleanup' in h && typeof h.cleanup === 'function') h.cleanup()
      this.insts.delete(path)
    }
    // 後始末を先に、そのあと作る（React と同じ順）
    const run = [...this.queue]
    for (const rec of run) { if (typeof rec.cleanup === 'function') rec.cleanup(); rec.cleanup = undefined }
    for (const rec of run) { rec.pending = false; rec.cleanup = rec.create() }
  }

  private build(node: any, path: string, parent: HostNode | null): (HostNode | string)[] {
    if (node == null || typeof node === 'boolean') return []
    if (typeof node === 'string' || typeof node === 'number') return [String(node)]
    if (Array.isArray(node)) return node.flatMap((c, i) => this.build(c, `${path}.${i}`, parent))
    if (typeof node !== 'object' || !node.$$typeof) throw new Error('描画器が扱えないものです')
    const { type, props, key } = node
    const seg = `${path}/${key ?? ''}`
    if (typeof type === 'string') {
      const host: HostNode = { type, props, children: [], parent }
      host.children = this.build(props.children, `${seg}<${type}>`, host)
      return [host]
    }
    if (type === (ReactDefault as any).Fragment) return this.build(props.children, `${seg}<F>`, parent)
    if (typeof type === 'function') {
      const p = `${seg}<${type.name || 'C'}>`
      let inst = this.insts.get(p)
      if (!inst) { inst = { hooks: [] }; this.insts.set(p, inst) }
      this.visited.add(p)
      const prev = cur
      cur = { root: this, inst, i: 0 }
      internals.ReactCurrentDispatcher.current = dispatcher
      let out: any
      try { out = type(props) } finally { cur = prev; internals.ReactCurrentDispatcher.current = null }
      return this.build(out, p, parent)
    }
    throw new Error('描画器が扱えない要素の種類です')
  }

  /** 同じ画面のまま、渡すもの（props）だけを変える（別のプロジェクトへ切り替わる、など）。 */
  update(element: React.ReactElement) { this.element = element; this.renderRoot() }

  unmount() {
    this.unmounted = true
    for (const inst of this.insts.values()) {
      for (const h of inst.hooks) if (h && 'cleanup' in h && typeof h.cleanup === 'function') h.cleanup()
    }
    this.insts.clear()
    this.tree = []
  }

  // ── 見る・押す ──
  private textOf(n: HostNode | string): string[] {
    return typeof n === 'string' ? [n] : n.children.flatMap(c => this.textOf(c))
  }
  /** 見えている文字を、改行で区切ってすべて返す。 */
  text(): string { return this.tree.flatMap(n => this.textOf(n)).join('\n') }
  nodeText(n: HostNode): string { return this.textOf(n).join('') }
  findAll(pred: (n: HostNode) => boolean): HostNode[] {
    const out: HostNode[] = []
    const walk = (n: HostNode | string) => { if (typeof n === 'string') return; if (pred(n)) out.push(n); n.children.forEach(walk) }
    this.tree.forEach(walk)
    return out
  }
  button(label: string): HostNode {
    const found = this.findAll(n => n.type === 'button' && this.nodeText(n).trim() === label)
    if (found.length !== 1) throw new Error(`ボタン「${label}」が ${found.length} 個あります`)
    return found[0]
  }
  hasButton(label: string): boolean {
    return this.findAll(n => n.type === 'button' && this.nodeText(n).trim() === label).length > 0
  }
  /** いちばん外側（画面の外＝背景）。 */
  get backdrop(): HostNode { return this.tree[0] as HostNode }
  /** クリックする。onClick を持つ最も近い祖先へ泡のように上がり、stopPropagation で止まる。 */
  click(target: HostNode) {
    let stopped = false
    const e = { target, stopPropagation() { stopped = true }, preventDefault() {} }
    for (let n: HostNode | null = target; n && !stopped; n = n.parent) {
      if (typeof n.props.onClick === 'function') n.props.onClick(e)
    }
  }
}

/** 溜まった非同期（get・読み込み・状態更新）を流し切る。 */
async function settle() { for (let i = 0; i < 6; i++) await new Promise<void>(r => setImmediate(r)) }

// ═════════════════════════════════════════════════════════════════════════════
// 偽の electronAPI（projectOps は本物の main の記録を通す）
// ═════════════════════════════════════════════════════════════════════════════

const DIR = '/tmp/ops-modal-proj-a'
const OTHER = '/tmp/ops-modal-proj-b'

type Api = ReturnType<typeof makeApi>

function makeApi(opts: { runningOp?: (dir: string) => string | null } = {}) {
  const subs = new Set<(p: any) => void>()
  const state = { push: true, metaJson: '{}', metaGate: null as Promise<void> | null }
  // main の記録が変わるたび、押し出す（ipc/projectOps.ts と同じ形: { projectDir, running, last, earlier }）
  setProjectOpsListener((projectDir, snapshot) => {
    if (!state.push) return
    for (const cb of subs) cb({ projectDir, ...snapshot })
  })
  const api = {
    state,
    projectOps: {
      get: vi.fn(async (dir: string) => getOps(dir)),
      ack: vi.fn(async (dir: string, upTo?: number) => ({ ok: true as const, acked: ackOps(dir, upTo) })),
      onChanged: vi.fn((cb: (p: any) => void) => { subs.add(cb); return () => { subs.delete(cb) } }),
    },
    publishMeta: {
      runningOp: vi.fn(async (dir: string) => (opts.runningOp ? opts.runningOp(dir) : (runningOpName(dir) ?? null))),
      merge: vi.fn(async () => ({ ok: true, meta: {} })),
      forgetTarget: vi.fn(async () => ({ ok: true, meta: {} })),
      dismissInterrupted: vi.fn(async () => ({ ok: true, meta: {} })),
    },
    fs: {
      readFile: vi.fn(async (p: string) => {
        if (p.endsWith('/.sakuraide.json')) {
          const json = state.metaJson
          if (state.metaGate) await state.metaGate   // 記録ファイルの読み込みの応答を遅らせる（公開先が決まる前を作る）
          return json
        }
        throw new Error('ENOENT')
      }),
      latestChangeAt: vi.fn(async () => ({ ok: false })),
      exists: vi.fn(async () => false),
    },
    shell: { which: vi.fn(async () => true) },
    storage: { ensureLayer: vi.fn(async () => ({})) },
    /** いま押し出しを受けようとしている数（外したあとに 0 に戻るか＝購読を解除しているか）。 */
    subscriberCount() { return subs.size },
    /** 押し出しを止める（「押し出しが届かなかった」を作る）。 */
    stopPush() { state.push = false },
    /** 別の窓・別の画面が、結果を「見た」と main に伝える（この画面の ack ではない）。 */
    ackElsewhere(dir: string, upTo?: number) { return ackOps(dir, upTo) },
  }
  return api
}

let api: Api
let roots: MiniRoot[] = []

function install(a: Api) {
  ;(globalThis as any).window = {
    electronAPI: a,
    // 偽のタイマーへ差し替えても効くよう、呼ぶ時に globalThis を見る
    setInterval: (fn: any, ms: number) => (globalThis.setInterval as any)(fn, ms),
    clearInterval: (id: any) => (globalThis.clearInterval as any)(id),
    dispatchEvent: () => true,
  }
}

function modalElement(projectDir: string, onClose: () => void) {
  return React.createElement(PublishModal, { projectDir, apiKey: '', onClose, onRun: () => {}, onOpenCredentials: () => {} })
}

/** ダイアログを開く（付ける）。 */
function open(props: { projectDir?: string; onClose?: () => void } = {}): { root: MiniRoot; onClose: ReturnType<typeof vi.fn> } {
  const onClose = (props.onClose as any) ?? vi.fn()
  const root = new MiniRoot(React.createElement(PublishModal, {
    projectDir: props.projectDir ?? DIR, apiKey: '', onClose, onRun: () => {}, onOpenCredentials: () => {},
  }))
  roots.push(root)
  return { root, onClose }
}

/** 記録に載る処理を1つ走らせる（release() で終わる）。開始は同期で記録される。 */
function startOp(
  dir: string, op: ProjectOp, meta: { target: OpTarget; handler: string }, result: Record<string, unknown> = { ok: true },
) {
  let release!: () => void
  const wait = new Promise<void>(r => { release = r })
  const done = withProjectLock(dir, op, async () => { await wait; return result }, meta)
  return { finish: async () => { release(); await done; await settle() }, done }
}

const TEARDOWN = { target: 'sakura-apprun' as const, handler: 'cloud:teardown' }
const HANAMII_PUBLISH = { target: 'hanamii' as const, handler: 'hanamii:publish' }

beforeEach(() => {
  resetProjectOpsForTests()
  api = makeApi()
  install(api)
  roots = []
})
afterEach(() => {
  for (const r of roots) r.unmount()
  setProjectOpsListener(null)
  vi.useRealTimers()
  delete (globalThis as any).window
})

// ═════════════════════════════════════════════════════════════════════════════
// ① 走っている間は、画面の外のクリックでは閉じない。✗ は押せば閉じ、✗ の近くに一言出す
// ═════════════════════════════════════════════════════════════════════════════

const NOTE = '閉じても処理は最後まで進みます'

describe('★★ ① 走っている間は、画面の外のクリックでは閉じない', () => {
  it('★ 何も走っていないとき: 外側をクリックすると閉じる。✗ の近くの一言は出ない', async () => {
    const { root, onClose } = open()
    await settle()
    expect(root.text()).not.toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('★★ 処理が走っているとき（projectOps の running）: 外側をクリックしても閉じない', async () => {
    const op = startOp(DIR, '削除', TEARDOWN)
    const { root, onClose } = open()
    await settle()
    root.click(root.backdrop)
    expect(onClose).not.toHaveBeenCalled()
    await op.finish()
  })

  it('★★ ✗ は押せば閉じる（走っていても）', async () => {
    const op = startOp(DIR, '削除', TEARDOWN)
    const { root, onClose } = open()
    await settle()
    root.click(root.button('×'))
    expect(onClose).toHaveBeenCalledTimes(1)
    await op.finish()
  })

  it('★★ 画面の内側（ダイアログ本体）をクリックしても閉じない（走っていなくても・従来どおり）', async () => {
    const { root, onClose } = open()
    await settle()
    const inner = root.backdrop.children.find((c): c is HostNode => typeof c !== 'string')!
    root.click(inner)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('★★ 走っている間は、✗ の近く（同じ行）に「閉じても処理は最後まで進みます」が見える文字として出る（title だけにしない）', async () => {
    const op = startOp(DIR, '削除', TEARDOWN)
    const { root } = open()
    await settle()
    const x = root.button('×')
    const row = x.parent!
    // ✗ と同じ行の中に、見える文字として入っている
    expect(root.nodeText(row)).toContain(NOTE)
    // title 属性ではなく、子の文字である
    expect(typeof x.props.title === 'string' ? x.props.title : '').not.toContain(NOTE)
    await op.finish()
  })

  it('★ 走っていない間は、その一言は出ない。終わったら消え、外側クリックで閉じられる', async () => {
    const op = startOp(DIR, '削除', TEARDOWN)
    const { root, onClose } = open()
    await settle()
    expect(root.text()).toContain(NOTE)
    await op.finish()
    expect(root.text()).not.toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('★ 開いたあとに処理が始まったとき（押し出し）も、その場で閉じなくなる', async () => {
    const { root, onClose } = open()
    await settle()
    const op = startOp(DIR, '公開', HANAMII_PUBLISH)
    await settle()
    expect(root.text()).toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).not.toHaveBeenCalled()
    await op.finish()
  })

  it('★★ 既存の runningOp（publishMeta:runningOp）だけが「走っている」と言うときも閉じない（どちらかが言えば走っている）', async () => {
    api = makeApi({ runningOp: () => '公開' }) // projectOps は空
    install(api)
    const { root, onClose } = open()
    await settle()
    expect(getOps(DIR).running).toBeNull()
    expect(root.text()).toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('★★ projectOps だけが「走っている」と言うとき（runningOp は null）も閉じない', async () => {
    api = makeApi({ runningOp: () => null })
    install(api)
    const op = startOp(DIR, '作成', { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:create' })
    const { root, onClose } = open()
    await settle()
    expect(root.text()).toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).not.toHaveBeenCalled()
    await op.finish()
  })

  it('★ 別のプロジェクトの処理では閉じなくならない（掟11）', async () => {
    const op = startOp(OTHER, '削除', TEARDOWN)
    const { root, onClose } = open()
    await settle()
    expect(root.text()).not.toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
    await op.finish()
  })

  it('★ 聞けなかった（get が例外）ときも落ちない（握りつぶす）。既存の runningOp だけで判断する', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => { unhandled.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      api.projectOps.get.mockRejectedValue(new Error('preload 未注入'))
      const { root, onClose } = open()
      await settle()
      root.click(root.backdrop)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([]) // 例外を握りつぶさずに投げ続けると、ここに溜まる
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('★ 画面を外すと、押し出しの受け取りも外す（開くたびに受け口が溜まらない）。プロジェクトが切り替わっても1つのまま', async () => {
    const onClose = vi.fn()
    const { root } = open({ onClose })
    await settle()
    expect(api.subscriberCount()).toBe(1)
    root.update(modalElement(OTHER, onClose))
    await settle()
    expect(api.subscriberCount()).toBe(1)
    root.unmount()
    expect(api.subscriberCount()).toBe(0)
    // 開いては閉じるを繰り返しても、溜まらない
    for (let i = 0; i < 3; i++) { open().root.unmount() }
    expect(api.subscriberCount()).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 数秒ごとに聞き直す（押し出しが届かなくても、走っているかを取りこぼさない）
// ═════════════════════════════════════════════════════════════════════════════

describe('★★ 開いている間も、数秒（3秒）ごとに走っているかを聞き直す', () => {
  it('★★ 押し出しが届かなくても、3秒ごとの聞き直しで「走り始めた」「終わった」に追いつく', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    api.stopPush()
    const { root, onClose } = open()
    await settle()
    const first = api.projectOps.get.mock.calls.length
    expect(first).toBeGreaterThanOrEqual(1)

    // 押し出し無しで走り始める → 3秒後の聞き直しで気づく
    const op = startOp(DIR, '削除', TEARDOWN, { ok: true, executed: ['アプリを削除しました'] })
    await vi.advanceTimersByTimeAsync(3000)
    await settle()
    expect(api.projectOps.get.mock.calls.length).toBeGreaterThan(first)
    expect(root.text()).toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).not.toHaveBeenCalled()

    // 押し出し無しで終わる → 次の聞き直しで気づく（閉じられるようになり、結果が出る）
    await op.finish()
    await vi.advanceTimersByTimeAsync(3000)
    await settle()
    expect(root.text()).not.toContain(NOTE)
    expect(root.text()).toContain('が終わりました')
    root.click(root.backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('★ 3秒より短い間には聞き直さない・3秒ごとには聞き直す（間隔が「数秒」）', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    open()
    await settle()
    const n0 = api.projectOps.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(2900)
    expect(api.projectOps.get.mock.calls.length).toBe(n0)
    await vi.advanceTimersByTimeAsync(100)
    expect(api.projectOps.get.mock.calls.length).toBe(n0 + 1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.projectOps.get.mock.calls.length).toBe(n0 + 2)
  })

  it('★ 閉じたら（付けた画面を外したら）聞き直しも止まる', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { root } = open()
    await settle()
    root.unmount()
    const n = api.projectOps.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.projectOps.get.mock.calls.length).toBe(n)
  })

  it('★ 経過時間が進む（聞き直しのたびに数え直す）', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'))
    const op = startOp(DIR, '削除', TEARDOWN)
    const { root } = open()
    await settle()
    expect(root.text()).toContain('経過 0秒')
    await vi.advanceTimersByTimeAsync(125_000)
    await settle()
    expect(root.text()).toMatch(/経過 2分\d+秒/)
    await op.finish()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ② 閉じて開き直したとき、進み具合と結果が続きから見える
// ═════════════════════════════════════════════════════════════════════════════

describe('★★★ ② 閉じて開き直したとき（外して付け直す）', () => {
  it('★★★ 走っていれば、進み具合が出る。何度閉じて開き直しても、最新の進み具合が出る', async () => {
    const op = startOp(DIR, '削除', TEARDOWN)
    reportProgress(DIR, 'ロードバランサの削除を待っています…', { detail: '状態: 削除中' })

    const first = open()
    await settle()
    expect(first.root.text()).toContain('ロードバランサの削除を待っています…')
    expect(first.root.text()).toContain('状態: 削除中')
    expect(first.root.text()).toContain('の削除が進んでいます')
    first.root.unmount() // 閉じる（処理は止まらない）

    reportProgress(DIR, 'オートスケーリンググループを削除しています…')

    const second = open() // 開き直す
    await settle()
    expect(second.root.text()).toContain('オートスケーリンググループを削除しています…')
    expect(second.root.text()).not.toContain('ロードバランサの削除を待っています…') // 古い進み具合を出さない
    expect(second.root.text()).toContain('さくらのAppRun') // どの公開先の操作か
    await op.finish()
  })

  it('★★ 進み具合が更新されると、開いている画面にも押し出しで届く。段（step/total）も出る', async () => {
    const op = startOp(DIR, '公開', { target: 'vercel', handler: 'vercel:publish' })
    const { root } = open()
    await settle()
    reportProgress(DIR, 'ファイルをアップロードしています…', { step: 3, total: 12 })
    await settle()
    expect(root.text()).toContain('ファイルをアップロードしています…（3 / 12）')
    await op.finish()
  })

  it('★★★ 終わっていれば、結果と警告が出る（閉じている間に終わった処理）', async () => {
    // ダイアログを閉じている間に、保存場所が残る破棄が終わった
    const op = startOp(DIR, '削除', TEARDOWN, {
      ok: true, keptBucketName: 'koto-data-bucket', executed: ['アプリを削除しました'],
    })
    await op.finish()

    const { root } = open()
    await settle()
    const t = root.text()
    expect(t).toContain('さくらのAppRunの削除は終わりましたが、確認が必要なことがあります')
    // 「保存場所が残ったので月額が続きます」という警告を見逃さない
    expect(t).toContain('koto-data-bucket')
    expect(t).toContain('課金は続きます')
    // 起きたことの一覧は畳んで持つ（本文には出ていなくても、材料として渡っている）
    expect(root.findAll(n => n.type === 'details' && root.nodeText(n).includes('アプリを削除しました')).length).toBe(1)
  })

  it('★★★ うまくいった結果（警告なし）は「終わりました」。うまくいかなかった結果は、その理由を出す', async () => {
    const ok = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, url: 'https://example.test/', message: '公開しました' })
    await ok.finish()
    const bad = startOp(DIR, '削除', TEARDOWN, { ok: false, message: 'レジストリの削除に失敗しました' })
    await bad.finish()

    const { root } = open()
    await settle()
    const t = root.text()
    expect(t).toContain('🌸 HANAMIIの公開が終わりました')
    expect(t).toContain('https://example.test/')
    expect(t).toContain('さくらのAppRunの削除は、うまくいきませんでした')
    expect(t).toContain('レジストリの削除に失敗しました')
  })

  it('★★ うまくいかなかったもの・警告があるものは黄色の枠、警告のない成功は黄色にしない（見逃させない）', async () => {
    const clean = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true })
    await clean.finish()
    const warned = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'b-1234567' })
    await warned.finish()
    const { root } = open()
    await settle()
    const card = (title: string) => root.findAll(n => n.type === 'div' && typeof n.props.className === 'string'
      && n.props.className.includes('rounded-xl') && root.nodeText(n).includes(title))
      .sort((a, b) => root.nodeText(a).length - root.nodeText(b).length)[0]
    expect(card('の公開が終わりました').props.className).not.toContain('brand-yellow')
    expect(card('確認が必要なことがあります').props.className).toContain('brand-yellow')
  })

  it('★★ 結果を見ないうちに次の操作も終わっていたら、前の警告も上書きせずに両方出る', async () => {
    const a = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'first-bucket' })
    await a.finish()
    const b = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, warnings: ['まだ動いていません'] })
    await b.finish()
    const { root } = open()
    await settle()
    const t = root.text()
    expect(t).toContain('first-bucket')
    expect(t).toContain('まだ動いていません')
    // 古い順（起きた順）
    expect(t.indexOf('first-bucket')).toBeLessThan(t.indexOf('まだ動いていません'))
  })

  it('★★★ 開いている間に終わっても、その場で結果と警告が出る', async () => {
    const op = startOp(DIR, '削除', TEARDOWN, { ok: true, keptRegistryName: 'my-registry' })
    const { root } = open()
    await settle()
    expect(root.text()).not.toContain('が終わりました')
    await op.finish()
    expect(root.text()).toContain('my-registry')
    expect(root.text()).toContain('課金は続きます')
  })
})

describe('★★★ ack のあとは出ない・押すまでは出続ける', () => {
  it('★★★ 「結果を確認しました」を押すと、見せた記録の startedAt まで ack して消える。開き直しても出ない', async () => {
    const op = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'bk-1234567' })
    await op.finish()
    const startedAt = getOps(DIR).last!.startedAt

    const first = open()
    await settle()
    expect(first.root.text()).toContain('bk-1234567')
    first.root.click(first.root.button('結果を確認しました（この表示を消す）'))
    await settle()
    // 本物の main へ、見せた記録の startedAt を添えて伝えた（省略していない）
    expect(api.projectOps.ack).toHaveBeenCalledWith(DIR, startedAt)
    expect(first.root.text()).not.toContain('bk-1234567')
    expect(getOps(DIR).last).toBeNull()

    first.root.unmount()
    const second = open()
    await settle()
    expect(second.root.text()).not.toContain('bk-1234567')
    expect(second.root.hasButton('結果を確認しました（この表示を消す）')).toBe(false)
  })

  it('★★★ 押していなければ、閉じて開き直しても出続ける（閉じただけでは「見た」にならない）', async () => {
    const op = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'bk-1234567' })
    await op.finish()

    const first = open()
    await settle()
    expect(first.root.text()).toContain('bk-1234567')
    first.root.click(first.root.button('×')) // 閉じる
    first.root.unmount()
    expect(api.projectOps.ack).not.toHaveBeenCalled()

    const second = open()
    await settle()
    expect(second.root.text()).toContain('bk-1234567')
    const third = (second.root.unmount(), open())
    await settle()
    expect(third.root.text()).toContain('bk-1234567')
  })

  it('★★ 結果が出ている間に次の操作が終わっても、その結果まで消さない（見せた startedAt までしか ack しない）', async () => {
    const a = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'first-bucket' })
    await a.finish()
    const { root } = open()
    await settle()
    expect(root.text()).toContain('first-bucket')

    // 結果を見ている間に、次の操作が終わる
    const b = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, warnings: ['まだ動いていません'] })
    await b.finish()
    expect(root.text()).toContain('まだ動いていません')

    // ここで「確認しました」を押すと、見せた2件とも見たことになる
    root.click(root.button('結果を確認しました（この表示を消す）'))
    await settle()
    expect(root.text()).not.toContain('first-bucket')
    expect(root.text()).not.toContain('まだ動いていません')
    expect(getOps(DIR).last).toBeNull()
  })

  it('★★ 見せていない結果は ack しない・消さない（見せた分の startedAt までしか伝えない）', async () => {
    const a = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'first-bucket' })
    await a.finish()
    const firstStartedAt = getOps(DIR).last!.startedAt
    const { root } = open()
    await settle()
    // この時点で見えているのは1件目だけ。この画面のボタン（＝1件目だけを見せていた時点の押し口）を手に持つ
    const staleButton = root.button('結果を確認しました（この表示を消す）')
    // 押される前に、2件目が終わって届く
    const b = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, warnings: ['second-warning'] })
    await b.finish()
    const secondStartedAt = getOps(DIR).last!.startedAt
    expect(secondStartedAt).toBeGreaterThan(firstStartedAt)

    api.stopPush() // ack しても押し出しは届かない（届いた押し出しで、消えた表示が戻るのを当てにしない）
    root.click(staleButton) // 1件目だけを見せていた時点の押し口で押す
    await settle()
    // 伝えたのは、見せていた1件目まで。2件目を「見た」ことにしていない
    expect(api.projectOps.ack).toHaveBeenCalledWith(DIR, firstStartedAt)
    expect(getOps(DIR).last?.startedAt).toBe(secondStartedAt)
    // 画面からも、2件目は消えていない
    expect(root.text()).toContain('second-warning')
    expect(root.text()).not.toContain('first-bucket')
  })

  it('★★★ 各パネル・別の窓が先に「見た」と伝えても、この画面の結果は利用者が確認するまで消えない', async () => {
    const op = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'bk-1234567' })
    await op.finish()
    const { root } = open()
    await settle()
    expect(root.text()).toContain('bk-1234567')

    api.ackElsewhere(DIR) // 隠れたタブのパネルが先に ack した。利用者は何も見ていない
    await settle()
    expect(getOps(DIR).last).toBeNull()
    expect(root.text()).toContain('bk-1234567') // それでも、ここでは見える

    root.click(root.button('結果を確認しました（この表示を消す）'))
    await settle()
    expect(root.text()).not.toContain('bk-1234567')
  })

  it('★ 結果が無いときは「確認しました」ボタンも出ない', async () => {
    const { root } = open()
    await settle()
    expect(root.hasButton('結果を確認しました（この表示を消す）')).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 環境の独立（掟11）・押し出しと問い合わせの前後
// ═════════════════════════════════════════════════════════════════════════════

describe('★★ 別のプロジェクトの記録を混ぜない（掟11）', () => {
  it('★★ 別のプロジェクトの走っている処理・終わった結果は、出さない（開いたときも、押し出しでも）', async () => {
    const other = startOp(OTHER, '削除', TEARDOWN, { ok: true, keptBucketName: 'other-bucket' })
    const { root } = open()
    await settle()
    expect(root.text()).not.toContain('の削除が進んでいます')
    await other.finish()
    expect(root.text()).not.toContain('other-bucket')
    expect(root.text()).not.toContain('が終わりました')
    // 別のプロジェクトの結果を、こちらが ack してしまうこともない
    expect(api.projectOps.ack).not.toHaveBeenCalled()
    expect(getOps(OTHER).last).not.toBeNull()
  })

  it('★ 自分のプロジェクトの押し出しは、projectDir の末尾に / があっても受ける（main は正規化した形で送る）', async () => {
    const { root } = open({ projectDir: `${DIR}/` })
    await settle()
    const op = startOp(DIR, '削除', TEARDOWN)
    await settle()
    expect(root.text()).toContain('の削除が進んでいます')
    await op.finish()
  })

  it('★ 開いたプロジェクトの結果だけが、開き直したときに出る（2つのプロジェクトで別々）', async () => {
    const a = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'a-bucket' })
    await a.finish()
    const b = startOp(OTHER, '削除', TEARDOWN, { ok: true, keptBucketName: 'b-bucket' })
    await b.finish()
    const forA = open()
    await settle()
    expect(forA.root.text()).toContain('a-bucket')
    expect(forA.root.text()).not.toContain('b-bucket')
    const forB = open({ projectDir: OTHER })
    await settle()
    expect(forB.root.text()).toContain('b-bucket')
    expect(forB.root.text()).not.toContain('a-bucket')
  })
})

describe('★★ 古い応答で、より新しい写しを戻さない', () => {
  it('★★ 開いた直後の問い合わせ（get）の応答が遅れ、その間に押し出しが届いたら、遅れて届いた古い応答で上書きしない', async () => {
    const op = startOp(DIR, '削除', TEARDOWN, { ok: true })
    // 最初の get は「走っている」写しを持ったまま、しばらく返らない
    let releaseGet!: () => void
    const staleSnapshot = getOps(DIR)
    api.projectOps.get.mockImplementationOnce(() => new Promise(r => { releaseGet = () => r(staleSnapshot as any) }))
    const { root, onClose } = open()
    await settle()
    // 応答を待っている間に、処理が終わり、押し出しが届く
    await op.finish()
    expect(root.text()).not.toContain('の削除が進んでいます')
    // いまごろ古い応答が届く（「走っている」）
    releaseGet()
    await settle()
    expect(root.text()).not.toContain('の削除が進んでいます')
    expect(root.text()).not.toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('★★ 開いたまま、別のプロジェクトへ切り替わったとき（掟11）', () => {
  it('★★ 前のプロジェクトの走っている処理・結果を、次のプロジェクトの画面に残さない。次のプロジェクトの分が出る', async () => {
    const a = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'a-bucket' })
    await a.finish()
    const b = startOp(OTHER, '削除', TEARDOWN, { ok: true, keptBucketName: 'b-bucket' })
    await b.finish()
    const running = startOp(DIR, '公開', HANAMII_PUBLISH)
    const onClose = vi.fn()
    const { root } = open({ onClose })
    await settle()
    expect(root.text()).toContain('a-bucket')
    expect(root.text()).toContain(NOTE) // DIR で公開が走っている

    root.update(modalElement(OTHER, onClose)) // 別のプロジェクトへ切り替わる
    await settle()
    expect(root.text()).not.toContain('a-bucket')
    expect(root.text()).not.toContain(NOTE) // 別のプロジェクトでは走っていない＝閉じられる
    expect(root.text()).toContain('b-bucket')
    root.click(root.backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
    await running.finish()
  })

  it('★★ 切り替えた直後（次のプロジェクトの記録が届く前）に、前のプロジェクトの走っている処理を出さない・閉じられる', async () => {
    const running = startOp(DIR, '公開', HANAMII_PUBLISH)
    reportProgress(DIR, '前のプロジェクトを公開しています…')
    const onClose = vi.fn()
    const { root } = open({ onClose })
    await settle()
    expect(root.text()).toContain('前のプロジェクトを公開しています…')

    // 次のプロジェクトの記録は、まだ届かない
    api.projectOps.get.mockImplementation(async (dir: string) => (dir === OTHER ? new Promise(() => {}) as any : getOps(dir)))
    api.publishMeta.runningOp.mockImplementation(async () => null)
    root.update(modalElement(OTHER, onClose))
    await settle()
    expect(root.text()).not.toContain('前のプロジェクトを公開しています…')
    expect(root.text()).not.toContain(NOTE)
    await running.finish()
  })

  it('★★ 切り替える前のプロジェクトへの問い合わせ（get）の応答が、切り替えたあとに届いても、入れない', async () => {
    const running = startOp(DIR, '公開', HANAMII_PUBLISH)
    const stale = getOps(DIR) // DIR は「走っている」
    let release!: () => void
    api.projectOps.get.mockImplementationOnce(() => new Promise(r => { release = () => r(stale as any) }))
    const onClose = vi.fn()
    const { root } = open({ onClose })
    await settle()
    root.update(modalElement(OTHER, onClose)) // 応答が届く前に、別のプロジェクトへ切り替わる
    await settle()
    release() // 前のプロジェクトの応答が、いまごろ届く
    await settle()
    expect(root.text()).not.toContain('への公開が進んでいます')
    expect(root.text()).not.toContain(NOTE)
    await running.finish()
  })
})

describe('★★ 既存の runningOp の聞き直し（公開以外の操作でも、終わったら追いつく）', () => {
  it('★★ 作成・削除でも、3秒ごとの聞き直しで「終わった」に追いつき、閉じられるようになる（公開のときだけではない）', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    let legacy: string | null = '削除'
    api = makeApi({ runningOp: () => legacy })
    install(api)
    api.stopPush() // projectOps は空のまま。既存の runningOp だけが変わる
    const { root, onClose } = open()
    await settle()
    expect(root.text()).toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).not.toHaveBeenCalled()

    legacy = null
    await vi.advanceTimersByTimeAsync(3000)
    await settle()
    expect(root.text()).not.toContain(NOTE)
    root.click(root.backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('既存の表示との重なり', () => {
  it('★ 公開が走っていて、公開の開始マーカー（pending）も同じ公開を指しているときは、進み具合を1つの枠にまとめる（枠を二重にしない）', async () => {
    api.state.metaJson = JSON.stringify({ publish: { pending: { target: 'hanamii', startedAt: new Date(Date.now() - 60_000).toISOString() } } })
    const op = startOp(DIR, '公開', HANAMII_PUBLISH)
    reportProgress(DIR, '⏳ HANAMII が新しい版を起動するのを待っています…', { detail: '状態: BUILDING（12秒経過）' })
    const { root } = open()
    await settle()
    const t = root.text()
    expect(t).toContain('への公開が進んでいます') // 既存の pending の枠
    expect(t).toContain('⏳ HANAMII が新しい版を起動するのを待っています…') // 進み具合
    expect(t).toContain('状態: BUILDING（12秒経過）')
    expect(root.findAll(n => n.props?.role === 'status')).toHaveLength(0) // 別枠（OpRunningCard）は出ていない
    expect(t.match(/が進んでいます/g)?.length).toBe(1)
    await op.finish()
  })

  it('★ 走っているのが公開以外（削除）のときは、進み具合の枠が単独で出る', async () => {
    const op = startOp(DIR, '削除', TEARDOWN)
    reportProgress(DIR, 'アプリを削除しています…')
    const { root } = open()
    await settle()
    expect(root.findAll(n => n.props?.role === 'status')).toHaveLength(1)
    expect(root.text()).toContain('アプリを削除しています…')
    expect(root.text()).toContain('Koto を終了すると途中で止まります')
    await op.finish()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 二重表示の解消（2026-09-30 検分の指摘3）
//   以前は、モーダルの上部（進み具合・結果）と、目の前の公開先の画面の中（各パネル）の両方に、同じ段・同じ結果が出た。
//   HANAMII の公開は、起動を待つ間は開始マーカーを外しているので、枠にまとまらず上部とパネルの両方に同じ段が出た。
//   利用者が画面の前で見ていた結果まで、上部のカードは「確認しました」を押すまで残った。
//   直し方: 目の前の公開先の画面が自分の画面に出すものは、上部では出さない。上部は、どの画面も出さないもの
//   （別の公開先・目の前に無い画面・公開先を選ぶ前・レンタルサーバ）の最後の受け皿として、警告を見逃さないために残す。
//   ここでは子のパネルは空の部品なので、**上部に出るか出ないか**がそのまま見える（パネルが出す分は見えない）。
// ═════════════════════════════════════════════════════════════════════════════

const CONFIRM_BUTTON = '結果を確認しました（この表示を消す）'
const DEDICATED_PUBLISH = { target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:publishApp' }
const DEDICATED_TEARDOWN_APP = { target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardownApp' }
const VERCEL_PUBLISH = { target: 'vercel' as const, handler: 'vercel:publish' }
const APPRUN_APPLY = { target: 'sakura-apprun' as const, handler: 'cloud:apply' }
/** 開いた時点で、その公開先の画面を見ている（最後に公開した公開先の画面で開く）状態にする。 */
const viewing = (target: string) => { api.state.metaJson = JSON.stringify({ target }) }

describe('★★★ 二重表示の解消: 目の前の公開先の画面が出すものは、上部では重ねて出さない', () => {
  it('★★★ HANAMII の画面を見ているとき、HANAMII の走っている公開の進み具合は、上部に出さない（パネルが出す）', async () => {
    viewing('hanamii')
    const op = startOp(DIR, '公開', HANAMII_PUBLISH)
    reportProgress(DIR, '⏳ HANAMII が新しい版を起動するのを待っています…', { detail: '状態: BUILDING（12秒経過）' })
    const { root } = open()
    await settle()
    expect(root.findAll(n => n.props?.role === 'status'), '上部に、パネルと同じ進み具合の枠が出ている（二重）').toHaveLength(0)
    expect(root.text()).not.toContain('⏳ HANAMII が新しい版を起動するのを待っています…')
    expect(root.text()).not.toContain('状態: BUILDING（12秒経過）')
    // ただし ✗ の近くの一言・外側クリックで閉じない歯止めは、そのまま（走っていることは変わらない）
    expect(root.text()).toContain('閉じても処理は最後まで進みます')
    await op.finish()
  })

  it('★★★ 公開の開始マーカー（pending）が残っていても、HANAMII の画面を見ている間は、上部の「公開が進んでいます」の枠を出さない（パネルが出す・2026-09-30 検分）', async () => {
    // 以前は、パネルの進み具合（HANAMII の起動待ちは最長およそ5分）と、開始マーカーの枠が、ずっと2つ並んでいた。
    viewing('hanamii')
    api.state.metaJson = JSON.stringify({ target: 'hanamii', publish: { pending: { target: 'hanamii', startedAt: new Date(Date.now() - 60_000).toISOString() } } })
    const op = startOp(DIR, '公開', HANAMII_PUBLISH)
    reportProgress(DIR, '⏳ HANAMII が新しい版を起動するのを待っています…')
    const { root } = open()
    await settle()
    expect(root.text(), 'パネルが同じ公開の進み具合を出しているのに、上部にも「公開が進んでいます」の枠が出ている（二重）').not.toContain('への公開が進んでいます')
    expect(root.text(), 'パネルと同じ進み具合が上部に重なっている').not.toContain('⏳ HANAMII が新しい版を起動するのを待っています…')
    // 走っていること（外側クリックで閉じない・✗ の近くの一言）は変わらない
    expect(root.text()).toContain('閉じても処理は最後まで進みます')
    await op.finish()
  })

  it('★★★ 進んでいる公開が、目の前の画面のものでないとき（別の公開先の画面・隠れたタブ・公開先の選択前）は、上部の枠が進み具合を出す', async () => {
    // 目の前に進み具合を出す画面が無いので、ここが出す（枠は1つ）
    for (const view of ['vercel', 'sakura-apprun', null]) {
      resetProjectOpsForTests()
      api = makeApi(); install(api)
      api.state.metaJson = JSON.stringify({ ...(view ? { target: view } : {}), publish: { pending: { target: 'hanamii', startedAt: new Date(Date.now() - 60_000).toISOString() } } })
      const op = startOp(DIR, '公開', HANAMII_PUBLISH)
      reportProgress(DIR, '⏳ HANAMII が新しい版を起動するのを待っています…')
      const { root } = open()
      await settle()
      expect(root.text(), String(view)).toContain('への公開が進んでいます')
      expect(root.text(), String(view)).toContain('⏳ HANAMII が新しい版を起動するのを待っています…')
      expect(root.text().split('への公開が進んでいます').length - 1, `${String(view)}: 枠が二重`).toBe(1)
      await op.finish()
      root.unmount()
    }
  })

  it('★★★ HANAMII の画面を見ているとき、HANAMII の終わった結果（警告なし）は、上部に出さない・「確認しました」も出さない', async () => {
    viewing('hanamii')
    const { root } = open()
    await settle()
    const op = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, url: 'https://example.test/' })
    await op.finish()
    expect(root.text(), '上部に、パネルと同じ結果が出ている（二重）').not.toContain('🌸 HANAMIIの公開が終わりました')
    expect(root.hasButton(CONFIRM_BUTTON), '画面の前で見ていた結果を、上部が「確認しました」まで残している').toBe(false)
  })

  // ── 警告つきの結果は、目の前のパネルが出していても、上部にも出る（2026-09-30 検分）───────────────────
  // 各パネルは結果を公開ボタンのずっと下（①〜④の下・⑥⑧の節の中）に出す。利用者がスクロールせずに閉じると、見せたことに
  // ならないのに「見た」と伝えて、月額が続く警告・まだ動いていない警告が、閉じて開き直すと二度と出なかった。
  // だから警告つきの結果は、パネルが出していても、上部が「結果を確認しました」まで出す（作者の決定 ②）。
  it('★★★ HANAMII の画面を見ているときでも、警告つきの結果は上部に出て、「結果を確認しました」まで残る', async () => {
    viewing('hanamii')
    const { root } = open()
    await settle()
    const op = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, url: 'https://example.test/', warnings: ['まだ動いていません'] })
    await op.finish()
    expect(root.text(), 'パネルが出していても、警告が上部に出ていない（パネルはスクロールしないと見えない）').toContain('まだ動いていません')
    expect(root.text()).toContain('確認が必要なことがあります')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(true)
  })

  it('★★★ HANAMII の破棄で、利用者のファイルがあってバケットを残した回（keptBucketName）: 「✅ 削除が終わりました」ではなく、月額が続く警告つきの見出しで出る', async () => {
    // 以前は executed の1行（⚠️ 無し）に入るだけで、見出しは「✅ HANAMIIの削除が終わりました」・月額が続く一文は折りたたみの中だった
    viewing('hanamii')
    const op = startOp(DIR, '削除', { target: 'hanamii', handler: 'hanamii:teardown' }, {
      ok: true, appDeleted: true,
      executed: ['保存場所『koto-b』を片づけました — このプロジェクトのデータだけを削除します。保存場所そのものは残します（月額の課金は続きます）。'],
      keptBucketName: 'koto-b', keptBucketNames: ['koto-b'],
    })
    const { root } = open()
    await settle()
    await op.finish()
    expect(root.text(), '月額が続くのに、「終わりました」だけの見出しになっている').toContain('確認が必要なことがあります')
    expect(root.text()).not.toContain('HANAMIIの削除が終わりました')
    // 折りたたみ（実行した内容）を開かなくても、月額が続くことと保存場所の名前が読める
    const warnings = root.findAll(n => n.type === 'p' && root.nodeText(n).includes('月額495円'))
    expect(warnings.length, '月額が続く警告の段落が出ていない').toBeGreaterThan(0)
    expect(root.text()).toContain('『koto-b』')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(true)
  })

  it('★★★ 警告つきの結果は、上部で「確認しました」を押すまで、閉じて開き直しても main に残り、上部に出る（押すと消える）', async () => {
    viewing('hanamii')
    const first = open()
    await settle()
    const op = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, url: 'https://example.test/', warnings: ['まだ動いていません'] })
    await op.finish()
    expect(first.root.hasButton(CONFIRM_BUTTON)).toBe(true)
    // 押さずに閉じる。開き直しても出る
    first.root.unmount()
    const second = open()
    await settle()
    expect(second.root.text(), '確認しないまま閉じたのに、開き直すと警告が消えている').toContain('まだ動いていません')
    expect(second.root.hasButton(CONFIRM_BUTTON)).toBe(true)
    // 押すと、見たことになる
    second.root.click(second.root.button(CONFIRM_BUTTON))
    await settle()
    expect(second.root.text()).not.toContain('まだ動いていません')
    expect(getOps(DIR).last).toBeNull()
    second.root.unmount()
    const third = open()
    await settle()
    expect(third.root.text()).not.toContain('まだ動いていません')
  })

  for (const c of [
    { name: 'Vercel', view: 'vercel', meta: VERCEL_PUBLISH },
    { name: '共用型（さくらのAppRun）', view: 'sakura-apprun', meta: APPRUN_APPLY },
    { name: '専有型の⑧', view: 'sakura-apprun-dedicated', meta: DEDICATED_PUBLISH },
  ]) {
    it(`★★ ${c.name} の画面を見ていても、警告つきの結果は上部に出る（パネルの結果欄は下のほうにあり、スクロールしないと見えない）`, async () => {
      viewing(c.view)
      const op = startOp(DIR, '公開', c.meta, { ok: true, url: 'https://example.test/', warnings: ['DNS の設定がまだです'] })
      const { root } = open()
      await settle()
      await op.finish()
      expect(root.text()).toContain('DNS の設定がまだです')
      expect(root.hasButton(CONFIRM_BUTTON)).toBe(true)
    })
  }

  it('★★★ 別の公開先の結果は、HANAMII の画面を見ていても上部に出る（別の公開先の警告＝月額が続く、を見逃さない最後の受け皿）', async () => {
    viewing('hanamii')
    const op = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'koto-data-bucket' })
    const { root } = open()
    await settle()
    await op.finish()
    expect(root.text()).toContain('koto-data-bucket')
    expect(root.text()).toContain('課金は続きます')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(true)
  })

  it('★★ 別の公開先の走っている操作は、上部に進み具合が出る（パネルは1行で知らせるだけ・掟11）', async () => {
    viewing('hanamii')
    const op = startOp(DIR, '削除', TEARDOWN)
    reportProgress(DIR, 'アプリを削除しています…')
    const { root } = open()
    await settle()
    expect(root.findAll(n => n.props?.role === 'status')).toHaveLength(1)
    expect(root.text()).toContain('アプリを削除しています…')
    await op.finish()
  })

  for (const c of [
    { name: 'Vercel', view: 'vercel', meta: VERCEL_PUBLISH, title: '▲ Vercelの公開が終わりました' },
    { name: '共用型（さくらのAppRun）', view: 'sakura-apprun', meta: APPRUN_APPLY, title: 'さくらのAppRunの公開が終わりました' },
    { name: '専有型の⑧', view: 'sakura-apprun-dedicated', meta: DEDICATED_PUBLISH, title: 'の公開が終わりました' },
  ]) {
    it(`★★ ${c.name} の画面を見ているとき、その公開先の結果は上部に出さない（各パネルが出す）`, async () => {
      viewing(c.view)
      const op = startOp(DIR, '公開', c.meta, { ok: true, url: 'https://example.test/' })
      const { root } = open()
      await settle()
      await op.finish()
      expect(root.text()).not.toContain(c.title)
      expect(root.hasButton(CONFIRM_BUTTON)).toBe(false)
    })
  }

  it('★★★ 専有型の画面でも、⑤⑥⑧に無い操作（📡 一覧の「アプリだけ破棄」）の結果は、パネルが出さないので上部に出す', async () => {
    viewing('sakura-apprun-dedicated')
    const op = startOp(DIR, '削除', DEDICATED_TEARDOWN_APP, { ok: false, message: '削除中のまま止まりました' })
    const { root } = open()
    await settle()
    await op.finish()
    expect(root.text(), 'パネルが出さない結果が、どこにも出ていない（見逃す）').toContain('削除中のまま止まりました')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(true)
  })

  it('★★★ 共用型の画面を見ているとき、専有型（隠れたタブ）の結果は、利用者が見られないので上部に出る', async () => {
    viewing('sakura-apprun')
    const op = startOp(DIR, '公開', DEDICATED_PUBLISH, { ok: true, warnings: ['DNS の設定がまだです'] })
    const { root } = open()
    await settle()
    await op.finish()
    expect(root.text()).toContain('DNS の設定がまだです')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(true)
  })

  it('★★★ 公開先を選ぶ前（選択画面）・レンタルサーバの画面では、従来どおり全部を上部に出す（どの画面も出さない）', async () => {
    for (const view of [null, 'sakura-rental']) {
      resetProjectOpsForTests()
      api = makeApi(); install(api)
      if (view) viewing(view)
      const op = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, warnings: ['まだ動いていません'] })
      await op.finish()
      const { root } = open()
      await settle()
      expect(root.text(), String(view)).toContain('まだ動いていません')
      expect(root.hasButton(CONFIRM_BUTTON), String(view)).toBe(true)
      root.unmount()
    }
  })

  it('★★★ 公開先の選択画面で終わった結果は上部に出る。その公開先の画面へ移ると、パネルが出すので上部からは消える（警告なし）', async () => {
    const op = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, url: 'https://example.test/' })
    await op.finish()
    const { root } = open()
    await settle()
    expect(root.text()).toContain('🌸 HANAMIIの公開が終わりました')
    root.click(root.findAll(n => n.type === 'button' && root.nodeText(n).includes('🌸 HANAMII（国産のクラウドサービス）'))[0])
    await settle()
    expect(root.text(), 'その画面へ移ったのに、上部にも残っている（パネルと二重）').not.toContain('🌸 HANAMIIの公開が終わりました')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(false)
  })

  it('★★★ 警告つきの結果は、その公開先の画面へ移っても、上部に残る（パネルが出していても、「確認しました」まで）', async () => {
    const op = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, warnings: ['まだ動いていません'] })
    await op.finish()
    const { root } = open()
    await settle()
    expect(root.text()).toContain('まだ動いていません')
    root.click(root.findAll(n => n.type === 'button' && root.nodeText(n).includes('🌸 HANAMII（国産のクラウドサービス）'))[0])
    await settle()
    expect(root.text(), 'その画面へ移っただけで、確認していない警告が消えた').toContain('まだ動いていません')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(true)
  })

  it('★★★ 画面の前で見た結果（警告なし）は、別の画面（公開先の選択）へ戻っても、上部に出し直さない', async () => {
    viewing('hanamii')
    const { root } = open()
    await settle()
    const op = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, url: 'https://example.test/' })
    await op.finish()
    expect(root.text()).not.toContain('🌸 HANAMIIの公開が終わりました') // パネルが出している間は、上部には出ない
    root.click(root.button('← 公開先を変更'))
    await settle()
    expect(root.text(), '見終えた結果が、戻ったときに「確認しました」まで残るカードとして出直している').not.toContain('🌸 HANAMIIの公開が終わりました')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(false)
  })

  it('★★ 公開先が決まる前（読み込み中）は、上部に結果を出さない（あとでパネルが出す分を、一瞬出して消さない）', async () => {
    viewing('hanamii')
    const done = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, url: 'https://example.test/' })
    await done.finish()
    let release!: () => void
    api.state.metaGate = new Promise<void>(r => { release = r })
    const { root } = open()
    await settle()
    // 記録は届いているが、どの公開先の画面を見るかがまだ決まっていない
    expect(root.text()).toContain('読み込み中')
    expect(root.text(), '公開先が決まる前に、上部に結果が一瞬出ている').not.toContain('🌸 HANAMIIの公開が終わりました')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(false)
    release()
    await settle()
    expect(root.text()).not.toContain('🌸 HANAMIIの公開が終わりました') // HANAMII の画面を見ている＝パネルが出す
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(false)
  })

  it('★★ 読み込み中は警告つきの結果も出さない。読み込みが済んだら、警告つきの結果は上部に出る', async () => {
    viewing('hanamii')
    const done = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, warnings: ['まだ動いていません'] })
    await done.finish()
    let release!: () => void
    api.state.metaGate = new Promise<void>(r => { release = r })
    const { root } = open()
    await settle()
    expect(root.text()).toContain('読み込み中')
    expect(root.text(), '公開先が決まる前に、上部に結果が一瞬出ている').not.toContain('まだ動いていません')
    release()
    await settle()
    expect(root.text()).toContain('まだ動いていません')
    expect(root.hasButton(CONFIRM_BUTTON)).toBe(true)
  })

  it('★★ 上部で「確認しました」と押しても、パネルが出している（より新しい）記録は ack しない（上部に見せた分までしか伝えない）', async () => {
    viewing('hanamii')
    const { root } = open()
    await settle()
    const foreign = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'bk-1234567' })   // 上部に出る（別の公開先）
    await foreign.finish()
    const foreignStartedAt = getOps(DIR).last!.startedAt
    const own = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true })                              // パネルが出す（上部には出ない）
    await own.finish()
    const ownStartedAt = getOps(DIR).last!.startedAt
    expect(ownStartedAt).toBeGreaterThan(foreignStartedAt)
    root.click(root.button(CONFIRM_BUTTON))
    await settle()
    expect(api.projectOps.ack).toHaveBeenCalledWith(DIR, foreignStartedAt)
    expect(api.projectOps.ack, 'パネルが出している記録まで、上部が見たことにした（パネルの ack を待たずに消える）').not.toHaveBeenCalledWith(DIR, ownStartedAt)
    expect(getOps(DIR).last?.startedAt, '上部が見せていない記録が main から消えた').toBe(ownStartedAt)
  })

  it('★★ 目の前に無い間に終わった結果を、上部で「確認しました」と押すと、押した分だけ ack する（パネルが出している分は伝えない）', async () => {
    viewing('hanamii')
    const { root } = open()
    await settle()
    const own = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true })
    await own.finish()
    const foreign = startOp(DIR, '削除', TEARDOWN, { ok: true, keptBucketName: 'bk-1234567' })
    await foreign.finish()
    const foreignStartedAt = getOps(DIR).last!.startedAt
    root.click(root.button(CONFIRM_BUTTON))
    await settle()
    expect(api.projectOps.ack).toHaveBeenCalledWith(DIR, foreignStartedAt)
    expect(root.text()).not.toContain('bk-1234567')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 掟5・掟8・掟4: 文は素のテキスト・製品名・秘密
// ═════════════════════════════════════════════════════════════════════════════

describe('画面の文の掟', () => {
  it('★ 出す文は素のテキスト（Markdown 記法なし・掟5）で、「Claude Code」を含まない（掟8）', async () => {
    const done = startOp(DIR, '削除', TEARDOWN, { ok: false, message: '失敗しました', warnings: ['⚠️ 残っています'], detail: '診断の文', executed: ['アプリを削除しました'] })
    await done.finish()
    const op = startOp(DIR, '公開', HANAMII_PUBLISH)
    reportProgress(DIR, '公開しています…', { detail: '補足' })
    const { root } = open()
    await settle()
    const t = root.text()
    expect(t).not.toMatch(/\*\*|`|^#|\n#/)
    expect(t).not.toContain('Claude Code')
    await op.finish()
  })

  it('★ ⚠️ で始まる警告に、⚠️ を二重に付けない。印の無い警告には付ける', async () => {
    const op = startOp(DIR, '公開', HANAMII_PUBLISH, { ok: true, warnings: ['⚠️ 印つきの警告', '印なしの警告'] })
    await op.finish()
    const { root } = open()
    await settle()
    const t = root.text()
    expect(t).toContain('⚠️ 印つきの警告')
    expect(t).not.toContain('⚠️ ⚠️')
    expect(t).toContain('⚠️ 印なしの警告')
  })
})
