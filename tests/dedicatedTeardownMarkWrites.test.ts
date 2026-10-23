import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 何を固定するか（0.6.22 段階3B の検分の指摘。設計書 docs/teardown-unify-plan.md 10.11.14 の C-4・C-3 の続き）──────────────────
// 専有型の削除 `apprunDedicated:teardown` を、本物の main（ハンドラ・骨・teardownFlow・保存場所の片づけ）に、偽の HTTP サーバと偽の保存場所で流す。
//   M  押し直しの印（storageLeftoverBucket(s)）を書けなかった・下ろせなかった回は、黙らずに結果へ知らせの行を足す
//      （双子の HANAMII は withLeftoverMark が同じことをする＝tests/hanamiiTeardownLeftover.test.ts）。印が無いと、行は残っても
//      押し直しの 🗑 が「記録にありません」で止まり、月額が続く保存場所に辿れない。印が残ったまま「すべて削除しました」と出るのも同じ穴。
//   N  計算資源に何もしなかった回（保存場所だけを片づけた押し直し）の message に、「記録がありません（何も作られていません）」を載せない
//   K  バケットごと消したのに設定（env.json）から外せなかった回の警告 / 他のプロジェクトのデータがあるので残した保存場所は、止まった回の結果にも載る
// 偽物は tests/dedicatedTeardownShellMocks.ts、下ごしらえは tests/dedicatedTeardownShellHarness.ts。
// 期待の文は書き下す（実装の定数を通すと、文が変わっても気づけない）。

vi.mock('electron', async () => (await import('./dedicatedTeardownShellMocks')).electronMock())
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./dedicatedTeardownShellMocks')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/apprunDedicatedApply', async (orig) => (await import('./dedicatedTeardownShellMocks')).applyMock(await orig()))
vi.mock('../src/main/publishMetaFs', async (orig) => (await import('./dedicatedTeardownShellMocks')).publishMetaMock(await orig()))
vi.mock('../src/main/cloud/storageForTarget', async (orig) => (await import('./dedicatedTeardownShellMocks')).storageForTargetMock(await orig()))

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { summarizeResult } from '../src/main/projectOps'
import { toTeardownView } from '../src/shared/teardownResult'
import { h } from './dedicatedTeardownShellMocks'
import { AUTH, EVENT, PREFIX, setupEach, teardownEach, startServer, CLUSTER_GONE, project, targetsOf } from './dedicatedTeardownShellHarness'

registerApprunDedicatedHandlers({} as any)
const teardown = h.handlers.get('apprunDedicated:teardown')!

const A = 'koto-data-a'
const B = 'koto-data-b'
const D = 'sakura-apprun-dedicated' as const
const GO = { confirmed: true }

let dir = ''
beforeEach(() => { dir = setupEach() })
afterEach(() => { teardownEach() })

const run = async () => { await startServer(CLUSTER_GONE); return teardown(EVENT, dir, AUTH, GO) }
/** 押し直し（資源の記録はもう空）。さくらへの要求は出ないので、偽サーバは要らない。 */
const rerun = () => teardown(EVENT, dir, AUTH, GO)
const rowExists = (): boolean => targetsOf().includes(D)
const envBuckets = (): string[] => JSON.parse(fs.readFileSync(path.join(dir, '.sakura-cloud', 'env.json'), 'utf-8'))?.persistence?.objectStorage?.map((b: any) => b.bucket) ?? []
const warnedOf = (r: { executed: string[] }): string[] => r.executed.filter(l => l.startsWith('⚠️'))
const marks = () => { const rec = readApprunDedicatedFs(dir); return [rec.storageLeftoverBucket ?? null, rec.storageLeftoverBuckets ?? null] }

/** 残っている保存場所の名前を書く回（印を書く）／印を下ろす回（null で書く）。 */
const writesMark = (patch: Record<string, unknown>) => Array.isArray(patch.storageLeftoverBuckets)
const clearsMark = (patch: Record<string, unknown>) => 'storageLeftoverBuckets' in patch && patch.storageLeftoverBuckets === null

const MARK_FAILED = '⚠️ 残っている保存場所を公開の記録に書けませんでした。さくらのクラウドのコントロールパネル（オブジェクトストレージ）で、残っている保存場所を確かめて削除してください。'
const CLEAR_FAILED = '⚠️ 保存場所は残っていませんが、公開の記録の「保存場所が残っている」印を消せませんでした。フォルダの書き込み権限を確かめて、もう一度削除を実行してください。'
const LEFTOVER_AB = '\n保存場所『koto-data-a』『koto-data-b』が残っています（消すまで月額が続きます）。'

// ── M 押し直しの印を書けない・下ろせない ──────────────────────────────────

describe('M 押し直しの印を書けなかった回は、黙らず結果に知らせの行を足す（ok・残りの名前・行は変えない）', () => {
  it('★★★ 保存場所2件の1件目の一覧に失敗 → 印を書けない。警告が1行付く。行は残る・message は残りの全件を言う・印は書けていない。画面の結果にも開き直した記録にも出る', async () => {
    project({ storage: [A, B] })
    h.listThrowsFor = new Set([A])
    h.failRecordWrite = writesMark

    const r = await run()

    expect(r.ok).toBe(false)
    expect(r.remainingBuckets).toEqual([A, B])
    expect(r.message).toContain(LEFTOVER_AB)
    expect(warnedOf(r)).toEqual([MARK_FAILED])
    expect(rowExists(), '保存場所が残ったので行は残る（D1）').toBe(true)
    expect(marks(), '前提: 印は書けていない').toEqual([null, null])
    expect(toTeardownView(D, r).warnings).toContain(MARK_FAILED)
    expect(summarizeResult(r).warnings).toContain(MARK_FAILED)
  })

  it('★★★ 片づけそのものが投げた回も同じ（全件が残っている側に倒す回。印を書けなければ知らせる）', async () => {
    project({ storage: [A, B] })
    h.storageThrows = true
    h.failRecordWrite = writesMark

    const r = await run()

    expect(r.ok).toBe(false)
    expect(r.message).toContain('保存場所を削除できませんでした: 片づけが投げました（テスト）')
    expect(r.message).toContain(LEFTOVER_AB)
    expect(warnedOf(r)).toEqual([MARK_FAILED])
    expect(r.executed[0], '計算資源の削除の行は、知らせより前に残る').not.toBe(MARK_FAILED)
    expect(marks()).toEqual([null, null])
    expect(toTeardownView(D, r).warnings).toContain(MARK_FAILED)
  })

  it('★★ 印を書けた回は、この知らせを付けない（言い違えない）。印は先頭1件と全件の両方', async () => {
    project({ storage: [A, B] })
    h.listThrowsFor = new Set([A])

    const r = await run()

    expect(r.ok).toBe(false)
    expect(warnedOf(r)).toEqual([])
    expect(marks()).toEqual([A, [A, B]])
  })

  it('★★ 保存場所へ接続できない回（片づいたものが無い）も、印を書けなければ知らせる', async () => {
    project({ storage: [A, B] })
    h.listThrowsFor = new Set([A, B])
    h.failRecordWrite = writesMark
    const r = await run()
    expect(r.ok).toBe(false)
    expect(warnedOf(r)).toEqual([MARK_FAILED])
  })
})

describe('M 押し直しの印を下ろせなかった回も、黙らない。もう一度実行すれば下りる', () => {
  const STORED = { clusterID: 'c1', storageLeftoverBucket: A, storageLeftoverBuckets: [A, B] }

  it('★★★ 保存場所が0件になっていた回（env.json から外れている）に印を下ろせない → 警告が1行。印は残る。もう一度実行すると下りて、警告は出ない', async () => {
    project({ storage: [], record: STORED })
    h.failRecordWrite = clearsMark

    const r = await run()

    expect(r.ok).toBe(true)
    expect(warnedOf(r)).toEqual([CLEAR_FAILED])
    expect(marks(), '前提: 印が下りていない').toEqual([A, [A, B]])
    expect(toTeardownView(D, r).warnings).toContain(CLEAR_FAILED)

    h.failRecordWrite = null
    const again = await rerun()
    expect(again.ok).toBe(true)
    expect(warnedOf(again)).toEqual([])
    expect(marks()).toEqual([null, null])
  })

  it('★★★ 全部片づいた回に、印を下ろす最後の書き込みが失敗 → 警告が1行（結果の最後）。印は残る。もう一度実行すると下りる', async () => {
    project({ storage: [A], record: { clusterID: 'c1', storageLeftoverBucket: A, storageLeftoverBuckets: [A] } })
    h.failRecordWrite = clearsMark

    const r = await run()

    expect(r.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([A])
    expect(warnedOf(r)).toEqual([CLEAR_FAILED])
    expect(r.executed.at(-1), '知らせは起きたことの最後').toBe(CLEAR_FAILED)
    expect(marks()).toEqual([A, [A]])
    expect(summarizeResult(r).warnings).toContain(CLEAR_FAILED)

    h.failRecordWrite = null
    const again = await rerun()
    expect(again.ok).toBe(true)
    expect(warnedOf(again)).toEqual([])
    expect(marks()).toEqual([null, null])
  })

  it('★★ 印が元から無い記録で、最後の書き込みが失敗しても、「印を消せなかった」とは言わない（残っていない印を言い違えない）', async () => {
    project({ storage: [A] })
    h.failRecordWrite = clearsMark

    const r = await run()

    expect(r.ok).toBe(true)
    expect(r.executed.join('\n')).not.toContain('印を消せませんでした')
    expect(warnedOf(r)).toEqual([])
  })
})

// ── N 計算資源に何もしなかった回の message ──────────────────────────────────

describe('N 保存場所だけを片づけた押し直しは、「記録がありません（何も作られていません）」を message に持たない', () => {
  const NO_RECORD = '記録がありません（このプロジェクトでは何も作られていません）。'
  const FLOW_DONE = '削除の要求はすべて受け付けられ、一覧から消えたことを確認しました。コントロールパネルでもご確認ください。'

  it('★★★ 保存場所だけが残った記録を押し直して全部片づく → ok・保存場所の削除の行が出て、message は空。さくらへの要求は0本。画面に渡す view の message も空', async () => {
    project({ storage: [A, B], record: { storageLeftoverBucket: A, storageLeftoverBuckets: [A, B] } })
    const calls = await startServer({})

    const r = await teardown(EVENT, dir, AUTH, GO)

    expect(calls, '計算資源は記録に無いので、さくらへは何も要求しない').toEqual([])
    expect(r.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([A, B])
    expect(r.executed.filter((l: string) => l.startsWith('保存場所'))).toHaveLength(2)
    expect(r.message).toBe('')
    expect(toTeardownView(D, r).message).toBe('')
    expect(JSON.stringify(r)).not.toContain(NO_RECORD)
  })

  it('★★ 保存場所が0件で印だけ下ろす押し直し（executed も空）も、message は空', async () => {
    project({ storage: [], record: { storageLeftoverBucket: A } })
    await startServer({})
    const r = await teardown(EVENT, dir, AUTH, GO)
    expect(r.ok).toBe(true)
    expect(r.executed).toEqual([])
    expect(r.message).toBe('')
    expect(marks()).toEqual([null, null])
  })

  it('★★ 計算資源を実際に消した回の message は、流れの文のまま（空にするのは何も消さなかった回だけ）', async () => {
    project({ storage: [A] })
    const r = await run()
    expect(r.ok).toBe(true)
    expect(r.executed.some((l: string) => l.includes('クラスタ'))).toBe(true)
    expect(r.message).toBe(FLOW_DONE)
  })
})

// ── K 止まった回・外せなかった回の事実 ──────────────────────────────────────

describe('K 外せなかった設定・残した保存場所の事実は、結果に載る', () => {
  const FORGET_FAILED = '⚠️ 保存場所の記録（公開の設定）は残しています。次に公開する前に、【公開】の「保存場所を用意する」からやり直してください'

  it('★★★ バケットごと消したのに設定（env.json）から外せなかった → 起きたことの最後に警告が1行。画面の結果にも記録にも出る。設定にはバケットが残る。外せた回は出ない', async () => {
    project({ storage: [A] })
    h.forgetBucketsFails = true

    const r = await run()

    expect(r.ok).toBe(true)
    expect(h.deletedBuckets).toEqual([A])
    expect(warnedOf(r)).toEqual([FORGET_FAILED])
    expect(r.executed.at(-1)).toBe(FORGET_FAILED)
    expect(toTeardownView(D, r).warnings).toContain(FORGET_FAILED)
    expect(summarizeResult(r).warnings).toContain(FORGET_FAILED)
    expect(envBuckets(), '前提: 設定から外せていない').toEqual([A])
  })

  it('★★ 外せた回は、この警告を付けない。設定からバケットが消える', async () => {
    project({ storage: [A] })
    const r = await run()
    expect(r.ok).toBe(true)
    expect(warnedOf(r)).toEqual([])
    expect(envBuckets()).toEqual([])
  })

  it('★★★ 1件目は他のプロジェクトのデータがあるので残し、2件目で止まった回 → 残した保存場所（keptBucketName(s)）が結果に載り、月額が続く警告になる。残りは2件目だけ', async () => {
    project({ storage: [A, B] })
    h.keysFor.set(A, [`${PREFIX}.koto-keep`, 'projects/other/data.json'])
    h.listThrowsFor = new Set([B])

    const r = await run()

    expect(r.ok).toBe(false)
    expect(h.deletedBuckets, '1件目は他のプロジェクトのデータがあるのでバケットごとは消さない。2件目は触れていない').toEqual([])
    expect(r.keptBucketName).toBe(A)
    expect(r.keptBucketNames).toEqual([A])
    expect(r.remainingBuckets).toEqual([B])
    expect(r.remaining).toMatchObject({ storageBucket: B })
    expect(envBuckets(), '残した保存場所も、止まった保存場所も、設定には残る').toEqual([A, B])
    const kept = (warnings: string[]) => warnings.filter(w => w.includes('データの保存場所『koto-data-a』は残るため、月額'))
    expect(kept(toTeardownView(D, r).warnings), '画面の結果').toHaveLength(1)
    expect(kept(summarizeResult(r).warnings), '開き直した記録').toHaveLength(1)
    expect(toTeardownView(D, r).warnings.join('\n')).not.toContain('『koto-data-b』は残るため')
    expect(marks()).toEqual([B, [B]])
  })
})
