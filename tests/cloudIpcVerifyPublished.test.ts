import { describe, it, expect } from 'vitest'
import { verifyPublished } from '../src/main/ipc/cloud'
import { verifyMessage, verifyDelaysMs } from '../src/shared/publishVerify'

// ── A（2026-09-16 の検分）: 共用型の公開確認が、503・502・500 を「接続できなかった」に
// 倒していた穴を直す。ここは cloud.ts の `verifyPublished`（IO を含む、9回くり返す本体）を
// **偽の fetch** に流し、振る舞いで固定する（掟10・ソースの文字列を grep するだけのテストに
// しない）。判定そのものの純関数テストは tests/publishVerify.test.ts（judgeVerifyProbe）。

const DELAYS = verifyDelaysMs()
const ATTEMPTS = DELAYS.length + 1 // 初回 + 8回の取り直し = 9

/** 常に同じ番号を返す偽の fetch。呼ばれた回数を数える。 */
function fakeFetchAlways(status: number, body = ''): { fetchImpl: typeof fetch; calls: number[] } {
  const calls: number[] = []
  const fetchImpl = (async () => {
    calls.push(status)
    return { status, text: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** 何ミリ秒も待たない偽の sleep。渡された ms を記録する。 */
function noWaitSleep(): { sleepImpl: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = []
  const sleepImpl = async (ms: number) => { waited.push(ms) }
  return { sleepImpl, waited }
}

describe('cloud.ts: verifyPublished（偽の fetch で振る舞いを固定・A）', () => {
  it('★★★ 503 を返し続けたら no-backend。「接続できなかった」とは言わない（今回の穴そのもの）', async () => {
    const { fetchImpl } = fakeFetchAlways(503)
    const { sleepImpl } = noWaitSleep()
    const r = await verifyPublished('https://example.com', 'v1', () => {}, { fetchImpl, sleepImpl })
    expect(r.outcome).toBe('no-backend')
    expect(verifyMessage(r.outcome, r.status)).not.toContain('接続できなかった')
  })

  it('★★★ 500・502 を返し続けたら error-status', async () => {
    for (const status of [500, 502]) {
      const { fetchImpl } = fakeFetchAlways(status)
      const { sleepImpl } = noWaitSleep()
      const r = await verifyPublished('https://example.com', 'v1', () => {}, { fetchImpl, sleepImpl })
      expect(r.outcome, `status ${status}`).toBe('error-status')
      expect(r.status).toBe(status)
      expect(verifyMessage(r.outcome, r.status)).not.toContain('接続できなかった')
      expect(verifyMessage(r.outcome, r.status)).toContain(String(status))
    }
  })

  it('★★★ 404 はこれまでどおり stale（目印が無い＝古い版という静的配信の正しい観測。ここを壊さない）', async () => {
    const { fetchImpl } = fakeFetchAlways(404)
    const { sleepImpl } = noWaitSleep()
    const r = await verifyPublished('https://example.com', 'v1', () => {}, { fetchImpl, sleepImpl })
    expect(r.outcome).toBe('stale')
  })

  it('★★ 200＋目印一致は ok（1回目で止まる）', async () => {
    const { fetchImpl, calls } = fakeFetchAlways(200, 'v1\n')
    const { sleepImpl, waited } = noWaitSleep()
    const r = await verifyPublished('https://example.com', 'v1', () => {}, { fetchImpl, sleepImpl })
    expect(r.outcome).toBe('ok')
    expect(calls.length).toBe(1)
    expect(waited.length).toBe(0)
  })

  it('★★ 200＋不一致は stale', async () => {
    const { fetchImpl } = fakeFetchAlways(200, 'ふるい\n')
    const { sleepImpl } = noWaitSleep()
    const r = await verifyPublished('https://example.com', 'v1', () => {}, { fetchImpl, sleepImpl })
    expect(r.outcome).toBe('stale')
  })

  it('★★ 通信できないときだけ unreachable', async () => {
    const fetchImpl = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const { sleepImpl } = noWaitSleep()
    const r = await verifyPublished('https://example.com', 'v1', () => {}, { fetchImpl, sleepImpl })
    // unreachable は「本当に繋がらなかった」ときの結果。この場合は「接続できなかった」で正しい
    // （直したのは 503・500・502 のような、繋がってはいるのにエラーが返るケースだけ）。
    expect(r.outcome).toBe('unreachable')
    expect(verifyMessage(r.outcome)).toContain('接続できなかった')
  })

  it('★★★ 503 でも早く諦めず、9回（初回＋8回の取り直し）くり返す。振る舞いは変えない（A-5）', async () => {
    const { fetchImpl, calls } = fakeFetchAlways(503)
    const { sleepImpl, waited } = noWaitSleep()
    const r = await verifyPublished('https://example.com', 'v1', () => {}, { fetchImpl, sleepImpl })
    expect(calls.length).toBe(ATTEMPTS)
    expect(waited).toEqual(DELAYS)
    expect(r.outcome).toBe('no-backend')
  })

  it('★★ 最後に観測した種類で決める（届いたことがある結果は、あとの1回が繋がらなくても薄めない）', async () => {
    let i = 0
    const fetchImpl = (async () => {
      i++
      if (i <= 3) return { status: 503, text: async () => '' } as unknown as Response
      throw new Error('down') // 最後のほうだけ繋がらなくなっても、503 が届いていた事実は残す
    }) as unknown as typeof fetch
    const { sleepImpl } = noWaitSleep()
    const r = await verifyPublished('https://example.com', 'v1', () => {}, { fetchImpl, sleepImpl })
    expect(r.outcome).toBe('no-backend')
  })
})
