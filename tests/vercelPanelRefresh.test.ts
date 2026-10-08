import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── なぜこのテストが要るか（2026-09-24 検分）──────────────────────────────
// Vercel の公開前チェックは「保存場所をまだ用意していないため、いまのままでは
// データは残りません。上の『保存場所を用意する』から用意してください。」と、
// **同じ画面のボタンを名指し**する。ところが言われたとおり用意しても
// （月額495円が始まっても）、この枠は開いた時点の判断を出し続けていた。
//   ・利用者から見ると「払ったのに直っていない」
//   ・しかもその行の「AIに相談する」は、**既に用意済みなのに**
//     「保存場所をまだ用意していない」という嘘を AI へ送り、直っているものを直させる
// 隣の2枚（AppRunPanel・AppRunDedicatedPanel）は同じ出来事（`sakura:storage-prepared`）を
// 受けて取り直している。
//
// **ソースの文字列は読まない**（掟10）。偽の react で**関数を実際に動かし**、
// 出来事を投げて「もう一度 preflight が呼ばれるか」「片づけで購読が外れるか」を見る。

/** 偽の react（hooks を手で回す）。画面は作らない（jsx は null を返す）。 */
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  effects: [] as { fn: () => void | (() => void); deps: unknown[] | undefined }[],
  index: 0,
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
vi.mock('react/jsx-runtime', () => ({ jsx: () => null, jsxs: () => null, Fragment: () => null }))

/** 呼ばれた preflight の回数（**これが検査の対象**）。 */
let preflightCalls: string[] = []

/** 何を触られても落ちない偽の electronAPI（ここで見たいのは preflight だけ）。 */
function fakeElectronApi(): any {
  const anything: any = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: () => Promise.resolve({}),
  })
  return new Proxy({
    fs: { readFile: async () => '{}', writeFile: async () => {} },
    vercel: {
      preflight: async (projectDir: string) => {
        preflightCalls.push(projectDir)
        return { ok: true, canPublish: true, summary: '', checks: [] }
      },
      onProgress: () => () => {},
    },
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

// 動かす場所が画面ではないので、拾われなかった Promise は無視する
// （見たいのは preflight が呼ばれるかどうかだけ）。
const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

import VercelPanel from '../src/renderer/components/VercelPanel'

/**
 * VercelPanel を1回だけ「描いて」、**公開前チェックの useEffect** を動かす。
 *
 * どの useEffect かは**依存の中身**で選ぶ（関数＝`runPreflight` を依存に持つもの）。
 * ソースの文字列ではなく、渡っているものを見る。
 */
function renderAndRunPreflightEffect(projectDir: string): Array<() => void> {
  hooks.states = []; hooks.effects = []; hooks.index = 0
  ;(VercelPanel as unknown as (p: unknown) => unknown)({ apiKey: 'k', projectDir, onOpenCredentials: () => {} })
  const chosen = hooks.effects.filter(e => (e.deps ?? []).some(d => typeof d === 'function'))
  expect(chosen.length, '公開前チェックの useEffect が見つからない').toBe(1)
  const cleanups = chosen.map(e => e.fn()).filter((c): c is () => void => typeof c === 'function')
  mounted.push(...cleanups)
  return cleanups
}

/** まだ片づけていない購読（**テストどうしが混ざらないよう**、毎回必ず外す）。 */
let mounted: Array<() => void> = []

beforeEach(() => { preflightCalls = [] })
afterEach(() => { for (const c of mounted) c(); mounted = [] })

describe('VercelPanel: 保存場所を用意したら、公開前チェックを取り直す', () => {
  it('★ 押さなくても、開いた時点で1回走る', () => {
    renderAndRunPreflightEffect('/tmp/proj-a')
    expect(preflightCalls).toEqual(['/tmp/proj-a'])
  })

  it('★ 保存場所を用意した出来事を受けて、もう一度走る（「↻ 更新」を押させない）', () => {
    renderAndRunPreflightEffect('/tmp/proj-b')
    expect(preflightCalls).toHaveLength(1)
    window.dispatchEvent(new Event('sakura:storage-prepared'))
    expect(preflightCalls, '用意した直後に取り直していない').toEqual(['/tmp/proj-b', '/tmp/proj-b'])
  })

  it('★ 片づけ（アンマウント）で購読を外す（閉じたあとに走らない）', () => {
    const cleanups = renderAndRunPreflightEffect('/tmp/proj-c')
    expect(cleanups.length, '後片づけを返していない').toBe(1)
    for (const c of cleanups) c()
    mounted = []
    window.dispatchEvent(new Event('sakura:storage-prepared'))
    expect(preflightCalls).toEqual(['/tmp/proj-c'])
  })

  it('★ ほかの出来事では走らない（何にでも反応しない）', () => {
    renderAndRunPreflightEffect('/tmp/proj-d')
    window.dispatchEvent(new Event('sakura:credentials-changed'))
    expect(preflightCalls).toHaveLength(1)
  })
})
