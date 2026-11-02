import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'

// ── 0.6.25: 手順6の節（components/DedicatedTeardownSection.tsx）の 💾 の行は、確認・赤い箱と同じ作り手（teardownDataNoteFor）を通る ──────────────────
// 保存場所の一覧の各要素（`keep` を持つもの）を、そのまま作り手へ渡す。`keep` のある保存場所は「残ります」と言い、「データも削除します」と言わない。
// ここで固定するのは「行の作り手が keep を見る」ことまで。節が keep を載せた一覧を読み込む処理（cloud:twinFacts を呼ぶ）は、ここでは固定しない。
// 偽の React と偽の window（storage.placement）は dedicatedTeardownSectionPlacements.test.ts と同じ。

vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())

import { RT } from './appRunPanelRt'
import DedicatedTeardownSection from '../src/renderer/components/DedicatedTeardownSection'

const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise<void>(r => setTimeout(r, 0)); await Promise.resolve() } }
const until = async (cond: () => boolean, what: string) => {
  for (let k = 0; k < 200 && !cond(); k++) await settle()
  expect(cond(), what).toBe(true)
}

let placements: unknown[]
let opened: Array<{ close: () => void }> = []

beforeEach(() => {
  placements = []
  const w: any = new EventTarget()
  w.electronAPI = {
    apprunDedicated: { onTeardownProgress: () => () => {} },
    storage: { placement: async () => ({ ok: true, placements }) },
  }
  w.addEventListener = EventTarget.prototype.addEventListener.bind(w)
  w.removeEventListener = EventTarget.prototype.removeEventListener.bind(w)
  w.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(w)
  ;(globalThis as any).window = w
})
afterEach(() => { for (const m of opened) m.close(); opened = []; delete (globalThis as any).window })

function mount(apprunState: Record<string, unknown> = { clusterID: 'c-1' }) {
  const props = {
    projectDir: '/tmp/proj-a', locked: false, showButton: true, tearingDown: false, running: false, runningRecord: null, nowMs: 0,
    apprunState, appRecord: null, summaryLines: [], view: null, notes: [], onStart: () => {}, onDone: async () => {},
  }
  const inst = RT.mount(DedicatedTeardownSection as any, props)
  const view = { text: () => RT.textOf(RT.expand(inst.tree)), close: () => { RT.unmount(inst) } }
  opened.push(view)
  return view
}

describe('手順6の 💾 の行: keep のある保存場所は「残ります」と言う', () => {
  it('★★★ keep のある保存場所の行は、確認と同じ文の作り手の「残ります（消すまで月額が続きます）」＋理由。「データも削除します」と言わない', async () => {
    placements = [{ bucket: 'koto-a', prefix: 'projects/myapp/', shared: true, keep: { risk: 'twin', folders: ['clone'] } }]
    const v = mount()
    await until(() => v.text().includes('koto-a'), '保存場所の行が出ない')
    expect(v.text()).toContain('💾 保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『clone』も同じデータを使っています。')
    expect(v.text()).not.toContain('にある、このプロジェクトのデータも削除します')
  })

  it('★★★ 保存場所が複数: keep のあるものは「残ります」、無いものは今までどおり「データも削除します」。1件ずつ別の行', async () => {
    placements = [
      { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true, keep: { risk: 'unread', folders: [] } },
      { bucket: 'koto-b', prefix: 'projects/myapp/', shared: false },
    ]
    const v = mount()
    await until(() => v.text().includes('koto-b'), '保存場所の行が出ない')
    const t = v.text()
    expect(t).toContain('💾 保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。')
    expect(t).toContain('💾 保存場所『koto-b』にある、このプロジェクトのデータも削除します。')
    expect(t).not.toContain('保存場所『koto-a』にある、このプロジェクトのデータも削除します')
  })

  it('★★ 対照: keep の無い保存場所は今までどおり（keep: null も同じ）', async () => {
    placements = [{ bucket: 'koto-a', prefix: 'projects/myapp/', shared: true, keep: null }]
    const v = mount()
    await until(() => v.text().includes('koto-a'), '保存場所の行が出ない')
    expect(v.text()).toContain('💾 保存場所『koto-a』にある、このプロジェクトのデータも削除します。')
    expect(v.text()).not.toContain('は残ります（消すまで月額が続きます）')
  })
})

// ── 🗄️「保存場所だけが残っています…もう一度押すと削除します」の行も、keep の保存場所を「削除します」と言わない ───────────────────────────
// 💾 の行が「残ります」と言う保存場所を、同じ節の 🗄️ の行が「もう一度押すと削除します」と言うと、1つの画面が正反対のことを言う。
// 🗄️ の行は、消す保存場所（keep の無いもの）の名前だけで作る。全部 keep なら出さない（💾 の行が言う）。期待の文は書き下す。

const LEFT_A = { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a'] }
const LEFT_AB = { storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a', 'koto-b'] }
const KEEP_A = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true, keep: { risk: 'twin', folders: ['clone'] } }
const PLAIN_B = { bucket: 'koto-b', prefix: 'projects/myapp/', shared: false }

describe('手順6の 🗄️ の行: keep の保存場所に「もう一度押すと削除します」と言わない', () => {
  it('★★★ 保存場所だけが残り、全部 keep: 🗄️ の行は出ない。💾 の行が「残ります」と言い、「削除します」は出ない', async () => {
    placements = [KEEP_A]
    const v = mount(LEFT_A)
    await until(() => v.text().includes('💾'), '保存場所の行が出ない')
    const t = v.text()
    expect(t).toContain('💾 保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『clone』も同じデータを使っています。')
    expect(t).not.toContain('🗄️')
    expect(t).not.toContain('もう一度押すと削除します')
    expect(t).not.toContain('だけが残っています')
  })

  it('★★★ 一部だけ keep: 🗄️ の行は消す保存場所 B の名前だけ。A は 💾 の行が「残ります」と言い、B は 🗄️ と 💾 が消すと言う', async () => {
    placements = [KEEP_A, PLAIN_B]
    const v = mount(LEFT_AB)
    await until(() => v.text().includes('💾 保存場所『koto-b』'), '保存場所の行が出ない')
    const t = v.text()
    expect(t).toContain('🗄️ 保存場所『koto-b』だけが残っています（消すまで月額が続きます）。もう一度押すと削除します。')
    expect(t).not.toContain('『koto-a』『koto-b』だけが残っています')
    expect(t).not.toContain('『koto-a』だけが残っています')
    expect(t).toContain('💾 保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『clone』も同じデータを使っています。')
    expect(t).toContain('💾 保存場所『koto-b』にある、このプロジェクトのデータも削除します。')
  })

  it('★★ 対照: keep の無い保存場所だけが残った回は、今までどおり 🗄️ の行が全件を言う（keep: null も同じ）', async () => {
    placements = [{ ...KEEP_A, keep: null }, PLAIN_B]
    const v = mount(LEFT_AB)
    await until(() => v.text().includes('💾 保存場所『koto-b』'), '保存場所の行が出ない')
    expect(v.text()).toContain('🗄️ 保存場所『koto-a』『koto-b』だけが残っています（消すまで月額が続きます）。もう一度押すと削除します。')
  })

  it('★★ 保存場所の一覧に載っていない名前（env.json に無い）は、消す側のまま 🗄️ の行が言う', async () => {
    placements = [KEEP_A]
    const v = mount(LEFT_AB)
    await until(() => v.text().includes('💾 保存場所『koto-a』'), '保存場所の行が出ない')
    expect(v.text()).toContain('🗄️ 保存場所『koto-b』だけが残っています（消すまで月額が続きます）。もう一度押すと削除します。')
  })
})
