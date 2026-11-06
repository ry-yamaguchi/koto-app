import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { h, resetHarness, newProjectDir, setup, REGISTRY_ROW } from './sharedTeardownHarness'
import { splitFailureDetail } from '../src/shared/failureDetail'

// ── 古いイメージの片づけ: 権限を戻す処理が通信で失敗しても、本体の結果と「戻せませんでした」の注意を失わない ──────
// 以前は finally の中の権限を戻す呼び出しが投げると、そのまま外へ出て、削除の結果（何件消えたか）も
// 「権限を元に戻せませんでした」の注意も、回線断の1行（英語の fetch failed）に置き換わっていた。
// 本物の main に偽の client・偽の crane を流し、返る message で固定する（掟10）。

const ctl = vi.hoisted(() => ({
  /** 権限の更新が呼ばれた順の記録（'all' / 'readwrite'）。 */
  permissions: [] as string[],
  /** 'readwrite'（戻す）で回線断にする。 */
  restoreDown: false,
  /** 削除（crane）が投げる。 */
  deleteThrows: false,
  /** 送ったあとで切れた失敗（要求が届いたかは分からない）。 */
  reset: () => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  }),
  net: () => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND secure.sakura.ad.jp'), { code: 'ENOTFOUND' }),
  }),
}))

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/registry-auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasRegistryCredentials: () => true,
  loadRegistryCredentials: () => ({ name: 'myreg', user: 'u', password: 'pw' }),
}))
vi.mock('../src/main/cloud/client', async (orig) => {
  class Fake {
    dryRun = false
    constructor(_o?: unknown) {}
    async listContainerRegistries() { return { dryRun: false as const, ok: true, status: 200, data: { CommonServiceItems: [REGISTRY_ROW] } } }
    async updateRegistryUser(_z: string, _id: string, body: { permission: string }) {
      ctl.permissions.push(body.permission)
      if (body.permission === 'readwrite' && ctl.restoreDown) throw ctl.net()
      return { dryRun: false as const, ok: true, status: 200, data: null }
    }
  }
  return { ...(await orig<Record<string, unknown>>()), SakuraCloudClient: Fake }
})
const TAGS = ['v20260101-000001', 'v20260101-000002', 'v20260101-000003', 'v20260101-000004', 'v20260101-000005', 'v20260101-000006', 'v20260101-000007', 'v20260101-000008']
const digest = (n: number) => `sha256:${String(n).repeat(64)}`
vi.mock('../src/main/cloud/imageCleanup', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listTags: async () => ({ ok: true, tags: TAGS }),
  resolveDigests: async () => Object.fromEntries(TAGS.map((t, i) => [t, digest(i + 1)])),
  deleteDigests: async (o: { digests: string[] }) => {
    if (ctl.deleteThrows) throw ctl.reset()
    return { deleted: [...o.digests], failed: [], permission: false, unsupported: false }
  },
}))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const cleanup = (dir: string, confirmed: boolean) => Promise.resolve(h.handlers.get('cloud:cleanupImages')!({ sender: { send() {} } }, dir, { confirmed }))

let dir = ''
beforeEach(() => {
  resetProjectOpsForTests(); resetHarness()
  ctl.permissions = []; ctl.restoreDown = false; ctl.deleteThrows = false
  dir = newProjectDir()
  setup(dir, { env: [], resources: [], meta: { registryName: 'myreg' } as any })
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const RESTORE_WARNING = '権限を元（Push & Pull）に戻せませんでした'

describe('cloud:cleanupImages: 権限を戻す処理の失敗', () => {
  it('基準: 戻せたら、削除の結果だけが返る（権限は上げて、戻す）', async () => {
    const r = await cleanup(dir, true)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('古いイメージを')
    expect(r.message).not.toContain(RESTORE_WARNING)
    expect(ctl.permissions).toEqual(['all', 'readwrite'])
  })

  it('★ 削除は済んだが、戻す呼び出しが回線断: 削除の結果と「戻せませんでした」の注意が残り、英語の fetch failed だけにならない', async () => {
    ctl.restoreDown = true
    const r = await cleanup(dir, true)
    expect(r.ok).toBe(true)
    expect(r.deleted.length).toBeGreaterThan(0)
    expect(r.message).toContain('古いイメージを')
    expect(r.message).toContain(RESTORE_WARNING)
    expect(r.message).not.toBe('fetch failed')
  })

  it('★ 削除の途中で回線断、しかも戻す呼び出しも失敗: 日本語の文＋戻せなかった注意、詳細は最後の行', async () => {
    ctl.deleteThrows = true
    ctl.restoreDown = true
    const r = await cleanup(dir, true)
    expect(r.ok).toBe(false)
    const { text, detail } = splitFailureDetail(r.message)
    // 書き込みの途中なので「済んだかは確かめられていません」と言い、もう一度とは言わない
    expect(text).toContain('操作が済んだかは確かめられていません')
    expect(text).toContain(RESTORE_WARNING)
    expect(detail).toContain('ECONNRESET')
    expect(r.message.endsWith(`詳細: ${detail}`)).toBe(true)
  })

  it('削除の途中で回線断、権限は戻せた: 注意は付かない', async () => {
    ctl.deleteThrows = true
    const r = await cleanup(dir, true)
    expect(r.ok).toBe(false)
    expect(splitFailureDetail(r.message).text).not.toContain(RESTORE_WARNING)
    expect(splitFailureDetail(r.message).detail).toContain('ECONNRESET')
    expect(ctl.permissions).toEqual(['all', 'readwrite'])
  })
})
