import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階3A（3A-4b）材料: プロジェクトの削除を開いたときに1回読む材料（projectDeleteFacts.ts の readProjectDeleteFacts）──────────────
// 設計書: docs/teardown-unify-plan.md の 10.9.4 の(2)・10.9.13 の「材料」。**読むだけで、何も書かない・外へ要求を出さない・投げない**。
//   targets・unreadable … 公開の読み口（4a。旧い記録の公開先も数える）／ dedicated … 専有型の記録／ placements … 保存場所の全件
//   running … 走っている操作／ sharedLeftover … 共用型の行が無いのに、共用型の記録に消すものがある（10.9.18 の E）
//   sharedRegistry … 共用型の行があるときの、記録のコンテナレジストリ（名前・由来・使っているほかのプロジェクト。2026-10-19、0.6.22-rc.1 の実機）
// 偽の window は、呼ばれた口の名前を log に残す（読む口だけが呼ばれ、registryName は呼ばれないことを見る）。

import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'

afterEach(() => { delete (globalThis as any).window })

const DIR = '/proj'
const META = `${DIR}/.sakuraide.json`
const STATE = `${DIR}/.sakura-cloud/state.json`
const meta = (publish: unknown) => JSON.stringify({ name: 'myapp', publish })
const rec = (over: Record<string, unknown> = {}) => ({ appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [], stateOnlyBuckets: [], ...over })
const PL = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }

type Setup = {
  files?: Record<string, string>
  running?: unknown
  /** 走っているかの答えを、呼ばれた時点で決める（`running` より優先）。公開が途中で終わる世界を作るのに使う。 */
  runningNow?: () => unknown
  /** 公開の記録（fs.exists・fs.readFile）が読まれた直後に呼ぶ。世界を進める（公開が終わって、記録が書かれる）のに使う。 */
  afterRecordRead?: () => void
  dedicated?: unknown
  placement?: unknown
  record?: unknown
}
/** 偽の window。Setup の値が Error なら、その口は投げる。`log` は呼ばれた口の名前。 */
function install(s: Setup = {}) {
  const log: string[] = []
  const reply = (name: string, v: unknown) => { log.push(name); if (v instanceof Error) throw v; return v }
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        exists: async (p: string) => { log.push('fs.exists'); const r = p in (s.files ?? {}); s.afterRecordRead?.(); return r },
        readFile: async (p: string) => { log.push('fs.readFile'); const v = (s.files ?? {})[p]; s.afterRecordRead?.(); if (v === undefined) throw new Error(`ENOENT: ${p}`); return v },
      },
      publishMeta: { runningOp: async () => reply('publishMeta.runningOp', s.runningNow ? s.runningNow() : (s.running ?? null)) },
      apprunDedicated: { state: async () => reply('apprunDedicated.state', 'dedicated' in s ? s.dedicated : null) }, // undefined もそのまま返す
      storage: { placement: async () => reply('storage.placement', s.placement ?? { ok: true, placements: [] }) },
      cloud: {
        teardownRecord: async () => reply('cloud.teardownRecord', s.record ?? { ok: true, record: rec() }),
        registryName: async () => reply('cloud.registryName', { name: 'myreg', adopted: false }),
      },
    },
  }
  return log
}
const read = () => readProjectDeleteFacts(DIR)

describe('材料: 何も無い新しいプロジェクト・読む口の一覧', () => {
  it('★★★ 何も無い: 空の材料。偽の注意（unreadable）を出さない。読む口だけが呼ばれ、書く口・registryName は呼ばれない', async () => {
    const log = install()
    expect(await read()).toEqual({ targets: [], unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null })
    expect(new Set(log)).toEqual(new Set(['fs.exists', 'apprunDedicated.state', 'storage.placement', 'publishMeta.runningOp', 'cloud.teardownRecord']))
    expect(log).not.toContain('cloud.registryName') // 10.9.18 の D: レジストリの名前は読まない
    expect(log).not.toContain('fs.readFile') // 記録のファイルが無いので読みにいかない
  })

  it('★★ window が無い・口が全部投げる: 投げない。公開の記録は読めなかった扱い（unreadable）、ほかは空に倒す', async () => {
    delete (globalThis as any).window
    expect(await read()).toEqual({ targets: [], unreadable: true, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null })
    const boom = new Error('boom')
    install({ running: boom, dedicated: boom, placement: boom, record: boom })
    expect(await read()).toEqual({ targets: [], unreadable: true, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null })
  })
})

describe('材料: 公開先・走っている操作・専有型・保存場所', () => {
  it('★★★ 公開先は旧い記録の分も数える（publish.targets ∪ HANAMII の projectId ∪ state.json の共用型）。読めた分は落とさない', async () => {
    install({ files: { [META]: meta({ hanamii: { projectId: 'hnm-1' }, targets: { vercel: { publishedAt: '2026-10-01T00:00:00.000Z' } } }), [STATE]: JSON.stringify({ resources: [{ kind: 'apprun-app', id: 'app-1' }] }) } })
    expect(await read()).toMatchObject({ targets: ['hanamii', 'vercel', 'sakura-apprun'], unreadable: false })
    install({ files: { [META]: meta({ hanamii: { projectId: 'hnm-1' } }), [STATE]: '{ 壊れた' } }) // state.json だけが壊れた
    expect(await read()).toMatchObject({ targets: ['hanamii'], unreadable: true })
  })

  it.each(['作成', '削除', '公開'] as const)('★★★ running: 聞いた操作（%s）を、公開先ごとそのまま入れる。null なら null。聞けなければ null', async (op) => {
    install({ running: { op, target: 'sakura-apprun' } })
    expect((await read()).running).toEqual({ op, target: 'sakura-apprun' })
    install({ running: null })
    expect((await read()).running).toBeNull()
    install({ running: new Error('聞けない') })
    expect((await read()).running).toBeNull()
  })

  it('★★★ 走っている操作を、公開の記録・専有型・保存場所より先に聞く（projectMeta.ts の loadPublishSnapshot と同じ順序）', async () => {
    const log = install({ files: { [META]: meta({ targets: { vercel: { publishedAt: '2026-10-01T00:00:00.000Z' } } }), [STATE]: JSON.stringify({ resources: [] }) } })
    await read()
    expect(log[0]).toBe('publishMeta.runningOp')
    const later = ['fs.exists', 'fs.readFile', 'apprunDedicated.state', 'storage.placement', 'cloud.teardownRecord']
    for (const name of later) expect(log.indexOf(name), name).toBeGreaterThan(log.indexOf('publishMeta.runningOp'))
    const failing = install({ running: new Error('聞けない'), files: { [META]: meta({ targets: {} }) } })
    await read()
    expect(failing[0], '聞けなかった回も、先に聞く').toBe('publishMeta.runningOp')
  })

  it('★★★ 公開の記録を読む直前に初回の公開が終わっても、「公開なし・走っていない」と読まない（先に聞いた「走っている」が残り、止める）', async () => {
    // 世界: 初回の公開が走っている（記録はまだ無い）。記録を読んだ直後に公開が終わり、記録が書かれ、走っていない状態になる。
    const files: Record<string, string> = {}
    let publishing = true
    const log = install({
      files,
      runningNow: () => (publishing ? { op: '公開', target: 'sakura-apprun' } : null),
      afterRecordRead: () => {
        if (!publishing) return
        publishing = false
        files[META] = meta({ targets: { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z' } } })
      },
    })
    const facts = await read()
    expect(log[0]).toBe('publishMeta.runningOp')
    expect(facts.running, '先に聞いた答えが残る。あとから聞くと null になり、行の無い記録と合わせて「公開なし」と読んでしまう').toEqual({ op: '公開', target: 'sakura-apprun' })
    expect(planProjectDeleteTeardown(facts).block).toEqual({ reason: 'running', op: '公開', target: 'sakura-apprun' })
  })

  it('★★★ dedicated: 専有型の記録をそのまま入れる。null・undefined・投げたは null（止める判断は targets 側が残る）', async () => {
    const record = { clusterID: 'c-1', storageLeftoverBucket: 'koto-x' }
    install({ dedicated: record })
    expect((await read()).dedicated).toEqual(record)
    install({ dedicated: undefined })
    expect((await read()).dedicated).toBeNull()
    install({ dedicated: new Error('読めない') })
    expect((await read()).dedicated).toBeNull()
  })

  it('★★★ placements: 全件（bucket・prefix・shared だけ）。1件の形でも読む。ok:false・投げたは []', async () => {
    install({ placement: { ok: true, placements: [{ ...PL, consentedAt: '2026-08-14T00:00:00.000Z' }, { bucket: 'koto-data-b', prefix: 'p/', shared: false }] } })
    expect((await read()).placements).toEqual([PL, { bucket: 'koto-data-b', prefix: 'p/', shared: false }])
    install({ placement: { ok: true, placement: PL } })
    expect((await read()).placements).toEqual([PL])
    install({ placement: { ok: false, message: '読めない', placements: [{ bucket: 'koto-unsure', prefix: 'p', shared: false }] } }) // ok:false の答えの中身は使わない
    expect((await read()).placements).toEqual([])
    install({ placement: new Error('読めない') })
    expect((await read()).placements).toEqual([])
  })
})

describe('材料: 共用型の残りだけがあるプロジェクト（10.9.18 の E）', () => {
  it('★★★ 共用型の行が無いのに、記録に保存場所／レジストリがある: sharedLeftover に名前と保存場所が入る。unreadable は立たない', async () => {
    install({ record: { ok: true, record: rec({ placements: [PL], registryName: 'myreg' }) } })
    expect(await read()).toMatchObject({ targets: [], unreadable: false, sharedLeftover: { registryName: 'myreg', placements: [PL] } })
    install({ record: { ok: true, record: rec({ placements: [PL] }) } })
    expect((await read()).sharedLeftover).toEqual({ registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [PL] })
    install({ record: { ok: true, record: rec({ registryName: 'myreg' }) } })
    expect((await read()).sharedLeftover).toEqual({ registryName: 'myreg', registryOrigin: 'unknown', registryUsers: [], placements: [] })
  })

  it('★★★ レジストリの由来（owned・adopted・unknown）と、使っているほかのプロジェクトを、そのまま入れる（月額を言ってよいかの材料。書き換えない）', async () => {
    for (const origin of ['owned', 'adopted', 'unknown'] as const) {
      install({ record: { ok: true, record: rec({ registryName: 'myreg', registryOrigin: origin, registryUsers: ['reminder', 'landing'] }) } })
      expect((await read()).sharedLeftover, origin).toEqual({ registryName: 'myreg', registryOrigin: origin, registryUsers: ['reminder', 'landing'], placements: [] })
    }
  })

  it('★★★ 共用型の行がある（publish.targets・state.json のどちらでも）: 残りの文の材料（sharedLeftover）は null。記録は 1 回だけ読む（レジストリの材料のため）', async () => {
    const withRecord = { record: { ok: true, record: rec({ placements: [PL], registryName: 'myreg' }) } }
    const a = install({ ...withRecord, files: { [META]: meta({ targets: { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z' } } }) } })
    expect(await read()).toMatchObject({ targets: ['sakura-apprun'], sharedLeftover: null })
    expect(a.filter(n => n === 'cloud.teardownRecord')).toHaveLength(1)
    const b = install({ ...withRecord, files: { [STATE]: JSON.stringify({ resources: [{ kind: 'apprun-app', id: 'app-1' }] }) } })
    expect(await read()).toMatchObject({ targets: ['sakura-apprun'], sharedLeftover: null })
    expect(b.filter(n => n === 'cloud.teardownRecord')).toHaveLength(1)
  })

  it('★★★ 記録が空（何も無い）: null・unreadable は立たない', async () => {
    install({ record: { ok: true, record: rec() } })
    expect(await read()).toMatchObject({ sharedLeftover: null, unreadable: false })
  })

  it('★★★ 記録を読めない（ok:false・投げた・形が違う）: sharedLeftover は null、unreadable を立てる（読めなかったことを黙らない）', async () => {
    for (const record of [{ ok: false, message: 'env.json がありません' }, new Error('IPC が落ちた'), { ok: true, record: { appNames: 'x' } }, undefined]) {
      install(record === undefined ? { record: { ok: false } } : { record })
      expect(await read(), JSON.stringify(record)).toMatchObject({ sharedLeftover: null, unreadable: true })
    }
  })

  it('★★ 公開の記録が読めなかった回でも、読めた分（unreadable）を保ったまま共用型の残りを見る', async () => {
    install({ files: { [META]: '{ 壊れた' }, record: { ok: true, record: rec({ placements: [PL] }) } })
    expect(await read()).toMatchObject({ targets: [], unreadable: true, sharedLeftover: { registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [PL] } })
  })
})

describe('材料: 共用型の行があるときのコンテナレジストリ（sharedRegistry。「公開も一緒に破棄する」を外したときの月額の材料）', () => {
  const ROW = { files: { [META]: meta({ targets: { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z' } } }) } }

  it('★★★ 記録のレジストリの名前・由来・使っているほかのプロジェクトを、そのまま入れる（owned・adopted・unknown のどれも。由来を書き換えない）', async () => {
    for (const origin of ['owned', 'adopted', 'unknown'] as const) {
      install({ ...ROW, record: { ok: true, record: rec({ registryName: 'myreg', registryOrigin: origin, registryUsers: ['reminder', 'landing'] }) } })
      expect((await read()).sharedRegistry, origin).toEqual({ registryName: 'myreg', origin, users: ['reminder', 'landing'] })
    }
    install({ ...ROW, record: { ok: true, record: rec({ registryName: 'myreg', registryOrigin: 'owned' }) } })
    expect((await read()).sharedRegistry).toEqual({ registryName: 'myreg', origin: 'owned', users: [] })
  })

  it('★★★ 作者の実例の形（.sakura-cloud が無く、共用型の行だけ。main の答えは空の記録）: レジストリは無い（null）。偽の注意（unreadable）も出さない', async () => {
    install({ ...ROW, record: { ok: true, record: rec() } })
    expect(await read()).toMatchObject({ targets: ['sakura-apprun'], sharedRegistry: null, sharedLeftover: null, unreadable: false })
  })

  it('★★★ 記録を読めない（ok:false・投げた・形が違う）: null（月額を言わない側）。行は読めているので unreadable は立てない', async () => {
    for (const record of [{ ok: false, message: 'env.json がありません' }, new Error('IPC が落ちた'), { ok: true, record: { appNames: 'x' } }, { ok: true, record: rec({ registryOrigin: 'まちがい', registryName: 'myreg' }) }]) {
      install({ ...ROW, record })
      expect(await read(), JSON.stringify(record)).toMatchObject({ targets: ['sakura-apprun'], sharedRegistry: null, unreadable: false })
    }
  })

  it('★★ 共用型の行が無い回は、記録にレジストリがあっても sharedRegistry は null（その回は sharedLeftover が言う）', async () => {
    install({ record: { ok: true, record: rec({ registryName: 'myreg', registryOrigin: 'owned' }) } })
    expect(await read()).toMatchObject({ targets: [], sharedRegistry: null, sharedLeftover: { registryName: 'myreg', placements: [] } })
  })
})

describe('材料: 判断（planProjectDeleteTeardown）に通すと、旧い記録だけの公開先も先に破棄する対象になる', () => {
  it('★★★ HANAMII の projectId だけ・共用型の state.json だけ → teardown は HANAMII → 共用型。専有型の ID だけ → 止める', async () => {
    install({ files: { [META]: meta({ hanamii: { projectId: 'hnm-1' } }), [STATE]: JSON.stringify({ resources: [{ kind: 'apprun-app', id: 'app-1' }] }) } })
    expect(planProjectDeleteTeardown(await read())).toEqual({ block: null, teardown: ['hanamii', 'sakura-apprun'] })
    install({ files: { [META]: meta({ apprunDedicated: { clusterID: 'c-1' } }) }, dedicated: { clusterID: 'c-1' } })
    expect(planProjectDeleteTeardown(await read())).toMatchObject({ block: { reason: 'dedicated' } })
    install({ running: { op: '公開', target: 'hanamii' } })
    expect(planProjectDeleteTeardown(await read())).toMatchObject({ block: { reason: 'running', op: '公開', target: 'hanamii' } })
  })
})

describe('材料 配線: 読むだけのファイル。手本・仕様書・IPC を直接は持たない', () => {
  const ROOT = path.join(__dirname, '..')
  const raw = fs.readFileSync(path.join(ROOT, 'src/renderer/teardown/projectDeleteFacts.ts'), 'utf-8')
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

  it('★★ 150行以下。仕様書（sharedTeardownSpec・hanamiiTeardownSpec）・teardownRecord の直接呼び・.invoke(・手本・registryName を持たない', () => {
    expect(raw.split('\n').length).toBeLessThanOrEqual(150)
    for (const w of ['sharedTeardownSpec', 'hanamiiTeardownSpec', 'electronAPI.cloud', '.invoke(', 'dedicatedTeardownFlow', 'apprunDedicatedActions', 'registryName(', 'writeFile', 'clearPublishRecord']) expect(code, w).not.toContain(w)
  })

  it('★★ 共用型の記録は readSharedTeardownRecord（targets/shared.ts）で読み、「消すものがあるか」は sharedTeardownHasWork に任せる（判断を2つ持たない）', () => {
    expect(code).toContain('await readSharedTeardownRecord(dir)')
    expect(code).toContain('sharedTeardownHasWork(rec)')
    expect(code).toContain("const hasSharedRow = targets.includes('sakura-apprun')")
    expect(code).toContain('if (!hasSharedRow) unreadable = true')
  })

  it('★★ 共用型の仕様書の hasWork は sharedTeardownHasWork を指す（材料と仕様書が同じ判断を使う。2つ書かない）', () => {
    const spec = fs.readFileSync(path.join(ROOT, 'src/renderer/teardown/targets/shared.ts'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
    expect(spec).toContain('export const sharedTeardownHasWork = (r: SharedTeardownRecord): boolean =>')
    expect(spec).toContain('hasWork: sharedTeardownHasWork,')
    expect(spec.match(/appNames\.length > 0 \|\| !!r\.registryName/g)).toHaveLength(1)
  })
})
