import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'

// ── T-F1・F2・F3・F4・F7（共用型）0.6.24 F-4: 本物の cloud:teardown に、偽の client・偽の保存場所を流す ──────────────────
// 仕様: docs/v0624-aefi-spec.md の F-4・T-F1〜F4・F7。「見せていない保存場所への要求が0件」を、呼ばれた要求の一覧（h.calls）で固定する（掟10）。
//   ・確認で見せた保存場所（名前と prefix の組。shownPlacements）と一致するものだけを消す
//   ・見せていないもの（確認のあとで足された・名前を挙げられなかった・値の形が違う）は、外へ1本も要求を出さない。ok:false・残りに入る・行（公開の記録）は残る
//   ・飛ばした分があるとき、名前での鍵の一括の無効化はしない。記録の鍵は、実際に片づけた最初の1件に渡る
// 画面を通した流れは tests/sharedShownTeardownFlow.test.ts。純関数は tests/storageSelection.test.ts。
import { A, B, PREFIX, APP, bucketRef, h, resetHarness, newProjectDir, setup, envBuckets, stateKinds, stateMeta, writePublishRecord, publishTargets, OK_AUTH } from './sharedTeardownHarness'
import { permissionNameFor } from '../src/shared/storageKeys'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
// 画面を通さず本物の main を直接呼ぶ（shownPlacements は各試験が自分で書く）
const teardown = h.handlers.get('cloud:teardown')!
const EVENT = {}
const C = 'koto-data-c'
const D = 'koto-data-d'
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const pair = (bucket: string, prefix = PREFIX) => ({ bucket, prefix })
const go = (shownPlacements?: unknown, extra: Record<string, unknown> = {}) =>
  teardown(EVENT, dir, OK_AUTH, { ...GO, ...extra, ...(shownPlacements === undefined ? {} : { shownPlacements }) })

let dir = ''
beforeEach(() => { resetProjectOpsForTests(); resetHarness(); dir = newProjectDir() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** 共用型の行（公開の記録）つきのプロジェクト。env は env.json の同意済み、stateOnly は state にだけある保存場所。 */
function put(env: string[], opts: { stateOnly?: string[]; meta?: Record<string, unknown>; envExtra?: (b: string) => Record<string, unknown> } = {}) {
  setup(dir, { env, resources: [APP, ...[...env, ...(opts.stateOnly ?? [])].map(bucketRef)], ...(opts.meta ? { meta: opts.meta as any } : {}), ...(opts.envExtra ? { envExtra: opts.envExtra } : {}) })
  writePublishRecord(dir, { 'sakura-apprun': { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://myapp.example.test' } })
}

/** 保存場所への要求（接続・一覧・削除・鍵）。アプリ・レジストリへの要求は含めない。 */
const storageCalls = () => h.calls.filter(c => /^(connect|listAllKeys|deleteKeys|deleteBucket|deletePermission|listPermissions|dispose)\b/.test(c))
/** そのバケットへ出た要求（一覧・データ削除・バケット削除）。 */
const touching = (bucket: string) => h.calls.filter(c => c === `listAllKeys ${bucket}` || c === `deleteKeys ${bucket}` || c === `deleteBucket ${bucket}`)
const gone = (bucket: string) => [`listAllKeys ${bucket}`, `deleteKeys ${bucket}`, `deleteBucket ${bucket}`]
const SKIP_CHANGED = (b: string) => `確認のあとで保存場所の記録が変わったため、保存場所『${b}』は削除していません。`
const SKIP_UNNAMED = (b: string) => `確認で保存場所の名前を挙げられなかったため、保存場所『${b}』は削除していません。`

describe('T-F1 共用型: 確認で見せていない保存場所への要求は0件', () => {
  it('★★★ 確認は A だけ名指しし、そのあとで env.json に B が足された → 要求は A だけ・B は0件・ok:false・残りに B・行は残る', async () => {
    put([A, B]) // 確認のあとの記録（B が足されている）
    const reply = await go([pair(A)])

    expect(h.calls).toEqual(expect.arrayContaining(gone(A)))
    expect(touching(B), 'B への要求が出ている（見せていないのに）').toEqual([])
    expect(h.calls.filter(c => c.endsWith(` ${B}`))).toEqual([])
    expect(reply.ok).toBe(false)
    expect(reply.appDeleted).toBe(true)
    expect(reply.remainingBucket).toBe(B)
    expect(reply.remainingBuckets).toEqual([B])
    expect(reply.skippedBuckets).toEqual([B])
    expect(reply.message).toContain(SKIP_CHANGED(B))
    expect(reply.message).toContain(`保存場所『${B}』が残っています（消すまで月額が続きます）`)
    // 行（公開の記録）が残る＝押し直せる。消した A だけが記録から外れ、B は env.json にも state にも残る
    expect(publishTargets(dir)['sakura-apprun']).toBeDefined()
    expect(envBuckets(dir)).toEqual([B])
    expect(stateKinds(dir).filter(k => k === 'bucket')).toHaveLength(1)
  })

  it('対照: 確認が A・B の両方を名指ししていれば、両方ふつうに消える・ok:true・行も消える・skippedBuckets は付かない', async () => {
    put([A, B])
    const reply = await go([pair(A), pair(B)])
    expect(h.calls).toEqual(expect.arrayContaining([...gone(A), ...gone(B)]))
    expect(reply.ok).toBe(true)
    expect(reply).not.toHaveProperty('skippedBuckets')
    expect(reply).not.toHaveProperty('remainingBuckets')
    expect(publishTargets(dir)['sakura-apprun']).toBeUndefined()
  })

  it('★★ 押し直し: 飛ばした B を、次の確認が名指しすれば消える（行が残っているので 🗑 から続きをやり直せる）', async () => {
    put([A, B])
    expect((await go([pair(A)])).ok).toBe(false)
    h.calls = []
    put([B]) // 1回目で A は消えた（記録から外れた）。B が残っている
    const again = await go([pair(B)])
    expect(again.ok).toBe(true)
    expect(h.calls).toEqual(expect.arrayContaining(gone(B)))
    expect(publishTargets(dir)['sakura-apprun']).toBeUndefined()
  })

  it('★★ state にだけある保存場所（設定から外したもの）も、見せていなければ飛ばす。見せていれば消す', async () => {
    put([A], { stateOnly: [B] })
    const first = await go([pair(A)])
    expect(touching(B)).toEqual([])
    expect(first.ok).toBe(false)
    expect(first.skippedBuckets).toEqual([B])
    h.calls = []
    put([A], { stateOnly: [B] })
    const both = await go([pair(A), pair(B)])
    expect(both.ok).toBe(true)
    expect(h.calls).toEqual(expect.arrayContaining([...gone(A), ...gone(B)]))
  })
})

describe('T-F2 共用型: 見せた保存場所が無い・形が違う → 保存場所への要求は0件（接続もしない）', () => {
  const OLD_KEY = 'perm-recorded'
  // 渡さない・文字列・prefix が無い・null・要素が null・空の配列。どれも「全部見せた」に倒さない（不明を肯定にしない）
  it.each([
    ['shownPlacements を渡さない', undefined],
    ['文字列', 'koto-data-a'],
    ['prefix が無い要素', [{ bucket: A }]],
    ['null', null],
    ['要素が null', [null]],
    ['空の配列', []],
    ['配列でないオブジェクト', { bucket: A, prefix: PREFIX }],
  ])('★★★ %s → 一覧も削除も接続も0件。ok:false・残りに A・行と記録の鍵と env.json は残る', async (_name, shown) => {
    put([A], { meta: { storagePermissionId: OLD_KEY } })
    h.permissions = [{ id: 'perm-old', displayName: permissionNameFor('myapp', 'apprun') }]
    const reply = await go(shown)

    expect(storageCalls(), '保存場所への要求が出ている').toEqual([])
    expect(reply.ok).toBe(false)
    expect(reply.remainingBuckets).toEqual([A])
    expect(reply.skippedBuckets).toEqual([A])
    expect(reply.message).toContain(SKIP_UNNAMED(A))
    expect(publishTargets(dir)['sakura-apprun']).toBeDefined()
    expect(envBuckets(dir)).toEqual([A])
    expect(stateMeta(dir).storagePermissionId, '鍵を無効にしていないので、記録の鍵は残す').toBe(OLD_KEY)
  })
})

describe('T-F3 共用型: 同じバケットで prefix が違えば飛ばす', () => {
  it('★★★ 見せたのは別の prefix → A への要求0件・ok:false・「確認のあとで…変わった」', async () => {
    put([A])
    const reply = await go([pair(A, 'projects/other/')])
    expect(storageCalls()).toEqual([])
    expect(reply.ok).toBe(false)
    expect(reply.skippedBuckets).toEqual([A])
    expect(reply.message).toContain(SKIP_CHANGED(A))
  })
})

describe('T-F4 共用型: 見せたほうが多い → ふつうに消える', () => {
  it('★★ 確認は A・B を名指ししたが、いまの記録は A だけ → A だけ消す・B への要求0件・ok:true', async () => {
    put([A])
    const reply = await go([pair(A), pair(B)])
    expect(h.calls).toEqual(expect.arrayContaining(gone(A)))
    expect(touching(B)).toEqual([])
    expect(reply.ok).toBe(true)
    expect(reply).not.toHaveProperty('skippedBuckets')
    expect(publishTargets(dir)['sakura-apprun']).toBeUndefined()
  })
})

describe('T-F7 共用型: 飛ばした分があるとき、鍵は押し直しで片づける', () => {
  const REC = 'perm-recorded'

  it('★★★ 名前での鍵の一括の無効化はしない（listPermissions も deletePermission perm-old も0件）。対照: 全部見せれば、一括の無効化が走る', async () => {
    put([A, B], { meta: { storagePermissionId: REC } })
    h.permissions = [{ id: 'perm-old', displayName: permissionNameFor('myapp', 'apprun') }]
    const reply = await go([pair(A)])
    expect(reply.ok).toBe(false)
    expect(h.calls).not.toContain('listPermissions')
    expect(h.calls).not.toContain('deletePermission perm-old')
    // 対照（同じ並び・全部見せる）
    resetHarness()
    put([A, B], { meta: { storagePermissionId: REC } })
    h.permissions = [{ id: 'perm-old', displayName: permissionNameFor('myapp', 'apprun') }]
    expect((await go([pair(A), pair(B)])).ok).toBe(true)
    expect(h.calls).toContain('listPermissions')
    expect(h.calls).toContain('deletePermission perm-old')
  })

  it('★★★ 記録の鍵は、実際に片づけた最初の1件に渡る。先頭の A を見せていなければ、B を消した直後に1回だけ無効にする（A には触れない）', async () => {
    put([A, B, C], { meta: { storagePermissionId: REC } })
    const reply = await go([pair(B), pair(C)])
    expect(reply.ok).toBe(false)
    expect(reply.skippedBuckets).toEqual([A])
    expect(touching(A)).toEqual([])
    const at = (c: string) => h.calls.indexOf(c)
    expect(h.calls.filter(c => c === `deletePermission ${REC}`)).toHaveLength(1)
    expect(at(`deletePermission ${REC}`)).toBeGreaterThan(at(`deleteBucket ${B}`)) // 鍵はバケットを消したあと
    expect(at(`deletePermission ${REC}`)).toBeLessThan(at(`listAllKeys ${C}`)) // 2件目には渡さない
    expect(h.calls.filter(c => c.startsWith('deletePermission '))).toEqual([`deletePermission ${REC}`])
  })
})

describe('残りの数え方（remainingBuckets）: 止まった1件・その後ろの未着手・飛ばした分の順。重ならない', () => {
  it('★★ A は消え、B の一覧で止まり、C は見せていない・D は未着手 → 残りは B・D・C（A は入らない）。D と C への要求は0件', async () => {
    put([A, B, C, D])
    h.fail[`listAllKeys ${B}`] = 'throw'
    const reply = await go([pair(A), pair(B), pair(D)])
    expect(reply.ok).toBe(false)
    expect(reply.remainingBucket).toBe(B)
    expect(reply.remainingBuckets).toEqual([B, D, C])
    expect(reply.skippedBuckets).toEqual([C])
    expect(touching(A)).toHaveLength(3)
    expect(touching(C)).toEqual([])
    expect(touching(D)).toEqual([])
    expect(reply.message).toContain('テスト用の失敗')
    expect(reply.message).toContain(SKIP_CHANGED(C))
    expect(reply.message).toContain(`保存場所『${B}』『${D}』『${C}』が残っています`)
    expect(envBuckets(dir)).toEqual([B, C, D]) // 消えた A だけが外れる
  })

  it('保存場所に接続できない回: 全件が残る（見せた分・飛ばした分とも）。接続できない文と、飛ばした文の両方が出る', async () => {
    put([A, B])
    h.fail.connect = 'throw'
    const reply = await go([pair(A)])
    expect(reply.ok).toBe(false)
    expect(reply.remainingBuckets).toEqual([A, B])
    expect(reply.skippedBuckets).toEqual([B])
    expect(reply.message).toContain('接続できないため')
    expect(reply.message).toContain(SKIP_CHANGED(B))
    expect(touching(A)).toEqual([])
  })
})
