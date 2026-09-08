import { describe, it, expect } from 'vitest'
import { performRollback, type TrafficClientLike } from '../src/main/cloud/rollback'

// rollback.test.ts — cloud:rollback の main 側の歯止め（2026-09-08 検分で指摘）。
//
// cloud:apply / cloud:teardown / cloud:cleanupImages は main 側で opts.confirmed === true を
// 要求しているのに、cloud:rollback だけ「確認は画面側」として素通ししていた。検分役が実際に
// 画面側の `if (!window.confirm(` を `if (false && !window.confirm(` に、`)) return` を
// `)) { /* 確認せず続行 */ }` に変異させても、既存のテスト（文字列一致）は32件すべて緑の
// まま素通りした——**歯止めが振る舞いで守られていなかった**ということ。
//
// ここでは applyBucket.test.ts（apply.ts の confirmed ガード試験）と同じ流儀で、
// **偽の client を注入し、putTraffics が実際に呼ばれたかどうか**で歯止めを固定する
// （文字列一致にしない）。

/** 何を呼ばれたかを記録する偽のクライアント。 */
function fakeClient(response: { dryRun: boolean; ok?: boolean; status?: number; data?: unknown }) {
  const calls: { appId: string; body: unknown }[] = []
  const client: TrafficClientLike = {
    async putTraffics(appId, body) {
      calls.push({ appId, body })
      return response as any
    },
  }
  return { client, calls }
}

describe('performRollback: confirmed !== true なら putTraffics を一切呼ばない（★変異試験①）', () => {
  it('confirmed を渡さない（undefined）と putTraffics は一度も呼ばれず、ok:false を返す', async () => {
    const { client, calls } = fakeClient({ dryRun: false, ok: true })
    const r = await performRollback({ appId: 'app-1', versionName: 'v2', confirmed: undefined as any, client })
    expect(calls.length).toBe(0)
    expect(r.ok).toBe(false)
  })

  it('confirmed: false でも putTraffics は呼ばれない', async () => {
    const { client, calls } = fakeClient({ dryRun: false, ok: true })
    const r = await performRollback({ appId: 'app-1', versionName: null, confirmed: false, client })
    expect(calls.length).toBe(0)
    expect(r.ok).toBe(false)
  })

  it('confirmed が真偽値でない値（"true" など文字列）でも、true でなければ呼ばれない', async () => {
    const { client, calls } = fakeClient({ dryRun: false, ok: true })
    await performRollback({ appId: 'app-1', versionName: 'v2', confirmed: 'true' as any, client })
    expect(calls.length).toBe(0)
  })
})

describe('performRollback: confirmed: true のときだけ、buildRollbackBody(versionName) で putTraffics を呼ぶ', () => {
  it('特定バージョンへの切り替え: {version_name, percent:100} を1回だけ渡す', async () => {
    const { client, calls } = fakeClient({ dryRun: false, ok: true })
    const r = await performRollback({ appId: 'app-1', versionName: 'v2', confirmed: true, client })
    expect(calls).toEqual([{ appId: 'app-1', body: [{ version_name: 'v2', percent: 100 }] }])
    expect(r.ok).toBe(true)
  })

  it('最新に戻す（versionName: null）: {is_latest_version:true, percent:100} を渡す（version_name ではない）', async () => {
    const { client, calls } = fakeClient({ dryRun: false, ok: true })
    await performRollback({ appId: 'app-1', versionName: null, confirmed: true, client })
    expect(calls[0].body).toEqual([{ is_latest_version: true, percent: 100 }])
  })

  it('API がエラーを返せば ok:false（HTTPステータスを含む）', async () => {
    const { client } = fakeClient({ dryRun: false, ok: false, status: 500, data: {} })
    const r = await performRollback({ appId: 'app-1', versionName: 'v2', confirmed: true, client })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('500')
  })

  it('401/403 は認証エラーとして案内する', async () => {
    const { client } = fakeClient({ dryRun: false, ok: false, status: 401 })
    const r = await performRollback({ appId: 'app-1', versionName: 'v2', confirmed: true, client })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('認証')
  })
})
