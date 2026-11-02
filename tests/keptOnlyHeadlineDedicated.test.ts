import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 0.6.25: 専有型の手順6の結果欄（DedicatedTeardownSection）も、見出しは TeardownResultView の1つの選びを通る ─────────────────────
// 偽の React の上で節を動かし、`view`（main が返した形から作る）を渡して、結果欄の見出しを見る（tests/dedicatedTeardownSection.test.ts と同じ作り）。
// 他の入口（【公開】共用型・HANAMII・プロジェクトの削除・📡 の3行）は tests/keptOnlyHeadline.test.ts。

vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())

import { RT } from './appRunPanelRt'
import DedicatedTeardownSection from '../src/renderer/components/DedicatedTeardownSection'
import { toTeardownView } from '../src/shared/teardownResult'

const DEDICATED = 'sakura-apprun-dedicated' as const
const FULL_RECORD = { clusterID: 'c-1', asgID: 'a-1', loadBalancerID: 'lb-1', applicationID: 'app-1', applicationName: 'myapp', activeVersion: 3, hosts: ['app.example.com'] }

const KEPT_ONLY_REPLY = {
  ok: true, executed: ['保存場所『koto-data-a』のデータは残しました — フォルダ『myapp copy』も同じデータを使っています。'],
  keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptBucketsUsedByOthers: ['koto-data-a'], keptOnly: true,
}
const KEPT_BUT_DELETED_REPLY = {
  ok: true, executed: ['クラスタ『c-1』を削除しました', '保存場所『koto-data-a』のデータは残しました'],
  keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptBucketsWithOwnFiles: ['koto-data-a'],
}
const ALL_GONE_REPLY = { ok: true, executed: ['クラスタ『c-1』を削除しました'] }

function installWindow() {
  const w: any = new EventTarget()
  w.electronAPI = {
    apprunDedicated: { state: async () => FULL_RECORD, teardown: async () => ({ ok: true }), onTeardownProgress: () => () => {} },
    cloud: { loadKey: async () => ({ token: 'tok', secret: 'sec' }) },
    storage: { placement: async () => ({ ok: true, placements: [] }) },
    fs: { readFile: async () => '{}', exists: async () => false },
    stageTiming: { estimates: async () => null },
    win: { setBusy: () => {} },
  }
  w.addEventListener = EventTarget.prototype.addEventListener.bind(w)
  w.removeEventListener = EventTarget.prototype.removeEventListener.bind(w)
  w.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(w)
  ;(globalThis as any).window = w
}

let opened: Array<{ close: () => void }> = []
beforeEach(() => { installWindow() })
afterEach(() => { for (const m of opened) m.close(); opened = []; delete (globalThis as any).window })

function mount(view: ReturnType<typeof toTeardownView> | null) {
  const props = {
    projectDir: '/tmp/proj-a', locked: false, showButton: false, tearingDown: false, running: false, runningRecord: null, nowMs: 0,
    apprunState: FULL_RECORD, appRecord: null, summaryLines: [], view, notes: [], onStart: () => {}, onDone: async () => {},
  }
  const inst = RT.mount(DedicatedTeardownSection as any, props)
  const v = { text: () => RT.textOf(RT.expand(inst.tree)), close: () => { RT.unmount(inst) } }
  opened.push(v)
  return v
}

describe('手順6の結果欄の見出し（専有型）', () => {
  it('★★★ keptOnly: 「⚠️ 削除していません」。「✅ すべて削除しました」「✅ 削除しました」は出ない。月額の警告は出る', () => {
    const t = mount(toTeardownView(DEDICATED, KEPT_ONLY_REPLY)).text()
    expect(t).toContain('⚠️ 削除していません')
    expect(t).not.toContain('すべて削除しました')
    expect(t).not.toContain('✅ 削除しました')
    expect(t).toContain('月額')
    expect(t).not.toContain('AIに相談する')
  })

  it('★★★ 保存場所を残し、ほかは消した回（keptOnly でない・理由は問わない）: 「✅ 削除しました」。「すべて」と言わない', () => {
    const t = mount(toTeardownView(DEDICATED, KEPT_BUT_DELETED_REPLY)).text()
    expect(t).toContain('✅ 削除しました')
    expect(t).not.toContain('すべて削除しました')
    expect(t).not.toContain('削除していません')
  })

  it('★★★ 何も残さず全部消えた回は「✅ すべて削除しました」のまま（dedicatedTeardownGolden.test.ts:380 の期待）', () => {
    const t = mount(toTeardownView(DEDICATED, ALL_GONE_REPLY)).text()
    expect(t).toContain('✅ すべて削除しました')
    expect(t).not.toContain('削除していません')
  })
})
