import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── T-I6（材料）: プロジェクトの削除を開いたときに、複製（同じ公開の記録を持つ別のフォルダ）を1回読む（0.6.24 I-3・作者の決定 K1）────────────────
//   ・readRecordTwins（teardown/readTwins.ts）: main の cloud:recordTwins の答えを、形を確かめて受け取る。**読めなかった・形が違う回は null**
//     （空の配列に直さない。null は plan が「何も外さない」側に倒す印。tests/projectDeleteTwinsPlan.test.ts）
//   ・readProjectDeleteFacts: facts.twins に入れる。読む口の一覧に cloud.recordTwins が1回だけ加わり、書く口は呼ばれない。走っているかを先に聞く順序は変わらない
//   ・実フォルダ通し: 本物の main の cloud:recordTwins・cloud:teardownRecord と本物の読み口で、複製のフォルダの材料を読み、plan → 流れまで通す。
//     複製を削除したあと、残ったほうからは破棄できる（usage-guide の「片方を削除するまで」）

const m = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { m.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

import { registerCloudTeardownHandlers } from '../src/main/ipc/cloudTeardown'
import { readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { readRecordTwins } from '../src/renderer/teardown/readTwins'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import { pressProjectDelete } from '../src/renderer/teardown/projectDelete'
import { harness } from './projectDeleteRunHarness'

afterEach(() => { delete (globalThis as any).window })

const DIR = '/proj'
const GOOD = { hanamii: ['rc24-h'], 'sakura-apprun': [], 'sakura-apprun-dedicated': ['rc24-d', 'rc24-e'] }

describe('★★★ readRecordTwins: main の答えを、形を確かめて受け取る', () => {
  const withApi = (recordTwins: unknown) => { (globalThis as any).window = { electronAPI: { cloud: { recordTwins } } } }

  it('★★★ ok:true で3つの公開先がどれも名前の配列: そのまま返す（コピー）。口は projectDir を1つだけ受けて1回呼ぶ', async () => {
    const calls: unknown[][] = []
    withApi(async (...a: unknown[]) => { calls.push(a); return { ok: true, twins: GOOD } })
    const r = await readRecordTwins(DIR)
    expect(r).toEqual(GOOD)
    expect(r).not.toBe(GOOD)
    expect(r!.hanamii).not.toBe(GOOD.hanamii)
    expect(calls).toEqual([[DIR]])
  })

  it('★★★ 複製が1つも無い答え（3つとも空）は、空のまま返す（null ではない。「確かめて、いなかった」）', async () => {
    withApi(async () => ({ ok: true, twins: { hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] } }))
    expect(await readRecordTwins(DIR)).toEqual({ hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] })
  })

  it.each([
    ['ok:false', { ok: false, message: 'プロジェクトフォルダが不正です' }],
    ['ok が無い', { twins: GOOD }],
    ["ok:'true'（文字列）", { ok: 'true', twins: GOOD }],
    ['twins が無い', { ok: true }],
    ['twins が null', { ok: true, twins: null }],
    ['twins が配列', { ok: true, twins: [] }],
    ['twins が文字列', { ok: true, twins: 'x' }],
    ['HANAMII が無い', { ok: true, twins: { 'sakura-apprun': [], 'sakura-apprun-dedicated': [] } }],
    ['共用型が配列でない', { ok: true, twins: { hanamii: [], 'sakura-apprun': 'x', 'sakura-apprun-dedicated': [] } }],
    ['専有型が無い', { ok: true, twins: { hanamii: [], 'sakura-apprun': [] } }],
    ['名前に数字', { ok: true, twins: { hanamii: [1], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] } }],
    ['名前に空文字', { ok: true, twins: { hanamii: [''], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] } }],
    ['名前に null', { ok: true, twins: { hanamii: [null], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] } }],
    ['null', null],
    ['undefined', undefined],
    ['文字列', 'ok'],
  ])('★★★ 形が違う答え（%s）→ null（外さない側。空の配列に直さない）', async (_name, answer) => {
    withApi(async () => answer)
    expect(await readRecordTwins(DIR)).toBeNull()
  })

  it('★★★ 口が投げる・window が無い・cloud が無い・recordTwins が関数でない → null（投げない）', async () => {
    withApi(async () => { throw new Error('IPC が落ちた') })
    expect(await readRecordTwins(DIR)).toBeNull()
    withApi(() => { throw new Error('同期で落ちた') })
    expect(await readRecordTwins(DIR)).toBeNull()
    withApi(undefined)
    expect(await readRecordTwins(DIR)).toBeNull()
    withApi('x')
    expect(await readRecordTwins(DIR)).toBeNull()
    ;(globalThis as any).window = { electronAPI: {} }
    expect(await readRecordTwins(DIR)).toBeNull()
    delete (globalThis as any).window
    expect(await readRecordTwins(DIR)).toBeNull()
  })
})

describe('★★★ readProjectDeleteFacts: facts.twins', () => {
  const META = `${DIR}/.sakuraide.json`
  /** 偽の window。log は呼ばれた口の名前。recordTwins の答えは引数で決める。 */
  function install(recordTwins: () => unknown) {
    const log: string[] = []
    ;(globalThis as any).window = {
      electronAPI: {
        fs: {
          exists: async (p: string) => { log.push('fs.exists'); return p === META },
          readFile: async (p: string) => { log.push('fs.readFile'); if (p !== META) throw new Error(`ENOENT: ${p}`); return JSON.stringify({ publish: { hanamii: { projectId: 'prj-1' } } }) },
        },
        publishMeta: { runningOp: async () => { log.push('publishMeta.runningOp'); return null } },
        apprunDedicated: { state: async () => { log.push('apprunDedicated.state'); return null } },
        storage: { placement: async () => { log.push('storage.placement'); return { ok: true, placements: [] } } },
        cloud: {
          teardownRecord: async () => { log.push('cloud.teardownRecord'); return { ok: true, record: { appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [], stateOnlyBuckets: [] } } },
          recordTwins: async (...a: unknown[]) => { log.push(`cloud.recordTwins:${a.join(',')}`); return recordTwins() },
        },
      },
    }
    return log
  }

  it('★★★ twins に、main の答えをそのまま入れる。読む口の一覧に cloud.recordTwins が projectDir つきで1回だけ加わる。走っているかを先に聞く順序はそのまま', async () => {
    const log = install(() => ({ ok: true, twins: GOOD }))
    const facts = await readProjectDeleteFacts(DIR)
    expect(facts.twins).toEqual(GOOD)
    expect(facts.targets).toEqual(['hanamii']) // 材料の残りは変わらない
    expect(log.filter(n => n.startsWith('cloud.recordTwins'))).toEqual([`cloud.recordTwins:${DIR}`])
    expect(log[0]).toBe('publishMeta.runningOp')
    expect(log.indexOf(`cloud.recordTwins:${DIR}`)).toBeGreaterThan(log.indexOf('publishMeta.runningOp'))
    expect(new Set(log.map(n => n.split(':')[0]))).toEqual(new Set(['fs.exists', 'fs.readFile', 'publishMeta.runningOp', 'apprunDedicated.state', 'storage.placement', 'cloud.teardownRecord', 'cloud.recordTwins']))
  })

  it('★★★ 読めなかった（ok:false・投げた・形が違う）: twins は null。ほかの材料は読めたまま。unreadable は立てない（複製が分からないことは、公開の記録が読めないことではない）', async () => {
    for (const answer of [{ ok: false, message: 'x' }, new Error('IPC が落ちた'), { ok: true, twins: { hanamii: 'x' } }, undefined]) {
      install(() => { if (answer instanceof Error) throw answer; return answer })
      const facts = await readProjectDeleteFacts(DIR)
      expect(facts.twins, String(JSON.stringify(answer))).toBeNull()
      expect(facts).toMatchObject({ targets: ['hanamii'], unreadable: false })
    }
  })

  it('★★★ 複製が無いと確かめられた答え（空の3つ）は、null ではなく空の3つ（plan は「複製なし」と読み、読めなかった null とは区別する）', async () => {
    install(() => ({ ok: true, twins: { hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] } }))
    expect((await readProjectDeleteFacts(DIR)).twins).toEqual({ hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] })
  })
})

describe('★★★ 実フォルダ通し: 本物の main の cloud:recordTwins・cloud:teardownRecord と本物の読み口 → plan → 流れ', () => {
  let ws = ''
  beforeEach(() => {
    m.handlers.clear()
    registerCloudTeardownHandlers()
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-twins-facts-')))
  })
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }) })

  const meta = (extra: Record<string, unknown> = {}) => ({ name: 'myapp', publish: { hanamii: { projectId: 'prj-1' }, targets: { hanamii: { publishedAt: '2026-10-19T00:00:00.000Z' } }, ...extra } })
  const stateOf = (appId: string) => ({ name: 'myapp', backend: 'apprun', resources: [{ kind: 'apprun-app', id: appId, key: 'apprun-app:myapp', stateful: false }] })
  function project(name: string, files: { meta?: unknown; state?: unknown }): string {
    const dir = path.join(ws, name)
    fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
    if (files.meta !== undefined) fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify(files.meta))
    if (files.state !== undefined) fs.writeFileSync(path.join(dir, '.sakura-cloud', 'state.json'), JSON.stringify(files.state))
    return dir
  }
  /** 画面の window。記録を読む口は実フォルダ、複製・共用型の記録の口は本物の main のハンドラ。 */
  function installReal() {
    ;(globalThis as any).window = {
      electronAPI: {
        fs: {
          exists: async (p: string) => fs.existsSync(p),
          readFile: async (p: string) => fs.readFileSync(p, 'utf-8'),
        },
        publishMeta: { runningOp: async () => null },
        apprunDedicated: { state: async (d: string) => readApprunDedicatedFs(d) },
        storage: { placement: async () => ({ ok: true, placements: [] }) },
        cloud: {
          teardownRecord: async (d: string) => m.handlers.get('cloud:teardownRecord')!({}, d),
          recordTwins: async (d: string) => m.handlers.get('cloud:recordTwins')!({}, d),
        },
      },
    }
  }

  it('★★★ 複製のフォルダの材料: 元のフォルダ名が twins に入り、plan は HANAMII・共用型を破棄から外す。流れは破棄の要求0回でフォルダだけ移す', async () => {
    const orig = project('rc24-h', { meta: meta(), state: stateOf('app-1') })
    const copy = project('rc24-h copy', { meta: meta(), state: stateOf('app-1') })
    installReal()
    const facts = await readProjectDeleteFacts(copy)
    expect(facts.targets).toEqual(['hanamii', 'sakura-apprun'])
    expect(facts.twins).toEqual({ hanamii: ['rc24-h'], 'sakura-apprun': ['rc24-h'], 'sakura-apprun-dedicated': [] })
    const plan = planProjectDeleteTeardown(facts)
    expect(plan).toEqual({ block: null, teardown: [], twinned: [{ target: 'hanamii', folders: ['rc24-h'] }, { target: 'sakura-apprun', folders: ['rc24-h'] }] })
    const { h, deps } = harness({ nextFacts: facts })
    const r = await pressProjectDelete(copy, { plan, run: null, seen: facts }, true, deps)
    expect(r.run.phase).toBe('trashed')
    expect(h.teardownTargets, '複製のある公開先の破棄は出ない').toEqual([])
    expect(h.trashed).toEqual([copy])
    expect(fs.existsSync(orig), '元は残る').toBe(true)
  })

  it('★★★ 元のフォルダの材料も同じ（複製がいる間は、どちらからも破棄しない）。複製を削除したあとは、残ったほうから破棄できる', async () => {
    const orig = project('rc24-h', { meta: meta(), state: stateOf('app-1') })
    const copy = project('rc24-h copy', { meta: meta(), state: stateOf('app-1') })
    installReal()
    const both = planProjectDeleteTeardown(await readProjectDeleteFacts(orig))
    expect(both.teardown).toEqual([])
    expect(both.twinned.map(t => t.target)).toEqual(['hanamii', 'sakura-apprun'])
    expect(both.twinned.map(t => t.folders)).toEqual([['rc24-h copy'], ['rc24-h copy']])
    fs.rmSync(copy, { recursive: true, force: true }) // 複製をゴミ箱へ移した（フォルダが無くなる）
    const alone = planProjectDeleteTeardown(await readProjectDeleteFacts(orig))
    expect(alone).toEqual({ block: null, teardown: ['hanamii', 'sakura-apprun'], twinned: [] })
    const { h, deps } = harness()
    await pressProjectDelete(orig, { plan: alone, run: null, seen: await readProjectDeleteFacts(orig) }, true, deps)
    expect(h.teardownTargets).toEqual([['hanamii', 'sakura-apprun']])
  })

  it('★★★ 識別子が違う兄弟（別のプロジェクト）・同じレジストリ名だけの兄弟は複製ではない: 破棄の対象のまま（K1）', async () => {
    const mine = project('mine', { meta: meta(), state: { ...stateOf('app-1'), meta: { registryName: 'myreg' } } })
    project('other', { meta: { name: 'other', publish: { hanamii: { projectId: 'prj-2' }, targets: { hanamii: { publishedAt: '2026-10-19T00:00:00.000Z' } } } }, state: { ...stateOf('app-2'), meta: { registryName: 'myreg' } } })
    installReal()
    const facts = await readProjectDeleteFacts(mine)
    expect(facts.twins).toEqual({ hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] })
    expect(planProjectDeleteTeardown(facts)).toEqual({ block: null, teardown: ['hanamii', 'sakura-apprun'], twinned: [] })
  })

  it('★★★ 専有型: 複製がいれば止めを外してフォルダを移す。複製が無ければ止める', async () => {
    const rec = { applicationID: 'ap-1', clusterID: 'cl-1', loadBalancerID: 'lb-1', asgID: 'asg-1' }
    const orig = project('rc24-d', { meta: { name: 'd', publish: { apprunDedicated: rec, targets: { 'sakura-apprun-dedicated': { publishedAt: '2026-10-19T00:00:00.000Z' } } } } })
    installReal()
    expect(planProjectDeleteTeardown(await readProjectDeleteFacts(orig)).block).toEqual({ reason: 'dedicated' })
    const copy = project('rc24-d copy', { meta: { name: 'd', publish: { apprunDedicated: { clusterID: 'cl-1' } } } })
    const facts = await readProjectDeleteFacts(copy)
    const plan = planProjectDeleteTeardown(facts)
    expect(plan.block).toBeNull()
    expect(plan.twinned).toEqual([{ target: 'sakura-apprun-dedicated', folders: ['rc24-d'] }])
    const { h, deps } = harness({ nextFacts: facts })
    expect((await pressProjectDelete(copy, { plan, run: null, seen: facts }, true, deps)).run.phase).toBe('trashed')
    expect(h.teardownTargets).toEqual([])
  })
})
