import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'

// ── 0.6.24 F-4: teardownStorageForProject の `shown`（確認で見せた保存場所）。偽の保存場所に流して、呼ばれた要求の一覧で見る ──────────────
// 仕様: docs/v0624-aefi-spec.md の F-4・6章 U3・U5。
//   ・`shown` は必須（U5。共用型・HANAMII・専有型の3つの呼び手がすべて渡す）。値が何であれ（undefined を含む）、見せたものだけを消す
//   ・見せていないものは、アダプタを作る前に ok:false・要求0件
//   ・**渡さない形（従来どおり全件を消す道）は無い**。JS から呼ぶ側が渡し忘れても、キーが無いだけで「見せたものが無い」扱い＝何も消さない
//   ・結果の failed は、残っているバケット名の全件を remainingBuckets で返す（先頭は remainingBucket）
vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { teardownStorageForProject } from '../src/main/cloud/storageForTarget'
import { A, B, PREFIX, APP, bucketRef, h, resetHarness, newProjectDir, setup } from './sharedTeardownHarness'

const CREDS = { token: 'TEST-TOKEN', secret: 'TEST-SECRET' } as any
const pair = (bucket: string, prefix = PREFIX) => ({ bucket, prefix })
let dir = ''
beforeEach(() => { resetHarness(); dir = newProjectDir(); setup(dir, { env: [A, B], resources: [APP, bucketRef(A), bucketRef(B)] }) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const storageCalls = () => h.calls.filter(c => /^(connect|listAllKeys|deleteKeys|deleteBucket|deletePermission|listPermissions|dispose)\b/.test(c))
const touching = (bucket: string) => h.calls.filter(c => c === `listAllKeys ${bucket}` || c === `deleteKeys ${bucket}` || c === `deleteBucket ${bucket}`)

describe('shown を渡した呼び手（3つの呼び手すべて）: 見せたものだけを消す', () => {
  it('★★★ キーはあるが値が undefined → 見せたものが無い扱い。接続（アダプタを作ること）も一覧も削除も0件', async () => {
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, shown: undefined })
    expect(storageCalls()).toEqual([])
    expect(r).toMatchObject({ ok: false, reason: 'failed', done: [], remainingBucket: A, remainingBuckets: [A, B], skippedBuckets: [A, B], warnings: [] })
    expect((r as any).message).toBe('確認で保存場所の名前を挙げられなかったため、保存場所『koto-data-a』『koto-data-b』は削除していません。')
  })

  it('★★ 見せたのが B だけ: B だけ消し（鍵の1件は B に渡る）、A は0件。回し終えたあとに ok:false・done に B が残る・名前での鍵の一括の無効化はしない', async () => {
    h.permissions = [{ id: 'perm-old', displayName: 'koto-myapp-apprun' }]
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, permissionId: 'perm-rec', sweepKeysFor: 'apprun', shown: [pair(B)] })
    expect(touching(A)).toEqual([])
    expect(h.calls).toEqual(expect.arrayContaining([`listAllKeys ${B}`, `deleteKeys ${B}`, `deleteBucket ${B}`, 'deletePermission perm-rec']))
    expect(h.calls).not.toContain('listPermissions')
    expect(r.ok).toBe(false)
    if (r.ok || r.reason !== 'failed') throw new Error('failed のはず')
    expect(r.done.map(b => b.bucket)).toEqual([B])
    expect(r.remainingBucket).toBe(A)
    expect(r.remainingBuckets).toEqual([A])
    expect(r.skippedBuckets).toEqual([A])
    expect(h.calls.at(-1)).toBe('dispose') // アダプタの一時キーは片づける
  })

  it('★★ 見せたのが全件（並びは違ってよい）→ 全件消える・ok:true・skippedBuckets も remainingBuckets も付かない', async () => {
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, shown: [pair(B), pair(A)] })
    expect(r.ok).toBe(true)
    expect(r).not.toHaveProperty('skippedBuckets')
    expect(h.calls).toEqual(expect.arrayContaining([`deleteBucket ${A}`, `deleteBucket ${B}`]))
  })

  it('placements を渡した回も同じ（渡した一覧を、見せたものだけに絞る）。保存場所が1件も無い回は none のまま（shown が無くても）', async () => {
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, placements: [{ bucket: A, prefix: PREFIX, shared: true }], shown: [pair(B)] })
    expect(storageCalls()).toEqual([])
    expect((r as any).skippedBuckets).toEqual([A])
    h.calls = []
    expect(await teardownStorageForProject({ creds: CREDS, projectDir: dir, placements: [], shown: undefined })).toEqual({ ok: true, reason: 'none' })
    expect(storageCalls()).toEqual([])
  })
})

describe('shown を渡さない形は無い（U5 で必須にした）', () => {
  it('★★★ キーごと渡さない（JS からの渡し忘れ・型を破った呼び出し）→ 見せたものが無い扱い。接続も一覧も削除も0件・ok:false・全件が残りに。従来のように全件を消さない', async () => {
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir } as any)
    expect(storageCalls()).toEqual([])
    expect(r).toMatchObject({ ok: false, reason: 'failed', done: [], remainingBucket: A, remainingBuckets: [A, B], skippedBuckets: [A, B], warnings: [] })
    expect((r as any).message).toBe('確認で保存場所の名前を挙げられなかったため、保存場所『koto-data-a』『koto-data-b』は削除していません。')
  })

  it('★★ placements を渡した回も同じ（キーが無ければ、渡した一覧の全件を飛ばす）。保存場所が1件も無い回は none のまま', async () => {
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, placements: [{ bucket: A, prefix: PREFIX, shared: true }] } as any)
    expect(storageCalls()).toEqual([])
    expect((r as any).skippedBuckets).toEqual([A])
    expect(await teardownStorageForProject({ creds: CREDS, projectDir: dir, placements: [] } as any)).toEqual({ ok: true, reason: 'none' })
    expect(storageCalls()).toEqual([])
  })

  it('途中で止まった回は、止まった1件・後ろの未着手を remainingBuckets で返す（先頭は remainingBucket）。飛ばした分が無ければ skippedBuckets は付かない', async () => {
    h.fail[`listAllKeys ${A}`] = 'throw'
    const r = await teardownStorageForProject({ creds: CREDS, projectDir: dir, shown: [pair(A), pair(B)] })
    if (r.ok || r.reason !== 'failed') throw new Error('failed のはず')
    expect(r.remainingBucket).toBe(A)
    expect(r.remainingBuckets).toEqual([A, B])
    expect(r).not.toHaveProperty('skippedBuckets')
    expect(touching(B)).toEqual([])
  })
})
