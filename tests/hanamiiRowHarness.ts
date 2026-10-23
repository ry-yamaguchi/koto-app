// 一覧の HANAMII の行（TeardownRow）を、本物の流れ・本物の main・偽の HANAMII/偽の保存場所に通すテストの共通の道具。
// 使うテスト: tests/hanamiiTeardownRow.test.ts・tests/hanamiiTeardownRowResume.test.ts（段階1の1b）。
//
// vi.mock（react・electron・auth・storageAdapter・CredentialsModal）と vi.hoisted の入れ物（rt・h）は、テストのファイルの先頭に置く
// （vi.mock はそのファイルの中でしか巻き上げられないため）。ここは、その入れ物を受け取って、窓・記録・行の取り付けを組み立てる。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from 'vitest'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { getOps, ackOps, setProjectOpsListener, resetProjectOpsForTests } from '../src/main/projectOps'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import TeardownRow from '../src/renderer/components/teardown/TeardownRow'
import { hanamiiTeardownSpec } from '../src/renderer/teardown/targets/hanamii'
import type { TeardownFlowOutcome } from '../src/renderer/teardown/useTeardownFlow'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import type { PublishedEntry } from '../src/renderer/publishedIndex'
import { deleteProjectReply } from './hanamiiTeardownFixtures'
import { isolatedProjectDir } from './isolatedProject'

/** react の小さな代役の入れ物（テストのファイルの vi.hoisted で作る）。 */
export type RowRt = {
  slots: unknown[]
  refs: Array<{ current: unknown }>
  effects: Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) } | undefined>
  queue: Array<{ idx: number; fn: () => void | (() => void); deps?: readonly unknown[] }>
  i: number; r: number; e: number
  rerender: () => void
}
/** 偽の main・偽の HANAMII・偽の保存場所の入れ物（テストのファイルの vi.hoisted で作る）。 */
export type RowMain = {
  handlers: Map<string, (...args: any[]) => any>
  hasCreds: boolean
  /** 偽の HANAMII の DELETE が返す HTTP ステータス。 */
  status: number
  /** HANAMII へ出た要求と、保存場所へ出た要求を、1本の並びで積む。 */
  calls: string[]
  /** HANAMII へ出た要求の Authorization ヘッダ。 */
  auths: string[]
  listThrows: boolean
  /** 中央ストアの登録（id → トークン）と、使用中のトークン。 */
  byId: Map<string, string>
  active: string | null
}

export const PROJECT_ID = 'hnm-proj-1'
export const BUCKET = 'koto-data-x'
export const TOKEN_ID = 'tk-recorded'
export const KEY_MISSING = '公開に使った HANAMII のトークンが見つかりません（テスト）'
export const DELETE_CALL = `DELETE https://hanamii.jp/api/v1/projects/${PROJECT_ID}`
export const CLOSE_WARNING_CALL = [true, 'HANAMII の破棄', true, 'HANAMII の破棄', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel]
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
  intervals: Array<{ fn: () => void; ms: number; cleared: boolean }>
}

export function createRowHarness(rt: RowRt, h: RowMain) {
  registerHanamiiHandlers({} as any)
  const mainTeardown = h.handlers.get('hanamii:teardown')!
  const realFetch = globalThis.fetch
  let dir = ''
  let win!: Win
  /** HANAMII の DELETE を止める（走っている最中を作る）。 */
  let deleteGate: Promise<void> | null = null

  const metaFile = () => path.join(dir, '.sakuraide.json')
  const readMeta = (): any => JSON.parse(fs.readFileSync(metaFile(), 'utf-8'))

  function writeRecord(hanamii: Record<string, unknown>, withEnv = true) {
    fs.writeFileSync(metaFile(), JSON.stringify({
      name: 'myapp',
      publish: {
        hanamii: { workspaceId: 'ws-1', ...hanamii },
        targets: { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' }, vercel: { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://myapp.vercel.test' } },
      },
    }, null, 2), 'utf-8')
    if (withEnv) {
      const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
      spec.persistence = { objectStorage: [{ bucket: BUCKET, prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] } as any
      fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
    }
  }

  function installWindow() {
    win = { busy: [], dispatched: [], acks: [], publishMetaCalls: [], intervals: [] }
    const subs = new Set<(p: any) => void>()
    setProjectOpsListener((projectDir, snapshot) => { for (const cb of [...subs]) cb({ projectDir, ...snapshot }) })
    ;(globalThis as any).window = {
      electronAPI: {
        // exists: 確認の「ほかの公開先」が旧い共用型の記録（.sakura-cloud/state.json）の有無を見る（D9=2）。実ファイルの有無をそのまま返す。
        fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
        // 保存場所の設定（同意済みの全件）は env.json から。無ければ空。
        storage: {
          placement: async (d: string) => {
            try {
              const spec = JSON.parse(fs.readFileSync(path.join(d, '.sakura-cloud', 'env.json'), 'utf-8'))
              const list = (spec?.persistence?.objectStorage ?? []) as Array<{ bucket: string; prefix: string; shared: boolean }>
              return { ok: true, placements: list.map(p => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })) }
            } catch { return { ok: true, placements: [] } }
          },
        },
        stageTiming: { estimates: async () => null },
        win: { setBusy: (...a: unknown[]) => { win.busy.push(a) } },
        projectOps: {
          get: async (d: string) => getOps(d),
          ack: async (d: string, upTo?: number) => { win.acks.push([d, upTo]); return { ok: true, acked: ackOps(d, upTo) } },
          onChanged: (cb: (p: any) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
        },
        // 本物の main のハンドラ（preload の素通しと同じ形）。
        hanamii: { teardown: (d: string, auth: unknown, opts: unknown) => mainTeardown({}, d, auth, opts) },
        // 画面が公開の記録に触れたら数える（触れてはいけない）。
        publishMeta: new Proxy({}, { get: (_t, key) => (...a: unknown[]) => { win.publishMetaCalls.push([String(key), ...a]); return Promise.resolve({ ok: true, meta: {} }) } }),
      },
      dispatchEvent: (e: { type: string }) => { win.dispatched.push(e.type); return true },
      setInterval: (fn: () => void, ms: number) => { win.intervals.push({ fn, ms, cleared: false }); return win.intervals.length },
      clearInterval: (id: number) => { if (win.intervals[id - 1]) win.intervals[id - 1].cleared = true },
    }
  }

  /** beforeEach: 一時フォルダに公開の記録（HANAMII・tokenId つき）と保存場所の設定を置き、偽の HANAMII サーバと窓を立てる。 */
  function setup() {
    resetProjectOpsForTests()
    dir = isolatedProjectDir('koto-hanamii-row-')
    h.hasCreds = true; h.status = 200; h.calls = []; h.auths = []; h.listThrows = false
    h.byId = new Map([[TOKEN_ID, 'tok-of-recorded']]); h.active = 'tok-active'
    deleteGate = null
    // 偽の HANAMII サーバ（実物の HanamiiClient をそのまま動かし、出た要求だけを記録する）。
    globalThis.fetch = (async (input: unknown, init: any) => {
      h.calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      h.auths.push(String(init?.headers?.Authorization ?? ''))
      if (deleteGate) await deleteGate
      return deleteProjectReply(h.status, PROJECT_ID)
    }) as unknown as typeof fetch
    writeRecord({ projectId: PROJECT_ID, name: 'myapp', tokenId: TOKEN_ID })
    installWindow()
  }
  /** afterEach */
  function cleanup() {
    globalThis.fetch = realFetch
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
    dir, projectName: 'myapp', target: 'hanamii', label: '🌸 HANAMII', url: 'https://myapp.example.test',
    publishedAt: '2026-09-29T00:00:00.000Z', dateUnknown: false, hanamiiProjectId: PROJECT_ID, registryName: null,
  } as PublishedEntry)

  /** 一覧が HANAMII の行に渡すのと同じ props で、行（TeardownRow）を動かす。 */
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
        spec: hanamiiTeardownSpec, entry, keyMissingMessage: KEY_MISSING, blocked: over.blocked ?? false,
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
  /** 🗑 を押して、確認に「破棄する」と答える。 */
  async function pressAndConfirm(m: Mounted) {
    const props = await pressAndWaitConfirm(m)
    props.onConfirm()
    return props
  }

  return {
    setup, cleanup, mountRow, pressAndWaitConfirm, pressAndConfirm, writeRecord, readMeta, metaFile,
    get dir() { return dir },
    get win() { return win },
    setDeleteGate(g: Promise<void> | null) { deleteGate = g },
    hanamiiCalls: () => h.calls.filter(c => c.startsWith('DELETE ')),
  }
}
