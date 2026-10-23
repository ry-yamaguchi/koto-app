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
//   - AppRunPanel・専有型の手順6の節（DedicatedTeardownSection。0.6.22 の3B-6a でパネルから切り出した）… 開いたとき（useEffect）に読む
//   - HanamiiPanel（段階1の1c）… 開いたときには読まず、抱えない。🗑 を押した時点に共通の流れの読み口（teardown/facts.ts）が全件を読む。
//     その振る舞いは tests/hanamiiTeardownSection.test.ts（偽の React で HanamiiPanel を動かす）が固定する。ここは「抱えていない」ことだけ見る。
//   - PublishedListModal の HANAMII の行（段階1の1b）・共用型 AppRun の行（段階2の2b-2）… 一覧は保存場所を自分では読まない。
//     行（TeardownRow）が共通の流れを呼び、**押した時点で**共通の材料の読み口（electronFlowDeps の loadFacts）が全件を読んで、
//     確認の文（buildTeardownConfirm）に名前を出す。HANAMII は共通の読み口（storage:placement＝env.json の同意済み）、
//     共用型は main の記録（cloud:teardownRecord の placements＝env.json の同意済み + state にだけある保存場所）から。
//     偽の react の上では行の部品は動かないので、一覧が行に渡す仕様書（hanamiiTeardownSpec・sharedTeardownSpec）で、その読み口と確認の文を直接動かす。
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
/** `fs.readFile` が返す `.sakuraide.json` の中身（HANAMII の流れが、押した時点の記録として読む）。 */
let metaText = '{}'
/** `cloud.teardownRecord` が返す中身（共用型の流れが、押した時点の記録として読む）。 */
let recordReply: any = null

/** 何を触られても落ちない偽の electronAPI（ここで見たいのは storage.placement だけ）。 */
function fakeElectronApi(): any {
  const anything: any = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: () => Promise.resolve({}),
  })
  return new Proxy({
    // publishedRecords だけ中身を返す。ほかの fs（readFile など）は何を呼ばれても落ちない。
    // exists: 旧い共用型の記録（state.json）は無い（D9=2。.sakuraide.json だけがある）。
    fs: new Proxy({ publishedRecords: async () => records, readFile: async () => metaText, exists: async (p: string) => String(p).endsWith('/.sakuraide.json') } as any, {
      get: (t, key) => (key in t ? t[key] : anything),
    }),
    // cloud:teardownRecord（共用型の破棄の材料）。ほかの cloud は何を呼ばれても落ちない。
    cloud: new Proxy({ teardownRecord: async () => recordReply } as any, { get: (t, key) => (key in t ? t[key] : anything) }),
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
import DedicatedTeardownSection from '../src/renderer/components/DedicatedTeardownSection'
import HanamiiPanel from '../src/renderer/components/HanamiiPanel'
import PublishedListModal from '../src/renderer/components/PublishedListModal'
import { electronFlowDeps } from '../src/renderer/teardown/flow'
import { buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import { hanamiiTeardownSpec } from '../src/renderer/teardown/targets/hanamii'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import { runTeardownFlow } from '../src/renderer/teardown/flow'

/** 専有型の手順6の節に渡す最小の props（押さない・結果も無い。保存場所を読んで抱えるかだけを見る）。 */
const sectionProps = (projectDir: string) => ({
  projectDir, locked: false, showButton: true, tearingDown: false, running: false, runningRecord: null, nowMs: 0,
  apprunState: null, appRecord: null, summaryLines: [], view: null, notes: [], onStart: () => {}, onDone: async () => {},
})

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
  metaText = '{}'
  recordReply = null
  store.clear()
})
afterEach(() => { for (const c of mounted) { try { c() } catch { /* 片づけの失敗は無視 */ } } mounted = [] })

describe('破棄の確認の材料: 画面は保存場所を1件も落とさない', () => {
  it('★★★ 共用型 AppRun: 2件あれば2件とも抱える（消えるものを数え上げられる）', async () => {
    await renderAndRunEffects(AppRunPanel as any, { projectDir: '/tmp/proj-a', apiKey: 'k', onOpenCredentials: () => {} })
    expect(readPlacements, 'placements（全件）を読んでいない＝先頭1件しか見ていない').toBe(true)
    expect(keptBuckets(), '2件あるのに全件を抱えていない').toEqual([A.bucket, B.bucket])
  })

  it('★★★ 専有型 AppRun（手順6の節）: 2件あれば2件とも抱える', async () => {
    await renderAndRunEffects(DedicatedTeardownSection as any, sectionProps('/tmp/proj-b'))
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
    await renderAndRunEffects(DedicatedTeardownSection as any, sectionProps('/tmp/proj-e'))
    expect(keptBuckets()).toBeNull()
  })

  // ── ③公開の HANAMII ──────────────────────────────────────────────
  // 段階1の1c: 【公開】(HanamiiPanel) は保存場所を**開いたときには読まない**（画面の写しはいつでも古いので持たない）。
  // 🗑 を押した時点に、共通の流れの読み口（teardown/facts.ts）が全件を読んで確認の文に名前を出す。
  // その振る舞い（2件とも名指し・placements が無い古い応答でも先頭1件・読めなかった回は消えるものを作らず注意を出す）は
  // tests/hanamiiTeardownSection.test.ts が、HanamiiPanel を動かして固定している。
  it('★★ ③公開の HANAMII: 保存場所の全件を画面の state に抱えない（確認は押した時点に読む）', async () => {
    await renderAndRunEffects(HanamiiPanel as any, { projectDir: '/tmp/proj-f', apiKey: 'k', onOpenCredentials: () => {} })
    expect(keptBuckets(), '開いたときの写しで確認を作ることになる（押した時点より古い）').toBeNull()
  })
})

// ── 📡 公開したもの一覧の共用型 AppRun の行（段階2の2b-2）──────────────────────────────
//
// 共用型の 🗑 も、一覧が保存場所を読む askConfirm ではなく、行（TeardownRow）→ 共通の流れ（runTeardownFlow）を通る。
// 共用型の仕様書は共通の読み口（storage:placement＝env.json の同意済みだけ）を呼ばず、押した時点の main の記録（cloud:teardownRecord）の
// placements（env.json の同意済み + state にだけある保存場所）を使う（確認が言うものと main が消すものを同じ関数で決める）。
// ここで見るのは、その材料から確認の文が保存場所を全件・名前つきで言うこと、記録を読めなかったときは確認を出さないこと。
// 一覧が行にこの仕様書を渡していること自体は tests/publishedListSharedRow.test.ts。本物の main を通した一致は tests/sharedTeardownConfirm.test.ts（P5-確認）。
describe('破棄の確認の材料: 📡 一覧の共用型 AppRun の行（共通の流れ）も保存場所を1件も落とさない', () => {
  const plain = (p: typeof A) => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })
  const record = (over: Record<string, unknown> = {}) => ({
    ok: true,
    record: { appNames: ['myapp'], registryName: null, registryOrigin: 'owned', registryUsers: [], placements: [plain(A), plain(B)], stateOnlyBuckets: [], ...over },
  })
  const depsOf = (confirm: () => Promise<boolean> = async () => false) =>
    electronFlowDeps('/tmp/ws/myapp', sharedTeardownSpec, { confirm, confirmWithChoices: async () => ({ confirmed: false, choices: {} }), keyMissingMessage: 'k' })

  /** 🗑 を押した時点の確認の文（行が呼ぶ流れと同じ読み口・同じ文の作り手）。 */
  async function confirmBodyAtPress(): Promise<string> {
    return buildTeardownConfirm(sharedTeardownSpec, await depsOf().loadFacts()).body
  }

  beforeEach(() => { recordReply = record() })

  it('★★★ 2件あれば2件とも読み、確認に2件とも名前を出す（保存場所『A』『B』のデータも削除する旨）。共通の読み口（storage:placement）は呼ばない', async () => {
    const body = await confirmBodyAtPress()
    expect(body, '名前が出ていない保存場所がある（名前を出さないまま消させる）').toContain(A.bucket)
    expect(body, '名前が出ていない保存場所がある（名前を出さないまま消させる）').toContain(B.bucket)
    expect(body).toContain('データも削除します')
    expect(body).toContain('この操作は元に戻せません。')
    expect(readPlacements, '共用型が env.json だけの読み口（storage:placement）を呼んでいる＝state にだけある保存場所が確認から落ちる').toBe(false)
  })

  it('★★ state にだけある保存場所（設定から外したもの）も名前を出し、言い分ける（言って消す）', async () => {
    recordReply = record({ stateOnlyBuckets: [B.bucket] })
    const body = await confirmBodyAtPress()
    expect(body).toContain(`設定から外した保存場所『${B.bucket}』も削除します。`)
    expect(body).toContain(A.bucket)
    expect(body).not.toContain(`設定から外した保存場所『${A.bucket}』`)
  })

  it('★★ 保存場所が1件でも、名前を出す', async () => {
    recordReply = record({ placements: [plain(A)] })
    const body = await confirmBodyAtPress()
    expect(body).toContain(A.bucket)
    expect(body).not.toContain(B.bucket)
  })

  it('★★ 保存場所が0件（アプリだけ）。保存場所のことは言わない（記録に無いものを「消えます」と言わない）', async () => {
    recordReply = record({ placements: [] })
    const body = await confirmBodyAtPress()
    expect(body).not.toContain('💾')
    expect(body).not.toContain('保存場所')
  })

  it('★ 記録を読めなかった回（ok:false）・形が違う回は、確認の材料を作らない。確認も出さず、何も消さない（消すものを空に倒さない）', async () => {
    for (const bad of [{ ok: false, message: '保存場所の設定を読めませんでした（テスト）' }, { ok: true, record: { appNames: ['myapp'] } }, null]) {
      recordReply = bad
      await expect(depsOf().loadFacts(), JSON.stringify(bad)).rejects.toThrow()
      let asked = 0
      let invoked = 0
      const out = await runTeardownFlow('/tmp/ws/myapp', sharedTeardownSpec, {
        ...depsOf(async () => { asked++; return true }),
        confirmWithChoices: async () => { asked++; return { confirmed: true, choices: {} } },
        invoke: async () => { invoked++; return { ok: true } },
      })
      expect(asked).toBe(0)
      expect(invoked).toBe(0)
      expect(out).toMatchObject({ cancelled: false, result: { ok: false } })
      expect((out as any).result.message).toContain(sharedTeardownSpec.words.factsUnreadable)
    }
  })
})

// ── 📡 公開したもの一覧の HANAMII の行（段階1の1b）──────────────────────────────
//
// HANAMII の 🗑 は、一覧が保存場所を読む askConfirm ではなく、行（TeardownRow）→ 共通の流れ（runTeardownFlow）を通る。
// 材料は押した時点に共通の読み口（electronFlowDeps の loadFacts）が読み、確認の文は buildTeardownConfirm が作る（入口によらず同じ文）。
// ここで見るのは、その読み口と確認の文が、保存場所を全件・名前つきで言うこと、読めなかったときは言い落とさず注意を出すこと。
// 一覧が行にこの仕様書を渡していること自体は tests/publishedListHanamiiRow.test.ts。
describe('破棄の確認の材料: 📡 一覧の HANAMII の行（共通の流れ）も保存場所を1件も落とさない', () => {
  beforeEach(() => {
    metaText = JSON.stringify({
      name: 'myapp',
      publish: {
        hanamii: { projectId: 'hanamii-project-1', name: 'myapp' },
        targets: { hanamii: { publishedAt: '2026-09-24T01:00:00.000Z', url: 'https://myapp.example.invalid/' } },
      },
    })
  })

  /** 🗑 を押した時点の確認の文（行が呼ぶ流れと同じ読み口・同じ文の作り手）。 */
  async function confirmBodyAtPress(): Promise<string> {
    const deps = electronFlowDeps('/tmp/ws/myapp', hanamiiTeardownSpec, { confirm: async () => false, keyMissingMessage: 'k' })
    return buildTeardownConfirm(hanamiiTeardownSpec, await deps.loadFacts()).body
  }

  it('★★★ 2件あれば2件とも読み、確認に2件とも名前を出す（保存場所『A』『B』のデータも削除する旨）', async () => {
    const body = await confirmBodyAtPress()
    expect(readPlacements, 'placements（全件）を読んでいない＝先頭1件しか見ていない').toBe(true)
    expect(body, '名前が出ていない保存場所がある（名前を出さないまま消させる）').toContain(A.bucket)
    expect(body, '名前が出ていない保存場所がある（名前を出さないまま消させる）').toContain(B.bucket)
    expect(body).toContain('保存場所にあるデータの削除は元に戻せません')
  })

  it('★★ placements が無い古い応答でも、先頭1件は拾って名前を出す', async () => {
    reply = { ok: true, placement: A }
    const body = await confirmBodyAtPress()
    expect(body).toContain(A.bucket)
  })

  it('★★ 用意していなければ0件。保存場所のことも、「元に戻せません」も言わない（HANAMII のプロジェクトそのものは原本に無いので言わない）', async () => {
    reply = { ok: true, placement: null, placements: [] }
    const body = await confirmBodyAtPress()
    expect(body).not.toContain('💾')
    expect(body).not.toContain('元に戻せません')
  })

  it('★ 読めなかった回（ok:false）は、消えるものを勝手に作らず、「保存場所の削除は行われません」と注意を出す', async () => {
    reply = { ok: false, placement: A, placements: [A, B] }
    const body = await confirmBodyAtPress()
    expect(body).not.toContain(A.bucket)
    expect(body).not.toContain('💾')
    expect(body).toContain('保存場所の削除は行われません')
  })
})
