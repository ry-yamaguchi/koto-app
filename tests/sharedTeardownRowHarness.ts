// 一覧の共用型（さくらのAppRun）の行（TeardownRow）を、本物の流れ・本物の main（cloud:teardown・cloud:teardownRecord）・偽の client・偽の保存場所に通すテストの共通の道具。
// 使うテスト: tests/sharedTeardownRow.test.ts・tests/sharedTeardownRowStates.test.ts（段階2の2b-2・設計書 docs/teardown-unify-plan.md の 10.7.12 の E）。
// 手本: tests/hanamiiRowHarness.ts（HANAMII の行）。main 側の偽（client・保存場所・鍵）は tests/sharedTeardownHarness.ts。
//
// vi.mock（react・electron・auth・storageAdapter・client）と vi.hoisted の入れ物（rt）は、テストのファイルの先頭に置く
// （vi.mock はそのファイルの中でしか巻き上げられないため）。ここは、その入れ物を受け取って、窓・記録・行の取り付けを組み立てる。

import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { getOps, ackOps, setProjectOpsListener, resetProjectOpsForTests } from '../src/main/projectOps'
import TeardownRow from '../src/renderer/components/teardown/TeardownRow'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import type { TeardownFlowOutcome } from '../src/renderer/teardown/useTeardownFlow'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import type { PublishedEntry } from '../src/renderer/publishedIndex'
import type { RowRt } from './hanamiiRowHarness'
import { h, resetHarness, newProjectDir, setup as setupProject, writePublishRecord, A, APP, bucketRef, REGISTRY_ROW } from './sharedTeardownHarness'
import type { ResourceRef } from '../src/main/cloud/state'
import type { EnvState } from '../src/main/cloud/state'

export type { RowRt }
export const KEY_MISSING = 'さくらのクラウドのAPIキーが未登録です（テスト）'
export const CLOSE_WARNING_CALL = [true, 'さくらのAppRun の破棄', true, 'さくらのAppRun の破棄', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel]
export const tick = async () => { for (let k = 0; k < 6; k++) await new Promise<void>(r => setTimeout(r, 0)) }
export const holdGate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { p, open } }

export async function until(cond: () => boolean, what: string) {
  for (let k = 0; k < 400 && !cond(); k++) await tick()
  expect(cond(), what).toBe(true)
}

export type Win = {
  busy: unknown[][]
  dispatched: string[]
  acks: Array<[string, number | undefined]>
  /** 画面から公開の記録に触れた回数（publishMeta の口）。画面は記録を消さない（消すのは main の1か所）。 */
  publishMetaCalls: unknown[][]
  /** 共通の読み口（storage:placement）を呼んだ回数。共用型の仕様書は呼ばない（main の記録の placements を使う）。 */
  commonPlacementReads: number
}

export type ProjectOpts = {
  /** env.json の同意済みの保存場所。 */
  env?: string[]
  /** state.json の資源。 */
  resources?: ResourceRef[]
  meta?: EnvState['meta']
  /** 公開の記録（.sakuraide.json）の全体。省略すると共用型の行（publish.targets['sakura-apprun']）だけ。 */
  publish?: Record<string, unknown>
}

export function createSharedRowHarness(rt: RowRt) {
  registerCloudHandlers({} as any)
  const mainTeardown = h.handlers.get('cloud:teardown')!
  const mainRecord = h.handlers.get('cloud:teardownRecord')!
  let dir = ''
  let win!: Win

  const metaFile = () => path.join(dir, '.sakuraide.json')
  const readMeta = (): any => JSON.parse(fs.readFileSync(metaFile(), 'utf-8'))
  const SHARED_ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' }

  /** プロジェクトの置き方（既定: 保存場所 A・アプリ・A の bucket、公開の記録に共用型の行）。 */
  function writeProject(o: ProjectOpts = {}) {
    setupProject(dir, { env: o.env ?? [A], resources: o.resources ?? [APP, bucketRef(A)], ...(o.meta ? { meta: o.meta } : {}) })
    if (o.publish) fs.writeFileSync(metaFile(), JSON.stringify({ name: 'myapp', publish: o.publish }, null, 2), 'utf-8')
    else writePublishRecord(dir, { 'sakura-apprun': SHARED_ROW })
  }

  function installWindow() {
    win = { busy: [], dispatched: [], acks: [], publishMetaCalls: [], commonPlacementReads: 0 }
    const subs = new Set<(p: any) => void>()
    setProjectOpsListener((projectDir, snapshot) => { for (const cb of [...subs]) cb({ projectDir, ...snapshot }) })
    ;(globalThis as any).window = {
      electronAPI: {
        // 本物の main のハンドラ（preload の素通しと同じ形）。
        cloud: {
          teardownRecord: (d: string) => mainRecord({}, d),
          teardown: (d: string, auth: unknown, opts: unknown) => mainTeardown({}, d, auth, opts),
        },
        // exists: 確認の「ほかの公開先」が旧い共用型の記録（.sakura-cloud/state.json）の有無を見る（D9=2）。実ファイルの有無をそのまま返す。
        fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
        // 共用型の仕様書は呼ばない（呼んだら数える）。
        storage: { placement: async () => { win.commonPlacementReads++; return { ok: true, placements: [] } } },
        stageTiming: { estimates: async () => null },
        win: { setBusy: (...a: unknown[]) => { win.busy.push(a) } },
        projectOps: {
          get: async (d: string) => getOps(d),
          ack: async (d: string, upTo?: number) => { win.acks.push([d, upTo]); return { ok: true, acked: ackOps(d, upTo) } },
          onChanged: (cb: (p: any) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
        },
        // 画面が公開の記録に触れたら数える（触れてはいけない）。
        publishMeta: new Proxy({}, { get: (_t, key) => (...a: unknown[]) => { win.publishMetaCalls.push([String(key), ...a]); return Promise.resolve({ ok: true, meta: {} }) } }),
      },
      dispatchEvent: (e: { type: string }) => { win.dispatched.push(e.type); return true },
      setInterval: () => 1,
      clearInterval: () => {},
    }
  }

  /** beforeEach: 一時フォルダにプロジェクトを置き、偽の client・保存場所と窓を立てる。 */
  function setup(o: ProjectOpts = {}) {
    resetProjectOpsForTests()
    resetHarness()
    h.registryRows = [REGISTRY_ROW]
    dir = newProjectDir()
    writeProject(o)
    installWindow()
  }
  /** afterEach */
  function cleanup() {
    fs.rmSync(dir, { recursive: true, force: true })
    delete (globalThis as any).window
    rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.rerender = () => {}
  }

  // ── React の小さな代役の上で行を動かす ──
  function flushEffects() {
    const todo = rt.queue; rt.queue = []
    for (const q of todo) {
      const prev = rt.effects[q.idx]
      if (prev && typeof prev.cleanup === 'function') prev.cleanup()
      const slot: { deps?: readonly unknown[]; cleanup?: void | (() => void) } = { deps: q.deps }
      rt.effects[q.idx] = slot
      slot.cleanup = q.fn()
    }
  }
  function unmountAll() {
    for (const e of rt.effects) if (e && typeof e.cleanup === 'function') e.cleanup()
    rt.effects = []
    rt.rerender = () => {}
  }

  const entryOf = (): PublishedEntry => ({
    dir, projectName: 'myapp', target: 'sakura-apprun', label: '📦 さくらのAppRun', url: 'https://myapp.example.test',
    publishedAt: '2026-09-29T00:00:00.000Z', dateUnknown: false, hanamiiProjectId: null, registryName: null,
  } as PublishedEntry)

  /** 一覧が共用型の行に渡すのと同じ props で、行（TeardownRow）を動かす。 */
  function mountRow(over: { blocked?: boolean } = {}) {
    rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.r = 0; rt.e = 0
    const busy: boolean[] = []
    const outcomes: Array<{ entry: PublishedEntry; outcome: TeardownFlowOutcome }> = []
    const finished: number[] = []
    const entry = entryOf()
    let element: any
    let parts: any
    const render = () => {
      rt.i = 0; rt.r = 0; rt.e = 0; rt.queue = []
      element = TeardownRow({
        spec: sharedTeardownSpec, entry, keyMissingMessage: KEY_MISSING, blocked: over.blocked ?? false,
        onBusyChange: b => { busy.push(b) },
        onOutcome: (e, o) => { outcomes.push({ entry: e, outcome: o }) },
        onFinished: () => { finished.push(outcomes.length) },
        render: p => { parts = p; return 'ROW' as any },
      })
      flushEffects()
    }
    rt.rerender = render
    render()
    return {
      get parts() { return parts },
      get confirm() { return element?.props?.children?.[1] },
      entry, busy, outcomes, finished,
      unmount: unmountAll,
    }
  }
  type Mounted = ReturnType<typeof mountRow>

  /** 🗑 を押して、確認ダイアログが開くまで待つ。開いた確認の props を返す。 */
  async function pressAndWaitConfirm(m: Mounted) {
    m.parts.button.props.onClick()
    await until(() => !!m.confirm?.props?.open, '確認ダイアログが行に描かれない')
    expect(m.confirm.props.danger).toBe(true)
    return m.confirm.props
  }
  /** 🗑 を押して、確認に「破棄する」と答える（選択は触らない＝既定のまま）。 */
  async function pressAndConfirm(m: Mounted) {
    const props = await pressAndWaitConfirm(m)
    props.onConfirm()
    return props
  }

  return {
    setup, cleanup, mountRow, pressAndWaitConfirm, pressAndConfirm, writeProject, readMeta, metaFile,
    get dir() { return dir },
    get win() { return win },
    mainTeardown: (opts: unknown) => mainTeardown({}, dir, { heldByMain: true }, opts),
    /** 公開の記録（.sakuraide.json）の publish.targets の公開先の名前。 */
    publishedTargets: (): string[] => Object.keys(readMeta().publish?.targets ?? {}),
  }
}
