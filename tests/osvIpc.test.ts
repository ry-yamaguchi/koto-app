import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
}))

const boom = vi.hoisted(() => ({ on: false }))
vi.mock('../src/main/cloud/osvClient', async (orig) => {
  const m = await orig<typeof import('../src/main/cloud/osvClient')>()
  return { ...m, runOsvCheck: (a: Parameters<typeof m.runOsvCheck>[0]) => { if (boom.on) throw new TypeError('fetch failed'); return m.runOsvCheck(a) } }
})

const reads = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/main/osvProjectRead', async (orig) => {
  const m = await orig<typeof import('../src/main/osvProjectRead')>()
  return { ...m, readOsvPlanFs: (d: string) => { reads.n++; return m.readOsvPlanFs(d) } }
})

import { osvPreviewFs, osvCheckFs, registerOsvHandlers } from '../src/main/ipc/osv'
import { readOsvPlanFs } from '../src/main/osvProjectRead'
import { failureText } from '../src/shared/failureText'
import { PUBLIC_REGISTRY_PREFIX as R } from '../src/shared/lockfileDeps'
import { OSV_EXAMPLE_COUNT, OSV_MAX_PACKAGES } from '../src/shared/osvLimits'

let base = ''
let proj = ''
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osv-ipc-')))
  proj = path.join(base, 'proj')
  fs.mkdirSync(proj)
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
  vi.unstubAllGlobals()
  boom.on = false
})

const pub = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version, resolved: `${R}${name}/-/${name}-${version}.tgz`, integrity: `sha512-X-${name}`, ...extra,
})
function writeProject(root: Record<string, unknown>, rest: Record<string, unknown>, pkg?: unknown) {
  fs.writeFileSync(path.join(proj, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': root, ...rest } }))
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify(pkg ?? { dependencies: root.dependencies ?? {} }))
}
function goodProject() {
  writeProject(
    { dependencies: { express: '4.17.1', lodash: '4.17.20', debug: '2.6.9' } },
    {
      'node_modules/express': pub('express', '4.17.1'),
      'node_modules/lodash': pub('lodash', '4.17.20'),
      'node_modules/debug': pub('debug', '2.6.9'),
    },
  )
}

function fakeFetch(reply?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (reply) return reply(String(url), init)
    const body = JSON.parse(String(init?.body ?? '{}')) as { queries?: unknown[] }
    return new Response(JSON.stringify({ results: (body.queries ?? []).map(() => ({})) }), { status: 200 })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('同意が無ければ、要求が0件でファイルも読まない', () => {
  it.each([false, undefined, 'true', 1, null])('consented が %s → not-consented・fetch 0 回', async (c) => {
    goodProject()
    const { f, calls } = fakeFetch()
    expect(await osvCheckFs(proj, c, f)).toEqual({ state: 'not-consented' })
    expect(calls.length).toBe(0)
  })
  it.each([false, undefined, 'true', 1, null])('consented が %s → 一覧を読む関数も呼ばない', async (c) => {
    goodProject()
    reads.n = 0
    const { f } = fakeFetch()
    await osvCheckFs(proj, c, f)
    expect(reads.n).toBe(0)
    await osvCheckFs(proj, true, f)
    expect(reads.n).toBe(1)
  })
  it('フォルダが実在しなくても not-consented（先に同意を見る）', async () => {
    const { f, calls } = fakeFetch()
    expect(await osvCheckFs('/no/such/dir', false, f)).toEqual({ state: 'not-consented' })
    expect(await osvCheckFs(5, undefined, f)).toEqual({ state: 'not-consented' })
    for (const c of ['true', 1]) {
      expect(await osvCheckFs('/no/such/dir', c, f)).toEqual({ state: 'not-consented' })
      expect(await osvCheckFs('relative', c, f)).toEqual({ state: 'not-consented' })
    }
    expect(calls.length).toBe(0)
  })
})

describe('通信しない口（osvPreviewFs）', () => {
  it('どの状態でも要求が0件・一覧そのものは返さない', () => {
    const g = fakeFetch()
    vi.stubGlobal('fetch', g.f)
    const r0 = osvPreviewFs(proj) // no-manifest
    expect(r0).toEqual({ state: 'no-manifest' })
    goodProject()
    const r = osvPreviewFs(proj)
    expect(r.state).toBe('ok')
    if (r.state === 'ok') {
      expect(r.sendCount).toBe(3)
      expect(r.total).toBe(3)
      expect(r.examples.length).toBe(OSV_EXAMPLE_COUNT)
      expect(r.skipped).toEqual({ dev: 0, notPublic: 0, badShape: 0 })
      expect(r.manifest).toBe('match')
      expect('deps' in r).toBe(false)
    }
    expect(osvPreviewFs('relative/dir')).toEqual({ state: 'bad-dir' })
    expect(osvPreviewFs(undefined)).toEqual({ state: 'bad-dir' })
    fs.rmSync(path.join(proj, 'package-lock.json'))
    expect(osvPreviewFs(proj)).toEqual({ state: 'no-lockfile' })
    expect(g.calls.length).toBe(0)
  })
  it('sendCount は OSV_MAX_PACKAGES で切れ、total は全件', () => {
    const n = OSV_MAX_PACKAGES + 1
    const rest: Record<string, unknown> = {}
    const deps: Record<string, string> = {}
    for (let i = 0; i < n; i++) { rest[`node_modules/p${i}`] = pub(`p${i}`, '1.0.0'); deps[`p${i}`] = '1.0.0' }
    writeProject({ dependencies: deps }, rest)
    const r = osvPreviewFs(proj)
    expect(r.state).toBe('ok')
    if (r.state === 'ok') {
      expect(r.sendCount).toBe(OSV_MAX_PACKAGES)
      expect(r.total).toBe(n)
    }
  })
  it('サーバーに送る一覧（deps）が答えに入らない', () => {
    goodProject()
    const j = JSON.stringify(osvPreviewFs(proj))
    expect(j).not.toContain('"deps"')
    expect(j).not.toContain('"name"')
  })
})

describe('画面から受けた一覧を送らない', () => {
  it('osv:check に4つめの引数で一覧を渡しても、要求の本文はディスクの一覧と同じ', async () => {
    goodProject()
    const g = fakeFetch()
    vi.stubGlobal('fetch', g.f)
    handlers.clear()
    registerOsvHandlers()
    const h = handlers.get('osv:check')!
    const reply = await h({}, proj, true, [{ name: 'evil-internal', version: '1.0.0' }]) as { state: string }
    expect(reply.state).toBe('done')
    expect(g.calls.length).toBeGreaterThan(0)
    const bodies = g.calls.map((c) => String(c.init?.body ?? ''))
    for (const b of bodies) expect(b).not.toContain('evil-internal')
    const plan = readOsvPlanFs(proj)
    expect(plan.state).toBe('ok')
    if (plan.state !== 'ok') return
    const sent = JSON.parse(bodies[0]) as { queries: { package: { name: string; ecosystem: string }; version: string }[] }
    expect(sent.queries.map((q) => `${q.package.name} ${q.version}`)).toEqual(plan.deps.map((d) => `${d.name} ${d.version}`))
  })
})

describe('osvCheckFs', () => {
  it('bad-dir: 相対パス・空・数 → 要求 0 件', async () => {
    const { f, calls } = fakeFetch()
    for (const d of ['rel/dir', '', 42, null]) expect(await osvCheckFs(d, true, f)).toEqual({ state: 'bad-dir' })
    expect(calls.length).toBe(0)
  })
  it('ok 以外の state はそのまま返し、要求 0 件', async () => {
    const { f, calls } = fakeFetch()
    expect(await osvCheckFs(proj, true, f)).toEqual({ state: 'no-manifest' })
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0' } }))
    expect(await osvCheckFs(proj, true, f)).toEqual({ state: 'no-lockfile' })
    expect(calls.length).toBe(0)
  })
  it('送る一覧が 0 件（全部が開発用）→ nothing-to-send・要求 0 件', async () => {
    writeProject(
      { dependencies: { 'internal-x': '1.0.0' } },
      { 'node_modules/internal-x': { version: '1.0.0', resolved: 'https://npm.corp.example/internal-x/-/x.tgz' } },
    )
    const { f, calls } = fakeFetch()
    const r = await osvCheckFs(proj, true, f)
    expect(r).toMatchObject({ state: 'nothing-to-send', manifest: 'match' })
    expect(calls.length).toBe(0)
  })
  it('通った回: done・checked が件数と同じ・skipped と manifest が plan のもの', async () => {
    goodProject()
    const { f, calls } = fakeFetch()
    const r = await osvCheckFs(proj, true, f)
    expect(r.state).toBe('done')
    if (r.state !== 'done') return
    expect(r.result.checked).toBe(3)
    expect(r.result.total).toBe(3)
    expect(r.skipped).toEqual({ dev: 0, notPublic: 0, badShape: 0 })
    expect(r.manifest).toBe('match')
    expect(calls.length).toBeGreaterThan(0)
  })
  it('開発用・公開以外を含む形で done: skipped と manifest が plan のもの', async () => {
    writeProject(
      { dependencies: { express: '4.17.1', 'internal-x': '1.0.0' }, devDependencies: { vitest: '1.0.0' } },
      {
        'node_modules/express': pub('express', '4.17.1'),
        'node_modules/vitest': pub('vitest', '1.0.0', { dev: true }),
        'node_modules/internal-x': { version: '1.0.0', resolved: 'https://npm.corp.example/internal-x/-/x.tgz' },
      },
      { dependencies: { express: '^4.0.0', 'internal-x': '1.0.0' } },
    )
    const plan = readOsvPlanFs(proj)
    expect(plan.state).toBe('ok')
    if (plan.state !== 'ok') return
    expect(plan.skipped.dev).toBe(1)
    expect(plan.skipped.notPublic).toBe(1)
    expect(plan.manifest).toBe('mismatch')
    const { f } = fakeFetch()
    const r = await osvCheckFs(proj, true, f)
    expect(r.state).toBe('done')
    if (r.state !== 'done') return
    expect(r.skipped).toEqual(plan.skipped)
    expect(r.manifest).toBe(plan.manifest)
  })
  it('想定外の例外 → failed・message は failureText と同じ', async () => {
    goodProject()
    boom.on = true
    const { f } = fakeFetch()
    const r = await osvCheckFs(proj, true, f)
    expect(r).toEqual({ state: 'failed', message: failureText(new TypeError('fetch failed'), { readOnly: true }) })
    expect(r.state === 'failed' && r.message).toContain('詳細: fetch failed')
    expect(r.state === 'failed' && r.message).toContain('インターネット')
  })
  it('回線断（TypeError）→ done で stop.reason が offline・例外を投げない', async () => {
    goodProject()
    const f = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const r = await osvCheckFs(proj, true, f)
    expect(r.state).toBe('done')
    if (r.state === 'done') expect(r.result.stop?.reason).toBe('offline')
  })
})

describe('登録', () => {
  it("registerOsvHandlers は 'osv:preview' と 'osv:check' のちょうど2つを登録する", () => {
    handlers.clear()
    registerOsvHandlers()
    expect([...handlers.keys()].sort()).toEqual(['osv:check', 'osv:preview'])
  })
})
