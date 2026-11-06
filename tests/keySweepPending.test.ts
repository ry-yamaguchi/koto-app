import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── T-R1a: 共用型だけ、止まったあとの押し直しで鍵の一括の無効化が走らない（0.6.24 R1-a）────────────────────────────────
// 状況（0.6.24 U1〜U5 の検分で実測）: 共用型は、名前による鍵の一括の無効化（sweep）を「run の前の state にアプリがあった回」だけに渡す
// （アプリが無い回に渡すと、同じ名前で公開中の別プロジェクトの現役の鍵を無効にしうる＝docs/teardown-unify-plan.md 10.7.3）。
// 1回目にアプリが消え、保存場所の段が止まる（見せていない分がある・途中の失敗・例外）と、押し直しの回は state にアプリが無く、一括の無効化が永久に走らなかった。
// 直し方: 渡す条件が真なのに、保存場所の段が最後まで済まず見送った回は、記録（state の meta.keySweepPending）に印を立てる。印がある回は、アプリが無くても渡す。
// 最後まで済み、一括の無効化を果たした回は印が消える。最後まで済んでも、複製・何も消さなかった回で鍵に触れなかった回や、一括の無効化が途中で失敗した回は、印が残る（果たすべき仕事が残っている記録）。アプリが無く印も無い回は、今どおり渡さず、印も立てない。
// 本物の main に偽の保存場所を流し、**出た要求の一覧**（listPermissions・deletePermission）と、保存した state の meta で固定する（掟10）。
// HANAMII・専有型は一括の無効化を固定で渡す（アプリの有無を見ない）ので、この問題は無い（対象外）。
import { A, B, APP, OK_AUTH, PREFIX, bucketRef, h, resetHarness, newProjectDir, setup, stateMeta, stateKinds, envBuckets, workspaceOf } from './sharedTeardownHarness'
import { shownTeardown } from './shownFromEnv'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { stateToSave, type EnvState } from '../src/main/cloud/state'
import { permissionNameFor, keyRevokeGuide } from '../src/shared/storageKeys'

registerCloudHandlers({} as any)
const teardown = shownTeardown(h.handlers.get('cloud:teardown')!)
const EVENT = {}
const GO = { confirmed: true, deleteRegistry: false, registryName: null }
const REC = 'perm-rec'
const OLD = 'perm-old'
const NAME = 'myapp'
/** 確認で見せた保存場所（名前と prefix の組）を自分で決める回に使う（shownTeardown は opts に shownPlacements があれば上書きしない）。 */
const only = (...buckets: string[]) => ({ ...GO, shownPlacements: buckets.map(bucket => ({ bucket, prefix: PREFIX })) })

let dir = ''
beforeEach(() => { resetHarness(); resetProjectOpsForTests(); dir = newProjectDir() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** 名前による一括の無効化に入った要求（一覧を引く → 名前の合う鍵を無効にする）。 */
const sweepCalls = () => h.calls.filter(c => c === 'listPermissions' || c === `deletePermission ${OLD}`)
const oldKey = () => { h.permissions = [{ id: OLD, displayName: permissionNameFor(NAME, 'apprun') }] }

describe('★★★ 1回目にアプリが消えて保存場所の段が止まった → 押し直しで一括の無効化が走る', () => {
  it('★★★ 検分の再現: env=[A,B]・見せたのは A だけ → 1回目は ok:false で一括は走らず印が立つ。アプリを戻さずに B を見せて押し直すと listPermissions と deletePermission が出て、印が消える', async () => {
    setup(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B), APP], meta: { storagePermissionId: REC } })
    oldKey()

    const first = await teardown(EVENT, dir, OK_AUTH, only(A))
    expect(first).toMatchObject({ ok: false, appDeleted: true, skippedBuckets: [B] })
    expect(h.calls, '1回目は見せていない分があるので、一括の無効化は走らない').not.toContain('listPermissions')
    expect(h.calls).toContain(`deletePermission ${REC}`)                        // 記録の鍵は1件目で無効にできた
    expect(stateMeta(dir)).toMatchObject({ keySweepPending: 'apprun' })           // 一括の無効化を果たさずに止まった印
    expect(stateMeta(dir)?.storagePermissionId, '無効にできた記録の鍵の ID は外れる').toBeUndefined()
    expect(stateKinds(dir), '消えたアプリは記録に残らない（押し直しは「アプリが無い回」）').toEqual(['bucket'])

    // 押し直し: state は1回目の保存のまま（APP を戻さない）。B を見せる
    h.calls = []
    const second = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(second.ok).toBe(true)
    expect(h.calls.filter(c => c.startsWith('deleteApp ')), 'アプリは記録に無いので deleteApp は出ない').toEqual([])
    expect(sweepCalls(), '印を読んで、アプリが無い回でも一括の無効化が走る').toEqual(['listPermissions', `deletePermission ${OLD}`])
    expect(stateMeta(dir), '最後まで済んだ回は印が消える').toBeUndefined()
  })

  it('★★ 途中の失敗（2件目で一覧に失敗）でも印が立つ。押し直しで走る', async () => {
    setup(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B), APP] })
    oldKey()
    h.fail[`listAllKeys ${B}`] = 'throw'

    const first = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(first).toMatchObject({ ok: false, appDeleted: true, remainingBuckets: [B] })
    expect(sweepCalls()).toEqual([])
    expect(stateMeta(dir)).toMatchObject({ keySweepPending: 'apprun' })

    h.fail = {}
    h.calls = []
    const second = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(second.ok).toBe(true)
    expect(sweepCalls()).toEqual(['listPermissions', `deletePermission ${OLD}`])
    expect(stateMeta(dir)).toBeUndefined()
  })

  it('★★ 例外（保存場所の後始末が投げる）で終わった回にも印が立つ', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    h.fail.dispose = 'throw'

    const first = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(first).toMatchObject({ ok: false, appDeleted: true })
    expect(stateMeta(dir)).toMatchObject({ keySweepPending: 'apprun' })
  })

  it('★★ 印は、押し直しも止まれば残り続ける（印がある回が止まっても、また立てる）。最後に済んだ回で初めて消える', async () => {
    setup(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B), APP] })
    oldKey()

    await teardown(EVENT, dir, OK_AUTH, only(A))               // 1回目: アプリが消え、B を見せずに止まる → 印が立つ
    expect(stateMeta(dir)).toMatchObject({ keySweepPending: 'apprun' })

    h.fail[`listAllKeys ${B}`] = 'throw'                        // 2回目: アプリは無い。印があるので渡す条件は真。B の一覧に失敗して止まる
    h.calls = []
    const second = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(second.ok).toBe(false)
    expect(sweepCalls()).toEqual([])
    expect(stateMeta(dir), '2回目も止まったので、印は残る').toMatchObject({ keySweepPending: 'apprun' })

    h.fail = {}                                                 // 3回目: 済む → 一括の無効化が走り、印が消える
    h.calls = []
    const third = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(third.ok).toBe(true)
    expect(sweepCalls()).toEqual(['listPermissions', `deletePermission ${OLD}`])
    expect(stateMeta(dir)).toBeUndefined()
  })
})

describe('★★★ 対照: アプリが無く印も無い回は、今までどおり一括の無効化を渡さない。止まっても印を立てない（同じ名前の別プロジェクトの鍵を巻き込まない）', () => {
  it('★★★ アプリが無い回（保存場所だけ）が止まっても印は立たない。押し直しても listPermissions は0件', async () => {
    setup(dir, { env: [A, B], resources: [bucketRef(A), bucketRef(B)] })   // アプリは無い（幽霊の行）
    oldKey()

    const first = await teardown(EVENT, dir, OK_AUTH, only(A))
    expect(first).toMatchObject({ ok: false, skippedBuckets: [B] })
    expect(stateMeta(dir)?.keySweepPending, 'アプリが無い回に印を立てると、押し直しで別プロジェクトの鍵に当たる').toBeUndefined()

    h.calls = []
    const second = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(second.ok).toBe(true)
    expect(h.calls.filter(c => c === 'listPermissions' || c.startsWith('deletePermission ')), '同名の鍵に触れていない').toEqual([])
  })

  it('アプリが無い回が例外で止まっても印は立たない', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)] })
    h.fail.dispose = 'throw'
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(false)
    expect(stateMeta(dir)?.keySweepPending).toBeUndefined()
  })

  it('アプリがあった回が最後まで済めば、印は立たない（今どおり一括の無効化が走る）', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    oldKey()
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sweepCalls()).toEqual(['listPermissions', `deletePermission ${OLD}`])
    expect(stateMeta(dir)).toBeUndefined()
  })
})

describe('★★★ 最後まで済んだ（ok:true）のに一括の無効化を果たさなかった回は、印を残す（複製・何も消さなかった回）', () => {
  /** 複製（`myapp copy`）を、元と同じ親フォルダに置く。元と同じバケット・同じ prefix を env.json に同意済みで持つ。 */
  const twin = (bucket: string) => {
    const p = path.join(workspaceOf(dir), 'myapp copy', '.sakura-cloud')
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'env.json'), JSON.stringify({ persistence: { objectStorage: [{ bucket, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] } }))
    return path.dirname(p)
  }

  it('★★★ アプリがあった回で、保存場所が複製と同じ prefix → ok:true・一括の無効化の要求は0件・印が残る。複製が消えたあとの押し直しで走り、印が消える', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    const copy = twin(A)
    oldKey()

    const first = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(first).toMatchObject({ ok: true, appDeleted: true })
    expect(sweepCalls(), '複製がいるので鍵には触れない').toEqual([])
    expect(h.calls.filter(c => c.startsWith('deleteBucket '))).toEqual([])
    expect(stateMeta(dir), '果たしていない一括の無効化の印は成功の回でも残る').toMatchObject({ keySweepPending: 'apprun' })

    fs.rmSync(copy, { recursive: true, force: true })   // 複製が無くなった
    h.calls = []
    const second = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(second.ok).toBe(true)
    expect(h.calls.filter(c => c.startsWith('deleteApp ')), 'アプリは記録に無い').toEqual([])
    expect(sweepCalls(), '印を読んで、アプリが無い回でも一括の無効化が走る').toEqual(['listPermissions', `deletePermission ${OLD}`])
    expect(stateMeta(dir), '果たした回は印が消える').toBeUndefined()
  })

  it('★★★ keptOnly の回（アプリ無し・印だけ・保存場所が全部複製）→ keptOnly:true・要求0件・印が残る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)], meta: { keySweepPending: 'apprun' } })
    twin(A)
    oldKey()

    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply).toMatchObject({ ok: true, keptOnly: true })
    expect(sweepCalls()).toEqual([])
    expect(stateMeta(dir), '何も消さなかった回は印を落とさない').toMatchObject({ keySweepPending: 'apprun' })
  })

  it('★★ 確認で「消しません」（keepData）と言った回も、印が残る。要求0件', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    oldKey()
    const reply = await teardown(EVENT, dir, OK_AUTH, { ...GO, shownPlacements: [{ bucket: A, prefix: PREFIX, keepData: true }] })
    expect(reply.ok).toBe(true)
    expect(sweepCalls()).toEqual([])
    expect(stateMeta(dir)).toMatchObject({ keySweepPending: 'apprun' })
  })

  it('★★ 対照: アプリが無く印も無い回は、複製がいても印を立てない（同じ名前の別プロジェクトの鍵を巻き込まない）', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)] })
    twin(A)
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply).toMatchObject({ ok: true, keptOnly: true })
    expect(stateMeta(dir)?.keySweepPending).toBeUndefined()
  })
})

describe('★★★ 一括の無効化を行ったが果たせなかった回（一覧が引けない・無効にできない鍵がある）は、印を残す', () => {
  it('★★★ 一覧（listPermissions）が投げた ok:true の回 → 保存場所は消え、印が残り、結果に警告と手で消す案内が出る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    oldKey()
    h.fail.listPermissions = 'throw'

    const first = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(first.ok).toBe(true)
    expect(h.calls, '一覧を引きに行った').toContain('listPermissions')
    expect(h.calls.filter(c => c.startsWith('deletePermission ')), '一覧が無いので無効化の要求は0件').toEqual([])
    expect(stateMeta(dir), '果たしていない一括の無効化の印は残る').toMatchObject({ keySweepPending: 'apprun' })
    expect(stateKinds(dir), 'バケットは記録から消えている').toEqual([])
    expect(envBuckets(dir), 'バケットは env.json からも消えている').toEqual([])
    const guide = keyRevokeGuide(NAME, 'apprun')
    const warn = (first as any).executed.find((l: string) => l.startsWith('⚠️ ') && l.includes('一覧を取得できなかった'))
    expect(warn, '警告の行').toBeDefined()
    expect(warn.endsWith(guide), '警告の最後に、コントロールパネルで消す案内が付く').toBe(true)
  })

  it('★★ 鍵の無効化（deletePermission）が失敗した回も、保存場所は消え、印が残り、警告と手で消す案内が出る', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    oldKey()
    h.fail[`deletePermission ${OLD}`] = 'throw'

    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sweepCalls()).toEqual(['listPermissions', `deletePermission ${OLD}`])
    expect(stateMeta(dir)).toMatchObject({ keySweepPending: 'apprun' })
    expect(stateKinds(dir)).toEqual([])
    expect(envBuckets(dir)).toEqual([])
    const warn = (reply as any).executed.find((l: string) => l.startsWith('⚠️ ') && l.includes('無効にできませんでした'))
    expect(warn, '警告の行').toBeDefined()
    expect(warn.endsWith(keyRevokeGuide(NAME, 'apprun'))).toBe(true)
  })

  it('★★★ 保存場所が記録に残っている回（複製・「消しません」のあとなど）: 印あり・保存場所あり・直った一覧 → 一括の無効化が走り、印が消える', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)], meta: { keySweepPending: 'apprun' } })
    oldKey()
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sweepCalls()).toEqual(['listPermissions', `deletePermission ${OLD}`])
    expect(stateMeta(dir), '果たした回は印が消える').toBeUndefined()
  })

  it('★★ 保存場所が記録に残っている回で、一括の無効化がまた失敗したら、印は残る（例外にならない）', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)], meta: { keySweepPending: 'apprun' } })
    oldKey()
    h.fail.listPermissions = 'throw'
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(stateMeta(dir)).toMatchObject({ keySweepPending: 'apprun' })
  })
})

describe('★★ 印がある回で、保存場所が0件（env.json からも state からも消えている）のとき、印を外さない', () => {
  it('★★ 印あり・アプリ無し・保存場所0件 → ok:true・一括の無効化の要求は0件・印が残る', async () => {
    setup(dir, { env: [], resources: [], meta: { keySweepPending: 'apprun' } })
    oldKey()

    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(sweepCalls()).toEqual([])
    expect(stateMeta(dir), '果たしていない印は、保存場所が無い回でも落とさない').toMatchObject({ keySweepPending: 'apprun' })
  })

  it('★★ 対照: 印が無い回は、保存場所0件でも印を立てない', async () => {
    setup(dir, { env: [], resources: [APP] })
    const reply = await teardown(EVENT, dir, OK_AUTH, GO)
    expect(reply.ok).toBe(true)
    expect(stateMeta(dir)?.keySweepPending).toBeUndefined()
  })
})

describe('印の保存と消え方（記録を作る純関数）', () => {
  const stateWith = (meta: EnvState['meta']): EnvState => ({ name: NAME, backend: 'apprun', resources: [], meta })

  it('止まった回（ok:false）の保存は、state をそのまま残す＝印が残る', () => {
    const s = stateWith({ keySweepPending: 'apprun', storagePermissionId: REC })
    expect(stateToSave({ ok: false, state: s, kind: 'teardown', registryDeleted: false }).meta).toEqual({ keySweepPending: 'apprun', storagePermissionId: REC })
  })

  it('最後まで済んだ回（ok:true）の保存は、段が残した印を引き継ぐ（印を落とすのは段が果たした回に外したときだけ）。残すレジストリの名前と由来も残る', () => {
    const s = stateWith({ keySweepPending: 'apprun', registryName: 'myreg', registryAdopted: false })
    const saved = stateToSave({ ok: true, state: s, kind: 'teardown', registryDeleted: false })
    expect(saved.meta).toEqual({ registryName: 'myreg', registryAdopted: false, keySweepPending: 'apprun' })
    expect(stateToSave({ ok: true, state: stateWith({ keySweepPending: 'apprun' }), kind: 'teardown', registryDeleted: false }).meta).toEqual({ keySweepPending: 'apprun' })
    expect(stateToSave({ ok: true, state: stateWith({ keySweepPending: 'apprun' }), kind: 'teardown', registryDeleted: true }).meta, '消したレジストリの名前は残さないが、印は残す').toEqual({ keySweepPending: 'apprun' })
  })

  it('印が無い回・読めない形の印（\'apprun\' 以外）の保存は、印を作らない', () => {
    expect(stateToSave({ ok: true, state: stateWith({ registryName: 'myreg' }), kind: 'teardown', registryDeleted: false }).meta).toEqual({ registryName: 'myreg' })
    expect(stateToSave({ ok: true, state: stateWith({ keySweepPending: 'x' as any }), kind: 'teardown', registryDeleted: false }).meta).toBeUndefined()
  })
})

describe('配線: 一括の無効化を渡す条件・印を立てる所は保存場所の段の1か所', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8').replace(/^\s*\/\/.*$/gm, '')
  const stage = read('src/main/ipc/cloudTeardownStorage.ts')
  const main = read('src/main/ipc/cloudTeardown.ts')
  const times = (text: string, needle: string) => text.split(needle).length - 1

  it("★ sweepKeysFor を決めるのは段の1か所（`owed ? 'apprun' : null`）。cloudTeardown.ts は決めない（`hadApp ? 'apprun'` に戻らない）", () => {
    expect(times(stage, "sweepKeysFor: owed ? 'apprun' : null")).toBe(1)
    expect(times(stage, 'sweepKeysFor')).toBe(1)
    expect(times(main, 'sweepKeysFor')).toBe(0)
    expect(stage).toContain("const sweepOwedBy = (hadApp: boolean, state: EnvState): boolean => hadApp || state.meta?.keySweepPending === 'apprun'")
    expect(stage).toContain('const owed = sweepOwedBy(hadApp, i.cur)')
  })

  it("★ 印を立てるのは段の1か所で、渡す条件（owed）が真で、止まった回か一括の無効化を見送った回だけ。果たした回は外す", () => {
    expect(times(stage, "keySweepPending: 'apprun'")).toBe(1)
    expect(stage).toContain("const { keySweepPending: _drop, ...meta } = cur.meta ?? {}")
    expect(stage).toContain("cur = failure || sweepSkipped ? { ...cur, meta: { ...meta, keySweepPending: 'apprun' } } : { ...cur, meta }")
    expect(stage).toContain('if (st.ok && !st.sweepDone) sweepSkipped = true')
    expect(stage).not.toContain("if (failure && owed) cur =")
    expect(main).not.toContain('keySweepPending')
  })
})
