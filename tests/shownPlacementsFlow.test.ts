import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── T-F6（0.6.24 F-1・F-2）: 画面が「確認で見せた保存場所（名前と prefix の組）」を、3つの公開先の IPC の opts に載せて運ぶ ──────────────
// 仕様: docs/v0624-aefi-spec.md の F-1（flow.ts の shownPlacementsOf・3つの仕様書の invoke）・F-2（3点セット）・F-6（'call' の文）。
//   ・画面は運ぶだけ。何を消すか（見せていないものは消さない）は main の判断で、tests/shownPlacementsRealMain.test.ts が本物の main に通す。
//   ・「見せた」は、確認の 💾 の段落が名指しする保存場所＝`facts.placements` と一致する（confirm.ts の buildTeardownConfirmBody）。
//   ・保存場所の設定を読めなかった回（settings・call）は、何も見せていないので `[]`。それでも破棄そのもの（アプリなど）は進む。
//   ・opts は選択つきの確認（共用型のレジストリ）の回にも、選択の無い回にも、同じ値が載る（flow.ts の2つの opts の組み立て）。
// 3つの IPC の口（cloud.teardown・hanamii.teardown・apprunDedicated.teardown）に実際に届いた値を見る（ソースの文字列は読まない・掟10）。

vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))

import { runTeardownFlow, electronFlowDeps, shownPlacementsOf } from '../src/renderer/teardown/flow'
import { sharedTeardownSpec, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec, type DedicatedTeardownRecord } from '../src/renderer/teardown/targets/dedicated'
import { buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import type { TargetSpec, TeardownFacts, TeardownPlacement } from '../src/renderer/teardown/types'
import type { ConfirmWithChoicesAnswer, ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { runTeardownShell, type TeardownShellSpec } from '../src/main/cloud/teardownShell'
import { resetProjectOpsForTests } from '../src/main/projectOps'

const A: TeardownPlacement = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
const B: TeardownPlacement = { bucket: 'koto-data-b', prefix: 'projects/other/', shared: false }
/** prefix の無い保存場所（`''` として運ぶ）。 */
const NO_PREFIX: TeardownPlacement = { bucket: 'koto-data-c' }

const SHARED_RECORD: SharedTeardownRecord = {
  appNames: ['myapp'], registryName: null, registryOrigin: 'owned', registryUsers: [], placements: [], stateOnlyBuckets: [],
}
const SHARED_RECORD_WITH_REGISTRY: SharedTeardownRecord = { ...SHARED_RECORD, registryName: 'myreg' }
const HANAMII_RECORD: HanamiiTeardownRecord = { projectId: 'p-1', name: 'myapp', tokenId: 'tok-1', storageLeftoverBuckets: null }
const DEDICATED_RECORD: DedicatedTeardownRecord = { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1', applicationName: 'myapp' }

type Door = 'cloud' | 'hanamii' | 'apprunDedicated'
let ipc: Array<{ door: Door; dir: string; opts: any }> = []

function installWindow() {
  ipc = []
  const reply = (door: Door) => async (dir: string, _auth: unknown, opts: unknown) => { ipc.push({ door, dir, opts }); return { ok: true, executed: [], message: '', remaining: {} } }
  ;(globalThis as any).window = {
    electronAPI: {
      cloud: { teardown: reply('cloud'), loadKey: async () => ({ token: 't', secret: 's' }) },
      hanamii: { teardown: reply('hanamii') },
      apprunDedicated: { teardown: reply('apprunDedicated'), onTeardownProgress: () => () => {} },
      win: { setBusy: () => {} },
    },
  }
}
afterEach(() => { delete (globalThis as any).window })

type Case = { name: string; door: Door; spec: TargetSpec<any, any, any>; record: unknown }
const CASES: Case[] = [
  { name: '共用型', door: 'cloud', spec: sharedTeardownSpec, record: SHARED_RECORD },
  { name: 'HANAMII', door: 'hanamii', spec: hanamiiTeardownSpec, record: HANAMII_RECORD },
  { name: '専有型', door: 'apprunDedicated', spec: dedicatedTeardownSpec, record: DEDICATED_RECORD },
]

function factsOf(record: unknown, over: Partial<TeardownFacts<any>> = {}): TeardownFacts<any> {
  return {
    projectName: 'myapp', record, placements: [], placementsUnreadable: false, placementsUnreadableCause: null,
    otherTargets: [], otherTargetsUnreadable: false, waitNote: null, ...over,
  }
}

/** 本物の流れ（runTeardownFlow）と本物の deps の組み立て（electronFlowDeps）に、材料だけを差し替えて通す。確認の文は残す。 */
async function runFlow(c: Case, facts: TeardownFacts<any>, answer: boolean | ConfirmWithChoicesAnswer = true) {
  installWindow()
  const asked: ConfirmOptions[] = []
  const askedWithChoices: ConfirmWithChoicesOptions[] = []
  const entry = {
    confirm: async (o: ConfirmOptions) => { asked.push(o); return answer as boolean },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions) => { askedWithChoices.push(o); return answer as ConfirmWithChoicesAnswer },
    keyMissingMessage: 'キーがありません（テスト）',
  }
  const deps = { ...electronFlowDeps('/proj', c.spec, entry), loadFacts: async () => facts }
  const out = await runTeardownFlow('/proj', c.spec, deps)
  return { out, asked, askedWithChoices }
}

describe('shownPlacementsOf: 確認で見せた保存場所（名前と prefix の組）を作る1つの関数', () => {
  it('★★★ 読めた回は、確認が名指しする保存場所を、名前と prefix の組にして順に返す。prefix が無いものは \'\'。shared など余計な項目は運ばない', () => {
    expect(shownPlacementsOf(factsOf(null, { placements: [A, B, NO_PREFIX] }))).toStrictEqual([
      { bucket: 'koto-data-a', prefix: 'projects/myapp/' },
      { bucket: 'koto-data-b', prefix: 'projects/other/' },
      { bucket: 'koto-data-c', prefix: '' },
    ])
    expect(shownPlacementsOf(factsOf(null))).toStrictEqual([])
  })

  it('★★★ 保存場所の設定を読めなかった回（settings・call・理由なし）は、placements に何が入っていても []（何も見せていない。不明を「全部見せた」に倒さない）', () => {
    for (const cause of ['settings', 'call', null] as const) {
      expect(shownPlacementsOf(factsOf(null, { placements: [A, B], placementsUnreadable: true, placementsUnreadableCause: cause })), String(cause)).toStrictEqual([])
    }
  })

  it('★★ 確認の段落が数えない要素（null・名前の無いもの・名前が文字列でないもの）は、見せていないので入れない。形の違う prefix は \'\'（消す範囲を広げない）', () => {
    const weird = [null, undefined, { bucket: '' }, { bucket: 5 }, A, { bucket: 'koto-data-d', prefix: 7 }] as unknown as TeardownPlacement[]
    expect(shownPlacementsOf(factsOf(null, { placements: weird }))).toStrictEqual([
      { bucket: 'koto-data-a', prefix: 'projects/myapp/' },
      { bucket: 'koto-data-d', prefix: '' },
    ])
  })

  it('★★ 見せた保存場所は、確認の 💾 の段落が名指しした保存場所と一致する（確認の本文に出た名前＝運んだ名前）', () => {
    for (const c of CASES) {
      const facts = factsOf(c.record, { placements: [A, B, NO_PREFIX] })
      const body = buildTeardownConfirm(c.spec, facts).body
      const shown = shownPlacementsOf(facts).map(p => p.bucket)
      expect(shown, c.name).toEqual(['koto-data-a', 'koto-data-b', 'koto-data-c'])
      expect(body, c.name).toContain('保存場所『koto-data-a』『koto-data-b』『koto-data-c』にある、このプロジェクトのデータ')
    }
  })
})

describe.each(CASES)('T-F6 $name: 流れ → 仕様書の invoke → IPC の口に、確認で見せた組がそのまま届く', c => {
  it('★★★ 読めた回: IPC は1回。opts は { confirmed:true, shownPlacements: facts の組 }。選択・projectId など公開先ごとの項目は別に残る', async () => {
    const facts = factsOf(c.record, { placements: [A, B, NO_PREFIX] })
    const { out } = await runFlow(c, facts)
    expect(out.cancelled).toBe(false)
    expect(ipc).toHaveLength(1)
    expect(ipc[0].door).toBe(c.door)
    expect(ipc[0].dir).toBe('/proj')
    expect(ipc[0].opts.confirmed).toBe(true)
    expect(ipc[0].opts.shownPlacements).toStrictEqual([
      { bucket: 'koto-data-a', prefix: 'projects/myapp/' },
      { bucket: 'koto-data-b', prefix: 'projects/other/' },
      { bucket: 'koto-data-c', prefix: '' },
    ])
  })

  it('★★★ 保存場所の設定を読めなかった回（settings・call）: shownPlacements は []。それでも破棄そのものは進む（IPC は1回）', async () => {
    for (const cause of ['settings', 'call'] as const) {
      const facts = factsOf(c.record, { placements: [], placementsUnreadable: true, placementsUnreadableCause: cause })
      const { out } = await runFlow(c, facts)
      expect(out.cancelled, cause).toBe(false)
      expect(ipc, cause).toHaveLength(1)
      expect(ipc[0].opts.shownPlacements, cause).toStrictEqual([])
    }
  })

  it('★★★ 読めなかった回に placements が残っていても（材料の取り違え）、運ぶのは []。確認が名指ししていないものは運ばない', async () => {
    const facts = factsOf(c.record, { placements: [A], placementsUnreadable: true, placementsUnreadableCause: 'call' })
    await runFlow(c, facts)
    expect(ipc[0].opts.shownPlacements).toStrictEqual([])
  })

  it('★★ 確認が no なら IPC は0回（運ぶ前に止まる）', async () => {
    const facts = factsOf(c.record, { placements: [A] })
    const { out } = await runFlow(c, facts, false)
    expect(out).toEqual({ cancelled: true })
    expect(ipc).toEqual([])
  })
})

describe('T-F6 共用型: 選択つきの確認（コンテナレジストリ）の回にも、選択の無い回にも、同じ組が載る', () => {
  const shared = CASES[0]

  it('★★★ 選択の無い回（レジストリの記録なし）: opts は { confirmed, shownPlacements } で choices の鍵は付かない', async () => {
    const { askedWithChoices } = await runFlow(shared, factsOf(SHARED_RECORD, { placements: [A] }))
    expect(askedWithChoices).toEqual([]) // 選択つきの確認は使わない
    expect(ipc[0].opts.shownPlacements).toStrictEqual([{ bucket: 'koto-data-a', prefix: 'projects/myapp/' }])
    expect(ipc[0].opts.deleteRegistry).toBe(false)
  })

  it('★★★ 選択つきの回（レジストリを消す／消さない）: どちらの答えでも、同じ shownPlacements が届く', async () => {
    for (const want of [true, false]) {
      const facts = factsOf(SHARED_RECORD_WITH_REGISTRY, { placements: [A, B] })
      const { askedWithChoices } = await runFlow(shared, facts, { confirmed: true, choices: { deleteRegistry: want } })
      expect(askedWithChoices, String(want)).toHaveLength(1)
      expect(ipc[0].opts.deleteRegistry, String(want)).toBe(want)
      expect(ipc[0].opts.shownPlacements, String(want)).toStrictEqual([
        { bucket: 'koto-data-a', prefix: 'projects/myapp/' },
        { bucket: 'koto-data-b', prefix: 'projects/other/' },
      ])
    }
  })

  it('★★★ 選択つきの回で保存場所の設定を読めなかったときも []（選択の組み立てが、組を落とさない）', async () => {
    const facts = factsOf(SHARED_RECORD_WITH_REGISTRY, { placements: [], placementsUnreadable: true, placementsUnreadableCause: 'call' })
    await runFlow(shared, facts, { confirmed: true, choices: { deleteRegistry: false } })
    expect(ipc[0].opts.shownPlacements).toStrictEqual([])
  })
})

describe('F-6 確認の文（\'call\'）: 名前を挙げられない保存場所は削除しないと言う。公開先の3つで同じ', () => {
  it.each(CASES)('★★★ $name: call の確認は「名前を挙げられない保存場所は削除しません」と言い、「削除される場合があります」とは言わない', c => {
    const body = buildTeardownConfirm(c.spec, factsOf(c.record, { placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargets: ['Vercel'] })).body
    expect(body).toContain('⚠️ 保存場所の設定を問い合わせられなかったため、保存場所の名前を挙げられません。名前を挙げられない保存場所は削除しません（使っていれば残り、月額が続きます）。')
    expect(body).not.toContain('削除される場合があります')
    expect(body).not.toContain('Vercel') // ほかの公開先のデータが消える、とは言わない
  })

  it.each(CASES)('★★ $name: 保存場所だけが残った回でも、call なら先頭の段落は事実だけ（「残っている保存場所を削除します」と、削除しないという注意を並べない）', c => {
    const leftoverSpec: TargetSpec<any, any, any> = { ...c.spec, leftoverNote: () => '前回の破棄で、残っている保存場所『koto-data-a』を削除します。' }
    for (const cause of ['settings', 'call'] as const) {
      const body = buildTeardownConfirm(leftoverSpec, factsOf(c.record, { placementsUnreadable: true, placementsUnreadableCause: cause })).body
      expect(body, cause).toContain(`前回の${c.spec.words.verb}で、保存場所だけが残っています。`)
      expect(body, cause).not.toContain('残っている保存場所『koto-data-a』を削除します')
    }
  })
})

// ── F-2 3点セット（main・preload・global.d.ts）: opts に shownPlacements が必須で、結果に skippedBuckets がある ─────────────────────────
// main はこの単位ではまだ読まない（opts は unknown のまま骨を素通りする。選別は次の単位）。preload と global.d.ts が同じ形であることを、公開先ごとの塊で見る。
describe('F-2 3点セット: preload と global.d.ts の3本の teardown が、opts に shownPlacements（必須）・結果に skippedBuckets を持つ', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
  const preload = read('src/main/preload.ts')
  const dts = read('src/renderer/global.d.ts')
  const SHOWN = 'shownPlacements: Array<{ bucket: string; prefix: string }>'
  const DOORS = [
    { name: '共用型 cloud:teardown', preload: `teardown: (projectDir: string, auth: { heldByMain: true }, opts: { confirmed: boolean; deleteRegistry: boolean; registryName: string | null; ${SHOWN} }) =>`,
      dts: `teardown(projectDir: string, auth: { heldByMain: true }, opts: { confirmed: boolean; deleteRegistry: boolean; registryName: string | null; ${SHOWN} }): Promise<{` },
    { name: 'HANAMII hanamii:teardown', preload: `teardown: (projectDir: string, auth: { token: string }, opts: { confirmed: boolean; projectId: string; ${SHOWN} }) =>`,
      dts: `teardown(projectDir: string, auth: { token: string }, opts: { confirmed: boolean; projectId: string; ${SHOWN} }): Promise<{` },
    { name: '専有型 apprunDedicated:teardown', preload: `teardown: (projectDir: string, auth: { token: string; secret: string }, opts: { confirmed: boolean; ${SHOWN} }) =>`,
      dts: `teardown(projectDir: string, auth: { token: string; secret: string }, opts: { confirmed: boolean; ${SHOWN} }): Promise<{` },
  ]

  it.each(DOORS)('★★★ $name: preload の opts の型に shownPlacements が必須で入っている（1か所だけ）', d => {
    expect(preload.split(d.preload).length - 1).toBe(1)
  })

  it.each(DOORS)('★★★ $name: global.d.ts の opts の型に shownPlacements が必須で入り、その返り値の型（この関数の塊の中）に skippedBuckets?: string[] がある', d => {
    expect(dts.split(d.dts).length - 1).toBe(1)
    const start = dts.indexOf(d.dts)
    const end = dts.indexOf('\n      }>', start)
    expect(end).toBeGreaterThan(start)
    expect(dts.slice(start, end)).toContain('skippedBuckets?: string[]')
  })

  it('★★★ main の骨（runTeardownShell）は shownPlacements を落とさず、公開先の run の ctx.opts まで渡す（この単位では読まない）。confirmed は ctx.opts に残らない', async () => {
    resetProjectOpsForTests()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-shown-shell-'))
    try {
      const seen: Array<Record<string, unknown>> = []
      const spec: TeardownShellSpec<{ token: string }, { ok: boolean; message?: string }> = {
        target: 'hanamii', handler: 'hanamii:teardown',
        parseAuth: a => ((a as { token?: string } | null)?.token ? { token: 'x' } : null),
        authMissingMessage: 'トークンが未登録です', secretsOf: () => ['x'], twinsOf: () => [],
        run: async ctx => { seen.push(ctx.opts); return { ok: true } },
        shouldForgetRecord: () => false, forgetRecord: () => ({ ok: true }),
        refused: message => ({ ok: false, message }),
      }
      const shown = [{ bucket: 'koto-data-a', prefix: 'projects/myapp/' }]
      await runTeardownShell(spec, { projectDir: dir, auth: { token: 'x' }, opts: { confirmed: true, projectId: 'p-1', shownPlacements: shown } })
      expect(seen).toEqual([{ projectId: 'p-1', shownPlacements: shown }])
    } finally {
      resetProjectOpsForTests()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
