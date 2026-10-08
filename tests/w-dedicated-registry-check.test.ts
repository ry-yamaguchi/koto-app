import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── W-38（2026-09-27 決定・案2）: 専有型①の接続テストの注記「レジストリの権限は、アプリの
// 公開に対応したときに確認します。」がもう古い ─────────────────────────────────
//
// 専有型はすでに⑧でアプリを公開でき、公開にはコンテナレジストリの権限が要る。それなのに
// 接続テストは請求と専有型API参照の2点しか確かめておらず、レジストリの権限不足には
// 「⑧で公開しようとして初めて」気づく（日額のかかるクラスタを作ったあと）。
//
// 決定は「共用型の接続テスト（src/main/ipc/cloud.ts:360-379）と同じ確認を足し、注記は消す」。
// **cloud.ts は読むだけで変更しない**（担当外）。ここは専有型 apprunDedicated:testConnection の
// 振る舞いを、偽の SakuraCloudClient に実際に流して固定する（文字列一致ではない・掟10）。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  /** listContainerRegistries の偽の応答。 */
  registryResult: { dryRun: false, ok: true, status: 200, data: {} } as any,
  registryCalls: 0,
  /** getAuthStatus / getBillByContract（checkBilling が使う）の偽の応答。既定は両方成功。 */
  authStatusResult: { dryRun: false, ok: true, status: 200, data: { Account: { ID: 'acc-1' } } } as any,
  billResult: { dryRun: false, ok: true, status: 200, data: { Bills: [{ Amount: 1000, Date: '2026-09-01' }] } } as any,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

// 専有型API参照（GET /limits）は fetch を直接叩く薄いクライアント（src/main/cloud/apprunDedicated.ts）
// なので、ここでは getLimits だけを差し替える（レジストリ確認のテストに専有型APIの実ネットワークは要らない）。
vi.mock('../src/main/cloud/apprunDedicated', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, getLimits: async () => ({ ok: true, data: { clusterCount: 5 } }) }
})

// SakuraCloudClient を偽物に差し替える。**listContainerRegistries が呼ばれたか・何を返すか**を
// 制御する（共用型 cloud:testConnection と同じ判定をここでも行っているかを確かめる）。
// apiErrorMessage 等の実物のヘルパーは importOriginal で残す。
vi.mock('../src/main/cloud/client', async (importOriginal) => {
  const real = await importOriginal<any>()
  class FakeSakuraCloudClient {
    constructor(_opts: any) {}
    async listContainerRegistries(_zone: string) {
      h.registryCalls++
      return h.registryResult
    }
    async getAuthStatus(_zone: string) { return h.authStatusResult }
    async getBillByContract(_zone: string, _accountId: string) { return h.billResult }
  }
  return { ...real, SakuraCloudClient: FakeSakuraCloudClient }
})

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'

registerApprunDedicatedHandlers({} as any)
const testConnection = h.handlers.get('apprunDedicated:testConnection')!
const AUTH = { token: 'tok', secret: 'sec' }

beforeEach(() => {
  h.registryResult = { dryRun: false, ok: true, status: 200, data: {} }
  h.registryCalls = 0
  h.authStatusResult = { dryRun: false, ok: true, status: 200, data: { Account: { ID: 'acc-1' } } }
  h.billResult = { dryRun: false, ok: true, status: 200, data: { Bills: [{ Amount: 1000, Date: '2026-09-01' }] } }
})

describe('W-38: apprunDedicated:testConnection がコンテナレジストリの権限も確かめる', () => {
  it('★★ レジストリの一覧取得を実際に呼ぶ（何も作らない GET）', async () => {
    await testConnection(null, AUTH)
    expect(h.registryCalls).toBe(1)
  })

  it('★★ レジストリ・専有型API・請求のすべてが成功すれば ok:true。checks に registry を含む', async () => {
    const r = await testConnection(null, AUTH)
    expect(r.ok).toBe(true)
    expect(r.checks.registry.ok).toBe(true)
    expect(r.checks.api.ok).toBe(true)
    expect(r.checks.billing.ok).toBe(true)
  })

  it('★★ レジストリの権限が無いと、ほかが通っていても全体は ok:false になる（歯止め）', async () => {
    h.registryResult = { dryRun: false, ok: false, status: 403, data: {} }
    const r = await testConnection(null, AUTH)
    expect(r.checks.registry.ok).toBe(false)
    expect(r.checks.registry.message).toContain('権限不足')
    // 専有型APIと請求は成功しているのに、レジストリが失敗していれば全体は失敗——
    // 「ok: api.ok && billing.ok」に戻す変異（registry を判定に入れない）を、この行が捕まえる。
    expect(r.checks.api.ok).toBe(true)
    expect(r.checks.billing.ok).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('レジストリの取得が原因不明のHTTPエラーのときは、ステータスと応答本文を message に載せる', async () => {
    h.registryResult = { dryRun: false, ok: false, status: 500, data: { error_msg: 'サーバエラーです' } }
    const r = await testConnection(null, AUTH)
    expect(r.checks.registry.ok).toBe(false)
    expect(r.checks.registry.message).toContain('500')
    expect(r.checks.registry.message).toContain('サーバエラーです')
  })

  it('APIキー未登録のときは、api・registry・billing の3項目とも ng を返す（3点セットの型と一致）', async () => {
    const r = await testConnection(null, { token: '', secret: '' })
    expect(r.ok).toBe(false)
    expect(r.checks.api.ok).toBe(false)
    expect(r.checks.registry.ok).toBe(false)
    expect(r.checks.billing.ok).toBe(false)
    expect(h.registryCalls).toBe(0) // キーが無ければレジストリへも一切問い合わせない
  })
})
