import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// HANAMII の長い処理（check・作成・deploy・restart）は、始まったあとの失敗を HTTP 200 のまま本文の
// {"error":{"code","message"}} で返す（公開 API 文書の restart の節・公式 CLI も本文の error を見る）。
// ここは偽の fetch に実際に流して、client の読み方と、それを使う main の IPC の振る舞いを固定する。

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

import {
  HanamiiClient, HANAMII_REQUEST_TIMEOUT_MS, HANAMII_LONG_REQUEST_TIMEOUT_MS,
  hanamiiErrorMessage, hanamiiFailureMessage, readRestartReply,
} from '../src/main/hanamii/client'
import { readHanamiiDeleteReply } from '../src/main/hanamii/deleteReply'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'

registerHanamiiHandlers({} as any)

const BASE = 'https://hanamii.jp'
const TOKEN = 'tok-test'
const jsonRes = (status: number, data: unknown) => ({ ok: status >= 200 && status < 300, status, async text() { return data === '' ? '' : JSON.stringify(data) } })

let realFetch: typeof globalThis.fetch
let script: (method: string, url: string) => ReturnType<typeof jsonRes>
let reqs: string[] = []
let dirs: string[] = []

beforeEach(() => {
  reqs = []; dirs = []; h.revoked = []
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any) => {
    const method = init?.method ?? 'GET'
    reqs.push(`${method} ${String(input)}`)
    return script(method, String(input))
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const client = () => new HanamiiClient({ token: TOKEN })

describe('★★★ client: 本文の error は HTTP の状態に関わらず失敗', () => {
  it('HTTP 200 でも本文が {error:{code,message}} なら ok:false。状態はそのまま 200、code と message を返り値に載せる', async () => {
    script = () => jsonRes(200, { error: { code: 'health_check_failed', message: 'ヘルスチェックに応答しませんでした' } })
    const r = await client().restart('p1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(200)
    expect(r.apiError).toEqual({ code: 'health_check_failed', message: 'ヘルスチェックに応答しませんでした' })
  })
  it('本文の error が文字列でも失敗', async () => {
    script = () => jsonRes(200, { error: 'something broke' })
    const r = await client().createProject({ name: 'a', workspaceId: 'w', source: { type: 'zip', checkId: 'c' } })
    expect(r.ok).toBe(false)
    expect(r.apiError).toEqual({ code: null, message: 'something broke' })
  })
  it('error が無い・null・空文字の 200 は成功のまま', async () => {
    for (const body of [{ project: { id: 'p' } }, { error: null }, { error: '' }, null]) {
      script = () => jsonRes(200, body === null ? '' : body)
      const r = await client().getProject('p')
      expect(r.ok, JSON.stringify(body)).toBe(true)
      expect(r.apiError).toBeUndefined()
    }
  })
  it('4xx/5xx はこれまでどおり失敗（apiError も載る）', async () => {
    script = () => jsonRes(403, { error: { code: 'forbidden', message: '権限がありません' } })
    const r = await client().listWorkspaces()
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.apiError?.message).toBe('権限がありません')
  })
})

describe('★★★ client: DELETE の読み方（200 deleted・202 accepted・404）は変わらない', () => {
  const del = async (status: number, body: unknown) => {
    script = () => jsonRes(status, body)
    return readHanamiiDeleteReply(await client().deleteProject('p1'))
  }
  it('200 deleted:true → deleted', async () => {
    expect(await del(200, { project: { id: 'p1', deleted: true, deletion: 'completed' } })).toBe('deleted')
  })
  it('202 accepted → accepted（本文に error が無い）', async () => {
    expect(await del(202, { project: { id: 'p1', deleted: false, deletion: 'accepted', operationId: 'op', requiresReview: false } })).toBe('accepted')
  })
  it('404 → not-found（本文が {error:{...}} でも）', async () => {
    expect(await del(404, { error: { code: 'not_found', message: 'プロジェクトが見つかりません' } })).toBe('not-found')
    expect(await del(404, '')).toBe('not-found')
  })
  it('403 → failed', async () => {
    expect(await del(403, { error: { code: 'forbidden', message: 'x' } })).toBe('failed')
  })
})

describe('★★★ client: 時間切れは長い4つだけ 20 分、ほかは 30 秒', () => {
  it('定数は 20 分と 30 秒', () => {
    expect(HANAMII_LONG_REQUEST_TIMEOUT_MS).toBe(20 * 60 * 1000)
    expect(HANAMII_REQUEST_TIMEOUT_MS).toBe(30000)
  })
  it('check・作成・再デプロイ・restart は 20 分。ほかは 30 秒', async () => {
    script = () => jsonRes(200, {})
    const spy = vi.spyOn(AbortSignal, 'timeout')
    const c = client()
    const used = async (call: () => Promise<unknown>) => { spy.mockClear(); await call(); return spy.mock.calls.map(a => a[0]) }
    const LONG = [1200000], SHORT = [30000]
    expect(await used(() => c.checkUpload('u1'))).toEqual(LONG)
    expect(await used(() => c.createProject({ name: 'a', workspaceId: 'w', source: { type: 'zip', checkId: 'c' } }))).toEqual(LONG)
    expect(await used(() => c.redeploy('p', 'c'))).toEqual(LONG)
    expect(await used(() => c.restart('p'))).toEqual(LONG)
    expect(await used(() => c.listWorkspaces())).toEqual(SHORT)
    expect(await used(() => c.createUpload('w', 'a.zip'))).toEqual(SHORT)
    expect(await used(() => c.getProject('p'))).toEqual(SHORT)
    expect(await used(() => c.deleteProject('p'))).toEqual(SHORT)
    expect(await used(() => c.patchEnv('p', []))).toEqual(SHORT)
    expect(await used(() => c.putHealthCheck('p', { enabled: false, path: '/', port: null }))).toEqual(SHORT)
    expect(await used(() => c.getLogs('p'))).toEqual(SHORT)
  })
})

describe('★★★ hanamiiErrorMessage / hanamiiFailureMessage: 文書の形 {error:{code,message}}', () => {
  it('error.message を理由に使う（JSON 全文に落ちない）', () => {
    expect(hanamiiErrorMessage({ error: { code: 'forbidden', message: '権限がありません' } })).toBe('権限がありません')
  })
  it('message が無ければ code を見せる', () => {
    expect(hanamiiErrorMessage({ error: { code: 'rate_limited' } })).toBe('rate_limited')
  })
  it('403 の主の文に HANAMII の日本語の理由が添わる', () => {
    const body = { error: { code: 'forbidden', message: '権限がありません' } }
    expect(hanamiiFailureMessage('公開', { status: 403, data: body, apiError: { code: 'forbidden', message: '権限がありません' } }))
      .toBe('公開に失敗しました（HTTP 403）: 権限がありません')
  })
  it('★★★ 2xx の失敗は「HTTP 200」と書かず code を添える', () => {
    const body = { error: { code: 'health_check_failed', message: 'ヘルスチェックに応答しませんでした' } }
    const m = hanamiiFailureMessage('再起動', { status: 200, data: body, apiError: { code: 'health_check_failed', message: 'ヘルスチェックに応答しませんでした' } })
    expect(m).toBe('再起動に失敗しました（health_check_failed）: ヘルスチェックに応答しませんでした')
    expect(m).not.toContain('HTTP 200')
  })
})

describe('★★★ hanamiiFailureMessage: 主の文に添える理由は error.message だけ（伏せて1行・200字まで）', () => {
  const secret = 'hnm' + '_Ab12Cd34Ef56Gh78Ij90Kl12Mn34'
  it('HTML の本文（門番の 502 のページ）は主の文に添えない', () => {
    const html = '<html><head><title>502 Bad Gateway</title></head><body>gateway</body></html>'
    expect(hanamiiFailureMessage('公開', { status: 502, data: html })).toBe('公開に失敗しました（HTTP 502）')
  })
  it('文字列の本文は、秘密の形があっても主の文に出さない', () => {
    expect(hanamiiFailureMessage('公開', { status: 500, data: `token ${secret}` })).not.toContain(secret)
  })
  it('理由の中の秘密の形は伏せる', () => {
    const m = hanamiiFailureMessage('公開', { status: 403, data: { error: { code: 'forbidden', message: `トークン ${secret} は使えません` } }, apiError: { code: 'forbidden', message: `トークン ${secret} は使えません` } })
    expect(m).not.toContain(secret)
    expect(m).toBe('公開に失敗しました（HTTP 403）: トークン *** は使えません')
  })
  it('改行は詰めて 1 行、長い理由は 200 字で切る', () => {
    const msg = '1行目\n2行目\r\n   3行目' + 'あ'.repeat(300)
    const m = hanamiiFailureMessage('公開', { status: 400, data: null, apiError: { code: null, message: msg } })
    expect(m).not.toMatch(/[\r\n]/)
    expect(m.startsWith('公開に失敗しました（HTTP 400）: 1行目 2行目 3行目あ')).toBe(true)
    expect(m.endsWith('…')).toBe(true)
    expect(m.length).toBe('公開に失敗しました（HTTP 400）: '.length + 200 + 1)
  })
  it('理由が code と同じなら重ねない', () => {
    expect(hanamiiFailureMessage('再起動', { status: 200, data: { error: { code: 'health_check_failed' } }, apiError: { code: 'health_check_failed', message: 'health_check_failed' } }))
      .toBe('再起動に失敗しました（health_check_failed）')
    expect(hanamiiFailureMessage('再起動', { status: 200, data: { error: { code: 'health_check_failed' } }, apiError: { code: 'health_check_failed', message: null } }))
      .toBe('再起動に失敗しました（health_check_failed）')
  })
  it('JSON の本文（理由が取れない形）は「: {」を付けない', () => {
    expect(hanamiiFailureMessage('公開', { status: 500, data: { foo: 1 } })).toBe('公開に失敗しました（HTTP 500）')
    expect(hanamiiFailureMessage('公開', { status: 500, data: { error: {} } })).toBe('公開に失敗しました（HTTP 500）')
    expect(hanamiiFailureMessage('公開', { status: 500, data: { error: {} }, apiError: { code: null, message: null } })).toBe('公開に失敗しました（HTTP 500）')
  })
  it('client 越しでも同じ（{foo:1} の 500 と {error:{}} の 500 に「: {」が付かない）', async () => {
    for (const body of [{ foo: 1 }, { error: {} }]) {
      script = () => jsonRes(500, body)
      const r = await client().getProject('p')
      expect(hanamiiFailureMessage('状態の取得', r), JSON.stringify(body)).toBe('状態の取得に失敗しました（HTTP 500）')
    }
  })
})

describe('★★★ IPC: 公開・再起動の詳細（detail）は秘密の形を伏せる', () => {
  const secret = 'hnm' + '_Ab12Cd34Ef56Gh78Ij90Kl12Mn34'
  it('公開の失敗の detail に秘密の形が出ない', async () => {
    publishScript({ check: jsonRes(400, { error: { code: 'bad', message: `x ${secret}` } }) })
    const r = await publish(newProject())
    expect(r.detail).toContain('bad')
    expect(r.detail).not.toContain(secret)
    expect(r.message).not.toContain(secret)
  })
  it('再起動の失敗の detail に秘密の形が出ない', async () => {
    script = () => jsonRes(200, { error: { code: 'health_check_failed', message: `x ${secret}` } })
    const r = await restart()
    expect(r.detail).toContain('health_check_failed')
    expect(r.detail).not.toContain(secret)
  })
})

describe('★★★ readRestartReply: 成功は noop か READY のときだけ', () => {
  it('noop:true → noop', () => expect(readRestartReply({ project: {}, deployment: null, noop: true })).toBe('noop'))
  it('deployment.readyState が READY → ready', () => expect(readRestartReply({ project: { status: 'healthy' }, deployment: { id: 'd', readyState: 'READY', errorCode: null } })).toBe('ready'))
  it('それ以外の形は成功と言わない', () => {
    for (const d of [{}, null, '', { project: { id: 'p' } }, { deployment: { readyState: 'BUILDING' } }, { deployment: null }, { noop: 'true' }, { deployment: { readyState: 'ERROR' } }]) {
      expect(readRestartReply(d), JSON.stringify(d)).toBe('unconfirmed')
    }
  })
})

// ── IPC（main の振る舞い）──
function newProject(meta?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hnm-body-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  if (meta !== undefined) fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify(meta), 'utf-8')
  return dir
}
const metaOf = (dir: string): any => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8')) } catch { return {} } }
const publish = (dir: string, opts: Record<string, unknown> = {}) =>
  h.handlers.get('hanamii:publish')!({}, dir, { token: TOKEN, workspaceId: 'ws-1', name: 'myapp', ...opts })
const restart = (opts: Record<string, unknown> = {}) => h.handlers.get('hanamii:restart')!({}, 'proj-1', { token: TOKEN, ...opts })

function publishScript(over: { check?: ReturnType<typeof jsonRes>; create?: ReturnType<typeof jsonRes> } = {}) {
  script = (method, url) => {
    if (method === 'POST' && url === `${BASE}/api/v1/uploads`) return jsonRes(200, { upload: { uploadUrl: 'https://upload.example/zip', id: 'up-1' } })
    if (method === 'PUT') return jsonRes(200, {})
    if (method === 'POST' && url.endsWith('/check')) return over.check ?? jsonRes(200, { result: { canDeploy: true, checkId: 'chk-1' } })
    if (method === 'POST' && url === `${BASE}/api/v1/projects`) return over.create ?? jsonRes(200, { project: { id: 'proj-1' }, deployment: { id: 'dep-1' } })
    return jsonRes(404, { error: { code: 'not_found', message: `想定外: ${method} ${url}` } })
  }
}

describe('★★★ IPC: 公開の失敗の文', () => {
  it('検証が 200 の本文 error で失敗: 主の文に HTTP 200 を書かず code と HANAMII の理由、原文は detail', async () => {
    publishScript({ check: jsonRes(200, { error: { code: 'upload_expired', message: 'アップロードの期限が切れました' } }) })
    const r = await publish(newProject())
    expect(r.ok).toBe(false)
    expect(r.message).toBe('アップロードの検証に失敗しました（upload_expired）: アップロードの期限が切れました')
    expect(r.message).not.toContain('HTTP 200')
    expect(r.detail).toContain('upload_expired')
  })
  it('作成が 403 {error:{message}}: 主の文に理由が添わる（JSON なので添えない、にならない）', async () => {
    publishScript({ create: jsonRes(403, { error: { code: 'forbidden', message: 'このワークスペースでは作成できません' } }) })
    const r = await publish(newProject())
    expect(r.ok).toBe(false)
    expect(r.message).toBe('公開に失敗しました（HTTP 403）: このワークスペースでは作成できません')
  })
})

describe('★★★ IPC: 検証で断られた回（canDeploy:false）の HANAMII の文は、伏せて1件1行・200 字にし、原文は伏せた詳細に残す', () => {
  const TOK = 'hnm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'
  it('秘密の形は主の文にも詳細にも出ない・長い文は切る・詳細は常に付く', async () => {
    publishScript({ check: jsonRes(200, { result: { canDeploy: false, errorCount: 2, errors: [
      { message: `トークン ${TOK} は使えません\n次の行` },
      { message: 'x'.repeat(500) },
    ] } }) })
    const r = await publish(newProject())
    expect(r.ok).toBe(false)
    expect(r.message.startsWith('HANAMII が公開を受け付けませんでした:\n')).toBe(true)
    expect(r.message).not.toContain(TOK)
    const lines = r.message.split('\n').slice(1)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('トークン')
    expect(lines[0]).toContain('次の行')
    expect(lines[1].length).toBeLessThanOrEqual(200)
    expect(typeof r.detail).toBe('string')
    expect(r.detail.length).toBeGreaterThan(0)
    expect(r.detail).not.toContain(TOK)
  })
})

describe('★★★ IPC: 初回の作成で projectId が取り出せないときは失敗', () => {
  it('ok:false・記録に projectId=null も公開日時も書かない。名前を挙げて管理画面で確かめるよう言う（📡 へは案内しない）', async () => {
    publishScript({ create: jsonRes(200, { deployment: { id: 'dep-1' } }) })
    const dir = newProject()
    const r = await publish(dir)
    expect(r.ok).toBe(false)
    expect(r.message).toBe('HANAMII のプロジェクト『myapp』が作られたか確かめられませんでした。HANAMII の管理画面で『myapp』があるか確かめてください。')
    expect(r.message).not.toContain('📡')
    const hn = metaOf(dir).publish?.hanamii
    expect(hn?.projectId ?? null).toBeNull()
    expect(hn?.publishedAt).toBeUndefined()
    expect(hn === undefined || !('projectId' in hn) || hn.projectId == null).toBe(true)
  })
  it('作られたか分からないので、いま発行した保存場所の鍵は取り消さない（取り消しの一覧が空）', async () => {
    publishScript({ create: jsonRes(200, {}) })
    const r = await publish(newProject(), { withStorage: true })
    expect(r.ok).toBe(false)
    expect(h.revoked).toEqual([])
  })
  it('projectId が取れる通常の作成は成功し、鍵は取り消さない', async () => {
    publishScript()
    const dir = newProject()
    const r = await publish(dir, { withStorage: true })
    expect(r.ok).toBe(true)
    expect(h.revoked).toEqual([])
    expect(metaOf(dir).publish.hanamii.projectId).toBe('proj-1')
  })
})

describe('★★★ IPC: 再起動の結果の読み方', () => {
  const run = (body: unknown, status = 200) => { script = () => jsonRes(status, body); return restart() }
  it('noop → 成功（noop:true）', async () => {
    expect(await run({ project: {}, deployment: null, noop: true, message: '反映する変更はありません' })).toEqual({ ok: true, noop: true })
  })
  it('新しい版が READY → 成功（noop:false）', async () => {
    expect(await run({ project: {}, deployment: { id: 'd', readyState: 'READY', errorCode: null } })).toEqual({ ok: true, noop: false })
  })
  it('文書が言わない 2xx（空の本文・READY でない）は成功と言わない', async () => {
    for (const body of [{}, { project: { id: 'p' } }, { deployment: { readyState: 'BUILDING' } }]) {
      const r = await run(body)
      expect(r.unconfirmed, JSON.stringify(body)).toBe(true)
      expect(r.noop).toBe(false)
      expect(r.message).toContain('⚠️ 再起動の結果を確かめられませんでした。')
      expect(r.message).not.toContain('✅')
    }
  })
  it('200 の本文 error は失敗: 主の文に HTTP 200 を書かず code・理由、原文は detail', async () => {
    const r = await run({ error: { code: 'health_check_failed', message: 'ヘルスチェックに応答しませんでした' } })
    expect(r.ok).toBe(false)
    expect(r.message).toBe('再起動に失敗しました（health_check_failed）: ヘルスチェックに応答しませんでした')
    expect(r.detail).toContain('health_check_failed')
  })
})
