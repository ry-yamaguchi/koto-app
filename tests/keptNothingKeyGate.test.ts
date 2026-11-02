import { describe, it, expect, vi, afterEach } from 'vitest'

// ── 記録に鍵が残る回は、何も消さない門（teardown/keptNothing.ts）を通さない（流れ・門の純関数・3つの仕様書）──────────────────────
// 理由: main は鍵が残る回に、鍵を無効にしなかった警告を足すことがある。画面はほかのフォルダの記録を読まないので、同じ結果を組めない。
// 鍵が残る回は確認へ進め（main が実行時に同じ判断を下す）、鍵が残らない回だけ、確認も IPC も出さずに結果を組む。本物の main と並べた比べは tests/keptNothingKeyedRealMain.test.ts。
//   ・共用型 … 記録の `keyRecorded`（main の cloud:teardownRecord が返す。`false` のときだけ門を通す）
//   ・専有型 … 記録の `storagePermissionId`（未設定・null・空の文字列だけが「鍵なし」。ほかの値は読めない形でも鍵が残る側）
//   ・HANAMII … 鍵を記録に持たない（仕様書に判定が無い。記録に鍵の名前の項目があっても読まない）
// 変異: 門が鍵の有無を見ない／共用型の判定を外す／専有型の判定を外す／鍵の読みが欠けた回・読めない形を「鍵なし」と読む（不明を肯定に）／HANAMII にも鍵の判定を足す。

vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))

import { runTeardownFlow, electronFlowDeps } from '../src/renderer/teardown/flow'
import { keptNothingPlacements } from '../src/renderer/teardown/keptNothing'
import { sharedTeardownSpec, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec, type DedicatedTeardownRecord } from '../src/renderer/teardown/targets/dedicated'
import type { TargetSpec, TeardownFacts, TeardownPlacement } from '../src/renderer/teardown/types'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import type { ConfirmWithChoicesAnswer, ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'

const KEEP_TWIN = { risk: 'twin' as const, folders: ['myapp copy'] }
const A_KEPT: TeardownPlacement = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true, keep: KEEP_TWIN }

const SHARED_GHOST: SharedTeardownRecord = {
  appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], keyRecorded: false,
  placements: [{ bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }], stateOnlyBuckets: [],
}
const DEDICATED_GHOST: DedicatedTeardownRecord = { storageLeftoverBucket: 'koto-data-a', storageLeftoverBuckets: ['koto-data-a'] }
const HANAMII_GHOST: HanamiiTeardownRecord = { projectId: 'p-1', name: 'myapp', tokenId: 'tok-1', storageLeftoverBuckets: ['koto-data-a'] }

type Door = 'cloud' | 'hanamii' | 'apprunDedicated'
let ipc: Door[] = []
function installWindow() {
  ipc = []
  const reply = (door: Door) => async () => { ipc.push(door); return { ok: true, executed: [], message: '', remaining: {} } }
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

const factsOf = (record: unknown, placements: TeardownPlacement[]): TeardownFacts<any> => ({
  projectName: 'myapp', record, placements, placementsUnreadable: false, placementsUnreadableCause: null,
  otherTargets: [], otherTargetsUnreadable: false, waitNote: null, refusal: null,
})

async function runFlow(spec: TargetSpec<any, any, any>, facts: TeardownFacts<any>) {
  installWindow()
  const order: string[] = []
  const asked: ConfirmOptions[] = []
  const entry = {
    confirm: async (o: ConfirmOptions) => { order.push('confirm'); asked.push(o); return true },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => { order.push('confirm'); asked.push(o); return { confirmed: true, choices: {} } },
    keyMissingMessage: 'キーがありません（テスト）',
  }
  const base = electronFlowDeps('/proj', spec, entry)
  const deps = {
    ...base,
    loadFacts: async () => { order.push('loadFacts'); return facts },
    loadAuth: async (r: any) => { order.push('loadAuth'); return base.loadAuth(r) },
    beginActivity: (label: string, o: any) => { order.push('beginActivity'); return base.beginActivity(label, o) },
    onStart: () => { order.push('onStart') },
  }
  const out = await runTeardownFlow('/proj', spec, deps)
  return { out, order, asked }
}
const FULL_FLOW = ['loadFacts', 'confirm', 'beginActivity', 'onStart', 'loadAuth']

const pure = (spec: TargetSpec<any, any, any>, record: unknown, placements: TeardownPlacement[] = [A_KEPT]) =>
  keptNothingPlacements(spec, { record, placements, placementsUnreadable: false })

describe('★★★ 流れ: 記録に鍵が残る回は、全件 keep でも確認へ進む（確認 → キー → IPC が1回）。鍵が残らない回だけ門を通る', () => {
  it('共用型: keyRecorded が true → 飛ばさない。確認の見出しは「保存場所は残ります」（何も消さないと言う確認）・IPC は1回', async () => {
    const { out, order, asked } = await runFlow(sharedTeardownSpec, factsOf({ ...SHARED_GHOST, keyRecorded: true }, [A_KEPT]))
    expect(order).toEqual(FULL_FLOW)
    expect(asked).toHaveLength(1)
    expect(asked[0].title).toBe('保存場所は残ります')
    expect(ipc).toEqual(['cloud'])
    expect((out as any).keptNothing).toBeUndefined()
  })

  it('専有型: storagePermissionId がある → 飛ばさない。確認の見出しは「保存場所は残ります」・IPC は1回', async () => {
    const { out, order, asked } = await runFlow(dedicatedTeardownSpec, factsOf({ ...DEDICATED_GHOST, storagePermissionId: 'perm-1' }, [A_KEPT]))
    expect(order).toEqual(FULL_FLOW)
    expect(asked).toHaveLength(1)
    expect(asked[0].title).toBe('保存場所は残ります')
    expect(ipc).toEqual(['apprunDedicated'])
    expect((out as any).keptNothing).toBeUndefined()
  })

  it('対照: 共用型の keyRecorded が false・専有型の storagePermissionId が無い・HANAMII → 飛ばす（確認 0・キー 0・IPC 0）', async () => {
    for (const [spec, record] of [[sharedTeardownSpec, SHARED_GHOST], [dedicatedTeardownSpec, DEDICATED_GHOST], [hanamiiTeardownSpec, HANAMII_GHOST]] as const) {
      const { out, order, asked } = await runFlow(spec, factsOf(record, [A_KEPT]))
      expect(order, spec.target).toEqual(['loadFacts'])
      expect(asked, spec.target).toEqual([])
      expect(ipc, spec.target).toEqual([])
      expect(out, spec.target).toMatchObject({ cancelled: false, keptNothing: true })
    }
  })
})

describe('★★★ 門の純関数: 鍵が残らないと言い切れる回だけ通す。不明は肯定に倒さない', () => {
  it('共用型: keyRecorded が false だけ通る。true・欠け・真偽値でない値は通らない', () => {
    expect(pure(sharedTeardownSpec, { ...SHARED_GHOST, keyRecorded: false })).not.toBeNull()
    expect(pure(sharedTeardownSpec, { ...SHARED_GHOST, keyRecorded: true })).toBeNull()
    const { keyRecorded: _omitted, ...missing } = SHARED_GHOST
    expect(pure(sharedTeardownSpec, missing)).toBeNull()
    for (const odd of [undefined, null, 0, 1, 'false', 'true', {}, []]) {
      expect(pure(sharedTeardownSpec, { ...SHARED_GHOST, keyRecorded: odd }), `keyRecorded: ${JSON.stringify(odd)}`).toBeNull()
    }
  })

  it('専有型: storagePermissionId が未設定・null・空の文字列のときだけ通る。文字列・読めない形の値は通らない', () => {
    expect(pure(dedicatedTeardownSpec, DEDICATED_GHOST)).not.toBeNull()
    expect(pure(dedicatedTeardownSpec, { ...DEDICATED_GHOST, storagePermissionId: null })).not.toBeNull()
    expect(pure(dedicatedTeardownSpec, { ...DEDICATED_GHOST, storagePermissionId: '' })).not.toBeNull()
    expect(pure(dedicatedTeardownSpec, { ...DEDICATED_GHOST, storagePermissionId: 'perm-1' })).toBeNull()
    for (const odd of [0, 5, true, false, {}, [], ' ']) {
      expect(pure(dedicatedTeardownSpec, { ...DEDICATED_GHOST, storagePermissionId: odd }), `storagePermissionId: ${JSON.stringify(odd)}`).toBeNull()
    }
  })

  it('HANAMII: 鍵の判定を持たない。記録に鍵の名前の項目があっても読まず、通る', () => {
    expect(hanamiiTeardownSpec.keyRecorded).toBeUndefined()
    expect(pure(hanamiiTeardownSpec, HANAMII_GHOST)).not.toBeNull()
    expect(pure(hanamiiTeardownSpec, { ...HANAMII_GHOST, storagePermissionId: 'perm-1', keyRecorded: true })).not.toBeNull()
  })

  it('門は、仕様書の答えが false 以外（true・undefined・文字列など）なら通さない。false だけ通す', () => {
    const base = { targets: () => [], leftoverNote: undefined }
    const spec = (answer: unknown) => ({ ...base, keyRecorded: () => answer as boolean })
    expect(keptNothingPlacements(spec(false), { record: {}, placements: [A_KEPT], placementsUnreadable: false })).not.toBeNull()
    for (const odd of [true, undefined, null, 0, 'false', 'unknown']) {
      expect(keptNothingPlacements(spec(odd), { record: {}, placements: [A_KEPT], placementsUnreadable: false }), `答え: ${String(odd)}`).toBeNull()
    }
  })

  it('鍵の判定は、ほかの門の条件と重ねて効く: 鍵が残らなくても、消せる保存場所が混じる・読めなかった回は通らない', () => {
    const removing: TeardownPlacement = { bucket: 'koto-data-c', prefix: 'projects/myapp/', shared: true }
    expect(pure(sharedTeardownSpec, SHARED_GHOST, [A_KEPT, removing])).toBeNull()
    expect(keptNothingPlacements(sharedTeardownSpec, { record: SHARED_GHOST, placements: [A_KEPT], placementsUnreadable: false, twinFactsUnreadable: true })).toBeNull()
    expect(keptNothingPlacements(sharedTeardownSpec, { record: SHARED_GHOST, placements: [A_KEPT], placementsUnreadable: true })).toBeNull()
  })
})
