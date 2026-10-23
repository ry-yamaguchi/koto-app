import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 段階3B（3B-6a）: 手順6の節（components/DedicatedTeardownSection.tsx）の「保存場所の読み込み」──────────────────────────
// 設計書: docs/teardown-unify-plan.md の 10.11.9（D1 手順6）の1。保存場所の一覧の読み込み（placements の state と effect）は、パネルから節へ移した。
// 節の確認 → 実行・二重押し・stale・進み具合は tests/dedicatedTeardownSection.test.ts が固定している（そのファイルは F-6 の400行の上限に近いので、別ファイル）。
// ここは、💾 の行（消える保存場所の名指し）が**消すものを取り違えない**ことを、偽の React と偽の window（storage.placement）で確かめる:
//   ・プロジェクトが切り替わったら、新しいプロジェクトの保存場所を読み直す。古い問い合わせの遅い答えは、新しい表示を上書きしない
//   ・古い形（placement が1件だけ）しか返らなくても、その1件を名指しする（黙って0件にして、消えるものを隠さない）
// 再検分（3B-6a）で、`[projectDir]` の依存・`alive` の見張り・古い形への道のどれを外しても、既存のテストが全部緑のままだったので足した。

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

let placementImpl: (dir: string) => Promise<unknown>
let opened: Array<{ close: () => void }> = []

beforeEach(() => {
  placementImpl = async () => ({ ok: true, placements: [] })
  const w: any = new EventTarget()
  w.electronAPI = {
    apprunDedicated: { onTeardownProgress: () => () => {} },
    storage: { placement: (dir: string) => placementImpl(dir) },
  }
  w.addEventListener = EventTarget.prototype.addEventListener.bind(w)
  w.removeEventListener = EventTarget.prototype.removeEventListener.bind(w)
  w.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(w)
  ;(globalThis as any).window = w
})
afterEach(() => { for (const m of opened) m.close(); opened = []; delete (globalThis as any).window })

function mount(projectDir: string) {
  const props = {
    projectDir, locked: false, showButton: true, tearingDown: false, running: false, runningRecord: null, nowMs: 0,
    apprunState: { clusterID: 'c-1' }, appRecord: null, summaryLines: [], view: null, notes: [], onStart: () => {}, onDone: async () => {},
  }
  const inst = RT.mount(DedicatedTeardownSection as any, props)
  const view = {
    text: () => RT.textOf(RT.expand(inst.tree)),
    setProjectDir: (dir: string) => { RT.setProps(inst, { ...inst.props, projectDir: dir }) },
    close: () => { RT.unmount(inst) },
  }
  opened.push(view)
  return view
}

describe('手順6の節: 保存場所の読み込み（💾 の行）', () => {
  it('★★ プロジェクトが切り替わったら、新しいプロジェクトの保存場所を読み直す。古い問い合わせの遅い答えは、新しい表示を上書きしない', async () => {
    const bucketOf: Record<string, string> = { '/tmp/proj-a': 'koto-data-of-a', '/tmp/proj-b': 'koto-data-of-b' }
    const asked: string[] = []
    let releaseA!: () => void
    const heldA = new Promise<void>(r => { releaseA = r })
    placementImpl = async (dir: string) => {
      asked.push(dir)
      if (dir === '/tmp/proj-a') await heldA // A の答えは、B へ切り替えたあとに遅れて届く
      return { ok: true, placements: [{ bucket: bucketOf[dir], prefix: 'projects/x/', shared: true }] }
    }
    const v = mount('/tmp/proj-a')
    await settle()
    expect(asked).toEqual(['/tmp/proj-a'])
    v.setProjectDir('/tmp/proj-b')
    await until(() => v.text().includes('koto-data-of-b'), '切り替えたのに、新しいプロジェクトの保存場所を読み直さない')
    expect(asked, '切り替えたプロジェクトの保存場所を問い合わせていない').toEqual(['/tmp/proj-a', '/tmp/proj-b'])
    releaseA() // 古い問い合わせの答えが、いま届く
    await settle(); await settle()
    expect(v.text(), '古いプロジェクトの保存場所が新しい画面に出た（消すものを取り違える）').not.toContain('koto-data-of-a')
    expect(v.text()).toContain('koto-data-of-b')
  })

  it('★ 古い形（placement が1件だけ・placements なし）しか返らなくても、その1件を💾で名指しする（黙って0件にしない）', async () => {
    placementImpl = async () => ({ ok: true, placement: { bucket: 'koto-data-old-shape', prefix: 'projects/x/', shared: false } })
    const v = mount('/tmp/proj-a')
    await until(() => v.text().includes('koto-data-old-shape'), '古い形の保存場所が出ない（消えるものが隠れる）')
    expect(v.text()).toContain('💾')
  })

  it('★ 読めなかった回（ok:false・例外）は、💾 の行を出さずに画面は動き続ける（読めなくても削除そのものはできる）', async () => {
    placementImpl = async () => ({ ok: false })
    const a = mount('/tmp/proj-a')
    await settle(); await settle()
    expect(a.text()).not.toContain('💾')
    expect(a.text()).toContain('すべて削除する')
    placementImpl = async () => { throw new Error('読めない') }
    const b = mount('/tmp/proj-b')
    await settle(); await settle()
    expect(b.text()).not.toContain('💾')
    expect(b.text()).toContain('すべて削除する')
  })
})
