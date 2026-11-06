import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { A, APP, OK_AUTH, bucketRef, h, resetHarness, newProjectDir, setup, workspaceOf } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'
import { splitFailureDetail } from '../src/shared/failureDetail'

// ── 共用型の破棄（cloud:teardown・cloud:teardownRecord）で回線が切れたとき ──────────────────────────────
// 以前は「公開したものを削除できませんでした: fetch failed」のように、英語の原文が日本語の頭のあとに入り、
// 記録にも「予期しない失敗で止まりました: fetch failed」が残った。ここは本物の main に、削除が回線断で投げる偽の client を流す。

const net = vi.hoisted(() => ({
  reset: () => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  }),
  deleteApp: 'ok' as 'ok' | 'throw',
}))

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => {
  const mocked = (await import('./sharedTeardownHarness')).clientMock(await orig())
  const Base = mocked.SakuraCloudClient as any
  class Down extends Base {
    async deleteApp(id: string) {
      if (net.deleteApp === 'throw') throw net.reset()
      return super.deleteApp(id)
    }
  }
  return { ...mocked, SakuraCloudClient: Down }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const teardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const teardownRecord = h.handlers.get('cloud:teardownRecord')!
const EVENT = {}
const GO = { confirmed: true, deleteRegistry: false, registryName: null }

let dir = ''
beforeEach(() => { resetProjectOpsForTests(); resetHarness(); net.deleteApp = 'ok'; dir = newProjectDir() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const JAPANESE = /[぀-ヿ一-鿿]/

describe('cloud:teardown', () => {
  it('★ アプリの削除の途中で切れた: 前置きを残し、済んだかは確かめられていないと言い、詳細は最後の行', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)] })
    net.deleteApp = 'throw'
    const r = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(r.ok).toBe(false)
    expect(r.message.startsWith('公開したものを削除できませんでした: ')).toBe(true)
    const { text, detail } = splitFailureDetail(r.message)
    expect(JAPANESE.test(text)).toBe(true)
    expect(text).toContain('操作が済んだかは確かめられていません')
    expect(text).not.toContain('fetch failed')
    expect(detail).toContain('ECONNRESET')
    expect(r.message.endsWith(`詳細: ${detail}`)).toBe(true)
  })
})

describe('cloud:teardownRecord（親フォルダが読めない）', () => {
  it('EACCES: 日本語の文＋詳細（括弧の中に原文が残らない）', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], meta: { registryName: 'myreg' } as any })
    const ws = workspaceOf(dir)
    fs.chmodSync(ws, 0o311) // 開けるが一覧は読めない
    try {
      const r = await Promise.resolve(teardownRecord(EVENT, dir))
      expect(r.ok).toBe(false)
      const { text, detail } = splitFailureDetail(r.message)
      expect(text).toContain('確かめられませんでした')
      expect(text).not.toContain('EACCES')
      expect(detail).toContain('EACCES')
      expect(path.basename(ws)).toBeTruthy()
    } finally {
      fs.chmodSync(ws, 0o755)
    }
  })
})
