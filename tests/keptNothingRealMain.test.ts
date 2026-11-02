import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── 何も消さないと分かっている回の結果は、本物の main が同じ入力で返す結果と同じ view になる（双子）。プロジェクトの削除（PD-1）も本物の流れで固定 ──────────
// 実フォルダに複製（同じ保存場所の同じ prefix を持つ兄弟）を置き、本物の cloud:twinFacts の答えを材料に載せ、本物の仕様書で runTeardownFlow を流す。
//   ・画面が組んだ結果（確認 0 回・IPC 0 回・保存場所／さくら／HANAMII への要求 0 件）を toView に通した view と、
//     同じフォルダで本物の main（cloud:teardown・hanamii:teardown・apprunDedicated:teardown）が返す結果を toTeardownView に通した view を並べる。
//   ・共用型・専有型は、行・警告・見出しの印（keptOnly）まで同じ。違うのは appDeleted だけ（main は「アプリは消えた」と返す。画面は何も消していないので持たない）。
//   ・HANAMII は main が keptOnly を付けない（プロジェクトを消した回の見出しが唯一の知らせ）。行と警告が同じことを固定する。画面が組んだ結果だけが keptOnly を持つ。
//   ・プロジェクトの削除: 行のある共用型の幽霊の行（PD-1）は、確認なしで結果を返し、月額を見せてから2回目の押しで移す。残りの段の再判定（読み直した記録に keep が無い）で、
//     何も消さない確認が出なくなる。HANAMII の段がこの結果になった回は、残りの段が同じ保存場所を二重に言わない。
// 変異: 全件 keep でないのに飛ばす／keep の読み失敗を全件 keep と読む／レジストリ名・アプリ・資源があっても飛ばす／飛ばした回に IPC を呼ぶ／3つのうち1つだけ門を通さない／📡 の一言を出さない。

import { A, B, OK_AUTH, CONSENTED_AT, bucketRef, PREFIX, h, resetHarness, newProjectDir, workspaceOf, setup } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))
// 専有型の破棄の本体は実物を動かす。待たない sleep を入れる（資源の記録が無い回は、さくらへの要求は出ない）。
const d = vi.hoisted(() => ({ baseUrl: '' }))
vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => {
  const real = await orig<any>()
  return { ...real, teardownFlow: (auth: any, dir: string, opts: any) => real.teardownFlow(auth, dir, { ...opts, sleep: async () => {} }, d.baseUrl) }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { writeApprunDedicatedRecordFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { toTeardownView } from '../src/shared/teardownResult'
import { runTeardownFlow, electronFlowDeps, shownPlacementsOf } from '../src/renderer/teardown/flow'
import { loadTeardownFacts, type TeardownFactsApi } from '../src/renderer/teardown/facts'
import { sharedTeardownSpec, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec, type DedicatedTeardownRecord } from '../src/renderer/teardown/targets/dedicated'
import { runProjectDelete, pressProjectDelete, teardownPublished, type ProjectDeleteRunDeps } from '../src/renderer/teardown/projectDelete'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import { teardownHeadlineOf } from '../src/renderer/teardown/headline'
import ProjectDeleteResults from '../src/renderer/components/teardown/ProjectDeleteResults'
import { resolveConfirmWithChoices, type ConfirmWithChoicesAnswer, type ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import type { TargetSpec, TeardownPlacement } from '../src/renderer/teardown/types'
import type { TwinFactsArgs } from '../src/shared/twinFactsTypes'
import { deleteProjectReply } from './hanamiiTeardownFixtures'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const twinFactsIpc = (dir: string, args: TwinFactsArgs) => h.handlers.get('cloud:twinFacts')!({}, dir, args)

const EVENT = { sender: { send: () => {} } }
const HANAMII_ID = 'hnm-1'
const ROW = { publishedAt: CONSENTED_AT, url: 'https://x.example/' }

let dir = ''
let external: string[] = []
const realFetch = globalThis.fetch
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  d.baseUrl = ''
  dir = newProjectDir()
  external = []
  // 外への HTTP は、出たら記録する。HANAMII のプロジェクトの削除（DELETE）は、本物の main に「もう無い」(404) と答える。
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    external.push(`${init?.method ?? 'GET'} ${url}`)
    return deleteProjectReply(404, HANAMII_ID)
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(path.join(workspaceOf(dir), 'myapp copy'), { recursive: true, force: true })
  fs.rmSync(path.join(workspaceOf(dir), 'broken-env'), { recursive: true, force: true })
  delete (globalThis as any).window
})

const copyDir = () => path.join(workspaceOf(dir), 'myapp copy')
/** 複製（`myapp copy`）。元と同じバケット・同じ prefix を env.json に同意済みで持つ（公開の記録は無い）。 */
function putTwin(buckets: string[]): void {
  const p = path.join(copyDir(), '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), JSON.stringify({
    persistence: { objectStorage: buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT })) },
  }))
}
/** 複製かどうか確かめられない兄弟（env.json が壊れている）。 */
function putUnreadSibling(): void {
  const p = path.join(workspaceOf(dir), 'broken-env', '.sakura-cloud')
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, 'env.json'), '{ not json')
}
const writeHanamiiMeta = (leftover: string[] | null) => fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({
  name: 'myapp',
  publish: { hanamii: { projectId: HANAMII_ID, name: 'myapp', tokenId: 'tok-1', ...(leftover ? { storageLeftoverBuckets: leftover } : {}) }, targets: { hanamii: ROW } },
}, null, 2), 'utf-8')

const placementsOf = (buckets: string[]): TeardownPlacement[] => buckets.map(bucket => ({ bucket, prefix: PREFIX, shared: true }))
const realApi = (buckets: string[]): TeardownFactsApi => ({
  placements: async () => placementsOf(buckets),
  otherTargets: async () => [],
  estimates: async () => null,
  twinFacts: async (dd, args) => twinFactsIpc(dd, args),
})
const destructive = () => h.calls.filter(c => /^(deleteKeys|deleteBucket|deletePermission|listPermissions)\b/.test(c))
const text = (s: string) => s.replace(/<[^>]*>/g, '')

// ── 3つの公開先の ghost（消す資源が無く、保存場所だけが残る）と、本物の main の呼び方 ──────────────────────────────────────
const SHARED_GHOST = (buckets: string[]): SharedTeardownRecord => ({
  appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], keyRecorded: false,
  placements: placementsOf(buckets).map(p => ({ bucket: p.bucket, prefix: p.prefix ?? '', shared: true })), stateOnlyBuckets: [],
})
const HANAMII_GHOST = (buckets: string[]): HanamiiTeardownRecord => ({ projectId: HANAMII_ID, name: 'myapp', tokenId: 'tok-1', storageLeftoverBuckets: buckets })
const DEDICATED_GHOST = (buckets: string[]): DedicatedTeardownRecord => ({ storageLeftoverBucket: buckets[0], storageLeftoverBuckets: buckets })

type Case = {
  name: string; target: 'sakura-apprun' | 'hanamii' | 'sakura-apprun-dedicated'; spec: TargetSpec<any, any, any>
  place: (buckets: string[]) => void
  record: (buckets: string[]) => unknown
  mainCall: (shown: unknown) => Promise<any>
  /** 本物の main の返り値を、画面が読む view にする（その場の読み方。toTeardownView）。 */
  mainView: (raw: any) => ReturnType<typeof toTeardownView>
}
const CASES: Case[] = [
  {
    name: '共用型', target: 'sakura-apprun', spec: sharedTeardownSpec,
    place: buckets => setup(dir, { env: buckets, resources: buckets.map(bucketRef) }),
    record: SHARED_GHOST,
    mainCall: shown => h.handlers.get('cloud:teardown')!(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: false, registryName: null, shownPlacements: shown }),
    mainView: raw => toTeardownView('sakura-apprun', raw),
  },
  {
    name: 'HANAMII', target: 'hanamii', spec: hanamiiTeardownSpec,
    place: buckets => { setup(dir, { env: buckets, resources: [] }); writeHanamiiMeta(buckets) },
    record: HANAMII_GHOST,
    mainCall: shown => h.handlers.get('hanamii:teardown')!(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId: HANAMII_ID, shownPlacements: shown }),
    mainView: raw => toTeardownView('hanamii', raw),
  },
  {
    name: '専有型', target: 'sakura-apprun-dedicated', spec: dedicatedTeardownSpec,
    place: buckets => { setup(dir, { env: buckets, resources: [] }); writeApprunDedicatedRecordFs(dir, { storageLeftoverBucket: buckets[0], storageLeftoverBuckets: buckets }) },
    record: DEDICATED_GHOST,
    mainCall: shown => h.handlers.get('apprunDedicated:teardown')!(EVENT, dir, { token: 'tok', secret: 'sec' }, { confirmed: true, shownPlacements: shown }),
    mainView: raw => toTeardownView('sakura-apprun-dedicated', raw),
  },
]

/** 材料を本物の口（cloud:twinFacts）で読み、本物の仕様書で流れを流す。確認・invoke・活動レジストリ・キーは回数だけ数える偽。 */
async function runReal(c: Case, buckets: string[]) {
  const facts = await loadTeardownFacts(dir, { target: c.target, readRecord: async () => c.record(buckets) }, realApi(buckets))
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

const SCENES: Array<{ title: string; buckets: string[]; sibling: () => void; reason: RegExp }> = [
  { title: '複製（twin）1件', buckets: [A], sibling: () => putTwin([A]), reason: /フォルダ『myapp copy』も同じデータを使っています。/ },
  { title: '確かめられない兄弟（unread）', buckets: [A], sibling: () => putUnreadSibling(), reason: /フォルダ『broken-env』の記録を読めないため、同じデータを使っているか確かめられませんでした。/ },
  { title: '複製（twin）2件', buckets: [A, B], sibling: () => putTwin([A, B]), reason: /フォルダ『myapp copy』も同じデータを使っています。/ },
]

describe('★★★ 双子: 画面が組んだ結果と、本物の main が同じ入力で返す結果は、同じ view（行・警告・月額）', () => {
  for (const c of CASES) {
    for (const s of SCENES) {
      it(`${c.name} × ${s.title}: 確認 0・キー 0・IPC 0・活動レジストリ 0・外への要求 0。main の view と行・警告が一致する`, async () => {
        c.place(s.buckets)
        s.sibling()
        const r = await runReal(c, s.buckets)
        // 画面は何も呼ばない（確認・キー・IPC・活動レジストリ・保存場所・さくら・HANAMII）
        expect(r.facts.placements.every(p => !!p.keep), '材料の保存場所が全件 keep').toBe(true)
        expect(r.asked).toEqual([])
        expect([r.invokes, r.activities, r.auths]).toEqual([0, 0, 0])
        expect(h.calls, '画面が保存場所・client へ要求を出した').toEqual([])
        expect(external, '画面が外へ HTTP を出した').toEqual([])
        expect(r.out).toMatchObject({ cancelled: false, keptNothing: true, result: { ok: true, keptOnly: true } })
        const screen = c.spec.toView((r.out as any).result)

        // 本物の main に、同じ確認（見せた保存場所・keepData つき）で同じ入力を流す
        const mainRaw = await c.mainCall(shownPlacementsOf(r.facts))
        expect(mainRaw.ok, JSON.stringify(mainRaw)).toBe(true)
        expect(destructive(), 'main が消す要求・鍵の無効化を出した（前提が崩れている）').toEqual([])
        const main = c.mainView(mainRaw)

        // 行・警告・状態は同じ。ここが双子の本体。
        expect(screen.executed).toEqual(main.executed)
        expect(screen.warnings).toEqual(main.warnings)
        expect(screen.executed.join('')).toMatch(s.reason)
        expect(screen.warnings.length, '月額の警告（お金を削らない）').toBeGreaterThan(0)
        for (const b of s.buckets) expect(screen.warnings.join('')).toContain(`『${b}』`)
        expect(screen).toMatchObject({ ok: true, state: 'done', keptOnly: true, message: '', remaining: [], inProgress: [] })
        // 違うのは appDeleted（main は「消えた」と返す。画面は何も消していないので持たない）・段の所要時間（main は測る。画面は何も実行していないので無い）・HANAMII の見出しの印だけ
        const { appDeleted: mainAppDeleted, stageTimings: _mainTimings, ...mainRest } = main
        const { appDeleted: screenAppDeleted, stageTimings: screenTimings, ...screenRest } = screen
        expect(mainAppDeleted).toBe(true)
        expect(screenAppDeleted).toBeNull()
        expect(screenTimings).toBeNull()
        if (c.target === 'hanamii') {
          expect('keptOnly' in main, 'main は HANAMII に keptOnly を付けない').toBe(false)
          const { keptOnly, ...screenWithout } = screenRest
          expect(keptOnly).toBe(true)
          expect(screenWithout).toEqual(mainRest)
        } else {
          expect(screenRest).toEqual(mainRest)
        }
      })
    }
  }

  it('見出しは公開先の言葉で言い分ける（共用型・HANAMII は「⚠️ 破棄していません」・専有型は「⚠️ 削除していません」）。HANAMII の main の結果は今までどおり「✅ 破棄しました」', async () => {
    const heads: string[] = []
    for (const c of CASES) {
      resetHarness(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(copyDir(), { recursive: true, force: true }); dir = newProjectDir()
      c.place([A]); putTwin([A])
      const r = await runReal(c, [A])
      heads.push(teardownHeadlineOf(c.spec.toView((r.out as any).result), c.spec.words).text)
      if (c.target === 'hanamii') {
        const main = c.mainView(await c.mainCall(shownPlacementsOf(r.facts)))
        expect(teardownHeadlineOf(main, c.spec.words).text).toBe('✅ 破棄しました')
      }
    }
    expect(heads).toEqual(['⚠️ 破棄していません', '⚠️ 破棄していません', '⚠️ 削除していません'])
  })

  it('対照: 複製がいなければ、3つとも今までどおり確認が出て invoke に進む（この試験が門を見ていることの確認）', async () => {
    for (const c of CASES) {
      resetHarness(); fs.rmSync(dir, { recursive: true, force: true }); dir = newProjectDir()
      c.place([A])
      const r = await runReal(c, [A])
      expect(r.facts.placements.some(p => !!p.keep), c.name).toBe(false)
      expect(r.asked, c.name).toHaveLength(1)
      expect(r.invokes, c.name).toBe(1)
      expect((r.out as any).keptNothing, c.name).toBeUndefined()
    }
  })

  it('混在（A は複製がいる・B は複製がいない）: 3つとも確認が出て invoke に進む。確認は B だけを「削除します」と言う', async () => {
    for (const c of CASES) {
      resetHarness(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(copyDir(), { recursive: true, force: true }); dir = newProjectDir()
      c.place([A, B]); putTwin([A])
      const r = await runReal(c, [A, B])
      expect(r.facts.placements.map(p => !!p.keep), c.name).toEqual([true, false])
      expect(r.asked, c.name).toHaveLength(1)
      expect(r.invokes, c.name).toBe(1)
      expect(String(r.asked[0].body), c.name).toContain(`保存場所『${B}』にある、このプロジェクトのデータ`)
    }
  })
})

// ── プロジェクトの削除（本物の readProjectDeleteFacts・runProjectDelete・teardownPublished・本物の main）──────────────────────────────────
describe('★★★ プロジェクトの削除（PD-1）: 共用型の行の段がこの結果になった回は、月額を見せてから2回目の押しで移す', () => {
  let teardownCalls: unknown[][] = []
  let hanamiiCalls: unknown[][] = []
  let twinFactsOn = true

  function installWindow() {
    teardownCalls = []; hanamiiCalls = []; twinFactsOn = true
    const cloud: Record<string, unknown> = {
      teardownRecord: (p: string) => h.handlers.get('cloud:teardownRecord')!({}, p),
      recordTwins: (p: string) => h.handlers.get('cloud:recordTwins')!({}, p),
      teardown: (p: string, auth: unknown, opts: unknown) => { teardownCalls.push([p, auth, opts]); return h.handlers.get('cloud:teardown')!({}, p, auth, opts) },
    }
    // 窓の口は呼ばれた時点で twinFactsOn を見る（口が無い回は、プロパティが無いのと同じ答え）
    Object.defineProperty(cloud, 'twinFacts', { enumerable: true, get: () => twinFactsOn ? (p: string, a: TwinFactsArgs) => twinFactsIpc(p, a) : undefined })
    ;(globalThis as any).window = {
      electronAPI: {
        cloud,
        hanamii: { teardown: async (...a: unknown[]) => { hanamiiCalls.push(a); return { ok: true, executed: [] } } },
        fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
        storage: {
          placement: async (p: string) => {
            const list = JSON.parse(fs.readFileSync(path.join(p, '.sakura-cloud', 'env.json'), 'utf-8'))?.persistence?.objectStorage ?? []
            return { ok: true, placements: list.map((x: any) => ({ bucket: x.bucket, prefix: x.prefix, shared: x.shared })) }
          },
        },
        apprunDedicated: { state: async () => null },
        stageTiming: { estimates: async () => null },
        win: { setBusy: () => {} },
        publishMeta: { runningOp: async () => null },
      },
      dispatchEvent: () => true,
    }
  }
  beforeEach(() => installWindow())

  function fakeAsk() {
    const asked: Array<{ title: string; body: string }> = []
    return {
      asked,
      confirm: async (o: ConfirmOptions) => { asked.push({ title: o.title, body: o.body }); return true },
      confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => { asked.push({ title: o.title, body: o.body }); return resolveConfirmWithChoices('confirm', o.choices, {}) },
    }
  }
  function makeDeps(ask: ReturnType<typeof fakeAsk>) {
    const trashed: string[] = []
    const deps: ProjectDeleteRunDeps = {
      readFacts: readProjectDeleteFacts,
      teardown: (p, ts, o) => teardownPublished(p, ts, { confirm: ask.confirm, confirmWithChoices: ask.confirmWithChoices }, o),
      runningOp: async () => null,
      exists: async () => true,
      trash: async p => { trashed.push(p) },
    }
    return { deps, trashed }
  }
  const resultsHtml = (run: Parameters<typeof ProjectDeleteResults>[0]['run']) => text(renderToStaticMarkup(createElement(ProjectDeleteResults, { run, showBlockNote: true })))
  const REVIEW_HEAD = '破棄は済みましたが、残ったものがあります。'
  const writeSharedRowMeta = () => fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ name: 'myapp', publish: { targets: { 'sakura-apprun': ROW } } }), 'utf-8')

  it('★★★ 共用型の行はあるが state にアプリが無く、保存場所が全部 keep（行のある幽霊の行）: 確認 0・cloud:teardown 0・要求 0 件。phase は review・見出し「⚠️ 破棄していません」・月額の警告・フォルダはまだ移さない。2回目の押しで移る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)] })
    writeSharedRowMeta()
    putTwin([A])
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toMatchObject({ block: null, teardown: ['sakura-apprun'] })
    expect('leftover' in plan, '行がある回は残りの段ではなく、行の段').toBe(false)
    const ask = fakeAsk()
    const { deps, trashed } = makeDeps(ask)

    const r = await runProjectDelete(dir, plan, true, deps)

    expect(ask.asked, '確認が出た').toEqual([])
    expect(teardownCalls, 'cloud:teardown が呼ばれた').toEqual([])
    expect(h.calls, '保存場所・client へ要求が出た').toEqual([])
    expect(r.phase).toBe('review')
    const step = r.steps[0]
    if (step.kind !== 'done') throw new Error('done のはず')
    expect(step).toMatchObject({ target: 'sakura-apprun', kind: 'done' })
    expect(step.view).toMatchObject({ ok: true, state: 'done', keptOnly: true })
    expect(step.view.warnings.length, '月額の警告は残る').toBeGreaterThan(0)
    expect(trashed, '見せてから移す。1回目の押しでは移さない').toEqual([])
    const t = resultsHtml(r)
    expect(t).toContain('⚠️ 破棄していません')
    expect(t).not.toContain('✅ 破棄しました')
    expect(t).not.toContain(REVIEW_HEAD)
    expect(t).toContain('月額495円（税込）')
    expect(t).toContain('「🗑 ゴミ箱に移動」を押すと、フォルダをゴミ箱へ移します。')

    const second = await pressProjectDelete(dir, { plan, run: r, seen: facts }, true, deps)
    expect(second.run.phase).toBe('trashed')
    expect(trashed).toEqual([dir])
    expect(teardownCalls, '2回目の押しで破棄をやり直した').toEqual([])
    expect(ask.asked, '2回目の押しで確認を出した').toEqual([])
  })

  it('★★★ 残りの段の再判定: 開いたときは keep が読めず残りの段が足された回も、押した時点で keep が読めれば、何も消さない確認は出ない（確認 0・IPC 0）。review で見せてから移す', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)] })
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ name: 'myapp', publish: { targets: {} } }), 'utf-8')
    putTwin([A])
    // 開いたとき: 口が無い＝keep を読めない。残りの段（保存場所）が足される。
    twinFactsOn = false
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toMatchObject({ block: null, teardown: ['sakura-apprun'], leftover: { noun: '保存場所' } })
    // 押したとき: keep が読める。読み直した記録（cloud:teardownRecord）には keep が無いので、門（hasWork）は通る。確認を出す前に、流れの門が受け止める。
    twinFactsOn = true
    const ask = fakeAsk()
    const { deps, trashed } = makeDeps(ask)

    const r = await runProjectDelete(dir, plan, true, deps)

    expect(ask.asked, '何も消さない確認（保存場所は残ります／続ける）が出た').toEqual([])
    expect(teardownCalls).toEqual([])
    expect(h.calls).toEqual([])
    expect(r.phase).toBe('review')
    const step = r.steps[0]
    if (step.kind !== 'done') throw new Error('done のはず')
    expect(step).toMatchObject({ target: 'sakura-apprun', kind: 'done', leftover: true, label: '保存場所' })
    expect(step.view).toMatchObject({ ok: true, keptOnly: true })
    expect(resultsHtml(r)).toContain('⚠️ 破棄していません')
    expect(trashed).toEqual([])
    const second = await pressProjectDelete(dir, { plan, run: r, seen: facts }, true, deps)
    expect(second.run.phase).toBe('trashed')
    expect(ask.asked).toEqual([])
  })

  it('★★★ 対照: 押した時点でも keep を読めない（口が無い）回は、今までどおり確認が出る（門は不明を肯定に倒さない）。確認の見出しは「保存場所を破棄します」', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)] })
    fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ name: 'myapp', publish: { targets: {} } }), 'utf-8')
    putTwin([A])
    twinFactsOn = false
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    const ask = fakeAsk()
    const { deps } = makeDeps(ask)

    await runProjectDelete(dir, plan, true, deps)

    expect(ask.asked).toHaveLength(1)
    expect(ask.asked[0].title).toBe('保存場所を破棄します')
    expect(teardownCalls).toHaveLength(1) // main が最後の判断者（複製がいるので何も消さない）
    expect(destructive()).toEqual([])
  })

  it('★★★ HANAMII の段が「何も消さない」で済んだ回: 同じ保存場所の残りの段が、二重に結果を出さない（HANAMII の1段だけ・確認 0・IPC 0）', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)] })
    writeHanamiiMeta([A])
    putTwin([A])
    // 開いたとき: keep を読めず、HANAMII の段の後ろに残りの段（保存場所）が足される。
    twinFactsOn = false
    const facts = await readProjectDeleteFacts(dir)
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toMatchObject({ block: null, teardown: ['hanamii', 'sakura-apprun'], leftover: { noun: '保存場所' } })
    twinFactsOn = true
    const ask = fakeAsk()
    const { deps } = makeDeps(ask)

    const r = await runProjectDelete(dir, plan, true, deps)

    expect(ask.asked).toEqual([])
    expect(hanamiiCalls, 'HANAMII の IPC が呼ばれた').toEqual([])
    expect(teardownCalls, 'cloud:teardown が呼ばれた').toEqual([])
    expect(external).toEqual([])
    const done = r.steps.filter(s => s.kind === 'done')
    expect(done.map(s => s.target), '同じ保存場所の結果が2つ出た').toEqual(['hanamii'])
    const hanamii = done[0]
    if (hanamii.kind !== 'done') throw new Error('done のはず')
    expect(hanamii.view).toMatchObject({ ok: true, keptOnly: true })
    expect(r.phase).toBe('review')
    // 残りの段は、HANAMII の段が済ませた保存場所だけなので走らない（結果の欄を描かない nothingToDo）
    expect(r.steps.map(s => s.kind)).toEqual(['done', 'nothingToDo'])
    const t = resultsHtml(r)
    expect(t.match(/月額495円/g) ?? [], '月額の警告が2回出た').toHaveLength(1)
    expect(t).toContain('⚠️ 破棄していません')
  })
})
