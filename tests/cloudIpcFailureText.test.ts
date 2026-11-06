import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { h, resetHarness, newProjectDir, setup, APP } from './sharedTeardownHarness'
import { splitFailureDetail } from '../src/shared/failureDetail'

// ── 共用型 AppRun の IPC の口が、回線が切れたときに「日本語の文＋詳細: 原文」を返すこと ──────────────────────
// 以前の口は `message: e?.message ?? String(e)` で、画面に英語の「fetch failed」だけが出た（ホスト名も日本語の文も無い）。
// ここは本物の main に「どの呼び出しも回線断で投げる」偽の client を流し、返る message で固定する（掟10）。

const net = vi.hoisted(() => ({
  make: () => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND secure.sakura.ad.jp'), { code: 'ENOTFOUND' }),
  }),
}))

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createStorageAdapter: async () => { throw net.make() },
}))
/** どのメソッドを呼んでも回線断で投げるクラス。 */
function alwaysDown() {
  return class {
    dryRun = false
    constructor(_opts?: unknown) {
      return new Proxy(this, {
        get: (t, p) => (p in t || typeof p !== 'string' || p === 'then') ? (t as any)[p] : async () => { throw net.make() },
      })
    }
  }
}
vi.mock('../src/main/cloud/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), SakuraCloudClient: alwaysDown() }))
vi.mock('../src/main/cloud/objectStorage', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ObjectStorageClient: alwaysDown() }))
vi.mock('../src/main/cloud/monitoring', async (orig) => ({ ...(await orig<Record<string, unknown>>()), MonitoringClient: alwaysDown() }))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const call = (name: string, ...args: unknown[]): Promise<any> => Promise.resolve(h.handlers.get(name)!({}, ...args))

let dir = ''
beforeEach(() => {
  resetProjectOpsForTests(); resetHarness()
  dir = newProjectDir()
  setup(dir, { env: [], resources: [APP] })
})
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(dir, { recursive: true, force: true }) })

const JAPANESE = /[぀-ヿ一-鿿]/
/** 日本語の文があり、詳細の行にホスト名（原因の連なり）が残り、英語の生の文だけで終わっていない。 */
function expectJapaneseWithDetail(message: unknown): void {
  expect(typeof message).toBe('string')
  const { text, detail } = splitFailureDetail(message as string)
  expect(text).not.toBe('fetch failed')
  expect(JAPANESE.test(text)).toBe(true)
  expect(detail).toContain('secure.sakura.ad.jp')
}

describe('cloud.ts の IPC: 読み取りの口は、回線断を日本語の文＋詳細にする', () => {
  it.each([
    ['cloud:cost', () => call('cloud:cost')],
    ['cloud:appUrl', () => call('cloud:appUrl', dir)],
    ['cloud:appHealth', () => call('cloud:appHealth', dir)],
    ['cloud:listVersions', () => call('cloud:listVersions', dir)],
    ['cloud:getTraffics', () => call('cloud:getTraffics', dir)],
    ['cloud:getAccessLimit', () => call('cloud:getAccessLimit', dir)],
    ['cloud:telemetryStatus', () => call('cloud:telemetryStatus', dir, 'logs')],
    ['storage:status', () => call('storage:status')],
  ])('%s', async (_name, run) => {
    const r = await run()
    expect(r.ok).toBe(false)
    expectJapaneseWithDetail(r.message)
    // 読み取りは「もう一度」と言ってよい（何も変えていない）
    expect(splitFailureDetail(r.message).text).toContain('インターネットに接続できませんでした')
  })

  it('cloud:myIp（外部の窓口への fetch）', async () => {
    vi.stubGlobal('fetch', async () => { throw net.make() })
    const r = await call('cloud:myIp')
    expect(r.ok).toBe(false)
    expectJapaneseWithDetail(r.message)
  })
})

describe('cloud.ts の IPC: 書き込みの口も、回線断を日本語の文＋詳細にする（名前が引けない失敗は「もう一度」と言える）', () => {
  it.each([
    ['cloud:ensureRegistry', () => call('cloud:ensureRegistry', dir)],
    ['cloud:rollback', () => call('cloud:rollback', dir, null, { confirmed: true })],
    ['cloud:setAccessLimit', () => call('cloud:setAccessLimit', dir, { isEnabled: false, ips: [] })],
    ['cloud:enableTelemetry', () => call('cloud:enableTelemetry', dir, 'logs', { consented: false })],
    ['storage:createBucket', () => call('storage:createBucket', 'koto-data-test')],
    ['storage:prepare', () => call('storage:prepare', dir, {})],
  ])('%s', async (_name, run) => {
    const r = await run()
    expect(r.ok).toBe(false)
    expectJapaneseWithDetail(r.message)
  })

  it('cloud:apply（公開）の外側の失敗', async () => {
    // image 型にして、組み立てを通らず、AppRun への反映（API の呼び出し）で回線断にする
    const file = `${dir}/.sakura-cloud/env.json`
    const spec = JSON.parse(fs.readFileSync(file, 'utf-8'))
    spec.service.source = { type: 'image', ref: 'example.invalid/app:latest' }
    fs.writeFileSync(file, JSON.stringify(spec), 'utf-8')
    setup(dir, { env: [], resources: [] })
    fs.writeFileSync(file, JSON.stringify(spec), 'utf-8')
    const r = await call('cloud:apply', dir, { confirmed: true })
    expect(r.ok).toBe(false)
    expectJapaneseWithDetail(r.message)
  })
})

describe('cloud.ts の IPC: 見分けられない失敗は、今までどおり原文のまま返る', () => {
  it('cloud:loadEnv: 壊れた env.json の構文エラーは英語の原文のまま', async () => {
    fs.writeFileSync(`${dir}/.sakura-cloud/env.json`, '{ broken', 'utf-8')
    const r = await call('cloud:loadEnv', dir)
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/JSON/)
    expect(splitFailureDetail(r.errors[0]).detail).toBe('')
  })
})

describe('cloud.ts の IPC: 手元のファイルの失敗は、日本語の文＋詳細にする', () => {
  it('cloud:loadEnv: env.json が読めない（EACCES）', async () => {
    const file = `${dir}/.sakura-cloud/env.json`
    fs.chmodSync(file, 0o000)
    try {
      const r = await call('cloud:loadEnv', dir)
      expect(r.ok).toBe(false)
      const { text, detail } = splitFailureDetail(r.errors[0])
      expect(JAPANESE.test(text)).toBe(true)
      expect(detail).toContain('EACCES')
    } finally {
      fs.chmodSync(file, 0o644)
    }
  })
})
