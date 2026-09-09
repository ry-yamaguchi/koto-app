import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkBilling, type BillingClient } from '../src/main/cloud/connectionCheck'
import type { RequestResult } from '../src/main/cloud/client'

// roadmap #35: 接続テストの見せ方を、共用型と専有型で揃える。
// 「請求（コスト）参照」チェックは共用型 cloud:testConnection と専有型 apprunDedicated:testConnection の
// 両方が同じ関数（checkBilling）を呼ぶ——判断・表示を複製しない（掟10）。ここでは:
//   1. checkBilling 自体を偽クライアントで確かめる（純ロジック・electron 非依存）
//   2. 両方の ipcMain ハンドラが実際にこの1つの関数を呼んでいることを、ソースを読んで固定する
//      （electron 依存の ipcMain.handle 本体は直接実行できないため、既存の *Wiring.test.ts と
//      同じ「呼び出しの形を一意に指す」作法にする・掟10）

function ok(data: unknown): RequestResult {
  return { dryRun: false, ok: true, status: 200, data }
}
function fail(status: number, data: unknown): RequestResult {
  return { dryRun: false, ok: false, status, data }
}

describe('checkBilling（純ロジック・偽クライアント）', () => {
  it('auth-status → accountId → bill の順に成功すれば ok:true', async () => {
    const client: BillingClient = {
      getAuthStatus: async () => ok({ Account: { ID: 'acc-1' } }),
      getBillByContract: async () => ok({ Bills: [{ Amount: 1000, Date: '2026-09-01' }] }),
    }
    const r = await checkBilling(client, 'is1a')
    expect(r).toEqual({ ok: true, status: 200 })
  })

  it('auth-status が失敗すれば ok:false（billは呼ばない必要はないが、少なくとも成功にはしない）', async () => {
    const client: BillingClient = {
      getAuthStatus: async () => fail(401, {}),
      getBillByContract: async () => ok({}),
    }
    const r = await checkBilling(client, 'is1a')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
  })

  it('accountId を取り出せなければ ok:false（推測で埋めない）', async () => {
    const client: BillingClient = {
      getAuthStatus: async () => ok({}), // Account/Member どちらの形も無い
      getBillByContract: async () => ok({}),
    }
    const r = await checkBilling(client, 'is1a')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('アカウントID')
  })

  it('bill の取得が失敗すれば ok:false', async () => {
    const client: BillingClient = {
      getAuthStatus: async () => ok({ Account: { ID: 'acc-1' } }),
      getBillByContract: async () => fail(500, {}),
    }
    const r = await checkBilling(client, 'is1a')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
  })

  it('例外が飛んでも ok:false で返す（呼び出し元を巻き込まない）', async () => {
    const client: BillingClient = {
      getAuthStatus: async () => { throw new Error('network down') },
      getBillByContract: async () => ok({}),
    }
    const r = await checkBilling(client, 'is1a')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('network down')
  })
})

describe('共用型・専有型とも checkBilling を呼んでいる（掟10: 判断・表示を複製しない）', () => {
  const cloudIpc = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
  const dedicatedIpc = readFileSync(join(__dirname, '..', 'src/main/ipc/apprunDedicated.ts'), 'utf-8')

  it('cloud:testConnection（共用型）は checkBilling を import して呼ぶ。請求ロジックを自前で書き直していない', () => {
    expect(cloudIpc).toContain("import { checkBilling } from '../cloud/connectionCheck'")
    expect(cloudIpc).toContain('const billing: Check = await checkBilling(client, zone)')
    // 旧・複製された auth-status→accountId→bill の手書きロジックが cloud:testConnection の
    // 中に残っていないこと（getAuthStatus の直呼びが cost ハンドラ以外に増えていない）。
    const testConnAt = cloudIpc.indexOf("ipcMain.handle('cloud:testConnection'")
    const testConnEnd = cloudIpc.indexOf('\n  })', testConnAt)
    const testConnBlock = cloudIpc.slice(testConnAt, testConnEnd)
    expect(testConnBlock).not.toContain('client.getAuthStatus(')
  })

  it('apprunDedicated:testConnection（専有型）も checkBilling を import して呼ぶ。同じ関数を複製していない', () => {
    expect(dedicatedIpc).toContain("import { checkBilling, type ConnCheck } from '../cloud/connectionCheck'")
    expect(dedicatedIpc).toContain('await checkBilling(client, BILLING_ZONE)')
  })

  it('apprunDedicated:testConnection は SakuraCloudClient を dryRun:true で作る（GETのみ・何も作らない・掟4）', () => {
    const at = dedicatedIpc.indexOf("ipcMain.handle('apprunDedicated:testConnection'")
    expect(at).toBeGreaterThan(0)
    const end = dedicatedIpc.indexOf('\n  })', at)
    const block = dedicatedIpc.slice(at, end)
    expect(block).toContain('new SakuraCloudClient({ credentials: auth, dryRun: true })')
    expect(block).toContain('getLimits(auth)')
    expect(block).toContain('ok: api.ok && billing.ok')
  })

  it('専有型の接続テストは2項目（api・billing）を返す形になっている（roadmap #35: 共用型と同じチェックリストに揃える）', () => {
    const at = dedicatedIpc.indexOf("ipcMain.handle('apprunDedicated:testConnection'")
    const end = dedicatedIpc.indexOf('\n  })', at)
    const block = dedicatedIpc.slice(at, end)
    expect(block).toContain('checks: { api, billing }')
  })
})

describe('IPC 3点セット（掟6）: apprunDedicated:testConnection', () => {
  const ipc = readFileSync(join(__dirname, '..', 'src/main/ipc/apprunDedicated.ts'), 'utf-8')
  const preload = readFileSync(join(__dirname, '..', 'src/main/preload.ts'), 'utf-8')
  const globalDts = readFileSync(join(__dirname, '..', 'src/renderer/global.d.ts'), 'utf-8')

  it('main: ipcMain.handle を登録している', () => {
    expect(ipc).toContain("ipcMain.handle('apprunDedicated:testConnection'")
  })

  it('preload: electronAPI.apprunDedicated.testConnection を公開している', () => {
    expect(preload).toContain("testConnection: (auth: { token: string; secret: string }) => ipcRenderer.invoke('apprunDedicated:testConnection', auth)")
  })

  it('global.d.ts: 型が checks: { api, billing } の形を宣言している', () => {
    const at = globalDts.indexOf('apprunDedicated: {')
    expect(at).toBeGreaterThan(0)
    const end = globalDts.indexOf('limits(auth:', at)
    const block = globalDts.slice(at, end)
    expect(block).toContain('testConnection(auth: { token: string; secret: string })')
    expect(block).toContain('api: { ok: boolean')
    expect(block).toContain('billing: { ok: boolean')
  })
})
