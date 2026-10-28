import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 何を固定するか（設計書 docs/teardown-unify-plan.md 10.11.14 の C-4・C-5。0.6.22 段階3B-2）──────────────────
// 本物の main に、偽の HTTP サーバ（さくらの専有型 API）と偽の保存場所を当てて、返り値・処理の記録・公開の記録（印）を見る（掟10）。
//   C-4 保存場所が2件以上で途中で止まった回、残りを全件返す（remainingBuckets・message・TeardownView.remaining・記録の警告・
//       印: storageLeftoverBucket は先頭1件・storageLeftoverBuckets は全件。必ず一緒に書き、一緒に下ろす）。接続できなかった回・片づけが投げた回も全件。
//   C-5 鍵の無効化に失敗した回の ⚠️ の行に、パーミッションの名前（koto-<名前>_apprun-dedicated）の案内が1回だけ付く。ID の末尾は添えない（10.16）。

const h = vi.hoisted(() => ({
  baseUrl: '',
  handlers: new Map<string, (...args: any[]) => any>(),
  /** listAllKeys が返す中身（全バケット共通）。 */
  keys: [] as string[],
  /** 一覧に失敗するバケット。 */
  listThrowsFor: new Set<string>(),
  adapterThrows: false,
  /** teardownStorageForProject そのものが投げる。 */
  storageThrows: false,
  revokeThrows: false,
  permissions: [] as { id: string; displayName: string }[],
  listPermissionsThrows: false,
  /** 最初の deleteKeys の直後に呼ぶ関数（env.json が読めなくなる回を作る）。 */
  afterDeleteKeys: null as null | (() => void),
  storageCalls: [] as string[],
  deletedBuckets: [] as string[],
  deletedPermissions: [] as string[],
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

// 偽の保存場所。呼ばれた操作を積むだけ。実物の判断（storageTeardown.ts → teardownPlanFor）はそのまま動かす。
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => {
      if (h.adapterThrows) throw new Error('保存場所に接続できません（テスト）')
      h.storageCalls.push('connect')
      return {
        siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
        async isSiteReady() { return true },
        async ensureBucket() {}, async putMarker() {},
        async listAllKeys(bucket: string) {
          h.storageCalls.push(`listAllKeys ${bucket}`)
          if (h.listThrowsFor.has(bucket)) throw new Error('一覧を取得できませんでした（テスト）')
          return h.keys
        },
        async deleteKeys(bucket: string) { h.storageCalls.push(`deleteKeys ${bucket}`); h.afterDeleteKeys?.() },
        async deleteBucket(bucket: string) { h.storageCalls.push(`deleteBucket ${bucket}`); h.deletedBuckets.push(bucket) },
        async deletePermission(id: string) {
          h.storageCalls.push(`deletePermission ${id}`)
          if (h.revokeThrows) throw new Error('鍵を無効にできませんでした（テスト）')
          h.deletedPermissions.push(id)
        },
        async issueKey() { return { accessKey: 'A', secretKey: 'S', permissionId: 'p' } },
        async listPermissions() {
          h.storageCalls.push('listPermissions')
          if (h.listPermissionsThrows) throw new Error('パーミッションの一覧を取得できませんでした（テスト）')
          return h.permissions
        },
        async dispose() {},
      }
    },
  }
})

// 片づけそのものが投げる回を作る（本物の teardownStorageForProject は storageThrows が false のときだけ動く）。
vi.mock('../src/main/cloud/storageForTarget', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    teardownStorageForProject: (...args: unknown[]) =>
      h.storageThrows ? Promise.reject(new Error('片づけが投げました（テスト）')) : real.teardownStorageForProject(...args),
  }
})

// 破棄の本体は実物を動かす。偽サーバへ向けるため baseUrl だけを足し、待たない sleep を入れる。
vi.mock('../src/main/cloud/apprunDedicatedApply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    teardownFlow: (auth: any, dir: string, opts: any) => real.teardownFlow(auth, dir, { ...opts, sleep: async () => {} }, h.baseUrl),
  }
})

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { writeApprunDedicatedRecordFs, writePublishRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { getOps, resetProjectOpsForTests, summarizeResult } from '../src/main/projectOps'
import { toTeardownView } from '../src/shared/teardownResult'
import { KEY_REVOKE_FAILED_WARNING } from '../src/main/cloud/storageTeardown'
import { shownTeardown } from './shownFromEnv'
import { isolatedProjectDir } from './isolatedProject'

registerApprunDedicatedHandlers({} as any)
const teardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!) // 画面の代わりに、確認で見せた保存場所（env.json の記録）を渡す（0.6.24 F。main は見せたものだけを消す）

const AUTH = { token: 'dedicated-token-AAAA1111', secret: 'dedicated-secret-BBBB2222' }
const A = 'koto-data-a'
const B = 'koto-data-b'
const PREFIX = 'projects/myapp/'
const consented = (bucket: string, prefix = PREFIX) => ({ bucket, prefix, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' })
const EVENT = { sender: { send: () => {} } }
const GO = { confirmed: true }
const D = 'sakura-apprun-dedicated' as const
type Route = { status: number; body?: unknown }
let server: Server | null = null
let dir = ''

beforeEach(() => {
  resetProjectOpsForTests()
  dir = isolatedProjectDir('koto-dedicated-storage-all-')
  Object.assign(h, { baseUrl: '', keys: [`${PREFIX}.koto-keep`], adapterThrows: false, storageThrows: false, revokeThrows: false, permissions: [], listPermissionsThrows: false, afterDeleteKeys: null })
  h.listThrowsFor = new Set()
  h.storageCalls = []
  h.deletedBuckets = []
  h.deletedPermissions = []
})
afterEach(() => {
  if (server) { server.close(); server = null }
  resetProjectOpsForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function startServer(routes: Record<string, Route>): Promise<void> {
  const handler: http.RequestListener = (req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      const route = routes[`${req.method} ${req.url}`]
      const status = route?.status ?? 404
      res.writeHead(status, status === 204 ? {} : { 'Content-Type': 'application/json' })
      res.end(status === 204 ? undefined : JSON.stringify(route?.body ?? { error: 'test router: 未定義のルート' }))
    })
  }
  await new Promise<void>((resolve, reject) => {
    server = http.createServer(handler)
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') { h.baseUrl = `http://127.0.0.1:${addr.port}/`; resolve() } else reject(new Error('ポートを取得できません'))
    })
  })
}
const CLUSTER_GONE: Record<string, Route> = {
  'DELETE /clusters/c1': { status: 204 },
  'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
}

/** 同意済みの保存場所（バケットごと）と、クラスタだけの記録と、📡 の専有型の行を置く。 */
function project(opts: { storage?: Array<ReturnType<typeof consented>>; record?: Parameters<typeof writeApprunDedicatedRecordFs>[1] } = {}) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: opts.storage ?? [consented(A), consented(B)] } as any
  fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  writeApprunDedicatedRecordFs(dir, { clusterID: 'c1', ...(opts.record ?? {}) })
  writePublishRecordFs(dir, D, { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://app.example.com/' })
}
const rowExists = (): boolean => !!JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8'))?.publish?.targets?.[D]
const envBuckets = (): string[] => JSON.parse(fs.readFileSync(path.join(dir, '.sakura-cloud', 'env.json'), 'utf-8'))?.persistence?.objectStorage?.map((b: any) => b.bucket) ?? []
const run = async () => { await startServer(CLUSTER_GONE); return teardown(EVENT, dir, AUTH, GO) }
const NAMES = (...b: string[]) => b.map(x => `『${x}』`).join('')
const LEFTOVER_LINE = (...b: string[]) => `\n保存場所${NAMES(...b)}が残っています（消すまで月額が続きます）。`
const STORAGE_LABEL = (b: string) => `保存場所『${b}』（月額が続きます）`

// ── C-4 保存場所の残りの全件 ────────────────────────────────────────────

describe('C-4 保存場所が2件以上で途中で止まった回: 残りを全件返す・全件の印を書く', () => {
  it('★★★ 1件目の一覧に失敗 → remainingBuckets が2件・message に2件の名前・TeardownView.remaining が2件・記録の警告にも2件目の名前。何も消えていない', async () => {
    project()
    h.listThrowsFor = new Set([A])

    const r = await run()

    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.remainingBuckets).toEqual([A, B])
    expect(r.remaining).toEqual({ storageBucket: A })           // 止まった1件のまま（型と手順6の文を壊さない）
    expect(r.message).toContain(LEFTOVER_LINE(A, B))
    expect(h.deletedBuckets).toEqual([])
    const view = toTeardownView(D, r)
    expect(view.remaining.map(l => l.label)).toEqual([STORAGE_LABEL(A), STORAGE_LABEL(B)])
    expect(view.warnings.join('\n')).toContain(STORAGE_LABEL(B))
    // 開き直した画面が読む記録（summarizeResult）にも、2件目の名前が出る
    expect(summarizeResult(r).warnings.join('\n')).toContain(STORAGE_LABEL(B))
    expect(getOps(dir).last?.result?.warnings.join('\n')).toContain(STORAGE_LABEL(B))
    expect((getOps(dir).last?.result?.extra as any)?.remainingBuckets).toEqual([A, B])
    // 押し直しの印: storageLeftoverBucket は先頭1件・storageLeftoverBuckets は全件（同じ回に両方）。行は残る（V9）
    expect(readApprunDedicatedFs(dir)).toMatchObject({ storageLeftoverBucket: A, storageLeftoverBuckets: [A, B] })
    expect(rowExists()).toBe(true)
  })

  it('★★ 2件目で失敗 → 1件目は片づいている。残りは2件目だけ（先頭＝止まった1件）。env.json から消えたバケットは外れる', async () => {
    project()
    h.listThrowsFor = new Set([B])
    const r = await run()
    expect(r.ok).toBe(false)
    expect(h.deletedBuckets).toEqual([A])
    expect(r.remainingBuckets).toEqual([B])
    expect(r.remaining).toEqual({ storageBucket: B })
    expect(r.message).toContain(LEFTOVER_LINE(B))
    expect(r.message).not.toContain(NAMES(A, B))
    expect(r.executed.some((e: string) => e.includes(A))).toBe(true)
    expect(envBuckets()).toEqual([B])
    const rec = readApprunDedicatedFs(dir)
    expect([rec.storageLeftoverBucket, rec.storageLeftoverBuckets]).toEqual([B, [B]])
  })

  it('★★ 保存場所に接続できなかった回（片づいたものが無い）も全件。印も全件', async () => {
    project()
    h.adapterThrows = true
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([A, B])
    expect(r.remaining).toEqual({ storageBucket: A })
    expect(h.storageCalls).toEqual([])
    expect(readApprunDedicatedFs(dir).storageLeftoverBuckets).toEqual([A, B])
  })

  it('★★★ 片づけそのものが投げた回: 全件を remainingBuckets に・先頭を remaining.storageBucket に・印を全件で書く。押し直すと行ごと片づく', async () => {
    project()
    h.storageThrows = true
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.message).toContain('保存場所を削除できませんでした: 片づけが投げました（テスト）')
    expect(r.message).toContain(LEFTOVER_LINE(A, B))
    expect(r.remainingBuckets).toEqual([A, B])
    expect(r.remaining).toEqual({ storageBucket: A })
    expect(toTeardownView(D, r).remaining.map(l => l.label)).toEqual([STORAGE_LABEL(A), STORAGE_LABEL(B)])
    // 直す前: 印が無く、行を残しても押し直しの 🗑 が「記録にありません」で止まった
    expect(readApprunDedicatedFs(dir)).toMatchObject({ storageLeftoverBucket: A, storageLeftoverBuckets: [A, B] })
    expect(rowExists()).toBe(true)

    // 押し直す: 資源の記録は空でも、印があるので保存場所の片づけまで進み、全部片づいて行が消える
    h.storageThrows = false
    if (server) { server.close(); server = null }
    const again = await run()
    expect(again.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([A, B])
    expect(rowExists()).toBe(false)
    expect(readApprunDedicatedFs(dir).storageLeftoverBucket).toBeFalsy()
    expect(readApprunDedicatedFs(dir).storageLeftoverBuckets).toBeFalsy()
  })

  it('★★ 押し直して全部片づいた回、2つの印を一緒に下ろす（片方だけだと、もう無い保存場所の名前を言い続ける）', async () => {
    project()
    h.listThrowsFor = new Set([A])
    await run()
    if (server) { server.close(); server = null }
    h.listThrowsFor = new Set()
    h.storageCalls = []
    const again = await run()
    expect(again.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([A, B])
    expect(again.remainingBuckets).toBeUndefined()
    const rec = readApprunDedicatedFs(dir)
    expect(rec.storageLeftoverBucket).toBeNull()
    expect(rec.storageLeftoverBuckets).toBeNull()
    expect(rowExists()).toBe(false)
  })

  it('★★ 保存場所が0件になっていた回（env.json から外れている）: 前回の印を2つとも下ろす。旧い記録（1件だけ）も同じ', async () => {
    for (const mark of [
      { storageLeftoverBucket: A, storageLeftoverBuckets: [A, B] },
      { storageLeftoverBucket: A },
      { storageLeftoverBuckets: [A, B] },
    ]) {
      resetProjectOpsForTests()
      project({ storage: [], record: mark })
      if (server) { server.close(); server = null }
      const r = await run()
      expect(r.ok, JSON.stringify(mark)).toBe(true)
      expect(h.storageCalls, '保存場所には触れない').toEqual([])
      const rec = readApprunDedicatedFs(dir)
      expect([rec.storageLeftoverBucket ?? null, rec.storageLeftoverBuckets ?? null], JSON.stringify(mark)).toEqual([null, null])
    }
  })

  it('1件のときも、残りの名前の行と remainingBuckets（1件）と印（全件＝1件）を書く', async () => {
    project({ storage: [consented(A)] })
    h.listThrowsFor = new Set([A])
    const r = await run()
    expect(r.remainingBuckets).toEqual([A])
    expect(r.message).toContain(LEFTOVER_LINE(A))
    expect(readApprunDedicatedFs(dir)).toMatchObject({ storageLeftoverBucket: A, storageLeftoverBuckets: [A] })
  })

})

// ── C-5 鍵の案内 ────────────────────────────────────────────────────────

// 案内の文（書き下す。関数を通すと同語反復になる）。専有型の鍵の名前は koto-<名前>_apprun-dedicated（permissionNameFor）。
const GUIDE = 'さくらのクラウドのコントロールパネルで、オブジェクトストレージのパーミッション「koto-myapp_apprun-dedicated」を削除してください（アクセスキーも一緒に無効になります）。'
const NO_NAME_GUIDE = 'さくらのクラウドのコントロールパネル（オブジェクトストレージのパーミッション）で確かめてください。'
const KEY_LINE = `⚠️ ${KEY_REVOKE_FAILED_WARNING}`
const count = (lines: readonly string[], needle: string) => lines.join('\n').split(needle).length - 1

describe('C-5 鍵の案内: 無効にできなかった ⚠️ の行に、名前つきの案内が1回だけ付く（ID の末尾は添えない）', () => {
  it('★★★ 記録の鍵の無効化が投げる → executed・summarizeResult・toTeardownView・処理の記録の警告に同じ1行。案内は1回。記録の鍵は残す', async () => {
    project({ storage: [consented(A)], record: { storagePermissionId: 'perm-live' } })
    h.revokeThrows = true
    const r = await run()
    expect(r.ok).toBe(true)
    const LINE = `${KEY_LINE}。${GUIDE}`
    expect(r.executed).toContain(LINE)
    expect(summarizeResult(r).warnings).toContain(LINE)
    expect(toTeardownView(D, r).warnings).toContain(LINE)
    expect(getOps(dir).last?.result?.warnings).toContain(LINE)
    expect(count(r.executed, GUIDE)).toBe(1)
    expect(readApprunDedicatedFs(dir).storagePermissionId).toBe('perm-live')   // 案内を足しても、記録の鍵を残す判断は変わらない
    // 0.6.21 から: 直す前の言い方（鍵）は戻さない。ID の末尾は添えない（10.16）
    expect(r.executed.join('\n')).not.toContain('鍵を無効')
    expect(r.executed.join('\n')).not.toMatch(/ID の末尾|…[0-9a-zA-Z]{4}/)
  })

  it('★★ 警告が2行（記録の鍵の失敗＋名前が一致する鍵の一括の失敗）→ 案内は最後の1行だけ。全体で1回', async () => {
    project({ storage: [consented(A)], record: { storagePermissionId: 'perm-live' } })
    h.permissions = [{ id: 'perm-old', displayName: 'koto-myapp_apprun-dedicated' }]
    h.revokeThrows = true
    const r = await run()
    const warned = r.executed.filter((l: string) => l.startsWith('⚠️'))
    expect(warned).toEqual([KEY_LINE, `⚠️ 保存場所のアクセスキーを1件、無効にできませんでした。${GUIDE}`])
    expect(count(r.executed, GUIDE)).toBe(1)
    expect(summarizeResult(r).warnings).toEqual(expect.arrayContaining(warned))
  })

  it('鍵の一覧が取れない回も、案内が1回（最後の1行に）', async () => {
    project({ storage: [consented(A)], record: { storagePermissionId: 'perm-live' } })
    h.listPermissionsThrows = true
    const r = await run()
    const warned = r.executed.filter((l: string) => l.startsWith('⚠️'))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('パーミッション（アクセスキー）の一覧を取得できなかったため')
    expect(warned[0].endsWith(GUIDE)).toBe(true)
    expect(count(r.executed, GUIDE)).toBe(1)
  })

  it('★★★ 保存場所を消したあとに env.json が読めなくなっても、結果を失わず、案内の名前も保つ（名前は何も消す前に読む）', async () => {
    project({ storage: [consented(A)], record: { storagePermissionId: 'perm-live' } })
    h.revokeThrows = true
    h.afterDeleteKeys = () => fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), '{ 壊れた JSON', 'utf-8')
    const r = await run()
    expect(h.storageCalls).toContain(`deleteKeys ${A}`)
    expect(r).toMatchObject({ ok: true, appDeleted: true })
    expect(r.executed).toContain(`${KEY_LINE}。${GUIDE}`)   // 読み直していれば、名前を失って「確かめてください」の文になる
    expect(count(r.executed, NO_NAME_GUIDE)).toBe(0)
  })

  it('鍵を無効にできた回・鍵が無い回 → 案内は出ない。共用型・HANAMII の鍵の名前を言わない', async () => {
    project({ storage: [consented(A)], record: { storagePermissionId: 'perm-live' } })
    const r = await run()
    expect(h.deletedPermissions).toEqual(['perm-live'])
    expect(r.executed.join('\n')).not.toContain('パーミッション「')
    expect(summarizeResult(r).warnings.join('\n')).not.toContain('パーミッション「')

    // 失敗した回に、ほかの公開先の鍵の名前（koto-myapp・koto-myapp-hanamii）は出ない
    resetProjectOpsForTests()
    if (server) { server.close(); server = null }
    h.revokeThrows = true
    project({ storage: [consented(A)], record: { storagePermissionId: 'perm-live' } })
    const failed = await run()
    expect(count(failed.executed, '「koto-myapp」')).toBe(0)
    expect(count(failed.executed, '「koto-myapp-hanamii」')).toBe(0)
    expect(count(failed.executed, '「koto-myapp_apprun-dedicated」')).toBe(1)
  })

  it('★ 鍵の警告があっても、保存場所だけ残った回の残りの全件（C-4）と両立する（案内は executed、残りの名前は message・remainingBuckets）', async () => {
    project({ record: { storagePermissionId: 'perm-live' } })
    h.listThrowsFor = new Set([B])
    h.revokeThrows = true
    h.permissions = [{ id: 'perm-old', displayName: 'koto-myapp_apprun-dedicated' }]
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([B])
    expect(count(r.executed, GUIDE)).toBe(1)
  })
})
