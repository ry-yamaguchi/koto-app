import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── T-F1（共用型・画面の流れ）0.6.24 F-4: 確認が開いている間に記録が変わっても、見せていない保存場所は消えない ──────────────
// 仕様: docs/v0624-aefi-spec.md の T-F1「確認は B1 を名指しし、invoke の前に env.json へ B2 を足す → 要求は B1 だけ・B2 は0件・ok:false・残りに B2・行が残る」。
// 画面の流れ（runTeardownFlow）を、本物の main（cloud:teardownRecord・cloud:teardown）と偽の client・偽の保存場所に通す。確認の返事を返す直前に、AI（や別の操作）が env.json へ保存場所を足す。
// main の選別そのものを、画面を通さずに見るのは tests/sharedShownTeardown.test.ts。
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
import { h, resetHarness, newProjectDir, setup as setupProject, writePublishRecord, publishTargets, envBuckets, A, B, APP, PREFIX, bucketRef } from './sharedTeardownHarness'

registerCloudHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!

let dir = ''
let teardownCalls: unknown[][] = []

beforeEach(() => {
  resetProjectOpsForTests()
  resetHarness()
  teardownCalls = []
  dir = newProjectDir()
  ;(globalThis as any).window = {
    electronAPI: {
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

function put(env: string[]) {
  setupProject(dir, { env, resources: [APP, ...env.map(bucketRef)] })
  writePublishRecord(dir, { 'sakura-apprun': { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' } })
}

/** 本物の流れ。`whileConfirming` は、確認が開いている間（返事を返す直前）に起きることを書く。確認の文は残す。 */
async function run(whileConfirming: () => void = () => {}, spec: typeof sharedTeardownSpec = sharedTeardownSpec) {
  const bodies: string[] = []
  const entry = {
    confirm: async (o: ConfirmOptions) => { bodies.push(o.body); whileConfirming(); return true },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => {
      bodies.push(o.body); whileConfirming()
      return { confirmed: true, choices: Object.fromEntries(o.choices.map(c => [c.id, c.defaultChecked])) }
    },
    keyMissingMessage: 'キーがありません（テスト）',
  }
  const out = await runTeardownFlow(dir, spec, electronFlowDeps(dir, spec, entry))
  return { out, bodies, result: (out as any).result }
}
const touching = (bucket: string) => h.calls.filter(c => c === `listAllKeys ${bucket}` || c === `deleteKeys ${bucket}` || c === `deleteBucket ${bucket}`)
const storageCalls = () => h.calls.filter(c => /^(connect|listAllKeys|deleteKeys|deleteBucket|deletePermission|listPermissions|dispose)\b/.test(c))

describe('T-F1 共用型（画面の流れ）: 確認のあとで足された保存場所は消さない', () => {
  it('★★★ 確認は A だけ名指し → 確認が開いている間に env.json へ B が足される → 消えるのは A だけ。B への要求は0件・ok:false・残りに B・行が残る', async () => {
    put([A])
    const { bodies, result } = await run(() => put([A, B]))

    expect(bodies.join('\n')).toContain('保存場所『koto-data-a』')
    expect(bodies.join('\n')).not.toContain(B)
    expect((teardownCalls[0][2] as any).shownPlacements).toStrictEqual([{ bucket: A, prefix: PREFIX }])
    expect(h.calls).toEqual(expect.arrayContaining([`listAllKeys ${A}`, `deleteKeys ${A}`, `deleteBucket ${A}`]))
    expect(touching(B), '確認で見せていない B に要求が出ている').toEqual([])
    expect(result.ok).toBe(false)
    expect(result.remainingBuckets).toEqual([B])
    expect(result.skippedBuckets).toEqual([B])
    expect(result.message).toContain('確認のあとで保存場所の記録が変わったため、保存場所『koto-data-b』は削除していません。')
    expect(publishTargets(dir)['sakura-apprun'], '行が消えている（押し直せない）').toBeDefined()
    expect(envBuckets(dir)).toEqual([B])
  })

  it('★★★ 押し直す（次の確認が B を名指しする）と、B が消えて行も消える', async () => {
    put([A])
    await run(() => put([A, B]))
    h.calls = []
    put([B]) // 1回目で消えた A は記録から外れている
    const { bodies, result } = await run()
    expect(bodies.join('\n')).toContain('保存場所『koto-data-b』')
    expect(h.calls).toEqual(expect.arrayContaining([`listAllKeys ${B}`, `deleteKeys ${B}`, `deleteBucket ${B}`]))
    expect(result.ok).toBe(true)
    expect(publishTargets(dir)['sakura-apprun']).toBeUndefined()
  })

  it('★★★ 確認が名前を挙げられなかった回（保存場所の設定を決められなかった call）→ 画面が [] を運び、main は保存場所に1本も要求を出さない。ok:false・行が残る', async () => {
    put([A])
    const spec = { ...sharedTeardownSpec, placementsOf: () => { throw new Error('決められない（テスト）') } }
    const { bodies, result } = await run(() => {}, spec)
    expect(bodies.join('\n')).toContain('名前を挙げられない保存場所は削除しません')
    expect((teardownCalls[0][2] as any).shownPlacements).toStrictEqual([])
    expect(storageCalls(), '名前を挙げていないのに保存場所へ要求が出ている').toEqual([])
    expect(result.ok).toBe(false)
    expect(result.skippedBuckets).toEqual([A])
    expect(result.message).toContain('確認で保存場所の名前を挙げられなかったため、保存場所『koto-data-a』は削除していません。')
    expect(publishTargets(dir)['sakura-apprun']).toBeDefined()
    expect(envBuckets(dir)).toEqual([A])
  })
})
