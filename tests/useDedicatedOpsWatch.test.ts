import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階3B（3B-6a）: 専有型パネルの記録の見張りのフック（hooks/useDedicatedOpsWatch.ts）──────────────────────────
// 設計書: docs/teardown-unify-plan.md の 10.11.10・10.11.20 の K（K=1）。AppRunDedicatedPanel.tsx の見張りの effect を、**振る舞いを変えずに**ここへ移した。
// 見張りそのもの（読む・押し出しを受ける・ack の範囲・別の公開先を巻き込まない）は tests/ops-dedicated-resume.test.ts が本物の main の記録の上で固定している。
// ここは、**フックが見張りを正しく付け外しし、パネルへ渡す2つの口（走っているもの・結果が届いたとき）を通している**ことを、
// 偽の React の上で、本物の main の記録（projectOps.ts・withProjectLock）に流して確かめる（文字列は読まない。掟10）。
//
//   ・付けると、走っているものが opsRunning に出る。外す（アンマウント）と購読が解け、何も届かない
//   ・閉じている間に終わった結果は、1回だけ onFinished へ渡り、知らせ（resumedNotes）に集まり、開いている画面へ 'sakura-meta-changed' が飛ぶ。見た印（ack）は渡したあと
//   ・隠れているタブ（panelVisible:false）は、渡しても ack しない。また出たら ack する
//   ・プロジェクトが切り替わったら、前の見張りを外して新しく付け、表示（走っているもの・知らせ）を持ち越さない（掟11）
//   ・この画面が始めた操作（opsWatchRef.beginLocal）の結果は、出し終える（endLocal）まで渡さず・ack しない
//   ・結果の置き場（onFinished）は最新のものを使う（付け直さずに差し替わる）

vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())

import { RT } from './appRunPanelRt'
import { useDedicatedOpsWatch } from '../src/renderer/hooks/useDedicatedOpsWatch'
import type { DedicatedFinished, DedicatedOpKind } from '../src/renderer/apprunDedicatedActions'
import { withProjectLock } from '../src/main/projectLock'
import { getOps, ackOps, setProjectOpsListener, resetProjectOpsForTests } from '../src/main/projectOps'

const DIR = '/tmp/koto-ops-watch-hook-a'
const OTHER_DIR = '/tmp/koto-ops-watch-hook-b'

type Push = { projectDir: string } & ProjectOpsSnapshotShape

let subs: Set<(p: Push) => void>
let acks: Array<[string, number | undefined]>
let metaChanged: number
/** 設定すると、その間 projectOps.get の応答を止める（開いた直後・切り替えた直後の「読み終える前」を見る）。 */
let holdGet: Promise<void> | null
let opened: Array<{ close: () => void }> = []

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(r => setTimeout(r, 0)) }

const HANDLER: Record<DedicatedOpKind, { op: '作成' | '削除' | '公開'; handler: string }> = {
  create: { op: '作成', handler: 'apprunDedicated:create' },
  teardown: { op: '削除', handler: 'apprunDedicated:teardown' },
  publish: { op: '公開', handler: 'apprunDedicated:publishApp' },
}
/** main の操作を1つ走らせる（本物の withProjectLock）。`release()` するまで終わらない。 */
function startOp(kind: DedicatedOpKind, result: unknown, dir = DIR) {
  let release!: () => void
  const gate = new Promise<void>(open => { release = open })
  const { op, handler } = HANDLER[kind]
  const done = withProjectLock(dir, op, async () => { await gate; return result }, { target: 'sakura-apprun-dedicated', handler })
  return { release, done }
}
async function finish(op: { release: () => void; done: Promise<unknown> }) { op.release(); await op.done }
const TEARDOWN_OK = { ok: true, executed: ['クラスタ『c-1』を削除しました'], message: '', remaining: {} }

beforeEach(() => {
  resetProjectOpsForTests()
  subs = new Set(); acks = []; metaChanged = 0; holdGet = null
  setProjectOpsListener((projectDir, snapshot) => { for (const cb of [...subs]) cb({ projectDir, ...snapshot }) })
  const w: any = new EventTarget()
  w.electronAPI = {
    projectOps: {
      get: async (dir: string) => { if (holdGet && dir === OTHER_DIR) await holdGet; return getOps(dir) },
      ack: async (dir: string, upTo?: number) => { acks.push([dir, upTo]); return { ok: true, acked: ackOps(dir, upTo) } },
      onChanged: (cb: (p: Push) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
    },
  }
  w.addEventListener = EventTarget.prototype.addEventListener.bind(w)
  w.removeEventListener = EventTarget.prototype.removeEventListener.bind(w)
  w.dispatchEvent = (e: any) => { if (e?.type === 'sakura-meta-changed') metaChanged++; return EventTarget.prototype.dispatchEvent.call(w, e) }
  ;(globalThis as any).window = w
})
afterEach(() => {
  for (const m of opened) m.close()
  opened = []
  setProjectOpsListener(null)
  delete (globalThis as any).window
})

type Sink = { latest: ReturnType<typeof useDedicatedOpsWatch> | null }
/** フックだけを呼ぶ小さな部品を開く（画面は作らない）。 */
function mount(over: { projectDir?: string; panelVisible?: boolean; onFinished?: (f: DedicatedFinished[]) => void } = {}) {
  const sink: Sink = { latest: null }
  const delivered: DedicatedFinished[][] = []
  const Probe = (p: { projectDir: string; panelVisible: boolean; onFinished: (f: DedicatedFinished[]) => void }) => {
    sink.latest = useDedicatedOpsWatch(p.projectDir, p.panelVisible, p.onFinished)
    return null
  }
  const props = { projectDir: DIR, panelVisible: true, onFinished: (f: DedicatedFinished[]) => { delivered.push(f) }, ...over }
  const inst = RT.mount(Probe as any, props)
  const view = {
    sink, delivered,
    now: () => sink.latest!,
    setProps: (next: Partial<typeof props>) => { RT.setProps(inst, { ...inst.props, ...next }) },
    close: () => { RT.unmount(inst) },
  }
  opened.push(view)
  return view
}

describe('見張りの付け外し', () => {
  it('★★ 付けると、走っているものが opsRunning に出る。外す（アンマウント）と購読が解け、見張りの ref も空になる', async () => {
    const op = startOp('teardown', TEARDOWN_OK)
    const v = mount()
    await flush()
    expect(v.now().opsRunning.running?.kind).toBe('teardown')
    expect(v.now().opsRunning.other).toBeNull()
    expect(subs.size, '押し出しを受けていない').toBe(1)
    expect(v.now().opsWatchRef.current, '見張りが付いていない').not.toBeNull()
    const ref = v.now().opsWatchRef
    v.close()
    expect(subs.size, '外したのに購読が残っている').toBe(0)
    expect(ref.current, '外したのに見張りの ref が残っている').toBeNull()
    await finish(op)
  })

  it('★★ 閉じている間に終わった結果は、1回だけ onFinished へ渡り、知らせに集まり、開いている画面へ知らせが飛ぶ。渡したあとで ack する', async () => {
    const op = startOp('teardown', { ...TEARDOWN_OK, warnings: ['⚠️ 保存場所『koto-data-x』を片づけられませんでした'] })
    await finish(op)
    const v = mount()
    await flush()
    expect(v.delivered.length, '終わった結果が渡らない').toBe(1)
    expect(v.delivered[0].map(f => f.kind)).toEqual(['teardown'])
    expect(metaChanged, '記録が変わったことを開いている画面へ知らせていない').toBe(1)
    const notes = v.now().resumedNotes
    expect(notes.teardown.length).toBe(1)
    // V8（3B-6b）: パネルの知らせの見出しは、共通の「🔔 削除の結果」。入口の名前（手順6）は言わない
    expect(notes.teardown[0].headline).toMatch(/^🔔 削除の結果/)
    expect(notes.teardown[0].headline).not.toContain('手順6')
    expect(notes.create).toEqual([])
    expect(notes.publish).toEqual([])
    // 警告つきの記録は ack されず残る（月額が続く警告を見逃させない。ackUpToFor が止める）
    expect(acks).toEqual([])
    // 同じ記録を、もう一度渡さない（読み直しが来ても）
    v.now().opsWatchRef.current!.refresh()
    await flush()
    expect(v.delivered.length).toBe(1)
    expect(notes.teardown.length).toBe(1)
  })

  it('★★ 警告のない結果は、画面へ渡したあとで ack される（見た印）。ack は自分のプロジェクトの記録に対して', async () => {
    await finish(startOp('teardown', TEARDOWN_OK))
    const v = mount()
    await flush()
    expect(v.delivered.length).toBe(1)
    expect(acks.length, 'ack が1回だけ').toBe(1)
    expect(acks[0][0]).toBe(DIR)
    // 渡したあとに ack する（見せる前に「見た」にしない）
    expect(v.delivered.length).toBeGreaterThan(0)
  })

  it('★★★ 隠れているタブ（panelVisible:false）は、結果を渡しても ack しない。また出たら（panelVisible:true）ack する', async () => {
    await finish(startOp('teardown', TEARDOWN_OK))
    const v = mount({ panelVisible: false })
    await flush()
    expect(v.delivered.length, '隠れていても結果は画面へ渡る').toBe(1)
    expect(acks, '隠れているタブが「見た」と伝えた').toEqual([])
    v.setProps({ panelVisible: true })
    await flush()
    expect(acks.length, 'また出たのに ack しない').toBe(1)
    expect(acks[0][0]).toBe(DIR)
  })

  it('★★ 結果の置き場（onFinished）は最新のものを使う（付け直さずに差し替わる）', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const v = mount({ onFinished: first })
    await flush()
    v.setProps({ onFinished: second })
    await finish(startOp('create', { ok: true, stage: 'done', message: '' }))
    await flush()
    expect(first, '古い置き場へ渡した').not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect((second.mock.calls[0][0] as DedicatedFinished[]).map(f => f.kind)).toEqual(['create'])
    expect(subs.size, '置き場を替えただけで付け直している').toBe(1)
  })
})

describe('プロジェクトの切り替え（掟11）', () => {
  it('★★★ 切り替えたら前の見張りを外して新しく付け、走っているもの・知らせを持ち越さない。前のプロジェクトの結果は新しい画面へ入らない', async () => {
    // DIR: 終わった削除（警告つき＝ack されず残る）と、走っている作成。OTHER_DIR: 終わった公開
    await finish(startOp('teardown', { ...TEARDOWN_OK, warnings: ['⚠️ 保存場所『koto-data-x』を片づけられませんでした'] }, DIR))
    const running = startOp('create', { ok: true, stage: 'done', message: '' }, DIR)
    await finish(startOp('publish', { ok: true, stage: 'done', message: '' }, OTHER_DIR))
    const v = mount({ projectDir: DIR })
    await flush()
    expect(v.now().opsRunning.running?.kind).toBe('create')
    expect(v.now().resumedNotes.teardown.length, '前提: DIR の知らせが出ている').toBe(1)
    expect(v.delivered.flat().map(f => f.kind)).toEqual(['teardown'])
    const firstRef = v.now().opsWatchRef.current
    let open!: () => void
    holdGet = new Promise<void>(r => { open = r })
    v.setProps({ projectDir: OTHER_DIR })
    await Promise.resolve(); await Promise.resolve() // 状態の更新による描き直し（マイクロタスク）だけを待つ。記録の応答（holdGet）はまだ止めてある
    // 新しいプロジェクトの記録を読み終える前から、前のプロジェクトの表示は持ち越さない
    expect(v.now().opsRunning.running, '読み終える前に、前のプロジェクトの「走っている」が残っている').toBeNull()
    expect(v.now().resumedNotes.teardown, '読み終える前に、前のプロジェクトの知らせが残っている').toEqual([])
    open()
    await flush()
    expect(subs.size, '前の見張りが残っている（購読が2つ）').toBe(1)
    expect(v.now().opsWatchRef.current, '見張りが付け直されていない').not.toBe(firstRef)
    // 新しいプロジェクトの終わった結果は渡る（手順8の公開）。前のプロジェクトの結果は混ざらない
    expect(v.delivered.flat().map(f => f.kind)).toEqual(['teardown', 'publish'])
    expect(v.now().resumedNotes.teardown, '前のプロジェクトの知らせが戻った').toEqual([])
    expect(v.now().resumedNotes.publish.length).toBe(1)
    await finish(running)
    await flush()
    expect(v.delivered.flat().map(f => f.kind), '前のプロジェクトの終わりが新しい画面へ届いた').toEqual(['teardown', 'publish'])
  })
})

describe('この画面が始めた操作（opsWatchRef の beginLocal・endLocal）', () => {
  it('★★★ beginLocal した種類の結果は、endLocal するまで渡さず・ack しない。endLocal すると ack される（出し終える前に閉じたら、開き直して記録から出せる）', async () => {
    const v = mount()
    await flush()
    v.now().opsWatchRef.current!.beginLocal('teardown')
    const op = startOp('teardown', TEARDOWN_OK)
    await flush()
    await finish(op)
    await flush()
    expect(v.delivered, 'この画面が自分の返り値から出す結果を、記録から二重に渡した').toEqual([])
    expect(acks, '出し終える前に ack した').toEqual([])
    v.now().opsWatchRef.current!.endLocal('teardown')
    await flush()
    expect(acks.length, '出し終えたのに ack しない').toBe(1)
    expect(v.delivered, 'endLocal のあとも二重に渡さない').toEqual([])
  })

  it('★★ 手順5・6・8のどれも、同じ窓を通る（beginLocal した種類だけ止まり、ほかの種類の結果は渡る）', async () => {
    const v = mount()
    await flush()
    v.now().opsWatchRef.current!.beginLocal('create')
    await finish(startOp('create', { ok: true, stage: 'done', message: '' }))
    await finish(startOp('publish', { ok: true, stage: 'done', message: '' }))
    await flush()
    expect(v.delivered.flat().map(f => f.kind), '作成だけが止まり、公開は渡る').toEqual(['publish'])
  })
})

describe('フックの前提', () => {
  it('★ フックの本体は 150 行以下で、パネル本体（AppRunDedicatedPanel）を import しない（巨大ファイルの決まり・循環を作らない）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer/hooks/useDedicatedOpsWatch.ts'), 'utf-8')
    expect(src.split('\n').length).toBeLessThanOrEqual(150)
    expect(src).not.toMatch(/from\s+['"][^'"]*AppRunDedicatedPanel['"]/)
  })
})
