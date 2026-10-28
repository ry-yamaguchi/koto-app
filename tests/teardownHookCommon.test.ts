import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 段階0（0d）: 破棄の行・節が持つ画面の状態（フック useTeardownFlow と 行 TeardownRow）──────────────────────
//
// どの入口・IPC からもまだ呼ばれない（部品と単体テストだけ）。設計書: docs/teardown-unify-plan.md の 10.3.4 の E。
// **ソースの文字列を読まない**（掟10「お金・破壊の歯止めは、振る舞いで固定する」。配線の形は tests/teardownCommonWiring.test.ts）。
//
//   E-1 キャンセル              … IPC 0回・結果も出ず・窓を閉じる警告も立たない
//   E-2 破棄する             … onOutcome 1回。beginLocal → endLocal。ack は結果を出し終えたあと
//   E-3 窓を閉じる警告       … 実行中は win.setBusy に警告つきで載り、終われば外れる
//   E-4 二重押し             … IPC 1回
//   E-5 閉じて開き直す       … 走っている最中は続きが、終わっていれば結果が、記録（resumedTeardownView）から1回だけ出る
//   E-6 行                   … 実行中の印を下ろす・押せない条件・確認ダイアログが行の中に描かれる
//
// 仕様書は偽（target は 'hanamii'）だが、IPC の代わりに**本物の骨（runTeardownShell）と本物の withProjectLock** を通す。
// そのため main の処理の記録（projectOps）が本物の形でできて、フックの記録の監視（watchTeardownOps）が本物の記録を読む。
// React は DOM 環境を入れていないので、react の useState／useRef／useCallback／useEffect だけをこの試験用の小さな実装に差し替えて、
// フックの関数をそのまま呼ぶ（tests/dedicatedTeardownEntries.test.ts と同じやり方）。

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) } | undefined>,
  queue: [] as Array<{ idx: number; fn: () => void | (() => void); deps?: readonly unknown[] }>,
  i: 0, r: 0, e: 0,
  rerender: () => {},
}))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const idx = rt.i++
      if (!(idx in rt.slots)) rt.slots[idx] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[idx]) : v
        if (Object.is(next, rt.slots[idx])) return
        rt.slots[idx] = next
        rt.rerender()
      }
      return [rt.slots[idx], set]
    },
    useRef: (init: unknown) => {
      const idx = rt.r++
      if (!rt.refs[idx]) rt.refs[idx] = { current: init }
      return rt.refs[idx]
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const idx = rt.e++
      const prev = rt.effects[idx]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]))
      if (changed) rt.queue.push({ idx, fn, deps })
    },
  }
})

import { runTeardownShell, type TeardownShellSpec } from '../src/main/cloud/teardownShell'
import { withProjectLock } from '../src/main/projectLock'
import { getOps, ackOps, setProjectOpsListener, resetProjectOpsForTests } from '../src/main/projectOps'
import { useTeardownFlow, type TeardownFlowOutcome } from '../src/renderer/teardown/useTeardownFlow'
import TeardownRow from '../src/renderer/components/teardown/TeardownRow'
import TeardownProgress from '../src/renderer/components/teardown/TeardownProgress'
import { resumedTeardownNote } from '../src/renderer/teardown/watch'
import { toTeardownView, resumedTeardownView } from '../src/shared/teardownResult'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import type { TargetSpec, TeardownWords } from '../src/renderer/teardown/types'
import type { PublishedEntry } from '../src/renderer/publishedIndex'

type Rec = { projectId: string | null; name: string }
type Auth = { token: string }
type Reply = {
  ok: boolean; message?: string; executed?: string[]; keptBucketName?: string
  /** 専有型の返り値の形（E-7）。 */
  appDeleted?: boolean; remaining?: Record<string, string>; inProgress?: Record<string, string>
}

const RECORD: Rec = { projectId: 'p1', name: 'myapp' }
const AUTH: Auth = { token: 'tok-1234567890' }
const KEY_MISSING = 'HANAMII のトークンが未登録です（テスト）'
const EMPTY_OPS = { running: null, last: null, earlier: [] }
const tick = async () => { for (let k = 0; k < 6; k++) await new Promise<void>(r => setTimeout(r, 0)) }

const HANAMII_WORDS: TeardownWords = {
  verb: '破棄',
  confirmTitle: 'HANAMII の公開を破棄します',
  confirmLabel: '破棄する',
  activityLabel: 'HANAMII の破棄',
  rowButton: '🗑 破棄',
  running: '破棄しています…',
  doneHeadline: '✅ 破棄しました',
  inProgressHeadline: '⏳ 破棄の途中です',
  failedHeadline: '⚠️ 破棄できませんでした',
  factsUnreadable: '破棄するものの記録を読めませんでした',
  nothingToDo: 'HANAMII のプロジェクトIDが記録に無いため、ここからは削除できません。',
  askAiTarget: 'HANAMII',
}

// ── 偽の仕様書 ＋ 本物の骨 ─────────────────────────────────────────────────────────────

/** 骨の中の run（外部へ出る道）の代わり。gate で止められる。 */
let gate: Promise<void> | null
let runResult: Reply
let runCount: number
/** 骨の run が呼ばれたときに、ctx.progress へ流す文（記録の進み具合になる）。 */
let runProgress: string | null
let authLoads: number
let authGate: Promise<void> | null
let authAnswer: Auth | null
let invokes: Array<{ dir: string; auth: Auth; opts: unknown; record: Rec }>
let throwOnInvoke: Error | null
let readRecordImpl: () => Promise<Rec>

const shellSpec: TeardownShellSpec<Auth, Reply> = {
  target: 'hanamii',
  handler: 'hanamii:teardown',
  parseAuth: a => {
    const t = (a as { token?: unknown } | null | undefined)?.token
    return typeof t === 'string' && t ? { token: t } : null
  },
  authMissingMessage: 'トークンが未登録です',
  secretsOf: a => [a.token],
  twinsOf: () => [], // 複製なし
  run: async ctx => {
    runCount++; win.events.push('run')
    if (runProgress) ctx.progress(runProgress)
    if (gate) await gate
    return runResult
  },
  shouldForgetRecord: () => false,
  forgetRecord: () => ({ ok: true }),
  refused: message => ({ ok: false, message }),
}

function makeSpec(over: Partial<TargetSpec<Rec, Auth, Reply>> = {}): TargetSpec<Rec, Auth, Reply> {
  return {
    target: 'hanamii',
    handler: 'hanamii:teardown',
    words: HANAMII_WORDS,
    claimsComputeBillingStops: false,
    irreversibleNote: 'storage-only',
    readRecord: () => readRecordImpl(),
    hasWork: r => !!r.projectId,
    targets: r => [`HANAMII のプロジェクト『${r.name}』`],
    loadAuth: async () => {
      authLoads++
      if (authGate) await authGate
      return authAnswer
    },
    // IPC の代わりに本物の骨を通す（処理の記録・鍵・確認の印の検査が本物）。
    invoke: async (d, auth, opts, record) => {
      invokes.push({ dir: d, auth, opts, record })
      if (throwOnInvoke) throw throwOnInvoke
      return runTeardownShell(shellSpec, { projectDir: d, auth, opts })
    },
    failure: message => ({ ok: false, message }),
    toView: raw => toTeardownView('hanamii', raw),
    ...over,
  }
}

// ── 偽の window ─────────────────────────────────────────────────────────────────────

type Win = {
  /** setBusy（窓を閉じる警告）の呼び出し。 */
  busy: unknown[][]
  dispatched: string[]
  acks: Array<[string, number | undefined]>
  /** 呼ばれた順の出来事（run・outcome・ack・finished）。 */
  events: string[]
  /** 記録の問い合わせ（get）の回数。 */
  gets: number
  intervals: Array<{ fn: () => void; ms: number; cleared: boolean }>
}
let win: Win
let dir: string

function installWindow() {
  win = { busy: [], dispatched: [], acks: [], events: [], gets: 0, intervals: [] }
  const subs = new Set<(p: any) => void>()
  setProjectOpsListener((projectDir, snapshot) => { for (const cb of [...subs]) cb({ projectDir, ...snapshot }) })
  ;(globalThis as any).window = {
    electronAPI: {
      storage: { placement: async () => ({ ok: true, placement: null, placements: [] }) },
      // exists: 旧い共用型の記録（state.json）は無い（D9=2。.sakuraide.json だけがある）。
      fs: { readFile: async () => JSON.stringify({ publish: { targets: { hanamii: { publishedAt: '2026-10-01T00:00:00.000Z' } } } }), exists: async (p: string) => String(p).endsWith('/.sakuraide.json') },
      stageTiming: { estimates: async () => null },
      win: { setBusy: (...a: unknown[]) => { win.busy.push(a) } },
      projectOps: {
        get: async (d: string) => { win.gets++; return getOps(d) },
        ack: async (d: string, upTo?: number) => { win.events.push('ack'); win.acks.push([d, upTo]); return { ok: true, acked: ackOps(d, upTo) } },
        onChanged: (cb: (p: any) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
      },
    },
    dispatchEvent: (e: { type: string }) => { win.dispatched.push(e.type); return true },
    setInterval: (fn: () => void, ms: number) => { win.intervals.push({ fn, ms, cleared: false }); return win.intervals.length },
    clearInterval: (id: number) => { if (win.intervals[id - 1]) win.intervals[id - 1].cleared = true },
  }
}

beforeEach(() => {
  resetProjectOpsForTests()
  gate = null; authGate = null
  runResult = { ok: true, executed: ['✅ 消しました'] }
  runCount = 0; runProgress = null; authLoads = 0; authAnswer = AUTH
  invokes = []; throwOnInvoke = null
  readRecordImpl = async () => RECORD
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-teardown-hook-'))
  installWindow()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete (globalThis as any).window
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.rerender = () => {}
})

// ── React の小さな代役の上でフックを動かす ──────────────────────────────────────────────

function flushEffects() {
  const todo = rt.queue; rt.queue = []
  for (const q of todo) {
    const prev = rt.effects[q.idx]
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    // 効果の中で setState して描き直しが走っても、この効果を「もう付いている」と見られるよう、先に印を置く
    const slot: { deps?: readonly unknown[]; cleanup?: void | (() => void) } = { deps: q.deps }
    rt.effects[q.idx] = slot
    slot.cleanup = q.fn()
  }
}
function unmountAll() {
  for (const e of rt.effects) if (e && typeof e.cleanup === 'function') e.cleanup()
  rt.effects = []
  rt.rerender = () => {} // 外したあとに届く古い更新で、描き直しが走らないように
}

function mountHook(spec: TargetSpec<Rec, Auth, Reply>, over: { dir?: string; onFinished?: () => void | Promise<void> } = {}) {
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.r = 0; rt.e = 0
  const outcomes: TeardownFlowOutcome[] = []
  const finished: number[] = []
  let latest!: ReturnType<typeof useTeardownFlow<Rec, Auth, Reply>>
  const cur = { dir: over.dir ?? dir }
  const history: Array<{ tearingDown: boolean; progress: string | null; running: boolean }> = []
  const render = () => {
    rt.i = 0; rt.r = 0; rt.e = 0; rt.queue = []
    latest = useTeardownFlow(cur.dir, spec, {
      keyMissingMessage: KEY_MISSING,
      onOutcome: o => { win.events.push('outcome'); outcomes.push(o) },
      onFinished: () => { win.events.push('finished'); finished.push(outcomes.length); return over.onFinished?.() },
    })
    history.push({ tearingDown: latest.tearingDown, progress: latest.progress, running: latest.running })
    flushEffects()
  }
  rt.rerender = render
  render()
  return {
    get latest() { return latest },
    outcomes, finished, history,
    /** プロジェクトを切り替える（同じ画面が別のプロジェクトを指す）。 */
    switchDir(d: string) { cur.dir = d; render() },
    unmount: unmountAll,
  }
}
type Mounted = ReturnType<typeof mountHook>

async function answer(m: Mounted, yes: boolean) {
  for (let k = 0; k < 400 && !(m.latest.confirmElement as any).props.open; k++) await tick()
  expect((m.latest.confirmElement as any).props.open, '確認ダイアログ（ConfirmModal）が開かない').toBe(true)
  const props = (m.latest.confirmElement as any).props
  expect(props.danger).toBe(true)
  if (yes) props.onConfirm(); else props.onCancel()
}
/** 条件が成り立つまで少し待つ。 */
async function until(cond: () => boolean, what: string) {
  for (let k = 0; k < 400 && !cond(); k++) await tick()
  expect(cond(), what).toBe(true)
}
const holdGate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { p, open } }
const closeWarningCall = [true, 'HANAMII の破棄', true, 'HANAMII の破棄', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel]

// ═══════════════════════════════════════════════════════════════════════════════
// E-1〜E-4 フック: 押す → 確認 → 実行 → 結果
// ═══════════════════════════════════════════════════════════════════════════════

describe('E フック useTeardownFlow: 押す → 確認 → 破棄 → 結果', () => {
  it('★★★ E-1 キャンセル: IPC は0回・キーも読まず・結果も出ず、窓を閉じる警告も立たない。処理の記録も増えない', async () => {
    const m = mountHook(makeSpec())
    const started = m.latest.start()
    await answer(m, false)
    await started

    expect(invokes).toEqual([])
    expect(runCount).toBe(0)
    expect(authLoads).toBe(0)
    expect(m.outcomes).toEqual([])
    expect(m.finished).toEqual([])
    expect(win.busy).toEqual([]) // setBusy（窓を閉じる警告）は1回も立たない
    expect(win.acks).toEqual([])
    expect(m.latest.tearingDown).toBe(false)
    expect(getOps(dir)).toEqual(EMPTY_OPS)
    m.unmount()
  })

  it('★★★ E-2 破棄する: IPC は { confirmed: true } 付きで1回だけ。結果が1回出て、出し終えたあとで記録を「見た」にする', async () => {
    const m = mountHook(makeSpec())
    const started = m.latest.start()
    await answer(m, true)
    await started
    await tick()

    expect(invokes).toHaveLength(1)
    expect(invokes[0]).toEqual({ dir, auth: AUTH, opts: { confirmed: true, shownPlacements: [] }, record: RECORD })
    expect(runCount).toBe(1)
    expect(m.outcomes).toHaveLength(1) // 記録からの二重の結果は出ない
    expect(m.outcomes[0].view.ok).toBe(true)
    expect(m.outcomes[0].view.state).toBe('done')
    expect(m.outcomes[0].view.executed).toEqual(['✅ 消しました'])
    expect(m.outcomes[0].notes).toEqual([])
    expect(win.dispatched).toContain('sakura-meta-changed') // 開いている画面へ知らせる
    // 順序: 骨の run → 結果を出す → 「見た」と伝える → 一覧を読み直す。出し終える前（run の終わりの時点）では ack しない。
    expect(win.events).toEqual(['run', 'outcome', 'ack', 'finished'])
    expect(m.finished).toEqual([1]) // 結果を渡したあとで一覧を読み直す
    expect(win.acks).toHaveLength(1)
    expect(getOps(dir)).toEqual(EMPTY_OPS) // 見た印が付いて、未読の記録から消えた
    expect(m.latest.tearingDown).toBe(false)
    m.unmount()
  })

  it('★★★ E-2b 警告つきの結果（保存場所を残して月額が続く）: 結果は出るが、記録は「見た」にしない（上部の「確認しました」まで残す）', async () => {
    runResult = { ok: true, executed: [], keptBucketName: 'koto-data-x' }
    const m = mountHook(makeSpec())
    const started = m.latest.start()
    await answer(m, true)
    await started
    await tick()

    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.warnings.some(w => w.includes('koto-data-x'))).toBe(true)
    expect(win.acks).toEqual([]) // 警告つきの記録は、画面が「見た」と伝えない
    expect(getOps(dir).last?.seen).toBe(false)
    m.unmount()
  })

  it('★★ 確認ダイアログは仕様書の言葉で出る（見出し・ボタン）。消すものの名前が入る', async () => {
    const m = mountHook(makeSpec())
    const started = m.latest.start()
    for (let k = 0; k < 400 && !(m.latest.confirmElement as any).props.open; k++) await tick()
    const props = (m.latest.confirmElement as any).props
    expect(props.title).toBe('HANAMII の公開を破棄します')
    expect(props.confirmLabel).toBe('破棄する')
    expect(props.body).toContain("HANAMII のプロジェクト『myapp』")
    props.onCancel()
    await started
    m.unmount()
  })

  it('★★★ E-3 窓を閉じる警告: 破棄が走っている間だけ立つ（名前・detail・確認ボタンは PUBLISH_CLOSE_WARNING）。終われば外れる', async () => {
    const g = holdGate(); gate = g.p
    const m = mountHook(makeSpec())
    const started = m.latest.start()
    await answer(m, true)
    await until(() => win.busy.length > 0 && runCount === 1, '破棄が走り出さない')

    expect(win.busy[0]).toEqual(closeWarningCall)
    expect(m.latest.tearingDown).toBe(true)

    g.open()
    await started
    const last = win.busy[win.busy.length - 1]
    expect(last[0]).toBe(false) // 実行中が解けた
    expect(last[2]).toBe(false) // 閉じる警告も解けた
    expect(m.latest.tearingDown).toBe(false)
    m.unmount()
  })

  it('★★ E-4 二重押し: 確認を待っている最中・実行中にもう一度押しても、IPC は1回だけ', async () => {
    const g = holdGate(); gate = g.p
    const m = mountHook(makeSpec())
    const first = m.latest.start()
    const second = m.latest.start() // 確認を待っている最中にもう一度
    await answer(m, true)
    await until(() => runCount === 1, '破棄が走り出さない')
    const third = m.latest.start() // 実行中にもう一度
    g.open()
    await Promise.all([first, second, third])
    expect(invokes).toHaveLength(1)
    expect(runCount).toBe(1)
    expect(m.outcomes).toHaveLength(1)
    m.unmount()
  })

  it('★ 終わったあとは、また押せる（二重押しの印が残らない）', async () => {
    const m = mountHook(makeSpec())
    const s1 = m.latest.start()
    await answer(m, true)
    await s1
    await tick()
    const s2 = m.latest.start()
    await answer(m, true)
    await s2
    expect(invokes).toHaveLength(2)
    m.unmount()
  })

  it('キーが無いとき: IPC は0回。入口の案内文が結果になる。窓を閉じる警告は外れる', async () => {
    authAnswer = null
    const m = mountHook(makeSpec())
    const started = m.latest.start()
    await answer(m, true)
    await started
    expect(invokes).toEqual([])
    expect(runCount).toBe(0)
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.ok).toBe(false)
    expect(m.outcomes[0].view.message).toBe(KEY_MISSING)
    expect(win.busy[0]).toEqual(closeWarningCall)
    expect(win.busy[win.busy.length - 1][0]).toBe(false)
    m.unmount()
  })

  it('★★ IPC が例外: 失敗の結果になる（理由つき）。窓を閉じる警告は外れ、実行中の印も残らず、また押せる', async () => {
    throwOnInvoke = new Error('IPC が落ちました')
    const m = mountHook(makeSpec())
    const started = m.latest.start()
    await answer(m, true)
    await started
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.ok).toBe(false)
    expect(m.outcomes[0].view.state).toBe('failed')
    expect(m.outcomes[0].view.message).toContain('IPC が落ちました')
    expect(win.busy[win.busy.length - 1][0]).toBe(false)
    expect(m.latest.tearingDown).toBe(false)
    throwOnInvoke = null
    const again = m.latest.start()
    await answer(m, true)
    await again
    expect(m.outcomes[1].view.ok).toBe(true)
    m.unmount()
  })

  it('★★ 幽霊の行（hasWork が false）: 確認ダイアログは開かず、IPC は0回。結果は「記録にありません」の案内', async () => {
    readRecordImpl = async () => ({ projectId: null, name: '' })
    const m = mountHook(makeSpec())
    await m.latest.start()
    expect((m.latest.confirmElement as any).props.open).toBe(false)
    expect(invokes).toEqual([])
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.ok).toBe(false)
    expect(m.outcomes[0].view.message).toBe(HANAMII_WORDS.nothingToDo)
    expect(win.busy).toEqual([]) // 窓を閉じる警告も立たない
    m.unmount()
  })

  it('★ 公開の記録が読めない: 確認も IPC も出ず、読めなかった旨の失敗が結果になる', async () => {
    readRecordImpl = async () => { throw new Error('.sakuraide.json が壊れています') }
    const m = mountHook(makeSpec())
    await m.latest.start()
    expect((m.latest.confirmElement as any).props.open).toBe(false)
    expect(invokes).toEqual([])
    expect(m.outcomes[0].view.message).toBe('破棄するものの記録を読めませんでした: .sakuraide.json が壊れています')
    m.unmount()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// E-5 閉じて開き直す
// ═══════════════════════════════════════════════════════════════════════════════

describe('E-5 閉じて開き直したとき: 続きと結果を、記録から出す', () => {
  it('★★ 走っている最中: 新しく付けたフックが、記録から「破棄中」と開始時刻を読み戻す（この画面で押していなくても破棄中になる）', async () => {
    const g = holdGate(); gate = g.p
    const first = mountHook(makeSpec())
    const started = first.latest.start()
    await answer(first, true)
    await until(() => runCount === 1, '破棄が走り出さない')
    first.unmount() // 画面を閉じる。破棄は main が最後まで進める。

    const reopened = mountHook(makeSpec())
    await until(() => reopened.latest.running, '記録から「走っている」を読み戻せない')
    expect(reopened.latest.tearingDown).toBe(true) // 押していなくても「破棄中」（押せない）
    expect(reopened.latest.otherRunning).toBe(false)
    expect(reopened.latest.runningRecord?.startedAt).toBeGreaterThan(0)
    expect(reopened.latest.runningRecord?.handler).toBe('hanamii:teardown')
    // 押していなくても破棄中なので、開き直した行で押しても確認も IPC も出ない（二重に始めない）
    await reopened.latest.start()
    expect((reopened.latest.confirmElement as any).props.open).toBe(false)
    expect(invokes).toHaveLength(1)
    reopened.unmount()
    g.open()
    await started
  })

  it('★★ 走っている最中の進み具合: 記録の進み具合の文が progress に出る。記録が走っていると言うときは記録の文を選ぶ', async () => {
    const g = holdGate(); gate = g.p
    runProgress = 'プロジェクトを削除しています…'
    const first = mountHook(makeSpec())
    const started = first.latest.start()
    await answer(first, true)
    await until(() => first.latest.progress === 'プロジェクトを削除しています…', '記録の進み具合が出ない')
    expect(first.latest.running).toBe(true)
    first.unmount()
    const reopened = mountHook(makeSpec())
    await until(() => reopened.latest.progress === 'プロジェクトを削除しています…', '開き直しても進み具合が出ない')
    reopened.unmount()
    g.open()
    await started
  })

  it('★★★ 閉じている間に終わった破棄: 開き直すと、記録から結果と知らせが1回だけ onOutcome に届く。見た印のあとは出ない', async () => {
    const spec = makeSpec()
    // 画面が無い状態で破棄が走って終わる（main は最後まで進める）。
    const direct = await spec.invoke(dir, AUTH, { confirmed: true }, RECORD)
    expect(direct.ok).toBe(true)
    const rec = getOps(dir).last!
    expect(rec.seen).toBe(false)

    const m = mountHook(spec)
    await tick()
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view).toEqual(resumedTeardownView('hanamii', rec.result))
    expect(m.outcomes[0].view.state).toBe('done')
    expect(m.outcomes[0].notes).toEqual([resumedTeardownNote(HANAMII_WORDS, rec)])
    expect(m.outcomes[0].notes[0].headline).toContain('破棄の結果')
    expect(m.outcomes[0].notes[0].headline).not.toContain('結果です') // T162
    expect(m.finished).toEqual([1]) // 一覧を読み直す
    expect(win.dispatched).toContain('sakura-meta-changed')
    m.unmount()

    const m2 = mountHook(spec)
    await tick()
    expect(m2.outcomes).toEqual([]) // 見た印を返したので、二度出ない
    m2.unmount()
  })

  it('★★★ 閉じている間に終わった破棄が警告つき（月額が続く）: 見た印は返らず、何度開き直しても出る', async () => {
    runResult = { ok: true, executed: [], keptBucketName: 'koto-data-x' }
    const spec = makeSpec()
    await spec.invoke(dir, AUTH, { confirmed: true }, RECORD)
    for (let i = 0; i < 3; i++) {
      const m = mountHook(spec)
      await tick()
      expect(m.outcomes, `${i + 1}回目`).toHaveLength(1)
      expect(m.outcomes[0].view.warnings.some(w => w.includes('koto-data-x'))).toBe(true)
      expect(m.outcomes[0].notes[0].warnings.some(w => w.includes('koto-data-x'))).toBe(true)
      m.unmount()
    }
    expect(win.acks).toEqual([])
  })

  it('★★ 閉じている間に2回終わった: 結果は最新の1件、知らせは全件（古い順）を渡す', async () => {
    const spec = makeSpec()
    runResult = { ok: false, executed: [], message: '1回目は断られました' }
    await spec.invoke(dir, AUTH, { confirmed: true }, RECORD)
    runResult = { ok: true, executed: ['✅ 2回目で消えました'] }
    await spec.invoke(dir, AUTH, { confirmed: true }, RECORD)
    const m = mountHook(spec)
    await tick()
    expect(m.outcomes).toHaveLength(1) // onOutcome は1回
    expect(m.outcomes[0].view.executed).toEqual(['✅ 2回目で消えました'])
    expect(m.outcomes[0].notes).toHaveLength(2)
    expect(m.outcomes[0].notes[0].startedAt).toBeLessThan(m.outcomes[0].notes[1].startedAt)
    expect(m.outcomes[0].notes[0].message).toBe('1回目は断られました')
    m.unmount()
  })

  it('★★ 別の公開先の破棄の記録は、この画面の結果として出さない（掟11）', async () => {
    const other: TeardownShellSpec<Auth, Reply> = { ...shellSpec, target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown' }
    await runTeardownShell(other, { projectDir: dir, auth: AUTH, opts: { confirmed: true } })
    const m = mountHook(makeSpec())
    await tick()
    expect(m.outcomes).toEqual([])
    expect(m.latest.running).toBe(false)
    expect(m.latest.otherRunning).toBe(false)
    expect(win.acks).toEqual([])
    m.unmount()
  })

  it('★ プロジェクトを切り替えると、記録の監視も切り替わる。前のプロジェクトの結果は出さない', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-teardown-hook-other-'))
    try {
      const spec = makeSpec()
      runResult = { ok: false, executed: [], message: 'もう一方のプロジェクトの結果' }
      await spec.invoke(otherDir, AUTH, { confirmed: true }, RECORD)
      const m = mountHook(spec)
      await tick()
      expect(m.outcomes).toEqual([]) // 別のプロジェクトの結果
      m.switchDir(otherDir)
      await tick()
      expect(m.outcomes).toHaveLength(1)
      expect(m.outcomes[0].view.message).toBe('もう一方のプロジェクトの結果')
      m.unmount()
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('★★ プロジェクトを切り替えると、「走っている」の印も切り替わる（前のプロジェクトの破棄中を、別のプロジェクトに持ち越さない）', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-teardown-hook-other-'))
    try {
      const g = holdGate(); gate = g.p
      const spec = makeSpec()
      const running = spec.invoke(dir, AUTH, { confirmed: true }, RECORD) // dir で破棄が走っている最中
      await until(() => runCount === 1, '破棄が走り出さない')
      const m = mountHook(spec)
      await until(() => m.latest.running, '記録から「走っている」を読み戻せない')
      m.switchDir(otherDir)
      // 切り替えた直後（記録の問い合わせの応答を待たずに）から、前のプロジェクトの「走っている」を持ち越さない
      expect(m.latest.running).toBe(false)
      await tick()
      expect(m.latest.running).toBe(false) // 別のプロジェクトは何も走っていない
      expect(m.latest.tearingDown).toBe(false)
      expect(m.latest.runningRecord).toBeNull()
      m.unmount()
      g.open()
      await running
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('★★ 画面を外したあとに終わった破棄は、結果として届かない・「見た」とも伝えない（監視を外している）', async () => {
    const spec = makeSpec()
    const m = mountHook(spec)
    await tick()
    m.unmount()
    await spec.invoke(dir, AUTH, { confirmed: true }, RECORD)
    await tick()
    expect(m.outcomes).toEqual([])
    expect(m.finished).toEqual([])
    expect(win.acks).toEqual([])
    expect(getOps(dir).last?.seen).toBe(false) // 開き直したときのために残っている
  })

  it('★ 一覧の読み直し（onFinished）が失敗しても、結果は出ており、start は終わる（その場の結果も、開き直しの結果も）', async () => {
    const spec = makeSpec()
    const m = mountHook(spec, { onFinished: async () => { throw new Error('一覧の読み直しに失敗') } })
    const started = m.latest.start()
    await answer(m, true)
    await started // 投げ直さない
    await tick()
    expect(m.outcomes).toHaveLength(1)
    expect(m.finished).toEqual([1])
    m.unmount()

    await spec.invoke(dir, AUTH, { confirmed: true }, RECORD)
    const reopened = mountHook(spec, { onFinished: async () => { throw new Error('一覧の読み直しに失敗') } })
    await tick() // 開き直しの結果の onFinished が失敗しても、未処理の失敗にならない
    expect(reopened.outcomes).toHaveLength(1)
    reopened.unmount()
  })

  it('★ preload が無い環境（記録の口に触れると投げる）でも、この画面が始めた破棄は動く', async () => {
    Object.defineProperty((globalThis as any).window.electronAPI, 'projectOps', { get() { throw new Error('preload 未注入') } })
    const m = mountHook(makeSpec())
    const started = m.latest.start()
    await answer(m, true)
    await started
    expect(invokes).toHaveLength(1)
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.ok).toBe(true)
    expect(m.latest.running).toBe(false)
    m.unmount()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 別の操作・進み具合の購読・時計
// ═══════════════════════════════════════════════════════════════════════════════

describe('別の操作が走っているとき・進み具合のイベント・時計', () => {
  it('★★ 同じプロジェクトで別の操作（公開）が走っているあいだは otherRunning。start() は確認も IPC も出さない。終われば押せる', async () => {
    const g = holdGate()
    const holder = withProjectLock(dir, '公開', () => g.p, { target: 'hanamii', handler: 'hanamii:publish', secrets: [] })
    const m = mountHook(makeSpec())
    await until(() => m.latest.otherRunning, '別の操作を読み戻せない')
    expect(m.latest.tearingDown).toBe(false) // 別の操作は「この破棄中」ではない
    await m.latest.start()
    expect((m.latest.confirmElement as any).props.open).toBe(false)
    expect(invokes).toEqual([])
    g.open(); await holder
    await until(() => !m.latest.otherRunning, '別の操作が終わっても otherRunning のまま')
    m.unmount()
  })

  it('★★ 別の公開先の破棄が走っているあいだも otherRunning（鍵はプロジェクト単位）', async () => {
    const g = holdGate()
    const holder = withProjectLock(dir, '削除', () => g.p, { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', secrets: [] })
    const m = mountHook(makeSpec())
    await until(() => m.latest.otherRunning, '別の公開先の操作を読み戻せない')
    expect(m.latest.running).toBe(false)
    g.open(); await holder
    m.unmount()
  })

  it('★★ 進み具合のイベント: 仕様書が持っているときだけ購読する。実行を始めると前の文を消し、外したら購読も外れる', async () => {
    const listeners = new Set<(m: string) => void>()
    const spec = makeSpec({ subscribeProgress: cb => { listeners.add(cb); return () => { listeners.delete(cb) } } })
    const ag = holdGate(); authGate = ag.p // 実行が始まった直後（記録がまだ「走っている」と言わない間）で止める
    const m = mountHook(spec)
    expect(listeners.size).toBe(1)
    for (const cb of [...listeners]) cb('前の文')
    expect(m.latest.progress).toBe('前の文') // 記録が走っていないときは、この画面が受けた最新の1行
    const started = m.latest.start()
    await answer(m, true)
    await until(() => authLoads === 1, 'キーの読み込みに進まない')
    // 実行を始めた直後は、記録がまだ「走っている」と言わない。それでもこの画面は破棄中（押せない・進み具合の枠を出す）。
    expect(m.latest.running).toBe(false)
    expect(m.latest.tearingDown).toBe(true)
    expect(m.latest.progress).toBeNull() // 実行を始めたので、前の文は消えた
    for (const cb of [...listeners]) cb('破棄を始めました')
    expect(m.latest.progress).toBe('破棄を始めました')
    ag.open()
    await started
    m.unmount()
    expect(listeners.size).toBe(0)
  })

  it('進み具合のイベントを持たない仕様書でも動く（購読しない）', async () => {
    const m = mountHook(makeSpec())
    expect(m.latest.progress).toBeNull()
    m.unmount()
  })

  it('★ 進み具合の購読そのものが投げる環境（preload が無い）でも、フックは付き、この画面が始めた破棄は動く（購読の守り）', async () => {
    const spec = makeSpec({ subscribeProgress: () => { throw new Error('preload 未注入') } })
    const m = mountHook(spec) // 購読を try/catch で囲まないと、ここで投げる
    expect(m.latest.progress).toBeNull()
    const started = m.latest.start()
    await answer(m, true)
    await started
    expect(invokes).toHaveLength(1)
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.ok).toBe(true)
    m.unmount()
  })

  it('★ 走っているあいだだけ、15秒ごとに時計を進めて記録を聞き直す。終われば（外せば）止まる', async () => {
    const g = holdGate(); gate = g.p
    const m = mountHook(makeSpec())
    expect(win.intervals).toEqual([]) // 走っていなければ張らない
    const started = m.latest.start()
    await answer(m, true)
    await until(() => win.intervals.length === 1, '時計が張られない')
    expect(win.intervals[0].ms).toBe(15000)
    const before = win.gets
    win.intervals[0].fn()
    await tick()
    expect(win.gets).toBeGreaterThan(before) // 記録を聞き直した
    g.open()
    await started
    await until(() => win.intervals[0].cleared, '終わっても時計が止まらない')
    m.unmount()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// E-6 行 TeardownRow
// ═══════════════════════════════════════════════════════════════════════════════

const ENTRY: PublishedEntry = {
  dir: '', projectName: 'proj', target: 'hanamii', label: 'HANAMII',
  url: 'https://app.example.com/', publishedAt: '2026-10-01T00:00:00.000Z', dateUnknown: false,
  hanamiiProjectId: 'p1', registryName: null,
} as PublishedEntry

/** 行（TeardownRow）を react の小さな代役の上で実際に動かす。行が一覧へ渡す部品（button・below・busy）と、行の末尾に描く確認ダイアログを読む。 */
function mountRow(spec: TargetSpec<Rec, Auth, Reply>, over: { blocked?: boolean } = {}) {
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.r = 0; rt.e = 0
  const busy: boolean[] = []
  const outcomes: Array<{ entry: PublishedEntry; outcome: TeardownFlowOutcome }> = []
  const finished: number[] = []
  const entry = { ...ENTRY, dir }
  let element: any
  let parts: any
  const render = () => {
    rt.i = 0; rt.r = 0; rt.e = 0; rt.queue = []
    element = TeardownRow({
      spec, entry, keyMissingMessage: KEY_MISSING, blocked: over.blocked ?? false,
      onBusyChange: b => { busy.push(b) },
      onOutcome: (e, o) => { outcomes.push({ entry: e, outcome: o }) },
      onFinished: () => { finished.push(outcomes.length) },
      render: p => { parts = p; return 'ROW' as any },
    })
    flushEffects()
  }
  rt.rerender = render
  render()
  return {
    get element() { return element },
    get parts() { return parts },
    /** 行の末尾に描かれた確認ダイアログ（ConfirmModal）の要素。 */
    get confirm() { return element?.props?.children?.[1] },
    entry, busy, outcomes, finished,
    unmount: unmountAll,
  }
}

describe('E-6 行 TeardownRow: 確認ダイアログ・押せる条件・実行中の印', () => {
  it('★★★ 🗑 を押すと、確認ダイアログ（ConfirmModal）が**この行の中に**描かれる（描かないと 🗑 を押しても何も起きない）', async () => {
    const m = mountRow(makeSpec())
    expect(m.confirm.props.open).toBe(false)
    m.parts.button.props.onClick()
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが行に描かれていない')
    expect(m.confirm.props.title).toBe('HANAMII の公開を破棄します')
    expect(m.confirm.props.body).toContain('対象のプロジェクト:')
    m.confirm.props.onCancel()
    await tick()
    expect(invokes).toEqual([])
    m.unmount()
  })

  it('★★ 🗑 の文字と title: 押せるときは言葉の rowButton（HANAMII 風は「🗑 破棄」）。title は仕様書の言葉（動詞）から作る', () => {
    const m = mountRow(makeSpec())
    expect(m.parts.button.props.children).toBe('🗑 破棄')
    expect(m.parts.button.props.title).toContain('破棄します')
    expect(m.parts.button.props.title).not.toContain('専有型')
    expect(m.parts.below).toBeNull() // 破棄中でなければ、進み具合の枠は出ない
    expect(m.parts.busy).toBe(false)
    m.unmount()
  })

  it('★★ 🗑 の文字は言葉の rowButton そのもの。動詞（verb）から作らない（動詞を変えたときに、押せる場所の名前まで黙って変わらない）', () => {
    // 動詞は「破棄」のまま、ボタンの名前だけ別の文字にする。動詞から作る実装（`🗑 ${verb}`）や「🗑 破棄」の直書きなら、ここで落ちる。
    const m = mountRow(makeSpec({ words: { ...HANAMII_WORDS, rowButton: '🗑 テスト用の名前' } }))
    expect(m.parts.button.props.children).toBe('🗑 テスト用の名前')
    expect(m.parts.button.props.title).toContain('破棄します') // title は動詞から（ボタンの名前とは別）
    m.unmount()
    const del = mountRow(makeSpec({ words: { ...HANAMII_WORDS, verb: '削除' } }))
    expect(del.parts.button.props.title).toContain('削除します')
    del.unmount()
  })

  it('★★ 🗑 が押せない条件: ほかの行の破棄が走っている（blocked）・この行の破棄が走っている・別の操作が走っている。それ以外は押せる', async () => {
    const free = mountRow(makeSpec())
    expect(free.parts.button.props.disabled).toBe(false)
    free.unmount()

    const blocked = mountRow(makeSpec(), { blocked: true })
    expect(blocked.parts.button.props.disabled).toBe(true)
    blocked.unmount()

    // この行の破棄が走っている
    const g = holdGate(); gate = g.p
    const m = mountRow(makeSpec())
    m.parts.button.props.onClick()
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが開かない')
    m.confirm.props.onConfirm()
    await until(() => m.parts.busy === true, '破棄が走っているのに busy が false')
    expect(m.parts.button.props.disabled, '破棄が走っているのに 🗑 が押せる').toBe(true)
    expect(m.parts.button.props.children).toBe('破棄しています…')
    expect(m.parts.below, '破棄中の進み具合の枠が出ていない').not.toBeNull()
    expect(m.busy).toContain(true) // 一覧へ「実行中」を伝えた
    g.open()
    await until(() => m.parts.busy === false, '終わっても busy のまま')
    expect(m.busy[m.busy.length - 1]).toBe(false) // 終わったら下ろす
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].entry).toBe(m.entry) // 結果には、どの行のものかが付く
    expect(m.outcomes[0].outcome.view.ok).toBe(true)
    m.unmount()
  })

  it('★★ 別の操作（公開など）が走っているあいだは、🗑 が押せない。title が理由を言う', async () => {
    const g = holdGate()
    const holder = withProjectLock(dir, '公開', () => g.p, { target: 'hanamii', handler: 'hanamii:publish', secrets: [] })
    const m = mountRow(makeSpec())
    await until(() => m.parts.button.props.disabled === true, '別の操作が走っているのに押せる')
    expect(m.parts.button.props.title).toContain('別の操作')
    expect(m.parts.below).toBeNull() // 別の操作は、この行の破棄中ではない
    g.open(); await holder
    m.unmount()
  })

  it('★★ 破棄中の枠は、進み具合の部品（TeardownProgress）に仕様書の言葉と記録の材料を渡す', async () => {
    const g = holdGate(); gate = g.p
    runProgress = '保存場所を削除しています…'
    const spec = makeSpec()
    const m = mountRow(spec)
    m.parts.button.props.onClick()
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが開かない')
    m.confirm.props.onConfirm()
    await until(() => m.parts.below?.props?.children?.[1]?.props?.running === true, '進み具合の枠に、記録が走っていることが渡らない')
    const progress = m.parts.below.props.children[1]
    expect(progress.type).toBe(TeardownProgress)
    expect(progress.props.words).toBe(spec.words)
    expect(progress.props.progress).toBe('保存場所を削除しています…')
    expect(progress.props.runningRecord?.startedAt).toBeGreaterThan(0)
    expect(m.parts.below.props.children[0].props.children).toBe('破棄しています…')
    g.open()
    await until(() => m.parts.busy === false, '終わっても busy のまま')
    m.unmount()
  })

  it('★★★ 行が一覧から消えた（アンマウント）とき、実行中の印を必ず下ろす（下ろさないと、一覧を閉じるまでほかのすべての 🗑 が押せない）', async () => {
    const g = holdGate(); gate = g.p
    const m = mountRow(makeSpec())
    m.parts.button.props.onClick()
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが開かない')
    m.confirm.props.onConfirm()
    await until(() => m.busy.includes(true), '実行中の印が上がらない')
    expect(m.busy[m.busy.length - 1]).toBe(true)
    m.unmount() // 行が消えた（別の再読み込み・「一覧から削除」）
    expect(m.busy[m.busy.length - 1], 'アンマウントで実行中の印が下りていない').toBe(false)
    g.open()
    await tick()
  })

  it('★ キーが無いとき: 行の onOutcome に、行を使う入口が渡した案内文が届く（IPC は0回）', async () => {
    authAnswer = null
    const m = mountRow(makeSpec())
    m.parts.button.props.onClick()
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが開かない')
    m.confirm.props.onConfirm()
    await until(() => m.outcomes.length === 1, '結果が届かない')
    expect(m.outcomes[0].outcome.view.message).toBe(KEY_MISSING)
    expect(invokes).toEqual([])
    m.unmount()
  })

  it('★★ 破棄を始めた直後（記録がまだ「走っている」と言わない間）は、進み具合の枠は出るが、記録が走っているとは渡さない', async () => {
    const ag = holdGate(); authGate = ag.p
    const g = holdGate(); gate = g.p
    const m = mountRow(makeSpec())
    m.parts.button.props.onClick()
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが開かない')
    m.confirm.props.onConfirm()
    await until(() => authLoads === 1, 'キーの読み込みに進まない')
    expect(m.parts.below).not.toBeNull()
    expect(m.parts.below.props.children[1].props.running).toBe(false)
    expect(m.parts.below.props.children[1].props.runningRecord).toBeNull()
    ag.open()
    await until(() => m.parts.below?.props?.children?.[1]?.props?.running === true, '記録が走ったのに渡らない')
    g.open()
    await until(() => m.parts.busy === false, '終わっても busy のまま')
    m.unmount()
  })

  it('★ 閉じている間に終わった破棄は、行の onOutcome にその行の entry つきで届き、onFinished も呼ばれる', async () => {
    const spec = makeSpec()
    await spec.invoke(dir, AUTH, { confirmed: true }, RECORD)
    const m = mountRow(spec)
    await tick()
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].entry).toBe(m.entry)
    expect(m.outcomes[0].outcome.view.state).toBe('done')
    expect(m.finished).toEqual([1])
    m.unmount()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// E-7 hanamii 以外の仕様書（専有型の公開先・専有型の言葉）で流す
// ═══════════════════════════════════════════════════════════════════════════════
//
// ここまでの仕様書は target が 'hanamii'・言葉が HANAMII のものだけ。フックが公開先（記録の監視 watchTeardownOps の target・
// 開き直しの結果の読み方 resumedTeardownView の target）や言葉（窓を閉じる警告の名前・読めなかったときの文・知らせの見出し・
// 行の「実行中」の文字）を 'hanamii' の言葉に固定しても、上の試験は落ちない。段階2・3で共用型・専有型を載せたとき、
// 専有型は remaining／inProgress の読み方が違い、読み違えると「月額が続く」一覧が、開き直した画面から消える。

const DEDICATED_WORDS: TeardownWords = {
  verb: '削除',
  confirmTitle: '専有型クラスタを削除します',
  confirmLabel: '削除する',
  activityLabel: '専有型クラスタの削除',
  rowButton: '🗑 削除',
  running: '削除しています…',
  doneHeadline: '✅ すべて削除しました',
  inProgressHeadline: '⏳ 削除中です',
  failedHeadline: '⚠️ 削除できませんでした',
  factsUnreadable: '削除するものの記録を読めませんでした',
  nothingToDo: '削除するものが記録にありません。',
  askAiTarget: 'さくらのAppRun（専有型）',
}
const DEDICATED_TARGET = 'sakura-apprun-dedicated' as const
const dedicatedShellSpec: TeardownShellSpec<Auth, Reply> = { ...shellSpec, target: DEDICATED_TARGET, handler: 'apprunDedicated:teardown' }

/** 専有型の偽の仕様書（言葉・公開先・結果の読み方が専有型。IPC の代わりに本物の骨を、専有型の組で通す）。 */
function makeDedicatedSpec(over: Partial<TargetSpec<Rec, Auth, Reply>> = {}): TargetSpec<Rec, Auth, Reply> {
  return makeSpec({
    target: DEDICATED_TARGET,
    handler: 'apprunDedicated:teardown',
    words: DEDICATED_WORDS,
    claimsComputeBillingStops: true,
    irreversibleNote: 'always',
    targets: r => [`アプリ『${r.name}』`],
    invoke: async (d, auth, opts, record) => {
      invokes.push({ dir: d, auth, opts, record })
      return runTeardownShell(dedicatedShellSpec, { projectDir: d, auth, opts })
    },
    toView: raw => toTeardownView(DEDICATED_TARGET, raw),
    ...over,
  })
}

describe('E-7 専有型の仕様書: 公開先と言葉を hanamii に固定しない（フックと行）', () => {
  it.each([
    ['消せずに残ったもの（remaining）', { ok: false, message: 'ロードバランサの削除に失敗しました', appDeleted: true, remaining: { loadBalancerID: 'l1', clusterID: 'c1' } },
      'failed', ['ロードバランサ『l1』', 'クラスタ『c1』'], []],
    ['待ち切れずに止まったもの（inProgress）', { ok: false, message: '待ち切れませんでした', inProgress: { loadBalancerID: 'l1' } },
      'inProgress', [], ['ロードバランサ『l1』']],
  ] as const)('★★★ 閉じている間に終わった専有型の破棄（%s）: 開き直すと専有型の記録から届き、残ったもの・止まったものの一覧が読める。知らせの見出しは「削除の結果」', async (_label, result, state, remainingLabels, inProgressLabels) => {
    runResult = result as Reply
    const spec = makeDedicatedSpec()
    await spec.invoke(dir, AUTH, { confirmed: true }, RECORD)
    const rec = getOps(dir).last!
    expect({ target: rec.target, handler: rec.handler }).toEqual({ target: DEDICATED_TARGET, handler: 'apprunDedicated:teardown' })

    const m = mountHook(spec)
    await tick()
    expect(m.outcomes, '専有型の記録を、この画面の結果として受け取れない（記録の監視が別の公開先を見ている）').toHaveLength(1)
    const view = m.outcomes[0].view
    expect(view).toEqual(resumedTeardownView(DEDICATED_TARGET, rec.result))
    expect(view.state).toBe(state)
    // 専有型の読み方で読んでいる（hanamii の読み方では、これらの一覧は空になる）
    expect(view.remaining.map(l => l.label)).toEqual(remainingLabels)
    expect(view.inProgress.map(l => l.label)).toEqual(inProgressLabels)
    expect(m.outcomes[0].notes).toEqual([resumedTeardownNote(DEDICATED_WORDS, rec)])
    expect(m.outcomes[0].notes[0].headline).toContain('削除の結果')
    expect(m.outcomes[0].notes[0].headline).not.toContain('結果です') // T162
    expect(m.outcomes[0].notes[0].headline).not.toContain('破棄')
    m.unmount()
  })

  it('★★ 走っている専有型の破棄: 付け直した画面が「走っている」と読む（別の操作ではない）。hanamii の仕様書で見ると「別の操作」になる', async () => {
    const g = holdGate(); gate = g.p
    const spec = makeDedicatedSpec()
    const holder = spec.invoke(dir, AUTH, { confirmed: true }, RECORD)
    const m = mountHook(spec)
    await until(() => m.latest.running, '走っている専有型の破棄を、この画面の破棄として読めない')
    expect(m.latest.otherRunning).toBe(false)
    expect(m.latest.runningRecord?.target).toBe(DEDICATED_TARGET)
    expect(m.latest.tearingDown).toBe(true)
    m.unmount()
    const hanamii = mountHook(makeSpec())
    await until(() => hanamii.latest.otherRunning, 'hanamii の画面が、専有型の破棄を別の操作と読まない')
    expect(hanamii.latest.running).toBe(false)
    hanamii.unmount()
    g.open(); await holder
  })

  it('★★ 言葉は仕様書のものが、確認ダイアログ・窓を閉じる警告に届く（HANAMII の言葉に固定しない）', async () => {
    const g = holdGate(); gate = g.p
    const m = mountHook(makeDedicatedSpec())
    const started = m.latest.start()
    for (let k = 0; k < 400 && !(m.latest.confirmElement as any).props.open; k++) await tick()
    const props = (m.latest.confirmElement as any).props
    expect(props.title).toBe('専有型クラスタを削除します')
    expect(props.confirmLabel).toBe('削除する')
    expect(props.body).toContain('次を削除します: アプリ『myapp』')
    expect(props.body).not.toContain('破棄')
    props.onConfirm()
    await until(() => win.busy.length > 0 && runCount === 1, '削除が走り出さない')
    expect(win.busy[0]).toEqual([true, '専有型クラスタの削除', true, '専有型クラスタの削除', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel])
    g.open()
    await started
    m.unmount()
  })

  it('★★ 失敗の文も仕様書の言葉: 記録を読めなかった回（factsUnreadable）・消すものが記録に無い回（nothingToDo）', async () => {
    readRecordImpl = async () => { throw new Error('.sakuraide.json が壊れています') }
    const unreadable = mountHook(makeDedicatedSpec())
    await unreadable.latest.start()
    expect(unreadable.outcomes[0].view.message).toBe('削除するものの記録を読めませんでした: .sakuraide.json が壊れています')
    unreadable.unmount()

    readRecordImpl = async () => ({ projectId: null, name: 'myapp' })
    const ghost = mountHook(makeDedicatedSpec())
    await ghost.latest.start()
    expect(ghost.outcomes[0].view.message).toBe(DEDICATED_WORDS.nothingToDo)
    expect(invokes).toEqual([])
    ghost.unmount()
  })

  it('★★ 行: ボタンの名前・実行中の文字・枠の見出し・進み具合の部品へ渡す言葉は仕様書のもの（専有型は「🗑 削除」。V1）', async () => {
    const g = holdGate(); gate = g.p
    const spec = makeDedicatedSpec()
    const m = mountRow(spec)
    expect(m.parts.button.props.children).toBe('🗑 削除') // V1: 専有型の行のボタンは言葉の rowButton（手本どおり「削除」。HANAMII・共用型は「🗑 破棄」）
    expect(m.parts.button.props.title).toBe('公開を止めて、作られたものをすべて削除します')
    m.parts.button.props.onClick()
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが開かない')
    expect(m.confirm.props.title).toBe('専有型クラスタを削除します')
    m.confirm.props.onConfirm()
    await until(() => m.parts.busy === true, '削除が走っているのに busy が false')
    expect(m.parts.button.props.children).toBe('削除しています…')
    expect(m.parts.below.props.children[0].props.children).toBe('削除しています…')
    expect(m.parts.below.props.children[1].props.words).toBe(spec.words)
    g.open()
    await until(() => m.parts.busy === false, '終わっても busy のまま')
    expect(m.outcomes).toHaveLength(1)
    m.unmount()
  })
})
