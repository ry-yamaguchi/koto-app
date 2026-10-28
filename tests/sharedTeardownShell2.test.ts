import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 共用型の破棄 cloud:teardown の run（設計書 10.7.12 の C・後半）─────────────────────────────
//   C-9 鍵の無効化に失敗 / C-10 残した保存場所・env.json / C-11 押し直し / C-12 残す規則 / C-13 鍵（保存場所0件・一括の無効化）
//   C-14 例外（投げ直さない・アプリを消した分の state は保存する）
// 前半（断る回・アプリ・保存場所の失敗・レジストリ・公開の記録）は sharedTeardownShell.test.ts。
import { A, B, APP, OK_AUTH, REGISTRY_ROW, bucketRef, h, resetHarness, newProjectDir, setup, envBuckets, stateKinds, stateMeta, writePublishRecord, publishTargets } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'

/** applyPlan に渡されたプランの件数（空のプランでも呼ばれることを見る）。 */
const applied = vi.hoisted(() => [] as number[])

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))
vi.mock('../src/main/cloud/apply', async (orig) => {
  const real = await orig<any>()
  return { ...real, applyPlan: async (o: any) => { applied.push(o.plan.actions.length); return real.applyPlan(o) } }
})

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { summarizeResult, resetProjectOpsForTests } from '../src/main/projectOps'
import { toTeardownView } from '../src/shared/teardownResult'

registerCloudHandlers({} as any)
// 画面の代わりに、確認で見せた保存場所（記録から作る）を足して渡す（0.6.24 F。main は見せたものだけを消す）
const teardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const teardownRecord = h.handlers.get('cloud:teardownRecord')!
const EVENT = {}
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const KEY_LINE = '⚠️ 保存場所のアクセスキーを無効にできませんでした'
/** 案内（段階3A・keyRevokeGuide）。名前はこのテストのプロジェクト（myapp）の共用型の鍵。文言は書き下す（関数を通すと同語反復になる）。 */
const KEY_GUIDE = 'さくらのクラウドのコントロールパネルで、オブジェクトストレージのパーミッション「koto-myapp」を削除してください（アクセスキーも一緒に無効になります）。'
const KEY_LINE_WITH_GUIDE = `${KEY_LINE}。${KEY_GUIDE}`
const FOREIGN = 'projects/other/data.json' // ほかのプロジェクトが同じ保存場所を使っている印

let dir = ''
beforeEach(() => { resetProjectOpsForTests(); resetHarness(); applied.length = 0; dir = newProjectDir() })
afterEach(() => {
  Object.defineProperty(h, 'creds', { value: { token: 'TEST-TOKEN', secret: 'TEST-SECRET' }, writable: true, configurable: true })
  for (const f of ['env.json', 'state.json']) { try { fs.chmodSync(path.join(dir, '.sakura-cloud', f), 0o644) } catch { /* 無いこともある */ } }
  fs.rmSync(dir, { recursive: true, force: true })
})
const isRoot = process.getuid?.() === 0

describe('C-9 鍵の無効化に失敗: ok:true のまま、その場にも記録にも警告が出る。記録の鍵の ID は残す', () => {
  it('deletePermission が投げる → executed に ⚠️ の行。summarizeResult と toTeardownView の警告の両方にその行。meta に ID が残る', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], meta: { storagePermissionId: 'perm-1' } })
    h.fail['deletePermission perm-1'] = 'throw'

    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(reply.executed).toContain(KEY_LINE_WITH_GUIDE)
    expect(summarizeResult(reply).warnings).toContain(KEY_LINE_WITH_GUIDE)
    expect(toTeardownView('sakura-apprun', reply).warnings).toContain(KEY_LINE_WITH_GUIDE)
    expect(stateMeta(dir)).toMatchObject({ storagePermissionId: 'perm-1' })   // 辿れない鍵を作らない（押し直しの手がかり）
  })

  it('無効にできたとき → 警告なし・meta から ID が落ちる', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], meta: { storagePermissionId: 'perm-1' } })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toContain('deletePermission perm-1')
    expect(reply.executed.filter((l: string) => l.startsWith('⚠️'))).toEqual([])
    expect(stateMeta(dir)).toBeUndefined()
  })
})

describe('C-10 バケットごと消した保存場所は env.json からも消える。残した保存場所は env.json にも state にも残る', () => {
  it('ほかのプロジェクトが使っている保存場所は、データだけを消してバケットは残す → keptBucketName(s)・env.json と state に残る', async () => {
    setup(dir, { env: [A, B], resources: [APP, bucketRef(A), bucketRef(B)] })
    h.keys = [`projects/myapp/data.json`, FOREIGN]
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls.some(c => c.startsWith('deleteBucket '))).toBe(false)
    expect(h.calls).toContain(`deleteKeys ${A}`)
    expect(reply.ok).toBe(true)
    expect(reply.keptBucketName).toBe(A)
    expect(reply.keptBucketNames).toEqual([A, B])
    expect(envBuckets(dir)).toEqual([A, B])
    expect(stateKinds(dir)).toEqual(['bucket', 'bucket'])
    expect(summarizeResult(reply).warnings.join('\n')).toContain('月額')      // 残れば月額も続く＝警告になる
  })

  it('1件は消え、1件は残る → 消えたほうだけ env.json と state から外れる', async () => {
    setup(dir, { env: [A, B], resources: [APP, bucketRef(A), bucketRef(B)] })
    h.keysByBucket = { [A]: ['projects/myapp/data.json'], [B]: ['projects/myapp/data.json', FOREIGN] }
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.keptBucketNames).toEqual([B])
    expect(envBuckets(dir)).toEqual([B])
    expect(stateKinds(dir)).toEqual(['bucket'])
  })

  it('env.json に書き込めない → ok:true のまま ⚠️ の行（「保存場所を用意する」からやり直す）。env.json は残る', async () => {
    if (isRoot) return
    setup(dir, { env: [A], resources: [APP, bucketRef(A)] })
    fs.chmodSync(path.join(dir, '.sakura-cloud', 'env.json'), 0o444)
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(reply.executed.some((l: string) => l.startsWith('⚠️ 保存場所の記録（公開の設定・env.json）は残しています'))).toBe(true)
    expect(envBuckets(dir)).toEqual([A])
    expect(stateKinds(dir)).toEqual([])
  })
})

describe('C-11 押し直し: 誤警告を出さない・レジストリの選択の残り方', () => {
  it('レジストリを消し終えて保存場所で止まった回 → 記録に名前もアプリも無い。押し直しは保存場所の削除だけ。keptRegistryUnnamed は付かない', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], meta: { registryName: 'myreg' } })
    h.registryRows = [REGISTRY_ROW]
    h.fail[`listAllKeys ${A}`] = 'throw'
    const first = await teardown(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    expect(first).toMatchObject({ ok: false, appDeleted: true, remainingBuckets: [A] })
    expect(first.message).toContain('もう一度 🗑 破棄を押すと、保存場所の削除だけをやり直します。')
    expect(first.message).not.toContain('選択も、もう一度出ます')
    expect(first.keptRegistryName).toBeUndefined()
    expect(stateMeta(dir)?.registryName).toBeUndefined()              // 消えたレジストリは記録に残らない

    const rec = (await teardownRecord(EVENT, dir)).record
    expect(rec).toMatchObject({ appNames: [], registryName: null, placements: [{ bucket: A }] })

    h.fail = {}
    const second = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(second.ok).toBe(true)
    expect(second.keptRegistryUnnamed).toBeUndefined()                // 公開した形跡（アプリ）が無い回は、レジストリの話をしない
    expect(second.keptRegistryName).toBeUndefined()
  })

  it('レジストリを残して保存場所で止まった回 → registryName が記録に残り、押し直しにも選択が出る。message もそう言う', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], meta: { registryName: 'myreg' } })
    h.fail[`listAllKeys ${A}`] = 'throw'
    const first = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(first.ok).toBe(false)
    expect(first.keptRegistryName).toBe('myreg')
    expect(first.message).toContain('もう一度 🗑 破棄を押すと、保存場所の削除をやり直せます（コンテナレジストリを消すかどうかの選択も、もう一度出ます）。')
    expect(first.message).not.toContain('保存場所の削除だけをやり直します')
    expect((await teardownRecord(EVENT, dir)).record).toMatchObject({ appNames: [], registryName: 'myreg' })
  })

  it('アプリがあって記録にレジストリ名が無い回（v0.2.94 以前）だけ keptRegistryUnnamed が付く。アプリが無い回（保存場所だけ）には付かない', async () => {
    setup(dir, { env: [], resources: [APP] })
    expect((await teardown(EVENT, dir, OK_AUTH, GO)).keptRegistryUnnamed).toBe(true)

    resetHarness()
    setup(dir, { env: [A], resources: [bucketRef(A)] })               // アプリは無く、保存場所だけ
    const onlyStorage = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(onlyStorage.ok).toBe(true)
    expect(onlyStorage.keptRegistryUnnamed).toBeUndefined()
    expect(onlyStorage.keptRegistryName).toBeUndefined()
  })
})

describe('C-12 レジストリを残す規則: 消すのは true を選んだときだけ。それ以外は残る（アプリの段で失敗した回も）', () => {
  it('deleteRegistry が省略・false・\'true\'・1 → アプリの段で失敗しても keptRegistryName', async () => {
    for (const v of [undefined, false, 'true', 1]) {
      setup(dir, { env: [], resources: [APP], meta: { registryName: 'myreg' } })
      h.fail['deleteApp app-1'] = 'http500'
      const reply = await teardown(EVENT, dir, OK_AUTH, { confirmed: true, registryName: 'myreg', ...(v === undefined ? {} : { deleteRegistry: v }) })
      expect(reply.ok, String(v)).toBe(false)
      expect(reply.keptRegistryName, String(v)).toBe('myreg')
    }
  })

  it('true を選んだ回は、レジストリの削除に失敗しても（一覧が取れない）keptRegistry* を付けない。失敗は executed の※が言う', async () => {
    setup(dir, { env: [], resources: [APP], meta: { registryName: 'myreg' } })
    h.fail.listContainerRegistries = 'http500'
    const reply = await teardown(EVENT, dir, OK_AUTH, { confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    expect(reply.ok).toBe(true)
    expect(reply.keptRegistryName).toBeUndefined()
    expect(reply.keptRegistryUnnamed).toBeUndefined()
    expect(reply.executed.some((l: string) => l.startsWith('※ レジストリ『myreg』を削除できたか確認できませんでした'))).toBe(true)
    expect(stateMeta(dir)).toMatchObject({ registryName: 'myreg' })     // 消せたと確かめられないので、記録に名前を残す
  })
})

describe('C-13 鍵: 保存場所が0件でも記録の鍵は無効にする。一括の無効化はアプリがあった回だけ', () => {
  it('保存場所0件・記録の鍵あり → 接続して deletePermission。一括の無効化（listPermissions）はしない。meta から ID が落ちる', async () => {
    setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: 'perm-1' } })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toEqual(['deleteApp app-1', 'connect', 'deletePermission perm-1', 'dispose'])
    expect(reply.ok).toBe(true)
    expect(stateMeta(dir)).toBeUndefined()
  })

  it('保存場所0件・記録の鍵の無効化に失敗（deletePermission が投げる・接続できない）→ ⚠️ の行と meta の ID', async () => {
    for (const failing of ['deletePermission perm-1', 'connect']) {
      resetHarness()
      setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: 'perm-1' } })
      h.fail[failing] = 'throw'
      const reply = await teardown(EVENT, dir, OK_AUTH, GO)
      expect(reply.ok, failing).toBe(true)
      expect(reply.executed.some((l: string) => l.startsWith(KEY_LINE)), failing).toBe(true)
      expect(stateMeta(dir), failing).toMatchObject({ storagePermissionId: 'perm-1' })
    }
  })

  it('保存場所も記録の鍵も無い → 保存場所へ接続しない', async () => {
    setup(dir, { env: [], resources: [APP] })
    await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toEqual(['deleteApp app-1'])
  })

  it('名前による一括の無効化: アプリがあった回は listPermissions が走り同名の鍵を無効にする。アプリが無い回（保存場所だけ）は走らず、同名の別プロジェクトの鍵に触れない', async () => {
    h.permissions = [{ id: 'perm-same', displayName: 'koto-myapp' }, { id: 'perm-other', displayName: 'koto-other' }]
    setup(dir, { env: [A], resources: [APP, bucketRef(A)] })
    await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toContain('listPermissions')
    expect(h.calls).toContain('deletePermission perm-same')
    expect(h.calls).not.toContain('deletePermission perm-other')       // 名前が違う鍵には触れない

    resetHarness()
    h.permissions = [{ id: 'perm-same', displayName: 'koto-myapp' }]
    setup(dir, { env: [A], resources: [bucketRef(A)] })               // アプリは無い（保存場所だけ）
    await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).not.toContain('listPermissions')
    expect(h.calls.some(c => c.startsWith('deletePermission '))).toBe(false)
  })
})

describe('C-14 例外: 投げ直さない。アプリを消した分の state は保存する', () => {
  it('アプリが0件でも applyPlan は空のプランで1回呼ばれる', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)] })
    await teardown(EVENT, dir, OK_AUTH, GO)
    expect(applied).toEqual([0])
    applied.length = 0
    resetHarness()
    setup(dir, { env: [], resources: [APP] })
    await teardown(EVENT, dir, OK_AUTH, GO)
    expect(applied).toEqual([1])
  })

  it('保存場所の後始末（切断）で投げられても、投げ直さず ok:false・全件が残り・消えたアプリは記録に残らない・公開の記録は残る', async () => {
    setup(dir, { env: [A, B], resources: [APP, bucketRef(A)] })
    writePublishRecord(dir, { 'sakura-apprun': { publishedAt: '2026-10-01T00:00:00.000Z', url: 'https://x.test' } })
    h.fail.dispose = 'throw'
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply).toMatchObject({ ok: false, appDeleted: true, remainingBuckets: [A, B] })
    expect(reply.message).toContain('削除できませんでした')
    expect(stateKinds(dir)).toEqual(['bucket'])
    expect(publishTargets(dir)['sakura-apprun']).toBeDefined()
  })

  it('記録（state.json）を保存できない → ok:false・「記録を保存できませんでした」。投げ直さない', async () => {
    if (isRoot) return
    setup(dir, { env: [], resources: [APP] })
    fs.chmodSync(path.join(dir, '.sakura-cloud', 'state.json'), 0o444)
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(false)
    expect(reply.appDeleted).toBe(true)
    expect(reply.message).toContain('記録を保存できませんでした。もう一度 🗑 破棄を押すと続きからやり直せます。')
  })

  it('最後の防波堤: 想定外の例外（認証情報の読みが投げる）でも投げ直さず ok:false', async () => {
    setup(dir, { env: [], resources: [APP] })
    Object.defineProperty(h, 'creds', { get() { throw new Error('想定外のテスト用の失敗') }, configurable: true })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply).toMatchObject({ ok: false, message: '想定外のテスト用の失敗' })
    expect(h.calls).toEqual([])
  })
})
