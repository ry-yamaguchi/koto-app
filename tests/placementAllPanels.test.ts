import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── なぜこのテストが要るか（2026-09-25 検分の指摘23・37）────────────────────
//
// 破棄は `teardownStorageForProject` を通って、**同意済みの保存場所を全件**片づける。
// `storage:placement` も全件（`placements`）を返すようになった。ところが**画面が
// 先頭1件（`r.placement`）しか読んでいなかった**ので、⑥「すべて削除する」の確認には
// 『A』しか出ないのに、名前が一度も出なかった『B』とその中のデータまで消えていた。
// **元に戻せない削除を、名指ししないまま実行させない**（掟10「お金・破壊の歯止め」）。
//
// main 側（全件を返すか）は tests/storagePlacementAll.test.ts が固定している。
// ここで固定するのは**画面の側**——「返ってきた全件を、画面が落とさずに持つか」。
// **ソースの文字列は読まない**（掟10）。偽の react で**関数を実際に動かし**、
// 偽の electronAPI が2件返したときに、画面が2件とも抱えるかを見る。
//
// 見ている画面（破棄の確認に保存場所を出すもの）:
//   - AppRunPanel・AppRunDedicatedPanel・HanamiiPanel … 開いたとき（useEffect）に読む
//   - PublishedListModal（📡 公開したもの一覧）… **🗑 破棄を押したとき**（askConfirm）に読む。
//     effect を回すだけでは読まないので、一度描き直して🗑のボタンを探し、実際に押す。
// tests/teardownSupport.test.ts はソースの文字列で見張っている。ここは**振る舞い**で見張る。

/** 偽の react（hooks を手で回す）。画面は作らない（jsx は null を返す）。 */
const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  effects: [] as { fn: () => void | (() => void); deps: unknown[] | undefined }[],
  index: 0,
  /** 描いた要素（type と props）。クリック契機で読む画面のボタンを探して押すのに使う。 */
  rendered: [] as { type: unknown; props: any }[],
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
vi.mock('react/jsx-runtime', () => {
  // 画面は作らない（null を返す）。ただし**何を描いたか**は残す（ボタンの onClick を押すため）。
  const jsx = (type: unknown, props: any) => { hooks.rendered.push({ type, props }); return null }
  return { jsx, jsxs: jsx, Fragment: () => null }
})
// vitest の変換は開発用の jsxDEV（react/jsx-dev-runtime）で書き出す。jsx-runtime だけを偽物にしても
// 何も記録されなかった（2026-09-25 確認）ので、こちらにも同じ偽物を当てる。
vi.mock('react/jsx-dev-runtime', () => {
  const jsxDEV = (type: unknown, props: any) => { hooks.rendered.push({ type, props }); return null }
  return { jsxDEV, Fragment: () => null }
})

const CONSENTED = '2026-09-24T00:00:00.000Z'
const A = { bucket: 'koto-data-aaa', prefix: 'projects/myapp/', shared: true, consentedAt: CONSENTED }
const B = { bucket: 'koto-data-bbb', prefix: 'projects/myapp/', shared: true, consentedAt: CONSENTED }

/** `storage.placement` が返す中身（テストごとに差し替える）。 */
let reply: any = { ok: true, placement: A, placements: [A, B] }
/** 画面が `placements`（全件）を読んだか。**読まなければ、消えるものを数え上げられない。** */
let readPlacements = false
/** 📡 公開したもの一覧が読む公開の記録（`fs.publishedRecords` の中身）。 */
let records: any = { ok: true, projects: [] }

/** 何を触られても落ちない偽の electronAPI（ここで見たいのは storage.placement だけ）。 */
function fakeElectronApi(): any {
  const anything: any = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: () => Promise.resolve({}),
  })
  return new Proxy({
    // publishedRecords だけ中身を返す。ほかの fs（readFile など）は何を呼ばれても落ちない。
    fs: new Proxy({ publishedRecords: async () => records } as any, {
      get: (t, key) => (key in t ? t[key] : anything),
    }),
    // placement だけ中身を返す。ほかの storage（HANAMII が一緒に読む scan など）は落ちない偽物。
    storage: new Proxy({
      placement: async () => {
        // **どちらを読んだか**を記録する（getter で覗く）。値そのものは変えない。
        const r: any = { ok: reply.ok }
        Object.defineProperty(r, 'placement', { get: () => reply.placement, enumerable: true })
        Object.defineProperty(r, 'placements', { get: () => { readPlacements = true; return reply.placements }, enumerable: true })
        return r
      },
    } as any, { get: (t, key) => (key in t ? t[key] : anything) }),
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
const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

import AppRunPanel from '../src/renderer/components/AppRunPanel'
import AppRunDedicatedPanel from '../src/renderer/components/AppRunDedicatedPanel'
import HanamiiPanel from '../src/renderer/components/HanamiiPanel'
import PublishedListModal from '../src/renderer/components/PublishedListModal'

/** まだ片づけていない購読（**テストどうしが混ざらないよう**、毎回必ず外す）。 */
let mounted: Array<() => void> = []

/**
 * パネルを1回だけ「描いて」、**すべての useEffect を動かす**。
 *
 * どの effect が保存場所を読むかは決め打ちしない（増えても壊れない）。
 * 落ちる effect（このテストでは動かない配線）は、ここでは見送る。
 */
async function renderAndRunEffects(panel: (p: any) => unknown, props: any): Promise<void> {
  hooks.states = []; hooks.effects = []; hooks.index = 0; hooks.rendered = []
  panel(props)
  for (const e of hooks.effects) {
    try {
      const c = e.fn()
      if (typeof c === 'function') mounted.push(c)
    } catch { /* この画面の別の配線（このテストの対象外）は見送る */ }
  }
  await settle()
}

/** 読み込みは非同期（await window.electronAPI.storage.placement など）。決着まで待つ。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

/**
 * 今の状態のまま**もう一度描く**（React の再描画と同じく、state は持ち越す）。
 * effect は回さない（依存が変わっていないので React でも回らない）。描いた要素は hooks.rendered に残る。
 */
function rerender(panel: (p: any) => unknown, props: any): void {
  hooks.index = 0; hooks.effects = []; hooks.rendered = []
  panel(props)
}

/** 要素の直下の文字（入れ子の要素は偽の jsx が null にするので、文字だけが残る）。 */
function textOf(props: any): string {
  const c = props?.children
  return (Array.isArray(c) ? c : [c]).filter(x => typeof x === 'string' || typeof x === 'number').join('')
}

/** 描いた要素のうち、文字が `text` ちょうどのボタン。 */
function findButton(text: string): { type: unknown; props: any } | undefined {
  return hooks.rendered.find(el => el.type === 'button' && textOf(el.props).trim() === text)
}

/** 画面が抱えている保存場所の一覧（**配列で持っていなければ、全件は出せない**）。 */
function keptBuckets(): string[] | null {
  const kept = hooks.states.find(v => Array.isArray(v) && v.length > 0 && typeof (v[0] as any)?.bucket === 'string')
  return kept ? (kept as any[]).map(p => String(p.bucket)) : null
}

beforeEach(() => {
  reply = { ok: true, placement: A, placements: [A, B] }
  readPlacements = false
  records = { ok: true, projects: [] }
  store.clear()
})
afterEach(() => { for (const c of mounted) { try { c() } catch { /* 片づけの失敗は無視 */ } } mounted = [] })

describe('破棄の確認の材料: 画面は保存場所を1件も落とさない', () => {
  it('★★★ 共用型 AppRun: 2件あれば2件とも抱える（消えるものを数え上げられる）', async () => {
    await renderAndRunEffects(AppRunPanel as any, { projectDir: '/tmp/proj-a', apiKey: 'k', onOpenCredentials: () => {} })
    expect(readPlacements, 'placements（全件）を読んでいない＝先頭1件しか見ていない').toBe(true)
    expect(keptBuckets(), '2件あるのに全件を抱えていない').toEqual([A.bucket, B.bucket])
  })

  it('★★★ 専有型 AppRun: 2件あれば2件とも抱える', async () => {
    await renderAndRunEffects(AppRunDedicatedPanel as any, { projectDir: '/tmp/proj-b', apiKey: 'k', onOpenCredentials: () => {} })
    expect(readPlacements, 'placements（全件）を読んでいない＝先頭1件しか見ていない').toBe(true)
    expect(keptBuckets(), '2件あるのに全件を抱えていない').toEqual([A.bucket, B.bucket])
  })

  it('★★ 1件しか無いときも、今までどおり1件を抱える', async () => {
    reply = { ok: true, placement: A, placements: [A] }
    await renderAndRunEffects(AppRunPanel as any, { projectDir: '/tmp/proj-c', apiKey: 'k', onOpenCredentials: () => {} })
    expect(keptBuckets()).toEqual([A.bucket])
  })

  it('★★ 用意していなければ0件（「消えます」と言う材料を作らない）', async () => {
    reply = { ok: true, placement: null, placements: [] }
    await renderAndRunEffects(AppRunPanel as any, { projectDir: '/tmp/proj-d', apiKey: 'k', onOpenCredentials: () => {} })
    expect(keptBuckets()).toBeNull()
  })

  it('★ 読めなかった回（ok:false）は、消えるものを勝手に作らない', async () => {
    reply = { ok: false, placement: null, placements: [] }
    await renderAndRunEffects(AppRunDedicatedPanel as any, { projectDir: '/tmp/proj-e', apiKey: 'k', onOpenCredentials: () => {} })
    expect(keptBuckets()).toBeNull()
  })

  // ── ③公開の HANAMII（開いたときに読む）──────────────────────────────
  it('★★★ ③公開の HANAMII: 2件あれば2件とも抱える', async () => {
    await renderAndRunEffects(HanamiiPanel as any, { projectDir: '/tmp/proj-f', apiKey: 'k', onOpenCredentials: () => {} })
    expect(readPlacements, 'placements（全件）を読んでいない＝先頭1件しか見ていない').toBe(true)
    expect(keptBuckets(), '2件あるのに全件を抱えていない').toEqual([A.bucket, B.bucket])
  })

  it('★★ ③公開の HANAMII: placements が無い古い応答でも、先頭1件は拾う（黙って空にしない）', async () => {
    reply = { ok: true, placement: A }
    await renderAndRunEffects(HanamiiPanel as any, { projectDir: '/tmp/proj-g', apiKey: 'k', onOpenCredentials: () => {} })
    expect(keptBuckets()).toEqual([A.bucket])
  })

  it('★ ③公開の HANAMII: 読めなかった回（ok:false）は、消えるものを勝手に作らない', async () => {
    reply = { ok: false, placement: A, placements: [A, B] }
    await renderAndRunEffects(HanamiiPanel as any, { projectDir: '/tmp/proj-h', apiKey: 'k', onOpenCredentials: () => {} })
    expect(keptBuckets()).toBeNull()
  })
})

// ── 📡 公開したもの一覧（🗑 破棄を押したときに読む）────────────────────────
//
// この画面は保存場所を**開いたときには読まず**、🗑 破棄を押して確認を出すとき（askConfirm）に読む。
// なので「開く（effect で公開の記録を読む）→ 描き直す → 🗑 破棄のボタンを実際に押す」の順に動かす。
describe('破棄の確認の材料: 📡 公開したもの一覧も保存場所を1件も落とさない', () => {
  const props = { onClose: () => {}, onOpenProject: () => {} }

  /** 一覧を開いて、HANAMII の行の 🗑 破棄を押す。押したあとの確認画面まで描き直す。 */
  async function openAndPressTeardown(): Promise<void> {
    store.set('sakura_workspace', '/tmp/ws')
    records = {
      ok: true,
      projects: [{
        dir: '/tmp/ws/myapp',
        name: 'myapp',
        publish: {
          hanamii: { projectId: 'hanamii-project-1' },
          targets: { hanamii: { publishedAt: '2026-09-24T01:00:00.000Z', url: 'https://myapp.example.invalid/' } },
        },
      }],
    }
    await renderAndRunEffects(PublishedListModal as any, props)
    rerender(PublishedListModal as any, props)
    const btn = findButton('🗑 破棄')
    expect(btn, '🗑 破棄のボタンが描かれていない（公開の記録から一覧を組み立てられていない）').toBeTruthy()
    readPlacements = false // ここから先の読み取りは、🗑 を押したことによるもの
    btn!.props.onClick()
    await settle()
    rerender(PublishedListModal as any, props)
  }

  /** 確認画面の「💾 …」の文（無ければ null）。 */
  function dataNote(): string | null {
    const t = hooks.rendered.map(el => textOf(el.props)).find(s => s.startsWith('💾'))
    return t ?? null
  }

  it('★★★ 2件あれば2件とも抱え、確認に2件とも名指しする', async () => {
    await openAndPressTeardown()
    expect(readPlacements, 'placements（全件）を読んでいない＝先頭1件しか見ていない').toBe(true)
    expect(keptBuckets(), '2件あるのに全件を抱えていない').toEqual([A.bucket, B.bucket])
    const note = dataNote()
    expect(note, '確認画面に保存場所の文が出ていない').not.toBeNull()
    expect(note, '名前が出ていない保存場所がある（名指ししないまま消させる）').toContain(A.bucket)
    expect(note, '名前が出ていない保存場所がある（名指ししないまま消させる）').toContain(B.bucket)
  })

  it('★★ placements が無い古い応答でも、先頭1件は拾って名指しする', async () => {
    reply = { ok: true, placement: A }
    await openAndPressTeardown()
    expect(keptBuckets()).toEqual([A.bucket])
    expect(dataNote()).toContain(A.bucket)
  })

  it('★ 読めなかった回（ok:false）は、消えるものを勝手に作らない', async () => {
    reply = { ok: false, placement: A, placements: [A, B] }
    await openAndPressTeardown()
    expect(keptBuckets()).toBeNull()
    expect(dataNote()).toBeNull()
  })
})
