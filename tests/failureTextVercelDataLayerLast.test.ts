import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 公開が途中で切れて失敗した回に、koto-data を差し替えた1行も添える。
// このとき「詳細: 原文」は最後の行のままであること（後ろに足すと画面が詳細を分けて描けなくなる）を、
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
    // デプロイの作成で回線が切れる
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
  }) as any
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('公開の失敗に koto-data の1行を添えても、詳細は最後の行', () => {
  it('★ 日本語の文 → koto-data の1行 → 詳細（原文）の順', async () => {
    const r = await h.handlers.get('vercel:publish')!({ sender: { send() {} } }, dir, { token: 'tok-for-test-only', name: 'myapp' })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('操作が済んだかは確かめられていません')
    expect(text).toContain('koto-data.js')
    expect(text.indexOf('確かめられていません')).toBeLessThan(text.indexOf('koto-data.js'))
    expect(detail).toContain('ECONNRESET')
    expect(r.message.endsWith(`詳細: ${detail}`)).toBe(true)
  })
})
