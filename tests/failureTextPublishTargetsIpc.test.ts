import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { splitFailureDetail } from '../src/shared/failureDetail'

// Vercel・HANAMII・GitHub の IPC。回線が切れたとき、画面へ返る message が日本語の文＋最後の行の「詳細: 原文」で、
// ホスト名が詳細に残ること（英語の 'fetch failed' だけが出ない）を、本物のハンドラで確かめる。
// 読み取り（一覧・状態・ログ）と書き込み（公開・再起動・保存）で文が分かれることも見る。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => require('node:os').tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: class {},
  shell: { openExternal: async () => {} },
  dialog: {},
}))
vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => null }
})

import { registerVercelHandlers } from '../src/main/ipc/vercel'
import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { registerGithubHandlers } from '../src/main/ipc/github'

registerVercelHandlers({} as any)
registerHanamiiHandlers({} as any)
registerGithubHandlers({} as any)

const offlineTo = (host: string): Error => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }),
})
const resetTo = (): Error => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
})
const failFetch = (e: unknown) => { globalThis.fetch = (async () => { throw e }) as unknown as typeof fetch }

const call = (ch: string, ...a: any[]) => h.handlers.get(ch)!({ sender: { send() {} } }, ...a)
const realFetch = globalThis.fetch
let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-pub-'))
  fs.mkdirSync(path.join(dir, 'public'))
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<p>hi</p>')
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
})

const expectOffline = (message: string, host: string) => {
  const { text, detail } = splitFailureDetail(message)
  expect(text).not.toMatch(/fetch failed/)
  expect(text).toMatch(/インターネットに接続できませんでした|確かめられていません/)
  expect(detail).toContain(host)
  expect(message.endsWith(detail)).toBe(true)
}

describe('Vercel', () => {
  it('★ vercel:publish（書き込み）: 回線断は日本語の文＋詳細にホスト名。確かめる場所は公開一覧', async () => {
    failFetch(resetTo())
    const r = await call('vercel:publish', dir, { token: 'tok-for-test-only', name: 'demo' })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('操作が済んだかは確かめられていません')
    expect(text).toContain('📡 公開したもの一覧')
    expect(detail).toContain('ECONNRESET')
  })

  it('★ vercel:publish: 名前が引けない（送っていない）失敗はホスト名つき', async () => {
    failFetch(offlineTo('api.vercel.com'))
    const r = await call('vercel:publish', dir, { token: 'tok-for-test-only', name: 'demo' })
    expectOffline(r.message, 'api.vercel.com')
  })
})

describe('HANAMII', () => {
  it('★ hanamii:publish（書き込み）: 回線断は日本語の文＋詳細', async () => {
    failFetch(resetTo())
    const r = await call('hanamii:publish', dir, { token: 'tok-for-test-only', workspaceId: 'w1', name: 'demo' })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('確かめられていません')
    expect(detail).toContain('ECONNRESET')
  })

  it('★ hanamii:restart（書き込み）: 回線断は日本語の文＋詳細', async () => {
    failFetch(offlineTo('api.hanamii.jp'))
    const r = await call('hanamii:restart', 'p1', { token: 'tok-for-test-only' })
    expect(r.ok).toBe(false)
    expectOffline(r.message, 'api.hanamii.jp')
  })

  it('★ 読み取り（ワークスペース・状態・ログ）は例外を投げず、読み取りの文で返す', async () => {
    failFetch(offlineTo('api.hanamii.jp'))
    for (const r of [
      await call('hanamii:listWorkspaces', 'tok-for-test-only'),
      await call('hanamii:status', 'p1', 'tok-for-test-only'),
      await call('hanamii:logs', 'tok-for-test-only', 'p1'),
    ]) {
      expect(r.ok).toBe(false)
      const { text, detail } = splitFailureDetail(r.message)
      expect(text).toBe('インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。')
      expect(detail).toContain('api.hanamii.jp')
    }
  })
})

describe('HANAMII の読み取りは、途中で切れても「済んだかは分からない」とは言わない', () => {
  it('★ 読み取り（一覧・状態・ログ）: 途中で切れた失敗は、時間内に返事がなかった文（書き込みの文ではない）', async () => {
    failFetch(resetTo())
    for (const r of [
      await call('hanamii:listWorkspaces', 'tok-for-test-only'),
      await call('hanamii:status', 'p1', 'tok-for-test-only'),
      await call('hanamii:logs', 'tok-for-test-only', 'p1'),
    ]) {
      expect(splitFailureDetail(r.message).text).toContain('時間内に返事がありませんでした')
      expect(splitFailureDetail(r.message).text).not.toContain('確かめられていません')
    }
  })
})

describe('GitHub', () => {
  it('★ github:createRepo（書き込み）: 名前が引けない失敗は日本語の文＋詳細', async () => {
    failFetch(offlineTo('api.github.com'))
    const r = await call('github:createRepo', 'tok-for-test-only', 'my-repo')
    expect(r.ok).toBe(false)
    expectOffline(r.message, 'api.github.com')
  })

  it('★ github:save（途中で切れた）: 済んだかは確かめられていません＋確かめる場所＋詳細', async () => {
    failFetch(resetTo())
    const r = await call('github:save', dir, 'tok-for-test-only', 'me/repo')
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('確かめられていません')
    expect(text).toContain('GitHub のリポジトリ')
    expect(detail).toContain('ECONNRESET')
  })

  it('★ github:save: 手元のファイルが読めない失敗は日本語の文（原文を英語のまま出さない）', async () => {
    const file = path.join(dir, 'public', 'index.html')
    fs.chmodSync(file, 0o000)
    try {
      if (fs.existsSync('/proc') || process.getuid?.() === 0) return // 権限を無視する環境では確かめられない
      const r = await call('github:save', dir, 'tok-for-test-only', 'me/repo')
      expect(r.ok).toBe(false)
      expect(splitFailureDetail(r.message).text).not.toMatch(/^EACCES/)
      expect(splitFailureDetail(r.message).detail).toContain('EACCES')
    } finally { fs.chmodSync(file, 0o644) }
  })
})
