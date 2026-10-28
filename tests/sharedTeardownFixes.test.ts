import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階2の検分の指摘（2026-10-11）を、本物の main に偽の client・偽の保存場所を流して固定する ──────────────────────
//   F1  公開の設定（env.json）がまだ無いプロジェクトで 🗑 を押す → 失敗の枠でなく「破棄するものはありません」（親の判断 4。S1・S2・S4）
//   F8  HANAMII・専有型の破棄が消したバケットは、共用型の記録（state.json）からも外れる（あとの共用型の破棄が「設定から外した保存場所」と数えない）
//   F3  保存場所に触れなかった成功の回は、「保存場所にあった、このプロジェクトのデータを削除しました」と言わない
//   F4  applyPlan が積んだ対応外の処理（skipped）は、成功の回の返り値と処理の記録に残す（設計書 10.7.6）
//   F10 アプリを消す段で失敗した回も、途中まで起きたこと（消えたアプリ）を state.json に残す（2026-08-14 の 404 の形。掟10）
import { A, B, APP, OK_AUTH, bucketRef, h, resetHarness, newProjectDir, setup, envBuckets, stateKinds } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'
import type { ResourceRef } from '../src/main/cloud/state'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { forgetDeletedBuckets } from '../src/main/cloud/storageForTarget'
import { getOps, resetProjectOpsForTests } from '../src/main/projectOps'
import { runTeardownFlow, electronFlowDeps } from '../src/renderer/teardown/flow'
import { sharedTeardownSpec, SHARED_KEY_MISSING_MESSAGE } from '../src/renderer/teardown/targets/shared'

registerCloudHandlers({} as any)
// 画面の代わりに、確認で見せた保存場所（記録から作る）を足して渡す（0.6.24 F。main は見せたものだけを消す）
const teardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const record = h.handlers.get('cloud:teardownRecord')!
const EVENT = {}
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const EMPTY_RECORD = { appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [], stateOnlyBuckets: [] }
const APP2: ResourceRef = { kind: 'apprun-app', id: 'app-2', stateful: false, key: 'apprun-app:myapp2' }
const REGISTRY: ResourceRef = { kind: 'registry', id: 'reg-1', stateful: false, key: 'registry:myreg' }
const STORAGE_DONE = '保存場所にあった、このプロジェクトのデータを削除しました。'

let dir = ''
const cloudFile = (f: string) => path.join(dir, '.sakura-cloud', f)
const readState = (): any => JSON.parse(fs.readFileSync(cloudFile('state.json'), 'utf-8'))
const writeState = (state: unknown) => { fs.mkdirSync(path.dirname(cloudFile('state.json')), { recursive: true }); fs.writeFileSync(cloudFile('state.json'), typeof state === 'string' ? state : JSON.stringify(state), 'utf-8') }

beforeEach(() => { resetProjectOpsForTests(); resetHarness(); dir = newProjectDir() })
afterEach(() => { delete (globalThis as any).window; fs.rmSync(dir, { recursive: true, force: true }) })

/** 画面（renderer）の流れが見る window。cloud.teardownRecord は本物の main の口に繋ぐ（記録の形も main が返したまま）。 */
function installWindow() {
  const calls = { teardown: [] as unknown[][], confirm: 0 }
  ;(globalThis as any).window = {
    electronAPI: {
      cloud: {
        teardownRecord: async (d: string) => record(EVENT, d),
        teardown: async (...a: unknown[]) => { calls.teardown.push(a); return { ok: true } },
      },
      storage: { placement: async () => ({ ok: true, placement: null, placements: [] }) },
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
      stageTiming: { estimates: async () => null },
      win: { setBusy: () => {} },
    },
    dispatchEvent: () => true,
  }
  return calls
}
const flowDeps = (calls: { confirm: number }) => electronFlowDeps(dir, sharedTeardownSpec, {
  confirm: async () => { calls.confirm++; return true },
  confirmWithChoices: async () => { calls.confirm++; return { confirmed: true, choices: {} } },
  keyMissingMessage: SHARED_KEY_MISSING_MESSAGE,
})

describe('F1 公開の設定（env.json）がまだ無いプロジェクトの 🗑', () => {
  it('★★★ env.json も state.json も無い → 読めなかったのではなく、空の記録（破棄するものが無い）。外への要求は0件', async () => {
    expect(await record(EVENT, dir)).toEqual({ ok: true, record: EMPTY_RECORD })
    expect(h.calls).toEqual([])
  })

  it('★★ state.json があっても何も記録していない（resources が空・レジストリ名も鍵も無い）→ 空の記録', async () => {
    writeState({ name: 'myapp', backend: 'apprun', resources: [], meta: { createdAt: '2026-08-14T00:00:00.000Z' } })
    expect(await record(EVENT, dir)).toEqual({ ok: true, record: EMPTY_RECORD })
  })

  it.each([
    ['アプリが記録にある', { name: 'myapp', backend: 'apprun', resources: [APP] }],
    ['保存場所が記録にある', { name: 'myapp', backend: 'apprun', resources: [bucketRef(A)] }],
    ['レジストリ名が記録にある', { name: 'myapp', backend: 'apprun', resources: [], meta: { registryName: 'myreg' } }],
    ['アクセスキーの ID が記録にある', { name: 'myapp', backend: 'apprun', resources: [], meta: { storagePermissionId: 'perm-1' } }],
    ['記録が JSON として読めない', '{ これは JSON ではない'],
  ])('★★★ env.json が無く、記録に消すものがある／読めない（%s）→ 空の記録に倒さず、読めなかったと言う（確認を出さず、消す手段も無い）', async (_name, state) => {
    writeState(state)
    expect(await record(EVENT, dir)).toEqual({ ok: false, message: 'env.json がありません' })
  })

  it('★★★ 端から端: 本物の main の記録を画面の流れに通すと、確認0・実行0・nothingToDo の中立の知らせ（失敗の枠ではない）', async () => {
    const calls = installWindow()
    const out = await runTeardownFlow(dir, sharedTeardownSpec, flowDeps(calls))
    expect(out).toMatchObject({ cancelled: false, nothingToDo: true, result: { ok: false, message: sharedTeardownSpec.words.nothingToDo } })
    expect(calls.confirm).toBe(0)
    expect(calls.teardown).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('★★ 端から端: env.json が無くて記録に消すものがあるときは、nothingToDo ではなく「記録を読めませんでした」の失敗', async () => {
    writeState({ name: 'myapp', backend: 'apprun', resources: [APP] })
    const calls = installWindow()
    const out = await runTeardownFlow(dir, sharedTeardownSpec, flowDeps(calls))
    expect('nothingToDo' in out).toBe(false)
    expect((out as any).result.message).toContain('破棄するものの記録を読めませんでした')
    expect((out as any).result.message).toContain('env.json がありません')
    expect(calls.confirm).toBe(0)
    expect(calls.teardown).toEqual([])
  })
})

describe('F8 HANAMII・専有型の破棄が消したバケットは、共用型の記録（state.json）からも外れる', () => {
  it('★★★ 外す前: env.json に無く state にある B は「設定から外した保存場所」として数えられる。外した後は数えない', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)] })
    expect(forgetDeletedBuckets(dir, [A])).toBe(true)
    expect(envBuckets(dir)).toEqual([])
    expect(stateKinds(dir)).toEqual(['apprun-app'])
    expect((await record(EVENT, dir)).record).toMatchObject({ appNames: ['myapp'], placements: [], stateOnlyBuckets: [] })
  })

  it('★★★ そのあとの共用型の破棄は、もう無いバケットを一覧しに行かない（保存場所への接続も0件）', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)] })
    forgetDeletedBuckets(dir, [A])
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toEqual(['deleteApp app-1'])
    expect(reply.ok).toBe(true)
    expect(stateKinds(dir)).toEqual([])
  })

  it('★★ 名前を挙げたバケットだけ外す（挙げていないバケットとアプリは残る）。name・backend・meta も変えない', async () => {
    setup(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B), APP], meta: { registryName: 'myreg', storagePermissionId: 'perm-1' } })
    forgetDeletedBuckets(dir, [A])
    expect(readState()).toEqual({
      name: 'myapp', backend: 'apprun', resources: [bucketRef(B), APP], meta: { registryName: 'myreg', storagePermissionId: 'perm-1' },
    })
    expect(envBuckets(dir)).toEqual([B])
  })

  it('★★ 外すのは種類が bucket のものだけ（アプリの id がバケット名と同じでも外さない）', async () => {
    setup(dir, { env: [A], resources: [{ ...APP, id: A }, bucketRef(A)] })
    forgetDeletedBuckets(dir, [A])
    expect(readState().resources).toEqual([{ ...APP, id: A }])
  })

  it('★★ 戻り値は env.json を書き換えたか（state にだけある B の記録を外しても、env.json に無ければ false。呼び手の「記録を残しています」の判断は変わらない）', async () => {
    setup(dir, { env: [], resources: [bucketRef(B), APP] })
    expect(forgetDeletedBuckets(dir, [B])).toBe(false)
    expect(stateKinds(dir)).toEqual(['apprun-app'])
  })

  it('★ 空の一覧は何も触れない。state.json が無い・読めないときも投げず、env.json は外れる', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)] })
    const before = fs.readFileSync(cloudFile('state.json'), 'utf-8')
    expect(forgetDeletedBuckets(dir, [])).toBe(false)
    expect(fs.readFileSync(cloudFile('state.json'), 'utf-8')).toBe(before)

    writeState('{ これは JSON ではない')
    expect(forgetDeletedBuckets(dir, [A])).toBe(true)
    expect(envBuckets(dir)).toEqual([])
    expect(fs.readFileSync(cloudFile('state.json'), 'utf-8')).toBe('{ これは JSON ではない')

    fs.rmSync(cloudFile('state.json'))
    setup(dir, { env: [A], resources: [] })
    fs.rmSync(cloudFile('state.json'))
    expect(forgetDeletedBuckets(dir, [A])).toBe(true)
    expect(fs.existsSync(cloudFile('state.json'))).toBe(false)
  })
})

describe('F3 保存場所に触れなかった成功の回は、「データを削除しました」と言わない', () => {
  it('★★★ アプリだけ（保存場所も鍵も無い）→ ok:true・message の項目そのものが無い・要求はアプリの削除だけ', async () => {
    setup(dir, { env: [], resources: [APP] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect('message' in reply).toBe(false)
    expect(h.calls).toEqual(['deleteApp app-1'])
  })

  it('★★★ 記録の鍵だけ（保存場所0件）→ 鍵を無効にして ok:true・message は無い（消したデータは無い）', async () => {
    setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: 'perm-1' } })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toContain('deletePermission perm-1')
    expect(reply.ok).toBe(true)
    expect('message' in reply).toBe(false)
  })

  it('★★ 保存場所に触れた回は言う（対になる回）', async () => {
    setup(dir, { env: [A], resources: [APP] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toContain(`listAllKeys ${A}`)
    expect(reply.message).toBe(STORAGE_DONE)
  })
})

describe('F4 対応外の処理（skipped）は、成功の回の返り値と処理の記録に残る', () => {
  it('★★★ state にレジストリの資源がある → applyPlan が積む「段階3で対応」の行が、返り値にも処理の記録にも残る', async () => {
    setup(dir, { env: [], resources: [APP, REGISTRY] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    const line = 'コンテナレジストリ『myreg』を削除: 段階3で対応'   // 種類名（registry）を画面の文に出さない（W1）
    expect(reply.ok).toBe(true)
    expect(reply.skipped).toEqual([line])
    expect((getOps(dir).last?.result as any)?.extra?.skipped).toEqual([line])   // 開き直したときに読む処理の記録（extra）
  })

  it('★★ 何も積まれない回は、空の配列（項目は消えない）', async () => {
    setup(dir, { env: [], resources: [APP] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.skipped).toEqual([])
  })
})

describe('F10 アプリを消す段で失敗した回も、消えたアプリを state.json に残す（押し直しで 404 にしない）', () => {
  it('★★★ 2件のうち2件目で失敗 → ok:false・appDeleted:false。state.json には1件目が無く、2件目だけが残る。保存場所には触れない', async () => {
    setup(dir, { env: [A], resources: [APP, APP2, bucketRef(A)] })
    h.fail['deleteApp app-2'] = 'http500'
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toEqual(['deleteApp app-1', 'deleteApp app-2'])
    expect(reply).toMatchObject({ ok: false, appDeleted: false })
    expect(readState().resources.map((r: ResourceRef) => r.id)).toEqual(['app-2', A])   // 消えたアプリは記録から外れ、残ったアプリと保存場所は記録に残る
    expect(envBuckets(dir)).toEqual([A])
  })

  it('★★★ 押し直し: 消えたアプリ（1件目）は要求しない。2件目だけ消して、あとは続く', async () => {
    setup(dir, { env: [], resources: [APP, APP2] })
    h.fail['deleteApp app-2'] = 'http500'
    await teardown(EVENT, dir, OK_AUTH, GO)
    h.calls = []
    h.fail = {}
    const again = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(h.calls).toEqual(['deleteApp app-2'])
    expect(again.ok).toBe(true)
    expect(stateKinds(dir)).toEqual([])
  })
})
