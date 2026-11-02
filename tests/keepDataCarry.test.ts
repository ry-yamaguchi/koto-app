import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 0.6.25 U11: 確認で「消しません」と言った保存場所を、画面が `keepData: true` で運び、main が読む ──────────────────────────────
// 仕様: docs/v0625-plan.md の 1-1「確認で「消しません」と言った前提を main へ運ぶ」・2-3 の U11・T-1d。
//   ・画面（flow.ts の `shownPlacementsOf`）は、`keep` のある保存場所にだけ `keepData: true` を付ける（`true` のときだけ。付かないものにはキーも作らない）。
//   ・main の `parseShownPlacements` は `keepData === true` だけ運ぶ。`selectShown` の戻りの形は変えない（`tear` は `current` の項目のまま）。
//   ・`teardownStorage` の `mustKeepData` は、storage を一切呼ばずに `keptData` で残す。消す側には働かない。
//   ・型の宣言6か所（preload.ts×3・global.d.ts×3）が同じ形に揃う。
// 本物の main に流して要求の一覧を見る試験は tests/keepDataMainTeardown.test.ts。

vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))

import { runTeardownFlow, electronFlowDeps, shownPlacementsOf } from '../src/renderer/teardown/flow'
import { sharedTeardownSpec, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec, type DedicatedTeardownRecord } from '../src/renderer/teardown/targets/dedicated'
import type { TargetSpec, TeardownFacts, TeardownPlacement } from '../src/renderer/teardown/types'
import type { ConfirmWithChoicesAnswer, ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { parseShownPlacements, selectShown, mustKeepDataOf } from '../src/main/cloud/storageSelection'
import { teardownStorage, KEPT_AFTER_CONFIRM_NOTE, type StorageTeardownClientLike } from '../src/main/cloud/storageTeardown'
import { A as BUCKET_A, PREFIX, CONSENTED_AT, newProjectDir, workspaceOf } from './sharedTeardownHarness'

const PA: TeardownPlacement = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true, keep: { risk: 'twin', folders: ['myapp copy'] } }
const PB: TeardownPlacement = { bucket: 'koto-data-b', prefix: 'projects/other/', shared: false }
/** 複製かどうか確かめられない保存場所（prefix なし）。 */
const PC: TeardownPlacement = { bucket: 'koto-data-c', keep: { risk: 'unread', folders: [] } }
/** `keep` が null（確かめられて複製はいない）＝消す側。 */
const PD: TeardownPlacement = { bucket: 'koto-data-d', prefix: 'p/', keep: null as any }

const SHARED_RECORD: SharedTeardownRecord = {
  appNames: ['myapp'], registryName: null, registryOrigin: 'owned', registryUsers: [], placements: [], stateOnlyBuckets: [],
}
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

/** 本物の流れ（runTeardownFlow）と本物の deps の組み立て（electronFlowDeps）に、材料だけを差し替えて通す。 */
async function runFlow(c: Case, facts: TeardownFacts<any>) {
  installWindow()
  const entry = {
    confirm: async (_o: ConfirmOptions) => true,
    confirmWithChoices: async (_o: ConfirmWithChoicesOptions) => ({ confirmed: true, choices: {} }) as ConfirmWithChoicesAnswer,
    keyMissingMessage: 'キーがありません（テスト）',
  }
  const deps = { ...electronFlowDeps('/proj', c.spec, entry), loadFacts: async () => facts }
  return runTeardownFlow('/proj', c.spec, deps)
}

describe('shownPlacementsOf: keep のある保存場所にだけ keepData:true を付ける（付かないものにはキーも作らない）', () => {
  it('★★★ keep（twin・unread）→ keepData:true。keep の無いもの・keep が null → 付けない。shared など余計な項目は運ばない（toStrictEqual）', () => {
    expect(shownPlacementsOf(factsOf(null, { placements: [PA, PB, PC, PD] }))).toStrictEqual([
      { bucket: 'koto-data-a', prefix: 'projects/myapp/', keepData: true },
      { bucket: 'koto-data-b', prefix: 'projects/other/' },
      { bucket: 'koto-data-c', prefix: '', keepData: true },
      { bucket: 'koto-data-d', prefix: 'p/' },
    ])
  })

  it('★★ keep が無い入力は現行と1文字も変わらない（keepData のキー自体が無い）', () => {
    const out = shownPlacementsOf(factsOf(null, { placements: [PB, PD] }))
    expect(out).toStrictEqual([{ bucket: 'koto-data-b', prefix: 'projects/other/' }, { bucket: 'koto-data-d', prefix: 'p/' }])
    for (const p of out) expect(Object.keys(p).sort()).toEqual(['bucket', 'prefix'])
  })

  it('★★ 形の読めない keep（真の値だが object でない）も残す側に数える（消すと言い切る側へ倒さない）', () => {
    const odd = { bucket: 'koto-data-e', prefix: 'p/', keep: 'twin' } as unknown as TeardownPlacement
    expect(shownPlacementsOf(factsOf(null, { placements: [odd] }))).toStrictEqual([{ bucket: 'koto-data-e', prefix: 'p/', keepData: true }])
  })

  it('★★ 保存場所の設定を読めなかった回は、keep があっても []（何も見せていない）', () => {
    expect(shownPlacementsOf(factsOf(null, { placements: [PA, PC], placementsUnreadable: true, placementsUnreadableCause: 'call' }))).toStrictEqual([])
  })

  it('★★ 運んだ値を main の parseShownPlacements に通すと、そのまま同じ形で読める（往復で印が落ちない・増えない）', () => {
    const sent = shownPlacementsOf(factsOf(null, { placements: [PA, PB, PC, PD] }))
    expect(parseShownPlacements(sent)).toStrictEqual(sent)
  })
})

describe.each(CASES)('U11 $name: 流れ → 仕様書の invoke → IPC の口に、keepData が届く', c => {
  it('★★★ keep のある保存場所だけに keepData:true が付いた組が、そのまま届く（IPC は1回）', async () => {
    const out = await runFlow(c, factsOf(c.record, { placements: [PA, PB, PC] }))
    expect(out.cancelled).toBe(false)
    expect(ipc).toHaveLength(1)
    expect(ipc[0].door).toBe(c.door)
    expect(ipc[0].opts.confirmed).toBe(true)
    expect(ipc[0].opts.shownPlacements).toStrictEqual([
      { bucket: 'koto-data-a', prefix: 'projects/myapp/', keepData: true },
      { bucket: 'koto-data-b', prefix: 'projects/other/' },
      { bucket: 'koto-data-c', prefix: '', keepData: true },
    ])
  })

  it('★★ keep の無い回は、現行と同じ組（keepData のキーが無い）', async () => {
    await runFlow(c, factsOf(c.record, { placements: [PB] }))
    expect(ipc[0].opts.shownPlacements).toStrictEqual([{ bucket: 'koto-data-b', prefix: 'projects/other/' }])
  })
})

describe('U11 共用型・レジストリあり（選択つきの確認の枝）: keepData と選んだ値が、同じ IPC の opts に一緒に届く', () => {
  /** レジストリがあるので、確認は選択つき（confirmWithChoices の枝）になる。Koto が作った・借り手なし＝既定でオン。 */
  const REG_RECORD: SharedTeardownRecord = { ...SHARED_RECORD, registryName: 'myreg', registryOrigin: 'owned', registryUsers: [], keyRecorded: true }
  const calls = { confirm: 0, withChoices: 0, choices: [] as unknown[] }

  async function runWithChoices(answer: ConfirmWithChoicesAnswer) {
    installWindow()
    calls.confirm = 0; calls.withChoices = 0; calls.choices = []
    const entry = {
      confirm: async (_o: ConfirmOptions) => { calls.confirm++; return true },
      confirmWithChoices: async (o: ConfirmWithChoicesOptions) => { calls.withChoices++; calls.choices = [...o.choices]; return answer },
      keyMissingMessage: 'キーがありません（テスト）',
    }
    const deps = { ...electronFlowDeps('/proj', sharedTeardownSpec, entry), loadFacts: async () => factsOf(REG_RECORD, { placements: [PA, PB, PC] }) }
    return runTeardownFlow('/proj', sharedTeardownSpec, deps)
  }
  const SHOWN = [
    { bucket: 'koto-data-a', prefix: 'projects/myapp/', keepData: true },
    { bucket: 'koto-data-b', prefix: 'projects/other/' },
    { bucket: 'koto-data-c', prefix: '', keepData: true },
  ]

  it('★★★ 選んだ（deleteRegistry:true）: 選択つきの確認で聞き、IPC は1回。opts は keepData つきの組と、選んだ値・記録のレジストリ名が同時に届く（toStrictEqual）', async () => {
    const out = await runWithChoices({ confirmed: true, choices: { deleteRegistry: true } })
    expect(out.cancelled).toBe(false)
    expect(calls.withChoices).toBe(1)
    expect(calls.confirm).toBe(0)
    expect(calls.choices).toHaveLength(1)
    expect(ipc).toHaveLength(1)
    expect(ipc[0].door).toBe('cloud')
    expect(ipc[0].opts).toStrictEqual({ confirmed: true, deleteRegistry: true, registryName: 'myreg', shownPlacements: SHOWN })
  })

  it('★★★ 選ばなかった（false・欠け・boolean でない値）: deleteRegistry は false。keepData つきの組は同じように届く', async () => {
    for (const choices of [{ deleteRegistry: false }, {}, { deleteRegistry: 'true' }, { deleteRegistry: 1 }] as unknown as Array<Record<string, boolean>>) {
      await runWithChoices({ confirmed: true, choices })
      expect(ipc[0].opts, JSON.stringify(choices)).toStrictEqual({ confirmed: true, deleteRegistry: false, registryName: 'myreg', shownPlacements: SHOWN })
    }
  })

  it('★★ 確認をやめた回は IPC を呼ばない（keepData を運ぶ枝も、確認の答えを無視しない）', async () => {
    const out = await runWithChoices({ confirmed: false, choices: { deleteRegistry: true } })
    expect(out).toEqual({ cancelled: true })
    expect(ipc).toEqual([])
  })
})

describe('parseShownPlacements: keepData は === true だけ運ぶ', () => {
  it('★★★ true → keepData:true を付ける。false・無い → 付けない（キーも作らない）。余計な項目は運ばない', () => {
    expect(parseShownPlacements([{ bucket: 'a', prefix: 'p/', keepData: true }])).toStrictEqual([{ bucket: 'a', prefix: 'p/', keepData: true }])
    expect(parseShownPlacements([{ bucket: 'a', prefix: 'p/', keepData: false }])).toStrictEqual([{ bucket: 'a', prefix: 'p/' }])
    expect(parseShownPlacements([{ bucket: 'a', prefix: 'p/' }])).toStrictEqual([{ bucket: 'a', prefix: 'p/' }])
    expect(parseShownPlacements([{ bucket: 'a', prefix: 'p/', keepData: undefined, shared: true, extra: 1 }])).toStrictEqual([{ bucket: 'a', prefix: 'p/' }])
  })

  it.each([
    ['文字列 "true"', 'true'],
    ['文字列 "yes"', 'yes'],
    ['数 1', 1],
    ['数 0', 0],
    ['null', null],
    ['オブジェクト', {}],
    ['配列', []],
  ])('★★ keepData が %s → 壊れた値として全体を null（1件も見せていない扱い。消さない側）', (_name, bad) => {
    expect(parseShownPlacements([{ bucket: 'a', prefix: 'p/', keepData: bad }])).toBeNull()
    expect(parseShownPlacements([{ bucket: 'ok', prefix: 'p/' }, { bucket: 'a', prefix: 'p/', keepData: bad }])).toBeNull()
  })
})

describe('mustKeepDataOf: 名前と prefix の両方が一致して keepData:true のものがあるときだけ true', () => {
  const shown = [{ bucket: 'a', prefix: 'p/', keepData: true as const }, { bucket: 'b', prefix: 'p/' }]
  it('★★★ 一致して keepData → true。keepData の無い組・別の prefix・別のバケット・shown が null → false', () => {
    expect(mustKeepDataOf(shown, { bucket: 'a', prefix: 'p/' })).toBe(true)
    expect(mustKeepDataOf(shown, { bucket: 'b', prefix: 'p/' })).toBe(false)
    expect(mustKeepDataOf(shown, { bucket: 'a', prefix: 'q/' })).toBe(false)
    expect(mustKeepDataOf(shown, { bucket: 'c', prefix: 'p/' })).toBe(false)
    expect(mustKeepDataOf(null, { bucket: 'a', prefix: 'p/' })).toBe(false)
    expect(mustKeepDataOf([], { bucket: 'a', prefix: 'p/' })).toBe(false)
  })

  it('★★ 同じ組が2回あり、片方だけ keepData → true（残す側に倒す）', () => {
    expect(mustKeepDataOf([{ bucket: 'a', prefix: 'p/' }, { bucket: 'a', prefix: 'p/', keepData: true }], { bucket: 'a', prefix: 'p/' })).toBe(true)
  })
})

describe('selectShown: 戻りの形は変えない（keepData は tear に漏れず、突き合わせにも効かない）', () => {
  const P = (bucket: string, prefix = 'projects/myapp/', shared = true) => ({ bucket, prefix, shared })
  it('★★ tear・skipped は current の項目のまま。keepData が付いた組でも、名前と prefix の一致だけで分ける（toStrictEqual）', () => {
    const r = selectShown([P('b1'), P('b2')], [{ bucket: 'b1', prefix: 'projects/myapp/', keepData: true }])
    expect(r).toStrictEqual({ tear: [P('b1')], skipped: [P('b2')], why: 'changed' })
  })
})

describe('teardownStorage の mustKeepData: storage を一切呼ばずに keptData で残す', () => {
  type Calls = string[]
  const fake = (calls: Calls): StorageTeardownClientLike => ({
    async listAllKeys(bucket) { calls.push(`listAllKeys ${bucket}`); return [`${PREFIX}data.json`] },
    async deleteKeys(bucket) { calls.push(`deleteKeys ${bucket}`) },
    async deleteBucket(bucket) { calls.push(`deleteBucket ${bucket}`) },
    async deletePermission(id) { calls.push(`deletePermission ${id}`) },
  })
  const placement = { bucket: BUCKET_A, prefix: PREFIX, shared: true }

  it('★★★ mustKeepData:true（複製の記録はもう無い）→ 呼び出し0件・keptData・理由は「どちらでもない」・鍵（permissionId を渡しても）も無効にしない', async () => {
    const dir = newProjectDir()
    const calls: Calls = []
    const r = await teardownStorage({ storage: fake(calls), placement, permissionId: 'perm-rec', projectDir: dir, mustKeepData: true })
    expect(calls).toEqual([])
    expect(r).toStrictEqual({
      ok: true, deletedBucket: false, note: KEPT_AFTER_CONFIRM_NOTE, permissionRevoked: false, warnings: [],
      keptReasons: { ownFiles: false, usedByOthers: false }, keptData: true,
    })
  })

  it('★★ 複製がいる回は、理由が複製の文（記録だけで決まる）。呼び出しは0件のまま', async () => {
    const dir = newProjectDir()
    const p = path.join(workspaceOf(dir), 'myapp copy', '.sakura-cloud')
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'env.json'), JSON.stringify({ persistence: { objectStorage: [{ bucket: BUCKET_A, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT }] } }))
    const calls: Calls = []
    const r = await teardownStorage({ storage: fake(calls), placement, projectDir: dir, mustKeepData: true })
    expect(calls).toEqual([])
    expect(r).toMatchObject({ ok: true, keptData: true, note: 'フォルダ『myapp copy』も同じデータを使っています。', keptReasons: { ownFiles: false, usedByOthers: true } })
  })

  it('対照: mustKeepData が true でなければ（無い・false）、今までどおり一覧して消す（消す側には働かない）', async () => {
    for (const must of [undefined, false] as const) {
      const dir = newProjectDir()
      const calls: Calls = []
      const r = await teardownStorage({ storage: fake(calls), placement, permissionId: 'perm-rec', projectDir: dir, ...(must === undefined ? {} : { mustKeepData: must }) })
      expect(calls, String(must)).toEqual([`listAllKeys ${BUCKET_A}`, `deleteKeys ${BUCKET_A}`, `deleteBucket ${BUCKET_A}`, 'deletePermission perm-rec'])
      expect(r, String(must)).toMatchObject({ ok: true, deletedBucket: true, permissionRevoked: true })
      expect(r, String(must)).not.toHaveProperty('keptData')
    }
  })
})

describe('型の宣言（掟6の3点セット）: shownPlacements の宣言6か所がすべて keepData つきの同じ形', () => {
  const FIXED = 'shownPlacements: Array<{ bucket: string; prefix: string; keepData?: true }>'
  const OLD = 'shownPlacements: Array<{ bucket: string; prefix: string }>'
  const count = (text: string, needle: string): number => text.split(needle).length - 1
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf-8')
  const globalDts = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'global.d.ts'), 'utf-8')

  it('★★ preload.ts×3・global.d.ts×3（cloud・hanamii・apprunDedicated の teardown）。直す前の形は1か所も残っていない', () => {
    expect(count(preload, FIXED)).toBe(3)
    expect(count(globalDts, FIXED)).toBe(3)
    expect(count(preload, OLD)).toBe(0)
    expect(count(globalDts, OLD)).toBe(0)
  })
})
