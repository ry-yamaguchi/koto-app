import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 段階2（2b-1）: フック useTeardownFlow が、選択つきの確認（useConfirmChoices）を流れへ渡す ─────────────────────
// 設計書 docs/teardown-unify-plan.md の 10.7.7 (2)。振る舞いで固定する（ソースの文字列は読まない）。
//   ・選択（choices）を持つ仕様書: 確認に選択が出る（既定値つき）→ 動かした値が invoke の opts.choices に届く／キャンセルなら IPC 0
//   ・選択を持たない仕様書（HANAMII）: 今までの確認。choices は空・opts は { confirmed:true } だけ
//   ・nothingToDoIsOk の仕様書: 確認も IPC も出ず、結果欄に渡す outcome に nothingToDo:true が付く（付けない仕様書の outcome は今のまま）
// React は DOM 環境を入れていないので、useState／useRef／useCallback／useEffect だけをこの試験用の小さな実装に差し替えてフックをそのまま呼ぶ
// （tests/teardownHookCommon.test.ts と同じやり方）。確認の ConfirmModal は要素の props を直接押す。

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

import { useTeardownFlow, type TeardownFlowOutcome } from '../src/renderer/teardown/useTeardownFlow'
import { toTeardownView } from '../src/shared/teardownResult'
import type { TargetSpec, TeardownWords } from '../src/renderer/teardown/types'
import type { ConfirmChoice } from '../src/renderer/useConfirmChoices'

type Rec = { projectId: string | null; registry: string | null }
type Auth = { token: string }
type Reply = { ok: boolean; message?: string }

const WORDS: TeardownWords = {
  verb: '破棄', confirmTitle: 'テストの公開を破棄します', confirmLabel: '破棄する', activityLabel: 'テストの破棄', rowButton: '🗑 破棄', running: '破棄しています…',
  doneHeadline: '✅ 破棄しました', inProgressHeadline: '⏳ 破棄の途中です', failedHeadline: '⚠️ 破棄できませんでした',
  factsUnreadable: '破棄するものの記録を読めませんでした', nothingToDo: '破棄するものはありません（テスト）。', askAiTarget: 'テスト',
}
const REG: ConfirmChoice = { id: 'deleteRegistry', label: 'レジストリも削除する', defaultChecked: true }
const tick = async () => { for (let k = 0; k < 6; k++) await new Promise<void>(r => setTimeout(r, 0)) }

let invokes: Array<{ opts: unknown; record: Rec }>
let record: Rec

function makeSpec(over: Partial<TargetSpec<Rec, Auth, Reply>> = {}): TargetSpec<Rec, Auth, Reply> {
  return {
    target: 'hanamii', handler: 'test:teardown', words: WORDS, claimsComputeBillingStops: false, irreversibleNote: 'always',
    readRecord: async () => record,
    hasWork: r => !!r.projectId,
    targets: r => [`アプリ『${r.projectId}』`],
    loadAuth: async () => ({ token: 'tok' }),
    invoke: async (_d, _a, opts, r) => { invokes.push({ opts, record: r }); return { ok: true } },
    failure: message => ({ ok: false, message }),
    toView: raw => toTeardownView('hanamii', raw),
    ...over,
  }
}

beforeEach(() => {
  invokes = []
  record = { projectId: 'p1', registry: 'myreg' }
  ;(globalThis as any).window = {
    electronAPI: {
      storage: { placement: async () => ({ ok: true, placement: null, placements: [] }) },
      fs: { readFile: async () => JSON.stringify({ publish: { targets: {} } }), exists: async (p: string) => String(p).endsWith('/.sakuraide.json') },
      stageTiming: { estimates: async () => null },
      win: { setBusy: () => {} },
      projectOps: {
        get: async () => ({ running: null, last: null, earlier: [] }),
        ack: async () => ({ ok: true, acked: 0 }),
        onChanged: () => () => {},
      },
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

function flushEffects() {
  const todo = rt.queue; rt.queue = []
  for (const q of todo) {
    const prev = rt.effects[q.idx]
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    const slot: { deps?: readonly unknown[]; cleanup?: void | (() => void) } = { deps: q.deps }
    rt.effects[q.idx] = slot
    slot.cleanup = q.fn()
  }
}

function mountHook(spec: TargetSpec<Rec, Auth, Reply>) {
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.r = 0; rt.e = 0
  const outcomes: TeardownFlowOutcome[] = []
  let latest!: ReturnType<typeof useTeardownFlow<Rec, Auth, Reply>>
  const render = () => {
    rt.i = 0; rt.r = 0; rt.e = 0; rt.queue = []
    latest = useTeardownFlow('/work/myapp', spec, { keyMissingMessage: 'キーが未登録です', onOutcome: o => { outcomes.push(o) } })
    flushEffects()
  }
  rt.rerender = render
  render()
  return { get latest() { return latest }, get props() { return (latest.confirmElement as any).props }, outcomes }
}
type Mounted = ReturnType<typeof mountHook>

async function waitOpen(m: Mounted) {
  for (let k = 0; k < 400 && !m.props.open; k++) await tick()
  expect(m.props.open, '確認ダイアログ（ConfirmModal）が開かない').toBe(true)
}

describe('E フック: 選択（choices）を持つ仕様書の確認', () => {
  it('★★★ 確認に選択が出る（仕様書の選択・既定値つき）。触らずに実行すれば既定の値が invoke の opts.choices に届く', async () => {
    const m = mountHook(makeSpec({ choices: () => [REG] }))
    const started = m.latest.start()
    await waitOpen(m)
    expect(m.props.danger).toBe(true)
    expect(m.props.choices).toEqual([REG])
    expect(m.props.choiceValues).toEqual({ deleteRegistry: true })
    m.props.onConfirm()
    await started
    expect(invokes).toHaveLength(1)
    expect(invokes[0].opts).toEqual({ confirmed: true, shownPlacements: [], choices: { deleteRegistry: true } })
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.ok).toBe(true)
  })

  it('★★★ チェックを外して実行 → opts.choices.deleteRegistry は false。確認の画面の値も追従する', async () => {
    const m = mountHook(makeSpec({ choices: () => [REG] }))
    const started = m.latest.start()
    await waitOpen(m)
    m.props.onToggleChoice('deleteRegistry', false)
    expect(m.props.choiceValues).toEqual({ deleteRegistry: false })
    m.props.onConfirm()
    await started
    expect(invokes[0].opts).toEqual({ confirmed: true, shownPlacements: [], choices: { deleteRegistry: false } })
  })

  it('★★★ チェックを動かしてもキャンセル → IPC は0回・結果も出ない', async () => {
    const m = mountHook(makeSpec({ choices: () => [REG] }))
    const started = m.latest.start()
    await waitOpen(m)
    m.props.onToggleChoice('deleteRegistry', false)
    m.props.onCancel()
    await started
    expect(invokes).toEqual([])
    expect(m.outcomes).toEqual([])
    expect(m.props.open).toBe(false)
  })

  it('★★ 選択は記録（押した時点）から作る。借り物は既定オフの選択が出る', async () => {
    record = { projectId: 'p1', registry: 'adopted-reg' }
    const m = mountHook(makeSpec({ choices: r => [{ ...REG, defaultChecked: r.registry !== 'adopted-reg' }] }))
    const started = m.latest.start()
    await waitOpen(m)
    expect(m.props.choiceValues).toEqual({ deleteRegistry: false })
    m.props.onConfirm()
    await started
    expect(invokes[0].opts).toEqual({ confirmed: true, shownPlacements: [], choices: { deleteRegistry: false } })
  })
})

describe('E フック: 選択を持たない仕様書（HANAMII）の確認は今のまま', () => {
  it('★★★ choices は空・opts は { confirmed:true } だけ（choices の鍵が付かない）', async () => {
    const m = mountHook(makeSpec())
    const started = m.latest.start()
    await waitOpen(m)
    expect(m.props.choices).toEqual([])
    m.props.onConfirm()
    await started
    expect(invokes).toHaveLength(1)
    expect(Object.keys(invokes[0].opts as object)).toEqual(['confirmed', 'shownPlacements']) // choices の鍵は付かない（確認で見せた保存場所の組は、選択の有る無しによらず付く）
  })

  it('★★ 選択が空の配列を返す仕様書も同じ（今までの確認）', async () => {
    const m = mountHook(makeSpec({ choices: () => [] }))
    const started = m.latest.start()
    await waitOpen(m)
    m.props.onConfirm()
    await started
    expect(invokes[0].opts).toEqual({ confirmed: true, shownPlacements: [] })
  })
})

describe('E フック: 消すものが記録に無い回（nothingToDoIsOk）', () => {
  it('★★★ nothingToDoIsOk の仕様書: 確認は開かず IPC も呼ばない。outcome に nothingToDo:true が付き、view は仕様書の「破棄するものはありません」', async () => {
    record = { projectId: null, registry: null }
    const m = mountHook(makeSpec({ nothingToDoIsOk: true }))
    await m.latest.start()
    expect(m.props.open).toBe(false)
    expect(invokes).toEqual([])
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].nothingToDo).toBe(true)
    expect(m.outcomes[0].view.message).toBe(WORDS.nothingToDo)
    expect(m.outcomes[0].notes).toEqual([])
  })

  it('★★★ 印の無い仕様書: outcome は今のまま { view, notes } だけ（nothingToDo の鍵が付かない）', async () => {
    record = { projectId: null, registry: null }
    const m = mountHook(makeSpec())
    await m.latest.start()
    expect(invokes).toEqual([])
    expect(m.outcomes).toHaveLength(1)
    expect(Object.keys(m.outcomes[0]).sort()).toEqual(['notes', 'view'])
  })

  it('消すものがある回の outcome に nothingToDo は付かない（nothingToDoIsOk の仕様書でも）', async () => {
    const m = mountHook(makeSpec({ nothingToDoIsOk: true }))
    const started = m.latest.start()
    await waitOpen(m)
    m.props.onConfirm()
    await started
    expect('nothingToDo' in m.outcomes[0]).toBe(false)
  })
})
