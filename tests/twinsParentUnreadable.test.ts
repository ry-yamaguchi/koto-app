import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'

// ── 0.6.24 R2-f: 親フォルダの一覧を読めない回を、「複製なし」と同じに返さない ─────────────────────────────────────────
// いまは `recordTwinsFs` が、親フォルダの一覧を読めなかったとき空（複製なし）を返し、破棄が進む（複製がいるかもしれないのに）。
// 直し方: 一覧を読めなかったら `'unknown'`。骨（`twinsOf`）は `TWINS_UNKNOWN_MESSAGE` で断り（外への要求0件・記録は消さない）、
// `cloud:recordTwins` は `ok:false`（画面の twins は null で、plan は何も外さない）。**読めない兄弟（壊れたリンクなど）は今どおり数えない**（すべての破棄が止まらないように）。
// 親を 0o311（所有者は辿れるが一覧は読めない）にした本物のフォルダで、3つの破棄の IPC と cloud:recordTwins を流し、出た要求の一覧で固定する（掟10）。
// 変異: 一覧を読めなかったとき空を返す形に戻す／骨が 'unknown' を通す／readRecordTwins が 'unknown' を空にする。
import { A, OK_AUTH, CONSENTED_AT, bucketRef, APP, h, resetHarness, newProjectDir, workspaceOf, setup, stateKinds, writePublishRecord, publishTargets, envBuckets } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

const d = vi.hoisted(() => ({ baseUrl: '' }))
vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => {
  const real = await orig<any>()
  return { ...real, teardownFlow: (auth: any, dir: string, opts: any) => real.teardownFlow(auth, dir, { ...opts, sleep: async () => {} }, d.baseUrl) }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { writeApprunDedicatedRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { recordTwinsFs, readRecordTwins, RECORD_TWINS_UNKNOWN_MESSAGE } from '../src/main/cloud/recordTwins'
import { TWINS_UNKNOWN_MESSAGE } from '../src/main/cloud/teardownShell'
import { deleteProjectReply } from './hanamiiTeardownFixtures'

registerCloudHandlers({} as any)
registerHanamiiHandlers({} as any)
registerApprunDedicatedHandlers({} as any)
const sharedTeardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const hanamiiTeardown = shownTeardown(h.handlers.get('hanamii:teardown')!)
const dedicatedTeardown = shownTeardown(h.handlers.get('apprunDedicated:teardown')!)
const recordTwinsIpc = (projectDir: unknown) => h.handlers.get('cloud:recordTwins')!({}, projectDir)

const EVENT = { sender: { send: () => {} } }
const ROW = { publishedAt: CONSENTED_AT, url: 'https://x.example/' }
const rootIsMe = typeof process.getuid === 'function' && process.getuid() === 0
const skipIfRoot = rootIsMe ? it.skip : it

let dir = ''
let server: Server | null = null
const realFetch = globalThis.fetch
beforeEach(() => {
  resetHarness()
  resetProjectOpsForTests()
  d.baseUrl = ''
  dir = newProjectDir()
})
afterEach(() => {
  if (server) { server.close(); server = null }
  globalThis.fetch = realFetch
  try { fs.chmodSync(workspaceOf(dir), 0o755) } catch { /* 無い */ }
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 親フォルダを、辿れるが一覧は読めない形（0o311）にする。 */
const lockParent = () => fs.chmodSync(workspaceOf(dir), 0o311)
const unlockParent = () => fs.chmodSync(workspaceOf(dir), 0o755)
const readMeta = (p: string): any => JSON.parse(fs.readFileSync(path.join(p, '.sakuraide.json'), 'utf-8'))
const writeHanamii = (p: string, projectId: string) => {
  fs.mkdirSync(p, { recursive: true })
  fs.writeFileSync(path.join(p, '.sakuraide.json'), JSON.stringify({ publish: { hanamii: { projectId }, targets: { hanamii: ROW } } }, null, 2), 'utf-8')
}

describe('★★★ recordTwinsFs: 親フォルダの一覧を読めなかったら \'unknown\'（空と同じに返さない）', () => {
  skipIfRoot('★★★ 3つの公開先とも、自分の記録に識別子がある回は 0o311 の親で \'unknown\'。読める親では複製の名前の並び', () => {
    writeHanamii(dir, 'hnm-1')
    setup(dir, { env: [], resources: [APP] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    lockParent()
    expect(recordTwinsFs(dir, 'hanamii')).toBe('unknown')
    expect(recordTwinsFs(dir, 'sakura-apprun')).toBe('unknown')
    expect(recordTwinsFs(dir, 'sakura-apprun-dedicated')).toBe('unknown')
    unlockParent()
    expect(recordTwinsFs(dir, 'hanamii')).toEqual([])
    expect(recordTwinsFs(dir, 'sakura-apprun')).toEqual([])
    expect(recordTwinsFs(dir, 'sakura-apprun-dedicated')).toEqual([])
  })

  skipIfRoot('対照: 自分の記録に識別子が無い公開先は、親が読めなくても空（比べる相手が無い）', () => {
    writeHanamii(dir, 'hnm-1')
    lockParent()
    expect(recordTwinsFs(dir, 'hanamii')).toBe('unknown')
    expect(recordTwinsFs(dir, 'sakura-apprun')).toEqual([])
    expect(recordTwinsFs(dir, 'sakura-apprun-dedicated')).toEqual([])
  })

  it('projectDir が文字列でない・空は確かめられない（\'unknown\'）。存在しないフォルダは比べる記録が無いので空。投げない', () => {
    expect(recordTwinsFs(undefined as unknown as string, 'hanamii')).toBe('unknown')
    expect(recordTwinsFs(null as unknown as string, 'hanamii')).toBe('unknown')
    expect(recordTwinsFs('', 'hanamii')).toBe('unknown')
    expect(recordTwinsFs(path.join(workspaceOf(dir), 'no-such'), 'hanamii')).toEqual([])
  })

  it('★★ 今どおり: 読めない兄弟（壊れたリンク・壊れた記録）は数えない。複製は見つかる（\'unknown\' にしない）', () => {
    writeHanamii(dir, 'hnm-1')
    writeHanamii(path.join(workspaceOf(dir), 'copy'), 'hnm-1')
    fs.symlinkSync(path.join(workspaceOf(dir), 'nowhere'), path.join(workspaceOf(dir), 'dead-link'))
    fs.mkdirSync(path.join(workspaceOf(dir), 'broken')); fs.writeFileSync(path.join(workspaceOf(dir), 'broken', '.sakuraide.json'), '{ not json')
    expect(recordTwinsFs(dir, 'hanamii')).toEqual(['copy'])
    fs.rmSync(path.join(workspaceOf(dir), 'copy'), { recursive: true })
    expect(recordTwinsFs(dir, 'hanamii')).toEqual([])
  })
})

describe('★★★ cloud:recordTwins: 親フォルダの一覧を読めなければ ok:false（空の答えにしない）', () => {
  skipIfRoot('★★★ 0o311 の親 → ok:false・文つき。読める親 → ok:true（空の3つ）。フォルダの中身は変わらない', async () => {
    writeHanamii(dir, 'hnm-1')
    lockParent()
    expect(await recordTwinsIpc(dir)).toEqual({ ok: false, message: RECORD_TWINS_UNKNOWN_MESSAGE })
    expect(readRecordTwins(dir)).toEqual({ ok: false, message: RECORD_TWINS_UNKNOWN_MESSAGE })
    unlockParent()
    expect(await recordTwinsIpc(dir)).toEqual({ ok: true, twins: { hanamii: [], 'sakura-apprun': [], 'sakura-apprun-dedicated': [] } })
    expect(readMeta(dir).publish.hanamii.projectId).toBe('hnm-1')
  })

  skipIfRoot('★★ 1つの公開先だけが読めなくても（ほかは複製が見つかっていても）、全体が ok:false。見つかった複製だけを返さない', async () => {
    writeHanamii(dir, 'hnm-1')
    writeHanamii(path.join(workspaceOf(dir), 'copy'), 'hnm-1')
    expect((await recordTwinsIpc(dir)).twins.hanamii).toEqual(['copy'])
    lockParent()
    expect(await recordTwinsIpc(dir)).toEqual({ ok: false, message: RECORD_TWINS_UNKNOWN_MESSAGE })
  })
})

describe('★★★ 3つの破棄の骨: 親フォルダの一覧を読めなければ、外への要求0件・記録も消さずに断る', () => {
  skipIfRoot('★★★ 共用型 cloud:teardown → deleteApp 0件・保存場所・鍵への要求も0件。ok:false・TWINS_UNKNOWN_MESSAGE。記録は残る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { storagePermissionId: 'perm-rec' } })
    writePublishRecord(dir, { 'sakura-apprun': ROW })
    lockParent()
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: false, registryName: null })
    expect(reply).toEqual({ ok: false, message: TWINS_UNKNOWN_MESSAGE })
    expect(h.calls, '親の一覧を読めないのに、外へ要求が出た').toEqual([])
    unlockParent()
    expect(stateKinds(dir)).toEqual(['bucket', 'apprun-app'])
    expect(envBuckets(dir)).toEqual([A])
    expect(publishTargets(dir)).toEqual({ 'sakura-apprun': ROW })
  })

  skipIfRoot('★★★ HANAMII hanamii:teardown → HANAMII への要求0件・保存場所への要求も0件。ok:false・TWINS_UNKNOWN_MESSAGE。projectId と公開の記録は残る', async () => {
    const hanamiiFetch: string[] = []
    globalThis.fetch = (async (url: string, init?: { method?: string }) => {
      hanamiiFetch.push(`${init?.method ?? 'GET'} ${url}`)
      return deleteProjectReply(200, 'hnm-1')
    }) as unknown as typeof fetch
    setup(dir, { env: [A], resources: [] })
    writeHanamii(dir, 'hnm-1')
    lockParent()
    const result = await hanamiiTeardown(EVENT, dir, { token: 'hnm_test' }, { confirmed: true, projectId: 'hnm-1' })
    expect(result).toEqual({ ok: false, message: TWINS_UNKNOWN_MESSAGE })
    expect(hanamiiFetch, '親の一覧を読めないのに、HANAMII へ要求が出た').toEqual([])
    expect(h.calls).toEqual([])
    unlockParent()
    expect(readMeta(dir).publish.hanamii.projectId).toBe('hnm-1')
    expect(readMeta(dir).publish.targets.hanamii).toEqual(ROW)
  })

  skipIfRoot('★★★ 専有型 apprunDedicated:teardown → さくらへの要求0件・保存場所への要求も0件。ok:false・TWINS_UNKNOWN_MESSAGE。資源の ID と公開の記録は残る', async () => {
    const requests: string[] = []
    server = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { requests.push(`${req.method} ${req.url}`); res.writeHead(404); res.end('{}') }) })
    d.baseUrl = await new Promise<string>(resolve => server!.listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as any).port}/`)))
    setup(dir, { env: [A], resources: [] })
    writeApprunDedicatedRecordFs(dir, { clusterID: 'c1' })
    lockParent()
    const result = await dedicatedTeardown(EVENT, dir, { token: 'tok', secret: 'sec' }, { confirmed: true })
    expect(result.ok).toBe(false)
    expect(result.message).toBe(TWINS_UNKNOWN_MESSAGE)
    expect(requests, '親の一覧を読めないのに、さくらへ要求が出た').toEqual([])
    expect(h.calls).toEqual([])
    unlockParent()
    expect(readApprunDedicatedFs(dir).clusterID).toBe('c1')
  })

  it('対照: 親が読めて複製がいなければ、これまでどおり破棄が進む（この試験が要求を見ていることの確認）', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    const reply = await sharedTeardown(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: false, registryName: null })
    expect(reply.ok).toBe(true)
    expect(h.calls).toContain('deleteApp app-1')
  })
})
