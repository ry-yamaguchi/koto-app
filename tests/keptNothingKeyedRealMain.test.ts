import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 記録に鍵（アクセスキーの ID）が残る回は、何も消さない門を通さない。確認へ進め、main に任せる ──────────────────────
// 門を通した回の結果は、main が同じ入力で返す結果と同じ view でなければならない（tests/keptNothingRealMain.test.ts）。
// ところが、記録に鍵が残る回は main が鍵の警告（「ほかのフォルダの記録も同じものを使っているため、無効にしていません。」）を足す。
// 画面は、ほかのフォルダが同じ鍵を持つかを読まない（main だけが兄弟の記録を読む）ので、この警告を組めない。
// そこで門は、鍵が残る回（共用型は record.keyRecorded、専有型は record.storagePermissionId）を通さず、確認へ進める。HANAMII は鍵を記録に持たないので当たらない。
//   ・複製が元の記録の鍵の ID を写した形（state.json〔専有型は .sakuraide.json〕ごと複製される）を、実フォルダと本物の main に流して固定する。
//   ・前提の確認: 同じ入力で本物の main が返す view には鍵の警告があり、画面が門を通して組む結果には無い。ここが崩れたら、この門の理由を見直す。
// 変異: 門が鍵の有無を見ない／共用型の鍵の判定を外す／専有型の鍵の判定を外す／鍵の読みが欠けた回を「鍵なし」と読む（不明を肯定に）。

import { A, OK_AUTH, CONSENTED_AT, bucketRef, PREFIX, h, resetHarness, newProjectDir, workspaceOf, setup } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))
// 専有型の破棄の本体は実物を動かす（資源の記録が無い回は、さくらへの要求は出ない）。
const d = vi.hoisted(() => ({ baseUrl: '' }))
vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => {
  const real = await orig<any>()
  return { ...real, teardownFlow: (auth: any, dir: string, opts: any) => real.teardownFlow(auth, dir, { ...opts, sleep: async () => {} }, d.baseUrl) }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { readSharedTeardownRecord } from '../src/main/ipc/cloudTeardown'
import { writeApprunDedicatedRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { KEY_KEPT_HELD_WARNING } from '../src/main/cloud/storageTeardown'
import { toTeardownView } from '../src/shared/teardownResult'
import { keptNothingReplyOf } from '../src/shared/keptNothingReply'
import { runTeardownFlow, electronFlowDeps, shownPlacementsOf } from '../src/renderer/teardown/flow'
import { loadTeardownFacts, type TeardownFactsApi } from '../src/renderer/teardown/facts'
import { namedPlacementsOf } from '../src/renderer/teardown/confirm'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import { dedicatedTeardownSpec } from '../src/renderer/teardown/targets/dedicated'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import type { TargetSpec, TeardownPlacement } from '../src/renderer/teardown/types'
import type { TwinFactsArgs } from '../src/shared/twinFactsTypes'

registerCloudHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const twinFactsIpc = (dir: string, args: TwinFactsArgs) => h.handlers.get('cloud:twinFacts')!({}, dir, args)
const EVENT = { sender: { send: () => {} } }
const KEY_ID = 'perm-1'

let dir = ''
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  d.baseUrl = ''
  dir = newProjectDir()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(path.join(workspaceOf(dir), 'myapp copy'), { recursive: true, force: true })
  delete (globalThis as any).window
})

const copyDir = () => path.join(workspaceOf(dir), 'myapp copy')
/** 複製（`myapp copy`）。元と同じバケット・同じ prefix を持つ（公開の記録は無い）。 */
function putTwinFolder(bucket: string): void {
  const p = path.join(copyDir(), '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), JSON.stringify({
    persistence: { objectStorage: [{ bucket, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT }] },
  }))
}
/** 複製が、元の記録の鍵の ID を写した形。共用型は state.json の meta、専有型は .sakuraide.json の publish.apprunDedicated。 */
const copyKeepsSharedKey = () => fs.writeFileSync(path.join(copyDir(), '.sakura-cloud', 'state.json'),
  JSON.stringify({ name: 'myapp', backend: 'apprun', resources: [], meta: { storagePermissionId: KEY_ID } }))
const copyKeepsDedicatedKey = () => fs.writeFileSync(path.join(copyDir(), '.sakuraide.json'),
  JSON.stringify({ publish: { apprunDedicated: { storagePermissionId: KEY_ID } } }))

const placementsOf = (buckets: string[]): TeardownPlacement[] => buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true }))
const realApi = (buckets: string[]): TeardownFactsApi => ({
  placements: async () => placementsOf(buckets),
  otherTargets: async () => [],
  estimates: async () => null,
  twinFacts: async (dd, args) => twinFactsIpc(dd, args),
})
const destructive = () => h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission|listPermissions)\b/.test(c))

type Case = {
  name: string; target: 'sakura-apprun' | 'sakura-apprun-dedicated'; spec: TargetSpec<any, any, any>
  /** 元の記録（保存場所が1件・記録に鍵が `keyed` のとき残る）と、複製（同じ鍵を写す）を置く。 */
  place: (keyed: boolean) => void
  record: () => unknown
  mainCall: (shown: unknown) => Promise<any>
}
const CASES: Case[] = [
  {
    name: '共用型', target: 'sakura-apprun', spec: sharedTeardownSpec,
    place: keyed => {
      setup(dir, { env: [A], resources: [bucketRef(A)], ...(keyed ? { meta: { storagePermissionId: KEY_ID } } : {}) })
      putTwinFolder(A)
      if (keyed) copyKeepsSharedKey()
    },
    // 画面が読む記録は、本物の cloud:teardownRecord の答えそのもの（keyRecorded は main が決める）
    record: () => {
      const r = readSharedTeardownRecord(dir)
      if (!r.ok) throw new Error(r.message)
      return r.record
    },
    mainCall: shown => h.handlers.get('cloud:teardown')!(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: false, registryName: null, shownPlacements: shown }),
  },
  {
    name: '専有型', target: 'sakura-apprun-dedicated', spec: dedicatedTeardownSpec,
    place: keyed => {
      setup(dir, { env: [A], resources: [] })
      writeApprunDedicatedRecordFs(dir, { storageLeftoverBucket: A, storageLeftoverBuckets: [A], ...(keyed ? { storagePermissionId: KEY_ID } : {}) })
      putTwinFolder(A)
      if (keyed) copyKeepsDedicatedKey()
    },
    record: () => readApprunDedicatedFs(dir),
    mainCall: shown => h.handlers.get('apprunDedicated:teardown')!(EVENT, dir, { token: 'tok', secret: 'sec' }, { confirmed: true, shownPlacements: shown }),
  },
]

/** 材料を本物の口（cloud:twinFacts）で読み、本物の仕様書で流れを流す。確認・invoke・活動レジストリ・キーは回数だけ数える偽。 */
async function runReal(c: Case) {
  const facts = await loadTeardownFacts(dir, { target: c.target, readRecord: async () => c.record() as never }, realApi([A]))
  const asked: ConfirmOptions[] = []
  let invokes = 0
  const base = electronFlowDeps(dir, c.spec, { confirm: async () => true, confirmWithChoices: async () => ({ confirmed: true, choices: {} }), keyMissingMessage: 'キーなし' })
  const deps = {
    ...base,
    loadFacts: async () => facts,
    confirm: async (o: ConfirmOptions) => { asked.push(o); return true },
    confirmWithChoices: async (o: any) => { asked.push(o); return { confirmed: true, choices: {} } },
    loadAuth: async () => ({}),
    invoke: async () => { invokes++; return { ok: true, executed: [], message: '', remaining: {} } },
    beginActivity: () => () => {},
  }
  const out = await runTeardownFlow(dir, c.spec, deps)
  return { facts, out, asked, invokes }
}

const KEY_LINE = `⚠️ ${KEY_KEPT_HELD_WARNING}`

describe('★★★ 記録に鍵が残る回は、何も消さない門を通さず、確認へ進める（鍵の警告は main だけが組める）', () => {
  for (const c of CASES) {
    it(`${c.name}: 前提 — 複製が同じ鍵の ID を写した入力を本物の main に流すと、鍵の警告が付く。画面が門を通して組む結果には、その警告が無い`, async () => {
      c.place(true)
      const r = await runReal(c)
      expect(r.facts.placements.every(p => !!p.keep), '材料の保存場所が全件 keep').toBe(true)

      const mainRaw = await c.mainCall(shownPlacementsOf(r.facts))
      expect(mainRaw.ok, JSON.stringify(mainRaw)).toBe(true)
      expect(destructive(), 'main が消す要求・鍵の無効化を出した').toEqual([])
      const main = toTeardownView(c.target, mainRaw)
      expect(main.warnings.some(w => w.includes(KEY_LINE)) || main.executed.some(l => l.includes(KEY_LINE)), `main の view に鍵の警告が無い: ${JSON.stringify(main)}`).toBe(true)

      // 画面が（門を通した場合に）組む結果。ここに鍵の警告を組む材料は無い。
      const [first, ...rest] = namedPlacementsOf(r.facts.placements)
      const screen = c.spec.toView(c.spec.keptNothingResult!(keptNothingReplyOf([first, ...rest])))
      expect(screen.executed.concat(screen.warnings).join('\n')).not.toContain(KEY_KEPT_HELD_WARNING)
    })

    it(`${c.name}: 記録に鍵が残る回は、全件 keep でも飛ばさない。確認が1回出て、IPC が1回。結果に keptNothing の印は付かない`, async () => {
      c.place(true)
      const r = await runReal(c)
      expect(r.facts.placements.every(p => !!p.keep)).toBe(true)
      expect(r.asked, '確認が出ていない（門を通った）').toHaveLength(1)
      expect(r.invokes).toBe(1)
      expect((r.out as any).keptNothing).toBeUndefined()
      expect(r.out).toMatchObject({ cancelled: false })
    })

    it(`${c.name}: 対照 — 記録に鍵が無ければ、同じ複製でも今までどおり門を通る（確認 0・IPC 0）。この試験が鍵だけを見ていることの確認`, async () => {
      c.place(false)
      const r = await runReal(c)
      expect(r.facts.placements.every(p => !!p.keep)).toBe(true)
      expect(r.asked).toEqual([])
      expect(r.invokes).toBe(0)
      expect(r.out).toMatchObject({ cancelled: false, keptNothing: true, result: { ok: true, keptOnly: true } })
      // 鍵が無いので、main が返す view にも鍵の警告は付かない（双子が揃う）
      const mainRaw = await c.mainCall(shownPlacementsOf(r.facts))
      const main = toTeardownView(c.target, mainRaw)
      expect(main.executed.concat(main.warnings).join('\n')).not.toContain(KEY_KEPT_HELD_WARNING)
      expect(c.spec.toView((r.out as any).result).warnings).toEqual(main.warnings)
    })
  }
})
