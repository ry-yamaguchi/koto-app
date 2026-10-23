import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'

// ── 結果の双子（共用型）: 本物の main（cloud:teardown）が返した値と、main が書いた記録で比べる（段階2・2a-2）──────────────
// 破棄の結果は、その場の返り値（toTeardownView）でも、閉じて開き直した記録（本物の summarizeResult → getOps を通ったもの。
// resumedTeardownView）でも、同じ TeardownView になる（設計書 10.4.9 の「双子」。文で書いた返り値の通りは tests/teardownResultCommon.test.ts の
// 「共用型 8〜14」）。ここは**本物の main が返した値**で比べる——main の返し方（appDeleted・remainingBuckets・keptBucketNames・⚠️ の行）を
// 変えると、ここが落ちる。偽の client・偽の保存場所の作りは tests/sharedTeardownHarness.ts（掟10: 要求の一覧で固定）。
import { A, B, PREFIX, APP, OK_AUTH, REGISTRY_ROW, bucketRef, h, resetHarness, newProjectDir, setup } from './sharedTeardownHarness'
import type { EnvState, ResourceRef } from '../src/main/cloud/state'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { getOps, resetProjectOpsForTests } from '../src/main/projectOps'
import { teardownRemainingWarnings } from '../src/shared/cloudCost'
import { KEY_REVOKE_FAILED_WARNING } from '../src/main/cloud/storageTeardown'
import {
  toTeardownView, resumedTeardownView, TEARDOWN_REMAINING_WARNING_HEAD, type TeardownView, type TeardownLeftover,
} from '../src/shared/teardownResult'

registerCloudHandlers({} as any)
const teardown = h.handlers.get('cloud:teardown')!
const EVENT = {}
const SHARED = 'sakura-apprun' as const
// コンテナレジストリは「消す」を選んだ形にそろえる（記録に名前が無い・残した、の警告が混ざらない）。レジストリの警告は C-8・C-11・C-12 の持ち場
const GO = { confirmed: true, deleteRegistry: true, registryName: 'myreg' }
const FOREIGN = 'projects/other-app/data.json' // ほかのプロジェクトの prefix。あるとバケットごとは消せない

let dir = ''
beforeEach(() => { resetProjectOpsForTests(); resetHarness(); dir = newProjectDir() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const STORAGE = (b: string): TeardownLeftover => ({ label: `保存場所『${b}』（月額が続きます）`, billing: true, kind: 'storage' })
// 保存場所が入っているときは、削除する前の確かめを添える（保存場所はほかのプロジェクトも使っていることがある。Koto は中身を確かめていない）
const STORAGE_CHECK = '保存場所は、ほかのプロジェクトも使っていないか確かめてから削除してください。消すと、そのプロジェクトのデータも消えます。'
const REMAINING_SENTENCE = (names: string) =>
  `${TEARDOWN_REMAINING_WARNING_HEAD}。コントロールパネルから直接削除することもできます: ${names}${names.includes('保存場所『') ? `。${STORAGE_CHECK}` : ''}`

/** env.json（同意済みの保存場所）と state.json を置く。レジストリ『myreg』は記録にあり、一覧にも出る（消せる）。 */
function put(env: string[], resources: ResourceRef[], meta: EnvState['meta'] = {}): void {
  setup(dir, { env, resources, meta: { registryName: 'myreg', ...meta } })
  h.registryRows = [REGISTRY_ROW]
}

/** 破棄を1回流し、その場の返り値と、main が書いた記録の両方から TeardownView を作る。2つは必ず同じ。 */
async function run(opts: Record<string, unknown> = GO) {
  const reply = await teardown(EVENT, dir, OK_AUTH, opts)
  const rec = getOps(dir).last?.result
  expect(rec, '終わった操作の結果が記録に無い').toBeTruthy()
  const live = toTeardownView(SHARED, reply)
  const resumed = resumedTeardownView(SHARED, rec)
  expect(resumed, 'その場と開き直しが食い違う').toEqual(live)
  return { reply, live, resumed, rec: rec! }
}

describe('本物の cloud:teardown の返り値を、その場でも記録からでも同じに読む（共用型）', () => {
  it('全部消えた（アプリと保存場所）→ done・appDeleted:true・残ったもの無し・警告無し', async () => {
    put([A], [bucketRef(A), APP])
    const { reply, live } = await run()
    expect(reply).toMatchObject({ ok: true, appDeleted: true })
    expect(live).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [], inProgress: [], warnings: [] })
    expect(live.executed.some(l => l.includes(A))).toBe(true)
  })

  it('アプリは消えて、保存場所が2件残った（先頭の一覧に失敗）→ failed・appDeleted:true・残ったもの2件・「残っている間は課金が続きます」の警告に2件とも', async () => {
    put([A, B], [APP])
    h.fail[`listAllKeys ${A}`] = 'throw'
    const { reply, live, rec } = await run()
    expect(reply).toMatchObject({ ok: false, appDeleted: true, remainingBuckets: [A, B] })
    expect(live).toMatchObject({ ok: false, state: 'failed', appDeleted: true, inProgress: [] })
    expect(live.remaining).toEqual([STORAGE(A), STORAGE(B)])
    expect(live.warnings).toEqual([REMAINING_SENTENCE(`保存場所『${A}』（月額が続きます）・保存場所『${B}』（月額が続きます）`)])
    // 一覧できなかった保存場所は、Koto が中身を確かめていない（共有のものかもしれない）。「削除してください」とだけ言わず、削除する前に確かめてもらう
    expect(reply.message).toContain('消えないときは、さくらのクラウドのコントロールパネル（オブジェクトストレージ）で、ほかのプロジェクトも使っていないか確かめてから削除してください。消すと、そのプロジェクトのデータも消えます。')
    expect(reply.message).not.toContain('オブジェクトストレージ）から削除してください')
    expect((rec.extra as Record<string, unknown>).appDeleted).toBe(true) // 記録の extra が appDeleted を持つ
    expect(h.calls.filter(c => c.startsWith('deleteKeys') || c.startsWith('deleteBucket'))).toEqual([])
  })

  it('保存場所の1件目は消えて、2件目の一覧に失敗 → 残ったものは2件目だけ。消えた1件目は残ったものに入らない', async () => {
    put([A, B], [APP])
    h.fail[`listAllKeys ${B}`] = 'throw'
    const { reply, live } = await run()
    expect(reply).toMatchObject({ ok: false, appDeleted: true, remainingBuckets: [B] })
    expect(live.remaining).toEqual([STORAGE(B)])
    expect(live.warnings).toEqual([REMAINING_SENTENCE(`保存場所『${B}』（月額が続きます）`)])
  })

  it('アプリを消せなかった → failed・appDeleted:false・保存場所には触れず、残ったものも警告も無い', async () => {
    put([A], [bucketRef(A), APP])
    h.fail['deleteApp app-1'] = 'http500'
    const { reply, live } = await run()
    expect(reply).toMatchObject({ ok: false, appDeleted: false })
    expect(live).toMatchObject({ ok: false, state: 'failed', appDeleted: false, remaining: [], inProgress: [], warnings: [] })
    expect(h.calls).toEqual(['deleteApp app-1'])
  })

  it('記録の鍵の無効化に失敗 → 成功のまま。⚠️ の行は起きたことから警告へ移り、その場にも記録にも出る', async () => {
    put([A], [bucketRef(A), APP], { storagePermissionId: 'perm-1' })
    h.fail['deletePermission perm-1'] = 'throw'
    const { reply, live } = await run()
    expect(reply.ok).toBe(true)
    const keyLine = reply.executed.find((l: string) => l.startsWith('⚠️ ') && l.includes(KEY_REVOKE_FAILED_WARNING))
    expect(keyLine).toBeTruthy()
    expect(live).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [] })
    expect(live.warnings).toEqual([keyLine])
    expect(live.executed).not.toContain(keyLine)
  })

  it('ほかのプロジェクトが同じ保存場所を使っている → データだけ消してバケットは残す。成功で、残ったものには入れず、警告だけが言う', async () => {
    put([A], [bucketRef(A), APP])
    h.keys = [`${PREFIX}data.json`, FOREIGN]
    const { reply, live } = await run()
    expect(reply).toMatchObject({ ok: true, appDeleted: true, keptBucketName: A, keptBucketNames: [A] })
    expect(live).toMatchObject({ ok: true, state: 'done', remaining: [] })
    // 残した理由（ほかのプロジェクトも使っている）も事実として返り、文はそれを言う。「後で消す場合は削除して」とは言わない（消すと、そのアプリが止まる）
    expect(reply).toMatchObject({ keptBucketsUsedByOthers: [A] })
    expect(reply.keptBucketsWithOwnFiles).toBeUndefined()
    expect(live.warnings).toEqual(teardownRemainingWarnings({ keptBucketName: A, keptBucketNames: [A], keptBucketsUsedByOthers: [A] }))
    expect(live.warnings[0]).toContain(`『${A}』`)
    expect(live.warnings[0]).toContain('ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。')
    expect(live.warnings[0]).not.toContain('後で消す場合は')
  })

  it('設定（env.json）から外した保存場所（state にだけあった分）→ 言って消す。成功で、警告は出ない', async () => {
    put([], [bucketRef(B), APP])
    const { reply, live } = await run()
    expect(reply).toMatchObject({ ok: true, appDeleted: true })
    expect(live).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [], warnings: [] })
    expect(live.executed.some(l => l.includes(B))).toBe(true)
    expect(h.calls).toContain(`deleteBucket ${B}`)
  })

  it('state にだけあった保存場所の一覧に失敗 → failed・残ったものに B。押し直した回（アプリは無い）も同じ形で読める', async () => {
    put([], [bucketRef(B), APP])
    h.fail[`listAllKeys ${B}`] = 'throw'
    const first = await run()
    expect(first.reply).toMatchObject({ ok: false, appDeleted: true, remainingBuckets: [B] })
    expect(first.live.remaining).toEqual([STORAGE(B)])

    resetProjectOpsForTests(); h.fail = {}; h.calls = []
    // 押し直し: アプリもレジストリ名も記録に無い（確認の選択は出ない）ので、画面は deleteRegistry:false・registryName:null で呼ぶ。保存場所の削除だけをやり直す
    const second = await run({ confirmed: true, deleteRegistry: false, registryName: null })
    expect(second.reply).toMatchObject({ ok: true, appDeleted: true })
    expect(second.live).toMatchObject({ ok: true, state: 'done', remaining: [], warnings: [] })
    expect(h.calls).toContain(`deleteBucket ${B}`)
  })

  it('消せずに残った1件と、ほかが使うので残した1件が同時にある → 警告は 残した保存場所 → 消せずに残った保存場所 の順。残ったものには消せなかった1件だけ', async () => {
    put([A, B], [APP])
    h.keysByBucket[A] = [`${PREFIX}data.json`, FOREIGN]    // A はほかが使う → データだけ消して残す
    h.fail[`listAllKeys ${B}`] = 'throw'                   // B は一覧に失敗 → 残る
    const { reply, live } = await run()
    expect(reply).toMatchObject({ ok: false, appDeleted: true, keptBucketNames: [A], remainingBuckets: [B] })
    expect(live.remaining).toEqual([STORAGE(B)])
    expect(live.warnings).toHaveLength(2)
    expect(live.warnings[0]).toBe(teardownRemainingWarnings({ keptBucketName: A, keptBucketNames: [A], keptBucketsUsedByOthers: [A] })[0])
    expect(live.warnings[1]).toBe(REMAINING_SENTENCE(`保存場所『${B}』（月額が続きます）`))
  })

  it('断られた回（確認の印なし）→ 何も始まっていない失敗。appDeleted は読めず null、残ったものも警告も無い。記録は作られない', async () => {
    put([A], [bucketRef(A), APP])
    const reply = await teardown(EVENT, dir, OK_AUTH, { confirmed: false, deleteRegistry: false, registryName: null })
    const view: TeardownView = toTeardownView(SHARED, reply)
    expect(view).toMatchObject({ ok: false, state: 'failed', appDeleted: null, remaining: [], inProgress: [], warnings: [] })
    expect(h.calls).toEqual([])
    expect(getOps(dir).last).toBeFalsy()
  })
})
