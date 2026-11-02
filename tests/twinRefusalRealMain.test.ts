import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 公開先の拒否: 画面が確認の前に返す結果は、本物の main が断る結果と同じ文（実フォルダ・本物の cloud:twinFacts と3つの破棄の IPC）──────────────
// 実フォルダに複製（同じ公開の記録を持つ兄弟）を置き、本物の `cloud:twinFacts` の答えを確認の材料（loadTeardownFacts）に載せ、本物の仕様書で runTeardownFlow を流す。
//   ・断る回（twin・unknown）は、確認 0 回・invoke 0 回・活動レジストリ 0 回。結果の文は、同じフォルダで本物の main（cloud:teardown・hanamii:teardown・apprunDedicated:teardown）が返す断りと一致する。
//   ・本物の main も外へ1本も出さない（保存場所・さくら・HANAMII への要求が0件）。
//   ・複製の無い回は、今までどおり確認が出て invoke に進む。
//   ・R4 の形（公開の記録の無い複製が同じ保存場所の同じ prefix を持つ）は、本物の `cloud:twinFacts` の keep が確認の 💾 に届く。
// 変異: refusal を無視して確認へ進む／unknown を通す／確認のあとで読む／keep を付けない。

import { A, OK_AUTH, CONSENTED_AT, bucketRef, APP, PREFIX, h, resetHarness, newProjectDir, workspaceOf, setup, writePublishRecord } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { TWINS_UNKNOWN_MESSAGE, twinsRefusedMessage } from '../src/shared/twinsRefusal'
import { runTeardownFlow, electronFlowDeps } from '../src/renderer/teardown/flow'
import { loadTeardownFacts, type TeardownFactsApi } from '../src/renderer/teardown/facts'
import { sharedTeardownSpec, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec, type DedicatedTeardownRecord } from '../src/renderer/teardown/targets/dedicated'
import type { TargetSpec, TeardownPlacement } from '../src/renderer/teardown/types'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import type { TwinFactsArgs } from '../src/shared/twinFactsTypes'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const twinFactsIpc = (dir: string, args: TwinFactsArgs) => h.handlers.get('cloud:twinFacts')!({}, dir, args)

const EVENT = { sender: { send: () => {} } }
const ROW = { publishedAt: CONSENTED_AT, url: 'https://x.example/' }
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0
const skipIfRoot = rootIsMe ? it.skip : it

let dir = ''
let external: string[] = []
const realFetch = globalThis.fetch
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  dir = newProjectDir()
  external = []
  // 外への HTTP は、出たら記録して失敗させる（断る回は1本も出ないこと）。
  globalThis.fetch = (async (url: string, init?: { method?: string }) => { external.push(`${init?.method ?? 'GET'} ${url}`); throw new Error('テスト: 外への要求') }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  try { fs.chmodSync(workspaceOf(dir), 0o755) } catch { /* 無い */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

const copyDir = () => path.join(workspaceOf(dir), 'copy')
const lockParent = () => fs.chmodSync(workspaceOf(dir), 0o311)
const writeHanamii = (p: string, projectId: string) => {
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId }, targets: { hanamii: ROW } } }, null, 2), 'utf-8')
}

const SHARED_RECORD: SharedTeardownRecord = { appNames: ['myapp'], registryName: null, registryOrigin: 'owned', registryUsers: [], placements: [], stateOnlyBuckets: [] }
const HANAMII_RECORD: HanamiiTeardownRecord = { projectId: 'hnm-1', name: 'myapp', tokenId: 'tok-1', storageLeftoverBuckets: null }
const DEDICATED_RECORD: DedicatedTeardownRecord = { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1', applicationName: 'myapp' }
const PLACEMENT: TeardownPlacement = { bucket: A, prefix: PREFIX, shared: true }

type Target = 'hanamii' | 'sakura-apprun' | 'sakura-apprun-dedicated'
type Case = { name: string; target: Target; spec: TargetSpec<any, any, any>; record: unknown; place: (p: string) => void; call: () => Promise<{ ok?: boolean; message?: string }> }
const CASES: Case[] = [
  {
    name: '共用型', target: 'sakura-apprun', spec: sharedTeardownSpec, record: SHARED_RECORD,
    place: p => { setup(p, { env: [A], resources: [bucketRef(A), APP] }); writePublishRecord(p, { 'sakura-apprun': ROW }) },
    call: () => h.handlers.get('cloud:teardown')!(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: false, registryName: null, shownPlacements: [] }),
  },
  {
    name: 'HANAMII', target: 'hanamii', spec: hanamiiTeardownSpec, record: HANAMII_RECORD,
    place: p => { setup(p, { env: [A], resources: [] }); writeHanamii(p, 'hnm-1') },
    call: () => h.handlers.get('hanamii:teardown')!(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId: 'hnm-1', shownPlacements: [] }),
  },
  {
    name: '専有型', target: 'sakura-apprun-dedicated', spec: dedicatedTeardownSpec, record: DEDICATED_RECORD,
    place: p => { setup(p, { env: [A], resources: [] }); writeApprunDedicatedRecordFs(p, { clusterID: 'c1' }) },
    call: () => h.handlers.get('apprunDedicated:teardown')!(EVENT, dir, { token: 'tok', secret: 'sec' }, { confirmed: true, shownPlacements: [] }),
  },
]

/** 本物の cloud:twinFacts を口にした材料の読み口。保存場所は A の1件（env.json の同意済みと同じ）。 */
const realApi = (placements: TeardownPlacement[] = [PLACEMENT]): TeardownFactsApi => ({
  placements: async () => placements,
  otherTargets: async () => [],
  estimates: async () => null,
  twinFacts: async (d, args) => twinFactsIpc(d, args),
})

/** 材料を本物の口で読み、本物の仕様書で流れを流す。確認・invoke・活動レジストリ・キーは回数だけ数える偽。 */
async function runReal(c: Case, placements: TeardownPlacement[] = [PLACEMENT]) {
  const facts = await loadTeardownFacts(dir, { target: c.target, readRecord: async () => c.record }, realApi(placements))
  const asked: ConfirmOptions[] = []
  let invokes = 0, activities = 0, auths = 0
  const base = electronFlowDeps(dir, c.spec, { confirm: async () => true, confirmWithChoices: async () => ({ confirmed: true, choices: {} }), keyMissingMessage: 'キーなし' })
  const deps = {
    ...base,
    loadFacts: async () => facts,
    confirm: async (o: ConfirmOptions) => { asked.push(o); return true },
    confirmWithChoices: async (o: any) => { asked.push(o); return { confirmed: true, choices: {} } },
    loadAuth: async () => { auths++; return {} },
    invoke: async () => { invokes++; return { ok: true, executed: [], message: '', remaining: {} } },
    beginActivity: () => { activities++; return () => {} },
  }
  const out = await runTeardownFlow(dir, c.spec, deps)
  return { facts, out, asked, invokes, activities, auths }
}

describe('★★★ 実フォルダの複製（twin）: 3つの公開先とも、確認なしで main の断りと同じ文を返す', () => {
  for (const c of CASES) {
    it(`${c.name}: 確認 0 回・invoke 0 回・活動レジストリ 0 回・キー 0 回。結果の文は本物の main の断りと同じ。main も外へ1本も出さない`, async () => {
      c.place(dir)
      c.place(copyDir())
      const r = await runReal(c)
      expect(r.facts.refusal).toEqual({ kind: 'twin', folders: ['copy'] })
      expect(r.asked).toEqual([])
      expect([r.invokes, r.activities, r.auths]).toEqual([0, 0, 0])
      expect(r.out).toMatchObject({ cancelled: false, result: { ok: false, message: twinsRefusedMessage(['copy']) } })
      const main = await c.call()
      expect(main.ok).toBe(false)
      expect(main.message).toBe((r.out as any).result.message)
      expect(h.calls, '断るのに保存場所・client へ要求が出た').toEqual([])
      expect(external, '断るのに外への HTTP が出た').toEqual([])
    })
  }

  it('対照: 複製が無ければ、3つの公開先とも今までどおり確認が出て invoke に進む（この試験が流れを見ていることの確認）', async () => {
    for (const c of CASES) {
      c.place(dir)
      const r = await runReal(c)
      expect(r.facts.refusal, c.name).toBeNull()
      expect(r.asked, c.name).toHaveLength(1)
      expect(r.invokes, c.name).toBe(1)
    }
  })
})

describe('★★★ 実フォルダ: 親フォルダの一覧を読めない（unknown）: 3つの公開先とも、確認なしで「確かめられなかった」の断り', () => {
  for (const c of CASES) {
    skipIfRoot(`${c.name}: 確認 0 回・invoke 0 回。結果の文は本物の main の断りと同じ（TWINS_UNKNOWN_MESSAGE）`, async () => {
      c.place(dir)
      lockParent()
      const r = await runReal(c)
      expect(r.facts.refusal).toEqual({ kind: 'unknown' })
      expect(r.asked).toEqual([])
      expect([r.invokes, r.activities, r.auths]).toEqual([0, 0, 0])
      expect(r.out).toMatchObject({ cancelled: false, result: { ok: false, message: TWINS_UNKNOWN_MESSAGE } })
      const main = await c.call()
      expect(main.ok).toBe(false)
      expect(main.message).toBe(TWINS_UNKNOWN_MESSAGE)
      expect(h.calls).toEqual([])
      expect(external).toEqual([])
    })
  }
})

describe('★★ R4 の形: 公開の記録の無い複製が同じ保存場所の同じ prefix を持つ → 本物の keep が確認の 💾 に届く', () => {
  it('HANAMII: 確認は出る（公開先の拒否ではない）。💾 は「残ります」と複製のフォルダ名を言い、「データも削除します」と言わない。一覧に保存場所を入れない', async () => {
    writeHanamii(dir, 'hnm-1')
    setup(dir, { env: [A], resources: [] })
    setup(copyDir(), { env: [A], resources: [] }) // 公開の記録は無い（「用意しただけ」の複製）
    const r = await runReal(CASES[1])
    expect(r.facts.refusal).toBeNull()
    expect(r.facts.placements).toEqual([{ ...PLACEMENT, keep: { risk: 'twin', folders: ['copy'] } }])
    expect(r.asked).toHaveLength(1)
    expect(r.invokes).toBe(1)
    const body = r.asked[0].body as string
    expect(body).toContain(`保存場所『${A}』とその中のデータは残ります`)
    expect(body).toContain('フォルダ『copy』も同じデータを使っています。')
    expect(body).not.toContain('データも削除します')
    expect(body).not.toContain(`保存場所『${A}』にある、このプロジェクトのデータ`)
  })

  it('読めない兄弟（壊れた env.json）→ keep は unread。確認は「確かめられませんでした」と言って残す側の文', async () => {
    writeHanamii(dir, 'hnm-1')
    setup(dir, { env: [A], resources: [] })
    fs.mkdirSync(path.join(copyDir(), '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(copyDir(), '.sakura-cloud', 'env.json'), '{ 壊れた', 'utf-8')
    const r = await runReal(CASES[1])
    expect(r.facts.placements).toEqual([{ ...PLACEMENT, keep: { risk: 'unread', folders: ['copy'] } }])
    const body = r.asked[0].body as string
    expect(body).toContain('フォルダ『copy』の記録を読めないため、同じデータを使っているか確かめられませんでした。')
    expect(body).not.toContain('データも削除します')
  })

  it('対照: 兄弟が別の prefix・別のバケットなら keep は付かず、確認は今までどおり「データも削除します」', async () => {
    writeHanamii(dir, 'hnm-1')
    setup(dir, { env: [A], resources: [] })
    setup(copyDir(), { env: ['koto-other'], resources: [] })
    const r = await runReal(CASES[1])
    expect(r.facts.placements).toEqual([PLACEMENT])
    expect(r.facts.placements.every(p => !('keep' in p))).toBe(true)
    expect(r.asked[0].body as string).toContain('データも削除します')
  })
})
