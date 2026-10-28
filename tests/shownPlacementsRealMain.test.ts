import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── T-F6（0.6.24 F-1）: 画面の流れを本物の main（cloud:teardownRecord・cloud:teardown）と偽の client・偽の保存場所に通す ──────────────
// 仕様: docs/v0624-aefi-spec.md の T-F6「画面の流れと本物の main を通すと、見せたものはふつうに消える。invoke の opts が facts の組と一致する。'call' なら []」。
//   ・確認で見せた保存場所（名前と prefix の組）は、main が返した記録（teardownRecord の placements）と同じ組で main の破棄に届く
//   ・見せたものは、これまでどおりふつうに消える（要求の一覧 h.calls を見る。ソースの文字列は読まない・掟10）
//   ・保存場所の設定を読めなかった回（call）は [] が届く
// main が「見せていないものを消さない」ことは tests/sharedShownTeardown.test.ts・tests/sharedShownTeardownFlow.test.ts（T-F1〜F4・F7）が見る。ここは、画面が運ぶ側の約束と、見せたものがふつうに消えることだけを固定する。
// 3つの公開先それぞれの IPC の口に届く値は tests/shownPlacementsFlow.test.ts。

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { runTeardownFlow, electronFlowDeps } from '../src/renderer/teardown/flow'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import type { ConfirmWithChoicesOptions, ConfirmWithChoicesAnswer } from '../src/renderer/useConfirmChoices'
import { h, resetHarness, newProjectDir, setup as setupProject, writePublishRecord, A, B, APP, PREFIX, bucketRef, REGISTRY_ROW } from './sharedTeardownHarness'

registerCloudHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!

let dir = ''
let teardownCalls: unknown[][] = []

beforeEach(() => {
  resetProjectOpsForTests()
  resetHarness()
  h.registryRows = [REGISTRY_ROW]
  teardownCalls = []
  dir = newProjectDir()
  ;(globalThis as any).window = {
    electronAPI: {
      // 本物の main のハンドラ（preload の素通しと同じ形）。届いた opts を残す。
      cloud: {
        teardownRecord: (d: string) => mainRecord({}, d),
        teardown: (d: string, auth: unknown, opts: unknown) => { teardownCalls.push([d, auth, opts]); return mainTeardown({}, d, auth, opts) },
      },
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
      storage: {
        placement: async (d: string) => {
          const list = JSON.parse(fs.readFileSync(path.join(d, '.sakura-cloud', 'env.json'), 'utf-8'))?.persistence?.objectStorage ?? []
          return { ok: true, placements: list.map((p: any) => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })) }
        },
      },
      stageTiming: { estimates: async () => null },
      win: { setBusy: () => {} },
    },
    dispatchEvent: () => true,
  }
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete (globalThis as any).window
})

function put(env: string[], meta?: { registryName: string; registryAdopted: boolean }) {
  setupProject(dir, { env, resources: [APP, ...env.map(bucketRef)], ...(meta ? { meta } : {}) })
  writePublishRecord(dir, { 'sakura-apprun': { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' } })
}

/** 本物の流れ（材料は本物の main の記録から読む）。確認の文は残す。 */
async function run(spec: typeof sharedTeardownSpec = sharedTeardownSpec) {
  const plain: ConfirmOptions[] = []
  const withChoices: ConfirmWithChoicesOptions[] = []
  const entry = {
    confirm: async (o: ConfirmOptions) => { plain.push(o); return true },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => {
      withChoices.push(o)
      return { confirmed: true, choices: Object.fromEntries(o.choices.map(c => [c.id, c.defaultChecked])) }
    },
    keyMissingMessage: 'キーがありません（テスト）',
  }
  const out = await runTeardownFlow(dir, spec, electronFlowDeps(dir, spec, entry))
  return { out, plain, withChoices }
}

describe('T-F6 共用型: 本物の main に通す', () => {
  it('★★★ 保存場所1件: 確認が名指しした A が、記録の prefix のまま main に届き、A のデータとバケットはふつうに消える', async () => {
    put([A])
    const { out, plain } = await run()
    expect(out.cancelled).toBe(false)
    expect((out as any).result.ok).toBe(true)
    expect(plain[0].body).toContain('保存場所『koto-data-a』')
    expect(teardownCalls).toHaveLength(1)
    expect((teardownCalls[0][2] as any).shownPlacements).toStrictEqual([{ bucket: A, prefix: PREFIX }])
    // 見せたものはこれまでどおり消える（main の判断は変えていない）
    expect(h.calls).toEqual(expect.arrayContaining([`listAllKeys ${A}`, `deleteKeys ${A}`, `deleteBucket ${A}`]))
  })

  it('★★★ 保存場所2件: 確認が名指しした全件が env.json の並びのまま届き、両方ふつうに消える', async () => {
    put([A, B])
    const { plain } = await run()
    expect(plain[0].body).toContain('保存場所『koto-data-a』『koto-data-b』')
    expect((teardownCalls[0][2] as any).shownPlacements).toStrictEqual([{ bucket: A, prefix: PREFIX }, { bucket: B, prefix: PREFIX }])
    expect(h.calls).toEqual(expect.arrayContaining([`deleteBucket ${A}`, `deleteBucket ${B}`]))
  })

  it('★★★ 届いた組は、確認の材料（main の teardownRecord が返した placements）の名前と prefix と一致する（画面が自分で作り直さない）', async () => {
    put([A, B])
    const record = await mainRecord({}, dir)
    expect(record.ok).toBe(true)
    await run()
    const fromMain = record.record.placements.map((p: { bucket: string; prefix: string }) => ({ bucket: p.bucket, prefix: p.prefix }))
    expect((teardownCalls[0][2] as any).shownPlacements).toStrictEqual(fromMain)
  })

  it('★★★ 選択つきの確認（コンテナレジストリ）の回も、同じ組が届く。選択の値（レジストリを消すか）は別に届く', async () => {
    put([A], { registryName: 'myreg', registryAdopted: false })
    const { withChoices } = await run()
    expect(withChoices).toHaveLength(1)
    const opts = teardownCalls[0][2] as any
    expect(opts.shownPlacements).toStrictEqual([{ bucket: A, prefix: PREFIX }])
    expect(opts.deleteRegistry).toBe(true) // Koto が作ったレジストリは既定でオン
    expect(opts.registryName).toBe('myreg')
  })

  it('★★★ 保存場所の設定を決められなかった回（call・placementsOf が投げた）: main に届く shownPlacements は []。確認は名前を挙げられないと言う', async () => {
    put([A])
    const spec = { ...sharedTeardownSpec, placementsOf: () => { throw new Error('決められない（テスト）') } }
    const { plain, withChoices } = await run(spec)
    const body = [...plain, ...withChoices].map(o => o.body).join('\n')
    expect(body).toContain('保存場所の名前を挙げられません。名前を挙げられない保存場所は削除しません')
    expect(teardownCalls).toHaveLength(1)
    expect((teardownCalls[0][2] as any).shownPlacements).toStrictEqual([])
  })
})
