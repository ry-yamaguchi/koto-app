import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── レジストリを作る前の探し直し: 一覧を読めなかった回は、新しく作らない（0.6.26）────────────────────────
// 「設定し直す」「レジストリを作る」は cloud:ensureRegistry を通る。作る前に一覧で既存のレジストリを探すが、
// 一覧の取得が HTTP 5xx・429 で失敗した回や、形が読めない応答だった回を「無い」と読むと、
// 記録している名前のレジストリがさくら側に残ったまま、サフィックス付きの別のレジストリを作ってしまう。
// 記録はその新しい名前で上書きされ、もとのレジストリは破棄でも消えないまま月額がかかり続ける。
// ここは偽の client に実際に流し、呼ばれた要求の一覧・push 用の認証・state.json で固定する（掟10。ソースの文字列は読まない）。
import { h, resetHarness, newProjectDir, setup, stateMeta } from './sharedTeardownHarness'

const reg = vi.hoisted(() => ({
  creds: null as null | { name: string; user: string; password: string },
  saved: [] as Array<{ name: string }>,
  /** 一覧の応答。ok のときの data は rows を包んだ形（listData が undefined のとき）。 */
  list: { status: 200, ok: true, data: undefined as unknown },
  rows: [] as Array<{ ID: string; Provider: { Class: string }; Status: { registry_name: string } }>,
  /** 呼ばれた要求を順に積む（メソッド名）。 */
  calls: [] as string[],
  created: [] as string[],
}))

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/registry-auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasRegistryCredentials: () => !!reg.creds,
  loadRegistryCredentials: () => reg.creds,
  saveRegistryCredentials: (c: { name: string; user: string; password: string }) => { reg.calls.push('saveRegistryCredentials'); reg.saved.push({ name: c.name }); reg.creds = c },
  clearRegistryCredentials: () => { reg.creds = null },
}))
vi.mock('../src/main/cloud/client', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const ok = (status: number, data: unknown) => ({ dryRun: false as const, ok: true, status, data })
  class FakeSakuraCloudClient {
    constructor(_opts: unknown) {}
    async listContainerRegistries() {
      reg.calls.push('listContainerRegistries')
      const data = reg.list.data === undefined ? { CommonServiceItems: reg.rows } : reg.list.data
      return { dryRun: false as const, ok: reg.list.ok, status: reg.list.status, data }
    }
    async createContainerRegistry(_zone: string, o: { subdomainLabel: string }) { reg.calls.push('createContainerRegistry'); reg.created.push(o.subdomainLabel); return ok(201, { CommonServiceItem: { ID: `new-${o.subdomainLabel}` } }) }
    async getContainerRegistry() { reg.calls.push('getContainerRegistry'); return { dryRun: false as const, ok: false, status: 500, data: null } }
    async addRegistryUser() { reg.calls.push('addRegistryUser'); return ok(201, null) }
    async updateRegistryUser() { reg.calls.push('updateRegistryUser'); return ok(200, null) }
  }
  return { ...real, SakuraCloudClient: FakeSakuraCloudClient }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { lookupExistingRegistry } from '../src/main/cloud/registryProvision'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const ensureRegistry = h.handlers.get('cloud:ensureRegistry')!
const EVENT = {}

const row = (label: string) => ({ ID: `id-${label}`, Provider: { Class: 'containerregistry' }, Status: { registry_name: label } })
const CREDS = (name: string) => ({ name, user: 'sakuraide', password: 'pw' })

let dir = ''
beforeEach(() => {
  resetProjectOpsForTests(); resetHarness()
  reg.creds = null; reg.saved = []; reg.rows = []; reg.calls = []; reg.created = []
  reg.list = { status: 200, ok: true, data: undefined }
  dir = newProjectDir()
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const stateText = (): string => fs.readFileSync(path.join(dir, '.sakura-cloud', 'state.json'), 'utf-8')

// ═══════════════════════════════════════════════════════════════════════════════
// 1. 本物の main（cloud:ensureRegistry）に偽の client を流す
// ═══════════════════════════════════════════════════════════════════════════════

describe('cloud:ensureRegistry: 一覧を読めなかった回は、新しいレジストリを作らず、記録も接続情報も変えない', () => {
  /** Koto が作った 'myapp' を記録している。push 用の認証は古い（設定し直しを押した回）。 */
  function recorded() {
    setup(dir, { env: [], resources: [], meta: { registryName: 'myapp', registryAdopted: false } })
    reg.creds = CREDS('myapp')
    return stateText()
  }

  it.each([
    [503, 'HTTP 503（さくら側の一時的な失敗）'],
    [500, 'HTTP 500'],
    [429, 'HTTP 429（要求が多すぎる）'],
    [502, 'HTTP 502'],
  ])('★★★ 一覧が HTTP %s で失敗 → 作らない。要求は一覧の1件だけ・ok:false・記録も接続情報も1文字も変えない（%s）', async (status) => {
    const before = recorded()
    reg.list = { status, ok: false, data: null }
    const r = await ensureRegistry(EVENT, dir)
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining(`HTTP ${status}`) })
    expect(r.message).toContain('作っていません')
    expect(reg.calls).toEqual(['listContainerRegistries']) // 作成・ユーザー追加・接続情報の保存は1件も出ていない
    expect(reg.created).toEqual([])
    expect(reg.saved).toEqual([])
    expect(reg.creds).toEqual(CREDS('myapp'))
    expect(stateText()).toBe(before)
    expect(stateMeta(dir)).toEqual({ registryName: 'myapp', registryAdopted: false })
  })

  it.each([
    ['CommonServiceItems が無い', {}],
    ['CommonServiceItems が配列でない', { CommonServiceItems: 'oops' }],
    ['応答が配列そのもの', []],
    ['応答が文字列', 'not json'],
    ['応答が null', null],
  ])('★★★ 一覧は 200 だが形が読めない（%s）→ 「無い」と読まず作らない。記録も変えない', async (_label, data) => {
    const before = recorded()
    reg.list = { status: 200, ok: true, data }
    const r = await ensureRegistry(EVENT, dir)
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('読み取れませんでした') })
    expect(r.message).toContain('作っていません')
    expect(reg.calls).toEqual(['listContainerRegistries'])
    expect(reg.saved).toEqual([])
    expect(stateText()).toBe(before)
  })

  it.each([401, 403])('HTTP %s（認証が通らない）→ 従来どおり認証の案内を返して作らない', async (status) => {
    const before = recorded()
    reg.list = { status, ok: false, data: null }
    const r = await ensureRegistry(EVENT, dir)
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('認証に失敗しました') })
    expect(reg.calls).toEqual(['listContainerRegistries'])
    expect(stateText()).toBe(before)
  })

  it('★★ 対照: 一覧を読めて、記録の名前も基本ラベルも無い（0件の配列）→ 作る。作成 → ユーザー追加 → 接続情報の保存の順', async () => {
    setup(dir, { env: [], resources: [], meta: { registryName: 'gone', registryAdopted: false } })
    reg.list = { status: 200, ok: true, data: { CommonServiceItems: [] } }
    const r = await ensureRegistry(EVENT, dir)
    expect(r).toMatchObject({ ok: true, created: true })
    expect(reg.calls.slice(0, 2)).toEqual(['listContainerRegistries', 'createContainerRegistry'])
    expect(reg.calls.indexOf('addRegistryUser')).toBeGreaterThan(reg.calls.indexOf('createContainerRegistry'))
    expect(reg.calls.indexOf('saveRegistryCredentials')).toBeGreaterThan(reg.calls.indexOf('addRegistryUser'))
    expect(reg.created).toEqual(['myapp'])
  })

  it('★★ 対照: 一覧を読めて、記録の名前のレジストリがある → 作らずに再利用する（作成の要求は0件）', async () => {
    setup(dir, { env: [], resources: [], meta: { registryName: 'myapp-ab12', registryAdopted: false } })
    reg.rows = [row('myapp-ab12'), row('other')]
    const r = await ensureRegistry(EVENT, dir)
    expect(r).toMatchObject({ ok: true, created: false })
    expect(reg.calls).not.toContain('createContainerRegistry')
    expect(reg.saved).toEqual([{ name: 'myapp-ab12' }])
  })

  it('★★ 対照: 一覧の他の行が読めなくても（別の種類の項目が混じる）、配列であれば読めたものとして探す', async () => {
    setup(dir, { env: [], resources: [], meta: { registryName: 'myapp', registryAdopted: false } })
    reg.list = { status: 200, ok: true, data: { CommonServiceItems: [{ ID: 'x', Provider: { Class: 'simplemonitor' } }, row('myapp')] } }
    const r = await ensureRegistry(EVENT, dir)
    expect(r).toMatchObject({ ok: true, created: false })
    expect(reg.created).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. 探し直しの関数そのもの
// ═══════════════════════════════════════════════════════════════════════════════

describe('lookupExistingRegistry: 作ってよいのは「一覧を読めて、探した名前がどれも無い」回だけ', () => {
  const clientOf = (res: unknown) => {
    const calls: string[] = []
    return { calls, client: { listContainerRegistries: async (zone: string) => { calls.push(zone); return res as any } } }
  }
  const okList = (rows: unknown[]) => ({ dryRun: false, ok: true, status: 200, data: { CommonServiceItems: rows } })

  it('探した名前が先に並んだものから見つかる（記録の名前が基本ラベルより先）', async () => {
    const { client, calls } = clientOf(okList([row('base'), row('recorded')]))
    expect(await lookupExistingRegistry(client, 'is1a', ['recorded', 'base'])).toEqual({ kind: 'found', id: 'id-recorded', label: 'recorded' })
    expect(calls).toEqual(['is1a'])
  })

  it('一覧が読めて0件、または探した名前が無い → absent（ここだけが「作ってよい」）', async () => {
    expect(await lookupExistingRegistry(clientOf(okList([])).client, 'is1a', ['a'])).toEqual({ kind: 'absent' })
    expect(await lookupExistingRegistry(clientOf(okList([row('b')])).client, 'is1a', ['a'])).toEqual({ kind: 'absent' })
  })

  it.each([
    ['HTTP 503', { dryRun: false, ok: false, status: 503, data: null }],
    ['HTTP 429', { dryRun: false, ok: false, status: 429, data: { error_msg: 'slow down' } }],
    ['HTTP 401', { dryRun: false, ok: false, status: 401, data: null }],
    ['HTTP 403', { dryRun: false, ok: false, status: 403, data: null }],
    ['形が読めない 200', { dryRun: false, ok: true, status: 200, data: {} }],
    ['dry-run の応答', { dryRun: true, method: 'GET', url: 'x' }],
  ])('%s → stop（message を返す。absent にも found にもならない）', async (_label, res) => {
    const r = await lookupExistingRegistry(clientOf(res).client, 'is1a', ['a'])
    expect(r.kind).toBe('stop')
    expect((r as { message: string }).message.length).toBeGreaterThan(0)
  })
})
