import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { splitFailureDetail } from '../src/shared/failureDetail'

// ── npm の失敗の見出し: 回線断・手元のファイルの失敗は、その文を見出しにする ─────────────────────────────
// 以前は、どの npm の失敗にも「package.json に書かれた名前が正しいか」と言い、回線が切れているだけでも書き間違いを疑わせた。

async function runInstall(stderr: string) {
  vi.resetModules()
  vi.doMock('child_process', () => ({
    execFile: (_cmd: string, args: string[], optsOrCb: any, cb?: any) => {
      const done = cb ?? optsOrCb
      if (args.includes('--version')) return done(null, '10.0.0', '')
      return done(new Error('exit 1'), '', stderr)
    },
  }))
  vi.doMock('../src/main/loginPath', () => ({ awaitLoginPath: async () => {}, loginPathHintForMissingTool: () => '' }))
  const { installDependencies } = await import('../src/main/cloud/npmInstall')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-npmfail-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"zzz":"1"}}')
    return await installDependencies(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

afterEach(() => { vi.doUnmock('child_process'); vi.doUnmock('../src/main/loginPath') })

describe('installDependencies の失敗の見出し', () => {
  it.each([
    ['ENOTFOUND', 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/zzz failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org', 'インターネットに接続できませんでした'],
    ['EAI_AGAIN', 'npm error code EAI_AGAIN\nnpm error network request to https://registry.npmjs.org/zzz failed', 'インターネットに接続できませんでした'],
    ['ETIMEDOUT（時間切れ）', 'npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/zzz failed', '時間内に返事がありませんでした'],
    ['ENOSPC（ディスクの空き）', 'npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device, write', 'ディスクの空きが足りません'],
    ['EACCES（権限）', 'npm error code EACCES\nnpm error syscall mkdir\nnpm error path /Users/me/app/node_modules\nnpm error EACCES: permission denied', 'このフォルダには書き込めません'],
  ])('%s: 見分けた文が見出し。package.json の書き間違いとは言わない', async (_name, stderr, headline) => {
    const r = await runInstall(stderr)
    expect(r.ok).toBe(false)
    expect(r.diagnosed).toBe(true)
    const { text, detail } = splitFailureDetail(r.message ?? '')
    expect(text).toContain(headline)
    expect(text).not.toContain('package.json')
    expect(detail).not.toBe('')
  })

  it('見分けられない npm の失敗（存在しない名前など）は、今までの文のまま', async () => {
    const r = await runInstall('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/zzz - Not found')
    expect(r.ok).toBe(false)
    expect(r.diagnosed).toBeUndefined()
    const { text, detail } = splitFailureDetail(r.message ?? '')
    expect(text).toContain('ライブラリを用意できませんでした')
    expect(text).toContain('package.json')
    expect(detail).toContain('E404')
  })
})
