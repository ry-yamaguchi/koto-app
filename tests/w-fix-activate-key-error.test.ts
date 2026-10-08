import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { activateCloudKey } from '../src/renderer/components/CredentialsModal'

// ── W-59 の検分の指摘（2026-09-29）: activateCloudKey の保存失敗も、英語の頭を取って見せる ──────
//
// 「使用中にする」は、鍵を main へ渡す cloud.saveKey（IPC）を呼ぶ。main が日本語で投げた失敗は
// ipcRenderer.invoke が「Error invoking remote method '<channel>': Error: <本文>」にくるむので、
// 何もしないと、AppRunPanel／AppRunDedicatedPanel が r.message をそのまま出す画面に**英語の頭**が出る。
// W-59 の一元化（remoteError.ts の cleanRemoteError）を、この経路にも通したことを**振る舞いで**固定する。
// （w-fix-remote-error.test.ts の「5つ全部」は setDetail(...) の個数しか見ておらず、この行は対象外だった。）

const HEAD = "Error invoking remote method 'cloud:saveKey': Error: "
const BODY = '鍵を保存できませんでした。もう一度お試しください'

type Stubs = { saveKey: ReturnType<typeof vi.fn>; dispatched: string[] }

function stubEnvironment(saveKey: ReturnType<typeof vi.fn>): Stubs {
  const store = { cloud: { entries: [{ id: 'k1', label: 'テスト用', values: { token: 'tok', secret: 'sec' } }], activeId: null } }
  const dispatched: string[] = []
  vi.stubGlobal('localStorage', { getItem: () => 'enc', setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', {
    electronAPI: {
      secure: { decrypt: async () => JSON.stringify(store), encrypt: async () => 'enc' },
      cloud: { saveKey },
    },
    dispatchEvent: (ev: Event) => { dispatched.push(ev.type); return true },
  })
  return { saveKey, dispatched }
}

describe('W-59: activateCloudKey の保存失敗は、英語の頭を取った日本語の本文だけを返す', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('★ cloud.saveKey が「Error invoking remote method …」で失敗しても、message に英語の頭が残らない', async () => {
    const s = stubEnvironment(vi.fn().mockRejectedValue(new Error(HEAD + BODY)))
    const r = await activateCloudKey('k1')
    expect(r.ok).toBe(false)
    expect(r.message).toBe(BODY)
    expect(r.message).not.toContain('Error invoking remote method')
    expect(s.saveKey).toHaveBeenCalledWith('tok', 'sec')
    // 失敗したときは「認証情報が変わった」通知を出さない（他の画面が誤って更新されない）
    expect(s.dispatched).not.toContain('sakura:credentials-changed')
  })

  it('頭の無い失敗は、そのまま返す（削り過ぎない）', async () => {
    stubEnvironment(vi.fn().mockRejectedValue(new Error('インターネット接続を確認してください')))
    const r = await activateCloudKey('k1')
    expect(r).toEqual({ ok: false, message: 'インターネット接続を確認してください' })
  })

  it('成功すれば ok:true で、認証情報が変わった通知を出す（テストが空振りしていないことの確認）', async () => {
    const s = stubEnvironment(vi.fn().mockResolvedValue(undefined))
    const r = await activateCloudKey('k1')
    expect(r).toEqual({ ok: true })
    expect(s.dispatched).toContain('sakura:credentials-changed')
  })
})
