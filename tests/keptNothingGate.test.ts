import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── 何も消さないと分かっている回は、確認を出さず・IPC も呼ばず、画面が結果「⚠️ 破棄していません」を組む（流れ・門・3つの仕様書）──────────────────────
// 門は teardown/keptNothing.ts の1つ（共用型・HANAMII・専有型の3つの仕様書が同じ関数を通る）。決める材料は確認の confirmDestroysNothing と同じもの。
// 偽の口に流し、実際に呼ばれた回数と順を見る（ソースの文字列は読まない・掟10）。本物の main と並べた比べは tests/keptNothingRealMain.test.ts。
//   ・飛ばす回: 消す資源が無く（共用型: アプリ無し・レジストリ名無し／HANAMII: プロジェクトが無く保存場所だけが残った回／専有型: 資源の記録が無く保存場所だけが残った回）、
//     保存場所が1件以上あり、全件に keep がある（cloud:twinFacts が読めた回だけ）。確認 0 回・キー 0 回・IPC 0 回・活動レジストリ 0 回。
//   ・飛ばさない回: 消せる保存場所が1つでもある／keep の読みに失敗／レジストリ名がある／アプリ・プロジェクト・資源がある／保存場所が無い（空の行は今の nothingToDo のまま）
//   ・結果: ok:true・keptOnly・見出しは「⚠️ 破棄していません」（専有型は「⚠️ 削除していません」）・行と黄色の月額の警告は残る
// 変異: 全件 keep でないのに飛ばす／keep の読み失敗を全件 keep と読む／レジストリ名があっても飛ばす／アプリ・プロジェクト・資源があっても飛ばす／
//       飛ばした回に IPC を呼ぶ／3つの仕様書のうち1つだけ門を通さない／📡 の一言を出さない。

vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'tok-active',
  getHanamiiTokenById: async () => 'tok-recorded',
}))

import { runTeardownFlow, electronFlowDeps } from '../src/renderer/teardown/flow'
import { loadTeardownFacts, type TeardownFactsApi } from '../src/renderer/teardown/facts'
import { keptNothingPlacements } from '../src/renderer/teardown/keptNothing'
import { teardownHeadlineOf } from '../src/renderer/teardown/headline'
import { sharedTeardownSpec, type SharedTeardownRecord } from '../src/renderer/teardown/targets/shared'
import { hanamiiTeardownSpec, type HanamiiTeardownRecord } from '../src/renderer/teardown/targets/hanamii'
import { dedicatedTeardownSpec, type DedicatedTeardownRecord } from '../src/renderer/teardown/targets/dedicated'
import type { TargetSpec, TeardownFacts, TeardownPlacement } from '../src/renderer/teardown/types'
import type { ConfirmWithChoicesAnswer, ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { twinsRefusedMessage } from '../src/shared/twinsRefusal'
import KeptNothingHint, { LIST_ROW_FORGET_HINT } from '../src/renderer/components/teardown/KeptNothingHint'
import TeardownResultView from '../src/renderer/components/teardown/TeardownResultView'

const KEEP_TWIN = { risk: 'twin' as const, folders: ['myapp copy'] }
const KEEP_UNREAD = { risk: 'unread' as const, folders: ['broken-env'] }
const A_KEPT: TeardownPlacement = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true, keep: KEEP_TWIN }
const B_KEPT: TeardownPlacement = { bucket: 'koto-data-b', prefix: 'projects/myapp/', shared: true, keep: KEEP_UNREAD }
const A_REMOVING: TeardownPlacement = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
const C_REMOVING: TeardownPlacement = { bucket: 'koto-data-c', prefix: 'projects/myapp/', shared: true }

// 共用型の記録は、消す資源の有無だけが違う。
const SHARED_GHOST: SharedTeardownRecord = {
  appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], keyRecorded: false,
  placements: [{ bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }], stateOnlyBuckets: [],
}
const SHARED_WITH_APP: SharedTeardownRecord = { ...SHARED_GHOST, appNames: ['myapp'] }
const SHARED_WITH_REGISTRY: SharedTeardownRecord = { ...SHARED_GHOST, registryName: 'myreg', registryOrigin: 'owned' }
const SHARED_EMPTY: SharedTeardownRecord = { ...SHARED_GHOST, placements: [] }
// HANAMII: プロジェクトは前回の破棄で消えていて、保存場所だけが残った回（印あり）／プロジェクトがまだある回（印なし）。
const HANAMII_GHOST: HanamiiTeardownRecord = { projectId: 'p-1', name: 'myapp', tokenId: 'tok-1', storageLeftoverBuckets: ['koto-data-a'] }
const HANAMII_WITH_PROJECT: HanamiiTeardownRecord = { ...HANAMII_GHOST, storageLeftoverBuckets: null }
// 専有型: 資源の記録が無く、保存場所だけが残った印の回／資源の記録がある回。
const DEDICATED_GHOST: DedicatedTeardownRecord = { storageLeftoverBucket: 'koto-data-a', storageLeftoverBuckets: ['koto-data-a'] }
const DEDICATED_WITH_RESOURCES: DedicatedTeardownRecord = { ...DEDICATED_GHOST, clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1', applicationName: 'myapp' }

type Door = 'cloud' | 'hanamii' | 'apprunDedicated'
let ipc: Array<{ door: Door; dir: string; opts: any }> = []

function installWindow() {
  ipc = []
  const reply = (door: Door) => async (dir: string, _auth: unknown, opts: unknown) => { ipc.push({ door, dir, opts }); return { ok: true, executed: [], message: '', remaining: {} } }
  ;(globalThis as any).window = {
    electronAPI: {
      cloud: { teardown: reply('cloud'), loadKey: async () => ({ token: 't', secret: 's' }) },
      hanamii: { teardown: reply('hanamii') },
      apprunDedicated: { teardown: reply('apprunDedicated'), onTeardownProgress: () => () => {} },
      win: { setBusy: () => {} },
    },
  }
}
afterEach(() => { delete (globalThis as any).window })

type Case = { name: string; door: Door; spec: TargetSpec<any, any, any>; ghost: unknown; withWork: unknown; headline: string }
const CASES: Case[] = [
  { name: '共用型', door: 'cloud', spec: sharedTeardownSpec, ghost: SHARED_GHOST, withWork: SHARED_WITH_APP, headline: '⚠️ 破棄していません' },
  { name: 'HANAMII', door: 'hanamii', spec: hanamiiTeardownSpec, ghost: HANAMII_GHOST, withWork: HANAMII_WITH_PROJECT, headline: '⚠️ 破棄していません' },
  { name: '専有型', door: 'apprunDedicated', spec: dedicatedTeardownSpec, ghost: DEDICATED_GHOST, withWork: DEDICATED_WITH_RESOURCES, headline: '⚠️ 削除していません' },
]

function factsOf(record: unknown, placements: TeardownPlacement[], over: Partial<TeardownFacts<any>> = {}): TeardownFacts<any> {
  return {
    projectName: 'myapp', record, placements, placementsUnreadable: false, placementsUnreadableCause: null,
    otherTargets: [], otherTargetsUnreadable: false, waitNote: null, refusal: null, ...over,
  }
}

/** 本物の流れと本物の deps の組み立てに、材料だけを差し替えて通す。確認・活動レジストリ・キーの読み出しの回数と順を数える。 */
async function runFlow(spec: TargetSpec<any, any, any>, facts: TeardownFacts<any>, extra: { reportShown?: boolean } = {}) {
  installWindow()
  const order: string[] = []
  const asked: ConfirmOptions[] = []
  const entry = {
    confirm: async (o: ConfirmOptions) => { order.push('confirm'); asked.push(o); return true },
    confirmWithChoices: async (o: ConfirmWithChoicesOptions): Promise<ConfirmWithChoicesAnswer> => { order.push('confirm'); asked.push(o); return { confirmed: true, choices: {} } },
    keyMissingMessage: 'キーがありません（テスト）',
    ...(extra.reportShown ? { reportShown: true } : {}),
  }
  const base = electronFlowDeps('/proj', spec, entry)
  const deps = {
    ...base,
    loadFacts: async () => { order.push('loadFacts'); return facts },
    loadAuth: async (r: any) => { order.push('loadAuth'); return base.loadAuth(r) },
    beginActivity: (label: string, o: any) => { order.push('beginActivity'); return base.beginActivity(label, o) },
    onStart: () => { order.push('onStart') },
  }
  const out = await runTeardownFlow('/proj', spec, deps)
  return { out, order, asked }
}
const FULL_FLOW = ['loadFacts', 'confirm', 'beginActivity', 'onStart', 'loadAuth']
const text = (html: string) => html.replace(/<[^>]*>/g, '')

describe('★★★ 門: 消す資源が無く、保存場所が全件 keep → 確認 0・キー 0・IPC 0・活動レジストリ 0。3つの仕様書とも同じ', () => {
  for (const c of CASES) {
    it(`${c.name}: twin の1件 → 結果は ok:true・keptOnly・keptNothing の印。呼ばれたのは材料の読み込みだけ`, async () => {
      const { out, order, asked } = await runFlow(c.spec, factsOf(c.ghost, [A_KEPT]))
      expect(order, '確認・キー・活動レジストリ・開始のどれかが呼ばれた').toEqual(['loadFacts'])
      expect(asked).toEqual([])
      expect(ipc, 'IPC が呼ばれた').toEqual([])
      expect(out).toMatchObject({ cancelled: false, keptNothing: true, result: { ok: true, keptOnly: true } })
      expect((out as any).nothingToDo, 'nothingToDo ではない（消すものが無いのではなく、消さない）').toBeUndefined()
    })

    it(`${c.name}: 見出しは「${c.headline}」・行は main と同じ文・黄色の月額の警告が残る。「破棄しました」「削除しました」とは言わない`, async () => {
      const { out } = await runFlow(c.spec, factsOf(c.ghost, [A_KEPT]))
      const view = c.spec.toView((out as any).result)
      expect(view).toMatchObject({ ok: true, state: 'done', keptOnly: true })
      expect(teardownHeadlineOf(view, c.spec.words)).toEqual({ text: c.headline, tone: 'yellow' })
      expect(view.executed).toEqual(['保存場所『koto-data-a』のデータは残しました — フォルダ『myapp copy』も同じデータを使っています。'])
      expect(view.warnings, '月額の警告（お金を削らない）').toEqual([
        '⚠️ データの保存場所『koto-data-a』は残るため、月額495円（税込）の課金は続きます。ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。',
      ])
      expect(view.message).toBe('')
      expect(view.remaining).toEqual([])
      const html = text(renderToStaticMarkup(createElement(TeardownResultView, {
        view, notes: [], words: c.spec.words, retryHint: 'x', serviceConsoleUrl: '', storageConsoleUrl: '',
      })))
      expect(html).toContain(c.headline)
      expect(html).not.toContain(c.spec.words.doneHeadline)
      expect(html).not.toContain('AIに相談')
    })

    it(`${c.name}: 確かめられない兄弟（unread）→ 同じく飛ばす。行は「確かめられませんでした」の文・月額の警告は「ほかのプロジェクトも使っています」と言わない`, async () => {
      const { out, order } = await runFlow(c.spec, factsOf(c.ghost, [B_KEPT]))
      expect(order).toEqual(['loadFacts'])
      const view = c.spec.toView((out as any).result)
      expect(view.executed).toEqual(['保存場所『koto-data-b』のデータは残しました — フォルダ『broken-env』の記録を読めないため、同じデータを使っているか確かめられませんでした。'])
      expect(view.warnings).toHaveLength(1)
      expect(view.warnings[0]).toContain('データの保存場所『koto-data-b』は残るため、月額495円（税込）の課金は続きます。')
      expect(view.warnings[0]).not.toContain('ほかのプロジェクトも使っています')
      expect(view.keptOnly).toBe(true)
    })

    it(`${c.name}: 全件 keep の2件（twin と unread）→ 飛ばす。行は2件・警告の月額は2件ぶん`, async () => {
      const { out, order } = await runFlow(c.spec, factsOf(c.ghost, [A_KEPT, B_KEPT]))
      expect(order).toEqual(['loadFacts'])
      const view = c.spec.toView((out as any).result)
      expect(view.executed).toHaveLength(2)
      expect(view.warnings.join('')).toContain('月額990円（税込）')
    })

    it(`${c.name}: 消せる保存場所が1つある（A は keep・C は keep なし）→ 飛ばさない。確認 → キー → IPC が1回`, async () => {
      const { order, asked } = await runFlow(c.spec, factsOf(c.ghost, [A_KEPT, C_REMOVING]))
      expect(order).toEqual(FULL_FLOW)
      expect(asked).toHaveLength(1)
      expect(ipc.map(x => x.door)).toEqual([c.door])
    })

    it(`${c.name}: 保存場所が keep なしの1件だけ → 飛ばさない（今までどおり確認）`, async () => {
      const { order } = await runFlow(c.spec, factsOf(c.ghost, [A_REMOVING]))
      expect(order).toEqual(FULL_FLOW)
      expect(ipc).toHaveLength(1)
    })

    it(`${c.name}: keep の読みに失敗（twinFactsUnreadable。keep は付かない）→ 飛ばさない。確認は今までどおり出て、IPC は1回`, async () => {
      const { order, asked } = await runFlow(c.spec, factsOf(c.ghost, [A_REMOVING], { twinFactsUnreadable: true, refusal: undefined }))
      expect(order).toEqual(FULL_FLOW)
      expect(asked).toHaveLength(1)
      expect(ipc).toHaveLength(1)
    })

    it(`${c.name}: 口が無い（twinFacts を読めていない。refusal も keep も付かない）→ 飛ばさない`, async () => {
      const { order } = await runFlow(c.spec, factsOf(c.ghost, [A_REMOVING], { refusal: undefined }))
      expect(order).toEqual(FULL_FLOW)
    })

    it(`${c.name}: 保存場所の設定を読めなかった（placementsUnreadable）→ 飛ばさない`, async () => {
      const { order } = await runFlow(c.spec, factsOf(c.ghost, [], { placementsUnreadable: true, placementsUnreadableCause: 'call' }))
      expect(order).toEqual(FULL_FLOW)
    })

    it(`${c.name}: 消す資源がある回（${c.name === '共用型' ? 'アプリ' : c.name === 'HANAMII' ? 'プロジェクト' : '資源の記録'}）は、保存場所が全件 keep でも飛ばさない（今までどおり確認 → IPC）`, async () => {
      const { order, asked } = await runFlow(c.spec, factsOf(c.withWork, [A_KEPT]))
      expect(order).toEqual(FULL_FLOW)
      expect(asked).toHaveLength(1)
      expect(ipc).toHaveLength(1)
    })

    it(`${c.name}: 公開先の拒否（複製）が先。ghost でも、結果は main の断りと同じ文の失敗（keptNothing ではない）`, async () => {
      const { out, order } = await runFlow(c.spec, factsOf(c.ghost, [A_KEPT], { refusal: { kind: 'twin', folders: ['copy'] } }))
      expect(order).toEqual(['loadFacts'])
      expect(out).toMatchObject({ cancelled: false, result: { ok: false, message: twinsRefusedMessage(['copy']) } })
      expect((out as any).keptNothing).toBeUndefined()
    })

    it(`${c.name}: reportShown を渡した入口には、見せた保存場所（keepData:true つき）を付ける。渡さない入口には付けない`, async () => {
      const withShown = await runFlow(c.spec, factsOf(c.ghost, [A_KEPT]), { reportShown: true })
      expect(withShown.out).toMatchObject({ keptNothing: true, shownPlacements: [{ bucket: 'koto-data-a', prefix: 'projects/myapp/', keepData: true }] })
      const without = await runFlow(c.spec, factsOf(c.ghost, [A_KEPT]))
      expect('shownPlacements' in (without.out as object)).toBe(false)
    })

    it(`${c.name}: この仕様書が結果の口（keptNothingResult）を持たなければ、門を通らない（安全網。今までどおり確認へ）`, async () => {
      const bare = { ...c.spec, keptNothingResult: undefined } as TargetSpec<any, any, any>
      const { order } = await runFlow(bare, factsOf(c.ghost, [A_KEPT]))
      expect(order).toEqual(FULL_FLOW)
    })

    it(`${c.name}: 口を持つ（3つの仕様書が同じ門を通る。持たない仕様書は門が飛ばせない）`, () => {
      expect(typeof c.spec.keptNothingResult).toBe('function')
    })
  }

  it('共用型: コンテナレジストリの名前がある回は、保存場所が全件 keep でも飛ばさない（レジストリを消す選択が確認に出る）', async () => {
    const { order, asked } = await runFlow(sharedTeardownSpec, factsOf(SHARED_WITH_REGISTRY, [A_KEPT]))
    expect(order).toEqual(FULL_FLOW)
    expect(asked).toHaveLength(1)
    expect(ipc).toHaveLength(1)
  })

  it('保存場所も無い空の行は、今の nothingToDo のまま（共用型: 破棄するものはありません。門は走らない）', async () => {
    const { out, order } = await runFlow(sharedTeardownSpec, factsOf(SHARED_EMPTY, []))
    expect(order).toEqual(['loadFacts'])
    expect(out).toMatchObject({ cancelled: false, nothingToDo: true, result: { ok: false, message: sharedTeardownSpec.words.nothingToDo } })
    expect((out as any).keptNothing).toBeUndefined()
  })

  it('nothingToDo の門が先: 専有型で資源も保存場所の印も無い行は、材料に keep があっても「消すものが記録にありません」', async () => {
    const { out } = await runFlow(dedicatedTeardownSpec, factsOf({}, [A_KEPT]))
    expect(out).toMatchObject({ cancelled: false, result: { ok: false, message: dedicatedTeardownSpec.words.nothingToDo } })
    expect((out as any).keptNothing).toBeUndefined()
  })
})

describe('★★★ keep の読みに失敗した回は、材料の読み込み（loadTeardownFacts）から流れまで通して、確認へ進む（不明を肯定に倒さない）', () => {
  const api = (twinFacts: TeardownFactsApi['twinFacts']): TeardownFactsApi => ({
    placements: async () => [A_REMOVING], otherTargets: async () => [], estimates: async () => null, twinFacts,
  })
  const BROKEN: Array<[string, TeardownFactsApi['twinFacts']]> = [
    ['口が投げた', async () => { throw new Error('IPC が落ちた（テスト）') }],
    ['ok:false', async () => ({ ok: false })],
    ['答えの件数が違う', async () => ({ ok: true, refusal: null, placements: [] })],
    ['keep の形が違う', async (_d, args) => ({ ok: true, refusal: null, placements: args.placements.map(p => ({ ...p, keep: { risk: 'maybe', folders: [] } })) as never })],
    // ok:false なのに、渡した保存場所と同じ並び・名前・件数で、keep の形も整った答え。ok の検査だけがこの答えを退ける
    ['ok:false だが保存場所の答えは整っている', async (_d, args) => ({ ok: false, refusal: null, placements: args.placements.map(p => ({ ...p, keep: { risk: 'twin', folders: ['x'] } })) }) as never],
  ]
  for (const c of CASES) {
    for (const [why, twinFacts] of BROKEN) {
      it(`${c.name} × ${why}: 確認が出て、IPC は1回（飛ばさない）。材料には読めなかった印が付き、保存場所に keep は付かない`, async () => {
        const facts = await loadTeardownFacts('/proj', { target: c.spec.target, readRecord: async () => c.ghost as never }, api(twinFacts))
        expect(facts.twinFactsUnreadable).toBe(true)
        expect(facts.placements.some(p => !!p.keep)).toBe(false)
        const { order, asked } = await runFlow(c.spec, facts)
        expect(order).toEqual(FULL_FLOW)
        expect(asked).toHaveLength(1)
        expect(ipc).toHaveLength(1)
      })
    }
  }
})

describe('★★ 結果の形（仕様書ごと）: main が同じ入力で返す形に揃える', () => {
  it('共用型: appDeleted を付けない（アプリは何も消していない）・skipped や message を作らない', async () => {
    const { out } = await runFlow(sharedTeardownSpec, factsOf(SHARED_GHOST, [A_KEPT]))
    expect((out as any).result).toStrictEqual({
      ok: true,
      executed: ['保存場所『koto-data-a』のデータは残しました — フォルダ『myapp copy』も同じデータを使っています。'],
      keptBucketName: 'koto-data-a',
      keptBucketNames: ['koto-data-a'],
      keptBucketsUsedByOthers: ['koto-data-a'],
      keptOnly: true,
    })
  })

  it('unread だけの回は keptBucketsUsedByOthers を付けない（使っているとは確かめていない）', async () => {
    const { out } = await runFlow(sharedTeardownSpec, factsOf(SHARED_GHOST, [B_KEPT]))
    expect('keptBucketsUsedByOthers' in (out as any).result).toBe(false)
  })

  it('専有型: message は空・remaining は空（資源を何も消していない）', async () => {
    const { out } = await runFlow(dedicatedTeardownSpec, factsOf(DEDICATED_GHOST, [A_KEPT]))
    expect((out as any).result).toMatchObject({ ok: true, message: '', remaining: {}, keptOnly: true })
  })

  it('HANAMII: 画面が組んだ結果だけ keptOnly を読む。main の返り値（keptOnly が付かない）の見出しは今までどおり「✅ 破棄しました」', () => {
    const fromMain = { ok: true, appDeleted: true, executed: ['x'], keptBucketName: 'koto-data-a', keptBucketNames: ['koto-data-a'], keptBucketsUsedByOthers: ['koto-data-a'] }
    expect('keptOnly' in hanamiiTeardownSpec.toView(fromMain)).toBe(false)
    // 付いていても、失敗の回は読まない（成否が先）
    expect('keptOnly' in hanamiiTeardownSpec.toView({ ok: false, keptOnly: true })).toBe(false)
  })
})

describe('★★ 門の純関数（keptNothingPlacements）: 確認の confirmDestroysNothing と同じ材料。残す保存場所だけを返す', () => {
  const pure = (spec: TargetSpec<any, any, any>, record: unknown, placements: TeardownPlacement[], over: Partial<TeardownFacts<any>> = {}) =>
    keptNothingPlacements(spec, factsOf(record, placements, over))

  it('全件 keep → 名前のある保存場所の全件（並びのまま）。名前の無い要素は数えない', () => {
    const got = pure(sharedTeardownSpec, SHARED_GHOST, [A_KEPT, null as any, { bucket: '', keep: KEEP_TWIN }, B_KEPT])
    expect(got?.map(p => p.bucket)).toEqual(['koto-data-a', 'koto-data-b'])
  })

  it('消せる保存場所が混じる → null。keep の無いものだけ → null。保存場所が無い → null', () => {
    expect(pure(sharedTeardownSpec, SHARED_GHOST, [A_KEPT, C_REMOVING])).toBeNull()
    expect(pure(sharedTeardownSpec, SHARED_GHOST, [A_REMOVING])).toBeNull()
    expect(pure(sharedTeardownSpec, SHARED_GHOST, [])).toBeNull()
    expect(pure(sharedTeardownSpec, SHARED_GHOST, null as any)).toBeNull()
  })

  it('不明は肯定に倒さない: 読めなかった印（twinFactsUnreadable・placementsUnreadable）・形の読めない keep でない値は null', () => {
    expect(pure(sharedTeardownSpec, SHARED_GHOST, [A_REMOVING], { twinFactsUnreadable: true })).toBeNull()
    expect(pure(sharedTeardownSpec, SHARED_GHOST, [A_KEPT], { twinFactsUnreadable: true })).toBeNull()
    expect(pure(sharedTeardownSpec, SHARED_GHOST, [A_KEPT], { placementsUnreadable: true })).toBeNull()
    expect(pure(sharedTeardownSpec, SHARED_GHOST, [{ ...A_REMOVING, keep: null as any }])).toBeNull()
    expect(pure(sharedTeardownSpec, SHARED_GHOST, [{ ...A_REMOVING, keep: undefined }])).toBeNull()
  })

  it('3つの仕様書が同じ関数を通る: ghost は通り、資源のある回は通らない', () => {
    for (const c of CASES) {
      expect(pure(c.spec, c.ghost, [A_KEPT]), `${c.name} の ghost`).not.toBeNull()
      expect(pure(c.spec, c.withWork, [A_KEPT]), `${c.name} の資源あり`).toBeNull()
    }
  })

  it('HANAMII: 保存場所だけが残った回で、残っている保存場所の一部が keep でなければ通らない（混在）', () => {
    expect(pure(hanamiiTeardownSpec, { ...HANAMII_GHOST, storageLeftoverBuckets: ['koto-data-a', 'koto-data-c'] }, [A_KEPT, C_REMOVING])).toBeNull()
  })

  it('専有型: 資源の ID が1つでもあれば通らない（4つとも）', () => {
    for (const key of ['clusterID', 'asgID', 'loadBalancerID', 'applicationID'] as const) {
      expect(pure(dedicatedTeardownSpec, { ...DEDICATED_GHOST, [key]: 'x' }, [A_KEPT]), key).toBeNull()
    }
  })

  it('共用型: アプリが1つでもあれば通らない・レジストリ名があれば通らない・設定から外した保存場所だけが消す側なら通らない', () => {
    expect(pure(sharedTeardownSpec, SHARED_WITH_APP, [A_KEPT])).toBeNull()
    expect(pure(sharedTeardownSpec, SHARED_WITH_REGISTRY, [A_KEPT])).toBeNull()
    expect(pure(sharedTeardownSpec, { ...SHARED_GHOST, placements: [...SHARED_GHOST.placements, { bucket: 'koto-data-c', prefix: 'projects/myapp/', shared: true }] }, [A_KEPT, C_REMOVING])).toBeNull()
  })
})

describe('★★ 📡 の一言: 何も消さないと分かっていた回にだけ「この行は「一覧から削除」で消せます。」を添える', () => {
  it('★★★ keptNothing の回は一言を出す。文は作者の決定のとおり1文字も違えない', () => {
    expect(LIST_ROW_FORGET_HINT).toBe('この行は「一覧から削除」で消せます。')
    const html = text(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { keptNothing: true } })))
    expect(html).toBe('この行は「一覧から削除」で消せます。')
  })

  it('★★★ main まで届いて何も消さなかった回（結果の view が keptOnly）にも同じ一言を出す。keptNothing は付かない（その行は main も消さずに残している）', () => {
    const html = text(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { view: { keptOnly: true } } })))
    expect(html).toBe('この行は「一覧から削除」で消せます。')
    expect(text(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { keptNothing: true, view: { keptOnly: true } } })))).toBe(html)
  })

  it('★★★ 何かを消した回（keptNothing も keptOnly も無い。その行は main が消している）には出さない。印は真偽値の true だけを読む', () => {
    expect(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: {} }))).toBe('')
    expect(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { keptNothing: undefined } }))).toBe('')
    expect(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { keptNothing: 'true' as never } }))).toBe('')
    expect(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { view: {} } }))).toBe('')
    expect(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { view: { keptOnly: undefined } } }))).toBe('')
    expect(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { view: { keptOnly: 'true' } } }))).toBe('')
    expect(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { view: { keptOnly: 1 } } }))).toBe('')
    expect(renderToStaticMarkup(createElement(KeptNothingHint, { outcome: { view: null } }))).toBe('')
  })
})
