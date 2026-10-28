import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── このテストは何か（段階2・docs/teardown-unify-plan.md の 10.7.2・10.7.12 の P5）────────────────
// 共用型 AppRun の破棄 `cloud:teardown` が、保存場所（バケット）に何をするかを、env.json と state.json の組み合わせ7行
// （M0〜M5）で、本物の main に偽の保存場所・偽の client を流して数える。
//   ・確認が名前を出す保存場所＝`cloud:teardownRecord` の `placements`（env.json の同意済み全件 + state にだけあるもの）
//   ・実際に触った保存場所＝保存場所への要求 `listAllKeys` に出た名前
// が、**どの形でも一致する**こと（P5-一致）と、順序（アプリ → レジストリ → 保存場所）を固定する（P5-順序）。
// 段階2の 2a-0 では「今の振る舞い」（M1 は A に触れない・M2 は確認が何も言わないのに B を消す・M3 は保存場所が先）を数えた。
// 2a-1a で保存場所の読み先を env.json の同意済み全件 + state にだけあるものに寄せたので、期待を新しい方針に書き換えた。
// **ソースの文字列は読まない**（掟10。P5-双子の「読み手が同じ関数を通る」だけは文字列で見る）。
import { A, B, PREFIX, APP, OK_AUTH, REGISTRY_ROW, bucketRef, h, resetHarness, newProjectDir, setup, envBuckets, stateKinds, stateMeta } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import type { ResourceRef } from '../src/main/cloud/state'
import { registerCloudHandlers, consentedPlacements } from '../src/main/ipc/cloud'
import { sharedTeardownRecordOf } from '../src/main/ipc/cloudTeardown'
import { storagePlacementsOf } from '../src/main/cloud/storageForTarget'
import { NOT_CONFIRMED_MESSAGE } from '../src/main/cloud/teardownShell'
import { defaultSpec } from '../src/main/cloud/spec'
import { consentedPlacementsOf } from '../src/shared/objectStorage'
import { getOps, resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const teardown = h.handlers.get('cloud:teardown')!
const teardownRecord = h.handlers.get('cloud:teardownRecord')!
const placement = h.handlers.get('storage:placement')!
const EVENT = {}

let dir = ''
beforeEach(() => { resetProjectOpsForTests(); resetHarness(); dir = newProjectDir() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const CONFIRMED = { confirmed: true, deleteRegistry: false, registryName: null }

/**
 * 画面の流れを写す: 先に確認の材料（`storage:placement`＝env.json だけの共通の読み口・`cloud:teardownRecord`）を読み、
 * そのあとで `cloud:teardown` を呼ぶ。`listed` は実際に一覧した（＝触った）保存場所。
 */
async function measure(opts: Record<string, unknown>) {
  const asked = await placement(EVENT, dir)
  const rec = await teardownRecord(EVENT, dir)
  // 画面は、確認の材料（teardownRecord の placements）が挙げた組をそのまま main へ運ぶ（0.6.24 F）。確認の印が無い回は何も足さない
  const shownPlacements = rec.ok ? (rec.record.placements as Array<{ bucket: string; prefix: string }>).map(p => ({ bucket: p.bucket, prefix: p.prefix })) : []
  const reply = await teardown(EVENT, dir, OK_AUTH, opts.confirmed === true ? { ...opts, shownPlacements } : opts)
  const calls = [...h.calls]
  const ops = getOps(dir)
  const verbs = ['listAllKeys ', 'deleteKeys ', 'deleteBucket ', 'deletePermission ']
  const app = calls.findIndex(c => c.startsWith('deleteApp '))
  const sto = calls.findIndex(c => verbs.some(v => c.startsWith(v)))
  return {
    reply, calls,
    envPlacements: (asked.placements as Array<{ bucket: string }>).map(p => p.bucket),
    recorded: (rec.record.placements as Array<{ bucket: string }>).map(p => p.bucket),
    listed: calls.filter(c => c.startsWith('listAllKeys ')).map(c => c.slice('listAllKeys '.length)),
    /** 一覧・データ削除・バケット削除のどれかで触った保存場所の名前（重なりなし・触った順）。 */
    touched: [...new Set(calls.flatMap(c => { const m = /^(?:listAllKeys|deleteKeys|deleteBucket) (.+)$/.exec(c); return m ? [m[1]] : [] }))],
    order: app < 0 ? 'no-app' : sto < 0 ? 'no-storage' : sto < app ? 'storage-first' : 'app-first',
    opsRecords: (ops.last ? 1 : 0) + ops.earlier.length,
    opsRunning: ops.running,
    opsResult: ops.last?.result,
  }
}
const storageOf = (...b: string[]) => b.flatMap(x => [`listAllKeys ${x}`, `deleteKeys ${x}`, `deleteBucket ${x}`])

describe('共用型の破棄 cloud:teardown: 確認が言う保存場所と、実際に触る保存場所（P5-一致・P5-順序）', () => {
  it('M0 確認の印が無い: 要求は1件も出ない（保存場所へ接続もしない）。処理の記録も作らない。state は変わらない', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    const m = await measure({ deleteRegistry: false, registryName: null })

    expect(m.calls).toEqual([])
    expect(m.reply).toEqual({ ok: false, message: NOT_CONFIRMED_MESSAGE })
    expect(m.opsRecords).toBe(0)
    expect(m.opsRunning).toBeNull()
    expect(stateKinds(dir)).toEqual(['bucket', 'apprun-app'])
    expect(envBuckets(dir)).toEqual([A])
  })

  it('M1 env.json に A・state に bucket 無し: 確認が言う A を、実際に消す（アプリのあと）。以前は A に触れなかった', async () => {
    setup(dir, { env: [A], resources: [APP] })
    const m = await measure(CONFIRMED)

    expect(m.envPlacements).toEqual([A])
    expect(m.recorded).toEqual([A])
    expect(m.listed).toEqual([A])                                   // P5-一致
    expect(m.calls).toEqual(['deleteApp app-1', 'connect', ...storageOf(A), 'listPermissions', 'dispose'])
    expect(m.order).toBe('app-first')
    expect(m.reply.ok).toBe(true)
    expect(m.reply.appDeleted).toBe(true)
    expect(m.reply.keptBucketName).toBeNull()
    expect(m.reply.message).toBe('保存場所にあった、このプロジェクトのデータを削除しました。')
    expect(m.opsRecords).toBe(1)
    expect(m.opsResult).toMatchObject({ ok: true })
    // 警告はレジストリの記録が無いことの1件だけ（保存場所は消えたので、A の名前を出す警告は無い）
    expect(m.opsResult!.warnings).toHaveLength(1)
    expect(m.opsResult!.warnings[0]).toContain('どのコンテナレジストリを使っているかの記録がない')
    expect(m.opsResult!.warnings.some((w: string) => w.includes(A))).toBe(false)
    expect(envBuckets(dir)).toEqual([])                             // 消したバケットの宛先は env.json からも外れる
    expect(stateKinds(dir)).toEqual([])
  })

  it('M2 env.json に無い・state に B: 確認が言う（recorded）B を、アプリのあとで消し、記録の鍵も無効にする', async () => {
    setup(dir, { env: [], resources: [bucketRef(B), APP], meta: { storagePermissionId: 'perm-1' } })
    const m = await measure(CONFIRMED)

    expect(m.envPlacements).toEqual([])                             // 共通の読み口（env.json だけ）は何も言わない
    expect(m.recorded).toEqual([B])                                 // 確認の材料は state にだけある B を挙げる
    expect(m.listed).toEqual([B])                                   // P5-一致: 材料が挙げたものを消す
    expect(m.calls).toEqual(['deleteApp app-1', 'connect', ...storageOf(B), 'deletePermission perm-1', 'listPermissions', 'dispose'])
    expect(m.order).toBe('app-first')
    expect(m.reply.ok).toBe(true)
    expect(m.reply.keptBucketName).toBeNull()
    expect(m.reply.executed.some((l: string) => l.includes(B))).toBe(true)
    expect(m.reply.executed.filter((l: string) => l.startsWith('⚠️'))).toEqual([])   // env.json に無い（state にだけある）分は外すものが無い。「記録を残しています」と言わない
    expect(stateKinds(dir)).toEqual([])                             // 成功の回は state.json から外れる
    expect(stateMeta(dir)).toBeUndefined()                          // 鍵の ID ごと meta が落ちる
  })

  it('M3 env.json にも state にも A（bucket が先の並び）: deleteApp が先。保存場所はそのあと', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    const m = await measure(CONFIRMED)

    expect(m.recorded).toEqual([A])
    expect(m.listed).toEqual([A])
    expect(m.calls).toEqual(['deleteApp app-1', 'connect', ...storageOf(A), 'listPermissions', 'dispose'])
    expect(m.order).toBe('app-first')                               // 以前は state の並びのまま＝保存場所が先だった
    expect(m.reply.ok).toBe(true)
    expect(envBuckets(dir)).toEqual([])
  })

  it("M3' env.json にも state にも A（app が先の並び）: M3 と同じ。state の並びに左右されない", async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)] })
    const m = await measure(CONFIRMED)

    expect(m.listed).toEqual([A])
    expect(m.calls).toEqual(['deleteApp app-1', 'connect', ...storageOf(A), 'listPermissions', 'dispose'])
    expect(m.order).toBe('app-first')
  })

  it('M4 env.json に A・B、state に A だけ: 確認が言う A と B を、両方消す。以前は B に触れなかった', async () => {
    setup(dir, { env: [A, B], resources: [APP, bucketRef(A)] })
    const m = await measure(CONFIRMED)

    expect(m.envPlacements).toEqual([A, B])
    expect(m.recorded).toEqual([A, B])
    expect(m.listed).toEqual([A, B])
    expect(m.calls).toEqual(['deleteApp app-1', 'connect', ...storageOf(A, B), 'listPermissions', 'dispose'])
    expect(m.reply.ok).toBe(true)
    expect(m.reply.keptBucketName).toBeNull()
    expect(envBuckets(dir)).toEqual([])
  })

  it('M5 env.json に A・レジストリ myreg を消す: deleteApp → レジストリの一覧・削除 → 保存場所 の順', async () => {
    setup(dir, { env: [A], resources: [APP], meta: { registryName: 'myreg' } })
    h.registryRows = [REGISTRY_ROW]
    const m = await measure({ confirmed: true, deleteRegistry: true, registryName: 'myreg' })

    expect(m.calls).toEqual([
      'deleteApp app-1', 'listContainerRegistries', 'deleteContainerRegistry reg-1',
      'connect', ...storageOf(A), 'listPermissions', 'dispose',
    ])
    expect(m.listed).toEqual([A])
    expect(m.reply.ok).toBe(true)
    expect(m.opsRecords).toBe(1)
    expect(m.opsResult!.warnings).toEqual([])
    expect(stateMeta(dir)).toBeUndefined()                          // 消せたので registryName の記録も落ちる
  })
})

describe('P5-一致（表）: 確認が名前を出す保存場所 = 実際に触った保存場所。どの形でも一致する', () => {
  const FORMS: Array<{ form: string; env: string[]; resources: ResourceRef[]; says: string[]; commonReader: string[] }> = [
    { form: 'M1 env に A・state に bucket 無し', env: [A], resources: [APP], says: [A], commonReader: [A] },
    { form: 'M3 env にも state にも A（bucket が先）', env: [A], resources: [bucketRef(A), APP], says: [A], commonReader: [A] },
    { form: "M3' env にも state にも A（app が先）", env: [A], resources: [APP, bucketRef(A)], says: [A], commonReader: [A] },
    { form: 'M4 env に A・B、state に A だけ', env: [A, B], resources: [APP, bucketRef(A)], says: [A, B], commonReader: [A, B] },
    { form: 'M2 env に無い・state に B', env: [], resources: [bucketRef(B), APP], says: [B], commonReader: [] },
    { form: 'M2+ env に A・state に A と B（B は設定から外した）', env: [A], resources: [APP, bucketRef(A), bucketRef(B)], says: [A, B], commonReader: [A] },
    { form: "M4' env に B・A（env.json の並びは state の並びと逆）", env: [B, A], resources: [bucketRef(A), APP], says: [B, A], commonReader: [B, A] },
  ]
  for (const f of FORMS) {
    it(`${f.form}: 確認の材料（placements）・一覧した名前・触った名前がすべて ${f.says.join('・')}。env.json の一覧は共通の読み口と同じ`, async () => {
      setup(dir, { env: f.env, resources: f.resources })
      const m = await measure(CONFIRMED)
      expect(m.recorded).toEqual(f.says)
      expect(m.listed).toEqual(f.says)
      expect(m.touched).toEqual(f.says)                          // 確認が言わなかった保存場所には、一覧すらしない
      expect(m.envPlacements).toEqual(f.commonReader)           // 共通の読み口（env.json だけ）は、state にだけある分を言わない
      expect(m.envPlacements.every(b => m.recorded.includes(b))).toBe(true)
      expect(m.reply.ok).toBe(true)
    })
  }

  it('確認の材料が挙げた stateOnlyBuckets = 共通の読み口が言わず、実際には消した保存場所（M2・M2+）', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A), bucketRef(B)] })
    const rec = (await teardownRecord(EVENT, dir)).record
    const common = (await placement(EVENT, dir)).placements.map((p: { bucket: string }) => p.bucket)
    expect(rec.stateOnlyBuckets).toEqual(rec.placements.map((p: { bucket: string }) => p.bucket).filter((b: string) => !common.includes(b)))
    expect(rec.stateOnlyBuckets).toEqual([B])
    const m = await measure(CONFIRMED)
    expect(m.touched).toEqual([A, B])
    expect(envBuckets(dir)).toEqual([])                         // env.json の A は外れる。B は env.json に無く、外すものも無い
    expect(stateKinds(dir)).toEqual([])
  })

  it('先頭の保存場所の一覧に失敗 → そこで止まり、確認が言った名前の外へは出ない。残りは確認が言った全件', async () => {
    setup(dir, { env: [A, B], resources: [APP, bucketRef(A)] })
    h.fail[`listAllKeys ${A}`] = 'throw'
    const m = await measure(CONFIRMED)
    expect(m.recorded).toEqual([A, B])
    expect(m.touched.every(b => m.recorded.includes(b))).toBe(true)
    expect(m.reply.ok).toBe(false)
    expect(m.touched).toEqual([A])                              // 最初の一覧で止まる。確認に無い名前へは移らない
    expect(m.reply.remainingBuckets).toEqual([A, B])             // 残りは、確認が言った全件
  })
})

describe('P5-順序（全部入り）: アプリ → レジストリ → 保存場所 → 記録の鍵 → 名前による一括の無効化 → 切断', () => {
  it('env に A・レジストリを消す・記録の鍵あり → この順に1本の一覧で出る。アプリが先、レジストリがその次、保存場所が最後', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { registryName: 'myreg', storagePermissionId: 'perm-1' } })
    h.registryRows = [REGISTRY_ROW]
    const m = await measure({ confirmed: true, deleteRegistry: true, registryName: 'myreg' })
    expect(m.calls).toEqual([
      'deleteApp app-1',
      'listContainerRegistries', 'deleteContainerRegistry reg-1',
      'connect', ...storageOf(A), 'deletePermission perm-1', 'listPermissions', 'dispose',
    ])
    expect(m.reply.ok).toBe(true)
    expect(stateMeta(dir)).toBeUndefined()
  })

  it('保存場所が0件で記録の鍵だけある → deleteApp → connect → deletePermission → dispose（一覧も一括の無効化もしない）', async () => {
    setup(dir, { env: [], resources: [APP], meta: { storagePermissionId: 'perm-1' } })
    const m = await measure(CONFIRMED)
    expect(m.recorded).toEqual([])
    expect(m.calls).toEqual(['deleteApp app-1', 'connect', 'deletePermission perm-1', 'dispose'])
    expect(m.touched).toEqual([])
  })
})

describe('M2（state にだけある保存場所）: 言って消す。鍵・ほかが使う保存場所の扱い', () => {
  const FOREIGN = 'projects/other/data.json'

  it('記録の鍵の無効化に失敗（deletePermission が投げる）→ ok:true のまま ⚠️ の行。B は消えて state から外れ、meta に鍵の ID が残る', async () => {
    setup(dir, { env: [], resources: [bucketRef(B), APP], meta: { storagePermissionId: 'perm-1' } })
    h.fail['deletePermission perm-1'] = 'throw'
    const m = await measure(CONFIRMED)
    expect(m.touched).toEqual([B])
    expect(m.reply.ok).toBe(true)
    expect(m.reply.executed).toContain('⚠️ 保存場所のアクセスキーを無効にできませんでした。さくらのクラウドのコントロールパネルで、オブジェクトストレージのパーミッション「koto-myapp」を削除してください（アクセスキーも一緒に無効になります）。')
    expect(stateKinds(dir)).toEqual([])                             // B はもう無いので、記録から外れる
    expect(stateMeta(dir)).toMatchObject({ storagePermissionId: 'perm-1' })   // 辿れない鍵を作らない
  })

  it('ほかのプロジェクトが B を使っている → B のデータだけ消してバケットは残す。keptBucketName(s) に B。state に B が残る（月額が続く警告）', async () => {
    setup(dir, { env: [], resources: [bucketRef(B), APP] })
    h.keys = [`${PREFIX}data.json`, FOREIGN]
    const m = await measure(CONFIRMED)
    expect(m.calls.some(c => c.startsWith('deleteBucket '))).toBe(false)
    expect(m.calls).toContain(`deleteKeys ${B}`)
    expect(m.reply.ok).toBe(true)
    expect(m.reply.keptBucketName).toBe(B)
    expect(m.reply.keptBucketNames).toEqual([B])
    expect(stateKinds(dir)).toEqual(['bucket'])
    expect(m.opsResult!.warnings.join('\n')).toContain('月額')
  })

  it('B の一覧に失敗 → 消さずに ok:false。remainingBuckets に B。アプリは消えていて記録に残らない。押し直しの確認の材料にも B が出る', async () => {
    setup(dir, { env: [], resources: [bucketRef(B), APP], meta: { storagePermissionId: 'perm-1' } })
    h.fail[`listAllKeys ${B}`] = 'throw'
    const m = await measure(CONFIRMED)
    expect(m.calls.some(c => c.startsWith('deleteKeys ') || c.startsWith('deleteBucket '))).toBe(false)
    expect(m.reply).toMatchObject({ ok: false, appDeleted: true, remainingBucket: B, remainingBuckets: [B] })
    expect(stateKinds(dir)).toEqual(['bucket'])
    expect(stateMeta(dir)).toMatchObject({ storagePermissionId: 'perm-1' })   // 消せていない保存場所の鍵は、まだ無効にしない
    const again = (await teardownRecord(EVENT, dir)).record
    expect(again).toMatchObject({ appNames: [], stateOnlyBuckets: [B] })
    expect(again.placements.map((p: { bucket: string }) => p.bucket)).toEqual([B])
  })
})

describe('P5-順序: アプリを消せなかった回は、レジストリにも保存場所にも触れない', () => {
  it('deleteApp が失敗 → レジストリ・保存場所への要求は0件。アプリは state に残り、保存場所の宛先も残る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP], meta: { registryName: 'myreg' } })
    h.registryRows = [REGISTRY_ROW]
    h.fail['deleteApp app-1'] = 'http500'
    const m = await measure({ confirmed: true, deleteRegistry: true, registryName: 'myreg' })

    expect(m.calls).toEqual(['deleteApp app-1'])
    expect(m.reply.ok).toBe(false)
    expect(m.reply.appDeleted).toBe(false)
    expect(stateKinds(dir)).toEqual(['bucket', 'apprun-app'])
    expect(envBuckets(dir)).toEqual([A])
  })
})

// ── P5-双子: 保存場所の読み手は3つ。どれも consentedPlacementsOf の1つを通り、同じ一覧になる ─────────────────
describe('P5-双子: 確認の材料・消すもの・確認の記録の保存場所の読み方が同じ', () => {
  const root = path.join(__dirname, '..', 'src')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8')

  function writeEnv(list: unknown[]) {
    const spec: any = defaultSpec({ name: 'myapp', hasDockerfile: false })
    spec.persistence = { objectStorage: list }
    fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(spec), 'utf-8')
    return spec
  }

  it('2件・同意の無いもの・prefix の無いもの・専用（shared:false）を含む env.json で、3つの読み手が bucket・prefix・shared まで同じ一覧', () => {
    const spec = writeEnv([
      { bucket: A, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' },
      { bucket: B, shared: false, consentedAt: '2026-08-15T00:00:00.000Z' },            // prefix 無し・専用
      { bucket: 'koto-data-c', prefix: PREFIX, consentedAt: '' },                        // 同意の日時が空＝対象外
      { bucket: 'koto-data-d', prefix: PREFIX },                                         // 同意なし＝対象外
    ])
    const viaConfirm = consentedPlacements(dir).map(({ bucket, prefix, shared }) => ({ bucket, prefix, shared }))
    const viaDelete = storagePlacementsOf(dir)
    const viaRecord = sharedTeardownRecordOf(spec, { name: 'myapp', backend: 'apprun', resources: [] }).placements
    expect(viaConfirm).toEqual([{ bucket: A, prefix: PREFIX, shared: true }, { bucket: B, prefix: '', shared: false }])
    expect(viaDelete).toEqual(viaConfirm)
    expect(viaRecord).toEqual(viaConfirm)
  })

  it('空の bucket・壊れた1件（env.json の検証が通らない形）は、純関数の側でも対象外。確認の記録の placements にも入らない', () => {
    const list: any[] = [
      { bucket: A, prefix: PREFIX, consentedAt: '2026-08-14T00:00:00.000Z' },
      { bucket: '', prefix: PREFIX, consentedAt: '2026-08-16T00:00:00.000Z' },
      null,
      { bucket: B, prefix: PREFIX, consentedAt: '   ' },
    ]
    const spec: any = { ...defaultSpec({ name: 'myapp', hasDockerfile: false }), persistence: { objectStorage: list } }
    expect(consentedPlacementsOf(list).map(p => p.bucket)).toEqual([A])
    expect(sharedTeardownRecordOf(spec, { name: 'myapp', backend: 'apprun', resources: [] }).placements).toEqual([{ bucket: A, prefix: PREFIX, shared: true }])
  })

  it('state にだけある保存場所は、env.json の一覧のあとに足される。env.json の分の並び・prefix・shared は読み手と同じまま', () => {
    const spec = writeEnv([{ bucket: A, prefix: PREFIX, shared: false, consentedAt: '2026-08-14T00:00:00.000Z' }])
    const state = { name: 'myapp', backend: 'apprun' as const, resources: [bucketRef(B), bucketRef(A)] }
    const rec = sharedTeardownRecordOf(spec, state)
    const viaConfirm = consentedPlacements(dir).map(({ bucket, prefix, shared }) => ({ bucket, prefix, shared }))
    expect(rec.placements.slice(0, viaConfirm.length)).toEqual(viaConfirm)
    expect(rec.placements.slice(viaConfirm.length)).toEqual([{ bucket: B, prefix: PREFIX, shared: true }])   // state にだけある分は共有に倒す
    expect(rec.stateOnlyBuckets).toEqual([B])
    expect(storagePlacementsOf(dir)).toEqual(viaConfirm)                                                     // 消すものの env.json の読みは state を見ない
  })

  it('3つのソースが consentedPlacementsOf( を呼ぶ（別の判断を書いて食い違わせない）', () => {
    for (const rel of ['main/ipc/cloud.ts', 'main/cloud/storageForTarget.ts', 'main/ipc/cloudTeardown.ts']) {
      expect(read(rel), rel).toContain('consentedPlacementsOf(')
    }
  })

  it('env.json が壊れていると、確認の材料・消すもの・確認の記録のどれも読めない（読めたふりをしない）', async () => {
    fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), '{ これは JSON ではない', 'utf-8')
    expect(() => consentedPlacements(dir)).toThrow()
    expect(() => storagePlacementsOf(dir)).toThrow()
    expect(await teardownRecord(EVENT, dir)).toMatchObject({ ok: false })
  })
})
