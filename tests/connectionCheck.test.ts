import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkBilling, type BillingClient } from '../src/main/cloud/connectionCheck'
import type { RequestResult } from '../src/main/cloud/client'
import { splitFailureDetail } from '../src/shared/failureDetail'

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

  // P（2026-09-10 レビューの修理・バッチ3）: 失敗時の応答本文（apiErrorMessage）を message に
  // 添える。直す前は HTTPステータスだけで、応答本文を捨てていた（共用型のレジストリ項目と
  // 扱いが揃っていなかった）。
  it('auth-status の失敗時、応答本文（apiErrorMessage）を message に添える', async () => {
    const client: BillingClient = {
      getAuthStatus: async () => fail(401, { error_msg: '認証エラーです' }),
      getBillByContract: async () => ok({}),
    }
    const r = await checkBilling(client, 'is1a')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('認証エラーです')
  })

  it('bill の失敗時、応答本文（apiErrorMessage）を message に添える', async () => {
    const client: BillingClient = {
      getAuthStatus: async () => ok({ Account: { ID: 'acc-1' } }),
      getBillByContract: async () => fail(500, { error_msg: '請求情報を取得できません' }),
    }
    const r = await checkBilling(client, 'is1a')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('請求情報を取得できません')
  })

  it('例外が飛んでも ok:false で返す（呼び出し元を巻き込まない）。見分けられない失敗は原文のまま', async () => {
    const client: BillingClient = {
      getAuthStatus: async () => { throw new Error('network down') },
      getBillByContract: async () => ok({}),
    }
    const r = await checkBilling(client, 'is1a')
    expect(r).toEqual({ ok: false, message: 'network down' })
  })

  // 通信そのものの失敗は、本物の fetch の例外の形で投げ、読み取りの日本語の文（完全一致）で返す。
  it('★ 名前が引けない・時間切れ・途中で切れた・証明書は、日本語の1文で返す（auth-status の段でも bill の段でも）', async () => {
    const offline = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    const signal = AbortSignal.timeout(5)
    await new Promise<void>(resolve => setTimeout(resolve, 40))
    const timeout = signal.reason
    const reset = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    const tls = new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })
    const T_OFFLINE = 'インターネットに接続できませんでした。接続を確かめてから、もう一度お試しください。'
    const T_TIMEOUT = '時間内に返事がありませんでした。混み合っているかもしれません。少し待ってから、もう一度お試しください。'
    const T_TLS = '安全な接続を確認できませんでした。社内ネットワークやセキュリティソフトの設定を確かめてください。'
    // 文は詳細の行を除いて完全一致で比べ、詳細（原文）は別に固める
    const sentenceOnly = (r: { ok: boolean; message?: string }) => ({ ...r, message: splitFailureDetail(r.message ?? '').text })
    const details: string[] = []
    for (const [thrown, expected] of [[offline, T_OFFLINE], [timeout, T_TIMEOUT], [reset, T_TIMEOUT], [tls, T_TLS]] as const) {
      const atAuth: BillingClient = {
        getAuthStatus: async () => { throw thrown },
        getBillByContract: async () => ok({}),
      }
      const rAuth = await checkBilling(atAuth, 'is1a')
      expect(sentenceOnly(rAuth)).toEqual({ ok: false, message: expected })
      details.push(splitFailureDetail(rAuth.message ?? '').detail)
      const atBill: BillingClient = {
        getAuthStatus: async () => ok({ Account: { ID: 'acc-1' } }),
        getBillByContract: async () => { throw thrown },
      }
      const rBill = await checkBilling(atBill, 'is1a')
      expect(sentenceOnly(rBill)).toEqual({ ok: false, message: expected })
      details.push(splitFailureDetail(rBill.message ?? '').detail)
    }
    // 4つの失敗 × 2つの段、すべてに原文の詳細が付く（認証の段でも請求の段でも）
    expect(details).toHaveLength(8)
    for (const d of details) expect(d).not.toBe('')
    expect(details[0]).toBe('fetch failed / ENOTFOUND')
    expect(details[6]).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
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
    // 専有型API参照の失敗の文は、接続テストの口だけが日本語にする（作る・消す流れの中の getLimits は原文のまま）
    expect(block).toContain('const limits = await getLimits(auth, undefined, { connectionTest: true })')
    expect(block).not.toContain('getLimits(auth)')
    expect(block).toContain('ok: api.ok && registry.ok && billing.ok')
  })

  // W-38（2026-09-27 決定・案2）: 専有型①「公開に対応したときに確認」の注記は古く、
  // 接続テストでレジストリの権限不足に、日額のかかるクラスタを作ったあとの⑧で初めて気づいていた。
  // 共用型 cloud:testConnection と同じレジストリ確認を足し、3項目（api・registry・billing）を返す。
  it('専有型の接続テストは3項目（api・registry・billing）を返す形になっている（roadmap #35・W-38: 共用型と同じチェックリストに揃える）', () => {
    const at = dedicatedIpc.indexOf("ipcMain.handle('apprunDedicated:testConnection'")
    const end = dedicatedIpc.indexOf('\n  })', at)
    const block = dedicatedIpc.slice(at, end)
    expect(block).toContain('checks: { api, registry, billing }')
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
