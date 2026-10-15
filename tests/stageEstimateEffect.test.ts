import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// ── 目安の部品（StageEstimate）の「効果」を実際に走らせて確かめる（2026-10-07 検分の指摘4）─────────────────────
// renderToStaticMarkup は useEffect を走らせないので、表の関数（estimateLineFor）しか見られなかった。
// 次の2つの変異は、それまでの全テストを素通りしていた:
//   (M9) useEffect の依存 `[stage]` を `[]` にする → 作業の始まりでは stage がまだ無い（RunningLines は stage 未定で現れ、
//        あとから段が付く）ので、目安が**一度も読み込まれない**
//   (M8) projectOps の reportStage から notify を消す → 段だけの切り替わり（作成の ASG・LB）が画面へ届かない
// DOM 環境（jsdom 等）は入れていないので、react の useState／useEffect だけを**この試験用の小さな実装**に差し替えて、
// 部品の関数をそのまま呼ぶ（依存配列が同じなら効果は再実行しない・変わったら後始末してからやり直す、という React の決まりを写している）。
// 描いた結果は本物の react-dom/server で HTML にする（部品の見た目は本物のまま）。

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) } | undefined>,
  queue: [] as Array<{ idx: number; fn: () => void | (() => void); deps?: readonly unknown[] }>,
  i: 0, e: 0,
  rerender: () => {},
}))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const idx = rt.i++
      if (!(idx in rt.slots)) rt.slots[idx] = init
      const set = (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[idx]) : v
        if (Object.is(next, rt.slots[idx])) return
        rt.slots[idx] = next
        rt.rerender()
      }
      return [rt.slots[idx], set]
    },
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const idx = rt.e++
      const prev = rt.effects[idx]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]))
      if (changed) rt.queue.push({ idx, fn, deps })
    },
  }
})

import StageEstimate from '../src/renderer/components/StageEstimate'

type Props = { stage?: string | null }
let lastProps: Props = {}
let html = ''

function flushEffects() {
  const todo = rt.queue; rt.queue = []
  for (const q of todo) {
    const prev = rt.effects[q.idx]
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    rt.effects[q.idx] = { deps: q.deps, cleanup: q.fn() }
  }
}
function render(props: Props) {
  lastProps = props
  rt.i = 0; rt.e = 0; rt.queue = []
  const el = (StageEstimate as unknown as (p: Props) => any)(props)
  html = el ? renderToStaticMarkup(el) : ''
  flushEffects()
}
/** 非同期の読み込み（Promise）が済むのを待つ。 */
const settle = async () => { for (let k = 0; k < 5; k++) await Promise.resolve() }
function unmount() { for (const e of rt.effects) if (e && typeof e.cleanup === 'function') e.cleanup(); rt.effects = [] }

const DEV_LB = { 'teardown.lb': { kind: 'dev', ms: 9 * 60_000, note: null, date: '2026-09-10' } }
let estimates: ReturnType<typeof vi.fn>

beforeEach(() => {
  rt.slots = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.e = 0
  rt.rerender = () => render(lastProps) // 状態が変わったら、いまの props で描き直す
  html = ''
  estimates = vi.fn(async () => DEV_LB)
  ;(globalThis as any).window = { electronAPI: { stageTiming: { estimates } } }
})
afterEach(() => { unmount(); delete (globalThis as any).window })

describe('StageEstimate: 段が付いたら目安を読んで出す（効果の依存は [stage]）', () => {
  it('★★ (M9) 最初は段が無く、あとから段が付く（RunningLines のふだんの形）: 付いた時点で読み込み、目安の一文が出る', async () => {
    render({ stage: undefined })
    await settle()
    expect(estimates).not.toHaveBeenCalled() // 段が無いうちは読まない
    expect(html).toBe('')
    render({ stage: 'teardown.lb' }) // 段が付いた
    await settle()
    expect(estimates).toHaveBeenCalledTimes(1)
    expect(html).toContain('目安 約9分（開発時の実測・2026-09-10）')
    expect(html).toContain('data-stage-estimate')
  })

  it('最初から段がある場合も、1回だけ読んで出す。同じ段のままの再描画では読み直さない', async () => {
    render({ stage: 'teardown.lb' })
    await settle()
    expect(html).toContain('目安 約9分（開発時の実測・2026-09-10）')
    render({ stage: 'teardown.lb' }); render({ stage: 'teardown.lb' })
    await settle()
    expect(estimates).toHaveBeenCalledTimes(1)
  })

  it('★ 段が変わるたびに読み直す（直前の操作で記録が増えて、目安が変わっていることがある）。目安の無い段には何も出さない', async () => {
    render({ stage: 'teardown.lb' })
    await settle()
    expect(html).toContain('約9分')
    render({ stage: 'teardown.cluster' }) // この段に目安は無い（一覧に無い）
    await settle()
    expect(estimates).toHaveBeenCalledTimes(2)
    expect(html).toBe('')
  })

  it('★ 古い読み込みの答えは捨てる（段が変わったあとに、前の段の読み込みが遅れて返っても、画面を上書きしない）', async () => {
    let resolveFirst!: (v: unknown) => void
    estimates
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r }))
      .mockImplementationOnce(async () => ({ 'teardown.asg': { kind: 'dev', ms: null, note: '数分', date: '2026-09-10' } }))
    render({ stage: 'teardown.lb' }) // 1回目の答えはまだ来ない
    render({ stage: 'teardown.asg' }) // 段が変わった（1回目の効果は後始末される）
    await settle()
    expect(html).toContain('目安 数分（開発時の実測・2026-09-10）')
    resolveFirst({ 'teardown.asg': { kind: 'dev', ms: 60_000, note: null, date: '1999-01-01' } }) // 遅れて来た古い答え
    await settle()
    expect(html).not.toContain('1999-01-01')
    expect(html).toContain('目安 数分（開発時の実測・2026-09-10）')
  })

  it('読めなかった（失敗・preload が無い・形が違う）ときは、何も出さず落ちない', async () => {
    estimates.mockImplementationOnce(async () => { throw new Error('boom') })
    render({ stage: 'teardown.lb' })
    await settle()
    expect(html).toBe('')
    delete (globalThis as any).window // preload が無い環境
    rt.slots = []; rt.effects = []
    expect(() => render({ stage: 'teardown.lb' })).not.toThrow()
    expect(html).toBe('')
  })

  it('この Mac の記録があれば、その一文（出典つき）を出す', async () => {
    estimates.mockImplementation(async () => ({ 'teardown.lb': { kind: 'local', ms: 8 * 60_000, count: 3 } }))
    render({ stage: 'teardown.lb' })
    await settle()
    expect(html).toContain('目安 約8分（この Mac での最近3回の中央値）')
  })
})
