import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── T-F1・F2・F3・F4・F5・F7（専有型）0.6.24 F-5: 本物の apprunDedicated:teardown に、偽の専有型サーバ・偽の保存場所を流す ──────────────
// 仕様: docs/v0624-aefi-spec.md の F-4・F-5・T-F1〜F5・F7・6章 U5。「見せていない保存場所への要求が0件」を、呼ばれた要求の一覧（h.storageCalls）で固定する（掟10）。
//   ・専有型の手順6・📡 の 🗑 は、確認で見せた保存場所（名前と prefix の組。shownPlacements）と一致するものだけを消す
//   ・見せていないもの（確認のあとで足された・名前を挙げられなかった・値の形が違う・**渡さない**）は、外へ1本も要求を出さない（接続もしない）。ok:false・残りに入る・行は残る
//     （計算資源〔クラスタ〕はそれより前に消えている。残りは publish.apprunDedicated.storageLeftoverBuckets の印に書く＝押し直しの道）
//   ・残りは main が数え直さない（以前は placements.slice(片づいた件数)）。teardownStorageForProject が返す remainingBuckets（止まった1件・後ろの未着手・飛ばした分の順）をそのまま使う
//   ・飛ばした分があるとき、名前での鍵の一括の無効化はしない（押し直しで行う）。記録の鍵は、実際に片づけた最初の1件に渡る
//   ・U5 で `shown` を必須にした。渡さない形（従来どおり全件を消す道）は無い（関数そのものの試験は tests/storageForTargetShown.test.ts）
// 共用型は tests/sharedShownTeardown.test.ts、HANAMII は tests/hanamiiShownTeardown.test.ts。純関数は tests/storageSelection.test.ts。
// 偽物は tests/dedicatedTeardownShellMocks.ts、下ごしらえは tests/dedicatedTeardownShellHarness.ts。期待の文は書き下す。

vi.mock('electron', async () => (await import('./dedicatedTeardownShellMocks')).electronMock())
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./dedicatedTeardownShellMocks')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => (await import('./dedicatedTeardownShellMocks')).applyMock(await orig()))
vi.mock('../src/main/publishMetaFs', async (orig) => (await import('./dedicatedTeardownShellMocks')).publishMetaMock(await orig()))

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { h } from './dedicatedTeardownShellMocks'
import { AUTH, EVENT, PREFIX, setupEach, teardownEach, startServer, CLUSTER_GONE, project, targetsOf } from './dedicatedTeardownShellHarness'

registerApprunDedicatedHandlers({} as any)
// 画面を通さず本物の main を直接呼ぶ（shownPlacements は各試験が自分で書く）
const teardown = h.handlers.get('apprunDedicated:teardown')!

const A = 'koto-data-a'
const B = 'koto-data-b'
const C = 'koto-data-c'
const D = 'koto-data-d'
const ROW = 'sakura-apprun-dedicated'
const pair = (bucket: string, prefix = PREFIX) => ({ bucket, prefix })
const SKIP_CHANGED = (b: string) => `確認のあとで保存場所の記録が変わったため、保存場所『${b}』は削除していません。`
const SKIP_UNNAMED = (b: string) => `確認で保存場所の名前を挙げられなかったため、保存場所『${b}』は削除していません。`
const DELETE_CLUSTER = 'DELETE /clusters/c1'

let dir = ''
beforeEach(() => { dir = setupEach() })
afterEach(() => { teardownEach() })

/** shownPlacements を渡さない（undefined）か、渡す。 */
const go = (shownPlacements?: unknown) =>
  teardown(EVENT, dir, AUTH, { confirmed: true, ...(shownPlacements === undefined ? {} : { shownPlacements }) })
/** 偽のさくらの専有型サーバ（クラスタだけ）を立てて破棄する。返り値は [結果, さくらへ出た要求]。 */
const run = async (shownPlacements?: unknown) => {
  const calls = await startServer(CLUSTER_GONE)
  return [await go(shownPlacements), calls] as const
}

/** そのバケットへ出た要求（一覧・データ削除・バケット削除）。 */
const touching = (bucket: string) => h.storageCalls.filter(c => c === `listAllKeys ${bucket}` || c === `deleteKeys ${bucket}` || c === `deleteBucket ${bucket}`)
const gone = (bucket: string) => [`listAllKeys ${bucket}`, `deleteKeys ${bucket}`, `deleteBucket ${bucket}`]
const rowExists = (): boolean => targetsOf().includes(ROW)
const envBuckets = (): string[] => JSON.parse(fs.readFileSync(path.join(dir, '.sakura-cloud', 'env.json'), 'utf-8'))?.persistence?.objectStorage?.map((b: any) => b.bucket) ?? []
const marks = () => { const rec = readApprunDedicatedFs(dir); return { one: rec.storageLeftoverBucket ?? null, many: rec.storageLeftoverBuckets ?? null } }

describe('T-F1 専有型: 確認で見せていない保存場所への要求は0件', () => {
  it('★★★ 確認は A だけ名指しし、そのあとで env.json に B が足された → 要求は A だけ・B は0件・ok:false・残りに B・行は残り、印に B', async () => {
    project({ storage: [A, B] }) // 確認のあとの記録（B が足されている）
    const [r, calls] = await run([pair(A)])

    expect(calls).toContain(DELETE_CLUSTER) // 計算資源（クラスタ）はそれより前に消えている
    expect(h.storageCalls).toEqual(expect.arrayContaining(gone(A)))
    expect(touching(B), 'B への要求が出ている（見せていないのに）').toEqual([])
    expect(h.storageCalls.filter(c => c.endsWith(` ${B}`))).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.remainingBuckets).toEqual([B])
    expect(r.skippedBuckets, '見せていなくて飛ばした分を、共用型と同じ印で返す（0.6.24 R1-d）').toEqual([B])
    expect(r.remaining.storageBucket).toBe(B)
    expect(r.message).toContain(SKIP_CHANGED(B))
    expect(r.message).toContain('\n保存場所『koto-data-b』が残っています（消すまで月額が続きます）。')
    // 押し直しの道: 行が残り、残っている B が印に書かれる（先頭の1件と全件を一緒に）。消した A だけが env.json から外れる
    expect(rowExists(), '見せていない保存場所が残っているのに行が消えた').toBe(true)
    expect(marks()).toEqual({ one: B, many: [B] })
    expect(envBuckets()).toEqual([B])
  })

  it('対照: 確認が A・B の両方を名指ししていれば、両方ふつうに消える・ok:true・行も印も消える', async () => {
    project({ storage: [A, B] })
    const [r] = await run([pair(A), pair(B)])
    expect(h.storageCalls).toEqual(expect.arrayContaining([...gone(A), ...gone(B)]))
    expect(r.ok).toBe(true)
    expect(r.remainingBuckets).toBeUndefined()
    expect(r.skippedBuckets).toBeUndefined()
    expect(rowExists(), '全部片づいたのに行が残っている').toBe(false)
    expect(marks()).toEqual({ one: null, many: null })
  })

  it('★★ 押し直し: クラスタはもう無い。次の確認が B を名指しすれば消え、行と印が消える（A への要求は0件のまま）', async () => {
    project({ storage: [A, B] })
    expect((await run([pair(A)]))[0].ok).toBe(false)
    h.storageCalls = []
    const again = await go([pair(B)])
    expect(again.ok).toBe(true)
    expect(h.storageCalls).toEqual(expect.arrayContaining(gone(B)))
    expect(touching(A)).toEqual([])
    expect(rowExists(), '全部片づいたのに行が残っている').toBe(false)
    expect(marks()).toEqual({ one: null, many: null })
  })
})

describe('T-F2 専有型: 見せた保存場所が無い・形が違う・渡さない → 保存場所への要求は0件（接続もしない）', () => {
  // 渡さない・文字列・prefix が無い・null・要素が null・空の配列（確認が名前を挙げられなかった回＝'call'）・配列でないオブジェクト。
  // どれも「全部見せた」に倒さない（不明を肯定にしない）。**渡さない（undefined）が、U3 で残した従来どおり全件を消す道だった**
  it.each([
    ['shownPlacements を渡さない', undefined],
    ['文字列', A],
    ['prefix が無い要素', [{ bucket: A }]],
    ['null', null],
    ['要素が null', [null]],
    ['空の配列', []],
    ['配列でないオブジェクト', { bucket: A, prefix: PREFIX }],
  ])('★★★ %s → 接続も一覧も削除も鍵の一覧も0件。ok:false・残りに A・行は残り、印に A', async (_name, shown) => {
    project({ storage: [A] })
    const [r, calls] = await run(shown)

    expect(h.storageCalls, '保存場所への要求が出ている（アダプタを作ってはいけない）').toEqual([])
    expect(calls).toContain(DELETE_CLUSTER) // クラスタは消えている
    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.remainingBuckets).toEqual([A])
    expect(r.remaining.storageBucket).toBe(A)
    expect(r.message).toContain(SKIP_UNNAMED(A))
    expect(r.message).toContain('\n保存場所『koto-data-a』が残っています（消すまで月額が続きます）。')
    expect(rowExists(), '見せていない保存場所が残っているのに行が消えた').toBe(true)
    expect(marks()).toEqual({ one: A, many: [A] })
    expect(envBuckets()).toEqual([A])
  })

  it('★★★ 渡さないで2件ある回 → 2件とも残りに（A・B）。要求は0件', async () => {
    project({ storage: [A, B] })
    const [r] = await run()
    expect(h.storageCalls).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([A, B])
    expect(r.message).toContain('保存場所『koto-data-a』『koto-data-b』は削除していません。')
    expect(marks()).toEqual({ one: A, many: [A, B] })
  })
})

describe('T-F3 専有型: 同じバケットで prefix が違えば飛ばす', () => {
  it('★★★ 見せたのは別の prefix → A への要求0件・ok:false・「確認のあとで…変わった」', async () => {
    project({ storage: [A] })
    const [r] = await run([pair(A, 'projects/other/')])
    expect(h.storageCalls).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([A])
    expect(r.message).toContain(SKIP_CHANGED(A))
    expect(marks()).toEqual({ one: A, many: [A] })
  })
})

describe('T-F4 専有型: 見せたほうが多い → ふつうに消える', () => {
  it('★★ 確認は A・B を名指ししたが、いまの記録は A だけ → A だけ消す・B への要求0件・ok:true・行が消える', async () => {
    project({ storage: [A] })
    const [r] = await run([pair(A), pair(B)])
    expect(h.storageCalls).toEqual(expect.arrayContaining(gone(A)))
    expect(touching(B)).toEqual([])
    expect(r.ok).toBe(true)
    expect(rowExists()).toBe(false)
  })
})

describe('T-F5 専有型: 残りは数え直さない。teardownStorageForProject の remainingBuckets をそのまま使う', () => {
  it('★★★ env が [A, B]、見せたのが [B] → B だけ消え、残りは [A]（B は入らない）。A への要求は0件・印も [A]', async () => {
    project({ storage: [A, B] })
    const [r] = await run([pair(B)])

    expect(touching(A)).toEqual([])
    expect(h.storageCalls).toEqual(expect.arrayContaining(gone(B)))
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets, '片づけた B を残りに数えた（片づいた件数で並びを切っている）').toEqual([A])
    expect(r.remaining.storageBucket).toBe(A)
    expect(r.message).toContain(SKIP_CHANGED(A))
    expect(r.message).toContain('\n保存場所『koto-data-a』が残っています（消すまで月額が続きます）。')
    expect(r.message).not.toContain('『koto-data-b』が残っています')
    expect(marks()).toEqual({ one: A, many: [A] })
    expect(envBuckets()).toEqual([A]) // 消えた B だけが外れる
  })

  it('★★★ A は消え、B の一覧で止まり、C は見せていない・D は未着手 → 残りは B・D・C（A は入らない）。D と C への要求は0件。印も同じ並び', async () => {
    project({ storage: [A, B, C, D] })
    h.listThrowsFor = new Set([B])
    const [r] = await run([pair(A), pair(B), pair(D)])

    expect(r.ok).toBe(false)
    expect(r.appDeleted).toBe(true)
    expect(r.remaining.storageBucket).toBe(B)
    expect(r.remainingBuckets).toEqual([B, D, C])
    expect(r.skippedBuckets, '飛ばしたのは見せていない C だけ（止まった B と未着手の D は入らない）').toEqual([C])
    expect(touching(A)).toHaveLength(3)
    expect(touching(C)).toEqual([])
    expect(touching(D)).toEqual([])
    expect(r.message).toContain('一覧を取得できませんでした（テスト）')
    expect(r.message).toContain(SKIP_CHANGED(C))
    expect(r.message).toContain('\n保存場所『koto-data-b』『koto-data-d』『koto-data-c』が残っています（消すまで月額が続きます）。')
    expect(marks()).toEqual({ one: B, many: [B, D, C] })
    expect(envBuckets()).toEqual([B, C, D]) // 消えた A だけが外れる
  })

  it('★★ 見せたものが全部片づき、見せていない C だけが残る → 残りは C だけ（片づけた分を残りに数えない）', async () => {
    project({ storage: [A, B, C] })
    const [r] = await run([pair(A), pair(B)])
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([C])
    expect(r.skippedBuckets).toEqual([C])
    expect(touching(C)).toEqual([])
    expect(marks()).toEqual({ one: C, many: [C] })
  })

  it('対照（従来の形）: 全件を見せて、A の一覧で止まる → 残りは A・B（止まった1件と後ろの未着手）。飛ばした分は無いので skippedBuckets は付かない', async () => {
    project({ storage: [A, B] })
    h.listThrowsFor = new Set([A])
    const [r] = await run([pair(A), pair(B)])
    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([A, B])
    expect(r.skippedBuckets).toBeUndefined()
    expect(touching(B)).toEqual([])
    expect(r.message).not.toContain('削除していません。')
    expect(marks()).toEqual({ one: A, many: [A, B] })
  })
})

describe('T-F7 専有型: 飛ばした分があるとき、鍵は押し直しで片づける。記録の鍵は実際に片づけた最初の1件に渡る', () => {
  const REC = { clusterID: 'c1', storagePermissionId: 'perm-rec' }

  it('★★★ 名前での鍵の一括の無効化はしない（listPermissions が0件）。記録の鍵は、見せた B を消したあとに B へ渡る。A への要求は0件', async () => {
    project({ record: REC, storage: [A, B] })
    const [r] = await run([pair(B)])

    expect(r.ok).toBe(false)
    expect(h.storageCalls).not.toContain('listPermissions')
    const calls = h.storageCalls
    expect(calls.indexOf('deletePermission perm-rec'), '記録の鍵が無効にされていない').toBeGreaterThan(-1)
    expect(calls.indexOf('deletePermission perm-rec')).toBeGreaterThan(calls.indexOf(`deleteBucket ${B}`)) // 順序: バケットのあと
    expect(touching(A)).toEqual([])
  })

  it('対照: 全部見せれば、一括の無効化が走り（listPermissions）、記録の鍵は消えて記録から外れる', async () => {
    project({ record: REC, storage: [A, B] })
    const [r] = await run([pair(A), pair(B)])
    expect(r.ok).toBe(true)
    expect(h.storageCalls).toContain('listPermissions')
    expect(h.storageCalls.filter(c => c === 'deletePermission perm-rec')).toHaveLength(1) // 2件目に渡して二重に警告しない
    expect(readApprunDedicatedFs(dir).storagePermissionId ?? null).toBeNull()
  })
})
