import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── なぜこのテストが要るか（2026-10-22 rc.4 の実機）────────────────────────────
//
// 同じ【公開】のモーダルの中で、HANAMII の公開を破棄した。保存場所 koto-rc-s1022 はバケットごと削除され、
// env.json の persistence.objectStorage は [] になった。ところがモーダル上部の「💾 データの保存」は
// 「用意済み／保存場所: koto-rc-s1022（ほかのプロジェクトと共有）／…公開しても追加の費用はかかりません」と出し続けた。
// このまま公開すると、保存場所なしで公開され、データは再起動で消える（画面は保存されると言う＝危ない側の間違い）。
//
// 原因は2つ（根は同じ: 「画面が持っている写しはいつでも古い」・掟10）:
//   C1. 破棄の終わりの知らせ（sakura-meta-changed）で、保存場所の「一覧」だけを読み直し、
//       このプロジェクトの保存場所の「記録」（storage.placement）は開いたときにしか読んでいなかった
//   C2. 記録にあるのに一覧に無いときの黄色い注意は、一覧が1件以上あるときしか出なかった。
//       実機では石狩のバケットが0件になったので、注意も出なかった
//
// 直し:
//   ・破棄が済んだ知らせでは、記録を読み直して当ててから、一覧を読み直す（先に記録。逆だと、消えた一覧に対して
//     もう無い記録が一瞬「見つかりません」と出る）。設定で保存場所を作った知らせは、今までどおり一覧だけ
//   ・記録を読み直す口は追い越されたら捨てる（遅れて返った古い読みが、新しい記録を上書きしない・別のプロジェクトに当たらない。掟11）。
//     追い越しの守りは2つに分かれる:
//       世代 … 読み以外が記録を変えたとき（用意の成功）と、プロジェクトが変わったときだけ上がる。読み始めた世代のままでなければ捨てる
//       番号 … 読み始めるたびに通し番号を振り、当てたら残す。自分より後に始まった読みがもう当たっていたら、自分は当てない
//     読みの開始・読みが当てるときは世代を上げない（上げると、読み直しが読めなかっただけで、まだ飛んでいる開いたときの
//     読みまで捨てて、ディスクに記録があるのに「用意なし」になる〔i1〜i3〕。当てるときに上げると、重なった次の読みが捨てられる〔c2〕）
//   ・「記録にあるが一覧に無いか」の判定は placementMissing 1つ。一覧が読めて0件なら「無い」と確かめられている。
//     ただし siteReady が true のときだけ（storage:status は、利用開始の問い合わせが 403・429・5xx で失敗しても
//     「利用開始前」と同じ siteReady: false・0件で返す。記録があるのに利用開始前は普通ないので、一時的な失敗として「無い」と言わない）。
//     canPrepare は siteReady を見ない（新しい利用者は本当に利用開始前で、用意を押せる必要がある〔h7〕）
//
// ここは**振る舞い**で固定する（掟10。ソースの文字列は読まない）。偽の react で StorageNotice を実際に動かし
// （tests/placementAllPanels.test.ts と同じ流儀。ただし effect の依存の変化・ref の持ち越しも再現する）、
// 偽の window.electronAPI.storage に実際に流して、**描いた結果**（「保存場所: 」の行・黄色い注意）と
// **呼ばれた要求の一覧と順序**（どのプロジェクトの記録を読みに行ったかも）を見る。
//
// ミューテーション（当てて落ちることを確認した対象と、実測で落ちたテスト。2026-10-22 2巡目）:
//   (a) 破棄の知らせで記録を読み直さない（一覧だけの形へ戻す）
//         → a・b2・c1・c2・c3・d1・d2・d4・e・i1・i2・i4
//   (b) 読み直しの失敗で記録を消す／書く: ok でない → b1・i1・i3。例外 → b2・i2・i3
//   (c) 追い越しの守り:
//         世代の確認を外す → c4・d3
//         番号の確認を外す → c1・c3・i4
//         当てたとき番号を残さない → c1・c3・i4
//         読みが当てるときに世代を上げる → c2
//   (d) 読みを始めるときに世代を上げる（1巡目の形） → i1・i2・i3
//   (e) 一覧を読み直してから記録を読む（順序を入れ替える） → b2・e
//   (f) 設定の知らせでも記録を読む → f
//   (g) placementMissing の条件:
//         `buckets.length > 0` を見る形へ戻る → g1・h1・h4・h6・k1・k4
//         siteReady を見ない → g7・h5・h6・k2・k4
//         loaded を見ない → g2。listFailed を見ない → g3
//   (h) プロジェクトが変わったとき:
//         世代の更新だけを外す → d3。プロジェクトの確認と世代の更新をどちらも外す → d1・d3
//         プロジェクトの確認だけを外しても、世代の更新が捨てるので、振る舞いは変わらない（二重の守り。d2 は番号でも捨てられる）
//   (h2) refreshPlacement が projectDirRef でなく projectDir（最初の描画の値）を読む → d4
//         （知らせの聞き手は依存 [] で一度だけ登録されるので、最初の描画の値のままになる）
//   (i) 開いたときの読みが世代・番号を見ない → c3・i4
//   (j) 用意の成功で世代を上げない → c4
//   (k) siteReady を状態に入れる道:
//         readBucketList が常に true → h5・h6・k2・k3・k4
//         reload が当てない → h1・h4・h6・k1・k4
//         canPrepare が siteReady を見る → h7・k2

/** 偽の react。hooks の slot を呼び出し順の添字で持ち越し、effect は依存が変わったときだけ（後始末つきで）回す。 */
const rt = vi.hoisted(() => ({
  slots: [] as any[],
  i: 0,
  rendering: false,
  pending: [] as { i: number; fn: () => void | (() => void); deps: unknown[] | undefined }[],
}))

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = rt.i++
    if (!(i in rt.slots)) rt.slots[i] = { v: typeof init === 'function' ? (init as () => unknown)() : init }
    const slot = rt.slots[i]
    return [slot.v, (v: unknown) => { slot.v = typeof v === 'function' ? (v as (p: unknown) => unknown)(slot.v) : v }]
  },
  useRef: (init: unknown) => {
    const i = rt.i++
    if (!(i in rt.slots)) rt.slots[i] = { current: init }
    return rt.slots[i]
  },
  useEffect: (fn: () => void | (() => void), deps: unknown[] | undefined) => { rt.pending.push({ i: rt.i++, fn, deps }) },
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  default: {},
}))
// 画面は作らない。ただし**描いた木**は残す（文字と、ボタンの onClick を読むため）。
vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: any) => ({ type, props })
  return { jsx, jsxs: jsx, Fragment: Symbol.for('fragment') }
})
// vitest の変換は開発用の jsxDEV で書き出す（tests/placementAllPanels.test.ts の注意と同じ）
vi.mock('react/jsx-dev-runtime', () => {
  const jsxDEV = (type: unknown, props: any) => ({ type, props })
  return { jsxDEV, Fragment: Symbol.for('fragment') }
})

import StorageNotice from '../src/renderer/components/StorageNotice'
import { placementMissing, emptyBucketList, canPrepare, createBucketListController, type BucketListState } from '../src/renderer/storageChoice'

// ── 偽の環境 ─────────────────────────────────────────────

type Rec = { bucket: string; prefix: string; shared: boolean; consentedAt: string }
const rec = (bucket: string): Rec => ({ bucket, prefix: 'projects/app/', shared: true, consentedAt: '2026-10-22T00:00:00.000Z' })

const A = '/tmp/koto-rc/app-a'
const B = '/tmp/koto-rc/app-b'
const S1022 = 'koto-rc-s1022'

/** ディスクの中身（env.json の記録と、石狩のバケット）。テストが破棄を真似るときは、ここを書き換える。 */
const disk = { placement: {} as Record<string, Rec | null>, buckets: [] as string[], siteReady: true }
/** 呼ばれた storage の要求（順序つき）。 */
let calls: string[] = []
/** storage.placement に渡されたプロジェクト（順序つき。どのプロジェクトの記録を読みに行ったかを見る）。 */
let placementDirs: string[] = []
/** 要求を受けた時点の画面（段落の文）。「記録を当ててから一覧を読む」を、描いた結果で見るため。 */
let seen: { at: string; rows: string[] }[] = []
/** 次の要求への応答を、順に差し替える（空なら、ディスクの中身をそのまま返す）。 */
let queue: { placement: Array<(dir: string) => Promise<any>>; status: Array<() => Promise<any>> } = { placement: [], status: [] }

const defaultPlacement = (dir: string) => {
  const p = disk.placement[dir] ?? null
  return { ok: true, placement: p, placements: p ? [p] : [] }
}
/** storage:status の成功の応答（src/main/ipc/cloud.ts）。**利用開始前（siteReady: false）は、一覧を引かず0件で返る。** */
const defaultStatus = () => ({ ok: true, siteReady: disk.siteReady, buckets: disk.siteReady ? disk.buckets.map(name => ({ name })) : [] })

let currentProps: any = null

function installWindow(): any {
  const win: any = new EventTarget()
  const store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  }
  win.localStorage = ls
  win.electronAPI = {
    storage: {
      // usesDataLayer: koto-data を使っている＝「データの保存」の枠（declared）が出る
      scan: async () => { calls.push('scan'); return { ok: true, usesDataLayer: true, usedBy: [], writesFiles: [], keepsInMemory: [] } },
      placement: (dir: string) => {
        calls.push('placement'); placementDirs.push(dir); record('placement')
        const h = queue.placement.shift()
        return h ? h(dir) : Promise.resolve(defaultPlacement(dir))
      },
      status: () => {
        calls.push('status'); record('status')
        const h = queue.status.shift()
        return h ? h() : Promise.resolve(defaultStatus())
      },
      leftoverData: async () => ({ ok: true, files: [] }),
      prepare: async () => {
        calls.push('prepare')
        const created = { bucket: 'koto-new-bucket', prefix: 'projects/app/', shared: true }
        disk.buckets = [created.bucket]
        disk.siteReady = true
        disk.placement[A] = { ...created, consentedAt: '2026-10-22T00:00:00.000Z' }
        return { ok: true, placement: created, dataLayerPlaced: false, dataLayerFile: null }
      },
    },
  }
  ;(globalThis as any).window = win
  ;(globalThis as any).localStorage = ls
  return win
}

let win: any

// ── 偽の react を動かす道具 ────────────────────────────────

function sameDeps(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (!a || !b) return false
  return a.length === b.length && a.every((v, k) => Object.is(v, b[k]))
}

/**
 * 1回描く。state・ref は持ち越し、effect は**依存が変わったものだけ**（前の後始末のあとに）回す。
 * 返すのは描いた木。effect の中の setState は、次の描画（view）で見える。
 */
function render(props: any): any {
  currentProps = props
  rt.rendering = true
  rt.i = 0
  rt.pending = []
  let tree: any
  try {
    tree = (StorageNotice as any)(props)
  } finally {
    rt.rendering = false
  }
  const changed = rt.pending.filter(e => !rt.slots[e.i] || !sameDeps(rt.slots[e.i].deps, e.deps))
  for (const e of changed) rt.slots[e.i]?.cleanup?.()
  rt.rendering = true
  try {
    for (const e of changed) {
      const c = e.fn()
      rt.slots[e.i] = { deps: e.deps, cleanup: typeof c === 'function' ? c : undefined }
    }
  } finally {
    rt.rendering = false
  }
  return tree
}

/** いまの state のまま描き直す（依存は変わらないので effect は回らない）。 */
const view = () => render(currentProps)

/** 木のうち、文字を取り出す（部品は呼んで開き、host の要素は子を見る）。 */
function textOf(node: any): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return textOf(node.props?.children)
}

/** 木のうち、type が一致する要素（部品は呼んで開く）。 */
function elementsOf(node: any, type: string, out: any[] = []): any[] {
  if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) { for (const n of node) elementsOf(n, type, out); return out }
  if (node.type === type) out.push(node)
  if (typeof node.type === 'function') return elementsOf(node.type(node.props), type, out)
  return elementsOf(node.props?.children, type, out)
}

const rowsOf = (tree: any): string[] => elementsOf(tree, 'p').map(textOf)
const rows = () => rowsOf(view())
/** 「保存場所: koto-rc-s1022　（ほかのプロジェクトと共有）」の行（無ければ undefined）。 */
const placementRow = () => rows().find(t => t.startsWith('保存場所: '))
const headline = () => rows()[0]
const warned = (rs: string[] = rows()) => rs.some(t => t.includes('⚠️ この保存場所は見つかりません'))

/** 要求を受けた時点の画面を残す（描画の最中に呼ばれたときは残さない）。 */
function record(at: string): void {
  if (rt.rendering || !currentProps) return
  seen.push({ at, rows: rowsOf(view()) })
}

/** 非同期の読み込みが決着するまで待つ。 */
async function settle(): Promise<void> {
  for (let k = 0; k < 30; k++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let k = 0; k < 30; k++) await Promise.resolve()
}

async function mount(dir: string = A): Promise<void> {
  render({ projectDir: dir, target: 'sakura-apprun' })
  await settle()
}

/** ボタンを押す（文字がちょうど label のもの）。 */
async function click(label: string): Promise<void> {
  const btn = elementsOf(view(), 'button').find(b => textOf(b).trim() === label)
  if (!btn) throw new Error(`ボタンが見つからない: ${label}`)
  await btn.props.onClick()
  await settle()
}

function deferred<T = any>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

const fire = (name: string) => win.dispatchEvent(new Event(name))

beforeEach(() => {
  disk.placement = {}
  disk.buckets = []
  disk.siteReady = true
  calls = []
  placementDirs = []
  seen = []
  queue = { placement: [], status: [] }
  rt.slots = []
  rt.i = 0
  rt.pending = []
  currentProps = null
  win = installWindow()
})
afterEach(() => {
  // 画面を片づける（知らせの聞き手を外す）
  for (const s of rt.slots) { try { s?.cleanup?.() } catch { /* 片づけの失敗は無視 */ } }
  rt.slots = []
  currentProps = null
})

/** 保存場所 koto-rc-s1022 を用意済みの、実機の最初の状態。 */
function prepared(): void {
  disk.placement[A] = rec(S1022)
  disk.buckets = [S1022]
}

// ── a. 実機の欠陥そのもの ─────────────────────────────────────

describe('破棄が済んだ知らせ（sakura-meta-changed）で、保存場所の記録を読み直す', () => {
  it('★★★ a. 用意済みで開く → 破棄で記録が [] になり、バケットも消える → 「用意済み」の行が消える（実機の欠陥）', async () => {
    prepared()
    await mount()
    // 前提: 開いたときは、用意済みの保存場所が出ている
    expect(headline()).toBe('💾 データの保存（用意済み）')
    expect(placementRow()).toContain(S1022)
    expect(warned()).toBe(false)

    // 破棄: 保存場所がバケットごと削除され、env.json の記録も空になる
    disk.placement[A] = null
    disk.buckets = []
    fire('sakura-meta-changed')
    await settle()

    expect(placementRow(), '消えた保存場所が「保存場所: …」と出続けている').toBeUndefined()
    expect(headline(), '「用意済み」と出続けている').toBe('💾 データの保存')
    expect(rows().some(t => t.includes('公開しても追加の費用はかかりません'))).toBe(false)
    // 記録が無いので、見つからないものも無い
    expect(warned()).toBe(false)
  })

  it('★★★ b1. 記録の読みが失敗（ok でない）→ いまの表示を変えない（保存場所の行は残る）', async () => {
    prepared()
    await mount()
    queue.placement.push(async () => ({ ok: false, placement: null, placements: [], message: '読めませんでした' }))
    fire('sakura-meta-changed')
    await settle()
    expect(placementRow()).toContain(S1022)
    expect(headline()).toBe('💾 データの保存（用意済み）')
  })

  it('★★★ b2. 記録の読みが例外 → いまの表示を変えない。一覧は読み直す', async () => {
    prepared()
    await mount()
    calls = []
    queue.placement.push(async () => { throw new Error('IPC が落ちた') })
    fire('sakura-meta-changed')
    await settle()
    expect(placementRow()).toContain(S1022)
    expect(headline()).toBe('💾 データの保存（用意済み）')
    // 記録を読めなくても、一覧の読み直しは行う（順序は e）
    expect(calls).toEqual(['placement', 'status'])
  })

  it('★★★ c1. 追い越し: 遅い読み直し（古い値）が、あとから始まった速い読み直し（新しい値）より後に終わっても、新しい値が残る', async () => {
    prepared()
    await mount()
    const slow = deferred()
    queue.placement.push(() => slow.promise)                                          // 1回目: 遅い（古い値を返す）
    queue.placement.push(async () => ({ ok: true, placement: null, placements: [] })) // 2回目: 速い（新しい値）
    fire('sakura-meta-changed')
    fire('sakura-meta-changed')
    await settle()
    expect(placementRow(), '新しい値（記録なし）が当たっていない').toBeUndefined()

    slow.resolve({ ok: true, placement: rec(S1022), placements: [rec(S1022)] })       // 古い値が、あとから返る
    await settle()
    expect(placementRow(), '遅れて返った古い読みが、新しい記録を上書きした').toBeUndefined()
    expect(headline()).toBe('💾 データの保存')
  })

  it('★★★ c2. 追い越し: 重なった2回の読み直しが順に終わっても、あとから始めた読みの値が残る', async () => {
    prepared()
    await mount()
    const first = deferred()
    const second = deferred()
    queue.placement.push(() => first.promise)   // 先に始めた読み（まだ破棄の前の値）
    queue.placement.push(() => second.promise)  // あとから始めた読み（破棄のあとの値）
    fire('sakura-meta-changed')
    fire('sakura-meta-changed')
    await settle()

    first.resolve({ ok: true, placement: rec(S1022), placements: [rec(S1022)] })
    await settle()
    second.resolve({ ok: true, placement: null, placements: [] })
    await settle()
    expect(placementRow(), '先に始めた読みが当たり、あとから始めた新しい読みが捨てられた').toBeUndefined()
    expect(headline()).toBe('💾 データの保存')
  })

  it('★★★ c3. 開いたときの遅い初回の読みが、そのあとに当たった新しい記録を上書きしない', async () => {
    disk.placement[A] = null
    const slowOpen = deferred()
    queue.placement.push(() => slowOpen.promise)  // 開いたときの読み（遅い。古い値を返す）
    render({ projectDir: A, target: 'sakura-apprun' })
    await settle()
    // 読みの途中で、記録は変わっていた（読み直しは新しい値を返す）
    queue.placement.push(async () => ({ ok: true, placement: rec('koto-newer'), placements: [rec('koto-newer')] }))
    fire('sakura-meta-changed')
    await settle()
    // （開いたときの読みが返るまで、枠そのものがまだ出ない。返ったあとの画面で見る）

    slowOpen.resolve({ ok: true, placement: rec('koto-older'), placements: [rec('koto-older')] })
    await settle()
    expect(placementRow(), '遅れて返った初回の読みが、新しい記録を上書きした').toContain('koto-newer')
    expect(placementRow()).not.toContain('koto-older')
  })

  it('★★★ c4. 用意の成功より前に始めた読み直しは、あとで古い値を返しても当たらない', async () => {
    disk.placement[A] = null
    await mount()
    // 用意の前に始めた読み直し（遅い。「記録なし」を返す）
    const stale = deferred()
    queue.placement.push(() => stale.promise)
    fire('sakura-meta-changed')
    await settle()

    // 用意する（費用に同意）→ 新しい保存場所が記録に載る
    await click('保存場所を用意する…')
    await click('用意する（費用に同意）')
    expect(calls).toContain('prepare')
    expect(placementRow()).toContain('koto-new-bucket')

    stale.resolve({ ok: true, placement: null, placements: [] })
    await settle()
    expect(placementRow(), '用意より前に始めた古い読みが、用意した保存場所の記録を消した').toContain('koto-new-bucket')
  })

  it('★★★ d1. プロジェクトが変わったあとに、前のプロジェクトの読みが終わっても当たらない（掟11）', async () => {
    prepared()
    disk.placement[B] = null
    await mount(A)
    const lateFromA = deferred()
    queue.placement.push(() => lateFromA.promise)  // A の読み直し（遅い）
    fire('sakura-meta-changed')
    await settle()

    // B に切り替える。B の記録の読みは失敗する（B の読みが記録を変えて、世代を上げることはない）
    queue.placement.push(async () => ({ ok: false, placement: null, placements: [], message: '読めませんでした' }))
    render({ projectDir: B, target: 'sakura-apprun' })
    await settle()

    lateFromA.resolve({ ok: true, placement: rec('koto-late-from-a'), placements: [rec('koto-late-from-a')] })
    await settle()
    expect(rows().some(t => t.includes('koto-late-from-a')), '前のプロジェクトの読みが、いまのプロジェクトの画面に当たった').toBe(false)
  })

  it('★★★ d2. プロジェクトを変えて B の記録が読めたあとに、前のプロジェクト A の読みが終わっても、B の画面は変わらない', async () => {
    prepared()
    disk.placement[B] = null
    await mount(A)
    const lateFromA = deferred()
    queue.placement.push(() => lateFromA.promise)
    fire('sakura-meta-changed')
    await settle()

    render({ projectDir: B, target: 'sakura-apprun' })   // B の記録は無い（既定の応答: null）
    await settle()
    expect(placementRow(), 'B は保存場所を用意していない').toBeUndefined()

    lateFromA.resolve({ ok: true, placement: rec('koto-late-from-a'), placements: [rec('koto-late-from-a')] })
    await settle()
    expect(placementRow(), 'A の遅い読みが B の画面に当たった').toBeUndefined()
    expect(headline()).toBe('💾 データの保存')
  })

  it('★★★ d3. A → B → A と切り替えて A に戻っても、最初の A で始めた読みは当たらない（同じプロジェクトでも、別の表示のときの読み）', async () => {
    prepared()
    disk.placement[B] = null
    await mount(A)
    const lateFromA = deferred()
    queue.placement.push(() => lateFromA.promise)
    fire('sakura-meta-changed')
    await settle()

    // B へ、そして A へ戻る。どちらの記録の読みも失敗する（読みが記録を変えて世代を上げることはない）
    queue.placement.push(async () => ({ ok: false, placement: null, placements: [], message: '読めませんでした' }))
    render({ projectDir: B, target: 'sakura-apprun' })
    await settle()
    queue.placement.push(async () => ({ ok: false, placement: null, placements: [], message: '読めませんでした' }))
    render({ projectDir: A, target: 'sakura-apprun' })
    await settle()

    lateFromA.resolve({ ok: true, placement: rec('koto-late-from-a'), placements: [rec('koto-late-from-a')] })
    await settle()
    expect(rows().some(t => t.includes('koto-late-from-a')), '切り替える前の読みが、戻ってきた画面に当たった').toBe(false)
  })

  it('★★★ d4. A → B と切り替えたあとの破棄の知らせは、B の記録を読み直して当てる（聞き手は最初の描画の版のまま。A を読みに行かない）', async () => {
    prepared()                                       // A: koto-rc-s1022
    disk.placement[B] = rec('koto-b-bucket')
    disk.buckets = [S1022, 'koto-b-bucket']
    await mount(A)
    render({ projectDir: B, target: 'sakura-apprun' })  // B に切り替える
    await settle()                                      // B の読みが済む
    expect(placementRow()).toContain('koto-b-bucket')
    expect(placementDirs).toEqual([A, B])

    // B の公開先を破棄した: B の記録が消える（A の記録は残っている）
    disk.placement[B] = null
    disk.buckets = [S1022]
    placementDirs = []
    fire('sakura-meta-changed')
    await settle()

    expect(placementDirs, '切り替えたあとの知らせが、前のプロジェクトの記録を読みに行った').toEqual([B])
    expect(placementRow(), 'B の「保存場所: 」の行が残っている（A の記録を読んで捨てた）').toBeUndefined()
    expect(headline()).toBe('💾 データの保存')
  })
})

// ── 開いたときの読みが飛んでいる間に、破棄の知らせが来たとき（読みの開始で世代を上げると、有効な初回の読みが捨てられる）──

describe('開いたときの読みが飛んでいる間の知らせ', () => {
  /** 開いたときの読み（記録あり・遅い）を飛ばしたまま、読み直しを走らせる。初回の読みを解決する関数を返す。 */
  async function openThenNotify(refresh: () => Promise<any>): Promise<() => Promise<void>> {
    prepared()
    const slowOpen = deferred()
    queue.placement.push(() => slowOpen.promise)  // 開いたときの読み（遅い。ディスクにある記録を返す）
    render({ projectDir: A, target: 'sakura-apprun' })
    await settle()
    queue.placement.push(refresh)                 // 知らせのあとの読み直し
    fire('sakura-meta-changed')
    await settle()
    // 前提: 開いたときと読み直しの2回、記録を読みに行っている
    expect(calls.filter(c => c === 'placement')).toHaveLength(2)
    return async () => {
      slowOpen.resolve({ ok: true, placement: rec(S1022), placements: [rec(S1022)] })
      await settle()
    }
  }

  it('★★★ i1. 読み直しが ok でなく終わっても、そのあと初回の読みが返れば、保存場所の行が出る（記録があるのに「用意なし」にならない）', async () => {
    const finishOpen = await openThenNotify(async () => ({ ok: false, placement: null, placements: [], message: '読めませんでした' }))
    await finishOpen()
    expect(placementRow(), 'ディスクに記録があるのに、読み直しの失敗で初回の読みまで捨てられた').toContain(S1022)
    expect(headline()).toBe('💾 データの保存（用意済み）')
  })

  it('★★★ i2. 読み直しが例外で終わっても、そのあと初回の読みが返れば、保存場所の行が出る', async () => {
    const finishOpen = await openThenNotify(async () => { throw new Error('IPC が落ちた') })
    await finishOpen()
    expect(placementRow(), 'ディスクに記録があるのに、読み直しの例外で初回の読みまで捨てられた').toContain(S1022)
    expect(headline()).toBe('💾 データの保存（用意済み）')
  })

  it('★★★ i3. 知らせが続けて2回来て、どちらの読み直しも読めなくても、初回の読みが返れば保存場所の行が出る', async () => {
    prepared()
    const slowOpen = deferred()
    queue.placement.push(() => slowOpen.promise)
    render({ projectDir: A, target: 'sakura-apprun' })
    await settle()
    queue.placement.push(async () => ({ ok: false, placement: null, placements: [], message: '読めませんでした' }))
    queue.placement.push(async () => { throw new Error('IPC が落ちた') })
    fire('sakura-meta-changed')
    fire('sakura-meta-changed')
    await settle()
    slowOpen.resolve({ ok: true, placement: rec(S1022), placements: [rec(S1022)] })
    await settle()
    expect(placementRow()).toContain(S1022)
  })

  it('★★★ i4. 読み直しが先に当たったあと、遅れて返った初回の読み（古い値）は当たらない（c3 と同じ。読みの開始で世代を上げなくても、番号で捨てる）', async () => {
    const finishOpen = await openThenNotify(async () => ({ ok: true, placement: null, placements: [] }))
    expect(placementRow(), '読み直しの新しい値（記録なし）が当たっていない').toBeUndefined()
    await finishOpen()                                // 初回の読みが、古い値（記録あり）を返す
    expect(placementRow(), '遅れて返った初回の読みが、先に当たった読み直しを上書きした').toBeUndefined()
  })
})

// ── 知らせごとに、読むものと順序 ──────────────────────────────

describe('知らせごとに読む要求と、その順序', () => {
  it('★★★ e. sakura-meta-changed: storage.placement が storage.status より先。記録を当ててから一覧を読み、その間「見つかりません」が一瞬も出ない', async () => {
    prepared()
    await mount()
    calls = []
    seen = []
    const gate = deferred()
    disk.placement[A] = null
    disk.buckets = []
    queue.placement.push(() => gate.promise)
    fire('sakura-meta-changed')
    await settle()
    // 記録の読みが返るまで、一覧は読まない
    expect(calls).toEqual(['placement'])

    gate.resolve({ ok: true, placement: null, placements: [] })
    await settle()
    expect(calls).toEqual(['placement', 'status'])
    // 一覧を読みに行った時点で、記録は当たっている（行が消えている）
    const atStatus = seen.find(s => s.at === 'status')
    expect(atStatus, '一覧を読んだ時点の画面が残っていない').toBeDefined()
    expect(atStatus!.rows.some(t => t.startsWith('保存場所: ')), '記録を当てる前に一覧を読んだ').toBe(false)
    // 順序の途中のどの画面でも、もう無い記録に「見つかりません」を出さない
    expect(seen.some(s => warned(s.rows))).toBe(false)
    expect(warned()).toBe(false)
  })

  it('★★★ f. sakura:storage-buckets-changed（設定で保存場所を作った）: storage.placement は呼ばず、一覧だけ読み直す', async () => {
    prepared()
    await mount()
    calls = []
    disk.buckets = [S1022, 'koto-rc-s1023']
    fire('sakura:storage-buckets-changed')
    await settle()
    expect(calls).toEqual(['status'])
    // 記録の行は変わらない
    expect(placementRow()).toContain(S1022)
  })
})

// ── 判定（純関数）と、画面の注意 ───────────────────────────────

/** 一覧を読めた状態（loaded・利用開始済み）を作る。 */
const listed = (buckets: string[], over: Partial<BucketListState> = {}): BucketListState =>
  ({ ...emptyBucketList(), buckets, loaded: true, siteReady: true, ...over })

describe('placementMissing: 記録にあるが一覧に無いか', () => {
  it('★★★ g1. 読めた0件の一覧＋記録あり → true（実機の場合。0件でも「無い」と確かめられている）', () => {
    expect(placementMissing(S1022, listed([]))).toBe(true)
  })
  it('★★★ g2. 一度も読めていない（空の初期値）→ false（空でも「無い」と確かめていない）。利用開始済みと見えても、読めていなければ言わない', () => {
    expect(placementMissing(S1022, emptyBucketList())).toBe(false)
    expect(placementMissing(S1022, { ...emptyBucketList(), siteReady: true })).toBe(false)
  })
  it('★★★ g3. 読み直しが失敗したまま（listFailed）→ false（古い一覧で言わない）。読めたあとの失敗でも同じ', () => {
    expect(placementMissing(S1022, listed([], { listFailed: true, listError: 'x' }))).toBe(false)
    expect(placementMissing(S1022, listed(['other'], { listFailed: true, listError: 'x' }))).toBe(false)
  })
  it('★★ g4. 一覧にある → false', () => {
    expect(placementMissing(S1022, listed([S1022]))).toBe(false)
    expect(placementMissing(S1022, listed(['other', S1022]))).toBe(false)
  })
  it('★★ g5. 一覧が空でない・記録の名前だけ無い → true', () => {
    expect(placementMissing(S1022, listed(['other']))).toBe(true)
  })
  it('★★ g6. 記録なし（null・undefined・空文字）→ false', () => {
    expect(placementMissing(null, listed([]))).toBe(false)
    expect(placementMissing(undefined, listed([]))).toBe(false)
    expect(placementMissing('', listed([]))).toBe(false)
  })

  it('★★★ g7. 利用開始を確かめられていない（siteReady: false）の0件 → false（利用開始前と、問い合わせの失敗〔403・429・5xx〕が同じ0件で返るので、「無い」と言わない）', () => {
    expect(placementMissing(S1022, listed([], { siteReady: false }))).toBe(false)
    // 一覧が空でなくても、利用開始を確かめられていないなら言わない
    expect(placementMissing(S1022, listed(['other'], { siteReady: false }))).toBe(false)
  })
  it('★★ g8. 何も読んでいない最初の状態は siteReady: false', () => {
    expect(emptyBucketList().siteReady).toBe(false)
  })
})

describe('controller: 応答の siteReady を状態に入れる（true と確かめられたときだけ true）', () => {
  const stateAfter = async (reply: unknown): Promise<BucketListState> => {
    const c = createBucketListController({ status: async () => reply, recorded: () => '', onChange: () => {} })
    await c.reload()
    return c.get()
  }

  it('★★★ k1. { ok: true, siteReady: true, buckets: [] } → siteReady: true（読めて0件。placementMissing が言える）', async () => {
    const s = await stateAfter({ ok: true, siteReady: true, buckets: [] })
    expect(s).toMatchObject({ loaded: true, listFailed: false, siteReady: true, buckets: [] })
    expect(placementMissing(S1022, s)).toBe(true)
  })

  it('★★★ k2. { ok: true, siteReady: false, buckets: [] } → 読めた（loaded・失敗ではない）が siteReady: false。placementMissing は言わない・canPrepare は押せる（新しい利用者）', async () => {
    const s = await stateAfter({ ok: true, siteReady: false, buckets: [] })
    expect(s).toMatchObject({ loaded: true, listFailed: false, siteReady: false, buckets: [] })
    expect(placementMissing(S1022, s)).toBe(false)
    // 新しい利用者は本当に利用開始前。「用意する（利用開始の同意）」を押せなくしない
    expect(canPrepare(s, false)).toBe(true)
  })

  it('★★★ k3. siteReady が無い・true でない値（文字列・数値・null）→ siteReady: false（=== true だけを信じる）', async () => {
    for (const siteReady of [undefined, 'true', 1, null]) {
      const s = await stateAfter({ ok: true, siteReady, buckets: [] })
      expect(s.siteReady, `siteReady=${String(siteReady)}`).toBe(false)
      expect(s.loaded).toBe(true)
    }
  })

  it('★★ k4. 読めた応答のたびに入れ替わる（false → true で、あとから言えるようになる。true → false で言わなくなる）', async () => {
    const replies: unknown[] = [
      { ok: true, siteReady: false, buckets: [] },
      { ok: true, siteReady: true, buckets: [] },
      { ok: true, siteReady: false, buckets: [] },
    ]
    const c = createBucketListController({ status: async () => replies.shift(), recorded: () => '', onChange: () => {} })
    await c.reload()
    expect(placementMissing(S1022, c.get())).toBe(false)
    await c.reload()
    expect(placementMissing(S1022, c.get())).toBe(true)
    await c.reload()
    expect(placementMissing(S1022, c.get())).toBe(false)
  })
})

describe('部品の描画: 記録にある保存場所が見つからないときの黄色い注意', () => {
  it('★★★ h1. 読めた0件の一覧＋記録あり → 「⚠️ この保存場所は見つかりません」が出る', async () => {
    disk.placement[A] = rec(S1022)
    disk.buckets = []
    await mount()
    expect(placementRow()).toContain(S1022)
    expect(warned(), '一覧が0件のとき、注意が出ない（実機の欠陥 C2）').toBe(true)
  })

  it('★★ h2. 一覧にあれば出ない', async () => {
    prepared()
    await mount()
    expect(warned()).toBe(false)
  })

  it('★★ h3. 一覧を読めなかった（ok でない）ときは出さず、読めなかったことを知らせる', async () => {
    disk.placement[A] = rec(S1022)
    queue.status.push(async () => ({ ok: false, message: 'キーが未登録です' }), async () => ({ ok: false, message: 'キーが未登録です' }))
    await mount()
    expect(placementRow()).toContain(S1022)
    expect(warned()).toBe(false)
    expect(rows().some(t => t.includes('⚠️ 保存場所の一覧を確かめられませんでした。'))).toBe(true)
  })

  it('★★ h4. 設定の知らせで一覧が0件になったとき（記録は残っている）も出る', async () => {
    prepared()
    await mount()
    expect(warned()).toBe(false)
    disk.buckets = []
    fire('sakura:storage-buckets-changed')
    await settle()
    expect(warned()).toBe(true)
  })

  it('★★★ h5. 利用開始を確かめられない（siteReady: false の0件）＋記録あり → 「見つかりません」を出さない（一時的な失敗かもしれない）。読めなかった知らせも出ない（読めてはいる）', async () => {
    disk.placement[A] = rec(S1022)
    disk.siteReady = false     // 問い合わせが失敗して、一覧を引かずに0件で返る
    await mount()
    expect(placementRow()).toContain(S1022)
    expect(warned(), '利用開始を確かめられていないのに「見つかりません」と言った').toBe(false)
    expect(rows().some(t => t.includes('⚠️ 保存場所の一覧を確かめられませんでした。'))).toBe(false)
  })

  it('★★★ h6. h5 の問い合わせが直って、読み直しで siteReady: true の0件になれば、そのとき「見つかりません」が出る', async () => {
    disk.placement[A] = rec(S1022)
    disk.siteReady = false
    await mount()
    expect(warned()).toBe(false)
    disk.siteReady = true
    disk.buckets = []
    fire('sakura:storage-buckets-changed')
    await settle()
    expect(warned()).toBe(true)
  })

  it('★★★ h7. 新しい利用者（記録なし・利用開始前）は、「用意する（費用に同意）」を押せて、用意が呼ばれる（siteReady で押せなくしない）', async () => {
    disk.placement[A] = null
    disk.siteReady = false
    await mount()
    await click('保存場所を用意する…')
    await click('用意する（費用に同意）')
    expect(calls, '利用開始前の新しい利用者が、用意を押せなかった').toContain('prepare')
    expect(placementRow()).toContain('koto-new-bucket')
  })
})
