import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 公開で発行した保存場所の鍵を取り消してよいのは、「版（プロジェクト）が確実に作られていない」回だけ（お金・鍵の守り・掟10）。
// 作成はストリームで返り、始まったあとの失敗は 200＋本文 error。原本の 502 external_api_error は「結果が不明のことがある」。
// 実は作られていたのに鍵を取り消すと、そのアプリは取り消した鍵で動いて保存場所へ 403 になり、Koto は記録していないので消せず、
// 次の公開は同じ名前で 409 になる。偽の fetch と偽の revokeIssuedKey に実際に流して、「呼ばれた取り消しの一覧」を検査する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  revoked: [] as string[],
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))
vi.mock('../src/main/cloud/storageForTarget', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/cloud/storageForTarget')>()
  return {
    ...real,
    issueStorageEnvFor: async () => ({ ok: true, permissionId: 'perm-new', projectName: 'myapp', envs: [{ key: 'K', value: 'V', secret: true }] }),
    revokeIssuedKey: async (a: { permissionId: string }) => { h.revoked.push(a.permissionId) },
  }
})

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'

registerHanamiiHandlers({} as any)

const BASE = 'https://hanamii.jp'
const TOKEN = 'tok-test'
const jsonRes = (status: number, data: unknown) => ({ ok: status >= 200 && status < 300, status, async text() { return data === '' ? '' : (typeof data === 'string' ? data : JSON.stringify(data)) } })

let realFetch: typeof globalThis.fetch
let script: (method: string, url: string) => ReturnType<typeof jsonRes>
let dirs: string[] = []

beforeEach(() => {
  dirs = []; h.revoked = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any) => script(init?.method ?? 'GET', String(input))) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

function newProject(meta?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hnm-revoke-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  if (meta !== undefined) fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify(meta), 'utf-8')
  return dir
}
const metaOf = (dir: string): any => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8')) } catch { return {} } }
const publish = (dir: string, opts: Record<string, unknown> = {}) =>
  h.handlers.get('hanamii:publish')!({}, dir, { token: TOKEN, workspaceId: 'ws-1', name: 'myapp', withStorage: true, ...opts })

type Over = { create?: () => ReturnType<typeof jsonRes>; env?: ReturnType<typeof jsonRes>; hc?: ReturnType<typeof jsonRes>; deploy?: ReturnType<typeof jsonRes> }
function publishScript(over: Over = {}) {
  script = (method, url) => {
    if (method === 'POST' && url === `${BASE}/api/v1/uploads`) return jsonRes(200, { upload: { uploadUrl: 'https://upload.example/zip', id: 'up-1' } })
    if (method === 'PUT' && url.startsWith('https://upload.example')) return jsonRes(200, {})
    if (method === 'POST' && url.endsWith('/check')) return jsonRes(200, { result: { canDeploy: true, checkId: 'chk-1' } })
    if (method === 'POST' && url === `${BASE}/api/v1/projects`) return (over.create ?? (() => jsonRes(200, { project: { id: 'proj-1' }, deployment: { id: 'dep-1' } })))()
    if (method === 'PATCH' && url.endsWith('/env')) return over.env ?? jsonRes(200, {})
    if (method === 'PUT' && url.endsWith('/health-check')) return over.hc ?? jsonRes(200, {})
    if (method === 'POST' && url.endsWith('/deploy')) return over.deploy ?? jsonRes(200, { deployment: { id: 'dep-2' } })
    return jsonRes(404, { error: { code: 'not_found', message: `想定外: ${method} ${url}` } })
  }
}
const NOT_CONFIRMED = 'HANAMII のプロジェクト『myapp』が作られたか確かめられませんでした。HANAMII の管理画面で『myapp』があるか確かめてください。'

describe('★★★ 初回の作成: 鍵を取り消すのは HTTP 4xx（ストリームが始まる前の断り）の回だけ', () => {
  for (const status of [400, 401, 403, 409, 413, 415, 429]) {
    it(`HTTP ${status} → 作られていないので、いま発行した鍵を取り消す`, async () => {
      publishScript({ create: () => jsonRes(status, { error: { code: 'refused', message: '断られました' } }) })
      const dir = newProject()
      const r = await publish(dir)
      expect(r.ok).toBe(false)
      expect(r.message).toBe(`公開に失敗しました（HTTP ${status}）: 断られました`)
      expect(h.revoked).toEqual(['perm-new'])
      expect(metaOf(dir).publish?.hanamii?.projectId ?? null).toBeNull()
    })
  }

  const UNKNOWN: Array<[string, () => ReturnType<typeof jsonRes>]> = [
    ['2xx の本文 error', () => jsonRes(200, { error: { code: 'build_failed', message: '途中で失敗' } })],
    ['2xx で projectId が無い', () => jsonRes(200, { deployment: { id: 'dep-1' } })],
    ['500', () => jsonRes(500, { error: { code: 'internal', message: 'x' } })],
    ['502 external_api_error', () => jsonRes(502, { error: { code: 'external_api_error', message: '外部 API の失敗' } })],
    ['502 の HTML', () => jsonRes(502, '<html><body>Bad Gateway</body></html>')],
    ['時間切れ・切断（例外）', () => { throw new Error('The operation was aborted due to timeout') }],
  ]
  for (const [name, create] of UNKNOWN) {
    it(`${name} → 作られたか分からないので、鍵を取り消さない。記録に projectId を書かない。名前を挙げて管理画面で確かめるよう言う`, async () => {
      publishScript({ create })
      const dir = newProject()
      const r = await publish(dir)
      expect(r.ok).toBe(false)
      expect(h.revoked).toEqual([])
      expect(r.message).toBe(NOT_CONFIRMED)
      expect(r.message).not.toContain('📡')
      const hn = metaOf(dir).publish?.hanamii
      expect(hn?.projectId ?? null).toBeNull()
      expect(hn?.publishedAt).toBeUndefined()
    })
  }

  it('原文は detail に残る（HTTP の状態と本文）', async () => {
    publishScript({ create: () => jsonRes(502, { error: { code: 'external_api_error', message: '外部 API の失敗' } }) })
    const r = await publish(newProject())
    expect(r.detail).toContain('HTTP 502')
    expect(r.detail).toContain('external_api_error')
  })
  it('通常の作成は成功し、鍵は取り消さない', async () => {
    publishScript()
    const dir = newProject()
    expect((await publish(dir)).ok).toBe(true)
    expect(h.revoked).toEqual([])
    expect(metaOf(dir).publish.hanamii.projectId).toBe('proj-1')
  })
})

describe('★★★ 再公開: 新しい鍵を載せた環境変数を HANAMII へ保存したあとは、鍵を取り消さない', () => {
  const existing = () => newProject({ publish: { hanamii: { projectId: 'proj-1' } } })
  const hcOpt = { healthCheck: { enabled: true, path: '/', port: null } }

  it('環境変数の保存（patchEnv）が失敗した回は、まだ保存されていないので取り消す', async () => {
    publishScript({ env: jsonRes(403, { error: { code: 'forbidden', message: 'x' } }) })
    const r = await publish(existing())
    expect(r.ok).toBe(false)
    expect(h.revoked).toEqual(['perm-new'])
  })
  it('ヘルスチェックの保存が失敗した回（patchEnv は通った）は取り消さない', async () => {
    publishScript({ hc: jsonRes(400, { error: { code: 'bad', message: 'x' } }) })
    const r = await publish(existing(), hcOpt)
    expect(r.ok).toBe(false)
    expect(h.revoked).toEqual([])
  })
  it('redeploy が 4xx で断られた回も取り消さない', async () => {
    publishScript({ deploy: jsonRes(409, { error: { code: 'conflict', message: 'x' } }) })
    const r = await publish(existing())
    expect(r.ok).toBe(false)
    expect(h.revoked).toEqual([])
  })
  it('redeploy が 2xx の本文 error で失敗した回も取り消さない', async () => {
    publishScript({ deploy: jsonRes(200, { error: { code: 'deploy_failed', message: 'x' } }) })
    const r = await publish(existing())
    expect(r.ok).toBe(false)
    expect(r.message).toBe('公開に失敗しました（deploy_failed）: x')
    expect(h.revoked).toEqual([])
  })
  it('通常の再公開は成功し、取り消さない', async () => {
    publishScript()
    const r = await publish(existing())
    expect(r.ok).toBe(true)
    expect(h.revoked).toEqual([])
  })
})
