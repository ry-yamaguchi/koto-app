import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 0.6.24 R2-i: 記録の鍵の ID だけを写した複製から、元の現役の鍵を無効にしない（7章の申し送り・U6 の報告）─────────────────────────────────────
// 複製が**保存場所の設定を外して**、記録の鍵（共用型の state.meta.storagePermissionId・専有型の記録の storagePermissionId）の ID だけを写した形だと、
// 保存場所の prefix で複製を見る `placementsHaveTwinRisk`（R1-c）には何も見えず、複製の側の破棄・公開の apply が、元の現役の鍵（元のアプリがいま保存場所の読み書きに使っているもの）を無効にする。
// 直し方: `permissionHeldByOthersFs`（同じ親フォルダの兄弟の記録に同じ鍵の ID があるか）。真か 'unknown'（親の一覧・兄弟の記録を読めない）なら、**記録の鍵を無効にしない**（K3 と同じ向き）。
// 当てる所は、記録の鍵を無効にする3か所すべて（`recordedKeyAtRisk` を通る）:
//   1. teardownStorageForProject のループの前（共用型・HANAMII・専有型の破棄）  2. cloudTeardownStorage.ts の保存場所0件の鍵の無効化  3. apply.ts の保存場所の削除
// 本物の main（cloud:teardown・teardownStorageForProject・applyPlan）に、偽の保存場所・偽の兄弟フォルダを流し、**出た要求の一覧**（deletePermission が0件）と記録の ID が残ることで固定する（掟10）。
// 変異: 確かめを外す（3か所それぞれ）／'unknown' を「持たない」に倒す／兄弟の記録の読み方を片方外す（共用型・専有型）／自分を数える／名前での一括の無効化（sweep）も止める条件を外す。
import { A, APP, OK_AUTH, bucketRef, h, resetHarness, newProjectDir, workspaceOf, setup, stateMeta } from './sharedTeardownHarness'
import { shownTeardown, shownFromEnv } from './shownFromEnv'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { permissionHeldByOthersFs } from '../src/main/cloud/permissionHolders'
import { recordedKeyAtRisk } from '../src/main/cloud/storageTeardown'
import { teardownStorageForProject } from '../src/main/cloud/storageForTarget'
import { applyPlan, type StorageClientLike, type CloudClientLike } from '../src/main/cloud/apply'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { emptyState } from '../src/main/cloud/state'
import type { Plan } from '../src/main/cloud/planner'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const EVENT = { sender: { send: () => {} } }
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const REC = 'perm-rec'
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0

let dir = ''
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  dir = newProjectDir()
})
afterEach(() => {
  try { fs.chmodSync(workspaceOf(dir), 0o755) } catch { /* 無い */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

const sib = (name: string): string => { const p = path.join(workspaceOf(dir), name); fs.mkdirSync(p, { recursive: true }); return p }
const put = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)) }
/** 共用型の記録（state.meta.storagePermissionId）だけを持つ兄弟。保存場所もアプリの記録も持たない（prefix でも、アプリの id でも、複製に見えない）。 */
const holderShared = (name: string, id: string = REC) => { const p = sib(name); put(path.join(p, '.sakura-cloud', 'state.json'), { name: 'x', backend: 'apprun', resources: [], meta: { storagePermissionId: id } }); return p }
/** 専有型の記録（publish.apprunDedicated.storagePermissionId）だけを持つ兄弟。 */
const holderDedicated = (name: string, id: string = REC) => { const p = sib(name); put(path.join(p, '.sakuraide.json'), { publish: { apprunDedicated: { storagePermissionId: id } } }); return p }
const deletedPermissions = () => h.calls.filter(c => c.startsWith('deletePermission '))

// ── permissionHeldByOthersFs ───────────────────────────────────────────────────────
describe('★★★ permissionHeldByOthersFs: 同じ親フォルダの兄弟の記録に、同じ鍵の ID があるか（true・\'unknown\'・false）', () => {
  it('★★★ 共用型の記録（state.meta）・専有型の記録（publish.apprunDedicated）のどちらかに同じ ID → true', () => {
    holderShared('s')
    expect(permissionHeldByOthersFs(dir, REC)).toBe(true)
    fs.rmSync(path.join(workspaceOf(dir), 's'), { recursive: true })
    expect(permissionHeldByOthersFs(dir, REC)).toBe(false)
    holderDedicated('d')
    expect(permissionHeldByOthersFs(dir, REC)).toBe(true)
  })

  it('★★★ 別の ID・鍵の記録が無い兄弟・兄弟がいない → false。記録が無い（ENOENT）兄弟は持たない', () => {
    expect(permissionHeldByOthersFs(dir, REC)).toBe(false) // 兄弟なし
    holderShared('other-shared', 'perm-other')
    holderDedicated('other-dedicated', 'perm-other')
    sib('plain')
    put(path.join(sib('only-state'), '.sakura-cloud', 'state.json'), { name: 'x', resources: [] })
    put(path.join(sib('empty-meta'), '.sakuraide.json'), {})
    expect(permissionHeldByOthersFs(dir, REC)).toBe(false)
  })

  it('★★ 自分（フォルダそのもの・自分を指すリンク）・隠しフォルダ・ファイルは数えない', () => {
    put(path.join(dir, '.sakura-cloud', 'state.json'), { name: 'x', resources: [], meta: { storagePermissionId: REC } })
    fs.symlinkSync(dir, path.join(workspaceOf(dir), 'link-to-self'))
    holderShared('.hidden')
    fs.writeFileSync(path.join(workspaceOf(dir), 'file.txt'), REC)
    expect(permissionHeldByOthersFs(dir, REC)).toBe(false)
  })

  it('★★★ 確かめられない: 兄弟の state.json・.sakuraide.json が壊れている・読めない形（配列）・フォルダだった・たどれないリンク → \'unknown\'', () => {
    for (const make of [
      () => put(path.join(sib('broken-state'), '.sakura-cloud', 'state.json'), '{ 壊れた'),
      () => put(path.join(sib('broken-meta'), '.sakuraide.json'), '{ 壊れた'),
      () => put(path.join(sib('array-state'), '.sakura-cloud', 'state.json'), '[]'),
      () => put(path.join(sib('array-meta'), '.sakuraide.json'), '5'),
      () => fs.mkdirSync(path.join(sib('dir-meta'), '.sakuraide.json'), { recursive: true }),
      () => fs.symlinkSync(path.join(workspaceOf(dir), 'nowhere'), path.join(workspaceOf(dir), 'dead-link')),
    ]) {
      for (const e of fs.readdirSync(workspaceOf(dir))) if (e !== path.basename(dir)) fs.rmSync(path.join(workspaceOf(dir), e), { recursive: true, force: true })
      make()
      expect(permissionHeldByOthersFs(dir, REC), String(make)).toBe('unknown')
    }
  })

  it('★★★ 持つ兄弟が見つかれば、ほかが読めなくても true（見つかった事実は動かない）。持たず確かめられないものがあれば \'unknown\'', () => {
    put(path.join(sib('broken'), '.sakuraide.json'), '{ 壊れた')
    expect(permissionHeldByOthersFs(dir, REC)).toBe('unknown')
    holderShared('holder')
    expect(permissionHeldByOthersFs(dir, REC)).toBe(true)
  })

  it.skipIf(rootIsMe)('★★★ 親フォルダの一覧を読めない（0o311）→ \'unknown\'', () => {
    holderShared('holder')
    fs.chmodSync(workspaceOf(dir), 0o311)
    expect(permissionHeldByOthersFs(dir, REC)).toBe('unknown')
  })

  it('絶対パスでない・id が空・文字列でない → \'unknown\'（親フォルダが決まらない・何を探すか分からない）。投げない', () => {
    expect(permissionHeldByOthersFs('relative/dir', REC)).toBe('unknown')
    expect(permissionHeldByOthersFs('', REC)).toBe('unknown')
    expect(permissionHeldByOthersFs(dir, '')).toBe('unknown')
    expect(permissionHeldByOthersFs(dir, undefined as unknown as string)).toBe('unknown')
    expect(permissionHeldByOthersFs(undefined as unknown as string, REC)).toBe('unknown')
  })

  it('★★★ recordedKeyAtRisk: 鍵が無ければ false。持つ兄弟（true）・確かめられない（\'unknown\'）は true。持つ兄弟がいなければ false', () => {
    expect(recordedKeyAtRisk(dir, null)).toBe(false)
    expect(recordedKeyAtRisk(dir, undefined)).toBe(false)
    expect(recordedKeyAtRisk(dir, '')).toBe(false)
    expect(recordedKeyAtRisk(dir, REC)).toBe(false)
    put(path.join(sib('broken'), '.sakuraide.json'), '{ 壊れた')
    expect(recordedKeyAtRisk(dir, REC)).toBe(true) // 'unknown' も無効にしない側
    fs.rmSync(path.join(workspaceOf(dir), 'broken'), { recursive: true })
    holderShared('holder')
    expect(recordedKeyAtRisk(dir, REC)).toBe(true)
    expect(recordedKeyAtRisk(dir, 'perm-mine')).toBe(false)
  })
})

// ── 1. teardownStorageForProject（共用型・HANAMII・専有型の破棄が通る）───────────────────────────────────────
describe('★★★ 場所1: 破棄（teardownStorageForProject）— 兄弟が同じ鍵の ID を持つなら、deletePermission 0件・記録の ID は残る', () => {
  const OWN = () => setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { storagePermissionId: REC } })

  it('★★★ 共用型 cloud:teardown（保存場所1件）: 共用型の記録に同じ鍵の ID を持つ兄弟 → 保存場所は片づくが、鍵は無効にしない。一括の無効化（名前）もしない。記録の ID は残る', async () => {
    OWN(); holderShared('holder')
    h.permissions = [{ id: REC, displayName: 'koto-myapp-apprun' }]
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(h.calls).toContain('deleteApp app-1')
    expect(h.calls.some(c => c.startsWith('deleteKeys ') || c.startsWith('deleteBucket ')), '保存場所は片づく（鍵だけ触れない）').toBe(true)
    expect(deletedPermissions(), '元の現役の鍵が切れる').toEqual([])
    expect(h.calls, '名前での一括の無効化の一覧引き').not.toContain('listPermissions')
    expect(stateMeta(dir)?.storagePermissionId, '無効にしていないので、記録の ID は残る').toBe(REC)
  })

  it('★★★ 専有型の記録に同じ鍵の ID を持つ兄弟（共用型の破棄でも）→ 鍵は無効にしない', async () => {
    OWN(); holderDedicated('holder')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(deletedPermissions()).toEqual([])
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })

  it('★★★ 確かめられない兄弟（.sakuraide.json が壊れている。保存場所の複製の確かめには数えられないもの）→ 鍵は無効にしない。記録の ID は残る', async () => {
    OWN()
    put(path.join(sib('broken'), '.sakuraide.json'), '{ 壊れた')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(deletedPermissions()).toEqual([])
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })

  it('★★★ 対照: 兄弟が同じ鍵の ID を持たなければ、今までどおり鍵を無効にし、記録の ID を外す（この試験が鍵の要求を見ていることの確認）', async () => {
    OWN(); holderShared('other', 'perm-other'); holderDedicated('other-d', 'perm-other-d'); sib('plain')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(deletedPermissions()).toEqual([`deletePermission ${REC}`])
    expect(stateMeta(dir)?.storagePermissionId).toBeUndefined()
  })

  it('★★★ teardownStorageForProject を直に（HANAMII・専有型もここを通る）: 同じ鍵の ID を持つ兄弟 → permissionRevoked は false・deletePermission 0件・一括の無効化もしない。対照: 持たなければ true', async () => {
    OWN()
    holderDedicated('holder')
    h.permissions = [{ id: REC, displayName: 'koto-myapp-apprun-dedicated' }]
    const args = { creds: { token: 't', secret: 's' } as any, projectDir: dir, permissionId: REC, sweepKeysFor: 'apprun-dedicated' as const, shown: shownFromEnv(dir) }
    const held = await teardownStorageForProject(args)
    expect(held.ok).toBe(true)
    expect(held.ok && held.reason === 'done' && held.permissionRevoked).toBe(false)
    expect(deletedPermissions()).toEqual([])
    expect(h.calls).not.toContain('listPermissions')

    fs.rmSync(path.join(workspaceOf(dir), 'holder'), { recursive: true })
    h.calls.length = 0
    const free = await teardownStorageForProject(args)
    expect(free.ok && free.reason === 'done' && free.permissionRevoked).toBe(true)
    expect(deletedPermissions()).toEqual([`deletePermission ${REC}`])
  })
})

// ── 2. 共用型の保存場所0件（revokeRecordedKey）──────────────────────────────────────────────────────────────
describe('★★★ 場所2: 共用型の保存場所0件の鍵の無効化（runStorageStage の revokeRecordedKey）— 兄弟が同じ鍵の ID を持つなら無効にしない', () => {
  const OWN = () => setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: REC } })

  it('★★★ 兄弟が同じ鍵の ID を持つ → deletePermission 0件・アクセスなし。記録の ID は残る', async () => {
    OWN(); holderShared('holder')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(h.calls).toContain('deleteApp app-1')
    expect(deletedPermissions(), '保存場所0件でも、元の現役の鍵が切れる').toEqual([])
    expect(h.calls, '無効にしないので、保存場所へ接続もしない').not.toContain('connect')
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })

  it('★★★ 確かめられない兄弟（壊れた state.json 以外の記録）→ 無効にしない', async () => {
    OWN()
    put(path.join(sib('broken'), '.sakuraide.json'), '{ 壊れた')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(deletedPermissions()).toEqual([])
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })

  it.skipIf(rootIsMe)('★★★ 親フォルダの一覧を読めない（0o311。アプリの記録が無いので骨は断らない）→ 兄弟の記録を確かめられないので、鍵は無効にしない。記録の ID は残る', async () => {
    setup(dir, { env: [], resources: [], meta: { registryName: 'myreg', storagePermissionId: REC } }) // アプリの記録なし（複製の確かめの対象が無い）。鍵だけがある
    fs.chmodSync(workspaceOf(dir), 0o311)
    try {
      await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    } finally {
      fs.chmodSync(workspaceOf(dir), 0o755)
    }
    expect(deletedPermissions(), '兄弟の記録を読めないのに、鍵を無効にした').toEqual([])
    expect(stateMeta(dir)?.storagePermissionId).toBe(REC)
  })

  it('★★ 対照（0o311 の試験と同じ記録）: 親フォルダが読めて兄弟もいなければ、アプリの記録が無くても鍵を無効にし、記録の ID を外す（親の一覧を読めないことだけが違い）', async () => {
    setup(dir, { env: [], resources: [], meta: { registryName: 'myreg', storagePermissionId: REC } })
    await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(deletedPermissions()).toEqual([`deletePermission ${REC}`])
    expect(stateMeta(dir)?.storagePermissionId).toBeUndefined()
  })

  it('★★★ 対照: 兄弟が持たなければ、今までどおり保存場所0件でも鍵を無効にし、記録の ID を外す', async () => {
    OWN(); holderShared('other', 'perm-other')
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(deletedPermissions()).toEqual([`deletePermission ${REC}`])
    expect(stateMeta(dir)?.storagePermissionId).toBeUndefined()
  })
})

// ── 3. 公開の apply の保存場所の削除 ──────────────────────────────────────────────────────────────────────────
describe('★★★ 場所3: 公開の apply の保存場所の削除（apply.ts）— 兄弟が同じ鍵の ID を持つなら無効にしない', () => {
  const BUCKET = 'koto-data-x'
  const PREFIX = 'projects/myapp/'
  function fakeStorage(calls: string[]): StorageClientLike {
    return {
      async isSiteReady() { return true },
      async ensureBucket() {},
      async listAllKeys() { return [`${PREFIX}data.json`] },
      async putMarker() {},
      async deleteKeys(_b, ks) { calls.push(`deleteKeys:${ks.join(',')}`) },
      async deleteBucket(b) { calls.push(`deleteBucket:${b}`) },
      async issueKey() { return { accessKey: 'AKIA', secretKey: 'S', permissionId: 'perm-new' } },
      async deletePermission(id) { calls.push(`deletePermission:${id}`) },
      async listPermissions() { return [] },
      siteInfo() { return { s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' } },
    }
  }
  const noCloud: CloudClientLike = {
    dryRun: false,
    async ensureUser() { return { ok: true } },
    async listApps() { return { ok: true, data: [] } },
    async getApp() { return { ok: true, dryRun: false, data: { min_scale: 0 } } },
    async createApp() { return { ok: true } },
    async patchApp() { return { ok: true } },
    async deleteApp() { return { ok: true } },
  }
  const spec = (): EnvSpec => {
    const s = defaultSpec({ name: 'myapp', hasDockerfile: false })
    s.persistence = { objectStorage: [{ bucket: BUCKET, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] }
    return s
  }
  const deletePlan = (): Plan => ({
    actions: [{ type: 'delete', kind: 'bucket', name: BUCKET, stateful: true, destructive: true, description: `保存場所『${BUCKET}』を削除` } as any],
    hasDestructive: true, hasStatefulDelete: true,
  }) as Plan
  const run = (calls: string[]) => {
    const state = emptyState('myapp', 'sakura-apprun')
    state.meta = { storagePermissionId: REC }
    return applyPlan({ plan: deletePlan(), spec: spec(), state, client: noCloud, storage: fakeStorage(calls), confirmed: true, projectDir: dir })
  }

  it('★★★ 兄弟が同じ鍵の ID を持つ → 保存場所は片づくが、deletePermission 0件。記録の ID は残る', async () => {
    holderShared('holder')
    const calls: string[] = []
    const r = await run(calls)
    expect(r.ok).toBe(true)
    expect(calls.some(c => c.startsWith('deleteKeys:') || c.startsWith('deleteBucket:')), '保存場所は片づく').toBe(true)
    expect(calls.filter(c => c.startsWith('deletePermission:')), '元の現役の鍵が切れる').toEqual([])
    expect(r.state.meta?.storagePermissionId, '無効にしていないので、記録の ID は残る').toBe(REC)
  })

  it('★★★ 専有型の記録に同じ ID・確かめられない兄弟（壊れた記録）でも無効にしない', async () => {
    holderDedicated('holder-d')
    const a: string[] = []
    const ra = await run(a)
    expect(a.filter(c => c.startsWith('deletePermission:'))).toEqual([])
    expect(ra.state.meta?.storagePermissionId).toBe(REC)
    fs.rmSync(path.join(workspaceOf(dir), 'holder-d'), { recursive: true })
    put(path.join(sib('broken'), '.sakuraide.json'), '{ 壊れた')
    const b: string[] = []
    const rb = await run(b)
    expect(b.filter(c => c.startsWith('deletePermission:'))).toEqual([])
    expect(rb.state.meta?.storagePermissionId).toBe(REC)
  })

  it('★★★ 対照: 兄弟が持たなければ、今までどおり鍵を無効にし、記録の ID を外す', async () => {
    holderShared('other', 'perm-other')
    const calls: string[] = []
    const r = await run(calls)
    expect(r.ok).toBe(true)
    expect(calls.filter(c => c.startsWith('deletePermission:'))).toEqual([`deletePermission:${REC}`])
    expect(r.state.meta?.storagePermissionId).toBeUndefined()
  })
})
