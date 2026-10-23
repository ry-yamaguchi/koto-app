import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── cloud:teardownRecord（破棄の確認の材料の口。読むだけ・外部へ要求を出さない）と sharedTeardownRecordOf ──────
// 確認の文が名前を出すアプリ・レジストリ・消す保存場所は、ここから来る。run も同じ sharedTeardownRecordOf で消すものを決める
// （P5。その一致は tests/sharedTeardownMeasure.test.ts が、実際に触った保存場所の名前で固定する）。
import { A, B, PREFIX, APP, bucketRef, h, resetHarness, newProjectDir, setup } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { sharedTeardownRecordOf, readSharedTeardownRecord } from '../src/main/ipc/cloudTeardown'
import { loadCloudSpec, loadCloudState } from '../src/main/cloud/specStore'
import { BAD_PROJECT_DIR_MESSAGE } from '../src/main/cloud/teardownShell'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const record = h.handlers.get('cloud:teardownRecord')!
const EVENT = {}

let dir = ''
beforeEach(() => { resetProjectOpsForTests(); resetHarness(); dir = newProjectDir() })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('cloud:teardownRecord: 確認の材料', () => {
  it('アプリ・レジストリ名・借り物・消す保存場所（env.json の同意済み + state にだけあるもの）・state にだけある保存場所を返す', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A), bucketRef(B)], meta: { registryName: 'myreg', registryAdopted: true } })
    expect(await record(EVENT, dir)).toEqual({
      ok: true,
      record: {
        appNames: ['myapp'],
        registryName: 'myreg',
        registryOrigin: 'adopted',
        registryUsers: [],
        placements: [{ bucket: A, prefix: PREFIX, shared: true }, { bucket: B, prefix: PREFIX, shared: true }],
        stateOnlyBuckets: [B],
      },
    })
  })

  it('記録に名前が無い（空文字を含む）レジストリは null。印は false なら owned', async () => {
    setup(dir, { env: [], resources: [APP], meta: { registryName: '', registryAdopted: false } })
    expect((await record(EVENT, dir)).record).toMatchObject({ registryName: null, registryOrigin: 'owned', placements: [], stateOnlyBuckets: [] })
  })

  // ★ 印の3つの状態（2026-10-19）。owned は false のときだけ。無い・型が違うものは unknown（「Koto が作った」とは読まない）。
  // 作者の手元の実例（ScheduleAPP が作った scheduleapp を reminder などが借りている）は、registryName あり・registryAdopted なし。
  it.each([
    ['false', { registryName: 'scheduleapp', registryAdopted: false }, 'owned'],
    ['true', { registryName: 'scheduleapp', registryAdopted: true }, 'adopted'],
    ['印が無い（作者の実例の形）', { registryName: 'scheduleapp' }, 'unknown'],
    ["'false'（文字列）", { registryName: 'scheduleapp', registryAdopted: 'false' }, 'unknown'],
    ['0', { registryName: 'scheduleapp', registryAdopted: 0 }, 'unknown'],
    ['null', { registryName: 'scheduleapp', registryAdopted: null }, 'unknown'],
  ])('registryAdopted が %s → registryOrigin は %s', async (_label, meta, origin) => {
    setup(dir, { env: [], resources: [APP], meta: meta as any })
    expect((await record(EVENT, dir)).record).toMatchObject({ registryName: 'scheduleapp', registryOrigin: origin })
  })

  it('同意の日時が無い env.json の保存場所は数えない。同じ名前が state にあれば「state にだけある」保存場所として数える', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], envExtra: () => ({ consentedAt: undefined }) })
    expect((await record(EVENT, dir)).record).toMatchObject({ placements: [{ bucket: A, prefix: PREFIX, shared: true }], stateOnlyBuckets: [A] })
  })

  it('env.json と state の両方にある保存場所は1件だけ。専用（shared:false）の印は env.json のものを使う', async () => {
    setup(dir, { env: [A], resources: [bucketRef(A)], envExtra: () => ({ shared: false }) })
    expect((await record(EVENT, dir)).record).toMatchObject({ placements: [{ bucket: A, prefix: PREFIX, shared: false }], stateOnlyBuckets: [] })
  })

  it('state.json が無い → アプリ0件・state にだけある保存場所なし', async () => {
    setup(dir, { env: [A], resources: [APP] })
    fs.rmSync(path.join(dir, '.sakura-cloud', 'state.json'))
    expect((await record(EVENT, dir)).record).toMatchObject({ appNames: [], registryName: null, placements: [{ bucket: A }], stateOnlyBuckets: [] })
  })

  it('env.json が無い・壊れている・state.json が壊れている・projectDir が不正 → ok:false（投げない）', async () => {
    setup(dir, { env: [A], resources: [APP] })
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'state.json'), '{ これは JSON ではない', 'utf-8')
    expect(await record(EVENT, dir)).toMatchObject({ ok: false })
    fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), '{ これも JSON ではない', 'utf-8')
    expect(await record(EVENT, dir)).toMatchObject({ ok: false })
    fs.rmSync(path.join(dir, '.sakura-cloud', 'env.json'))
    expect(await record(EVENT, dir)).toEqual({ ok: false, message: 'env.json がありません' })
    // projectDir が文字列でない・空 → 専用の文で断る（'' を通すと、アプリの作業フォルダ直下の .sakura-cloud を読みにいく）
    for (const bad of ['', undefined, null, 42, {}]) {
      expect(await record(EVENT, bad), String(bad)).toEqual({ ok: false, message: BAD_PROJECT_DIR_MESSAGE })
    }
    expect(await record(EVENT, 'relative/dir')).toMatchObject({ ok: false })
  })

  // cloud:registryName は名前だけを返す（2026-10-19）。作ったか借りたかの印は、読む画面が無いまま返すと、誤っても誰も気づかない。
  // 印を使う確認は、押した時点の cloud:teardownRecord が持つ（registryOrigin）。
  it('★ cloud:registryName は名前だけを返す。印（作った・借りた）は返さない', async () => {
    const registryName = h.handlers.get('cloud:registryName')!
    for (const mark of [{ registryAdopted: true }, { registryAdopted: false }, {}]) {
      setup(dir, { env: [], resources: [APP], meta: { registryName: 'myreg', ...mark } })
      expect(await registryName(EVENT, dir), JSON.stringify(mark)).toEqual({ ok: true, name: 'myreg' })
    }
    setup(dir, { env: [], resources: [APP] })
    expect(await registryName(EVENT, dir)).toEqual({ ok: true, name: null })
  })

  it('読むだけ: 外部への要求は0件。記録のファイルも変えない', async () => {
    setup(dir, { env: [A], resources: [APP, bucketRef(A)], meta: { registryName: 'myreg', storagePermissionId: 'perm-1' } })
    const before = ['env.json', 'state.json'].map(f => fs.readFileSync(path.join(dir, '.sakura-cloud', f), 'utf-8'))
    await record(EVENT, dir)
    expect(h.calls).toEqual([])
    expect(['env.json', 'state.json'].map(f => fs.readFileSync(path.join(dir, '.sakura-cloud', f), 'utf-8'))).toEqual(before)
  })

  it('run と同じ関数を通る: 口の答えは、同じ入力への sharedTeardownRecordOf の答えと同じ', async () => {
    setup(dir, { env: [A, B], resources: [APP, bucketRef('koto-data-c')], meta: { registryName: 'myreg' } })
    const spec = loadCloudSpec(dir)!
    const viaHandler = (await record(EVENT, dir)).record
    // 記録から決まる部分は run と同じ関数の答え。口が足すのは、同じレジストリを使うほかのプロジェクト（ここは兄弟がいないので空。tests/sharedTeardownUsers.test.ts）
    expect(viaHandler).toEqual({ ...sharedTeardownRecordOf(spec, loadCloudState(dir, spec)), registryUsers: [] })
    expect(viaHandler).toEqual((readSharedTeardownRecord(dir) as any).record)
    expect(viaHandler.placements.map((p: any) => p.bucket)).toEqual([A, B, 'koto-data-c'])
    expect(viaHandler.stateOnlyBuckets).toEqual(['koto-data-c'])
  })
})
