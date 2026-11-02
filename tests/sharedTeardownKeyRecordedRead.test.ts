import { describe, it, expect, afterEach } from 'vitest'
import { readSharedTeardownRecord, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'

// ── 共用型の記録の keyRecorded を、画面が読むときの規則 ────────────────────────────────────────────────────────
// 鍵の無効化は共用型の段にしかできない。false と言い切れるのは main が false を返したときだけで、欠け・真偽値でない値は「記録の鍵が残っている」（段を走らせる側）に読む。
// 投げない（形が違う記録のように、確認を止めない）。main が返す値の作り方は tests/sharedTeardownRecord.test.ts（T-3g）。

const mainRecord = (over: Record<string, unknown> = {}) => ({
  appNames: ['myapp'], registryName: 'myreg', registryOrigin: 'owned', registryUsers: [], stateOnlyBuckets: [],
  placements: [{ bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }], keyRecorded: false, ...over,
})

function installCloud(reply: unknown) {
  ;(globalThis as any).window = { electronAPI: { cloud: { teardownRecord: async () => reply } } }
}

afterEach(() => { delete (globalThis as any).window })

describe('readSharedTeardownRecord: keyRecorded', () => {
  it.each([
    ['欠けた', undefined],
    ["文字列（'false'）", 'false'],
    ['数値（0）', 0],
    ['null', null],
    ['配列', []],
  ])('★★★ keyRecorded が%s → 投げず、true（記録の鍵あり＝走らせる側）に読む', async (_n, value) => {
    installCloud({ ok: true, record: mainRecord({ keyRecorded: value }) })
    const got: SharedTeardownRecord = await readSharedTeardownRecord('/proj')
    expect(got.keyRecorded).toBe(true)
  })

  it('★★★ false のときだけ false。true は true', async () => {
    installCloud({ ok: true, record: mainRecord({ keyRecorded: false }) })
    expect((await readSharedTeardownRecord('/proj')).keyRecorded).toBe(false)
    installCloud({ ok: true, record: mainRecord({ keyRecorded: true }) })
    expect((await readSharedTeardownRecord('/proj')).keyRecorded).toBe(true)
  })

  it('ほかの項目の形が違う記録は、今までどおり投げる（keyRecorded の欠けとは別）', async () => {
    installCloud({ ok: true, record: mainRecord({ placements: undefined }) })
    await expect(readSharedTeardownRecord('/proj')).rejects.toThrow('破棄するものの記録の形を読めませんでした')
  })
})
