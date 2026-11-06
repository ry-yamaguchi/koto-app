import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 保存場所の鍵を用意できずに公開を止めた回の文でも、「詳細: 原文」は最後の行のまま（案内や koto-data の行を後ろに足さない）。
// 本物の公開ハンドラで確かめる。

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))
vi.mock('../src/main/cloud/storageForTarget', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    issueStorageEnvFor: async () => ({
      ok: false, reason: 'error',
      message: '保存場所のアクセスキーを用意できませんでした: インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。\n詳細: getaddrinfo ENOTFOUND secure.sakura.ad.jp',
    }),
  }
})
vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => null }
})

import { registerVercelHandlers } from '../src/main/ipc/vercel'
registerVercelHandlers({} as any)

const TEMPLATE_ESM = fs.readFileSync(path.join(process.cwd(), 'templates', 'koto-data.js'), 'utf-8')
const realFetch = globalThis.fetch
let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-vercel-last-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>hi</p>')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myapp', type: 'module' }))
  fs.writeFileSync(path.join(dir, 'app.js'), "import { list } from './koto-data.js'\nexport const run = () => list('x')\n")
  fs.writeFileSync(path.join(dir, 'koto-data.js'), TEMPLATE_ESM.replace(/^\/\/ koto-data-template: .*$/m, '// koto-data-template: 2026-01-01.0'))
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes('/v2/files')) return { ok: true, status: 200, text: async () => '' } as any
    throw new Error('呼ばれない')
  }) as any
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('保存場所の鍵を用意できず公開を止めた回: 詳細は最後の行', () => {
  it('★ 中止の案内と koto-data の1行は詳細の前に入る', async () => {
    const r = await h.handlers.get('vercel:publish')!({ sender: { send() {} } }, dir, { token: 'tok-for-test-only', name: 'myapp' })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('公開を中止しました')
    expect(text).toContain('koto-data.js')
    expect(detail).toBe('getaddrinfo ENOTFOUND secure.sakura.ad.jp')
    expect(r.message.endsWith(`詳細: ${detail}`)).toBe(true)
    expect(r.message.split('詳細: ').length).toBe(2)
  })
})
