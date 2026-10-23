import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'

// ── 段階2（2b-1）: P5-確認 ───────────────────────────────────────────────────────────────────────────
// 設計書 docs/teardown-unify-plan.md の 10.7.12「P5-確認」と、親の判断（10.7.16 末尾）の 1。
// 共用型の確認の文が名前を出す保存場所と、本物の main の `cloud:teardown` が実際に一覧・削除した保存場所が、**どの形でも一致する**ことを、
// 画面の流れ（loadTeardownFacts → buildTeardownConfirm → runTeardownFlow）と本物の main（cloud:teardownRecord・storage:placement・cloud:teardown）
// を偽の window でつないで固定する。偽なのは保存場所・client（tests/sharedTeardownHarness.ts）と window の橋だけ。
//   ・確認の文の「次を破棄します」に並ぶ保存場所＝`cloud:teardown` が `listAllKeys` した保存場所（名前も並びも）
//   ・state にだけある保存場所（M2）は「設定から外した保存場所『B』も削除します」と言い、実際にも消す（親の判断 1: 言って消す）
//   ・共用型の仕様書は共通の読み口（storage:placement＝env.json だけ）を呼ばない（呼ぶと M2 の B が確認から落ちる）
import { A, B, APP, OK_AUTH, bucketRef, h, resetHarness, newProjectDir, setup } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import type { ResourceRef } from '../src/main/cloud/state'
import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { resetProjectOpsForTests } from '../src/main/projectOps'
import { runTeardownFlow, electronFlowDeps } from '../src/renderer/teardown/flow'
import { loadTeardownFacts, electronTeardownFactsApi } from '../src/renderer/teardown/facts'
import { buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import { sharedTeardownSpec, SHARED_KEY_MISSING_MESSAGE } from '../src/renderer/teardown/targets/shared'
import type { ConfirmOptions } from '../src/renderer/useConfirm'

registerCloudHandlers({} as any)
const mainTeardown = h.handlers.get('cloud:teardown')!
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const mainPlacement = h.handlers.get('storage:placement')!
const EVENT = {}

let dir = ''
let commonReads = 0
beforeEach(() => {
  resetProjectOpsForTests(); resetHarness(); dir = newProjectDir(); commonReads = 0
  ;(globalThis as any).window = {
    electronAPI: {
      cloud: { teardownRecord: (d: string) => mainRecord(EVENT, d), teardown: (d: string, a: unknown, o: unknown) => mainTeardown(EVENT, d, a, o) },
      // 共通の読み口（env.json の同意済みだけ）。共用型の仕様書は呼ばない（呼ばれたら数える）
      storage: { placement: (d: string) => { commonReads++; return mainPlacement(EVENT, d) } },
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
      stageTiming: { estimates: async () => null },
      win: { setBusy: () => {} },
    },
    dispatchEvent: () => true,
  }
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete (globalThis as any).window })

/** 確認の本文の「次を破棄します」に並ぶ保存場所の名前（『A』『B』）を、並びのまま取り出す。 */
function bucketsNamedInList(body: string): string[] {
  const m = /保存場所((?:『[^』]+』)+)にある、このプロジェクトのデータ/.exec(body)
  return m ? [...m[1].matchAll(/『([^』]+)』/g)].map(x => x[1]) : []
}

/** 画面の流れをそのまま通す: 確認（押した時点の記録から作る）→ yes → cloud:teardown。確認の文と、main が実際に触った保存場所を返す。 */
async function throughFlow() {
  const asked: ConfirmOptions[] = []
  const out = await runTeardownFlow(dir, sharedTeardownSpec, electronFlowDeps(dir, sharedTeardownSpec, {
    confirm: async o => { asked.push(o); return true },
    confirmWithChoices: async o => { asked.push(o); return { confirmed: true, choices: Object.fromEntries(o.choices.map(c => [c.id, false])) } },
    keyMissingMessage: SHARED_KEY_MISSING_MESSAGE,
  }))
  const listed = h.calls.filter(c => c.startsWith('listAllKeys ')).map(c => c.slice('listAllKeys '.length))
  return { out, asked, body: asked[0]?.body ?? '', listed, calls: [...h.calls] }
}

const FORMS: Array<{ form: string; env: string[]; resources: ResourceRef[]; says: string[] }> = [
  { form: 'M1 env に A・state に bucket 無し', env: [A], resources: [APP], says: [A] },
  { form: 'M3 env にも state にも A（bucket が先）', env: [A], resources: [bucketRef(A), APP], says: [A] },
  { form: "M3' env にも state にも A（app が先）", env: [A], resources: [APP, bucketRef(A)], says: [A] },
  { form: 'M4 env に A・B、state に A だけ', env: [A, B], resources: [APP, bucketRef(A)], says: [A, B] },
  { form: "M4' env に B・A（env.json の並びは state の並びと逆）", env: [B, A], resources: [bucketRef(A), APP], says: [B, A] },
  { form: 'M2 env に無い・state に B（設定から外した）', env: [], resources: [bucketRef(B), APP], says: [B] },
  { form: 'M2+ env に A・state に A と B（B は設定から外した）', env: [A], resources: [APP, bucketRef(A), bucketRef(B)], says: [A, B] },
]

describe('P5-確認: 確認の文が名前を出す保存場所 = cloud:teardown が実際に一覧・削除した保存場所（本物の main）', () => {
  for (const f of FORMS) {
    it(`${f.form}: 確認の「次を破棄します」の保存場所も、main が listAllKeys した保存場所も ${f.says.join('・')}（並びまで一致）`, async () => {
      setup(dir, { env: f.env, resources: f.resources })
      const r = await throughFlow()
      expect(r.out).toMatchObject({ cancelled: false, result: { ok: true } })
      expect(bucketsNamedInList(r.body)).toEqual(f.says)           // 確認が言う
      expect(r.listed).toEqual(f.says)                              // 実際に触った（一致）
      for (const b of f.says) {                                      // 言った保存場所は、削除の要求まで届いている
        expect(r.calls).toContain(`deleteKeys ${b}`)
        expect(r.calls).toContain(`deleteBucket ${b}`)
      }
      expect(commonReads).toBe(0)                                    // 共通の読み口（env.json だけ）は使わない
    })
  }

  it('★★★ M2: state にだけある B は、確認が「設定から外した保存場所『B』も削除します」と言い、実際にも消す。env.json の A は「設定から外した」と言わない', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A), bucketRef(B)], meta: { storagePermissionId: 'perm-1' } })
    const r = await throughFlow()
    expect(r.body).toContain('設定から外した保存場所『koto-data-b』も削除します。')
    expect(r.body).not.toContain('設定から外した保存場所『koto-data-a』')
    expect(r.body).not.toContain('削除しません')
    expect(r.listed).toEqual([A, B])
    expect(r.calls).toContain('deletePermission perm-1')
  })

  it('★★★ 共通の読み口（storage:placement）は M2 の B を言わない。共用型の確認が B を言えるのは、記録（cloud:teardownRecord）から作るから', async () => {
    setup(dir, { env: [], resources: [bucketRef(B), APP] })
    expect((await mainPlacement(EVENT, dir)).placements).toEqual([])
    const facts = await loadTeardownFacts(dir, sharedTeardownSpec, electronTeardownFactsApi())
    expect(facts.placements.map(p => p.bucket)).toEqual([B])
    expect(facts.placementsUnreadable).toBe(false)
    expect(bucketsNamedInList(buildTeardownConfirm(sharedTeardownSpec, facts).body)).toEqual([B])
    expect(commonReads).toBe(0)                                      // 材料を読む流れは共通の読み口を呼ばない（上の直接の呼び出しは window を通らない）
  })

  it('★★ env.json にも state にも無い保存場所は、確認にも出ず、触られもしない（ほかのプロジェクトのバケット）', async () => {
    setup(dir, { env: [A], resources: [APP] })
    h.keysByBucket['koto-data-other'] = ['projects/other/data.json']
    const r = await throughFlow()
    expect(r.body).not.toContain('koto-data-other')
    expect(r.calls.some(c => c.includes('koto-data-other'))).toBe(false)
  })

  it('★★ 先頭の保存場所の一覧に失敗 → 止まる。main が触ったのは確認が言った名前の中だけで、残りは確認が言った全件', async () => {
    setup(dir, { env: [A, B], resources: [APP, bucketRef(A)] })
    h.fail[`listAllKeys ${A}`] = 'throw'
    const r = await throughFlow()
    const said = bucketsNamedInList(r.body)
    expect(said).toEqual([A, B])
    expect(r.listed.every(b => said.includes(b))).toBe(true)
    expect((r.out as any).result.ok).toBe(false)
    expect((r.out as any).result.remainingBuckets).toEqual([A, B])
  })

  it('★★ 消すものが無い（アプリも保存場所もレジストリも無い）形: 確認は出ず、main へも要求は出ない（nothingToDo）', async () => {
    setup(dir, { env: [], resources: [] })
    const r = await throughFlow()
    expect(r.asked).toEqual([])
    expect(r.out).toMatchObject({ cancelled: false, nothingToDo: true })
    expect(r.calls).toEqual([])
  })

  it('★★ M0: 確認の印を付けずに main を呼ぶと、保存場所には1本も要求が出ない（流れは必ず確認のあとで印を付ける）', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A), APP] })
    await mainTeardown(EVENT, dir, OK_AUTH, { deleteRegistry: false, registryName: null })
    expect(h.calls).toEqual([])
  })
})
