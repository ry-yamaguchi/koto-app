import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── なぜこのテストが要るか（2026-09-25 検分の指摘20）──────────────────────────
// ③公開モーダルの中には「保存場所を用意する」（StorageNotice）と HANAMII のパネルが
// **同じ画面に並んでいる**。用意を押すと `sakura:storage-prepared` が出るが、
// HanamiiPanel だけがそれを聞いていなかった（AppRunPanel・AppRunDedicatedPanel・VercelPanel は聞く）。
// パネルを作り直す仕掛け（key や再マウント）も無いので、`placement` は null のまま。
//
// 実害は表示だけではない。公開の引数が
//   `withStorage: withStorage && !!placement`
// なので **withStorage: false** で公開され、**月額495円を払って用意した保存場所を渡さずに公開する**。
// データはコンテナの中に落ちて、再起動で消える（指摘15＝VercelPanel とまったく同じ形で、
// こちらのほうが被害が大きい）。
//
// **ソースの文字列は読まない**（掟10）。偽の react で**関数を実際に動かし**、
// 出来事を投げて「もう一度 storage.placement を取り直すか」「片づけで購読が外れるか」を見る。

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

/** 保存場所を読み直した回数（**これが検査の対象**）。 */
let placementCalls: string[] = []

/** 何を触られても落ちない偽の electronAPI（ここで見たいのは storage.placement だけ）。 */
function fakeElectronApi(): any {
  const anything: any = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: () => Promise.resolve({}),
  })
  return new Proxy({
    fs: { readFile: async () => '{}', writeFile: async () => {} },
    storage: {
      placement: async (projectDir: string) => {
        placementCalls.push(projectDir)
        return { ok: true, placement: null, placements: [] }
      },
      scan: async () => ({ usedBy: [] }),
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
win.setInterval = () => 0
win.clearInterval = () => {}
;(globalThis as any).window = win
;(globalThis as any).localStorage = win.localStorage

// 動かす場所が画面ではないので、拾われなかった Promise は無視する
// （見たいのは storage.placement が呼ばれるかどうかだけ）。
const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

import HanamiiPanel from '../src/renderer/components/HanamiiPanel'

/**
 * HanamiiPanel を1回だけ「描いて」、**保存場所を読む useEffect** を動かす。
 *
 * どの useEffect かは**依存の中身**で選ぶ（関数＝読み直しの処理を依存に持つもの）。
 * ソースの文字列ではなく、渡っているものを見る。
 */
function renderAndRunStorageEffect(projectDir: string): Array<() => void> {
  hooks.states = []; hooks.effects = []; hooks.index = 0
  ;(HanamiiPanel as unknown as (p: unknown) => unknown)({ apiKey: 'k', projectDir, onOpenCredentials: () => {} })
  const chosen = hooks.effects.filter(e => (e.deps ?? []).some(d => typeof d === 'function'))
  expect(chosen.length, '保存場所を読む useEffect が見つからない').toBe(1)
  const cleanups = chosen.map(e => e.fn()).filter((c): c is () => void => typeof c === 'function')
  mounted.push(...cleanups)
  return cleanups
}

/** まだ片づけていない購読（**テストどうしが混ざらないよう**、毎回必ず外す）。 */
let mounted: Array<() => void> = []

beforeEach(() => { placementCalls = [] })
afterEach(() => { for (const c of mounted) c(); mounted = [] })

describe('HanamiiPanel: 保存場所を用意したら、読み直す', () => {
  it('★ 開いた時点で1回読む', () => {
    renderAndRunStorageEffect('/tmp/proj-a')
    expect(placementCalls).toEqual(['/tmp/proj-a'])
  })

  it('★★ 保存場所を用意した出来事を受けて、もう一度読む（払った保存場所を渡さずに公開しない）', () => {
    renderAndRunStorageEffect('/tmp/proj-b')
    expect(placementCalls).toHaveLength(1)
    window.dispatchEvent(new Event('sakura:storage-prepared'))
    expect(placementCalls, '用意した直後に読み直していない（withStorage が false のまま公開される）')
      .toEqual(['/tmp/proj-b', '/tmp/proj-b'])
  })

  it('★ 片づけ（アンマウント）で購読を外す（閉じたあとに走らない）', () => {
    const cleanups = renderAndRunStorageEffect('/tmp/proj-c')
    expect(cleanups.length, '後片づけを返していない').toBe(1)
    for (const c of cleanups) c()
    mounted = []
    window.dispatchEvent(new Event('sakura:storage-prepared'))
    expect(placementCalls).toEqual(['/tmp/proj-c'])
  })

  it('★ ほかの出来事では走らない（何にでも反応しない）', () => {
    renderAndRunStorageEffect('/tmp/proj-d')
    window.dispatchEvent(new Event('sakura:credentials-changed'))
    expect(placementCalls).toHaveLength(1)
  })
})
