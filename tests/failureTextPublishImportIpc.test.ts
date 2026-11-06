import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { splitFailureDetail } from '../src/shared/failureDetail'

// 公開先からのインポート（import:*）。回線が切れたとき、画面に届く message が
// 日本語の文＋最後の行の「詳細: 原文」になること、crane のパスワードが引数にも文にも出ないことを、
// 本物のハンドラを呼んで確かめる（ソースの文字列は読まない）。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  execCalls: [] as Array<{ file: string; args: string[]; stdin: string }>,
  execFail: null as null | ((file: string, args: string[]) => any),
  snapshotResult: null as null | { ok: boolean; message?: string; snapshotId?: string },
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => ({ token: 'tok', secret: 'sec' }) }
})
vi.mock('../src/main/cloud/registry-auth', () => ({
  loadRegistryCredentials: () => ({ user: 'reguser', password: 'REGPASS-DO-NOT-LEAK' }),
}))
vi.mock('../src/main/backup/store', () => ({ snapshotCurrentFiles: () => h.snapshotResult }))
vi.mock('../src/main/cloud/imageBuild', () => ({ cranePath: () => process.execPath }))
vi.mock('child_process', async () => {
  const execFile: any = () => { throw new Error('callback 形は使わない') }
  execFile[promisify.custom] = (file: string, args: string[]) => {
    const call = { file, args, stdin: '' }
    h.execCalls.push(call)
    const p: any = (async () => {
      const failure = h.execFail?.(file, args)
      if (failure) throw failure
      return { stdout: '', stderr: '' }
    })()
    p.child = { stdin: { end: (s: string) => { call.stdin = String(s) } } }
    return p
  }
  return { execFile, spawn: () => { throw new Error('使わない') } }
})

import { registerPublishImportHandlers } from '../src/main/ipc/publishImport'
registerPublishImportHandlers({} as any)

const HOST = 'api.vercel.com'
const offline = (): Error => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${HOST}`), { code: 'ENOTFOUND' }),
})

const realFetch = globalThis.fetch
let tmp = ''
beforeEach(() => {
  h.execCalls = []; h.execFail = null
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-import-'))
})
afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(tmp, { recursive: true, force: true })
})

const call = (ch: string, ...a: any[]) => h.handlers.get(ch)!({ sender: { send() {} } }, ...a)
const failFetch = (e: unknown) => { globalThis.fetch = (async () => { throw e }) as unknown as typeof fetch }

describe('import:list / import:inspect / import:run の回線断', () => {
  it('★ import:list（読み取り）: 日本語の文＋詳細にホスト名が残る', async () => {
    failFetch(offline())
    const r = await call('import:list', { target: 'vercel', token: 't' })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('インターネットに接続できませんでした')
    expect(text).not.toMatch(/fetch failed/)
    expect(detail).toContain(HOST)
  })

  it('★ import:inspect（読み取り）: 日本語の文＋詳細にホスト名が残る', async () => {
    failFetch(offline())
    const r = await call('import:inspect', { target: 'vercel', id: 'dpl_1', token: 't' })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('インターネットに接続できませんでした')
    expect(detail).toContain(HOST)
  })

  it('★ import:inspect（AppRun）: さくらのクラウドへの回線断も日本語の文＋詳細', async () => {
    failFetch(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND secure.sakura.ad.jp'), { code: 'ENOTFOUND' }),
    }))
    const r = await call('import:inspect', { target: 'sakura-apprun', id: 'app1' })
    expect(splitFailureDetail(r.message).text).toContain('インターネットに接続できませんでした')
    expect(splitFailureDetail(r.message).detail).toContain('secure.sakura.ad.jp')
  })

  it('★ import:run（書き込み）: 取り出しの途中で切れたら「済んだかは確かめられていません」', async () => {
    failFetch(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(`read ECONNRESET`), { code: 'ECONNRESET' }),
    }))
    const dest = path.join(tmp, 'new-project')
    const r = await call('import:run', { target: 'vercel', id: 'dpl_1', destDir: dest, token: 't' })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('確かめられていません')
    expect(text).toContain('インポート先のフォルダ')
    expect(detail).toContain('ECONNRESET')
  })

  it('見分けられない失敗（日本語の検証文）はそのまま返る', async () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x')
    const r = await call('import:run', { target: 'vercel', id: 'x', destDir: tmp })
    expect(r.message).toBe('その場所には既にファイルがあります。空のフォルダを選んでください。')
  })

  it('★ 履歴の起点が作れなかった注記: 日本語の文で、詳細（ENOSPC の原文）は最後の行', async () => {
    h.snapshotResult = { ok: false, message: "ENOSPC: no space left on device, copyfile '/a/x' -> '/b/x'" }
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/files/')) return new Response(JSON.stringify({ data: Buffer.from('hi').toString('base64') }), { status: 200 })
      return new Response(JSON.stringify([{ name: 'index.html', type: 'file', uid: 'u1' }]), { status: 200 })
    }) as unknown as typeof fetch
    const r = await call('import:run', { target: 'vercel', id: 'dpl_1', destDir: path.join(tmp, 'ok'), token: 't' })
    expect(r.ok).toBe(true)
    const { text, detail } = splitFailureDetail(r.historyNote)
    expect(text).toMatch(/^🕘 履歴の起点は作れませんでした（ディスクの空きが足りません.*）。$/)
    expect(detail).toContain('ENOSPC')
    expect(r.historyNote.endsWith(detail)).toBe(true)
  })
})

describe('AppRun のイメージ取り出し（crane）', () => {
  const appJson = {
    name: 'demo', components: [{ deploy_source: { container_registry: { image: 'demo.sakuracr.jp/demo:v1', server: 'demo.sakuracr.jp' } } }],
  }
  const serveApp = () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(appJson), { status: 200 })) as unknown as typeof fetch
  }

  it('★ 回線が切れた crane export は、日本語の文＋詳細（Go の no such host）', async () => {
    serveApp()
    h.execFail = (_f, args) => args[0] === 'export'
      ? Object.assign(new Error(`Command failed: crane export demo.sakuracr.jp/demo:v1 /x.tar\nError: Get "https://demo.sakuracr.jp/v2/": dial tcp: lookup demo.sakuracr.jp on 192.168.0.1:53: no such host`), {
        code: 1, stderr: 'Error: Get "https://demo.sakuracr.jp/v2/": dial tcp: lookup demo.sakuracr.jp on 192.168.0.1:53: no such host',
      })
      : null
    const r = await call('import:run', { target: 'sakura-apprun', id: 'app1', destDir: path.join(tmp, 'p') })
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    expect(text).toContain('インターネットに接続できませんでした')
    expect(detail).toContain('no such host')
    expect(r.message).not.toContain('Command failed')
  })

  it('★ パスワードは引数に載せず標準入力で渡し、失敗の文にも出さない', async () => {
    serveApp()
    h.execFail = (_f, args) => args[0] === 'auth'
      // 引数に -p があれば Node は引数を message に入れる。ここでは入れた形で失敗させて、画面の文に出ないことを見る
      ? Object.assign(new Error(`Command failed: crane ${args.join(' ')}\nError: logging in: unauthorized`), { code: 1, stderr: 'Error: logging in: unauthorized' })
      : null
    const r = await call('import:run', { target: 'sakura-apprun', id: 'app1', destDir: path.join(tmp, 'p') })
    const login = h.execCalls.find(c => c.args[0] === 'auth')!
    expect(login.args).not.toContain('REGPASS-DO-NOT-LEAK')
    expect(login.args).toContain('--password-stdin')
    expect(login.stdin).toBe('REGPASS-DO-NOT-LEAK')
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('REGPASS-DO-NOT-LEAK')
    expect(r.message).toContain('unauthorized')
  })
})
