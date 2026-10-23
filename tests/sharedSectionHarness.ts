// 【公開】(AppRunPanel) の「🗑 破棄する（削除）」(S1・S2) を、本物の画面（偽の React の上）・本物の流れ・本物の main（cloud:teardown・cloud:teardownRecord）・
// 偽の client・偽の保存場所に通すテストの共通の道具（段階2の2c・設計書 docs/teardown-unify-plan.md の 10.7.12 の S1・S2）。
// 使うテスト: tests/sharedTeardownSection.test.ts・tests/sharedTeardownSectionStates.test.ts。
// 手本: tests/sharedTeardownRowHarness.ts（S3 の行）・tests/ops-shared-panel.test.ts（AppRunPanel を偽の React で動かす）。
//
// vi.mock（react・electron・auth・storageAdapter・client）は、テストのファイルの先頭に置く（vi.mock はそのファイルの中でしか巻き上げられないため）:
//   vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
//   vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
//   vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())
//   vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
//   vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
//   vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
//   vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))
//
// 画面が呼ぶ cloud.* のうち、破棄に関わるもの（teardown・teardownRecord・registryName・isPublished）は**本物の main のハンドラ**につなぐ。
// ほかの読み出し（キー・設定・前提・期限・URL）は、画面が開けるだけの偽物。

import fs from 'node:fs'
import { expect } from 'vitest'
import { RT } from './appRunPanelRt'
import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { getOps, ackOps, setProjectOpsListener, resetProjectOpsForTests } from '../src/main/projectOps'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import { h, resetHarness, newProjectDir, setup as setupProject, writePublishRecord, A, APP, bucketRef, REGISTRY_ROW } from './sharedTeardownHarness'
import type { EnvState, ResourceRef } from '../src/main/cloud/state'

export const TEARDOWN_BUTTON = '破棄する（削除）'
export const EXPIRED_BUTTON = '🗑 破棄する'
/** 窓を閉じる警告が載ったときの setBusy の引数（公開と同じ文）。 */
export const CLOSE_WARNING_CALL = [true, 'さくらのAppRun の破棄', true, 'さくらのAppRun の破棄', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel]
export const CLOSE_WARNING_CLEARED = [false, '', false, '', '', '']

export const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise<void>(r => setTimeout(r, 0)); await Promise.resolve() } }
export const holdGate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { p, open } }

const SPEC = {
  name: 'myapp', backend: 'apprun', region: 'is1a',
  service: { port: 8080, source: { type: 'image', ref: 'x' }, scale: { min: 0, max: 10 } },
  persistence: { objectStorage: [] }, guardrails: { ttlHours: 0 },
}

export type Win = {
  /** 窓を閉じる警告（win.setBusy）の呼び出し。 */
  busy: unknown[][]
  /** 画面から公開の記録に触れた回数（publishMeta の口）。画面は記録を消さない（消すのは main の1か所）。 */
  publishMetaCalls: unknown[][]
  /** AI に相談する（sakura:ask-ai）の文。 */
  askAi: string[]
  /** 破棄の IPC に渡った引数。 */
  teardownArgs: unknown[][]
  /** 終わったあとの取り直し（期限・計画）と、確認の材料を読む流れ（estimates）が画面から呼ばれた回数。 */
  reads: { checkExpiry: number; plan: number; estimates: number }
}

export type ProjectOpts = {
  /** env.json の同意済みの保存場所。 */
  env?: string[]
  /** state.json の資源。 */
  resources?: ResourceRef[]
  meta?: EnvState['meta']
  /** 公開の記録（.sakuraide.json）の publish の中身。省略すると共用型の行（publish.targets['sakura-apprun']）だけ。 */
  publish?: Record<string, unknown>
}

export function createSectionHarness() {
  registerCloudHandlers({} as any)
  const mainTeardown = h.handlers.get('cloud:teardown')!
  const mainRecord = h.handlers.get('cloud:teardownRecord')!
  const mainRegistryName = h.handlers.get('cloud:registryName')!
  const mainIsPublished = h.handlers.get('cloud:isPublished')!
  let dir = ''
  let win!: Win
  let Panel!: (p: any) => unknown
  let opened: Array<ReturnType<typeof mount>> = []
  /** 期限切れのバナー（S2）を出すか。 */
  let expired = false
  /** 公開の計画の中身（作る・消すものがあれば、公開を押すと全面表示の確認が出る）。 */
  let planActions: unknown[] = []
  /** 公開URL（あれば、公開済みの画面に「前のバージョンへ戻す」の節が出る。破棄のあとは消える）。 */
  let appUrl: string | null = null
  /** IPC を止める門（開けるまで、cloud.teardown が main へ出ない）。 */
  let teardownGate: { p: Promise<void>; open: () => void } | null = null
  /** 処理の記録の知らせを画面へ送る（本物の main を通さず、作った写しを届ける。startedAt を揃えるなど）。 */
  let notifyOps: (dir: string, snapshot: Record<string, unknown>) => void = () => {}
  /** IPC の呼び出しそのものを失敗させる（main の外で起きる失敗。画面の catch を通す）。 */
  let teardownThrows: Error | null = null

  const metaFile = () => `${dir}/.sakuraide.json`
  const SHARED_ROW = { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' }

  function writeProject(o: ProjectOpts = {}) {
    setupProject(dir, { env: o.env ?? [A], resources: o.resources ?? [APP, bucketRef(A)], ...(o.meta ? { meta: o.meta } : {}) })
    if (o.publish) fs.writeFileSync(metaFile(), JSON.stringify({ name: 'myapp', publish: o.publish }, null, 2), 'utf-8')
    else writePublishRecord(dir, { 'sakura-apprun': SHARED_ROW })
  }

  function installWindow() {
    win = { busy: [], publishMetaCalls: [], askAi: [], teardownArgs: [], reads: { checkExpiry: 0, plan: 0, estimates: 0 } }
    const subs = new Set<(p: any) => void>()
    notifyOps = (d, snapshot) => { for (const cb of [...subs]) cb({ projectDir: d, ...snapshot }) }
    setProjectOpsListener((projectDir, snapshot) => { for (const cb of [...subs]) cb({ projectDir, ...snapshot }) })
    const ok = <T,>(v: T) => async () => v
    const cloud: any = {
      hasKey: ok(true),
      loadEnv: ok({ ok: true, spec: SPEC }),
      checkPrereqs: ok({ sourceType: 'image', builderMode: 'builtin', builder: true, registry: true }),
      checkExpiry: async () => { win.reads.checkExpiry++; return { ok: true, expired, createdAt: null, ttlHours: 0 } },
      appUrl: async () => ({ ok: true, url: appUrl }),
      getAccessLimit: ok({ ok: true, deployed: false }),
      preflight: ok({ ok: true, canPublish: true, summary: '確認できました', checks: [] }),
      plan: async () => { win.reads.plan++; return { ok: true, plan: { actions: planActions, hasDestructive: false, hasStatefulDelete: false } } },
      getTraffics: ok({ ok: true, state: { kind: 'latest' } }),
      onApplyProgress: () => () => {},
      // 破棄に関わるものは、本物の main のハンドラ（preload の素通しと同じ形）。
      // ipcRenderer.invoke は常に Promise を返す（main のハンドラが同期でも）。
      isPublished: async (d: string) => mainIsPublished({}, d),
      registryName: async (d: string) => mainRegistryName({}, d),
      teardownRecord: async (d: string) => mainRecord({}, d),
      teardown: async (d: string, auth: unknown, opts: unknown) => {
        win.teardownArgs.push([d, auth, opts])
        if (teardownThrows) throw teardownThrows
        if (teardownGate) await teardownGate.p
        return mainTeardown({}, d, auth, opts)
      },
    }
    const store = new Map<string, string>()
    const w: any = new EventTarget()
    w.electronAPI = {
      cloud,
      storage: { placement: async () => ({ ok: true, placements: [] }) },
      // 確認の「ほかの公開先」を読む口（実ファイルの有無をそのまま返す）。
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p), trash: async () => {} },
      // 確認の材料を読む流れが1回始まるたびに1回呼ばれる（二重に始まったかを数える）。
      stageTiming: { estimates: async () => { win.reads.estimates++; return null } },
      win: { setBusy: (...a: unknown[]) => { win.busy.push(a) } },
      secure: { decrypt: async () => '' },
      // 画面が公開の記録に触れたら数える（触れてはいけない）。
      publishMeta: new Proxy({}, { get: (_t, key) => (...a: unknown[]) => { win.publishMetaCalls.push([String(key), ...a]); return Promise.resolve({ ok: true, meta: {} }) } }),
      projectOps: {
        get: async (d: string) => getOps(d),
        ack: async (d: string, upTo?: number) => ({ ok: true, acked: ackOps(d, upTo) }),
        onChanged: (cb: (p: any) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
      },
    }
    w.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)) }, removeItem: (k: string) => { store.delete(k) } }
    w.addEventListener = EventTarget.prototype.addEventListener.bind(w)
    w.removeEventListener = EventTarget.prototype.removeEventListener.bind(w)
    w.dispatchEvent = (e: any) => { if (e?.type === 'sakura:ask-ai') win.askAi.push(String(e.detail?.text ?? '')); return EventTarget.prototype.dispatchEvent.call(w, e) }
    ;(globalThis as any).window = w
    ;(globalThis as any).localStorage = w.localStorage
  }

  /** beforeEach: 一時フォルダにプロジェクトを置き、偽の client・保存場所と窓を立てる。 */
  async function setup(o: ProjectOpts = {}) {
    resetProjectOpsForTests()
    resetHarness()
    h.registryRows = [REGISTRY_ROW]
    dir = newProjectDir()
    expired = false; appUrl = null; planActions = []; teardownGate = null; teardownThrows = null
    writeProject(o)
    installWindow()
    if (!Panel) Panel = (await import('../src/renderer/components/AppRunPanel')).default as unknown as (p: any) => unknown
  }
  function cleanup() {
    for (const m of opened) m.close()
    opened = []
    setProjectOpsListener(null)
    fs.rmSync(dir, { recursive: true, force: true })
    delete (globalThis as any).window
    delete (globalThis as any).localStorage
  }

  /** 画面を開く。`projectDir` を省略すると、setup で置いたプロジェクト。 */
  function mount(projectDir: string = dir) {
    let current = projectDir
    // 描き直すたびに、手順6の 🗑 が押せない（実行中の印 busy が立っている）かを控える（実行中の印が一瞬でも立ったかを見る）。
    const disabledTrace: boolean[] = []
    const traced = (p: any) => {
      const tree = Panel(p)
      const hits = RT.findAll(RT.expand(tree), (n: any) => n.type === 'button' && RT.textOf(n).includes(TEARDOWN_BUTTON))
      if (hits.length === 1) disabledTrace.push(hits[0].props.disabled === true)
      return tree
    }
    const inst = RT.mount(traced, { apiKey: 'k', projectDir, onOpenCredentials: () => {}, visible: true })
    const view = {
      inst,
      disabledTrace,
      tree: () => RT.expand(inst.tree),
      text: () => RT.textOf(RT.expand(inst.tree)),
      /** ラベルに文字を含むボタン（1つだけであること）。`exact` は、文字がラベルとちょうど同じもの（「🗑 破棄する」が「🗑 破棄する（削除）」にも当たるため）。 */
      button: (label: string, opts: { exact?: boolean } = {}) => {
        const hits = RT.findAll(RT.expand(inst.tree), (n: any) => n.type === 'button' && (opts.exact ? RT.textOf(n).trim() === label : RT.textOf(n).includes(label)))
        if (hits.length !== 1) throw new Error(`ボタン「${label}」が ${hits.length} 件（1件のはず）。いまの文字: ${RT.textOf(RT.expand(inst.tree)).slice(0, 600)}`)
        return hits[0]
      },
      close: () => { RT.unmount(inst) },
      async switchTo(next: string) { current = next; RT.setProps(inst, { apiKey: 'k', projectDir: next, onOpenCredentials: () => {}, visible: true }); await settle() },
      get projectDir() { return current },
      /** 開いている確認ダイアログ（共通の ConfirmModal）。出ていなければ null。 */
      confirm: (): { props: any } | null => RT.findAll(RT.expand(inst.tree), (n: any) => n.type === 'ConfirmModal' && n.props.open === true)[0] ?? null,
    }
    opened.push(view)
    return view
  }
  type Mounted = ReturnType<typeof mount>

  /** 確認が出るまで待つ（出なければ null）。 */
  async function waitConfirm(v: Mounted, rounds = 20): Promise<{ props: any } | null> {
    for (let k = 0; k < rounds; k++) {
      const c = v.confirm()
      if (c) return c
      await settle()
    }
    return null
  }
  /** 🗑 を押して、確認が出るまで待つ。開いた確認を返す。 */
  async function pressAndWaitConfirm(v: Mounted, label: string = TEARDOWN_BUTTON, opts: { exact?: boolean } = {}) {
    v.button(label, opts).props.onClick()
    const c = await waitConfirm(v)
    expect(c, '破棄の確認（ConfirmModal）が出ていない').not.toBeNull()
    return c!
  }
  /** 🗑 を押して、確認に「破棄する」と答える（選択は触らない＝既定のまま）。 */
  async function pressAndConfirm(v: Mounted, label: string = TEARDOWN_BUTTON, opts: { exact?: boolean } = {}) {
    const c = await pressAndWaitConfirm(v, label, opts)
    c.props.onConfirm()
    await settle()
    return c
  }

  return {
    setup, cleanup, mount, waitConfirm, pressAndWaitConfirm, pressAndConfirm, writeProject, metaFile,
    get dir() { return dir },
    get win() { return win },
    setExpired: (b: boolean) => { expired = b },
    setAppUrl: (u: string | null) => { appUrl = u },
    setPlanActions: (a: unknown[]) => { planActions = a },
    notifyOps: (dir: string, snapshot: Record<string, unknown>) => notifyOps(dir, snapshot),
    holdTeardown: () => { teardownGate = holdGate(); return teardownGate },
    failTeardownWith: (e: Error | null) => { teardownThrows = e },
    readMeta: (): any => JSON.parse(fs.readFileSync(metaFile(), 'utf-8')),
    /** 公開の記録（.sakuraide.json）の publish.targets の公開先の名前。 */
    publishedTargets: (): string[] => Object.keys(JSON.parse(fs.readFileSync(metaFile(), 'utf-8')).publish?.targets ?? {}),
    mainTeardown: (opts: unknown) => mainTeardown({}, dir, { heldByMain: true }, opts),
    mainOpsLast: () => getOps(dir).last,
  }
}
