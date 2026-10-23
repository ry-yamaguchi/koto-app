import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 共用型の破棄 cloud:teardown: ほかのプロジェクトの記録を読んでから、バケットごと消すか決める（2026-10-21 実機の欠陥）────
// 実機: 使い捨てのプロジェクト3つが同じ保存場所 S を使っていた（rc1-shared＝共用型 AppRun と HANAMII の両方で公開中・rc1-ded1＝専有型）。
// rc1-shared の HANAMII の破棄が S の中の prefix を目印ごと消し、そのあと rc1-ded1 の専有型の削除が「S のキーに、ほかの prefix が無い」と読んで
// **S をバケットごと消した**。rc1-shared の env.json には S が同意済みで残っていた。
// ここは本物の main（cloud:teardown → teardownStorageForProject → teardownStorage → teardownPlanFor）に、偽の client・偽の兄弟フォルダを流し、
// **出た要求の一覧**（バケット削除が0件・このプロジェクトのキーだけ消す）で固定する（掟10。ソースの文字列は読まない）。
// 専有型・HANAMII の破棄は tests/apprunDedicatedStorageTeardown.test.ts・tests/hanamiiStorageTeardown.test.ts に同じ形の試験がある。
import { A, B, APP, OK_AUTH, PREFIX, CONSENTED_AT, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, envBuckets, stateKinds, writePublishRecord, publishTargets } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { teardownRemainingWarnings } from '../src/shared/cloudCost'

registerCloudHandlers({} as any)
const teardown = h.handlers.get('cloud:teardown')!
const EVENT = {}
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const S = A // 共用の保存場所（実機の koto-rc-s1019）

let dir = ''
beforeEach(() => { resetHarness(); dir = newProjectDir() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/**
 * 兄弟のプロジェクトを置く。`consent` の保存場所を env.json に同意済みで、`stateBuckets` を state.json の bucket 資源に書く。
 * **`published`**: 公開の記録（.sakuraide.json の publish.targets）に、その公開先の行を置く（既定は無し＝公開していない／破棄が済んだ）。
 * `stateApp`: 旧い記録（targets が無かった頃）の形——state.json に apprun-app 資源だけがある。
 */
function sibling(name: string, opts: { consent?: string[]; stateBuckets?: string[]; rawEnv?: string; published?: string[]; stateApp?: boolean } = {}): string {
  const p = path.join(workspaceOf(dir), name)
  fs.mkdirSync(path.join(p, '.sakura-cloud'), { recursive: true })
  if (opts.rawEnv !== undefined) fs.writeFileSync(path.join(p, '.sakura-cloud', 'env.json'), opts.rawEnv)
  else if (opts.consent) {
    const objectStorage = opts.consent.map(bucket => ({ bucket, prefix: `projects/${name}/`, shared: true, consentedAt: CONSENTED_AT }))
    fs.writeFileSync(path.join(p, '.sakura-cloud', 'env.json'), JSON.stringify({ persistence: { objectStorage } }))
  }
  if (opts.stateBuckets || opts.stateApp) {
    const resources: unknown[] = (opts.stateBuckets ?? []).map(id => ({ kind: 'bucket', id, stateful: true, key: `bucket:${id}` }))
    if (opts.stateApp) resources.push({ kind: 'apprun-app', id: 'app-x', stateful: false, key: `apprun-app:${name}` })
    fs.writeFileSync(path.join(p, '.sakura-cloud', 'state.json'), JSON.stringify({ name, backend: 'apprun', resources }))
  }
  if (opts.published) writePublishRecord(p, Object.fromEntries(opts.published.map(t => [t, { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://x.example/' }])))
  return p
}
const requestsOn = (b: string) => h.calls.filter(c => c.endsWith(` ${b}`) && /^(listAllKeys|deleteKeys|deleteBucket) /.test(c))
const sawDeleteBucket = (b: string) => h.calls.includes(`deleteBucket ${b}`)

describe('★★★ cloud:teardown: 実機の再現（S のキーには自分の prefix しか無いが、兄弟の env.json に S が同意済みで残っている・兄弟は公開中）', () => {
  it('バケット削除の要求は0件。このプロジェクトのキーだけ消す。残した理由は「ほかのプロジェクトも使っている」で、結果の警告がそう言う', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    h.keysByBucket[S] = [`${PREFIX}data.json`] // 自分の prefix しか無い（rc1-shared の prefix は目印ごと消えていた）
    sibling('rc1-shared', { consent: [S], published: ['sakura-apprun', 'hanamii'] })

    const reply = await teardown(EVENT, dir, OK_AUTH, GO)

    expect(reply.ok).toBe(true)
    expect(sawDeleteBucket(S), 'バケットごと消した（実機の欠陥）').toBe(false)
    expect(requestsOn(S)).toEqual([`listAllKeys ${S}`, `deleteKeys ${S}`])
    expect(reply.keptBucketName).toBe(S)
    expect(reply.keptBucketsUsedByOthers).toEqual([S])
    const warning = teardownRemainingWarnings(reply).join('\n')
    expect(warning).toContain('ほかのプロジェクトも使っています')
    expect(warning).not.toContain('使っているプロジェクトが無いか確かめてください') // 「わからない」の文ではない（使っていると確かめた）
    // 緑の行は「保存場所は残します。」だけ（バケットを消したとは言わない）
    expect(reply.executed.find((l: string) => l.includes(S))).toBe(`保存場所『${S}』のデータを削除しました — 保存場所は残します。`)
    // 消していないバケットの記録は、このプロジェクトに残る（押し直しで、もう一度同じ判断をする）
    expect(envBuckets(dir)).toEqual([S])
    expect(stateKinds(dir)).toContain('bucket')
  })

  it('兄弟の state.json にだけ S がある（env.json は無い）が、公開中 → 残す', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    sibling('only-state', { stateBuckets: [S], published: ['hanamii'] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(sawDeleteBucket(S)).toBe(false)
    expect(reply.keptBucketsUsedByOthers).toEqual([S])
  })

  it('★★★ 兄弟の記録を読めなかった（壊れた JSON）→ わからないので残す。「ほかのプロジェクトも使っている」とは言わず、確かめてから削除するよう言う', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    sibling('broken', { rawEnv: '{ not json' })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sawDeleteBucket(S)).toBe(false)
    expect(requestsOn(S)).toEqual([`listAllKeys ${S}`, `deleteKeys ${S}`])
    expect(reply.keptBucketName).toBe(S)
    expect(reply.keptBucketsUsedByOthers).toBeUndefined()
    const warning = teardownRemainingWarnings(reply).join('\n')
    expect(warning).toContain('使っているプロジェクトが無いか確かめてください')
    expect(warning).not.toContain('ほかのプロジェクトも使っています')
  })

  it('★ 兄弟が別のバケットだけを使っている → 今までどおり、バケットごと消す（残して課金を続けさせない）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    sibling('uses-b', { consent: [B], stateBuckets: [B], published: ['sakura-apprun'] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(requestsOn(S)).toEqual([`listAllKeys ${S}`, `deleteKeys ${S}`, `deleteBucket ${S}`])
    expect(reply.keptBucketName).toBeNull()
    // 緑の行は、消したことを事実で言う（以前は「…あわせて削除できます」と、実際は消したのに提案の形で言っていた）
    expect(reply.executed.find((l: string) => l.includes(S))).toBe(`保存場所『${S}』のデータを削除しました — 保存場所ごと削除しました。月額の課金も止まります。`)
    expect(envBuckets(dir)).toEqual([])
  })

  it('★ 自分自身の env.json に S が同意済みで書いてあっても数えない（兄弟がいなければ、バケットごと消す）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sawDeleteBucket(S)).toBe(true)
  })

  it('★ 同意済みの保存場所が2つ: 兄弟が使っている分だけ残し、誰も使っていない分は消す（バケットごとに判断する）', async () => {
    setup(dir, { env: [S, B], resources: [bucketRef(S), bucketRef(B), APP] })
    h.keysByBucket[S] = [`${PREFIX}x.json`]
    h.keysByBucket[B] = [`${PREFIX}x.json`]
    sibling('rc1-shared', { consent: [S], published: ['vercel'] }) // S だけを使っている（Vercel で公開中）
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sawDeleteBucket(S), 'S は兄弟が使っている').toBe(false)
    expect(sawDeleteBucket(B), 'B は誰も使っていない').toBe(true)
    expect(reply.keptBucketNames).toEqual([S])
    expect(reply.keptBucketsUsedByOthers).toEqual([S])
    expect(envBuckets(dir)).toEqual([S])
  })
})

// ── 兄弟が「いま使っている」かは、設定（env.json・state.json）に加えて公開の記録（.sakuraide.json の行）で決める ─────────────────────
// 8f5e9d8 の直後に見つかった回帰: 共用型・HANAMII・専有型の破棄は、ほかが使うので残したバケットを env.json・state.json に残す（設定から外さない）。
// 設定だけで数えると、同じ S を使う A・B を順に破棄したとき、B の破棄が**破棄済みの A** を使用者と読み、S は誰にも消せず月額が続いた。
describe('★★★ cloud:teardown: 回帰 — 同じ S を使う A・B を順に破棄すると、最後の破棄で S はバケットごと消える', () => {
  const PA = 'projects/proj-a/'
  const PB = 'projects/proj-b/'
  /** 共用型で公開中のプロジェクト（S を同意済み・公開の記録＝sakura-apprun の行あり・アプリあり）。 */
  function publishedProject(projectDir: string, prefix: string) {
    setup(projectDir, { env: [S], resources: [bucketRef(S), APP], envExtra: () => ({ prefix }) })
    writePublishRecord(projectDir, { 'sakura-apprun': { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://x.example/' } })
  }

  it('A を破棄 → S は残る（B が公開中）。続けて B を破棄（A は破棄済みで行が無い）→ バケット削除の要求が1件・「保存場所ごと削除しました」', async () => {
    const dirB = path.join(workspaceOf(dir), 'proj-b')
    fs.mkdirSync(dirB)
    publishedProject(dir, PA)
    publishedProject(dirB, PB)

    // 1. A を破棄。S のキーは A の prefix だけ（B の prefix は目印ごと消えていた・実機と同じ）。B は公開中なので S は残る
    h.keysByBucket[S] = [`${PA}data.json`]
    const first = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(first.ok).toBe(true)
    expect(sawDeleteBucket(S), 'B が公開中なのに S を消した').toBe(false)
    expect(first.keptBucketsUsedByOthers).toEqual([S])
    // A の公開の記録は消える。設定（env.json の S・state.json の bucket 資源）は残る（設定から外さない作り）。アプリの資源は消える
    expect(publishTargets(dir)).toEqual({})
    expect(envBuckets(dir)).toEqual([S])
    expect(stateKinds(dir)).toContain('bucket')
    expect(stateKinds(dir)).not.toContain('apprun-app')

    // 2. 続けて B を破棄。A は破棄済み（公開の記録が無い）なので数えない → S をバケットごと消す
    h.calls = []
    h.keysByBucket[S] = [`${PB}data.json`]
    const second = await teardown(EVENT, dirB, OK_AUTH, GO)
    expect(second.ok).toBe(true)
    expect(h.calls.filter(c => c === `deleteBucket ${S}`), '最後の破棄で S が消えない（月額が続く・回帰）').toEqual([`deleteBucket ${S}`])
    expect(second.keptBucketName).toBeNull()
    expect(second.keptBucketsUsedByOthers).toBeUndefined()
    expect(second.executed.find((l: string) => l.includes(S))).toBe(`保存場所『${S}』のデータを削除しました — 保存場所ごと削除しました。月額の課金も止まります。`)
    expect(envBuckets(dirB)).toEqual([])
  })
})

describe('★★ cloud:teardown: 兄弟の公開の記録と、バケットの中の目印で、使っているかを決める', () => {
  it('兄弟が S を同意済みだが、公開の記録が無く、目印も無い（一度も公開していない「用意しただけ」）→ 数えない＝S をバケットごと消す', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    h.keysByBucket[S] = [`${PREFIX}data.json`]
    sibling('prepared-only', { consent: [S] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(requestsOn(S)).toEqual([`listAllKeys ${S}`, `deleteKeys ${S}`, `deleteBucket ${S}`])
    expect(reply.keptBucketName).toBeNull()
  })

  it('兄弟が S を同意済み・公開の記録なし・でも S の中に兄弟の目印がある → キーの一覧で数える＝残す（今のキーの判断のまま）', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    h.keysByBucket[S] = [`${PREFIX}data.json`, 'projects/prepared-only/.koto-keep']
    sibling('prepared-only', { consent: [S] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sawDeleteBucket(S)).toBe(false)
    expect(reply.keptBucketsUsedByOthers).toEqual([S])
  })

  it('旧い記録（兄弟の state.json に apprun-app と bucket だけ・.sakuraide.json が無い）→ 公開ありと数える＝残す', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    h.keysByBucket[S] = [`${PREFIX}data.json`]
    sibling('legacy', { stateBuckets: [S], stateApp: true })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sawDeleteBucket(S)).toBe(false)
    expect(reply.keptBucketsUsedByOthers).toEqual([S])
  })

  it('★★★ 兄弟の公開の記録（.sakuraide.json）が壊れている → わからないので残す。「ほかのプロジェクトも使っています」とは言わず、確かめてから削除するよう言う', async () => {
    setup(dir, { env: [S], resources: [bucketRef(S), APP] })
    h.keysByBucket[S] = [`${PREFIX}data.json`]
    const p = sibling('broken-meta', { consent: [S] })
    fs.writeFileSync(path.join(p, '.sakuraide.json'), '{ not json')
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sawDeleteBucket(S)).toBe(false)
    expect(reply.keptBucketName).toBe(S)
    expect(reply.keptBucketsUsedByOthers).toBeUndefined()
    const warning = teardownRemainingWarnings(reply).join('\n')
    expect(warning).toContain('使っているプロジェクトが無いか確かめてください')
    expect(warning).not.toContain('ほかのプロジェクトも使っています')
  })
})
