import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 行・節が使うフック（useTeardownFlow）は、流れが付けた keptNothing（何も消さないと分かっていた回）を、結果の onOutcome へそのまま渡す ───────────────
// 流れ（runTeardownFlow）は偽にして、返す結果だけを決める。フックは本物。React は DOM 環境を入れていないので、useState／useRef／useCallback／useEffect だけを
// 小さな実装に差し替える（tests/teardownHookCommon.test.ts と同じやり方）。
//   ・keptNothing の回 → onOutcome は { view, notes: [], keptNothing: true }（一覧が行の消し方の一言を添える元）
//   ・nothingToDo の回・ふつうの回 → 今までの形のまま（keptNothing のキーを付けない）
// 変異: フックが keptNothing を落とす／常に付ける。

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) } | undefined>,
  queue: [] as Array<{ idx: number; fn: () => void | (() => void); deps?: readonly unknown[] }>,
  i: 0, r: 0, e: 0,
  rerender: () => {},
}))
const flow = vi.hoisted(() => ({ next: null as unknown }))

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
// 流れは偽。結果だけを決める（確認も IPC も出さない）。
vi.mock('../src/renderer/teardown/flow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/teardown/flow')>()),
  electronFlowDeps: () => ({}),
  runTeardownFlow: async () => flow.next,
}))

import { useTeardownFlow, type TeardownFlowOutcome } from '../src/renderer/teardown/useTeardownFlow'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'

const REPLY = { ok: true, executed: ['x'], keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptOnly: true as const }

beforeEach(() => {
  ;(globalThis as any).window = {
    electronAPI: {
      projectOps: {
        get: async () => ({ running: null, last: null, earlier: [] }),
        ack: async () => ({ ok: true, acked: [] }),
        onChanged: () => () => {},
      },
      win: { setBusy: () => {} },
    },
    dispatchEvent: () => true,
    setInterval: () => 1,
    clearInterval: () => {},
  }
})
afterEach(() => {
  delete (globalThis as any).window
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.rerender = () => {}
})

function mountHook() {
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.r = 0; rt.e = 0
  const outcomes: TeardownFlowOutcome[] = []
  let latest!: ReturnType<typeof useTeardownFlow>
  const render = () => {
    rt.i = 0; rt.r = 0; rt.e = 0; rt.queue = []
    latest = useTeardownFlow('/tmp/koto-keptnothing-hook', sharedTeardownSpec, {
      keyMissingMessage: 'キーなし',
      onOutcome: o => { outcomes.push(o) },
    })
    for (const q of rt.queue.splice(0)) {
      // 効果の中で setState して描き直しが走っても、この効果を「もう付いている」と見られるよう、先に印を置く
      const slot: { deps?: readonly unknown[]; cleanup?: void | (() => void) } = { deps: q.deps }
      rt.effects[q.idx] = slot
      slot.cleanup = q.fn()
    }
  }
  rt.rerender = render
  render()
  return { outcomes, press: () => latest.start() }
}

describe('★★★ フック useTeardownFlow: keptNothing を onOutcome へそのまま渡す', () => {
  it('★★★ keptNothing の回: onOutcome は { view, notes: [], keptNothing: true }。view は仕様書の toView が読んだもの（keptOnly の印つき）', async () => {
    flow.next = { cancelled: false, result: REPLY, keptNothing: true }
    const m = mountHook()
    await m.press()
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0]).toStrictEqual({ view: sharedTeardownSpec.toView(REPLY), notes: [], keptNothing: true })
    expect(m.outcomes[0].view).toMatchObject({ ok: true, state: 'done', keptOnly: true })
  })

  it('★★ ふつうの回（keptNothing が無い）: 今までの形（keptNothing のキーを付けない）', async () => {
    flow.next = { cancelled: false, result: REPLY }
    const m = mountHook()
    await m.press()
    expect(m.outcomes).toHaveLength(1)
    expect(Object.keys(m.outcomes[0]).sort()).toEqual(['notes', 'view'])
  })

  it('★★ nothingToDo の回: 今までの形（nothingToDo だけ。keptNothing は付けない）', async () => {
    flow.next = { cancelled: false, result: { ok: false, message: sharedTeardownSpec.words.nothingToDo }, nothingToDo: true }
    const m = mountHook()
    await m.press()
    expect(Object.keys(m.outcomes[0]).sort()).toEqual(['notes', 'nothingToDo', 'view'])
  })

  it('★★ やめた回: 結果は出ない', async () => {
    flow.next = { cancelled: true }
    const m = mountHook()
    await m.press()
    expect(m.outcomes).toEqual([])
  })
})
