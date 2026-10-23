// 共用型の破棄 cloud:teardown / cloud:teardownRecord を、本物の main に偽の client・偽の保存場所で流すための土台
// （設計書 docs/teardown-unify-plan.md 10.7.2・10.7.12 の P5・C・D。tests/sharedTeardown*.test.ts が使う）。
//
// 使い方: 各テストファイルの先頭で、次の3つの vi.mock を書く（vi.mock はそのファイルの中でしか効かない）。
//   vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
//   vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
//   vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
//   vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))
// 実物の判断（storageTeardown.ts → teardownPlanFor）と applyPlan は mock しない。
import { afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { saveCloudState } from '../src/main/cloud/specStore'
import type { EnvState, ResourceRef } from '../src/main/cloud/state'

export const A = 'koto-data-a'
export const B = 'koto-data-b'
export const PREFIX = 'projects/myapp/'
export const CONSENTED_AT = '2026-08-14T00:00:00.000Z'
export const APP: ResourceRef = { kind: 'apprun-app', id: 'app-1', stateful: false, key: 'apprun-app:myapp' }
export const bucketRef = (bucket: string): ResourceRef => ({ kind: 'bucket', id: bucket, stateful: true, key: `bucket:${bucket}`, prefix: PREFIX })
export const REGISTRY_ROW = { ID: 'reg-1', Provider: { Class: 'containerregistry' }, Status: { registry_name: 'myreg' } }
export const OK_AUTH = { heldByMain: true } as const

type Failure = 'throw' | 'http500'
export const h = {
  handlers: new Map<string, (...args: any[]) => any>(),
  creds: { token: 'TEST-TOKEN', secret: 'TEST-SECRET' } as null | { token: string; secret: string },
  /** 保存場所・client へ出た要求の一覧（**1本・順序つき**）。 */
  calls: [] as string[],
  /** どのバケットを一覧しても返る中身。 */
  keys: [`${PREFIX}data.json`] as string[],
  /** バケットごとに中身を変えたいとき（ここにあるバケットは keys より優先）。 */
  keysByBucket: {} as Record<string, string[]>,
  /** listContainerRegistries が返す行。 */
  registryRows: [] as any[],
  /** listPermissions が返す権限。 */
  permissions: [] as Array<{ id: string; displayName: string }>,
  /** 要求の名前（`h.calls` に積まれる名前）→ 失敗のしかた。 */
  fail: {} as Record<string, Failure>,
  /** 仕込むと、deleteApp が入ったところで止まる（`entered` を呼び、`gate` が開くまで待つ）。鍵が埋まっている回を作る。 */
  hold: null as null | { entered: () => void; gate: Promise<void> },
}

export function resetHarness(): void {
  h.creds = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' }
  h.calls = []
  h.keys = [`${PREFIX}data.json`]
  h.keysByBucket = {}
  h.registryRows = []
  h.permissions = []
  h.fail = {}
  h.hold = null
}

/** 要求を記録し、失敗を仕込まれていれば投げる（'http500' の要求は呼び手が応答で表す）。 */
function hit(label: string): Failure | null {
  h.calls.push(label)
  const f = h.fail[label] ?? null
  if (f === 'throw') throw new Error(`テスト用の失敗（${label}）`)
  return f
}

export function electronMock() {
  return {
    ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
    app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
    BrowserWindow: class {},
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
    shell: { openExternal: async () => {} },
    dialog: {},
  }
}

export const authMock = (real: any) => ({ ...real, loadCredentials: () => h.creds })

export function storageAdapterMock(real: any) {
  return {
    ...real,
    createStorageAdapter: async () => {
      hit('connect')
      return {
        siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
        async isSiteReady() { return true },
        async ensureBucket() { h.calls.push('ensureBucket') },
        async putMarker() { h.calls.push('putMarker') },
        async listAllKeys(bucket: string) { hit(`listAllKeys ${bucket}`); return [...(h.keysByBucket[bucket] ?? h.keys)] },
        async deleteKeys(bucket: string) { hit(`deleteKeys ${bucket}`) },
        async deleteBucket(bucket: string) { hit(`deleteBucket ${bucket}`) },
        async deletePermission(id: string) { hit(`deletePermission ${id}`) },
        async issueKey() { h.calls.push('issueKey'); return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' } },
        async listPermissions() { hit('listPermissions'); return [...h.permissions] },
        async dispose() { hit('dispose') },
      }
    },
  }
}

export function clientMock(real: any) {
  class FakeSakuraCloudClient {
    dryRun = false
    constructor(_opts: any) {}
    async deleteApp(id: string) {
      const failure = hit(`deleteApp ${id}`)
      if (h.hold) { const held = h.hold; h.hold = null; held.entered(); await held.gate }
      return failure === 'http500' ? { ok: false, dryRun: false, status: 500 } : { ok: true, dryRun: false }
    }
    async listContainerRegistries(_zone: string) {
      if (hit('listContainerRegistries') === 'http500') return { dryRun: false as const, ok: false, status: 500, data: null }
      return { dryRun: false as const, ok: true, status: 200, data: { CommonServiceItems: h.registryRows } }
    }
    async deleteContainerRegistry(_zone: string, id: string) {
      if (hit(`deleteContainerRegistry ${id}`) === 'http500') return { dryRun: false as const, ok: false, status: 500, data: null }
      return { dryRun: false as const, ok: true, status: 204, data: null }
    }
  }
  return { ...real, SakuraCloudClient: FakeSakuraCloudClient }
}

// ── プロジェクトの置き方 ──────────────────────────────────────────────────────

/**
 * 新しいプロジェクトのフォルダ。**1つごとに、自分だけの親フォルダ（ワークスペース）の中**に作る。
 * 共用型の破棄の確認は、同じ親フォルダの兄弟プロジェクトの記録を読んで「同じコンテナレジストリを使うほかのプロジェクト」を数える（2026-10-19）。
 * 一時フォルダの直下に作ると、同時に走っているほかの試験の残り物を兄弟として読んでしまい、結果が試験の実行順で変わる。
 * 親フォルダごと片づけるのは、ファイルの最後（afterAll）。プロジェクトだけを消す試験（`fs.rmSync(dir)`）は、そのままでよい。
 */
const workspaces: string[] = []
export function newProjectDir(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-shared-teardown-'))
  workspaces.push(ws)
  const dir = path.join(ws, 'myapp')
  fs.mkdirSync(dir)
  return dir
}
/** `newProjectDir()` の親フォルダ（兄弟プロジェクトを置く場所）。 */
export const workspaceOf = (projectDir: string): string => path.dirname(projectDir)
afterAll(() => { for (const ws of workspaces) fs.rmSync(ws, { recursive: true, force: true }) })

/** `.sakura-cloud/env.json`（同意済みの保存場所 `env`）と `state.json`（`resources`・`meta`）を置く。 */
export function setup(projectDir: string, opts: { env: string[]; resources: ResourceRef[]; meta?: EnvState['meta']; envExtra?: (bucket: string) => Record<string, unknown> }): void {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = { objectStorage: opts.env.map(bucket => ({ bucket, prefix: PREFIX, shared: true, consentedAt: CONSENTED_AT, ...(opts.envExtra?.(bucket) ?? {}) })) } as any
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  saveCloudState(projectDir, { name: 'myapp', backend: 'apprun', resources: opts.resources, ...(opts.meta ? { meta: opts.meta } : {}) })
}

const readJson = (projectDir: string, file: string): any => JSON.parse(fs.readFileSync(path.join(projectDir, '.sakura-cloud', file), 'utf-8'))
export const envBuckets = (dir: string): string[] => (readJson(dir, 'env.json')?.persistence?.objectStorage ?? []).map((b: any) => b.bucket)
export const stateKinds = (dir: string): string[] => (readJson(dir, 'state.json')?.resources ?? []).map((r: any) => r.kind)
export const stateMeta = (dir: string): any => readJson(dir, 'state.json')?.meta
/** 公開の記録（.sakuraide.json）。共用型の行（publish.targets['sakura-apprun']）を置く／読む。 */
export function writePublishRecord(dir: string, targets: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify({ publish: { targets } }, null, 2), 'utf-8')
}
export const publishTargets = (dir: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8'))?.publish?.targets ?? {}
