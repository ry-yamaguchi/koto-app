import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── HANAMII の再公開（更新）が失敗しても、動いている版の URL を記録から失わない（2026-11-11 実機 R4）────────────────
// 以前は、依頼が受け付けられた時点で `{ publishedAt, url: null }` を書いていた。再公開で新しい版が起動しなかったとき
// HANAMII は前の版を動かし続けるのに、記録の url が null のまま残り、📡 と【公開】が動いているサイトの URL を失った。
// ここは hanamii:publish を実際に呼び、偽の HANAMII（fetch）の応答の違い（新しい版が READY / ERROR / 時間切れ）で、
// 公開記録（.sakuraide.json の publish.targets.hanamii）がどうなるかを読んで固定する。実ネットワークへは出ない。
// あわせて、ヘルスチェックを有効にした公開が deploy_error で失敗したときの文（一文が足される／足されない）。

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
import { hanamiiWaitTuning } from '../src/main/hanamii/aftercare'
import { HEALTH_CHECK_ALSO_SENTENCE } from '../src/shared/hanamiiErrorCode'

registerHanamiiHandlers({} as any)

const TOKEN = 'tok-test'
const BASE = 'https://hanamii.jp'
const UPLOAD_URL = 'https://upload.example/zip'
const OLD_URL = 'https://old-version.example.jp'
const NEW_URL = 'https://new-version.example.jp'
const OLD_AT = '2026-11-01T00:00:00.000Z'

/** 偽の HANAMII が、今回の deployment について返す状態。 */
type Mode = { kind: 'ready' } | { kind: 'ready-no-url' } | { kind: 'error'; errorCode: string | null } | { kind: 'pending' } | { kind: 'redeploy-400' } | { kind: 'create-timeout' } | { kind: 'create-400' }
/** 偽の HANAMII が最後に発行した deployment の id（状態の応答の latestDeployment.id になる）。 */
const lastDeployment = { id: '' }
let mode: Mode = { kind: 'ready' }
let dirs: string[] = []
let realFetch: typeof globalThis.fetch

const jsonRes = (status: number, data: unknown) => ({ ok: status < 300, status, async text() { return JSON.stringify(data) } })

function newProject(meta?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-hnm-url-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  if (meta !== undefined) fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify(meta, null, 2), 'utf-8')
  return dir
}
const readMeta = (dir: string): any => JSON.parse(fs.readFileSync(path.join(dir, '.sakuraide.json'), 'utf-8'))
const publish = (dir: string, opts: Record<string, unknown> = {}) =>
  h.handlers.get('hanamii:publish')!({}, dir, { token: TOKEN, workspaceId: 'ws-1', name: 'myapp', ...opts })
/** 公開済み（URL が分かっている）プロジェクトの記録。 */
const publishedMeta = (url: string | null = OLD_URL) => ({
  publish: { hanamii: { projectId: 'proj-1' }, targets: { hanamii: { publishedAt: '2026-11-01T00:00:00.000Z', url } } },
})

beforeEach(() => {
  dirs = []
  lastDeployment.id = ''
  mode = { kind: 'ready' }
  hanamiiWaitTuning.intervalMs = 0
  hanamiiWaitTuning.maxPolls = 3
  hanamiiWaitTuning.sleep = async () => {}
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init: any) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'POST' && url === `${BASE}/api/v1/uploads`) return jsonRes(200, { upload: { uploadUrl: UPLOAD_URL, id: 'up-1' } })
    if (method === 'PUT' && url === UPLOAD_URL) return jsonRes(200, {})
    if (method === 'POST' && url === `${BASE}/api/v1/uploads/up-1/check`) return jsonRes(200, { result: { canDeploy: true, checkId: 'chk-1' } })
    if (method === 'PUT' && /\/health-check$/.test(url)) return jsonRes(200, {})
    if (method === 'POST' && url === `${BASE}/api/v1/projects`) {
      if (mode.kind === 'create-timeout') throw new Error('The operation was aborted due to timeout')
      if (mode.kind === 'create-400') return jsonRes(400, { error: { message: 'bad' } })
      lastDeployment.id = 'dep-1'
      return jsonRes(200, { project: { id: 'proj-1' }, deployment: { id: 'dep-1' } })
    }
    if (method === 'POST' && /\/api\/v1\/projects\/[^/]+\/deploy$/.test(url)) {
      if (mode.kind === 'redeploy-400') return jsonRes(400, { error: { message: 'bad' } })
      lastDeployment.id = 'dep-2'
      return jsonRes(200, { deployment: { id: 'dep-2' } })
    }
    if (method === 'GET' && /\/api\/v1\/projects\/[^/]+$/.test(url)) {
      // 状態の応答の latestDeployment.id は、偽の HANAMII が最後に発行した deployment（初回 dep-1・更新 dep-2）
      const id = lastDeployment.id
      if (mode.kind === 'ready') return jsonRes(200, { project: { id: 'proj-1', url: NEW_URL, latestDeployment: { id, readyState: 'READY' } } })
      if (mode.kind === 'ready-no-url') return jsonRes(200, { project: { id: 'proj-1', latestDeployment: { id, readyState: 'READY' } } })
      if (mode.kind === 'error') return jsonRes(200, { project: { id: 'proj-1', url: OLD_URL, latestDeployment: { id, readyState: 'ERROR', ...(mode.errorCode ? { errorCode: mode.errorCode } : {}) } } })
      return jsonRes(200, { project: { id: 'proj-1', url: OLD_URL, latestDeployment: { id, readyState: 'BUILDING' } } })
    }
    return jsonRes(404, { error: { message: `想定外の要求: ${method} ${url}` } })
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  hanamiiWaitTuning.intervalMs = 3000
  hanamiiWaitTuning.maxPolls = 100
  hanamiiWaitTuning.sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

describe('★★★ 再公開（更新）が失敗しても、記録の URL は動いている版のまま', () => {
  it.each([
    ['新しい版が ERROR（deploy_error）', { kind: 'error', errorCode: 'deploy_error' } as Mode],
    ['新しい版が時間切れ（BUILDING のまま）', { kind: 'pending' } as Mode],
  ])('%s: URL も公開日時も前のまま。projectId は残る', async (_n, m) => {
    mode = m
    const dir = newProject(publishedMeta())
    const r = await publish(dir)
    expect(r.ok).toBe(true)
    expect(r.deployState).not.toBe('ready')
    const rec = readMeta(dir).publish.targets.hanamii
    expect(rec.url, '動いている版の URL を失った').toBe(OLD_URL)
    expect(rec.publishedAt, '公開されていない版の時刻に進んだ（「変更あり」の基準がずれる）').toBe(OLD_AT)
    expect(readMeta(dir).publish.hanamii.projectId).toBe('proj-1')
  })

  it('★★★ 失敗の状態は消えない（deployState:error と、原因の文が結果に載る）', async () => {
    mode = { kind: 'error', errorCode: 'deploy_error' }
    const dir = newProject(publishedMeta())
    const r = await publish(dir)
    expect(r.deployState).toBe('error')
    expect(r.message).toContain('エラーコード: deploy_error')
    expect(r.message).toContain('前のバージョンが動き続けている場合があります')
  })

  it('★★★ 依頼の段で断られた再公開（redeploy が 400）は、記録を書き換えない', async () => {
    mode = { kind: 'redeploy-400' }
    const dir = newProject(publishedMeta())
    const before = JSON.stringify(readMeta(dir).publish.targets)
    const r = await publish(dir)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(readMeta(dir).publish.targets)).toBe(before)
  })

  it('★★★ 成功した再公開は、新しい URL に更新する', async () => {
    mode = { kind: 'ready' }
    const dir = newProject(publishedMeta())
    const r = await publish(dir)
    expect(r.deployState).toBe('ready')
    expect(readMeta(dir).publish.targets.hanamii.url).toBe(NEW_URL)
  })

  it('★★★ 成功した再公開は、公開日時も新しくなる（ファイルをまとめた時刻。確かめた時刻より後にはならない）', async () => {
    mode = { kind: 'ready' }
    const dir = newProject(publishedMeta())
    const t0 = Date.now()
    await publish(dir)
    const at = Date.parse(readMeta(dir).publish.targets.hanamii.publishedAt)
    expect(at, '公開日時が前の版のまま').toBeGreaterThanOrEqual(t0)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('★★★ 失敗した再公開のあとに成功した再公開: 成功した回で初めて URL と公開日時が進む', async () => {
    const dir = newProject(publishedMeta())
    mode = { kind: 'error', errorCode: 'deploy_error' }
    await publish(dir)
    expect(readMeta(dir).publish.targets.hanamii).toEqual({ publishedAt: OLD_AT, url: OLD_URL })
    mode = { kind: 'ready' }
    await publish(dir)
    const rec = readMeta(dir).publish.targets.hanamii
    expect(rec.url).toBe(NEW_URL)
    expect(rec.publishedAt).not.toBe(OLD_AT)
  })

  it('★★ 成功したが応答に URL が無い再公開は、前の URL を残す（null にしない）', async () => {
    mode = { kind: 'ready-no-url' }
    const dir = newProject(publishedMeta())
    const r = await publish(dir)
    expect(r.deployState).toBe('ready')
    expect(readMeta(dir).publish.targets.hanamii.url).toBe(OLD_URL)
    expect(readMeta(dir).publish.targets.hanamii.publishedAt, '動いたと確かめたので日時は進む').not.toBe(OLD_AT)
  })

  it('★★ 前の URL が記録に無い再公開（初回が動く前に止まった等）は null のまま', async () => {
    mode = { kind: 'error', errorCode: 'deploy_error' }
    const dir = newProject(publishedMeta(null))
    await publish(dir)
    expect(readMeta(dir).publish.targets.hanamii.url).toBeNull()
  })

  it('★★ 前の公開日時が記録に無い再公開が失敗: 日時は null のまま（作り物の日時を入れない）', async () => {
    mode = { kind: 'error', errorCode: 'deploy_error' }
    const dir = newProject({ publish: { hanamii: { projectId: 'proj-1' } } })
    await publish(dir)
    expect(readMeta(dir).publish.targets.hanamii).toEqual({ publishedAt: null, url: null })
  })
})

describe('★★★ 初回の公開は従来どおり', () => {
  it('初回の公開が受け付けられて、新しい版が ERROR: url は null（前の URL は無い）。projectId は記録される', async () => {
    mode = { kind: 'error', errorCode: 'build_error' }
    const dir = newProject()
    const r = await publish(dir)
    expect(r.ok).toBe(true)
    expect(r.deployState).toBe('error')
    expect(readMeta(dir).publish.targets.hanamii.url).toBeNull()
    expect(typeof readMeta(dir).publish.targets.hanamii.publishedAt, '初回は依頼を受け付けた時刻を書く').toBe('string')
    expect(readMeta(dir).publish.hanamii.projectId).toBe('proj-1')
  })

  it('初回の公開が READY: url が書かれ、公開日時は依頼を受け付けた時刻のまま', async () => {
    mode = { kind: 'ready' }
    const dir = newProject()
    const t0 = Date.now()
    await publish(dir)
    expect(readMeta(dir).publish.targets.hanamii.url).toBe(NEW_URL)
    expect(Date.parse(readMeta(dir).publish.targets.hanamii.publishedAt)).toBeGreaterThanOrEqual(t0)
  })

  it('初回: 他の記録（別の公開先の URL）が混ざらない', async () => {
    mode = { kind: 'error', errorCode: 'build_error' }
    const dir = newProject({ publish: { targets: { vercel: { publishedAt: '2026-10-01T00:00:00.000Z', url: 'https://v.example' } } } })
    await publish(dir)
    expect(readMeta(dir).publish.targets.hanamii.url).toBeNull()
    expect(readMeta(dir).publish.targets.vercel.url).toBe('https://v.example')
  })

  it('★★★ 初回（記録に projectId が無い）で、古い URL だけが記録に残っていても引き継がない（新しく作るプロジェクトの URL ではない）', async () => {
    mode = { kind: 'error', errorCode: 'build_error' }
    const dir = newProject({ publish: { targets: { hanamii: { publishedAt: '2026-10-01T00:00:00.000Z', url: OLD_URL } } } })
    const r = await publish(dir)
    expect(r.ok).toBe(true)
    expect(readMeta(dir).publish.targets.hanamii.url).toBeNull()
  })

  it('★★★ 「作られたか分からない」（作成が時間切れ）: 記録は書かない（従来どおり）', async () => {
    mode = { kind: 'create-timeout' }
    const dir = newProject()
    const r = await publish(dir)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('作られたか確かめられませんでした')
    expect(fs.existsSync(path.join(dir, '.sakuraide.json')) ? readMeta(dir).publish?.targets?.hanamii : undefined).toBeUndefined()
  })

  it('初回の作成が 4xx で断られた: 記録に行を作らない', async () => {
    mode = { kind: 'create-400' }
    const dir = newProject()
    const r = await publish(dir)
    expect(r.ok).toBe(false)
    expect(fs.existsSync(path.join(dir, '.sakuraide.json')) ? readMeta(dir).publish?.targets?.hanamii : undefined).toBeUndefined()
  })
})

describe('★★★ deploy_error の文: ヘルスチェックを有効にした公開だけ、一文が足される', () => {
  const failWith = async (healthCheck: unknown) => {
    mode = { kind: 'error', errorCode: 'deploy_error' }
    const dir = newProject(publishedMeta())
    return publish(dir, healthCheck === undefined ? {} : { healthCheck })
  }
  it('有効: 一文が足される', async () => {
    const r = await failWith({ enabled: true, path: '/health', port: null })
    expect(r.message).toContain(HEALTH_CHECK_ALSO_SENTENCE)
  })
  it('無効・送っていない: 足されない', async () => {
    expect((await failWith({ enabled: false, path: '/', port: null })).message).not.toContain(HEALTH_CHECK_ALSO_SENTENCE)
    expect((await failWith(undefined)).message).not.toContain(HEALTH_CHECK_ALSO_SENTENCE)
  })
  it('有効でも deploy_error 以外（build_error・health_error）には足さない', async () => {
    for (const code of ['build_error', 'health_error', 'check_error']) {
      mode = { kind: 'error', errorCode: code }
      const dir = newProject(publishedMeta())
      const r = await publish(dir, { healthCheck: { enabled: true, path: '/health', port: null } })
      expect(r.message, code).not.toContain(HEALTH_CHECK_ALSO_SENTENCE)
    }
  })
})

describe('★★ 【公開】の状態欄（renderer）も、同じ表に自分の知っているヘルスチェックの設定を渡す', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/HanamiiPanel.tsx'), 'utf-8')
  it('describeErrorCode の呼び出しは1か所で、記録の設定（recordedHcEnabled）を渡す。main 側の呼び出しも1か所で、送った設定を渡す', () => {
    expect(panel.split('describeErrorCode(').length - 1).toBe(1)
    expect(panel).toContain('describeErrorCode(status.errorCode, { healthCheckEnabled: recordedHcEnabled })')
    const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/ipc/hanamii.ts'), 'utf-8')
    expect(main.split('describeErrorCode(').length - 1).toBe(1)
    expect(main).toContain('describeErrorCode(code, { healthCheckEnabled })')
  })
})
