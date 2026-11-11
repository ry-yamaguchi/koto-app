import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 失敗の文の「双子」を揃える（接続の試験・ワークスペース一覧・状態・ログ・公開のあとの ERROR・再起動）。
// どれも hanamiiFailureMessage を通り、200＋本文 error を「HTTP 200」と書かず、HTML の本文を主の文に載せない。
// 偽の fetch に実際に流して、返り値の文を見る（ソースの文字列は読まない）。

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { HanamiiClient } from '../src/main/hanamii/client'
import { describeErrorCode } from '../src/shared/hanamiiErrorCode'

registerHanamiiHandlers({} as any)

const BASE = 'https://hanamii.jp'
const TOKEN = 'tok-test'
const jsonRes = (status: number, data: unknown) => ({ ok: status >= 200 && status < 300, status, async text() { return data === '' ? '' : (typeof data === 'string' ? data : JSON.stringify(data)) } })
const HTML = '<html><head><title>502 Bad Gateway</title></head><body>gateway</body></html>'

let realFetch: typeof globalThis.fetch
let script: (method: string, url: string) => ReturnType<typeof jsonRes>
let calls: string[] = []
let dirs: string[] = []
beforeEach(() => {
  calls = []; dirs = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any) => { const m = init?.method ?? 'GET'; calls.push(`${m} ${String(input)}`); return script(m, String(input)) }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})
const call = (channel: string, ...args: any[]) => h.handlers.get(channel)!({}, ...args)
const BODY_ERROR = { error: { code: 'internal_error', message: '内部エラー' } }

describe('★★★ 接続の試験・ワークスペース一覧・状態・ログ: 失敗の文は hanamiiFailureMessage と同じ形', () => {
  it('testConnection: 500 の理由が添わる／HTML は添えない／200＋本文 error は「HTTP 200」と書かず code', async () => {
    script = () => jsonRes(500, { error: { code: 'internal', message: '内部の都合' } })
    expect((await new HanamiiClient({ token: TOKEN }).testConnection()).message).toBe('接続に失敗しました（HTTP 500）: 内部の都合')
    script = () => jsonRes(502, HTML)
    expect((await new HanamiiClient({ token: TOKEN }).testConnection()).message).toBe('接続に失敗しました（HTTP 502）')
    script = () => jsonRes(200, BODY_ERROR)
    expect((await new HanamiiClient({ token: TOKEN }).testConnection()).message).toBe('接続に失敗しました（internal_error）: 内部エラー')
  })
  it('testConnection: 401・403 の特別な文は残る', async () => {
    script = () => jsonRes(401, { error: { code: 'unauthorized', message: 'x' } })
    expect((await new HanamiiClient({ token: TOKEN }).testConnection()).message).toBe('認証に失敗しました（HANAMII のトークンを確認してください）')
  })
  it('listWorkspaces: 401/403 の特別な文は残り、ほかは理由つき／HTML は添えない／200＋本文 error は code', async () => {
    script = () => jsonRes(403, { error: { code: 'forbidden', message: 'x' } })
    expect((await call('hanamii:listWorkspaces', TOKEN)).message).toBe('認証に失敗しました（HANAMII のトークンを確認してください）')
    script = () => jsonRes(500, { error: { code: 'internal', message: '内部の都合' } })
    expect((await call('hanamii:listWorkspaces', TOKEN)).message).toBe('取得に失敗しました（HTTP 500）: 内部の都合')
    script = () => jsonRes(502, HTML)
    expect((await call('hanamii:listWorkspaces', TOKEN)).message).toBe('取得に失敗しました（HTTP 502）')
    script = () => jsonRes(200, BODY_ERROR)
    expect((await call('hanamii:listWorkspaces', TOKEN)).message).toBe('取得に失敗しました（internal_error）: 内部エラー')
  })
  it('status: 理由つき／200＋本文 error は code（HTTP 200 と書かない）', async () => {
    script = () => jsonRes(500, { error: { code: 'internal', message: '内部の都合' } })
    expect((await call('hanamii:status', 'p1', TOKEN)).message).toBe('状態の取得に失敗しました（HTTP 500）: 内部の都合')
    script = () => jsonRes(200, BODY_ERROR)
    const r = await call('hanamii:status', 'p1', TOKEN)
    expect(r.ok).toBe(false)
    expect(r.message).toBe('状態の取得に失敗しました（internal_error）: 内部エラー')
  })
  it('logs: 理由つき／200＋本文 error は code（HTTP 200 と書かない）', async () => {
    script = () => jsonRes(500, { error: { code: 'internal', message: '内部の都合' } })
    expect((await call('hanamii:logs', TOKEN, 'p1')).message).toBe('ログの取得に失敗しました（HTTP 500）: 内部の都合')
    script = () => jsonRes(200, BODY_ERROR)
    const r = await call('hanamii:logs', TOKEN, 'p1')
    expect(r.ok).toBe(false)
    expect(r.message).toBe('ログの取得に失敗しました（internal_error）: 内部エラー')
  })
})

describe('★★★ 公開のあとに新しい版が ERROR: errorCode は表を通した説明を添える', () => {
  function project(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hnm-twins-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
    return dir
  }
  const run = (errorCode: string) => {
    script = (method, url) => {
      if (method === 'POST' && url === `${BASE}/api/v1/uploads`) return jsonRes(200, { upload: { uploadUrl: 'https://upload.example/zip', id: 'up-1' } })
      if (method === 'PUT') return jsonRes(200, {})
      if (method === 'POST' && url.endsWith('/check')) return jsonRes(200, { result: { canDeploy: true, checkId: 'chk-1' } })
      if (method === 'POST' && url === `${BASE}/api/v1/projects`) return jsonRes(200, { project: { id: 'proj-1' }, deployment: { id: 'dep-1' } })
      if (method === 'GET' && url === `${BASE}/api/v1/projects/proj-1`) return jsonRes(200, { project: { id: 'proj-1', latestDeployment: { id: 'dep-1', readyState: 'ERROR', errorCode } } })
      return jsonRes(404, {})
    }
    return call('hanamii:publish', project(), { token: TOKEN, workspaceId: 'ws-1', name: 'myapp' })
  }
  it('表にある値（4つ）: エラーコードと、表の文（全文）が入る', async () => {
    for (const code of ['check_error', 'build_error', 'deploy_error', 'health_error']) {
      const r = await run(code)
      expect(r.deployState).toBe('error')
      expect(r.message, code).toContain(`（エラーコード: ${code}）。${describeErrorCode(code)}`)
    }
  })
  it('表に無い値: コードをそのまま見せ、説明は足さない（推測しない）', async () => {
    const r = await run('SOMETHING_NEW')
    expect(r.message).toContain('（エラーコード: SOMETHING_NEW）。')
    expect(r.message).not.toContain('エラーコード: SOMETHING_NEW。')
    expect(r.message).toBe('HANAMII が新しいバージョンを起動できませんでした（エラーコード: SOMETHING_NEW）。HANAMII の管理画面でログを確かめてください。')
  })
})

describe('★★★ 再起動: 設定の保存が済んだあとで restart だけが失敗した回は、保存が済んだことを返す', () => {
  const ENVS = [{ key: 'A', value: '1', type: 'plain' as const }]
  const HC = { enabled: true, path: '/', port: null }
  function restartScript(over: { env?: ReturnType<typeof jsonRes>; hc?: ReturnType<typeof jsonRes>; restart: ReturnType<typeof jsonRes> | (() => never) }) {
    script = (method, url) => {
      if (method === 'PATCH') return over.env ?? jsonRes(200, {})
      if (method === 'PUT') return over.hc ?? jsonRes(200, {})
      if (method === 'POST' && url.endsWith('/restart')) return typeof over.restart === 'function' ? over.restart() : over.restart
      return jsonRes(404, {})
    }
  }
  const restart = (opts: Record<string, unknown>) => call('hanamii:restart', 'p1', { token: TOKEN, ...opts })

  it('restart が 200＋本文 error: ok:false・envsSaved と healthCheckSaved・文は main の失敗の文のまま', async () => {
    restartScript({ restart: jsonRes(200, { error: { code: 'health_check_failed', message: 'ヘルスチェックに応答しませんでした' } }) })
    const r = await restart({ envs: ENVS, healthCheck: HC })
    expect(r.ok).toBe(false)
    expect(r.envsSaved).toBe(true)
    expect(r.healthCheckSaved).toBe(true)
    expect(r.message).toBe('再起動に失敗しました（health_check_failed）: ヘルスチェックに応答しませんでした')
  })
  it('restart が 500／時間切れの例外でも、保存が済んだ側の印が付く', async () => {
    restartScript({ restart: jsonRes(500, { error: { code: 'internal', message: 'x' } }) })
    const a = await restart({ envs: ENVS })
    expect(a.envsSaved).toBe(true)
    expect(a.healthCheckSaved).toBeUndefined()
    restartScript({ restart: () => { throw new Error('The operation was aborted due to timeout') } })
    const r = await restart({ healthCheck: HC })
    expect(r.ok).toBe(false)
    expect(r.healthCheckSaved).toBe(true)
    expect(r.envsSaved).toBeUndefined()
  })
  it('保存そのものが失敗した側・渡した設定が無い回は印を付けない', async () => {
    restartScript({ env: jsonRes(403, { error: { code: 'forbidden', message: 'x' } }), restart: jsonRes(200, {}) })
    const a = await restart({ envs: ENVS })
    expect(a.ok).toBe(false)
    expect(a.envsSaved).toBeUndefined()
    expect(a.healthCheckSaved).toBeUndefined()
    restartScript({ restart: jsonRes(500, { error: { code: 'internal', message: 'x' } }) })
    const b = await restart({})
    expect(b.envsSaved).toBeUndefined()
    expect(b.healthCheckSaved).toBeUndefined()
  })
  it('★★ 環境変数は保存できて、ヘルスチェックの保存で止まった回: envsSaved だけが付く（HANAMII の env は新しくなっている）', async () => {
    restartScript({ hc: jsonRes(400, { error: { code: 'bad', message: 'x' } }), restart: jsonRes(200, {}) })
    const r = await restart({ envs: ENVS, healthCheck: HC })
    expect(r.ok).toBe(false)
    expect(r.envsSaved).toBe(true)
    expect(r.healthCheckSaved).toBeUndefined()
  })
})
