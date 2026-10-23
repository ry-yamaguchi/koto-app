import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── コンテナレジストリを「作った／借りた／分からない」を、記録に書く口（2026-10-19）────────────────────────
// 破棄の「コンテナレジストリも削除する」を既定でオンにするのは、Koto がこのプロジェクトのために作ったと記録にあるもの（registryAdopted: false）だけ。
// 接続情報は Koto 全体で1つなので、記録の無いプロジェクトが公開すると、ほかのプロジェクトが作ったレジストリを使う。
// 以前は、その記録に印を書かなかった。印が無いものを「Koto が作った」と読んだため、ほかのアプリのイメージ入りのレジストリを既定で消す確認が出た。
//
// 書く口は3つ。ここは、本物の main に偽の client を流し、書かれた state.json で固定する（掟10。ソースの文字列は読まない）:
//   1. 公開 prepareAppImage … 記録の無いプロジェクトが接続情報の名前を採用する → registryAdopted: true（借りた）
//   2. cloud:ensureRegistry  … 新しく作った → false（作った）／既存を再利用 → 印の扱いは metaAfterEnsureRegistry
//   3. 引き継ぎ adoptedState … true（tests/adoptAppRun.test.ts が固定する）
// 読む口（cloud:teardownRecord → 共用型の仕様書の既定）まで通して、利用者が見る既定を確かめる。
import { A, h, resetHarness, newProjectDir, setup, stateMeta } from './sharedTeardownHarness'

const reg = vi.hoisted(() => ({
  creds: null as null | { name: string; user: string; password: string },
  saved: [] as Array<{ name: string }>,
  rows: [] as Array<{ ID: string; Provider: { Class: string }; Status: { registry_name: string } }>,
  created: [] as string[],
}))

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/registry-auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasRegistryCredentials: () => !!reg.creds,
  loadRegistryCredentials: () => reg.creds,
  saveRegistryCredentials: (c: { name: string; user: string; password: string }) => { reg.saved.push({ name: c.name }); reg.creds = c },
  clearRegistryCredentials: () => { reg.creds = null },
}))
// 内蔵ビルダーは無い扱いにする: 公開は「レジストリを決める → 記録する」の段まで進んで、ビルドの前で止まる（外へ何も出さない）
vi.mock('../src/main/cloud/imageBuild', async (orig) => ({ ...(await orig<Record<string, unknown>>()), builderAvailable: () => false }))
vi.mock('../src/main/cloud/client', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const ok = (status: number, data: unknown) => ({ dryRun: false as const, ok: true, status, data })
  class FakeSakuraCloudClient {
    constructor(_opts: unknown) {}
    async listContainerRegistries() { return ok(200, { CommonServiceItems: reg.rows }) }
    async createContainerRegistry(_zone: string, o: { subdomainLabel: string }) { reg.created.push(o.subdomainLabel); return ok(201, { CommonServiceItem: { ID: `new-${o.subdomainLabel}` } }) }
    async getContainerRegistry() { return { dryRun: false as const, ok: false, status: 500, data: null } } // 分類の読み直しは分からないまま
    async addRegistryUser() { return ok(201, null) }
    async updateRegistryUser() { return ok(200, null) }
  }
  return { ...real, SakuraCloudClient: FakeSakuraCloudClient }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { readSharedTeardownRecord } from '../src/main/ipc/cloudTeardown'
import { prepareAppImage } from '../src/main/cloud/imagePublish'
import { loadCloudSpec, loadCloudState } from '../src/main/cloud/specStore'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const ensureRegistry = h.handlers.get('cloud:ensureRegistry')!
const EVENT = {}

const row = (label: string) => ({ ID: `id-${label}`, Provider: { Class: 'containerregistry' }, Status: { registry_name: label } })
const CREDS = (name: string) => ({ name, user: 'sakuraide', password: 'pw' })

let dir = ''
beforeEach(() => {
  resetProjectOpsForTests(); resetHarness()
  reg.creds = null; reg.saved = []; reg.rows = []; reg.created = []
  dir = newProjectDir()
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const stateJson = (): any => JSON.parse(fs.readFileSync(path.join(dir, '.sakura-cloud', 'state.json'), 'utf-8'))
/** 破棄の確認が、このプロジェクトの記録から作る「コンテナレジストリも削除する」の選択の欄（利用者が見る既定）。 */
function registryChoice() {
  const rec = (readSharedTeardownRecord(dir) as { ok: true; record: Parameters<NonNullable<typeof sharedTeardownSpec.choices>>[0] }).record
  return sharedTeardownSpec.choices!(rec)[0]
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. 公開: 記録の無いプロジェクトが、接続情報にあるレジストリを自分のものとして記録する
// ═══════════════════════════════════════════════════════════════════════════════

describe('公開（prepareAppImage）: 記録の無いプロジェクトが接続情報の名前を採用すると、借りた印（registryAdopted: true）を書く', () => {
  async function publish(meta?: Record<string, unknown>) {
    setup(dir, { env: [], resources: [], ...(meta ? { meta } : {}) })
    const spec = loadCloudSpec(dir)!
    const state = loadCloudState(dir, spec)
    const result = await prepareAppImage({ projectDir: dir, spec, state, creds: { token: 't', secret: 's' } as any, progress: () => {} })
    return { result, state }
  }

  it('★★★ 記録が無い（ほかのプロジェクトが作った scheduleapp が接続情報に入っている）→ state.json に名前と registryAdopted: true。手元の state も同じ形', async () => {
    reg.creds = CREDS('scheduleapp')
    reg.rows = [row('scheduleapp')]
    const { result, state } = await publish()
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('内蔵ビルダー') }) // ビルドの前で止めた（想定どおり）
    expect(stateJson().meta).toEqual({ registryName: 'scheduleapp', registryAdopted: true })
    // 呼び出し側（cloud:apply）はこの state で保存し直す。ここが古いと、あとの保存で印が落ちる
    expect(state.meta).toEqual({ registryName: 'scheduleapp', registryAdopted: true })
  })

  it('★★★ 書いた記録から、破棄の確認の既定は「消さない」（借りたものと言う）。ほかのアプリのイメージ入りのレジストリを既定で消さない', async () => {
    reg.creds = CREDS('scheduleapp')
    reg.rows = [row('scheduleapp')]
    await publish()
    const choice = registryChoice()
    expect(choice.defaultChecked).toBe(false)
    // 借りたレジストリは、ふつう Koto が別のプロジェクトのために作ったもの。「Koto が作ったものではありません」とは言わない
    expect(choice.note).toContain('このプロジェクトのために作ったものではありません')
    expect(choice.note).not.toContain('Koto が作ったものではありません')
  })

  it('記録がほかの meta を持っていても残す（名前と印だけを足す）', async () => {
    reg.creds = CREDS('scheduleapp')
    reg.rows = [row('scheduleapp')]
    await publish({ storagePermissionId: 'perm-1', imageTag: 'v1' })
    expect(stateJson().meta).toEqual({ storagePermissionId: 'perm-1', imageTag: 'v1', registryName: 'scheduleapp', registryAdopted: true })
  })

  it('★★ 記録と接続情報が一致する（採用ではない）→ 印に触れない。Koto が作った（false）も借りた（true）も、印の無い記録も、そのまま', async () => {
    for (const mark of [{ registryAdopted: false }, { registryAdopted: true }, {}]) {
      resetHarness(); fs.rmSync(dir, { recursive: true, force: true }); dir = newProjectDir()
      reg.creds = CREDS('myreg'); reg.rows = [row('myreg')]
      await publish({ registryName: 'myreg', ...mark })
      expect(stateMeta(dir), JSON.stringify(mark)).toEqual({ registryName: 'myreg', ...mark })
    }
  })

  it('★★ 記録と接続情報が食い違う（別のプロジェクトのレジストリ）→ 公開を止め、記録は1文字も変えない', async () => {
    reg.creds = CREDS('scheduleapp'); reg.rows = [row('scheduleapp'), row('myreg')]
    const { result } = await publish({ registryName: 'myreg', registryAdopted: false })
    expect(result).toMatchObject({ ok: false, hint: 'reset-registry' })
    expect(stateMeta(dir)).toEqual({ registryName: 'myreg', registryAdopted: false })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. 🛠 レジストリを自動作成（cloud:ensureRegistry）
// ═══════════════════════════════════════════════════════════════════════════════

describe('cloud:ensureRegistry: 新しく作ったら registryAdopted: false。既存の再利用は、記録していた名前のときだけ印を引き継ぐ', () => {
  const run = async (meta?: Record<string, unknown>) => {
    setup(dir, { env: [], resources: [], ...(meta ? { meta } : {}) })
    return ensureRegistry(EVENT, dir)
  }

  it('★★★ 記録が無く、レジストリも無い → 新しく作る。registryAdopted: false を書く。破棄の確認の既定はオン', async () => {
    const r = await run()
    expect(r).toMatchObject({ ok: true, created: true })
    expect(reg.created).toEqual(['myapp'])
    expect(stateMeta(dir)).toMatchObject({ registryName: 'myapp', registryAdopted: false })
    expect(registryChoice().defaultChecked).toBe(true)
  })

  it('★★★ 借りた印（true）が残った記録で、そのレジストリが無くなっていた → 新しく作った回は false に直す（古い true を残さない）', async () => {
    const r = await run({ registryName: 'old-borrowed', registryAdopted: true })
    expect(r).toMatchObject({ ok: true, created: true })
    expect(stateMeta(dir)).toMatchObject({ registryName: 'myapp', registryAdopted: false })
  })

  it('★★ 記録していた名前のレジストリを再利用 → 印は触らない（作ったものは作った・借りたものは借りた・印の無いものは無いまま）', async () => {
    for (const mark of [{ registryAdopted: false }, { registryAdopted: true }, {}]) {
      resetHarness(); fs.rmSync(dir, { recursive: true, force: true }); dir = newProjectDir(); reg.created = []
      reg.rows = [row('myapp-ab12')]
      const r = await run({ registryName: 'myapp-ab12', ...mark })
      expect(r, JSON.stringify(mark)).toMatchObject({ ok: true, created: false })
      expect(reg.created, JSON.stringify(mark)).toEqual([])
      expect(stateMeta(dir), JSON.stringify(mark)).toEqual({ registryName: 'myapp-ab12', ...mark })
    }
  })

  it('★★★ 記録と違う名前の既存レジストリを再利用 → 前の印は外す（前のレジストリのもの。これが Koto の作ったものかは分からない）', async () => {
    reg.rows = [row('myapp')] // 基本ラベルと同じ名前の、ほかのプロジェクトのレジストリ
    const r = await run({ registryName: 'gone-one', registryAdopted: false })
    expect(r).toMatchObject({ ok: true, created: false })
    expect(reg.created).toEqual([])
    expect(stateMeta(dir)).toEqual({ registryName: 'myapp' })
    expect(registryChoice().defaultChecked).toBe(false)
  })

  it('★★ 記録が無く、基本ラベルのレジストリが既にある → 再利用するが「作った」とは書かない（印の無いまま・既定はオフ）', async () => {
    reg.rows = [row('myapp')]
    const r = await run()
    expect(r).toMatchObject({ ok: true, created: false })
    expect(stateMeta(dir)).toEqual({ registryName: 'myapp' })
    expect(registryChoice().defaultChecked).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. 3つの状態を最後まで通す: 印 → 破棄の確認の既定（利用者が見るもの）
// ═══════════════════════════════════════════════════════════════════════════════

describe('印 → 確認の既定: オンになるのは Koto が作った（false）ものだけ', () => {
  it.each([
    ['作った（registryAdopted: false）', { registryName: 'scheduleapp', registryAdopted: false }, true, undefined],
    ['借りた（true）', { registryName: 'scheduleapp', registryAdopted: true }, false, 'このプロジェクトのために作ったものではありません'],
    ['印が無い（作者の手元の実例の形）', { registryName: 'scheduleapp' }, false, 'このプロジェクトのために作ったか分かりません'],
    ["印の型が違う（'false'）", { registryName: 'scheduleapp', registryAdopted: 'false' }, false, 'このプロジェクトのために作ったか分かりません'],
  ])('%s → 既定 %s', (_label, meta, checked, noteHas) => {
    setup(dir, { env: [A], resources: [], meta: meta as any })
    const c = registryChoice()
    expect(c.defaultChecked).toBe(checked)
    if (noteHas) expect(c.note).toContain(noteHas)
    else expect(c.note).toBeUndefined()
  })
})
