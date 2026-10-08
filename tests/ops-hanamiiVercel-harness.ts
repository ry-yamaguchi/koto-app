// ops-hanamiiVercel-harness.ts — HanamiiPanel・VercelPanel の「閉じて開き直したとき」を動かして見る道具（テスト専用）。
//
// ── なぜ作ったか ──────────────────────────────────────────────────────────
// 既存の画面テスト（tests/hanamiiPanelRefresh.test.ts など）は、偽の react で hooks を手で回し、jsx は null を返す。
// あれは「effect が何を呼ぶか」しか見られない。ここで見たいのは**画面に何が出るか**
// （進み具合・結果・警告が出る／ack のあとは出ない）なので、次の3つを用意した:
//   1. 最小の react の代わり（useState・useEffect・useCallback・useMemo・useRef を、再描画と後片づけつきで動かす）
//   2. 描いた要素の木から、画面に出る文字とボタンを読む道具
//   3. **本物の main の記録**（src/main/projectOps.ts・projectLock.ts）に裏打ちされた偽の electronAPI
//      ——記録の作り方・ack の意味（startedAt 以下だけ見たことにする）を、テスト側で複製しない（掟10）
// 「コンポーネントを外して付け直す」（unmount → mount）で、開き直しを再現する。
//
// **秘密は使わない**: トークンはテスト用の作り物の文字列。

import { getOps, ackOps, setProjectOpsListener, resetProjectOpsForTests, reportProgress } from '../src/main/projectOps'
import { withProjectLock, projectBusyMessage } from '../src/main/projectLock'
import { progressReporter } from '../src/main/projectOps'
import { withoutPublishTargetInMeta } from '../src/shared/publishMeta'

// ── 1. 最小の react ──────────────────────────────────────────────────────

export const Fragment = Symbol('Fragment')
type El = { $$el: true; type: unknown; props: Record<string, unknown>; key?: unknown }
const el = (type: unknown, props: Record<string, unknown> | null, key?: unknown): El => ({ $$el: true, type, props: props ?? {}, key })

class Inst {
  slots: any[] = []
  cursor = 0
  seen = false
}

let activeRoot: FakeRoot | null = null
let current: Inst | null = null

function slotFor(): { inst: Inst; i: number } {
  if (!current) throw new Error('hooks は描いている最中にしか呼べない')
  return { inst: current, i: current.cursor++ }
}
const depsChanged = (a: unknown[] | undefined, b: unknown[] | undefined): boolean =>
  !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]))

export const reactModule = {
  useState: (init: unknown) => {
    const { inst, i } = slotFor()
    const root = activeRoot!
    if (!(i in inst.slots)) inst.slots[i] = { v: typeof init === 'function' ? (init as () => unknown)() : init }
    const slot = inst.slots[i]
    const set = (v: unknown) => {
      const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(slot.v) : v
      if (Object.is(next, slot.v)) return
      slot.v = next
      root.schedule()
    }
    return [slot.v, set]
  },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    const { inst, i } = slotFor()
    const root = activeRoot!
    if (!(i in inst.slots)) inst.slots[i] = { deps: undefined, cleanup: undefined, ran: false }
    const slot = inst.slots[i]
    if (!slot.ran || depsChanged(slot.deps, deps)) {
      root.pendingEffects.push(() => {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        const c = fn()
        slot.cleanup = typeof c === 'function' ? c : undefined
        slot.deps = deps
        slot.ran = true
      })
    }
  },
  useMemo: (fn: () => unknown, deps?: unknown[]) => {
    const { inst, i } = slotFor()
    if (!(i in inst.slots) || depsChanged(inst.slots[i].deps, deps)) inst.slots[i] = { v: fn(), deps }
    return inst.slots[i].v
  },
  useCallback: (fn: unknown, deps?: unknown[]) => {
    const { inst, i } = slotFor()
    if (!(i in inst.slots) || depsChanged(inst.slots[i].deps, deps)) inst.slots[i] = { v: fn, deps }
    return inst.slots[i].v
  },
  useRef: (init: unknown) => {
    const { inst, i } = slotFor()
    if (!(i in inst.slots)) inst.slots[i] = { current: init }
    return inst.slots[i]
  },
  default: {},
}

export const jsxRuntimeModule = { jsx: el, jsxs: el, Fragment }
export const jsxDevRuntimeModule = { jsxDEV: el, Fragment }

// ── 描いた木 ──────────────────────────────────────────────────────────────

type Out = string | null | Out[] | { tag: string; props: Record<string, any>; children: Out }

class FakeRoot {
  instances = new Map<string, Inst>()
  tree: Out = null
  pendingEffects: Array<() => void> = []
  scheduled = false
  unmounted = false
  constructor(private Component: (p: any) => unknown, public props: Record<string, unknown>) {}

  render(): void {
    this.instances.forEach(i => { i.seen = false })
    this.pendingEffects = []
    const prev = activeRoot
    activeRoot = this
    try {
      this.tree = this.expand(el(this.Component, this.props), 'r')
    } finally {
      activeRoot = prev
      current = null
    }
    for (const [path, inst] of Array.from(this.instances.entries())) {
      if (!inst.seen) {
        for (const s of inst.slots) if (s && typeof s.cleanup === 'function') s.cleanup()
        this.instances.delete(path)
      }
    }
    const effects = this.pendingEffects
    this.pendingEffects = []
    for (const run of effects) run()
  }

  schedule(): void {
    if (this.scheduled || this.unmounted) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.unmounted) this.render()
    })
  }

  unmount(): void {
    this.unmounted = true
    for (const inst of this.instances.values()) {
      for (const s of inst.slots) if (s && typeof s.cleanup === 'function') s.cleanup()
    }
    this.instances.clear()
  }

  private expand(node: unknown, path: string): Out {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string') return node
    if (typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map((n, i) => this.expand(n, `${path}/${(n as El | null)?.key ?? i}`))
    const e = node as El
    if (e.type === Fragment) return this.expand(e.props.children, path)
    if (typeof e.type === 'function') {
      const fn = e.type as (p: unknown) => unknown
      const key = `${path}:${fn.name || 'C'}`
      let inst = this.instances.get(key)
      if (!inst) { inst = new Inst(); this.instances.set(key, inst) }
      inst.seen = true
      inst.cursor = 0
      current = inst
      let out: unknown
      try { out = fn(e.props) } finally { current = null }
      return this.expand(out, key)
    }
    const { children, ...rest } = e.props
    return { tag: String(e.type), props: rest, children: this.expand(children, `${path}/${String(e.type)}`) }
  }
}

const BLOCK = new Set(['div', 'p', 'li', 'ul', 'ol', 'section', 'pre', 'details', 'summary', 'button', 'label', 'select', 'option'])

function linesOf(tree: Out): string[] {
  const lines: string[] = []
  let cur = ''
  const flush = () => { if (cur.trim()) lines.push(cur.trim()); cur = '' }
  const walk = (n: Out) => {
    if (n === null) return
    if (typeof n === 'string') { cur += n; return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    const block = BLOCK.has(n.tag)
    if (block) flush()
    walk(n.children)
    if (block) flush()
  }
  walk(tree)
  flush()
  return lines
}

export type Btn = { text: string; disabled: boolean; click: () => void }

export type Mounted = {
  /** 画面に出ている文字（1行ずつ）。 */
  lines(): string[]
  /** 画面に出ている文字の全体。 */
  text(): string
  has(s: string): boolean
  /** s が画面に何回出ているか（二重に出ていないかを見る）。 */
  count(s: string): number
  buttons(): Btn[]
  /** 文字に s を含むボタン（無ければ undefined）。 */
  button(s: string): Btn | undefined
  unmount(): void
  /** 同じ画面のまま、渡す値だけ変える（開いたままプロジェクトが切り替わる）。 */
  rerender(props: Record<string, unknown>): void
}

export function mount(Component: (p: any) => unknown, props: Record<string, unknown>): Mounted {
  const root = new FakeRoot(Component, props)
  root.render()
  const buttons = (): Btn[] => {
    const found: Btn[] = []
    const walk = (n: Out) => {
      if (n === null || typeof n === 'string') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (n.tag === 'button') {
        found.push({
          text: linesOf(n.children).join(' '),
          disabled: !!n.props.disabled,
          click: () => { (n.props.onClick as (() => void) | undefined)?.() },
        })
        return
      }
      walk(n.children)
    }
    walk(root.tree)
    return found
  }
  const text = () => linesOf(root.tree).join('\n')
  return {
    lines: () => linesOf(root.tree),
    text,
    has: s => text().includes(s),
    count: s => text().split(s).length - 1,
    buttons,
    button: s => buttons().find(b => b.text.includes(s)),
    unmount: () => root.unmount(),
    rerender: p => { root.props = p; root.render() },
  }
}

/** 非同期の連鎖（読み込み→状態→再描画）が落ち着くまで待つ。 */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0))
}

// ── 2. 偽の main（本物の記録・鍵に裏打ちする）──────────────────────────────

export type Deferred<T = void> = { promise: Promise<T>; resolve: (v: T) => void }
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

/** 偽の HANAMII 公開の返り値の例（本物の hanamii:publish が返す形）。 */
export const HANAMII_READY = {
  ok: true, projectId: 'prj_test1', deploymentId: 'dpl_test1', deployState: 'ready', readyState: 'READY',
  url: 'https://app-test.example.test',
} as const

export type World = ReturnType<typeof makeWorld>

export function makeWorld(dir: string) {
  const listeners = new Set<(p: any) => void>()
  const calls = {
    ack: [] as Array<[string, number | undefined]>,
    get: [] as string[],
    hanamiiPublish: [] as unknown[],
    hanamiiTeardown: [] as unknown[],
    hanamiiStatus: 0,
    cleanUpKeys: 0,
    setInterval: 0,
    vercelPublish: [] as unknown[],
    vercelOnProgress: 0,
    merge: [] as Array<Record<string, unknown>>,
    forgetTarget: [] as string[],
    events: [] as string[],
  }
  const world = {
    dir,
    calls,
    /**
     * プロジェクトごとの記録（.sakuraide.json）の中身（projectDir → 中身）。あれば、readFile はその projectDir の分を返す
     * （開いたまま別のプロジェクトへ切り替わる場面を作る）。無い projectDir は下の `meta` を返す。
     */
    metaByDir: {} as Record<string, any>,
    /** 公開先の記録（.sakuraide.json）の中身。 */
    meta: { publish: { hanamii: { workspaceId: 'ws1', name: 'app' }, vercel: { name: 'app', tokenId: 't1' }, targets: {} as Record<string, unknown> } } as any,
    /** 押し出し（onChanged）を止める（「画面が知らないうちに main が進んだ」を作る）。 */
    mutePush: false,
    /** get の応答を、この約束が果たされるまで遅らせる（写しは呼んだ時点のもの）。 */
    getGate: null as Deferred | null,
    /** 記録ファイルの読み込みの応答を、この約束が果たされるまで遅らせる（中身は呼んだ時点のもの）。 */
    readGate: null as Deferred | null,
    /** 公開・破棄の本体を、この約束が果たされるまで止める（走っている状態を作る）。 */
    opGate: null as Deferred | null,
    publishReply: { ...HANAMII_READY } as any,
    teardownReply: { ok: true, appDeleted: true, executed: [] } as any,
    vercelReply: { ok: true, deploymentId: 'dpl_v1', url: 'https://app-test.vercel.test', readyState: 'READY' } as any,
    statusReply: { ok: true, url: 'https://app-test.example.test', readyState: 'READY', errorCode: null, runtime: { status: 'healthy', detail: null, syncedAt: null } } as any,
    api: null as any,
    /** 好きな公開先・IPC の操作を、本物の鍵と記録の中で走らせる（別の公開先の操作を作るのにも使う）。 */
    guard: null as unknown as (project: string, op: '公開' | '削除' | '作成', meta: { target: any; handler: string }, first: string, body: () => Promise<any>) => Promise<any>,
  }

  const guard = async (project: string, op: '公開' | '削除' | '作成', meta: { target: any; handler: string }, first: string, body: () => Promise<any>): Promise<any> => {
    const progress = progressReporter(project)
    const locked = await withProjectLock(project, op, async () => {
      progress(first)
      if (world.opGate) await world.opGate.promise
      return body()
    }, { ...meta, secrets: [] })
    return locked.busy ? { ok: false, message: projectBusyMessage(locked.running) } : locked.value
  }

  world.guard = guard

  const api: any = {
    projectOps: {
      get: async (p: string) => {
        calls.get.push(p)
        const snap = getOps(p)
        if (world.getGate) await world.getGate.promise
        return snap
      },
      ack: async (p: string, upTo?: number) => {
        calls.ack.push([p, upTo])
        return { ok: true, acked: ackOps(p, upTo) }
      },
      onChanged: (cb: (p: any) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    },
    hanamii: {
      listWorkspaces: async () => ({ ok: true, workspaces: [{ id: 'ws1', name: 'テスト用ワークスペース', role: 'owner' }] }),
      detectEnvKeys: async () => ({ ok: true, keys: [] }),
      status: async () => { calls.hanamiiStatus++; return world.statusReply },
      cleanUpKeys: async () => { calls.cleanUpKeys++; return { ok: true, deleted: 0 } },
      restart: async () => ({ ok: true }),
      logs: async () => ({ ok: true, logs: [] }),
      publish: async (project: string, opts: unknown) => {
        calls.hanamiiPublish.push(opts)
        return guard(project, '公開', { target: 'hanamii', handler: 'hanamii:publish' }, '📦 公開するファイルをまとめています…', async () => world.publishReply)
      },
      teardown: async (projectId: string, _token: string, project?: string) => {
        calls.hanamiiTeardown.push([projectId, project])
        if (!project) return world.teardownReply
        return guard(project, '削除', { target: 'hanamii', handler: 'hanamii:teardown' }, '🗑 HANAMII のプロジェクトを削除しています…', async () => {
          // 本物の main（hanamii:teardown）は、保存場所まで片づいたら、鍵の中で記録（projectId・公開記録）も片づける。
          // ただし**記録が別のプロジェクトを指しているときは触らない**。その判断そのものは
          // tests/hanamiiTeardownRecord.test.ts が本物のハンドラ・本物のディスクで固定している（ここは偽の main の写し）。
          if (world.teardownReply?.ok === true) {
            const onDisk = world.meta?.publish?.hanamii?.projectId
            if (!(typeof onDisk === 'string' && onDisk !== '' && onDisk !== projectId)) world.meta = withoutPublishTargetInMeta(world.meta, 'hanamii')
          }
          return world.teardownReply
        })
      },
    },
    vercel: {
      preflight: async () => ({ ok: true, canPublish: true, summary: '確認しました', checks: [] }),
      onProgress: () => { calls.vercelOnProgress++; return () => {} },
      publish: async (project: string, opts: unknown) => {
        calls.vercelPublish.push(opts)
        return guard(project, '公開', { target: 'vercel', handler: 'vercel:publish' }, 'ファイルを収集しています…', async () => world.vercelReply)
      },
    },
    storage: {
      placement: async () => ({ ok: true, placement: null, placements: [] }),
      scan: async () => ({ usedBy: [] }),
    },
    fs: {
      // 呼んだ時点の中身を返す（応答は readGate が果たされるまで遅らせられる）。遅れて届いた古い値を作るのに使う。
      readFile: async (file: string) => {
        const dir = String(file).replace(/\/\.sakuraide\.json$/, '')
        const snap = JSON.stringify(world.metaByDir[dir] ?? world.meta)
        if (world.readGate) await world.readGate.promise
        return snap
      },
    },
    publishMeta: {
      merge: async (_p: string, patch: Record<string, unknown>) => {
        calls.merge.push(patch)
        return { ok: true, meta: world.meta }
      },
      forgetTarget: async (_p: string, target: string) => {
        calls.forgetTarget.push(target)
        return { ok: true, meta: world.meta }
      },
    },
    win: { setBusy: () => {} },
  }
  world.api = api

  // main の記録が変わるたび、IPC のように**少し遅れて**画面へ押し出す。
  // 押し出す相手は、**変わった時点で購読していた画面**（あとから開いた画面には、それより前の知らせは届かない）。
  setProjectOpsListener((projectDir, snapshot) => {
    if (world.mutePush) return
    const targets = Array.from(listeners)
    setTimeout(() => { for (const cb of targets) if (listeners.has(cb)) cb({ projectDir, ...snapshot }) }, 0)
  })

  return world
}

/** 偽の window を作って globalThis に付ける。 */
export function installWindow(world: World): void {
  const win: any = new EventTarget()
  win.electronAPI = world.api
  win.setInterval = (..._a: unknown[]) => { world.calls.setInterval++; return 0 }
  win.clearInterval = () => {}
  win.addEventListener = EventTarget.prototype.addEventListener.bind(win)
  win.removeEventListener = EventTarget.prototype.removeEventListener.bind(win)
  win.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(win)
  ;(globalThis as any).window = win
}

export function resetMain(): void {
  resetProjectOpsForTests()
}

export { getOps, reportProgress, withProjectLock, progressReporter }
