import { describe, it, expect, afterEach } from 'vitest'
import { runTeardownFlow, electronFlowDeps, type RunTeardownFlowDeps } from '../src/renderer/teardown/flow'
import { buildTeardownConfirm, buildTeardownConfirmBody } from '../src/renderer/teardown/confirm'
import { loadTeardownFacts, type TeardownFactsApi } from '../src/renderer/teardown/facts'
import type { TargetSpec, TeardownFacts, TeardownWords, TeardownPlacement } from '../src/renderer/teardown/types'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import type { ConfirmChoice, ConfirmWithChoicesAnswer, ConfirmWithChoicesOptions } from '../src/renderer/useConfirmChoices'
import { _activeCount, beginActivity } from '../src/renderer/activity'
import { toTeardownView } from '../src/shared/teardownResult'

// ── 段階2（2b-1）: 流れ・確認の文・材料の読み口に足した任意の項目 ──────────────────────────────────────
// 設計書 docs/teardown-unify-plan.md の 10.7.7 (2)・10.7.12「A に足す」・10.7.14 の 1・2・10。親の判断（10.7.16 末尾）の 1（placementsOf）・4（nothingToDoIsOk）。
//   ・choices      … 選択が1件以上なら confirmWithChoices で聞く。無ければ**確認も IPC も出さずに**失敗（confirm へ落とさない）。
//                    答えの confirmed が true 以外・選択の値が boolean でない → 実行しない／false。invoke の opts は { confirmed:true, choices }
//   ・choices 無し  … 今のまま（confirm・opts は { confirmed:true } だけ。HANAMII の呼び出しは 1文字も変わらない）
//   ・notes        … 💾・ほかの公開先の段落のあと、時間の予告と最後の問いの前に足す。無いときの文は変わらない
//   ・placementsOf … 材料の保存場所を、共通の読み口（storage:placement）でなく記録から決める。決めた関数が投げたら 'call'
//   ・nothingToDoIsOk … 消すものが無い回の結果に nothingToDo:true を付ける（付けない仕様書の結果の形は今のまま）
// 偽の仕様書（target は 'hanamii'）で流す。本物の共用型の仕様書は tests/sharedTeardownSpec.test.ts。

type Rec = { projectId: string | null; registry: string | null }
type Auth = { token: string }
type Reply = { ok: boolean; message?: string }

const RECORD: Rec = { projectId: 'p1', registry: 'myreg' }
const AUTH: Auth = { token: 'tok' }
const KEY_MISSING = 'キーが未登録です（テスト）'

const WORDS: TeardownWords = {
  verb: '破棄',
  confirmTitle: 'テストの公開を破棄します',
  confirmLabel: '破棄する',
  activityLabel: 'テストの破棄',
  rowButton: '🗑 破棄',
  running: '破棄しています…',
  doneHeadline: '✅ 破棄しました',
  inProgressHeadline: '⏳ 破棄の途中です',
  failedHeadline: '⚠️ 破棄できませんでした',
  factsUnreadable: '破棄するものの記録を読めませんでした',
  nothingToDo: '破棄するものはありません（テスト）。',
  askAiTarget: 'テスト',
}

const REG: ConfirmChoice = { id: 'deleteRegistry', label: 'レジストリも削除する', defaultChecked: true }

function makeSpec(over: Partial<TargetSpec<Rec, Auth, Reply>> = {}): TargetSpec<Rec, Auth, Reply> {
  return {
    target: 'hanamii',
    handler: 'test:teardown',
    words: WORDS,
    claimsComputeBillingStops: false,
    irreversibleNote: 'always',
    readRecord: async () => RECORD,
    hasWork: r => !!r.projectId,
    targets: r => [`アプリ『${r.projectId}』`],
    loadAuth: async () => AUTH,
    invoke: async () => ({ ok: true }),
    failure: message => ({ ok: false, message }),
    toView: raw => toTeardownView('hanamii', raw),
    ...over,
  }
}

function makeFacts(over: Partial<TeardownFacts<Rec>> = {}): TeardownFacts<Rec> {
  return {
    projectName: 'myapp', record: RECORD, placements: [], placementsUnreadable: false, placementsUnreadableCause: null,
    otherTargets: [], otherTargetsUnreadable: false, waitNote: null, ...over,
  }
}

type FakeOver = Partial<RunTeardownFlowDeps<Rec, Auth, Reply>> & { facts?: TeardownFacts<Rec>; confirmAnswer?: unknown; choicesAnswer?: unknown; noChoicesDep?: boolean }

function fakeDeps(over: FakeOver = {}) {
  const calls = {
    confirm: [] as ConfirmOptions[], confirmWithChoices: [] as ConfirmWithChoicesOptions[],
    invoke: [] as Array<{ opts: unknown; record: Rec }>, begin: 0, started: 0,
  }
  const { facts, confirmAnswer, choicesAnswer, noChoicesDep, ...rest } = over
  const deps: RunTeardownFlowDeps<Rec, Auth, Reply> = {
    loadFacts: async () => facts ?? makeFacts(),
    confirm: async o => { calls.confirm.push(o); return ('confirmAnswer' in over ? confirmAnswer : true) as boolean },
    ...(noChoicesDep ? {} : {
      confirmWithChoices: async (o: ConfirmWithChoicesOptions) => {
        calls.confirmWithChoices.push(o)
        return ('choicesAnswer' in over ? choicesAnswer : { confirmed: true, choices: { deleteRegistry: true } }) as ConfirmWithChoicesAnswer
      },
    }),
    loadAuth: async () => AUTH,
    invoke: async (_dir, _auth, opts, record) => { calls.invoke.push({ opts, record }); return { ok: true } },
    beginActivity: () => { calls.begin++; return () => {} },
    onStart: () => { calls.started++ },
    keyMissingMessage: KEY_MISSING,
    ...rest,
  }
  return { deps, calls }
}

afterEach(() => { delete (globalThis as any).window })

// ═══════════════════════════════════════════════════════════════════════════════
// choices（選択つきの確認）
// ═══════════════════════════════════════════════════════════════════════════════

describe('A 流れ: 選択（choices）つきの確認', () => {
  const withChoices = (over: Partial<TargetSpec<Rec, Auth, Reply>> = {}) => makeSpec({ choices: () => [REG], ...over })

  it('★★★ 選択が1件以上なのに入口が confirmWithChoices を渡していない: 確認も IPC も出さず、活動レジストリにも載せず、失敗の結果（confirm へ落とさない）', async () => {
    const { deps, calls } = fakeDeps({ noChoicesDep: true })
    const out = await runTeardownFlow('/p', withChoices(), deps)
    expect(out.cancelled).toBe(false)
    expect((out as any).result.ok).toBe(false)
    expect((out as any).result.message).toContain('確認を出せませんでした')
    expect(calls.confirm).toEqual([])           // confirm へ落とすと、レジストリを消すかどうかを聞かないまま進んでしまう
    expect(calls.invoke).toEqual([])
    expect(calls.begin).toBe(0)
    expect(calls.started).toBe(0)
  })

  it('★★ 選択つきで聞く: confirm は呼ばず、確認の文（buildTeardownConfirm）に choices を足して渡す', async () => {
    const spec = withChoices()
    const facts = makeFacts()
    const { deps, calls } = fakeDeps({ facts })
    await runTeardownFlow('/p', spec, deps)
    expect(calls.confirm).toEqual([])
    expect(calls.confirmWithChoices).toEqual([{ ...buildTeardownConfirm(spec, facts), choices: [REG] }])
  })

  it('★★★ yes → invoke の opts は { confirmed:true, choices:{ deleteRegistry:<答え> } }（true も false も）', async () => {
    for (const v of [true, false]) {
      const { deps, calls } = fakeDeps({ choicesAnswer: { confirmed: true, choices: { deleteRegistry: v } } })
      const out = await runTeardownFlow('/p', withChoices(), deps)
      expect(out).toEqual({ cancelled: false, result: { ok: true } })
      expect(calls.invoke).toHaveLength(1)
      expect(calls.invoke[0].opts).toEqual({ confirmed: true, choices: { deleteRegistry: v } })
      expect(calls.begin).toBe(1)
    }
  })

  it('★★★ 選択の値は list の id だけ・=== true のときだけ true（知らない id は落ち、boolean でない値・欠けた値は false）', async () => {
    const two = makeSpec({ choices: () => [REG, { id: 'other', label: '別', defaultChecked: false }] })
    const { deps, calls } = fakeDeps({ choicesAnswer: { confirmed: true, choices: { deleteRegistry: 'yes', stranger: true } } })
    await runTeardownFlow('/p', two, deps)
    expect(calls.invoke[0].opts).toEqual({ confirmed: true, choices: { deleteRegistry: false, other: false } })
    const { deps: d2, calls: c2 } = fakeDeps({ choicesAnswer: { confirmed: true } })      // choices ごと欠けた答え
    await runTeardownFlow('/p', two, d2)
    expect(c2.invoke[0].opts).toEqual({ confirmed: true, choices: { deleteRegistry: false, other: false } })
    const { deps: d3, calls: c3 } = fakeDeps({ choicesAnswer: { confirmed: true, choices: { deleteRegistry: 1, other: true } } })
    await runTeardownFlow('/p', two, d3)
    expect(c3.invoke[0].opts).toEqual({ confirmed: true, choices: { deleteRegistry: false, other: true } })
  })

  it.each([
    ['やめる', { confirmed: false, choices: {} }],
    ["confirmed が 'yes'", { confirmed: 'yes', choices: { deleteRegistry: true } }],
    ['confirmed が 1', { confirmed: 1, choices: { deleteRegistry: true } }],
    ['confirmed が無い', { choices: { deleteRegistry: true } }],
    ['答えが undefined', undefined],
    ['答えが null', null],
    ['答えが true（選択の答えの形でない）', true],
  ])('★★★ %s → cancelled。IPC は0回・キーも読まず・活動レジストリにも載せない', async (_label, answer) => {
    const { deps, calls } = fakeDeps({ choicesAnswer: answer })
    const out = await runTeardownFlow('/p', withChoices(), deps)
    expect(out).toEqual({ cancelled: true })
    expect(calls.invoke).toEqual([])
    expect(calls.begin).toBe(0)
    expect(calls.started).toBe(0)
  })

  it('★★ 選択が空の配列を返すなら、今までの確認（confirm）で聞く。opts は { confirmed:true } だけ（choices の鍵が付かない）', async () => {
    const { deps, calls } = fakeDeps()
    const out = await runTeardownFlow('/p', makeSpec({ choices: () => [] }), deps)
    expect(out).toEqual({ cancelled: false, result: { ok: true } })
    expect(calls.confirm).toHaveLength(1)
    expect(calls.confirmWithChoices).toEqual([])
    expect(calls.invoke[0].opts).toEqual({ confirmed: true })
    expect(Object.keys(calls.invoke[0].opts as object)).toEqual(['confirmed'])
  })

  it('★★ 選択を持たない仕様書（HANAMII）: confirm で聞き、confirmWithChoices は使わない。opts は { confirmed:true } だけ', async () => {
    const { deps, calls } = fakeDeps()
    await runTeardownFlow('/p', makeSpec(), deps)
    expect(calls.confirm).toHaveLength(1)
    expect(calls.confirmWithChoices).toEqual([])
    expect(Object.keys(calls.invoke[0].opts as object)).toEqual(['confirmed'])
  })

  it('★ 選択は記録（facts.record）から作る（押した時点の記録）', async () => {
    const seen: Rec[] = []
    const { deps } = fakeDeps({ facts: makeFacts({ record: { projectId: 'p9', registry: 'r9' } }) })
    await runTeardownFlow('/p', makeSpec({ choices: r => { seen.push(r); return [REG] } }), deps)
    expect(seen).toEqual([{ projectId: 'p9', registry: 'r9' }])
  })

  it('★ 活動レジストリ: 選択つきでも、確認が済んでから載せ、終われば外す（本物の beginActivity）', async () => {
    ;(globalThis as any).window = { electronAPI: { win: { setBusy: () => {} } }, dispatchEvent: () => true }
    const base = _activeCount()
    const whileAsking: number[] = []
    const whileInvoking: number[] = []
    const { deps } = fakeDeps({
      beginActivity,
      confirmWithChoices: async () => { whileAsking.push(_activeCount()); return { confirmed: true, choices: { deleteRegistry: true } } },
      invoke: async () => { whileInvoking.push(_activeCount()); return { ok: true } },
    })
    await runTeardownFlow('/p', withChoices(), deps)
    expect(whileAsking).toEqual([base])        // 聞いている間は載っていない
    expect(whileInvoking).toEqual([base + 1])  // 実行中は載っている
    expect(_activeCount()).toBe(base)          // 終われば外れる
  })

  it('★ electronFlowDeps: confirmWithChoices は入口が渡したときだけ deps に載る（渡さない入口は載らない）', () => {
    const spec = makeSpec()
    const without = electronFlowDeps('/p', spec, { confirm: async () => true, keyMissingMessage: KEY_MISSING })
    expect('confirmWithChoices' in without).toBe(false)
    const fn = async () => ({ confirmed: true, choices: {} })
    const withIt = electronFlowDeps('/p', spec, { confirm: async () => true, confirmWithChoices: fn, keyMissingMessage: KEY_MISSING })
    expect(withIt.confirmWithChoices).toBe(fn)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// nothingToDoIsOk（消すものが無い回）
// ═══════════════════════════════════════════════════════════════════════════════

describe('A 流れ: 消すものが記録に無い回（幽霊の行）と nothingToDo の印', () => {
  const ghost = makeFacts({ record: { projectId: null, registry: null } })

  it('★★★ nothingToDoIsOk の仕様書: 確認0・IPC0・活動レジストリ0。結果に nothingToDo:true が付く（文は仕様書の nothingToDo）', async () => {
    const { deps, calls } = fakeDeps({ facts: ghost })
    const out = await runTeardownFlow('/p', makeSpec({ nothingToDoIsOk: true }), deps)
    expect(out).toEqual({ cancelled: false, result: { ok: false, message: WORDS.nothingToDo }, nothingToDo: true })
    expect(calls.confirm).toEqual([])
    expect(calls.confirmWithChoices).toEqual([])
    expect(calls.invoke).toEqual([])
    expect(calls.begin).toBe(0)
  })

  it('★★★ 印の無い仕様書（HANAMII・専有型）: 結果は今のまま { cancelled:false, result } だけ（nothingToDo の鍵が付かない）', async () => {
    const { deps } = fakeDeps({ facts: ghost })
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: false, result: { ok: false, message: WORDS.nothingToDo } })
    expect('nothingToDo' in out).toBe(false)
  })

  it('nothingToDoIsOk でも、消すものがある回には nothingToDo が付かない（確認して実行した結果）', async () => {
    const { deps } = fakeDeps()
    const out = await runTeardownFlow('/p', makeSpec({ nothingToDoIsOk: true }), deps)
    expect(out).toEqual({ cancelled: false, result: { ok: true } })
    expect('nothingToDo' in out).toBe(false)
  })

  it('材料が読めない回は nothingToDo ではなく読めなかった失敗（消すものが分からないまま「無い」と言わない）', async () => {
    const { deps } = fakeDeps({ loadFacts: async () => { throw new Error('壊れています') } })
    const out = await runTeardownFlow('/p', makeSpec({ nothingToDoIsOk: true }), deps)
    expect('nothingToDo' in out).toBe(false)
    expect((out as any).result.message).toContain('破棄するものの記録を読めませんでした')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// notes（確認の本文に足す段落）
// ═══════════════════════════════════════════════════════════════════════════════

describe('B 確認の文: 仕様書が足す段落（notes）', () => {
  const P: TeardownPlacement = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
  const body = (specOver: Partial<TargetSpec<Rec, Auth, Reply>> = {}, factsOver: Partial<TeardownFacts<Rec>> = {}) =>
    buildTeardownConfirm(makeSpec(specOver), makeFacts(factsOver)).body

  it('★★★ notes が無い・空の仕様書: 文は今のまま（1文字も変わらない）', () => {
    const plain = body({}, { placements: [P], otherTargets: ['Vercel'], waitNote: '⏳ 時間がかかります。' })
    expect(body({ notes: () => [] }, { placements: [P], otherTargets: ['Vercel'], waitNote: '⏳ 時間がかかります。' })).toBe(plain)
    expect(body({ notes: () => ['', ''] }, { placements: [P], otherTargets: ['Vercel'], waitNote: '⏳ 時間がかかります。' })).toBe(plain)
  })

  it('★★★ 置き場所: 💾・ほかの公開先の段落のあと、時間の予告と最後の問いの前。足した順に並ぶ', () => {
    const text = body({ notes: () => ['🔗 NOTE-ONE', '⚠️ NOTE-TWO'] }, { placements: [P], otherTargets: ['Vercel'], waitNote: '⏳ WAIT' })
    const at = (s: string) => text.indexOf(s)
    expect(at('次を破棄します')).toBeGreaterThanOrEqual(0)
    expect(at('💾 ')).toBeGreaterThan(at('次を破棄します'))
    expect(at('Vercel でも使っているため')).toBeGreaterThan(at('💾 '))
    expect(at('🔗 NOTE-ONE')).toBeGreaterThan(at('Vercel でも使っているため'))
    expect(at('⚠️ NOTE-TWO')).toBeGreaterThan(at('🔗 NOTE-ONE'))
    expect(at('⏳ WAIT')).toBeGreaterThan(at('⚠️ NOTE-TWO'))
    expect(at('この操作は元に戻せません')).toBeGreaterThan(at('⏳ WAIT'))
    // 段落（空行で区切られる）として入る
    expect(text).toContain('\n\n🔗 NOTE-ONE\n\n⚠️ NOTE-TWO\n\n')
  })

  it('notes は記録（facts.record）から作る', () => {
    const seen: Rec[] = []
    body({ notes: r => { seen.push(r); return [] } }, { record: { projectId: 'p7', registry: null } })
    expect(seen).toEqual([{ projectId: 'p7', registry: null }])
  })

  it('buildTeardownConfirmBody: notes を渡さない呼び方（手本と同じ形）は今のまま', () => {
    const args = { verb: '破棄' as const, targets: ['A'], placements: [P], dataNote: '保存場所の文', claimsComputeBillingStops: false, irreversibleNote: 'always' as const }
    expect(buildTeardownConfirmBody(args)).toBe(buildTeardownConfirmBody({ ...args, notes: undefined }))
    expect(buildTeardownConfirmBody(args)).toBe(buildTeardownConfirmBody({ ...args, notes: [] }))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// placementsOf（記録から決める保存場所）
// ═══════════════════════════════════════════════════════════════════════════════

describe('材料の読み口: 記録から保存場所を決める仕様書（placementsOf）', () => {
  const A: TeardownPlacement = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
  const B: TeardownPlacement = { bucket: 'koto-b', prefix: 'projects/myapp/', shared: true }
  function fakeApi(over: Partial<TeardownFactsApi> = {}) {
    const calls = { placements: 0 }
    const api: TeardownFactsApi = {
      placements: async () => { calls.placements++; return [A] },
      otherTargets: async () => [],
      estimates: async () => null,
      ...over,
    }
    return { api, calls }
  }

  it('★★★ placementsOf があれば、その答えが材料の保存場所になり、共通の読み口（storage:placement）は呼ばない', async () => {
    const { api, calls } = fakeApi()
    const facts = await loadTeardownFacts('/p', { ...makeSpec(), placementsOf: () => [B] }, api)
    expect(facts.placements).toEqual([B])
    expect(facts.placementsUnreadable).toBe(false)
    expect(facts.placementsUnreadableCause).toBeNull()
    expect(calls.placements).toBe(0)
  })

  it('★ placementsOf には読んだ記録を渡す', async () => {
    const seen: Rec[] = []
    const { api } = fakeApi()
    await loadTeardownFacts('/p', { ...makeSpec(), readRecord: async () => ({ projectId: 'p5', registry: null }), placementsOf: r => { seen.push(r); return [] } }, api)
    expect(seen).toEqual([{ projectId: 'p5', registry: null }])
  })

  it('★★ placementsOf が空を返せば、保存場所は無い（読めなかったではない）。共通の読み口には倒れない', async () => {
    const { api, calls } = fakeApi()
    const facts = await loadTeardownFacts('/p', { ...makeSpec(), placementsOf: () => [] }, api)
    expect(facts.placements).toEqual([])
    expect(facts.placementsUnreadable).toBe(false)
    expect(calls.placements).toBe(0)
  })

  it('★★★ placementsOf が投げたら、名前を挙げられない（空に倒すが「読めなかった」事実が残る。理由は call）', async () => {
    const { api } = fakeApi()
    const facts = await loadTeardownFacts('/p', { ...makeSpec(), placementsOf: () => { throw new Error('壊れた記録') } }, api)
    expect(facts.placements).toEqual([])
    expect(facts.placementsUnreadable).toBe(true)
    expect(facts.placementsUnreadableCause).toBe('call')
  })

  it('★ placementsOf が無い仕様書（HANAMII・専有型）は、今までどおり共通の読み口を1回呼ぶ', async () => {
    const { api, calls } = fakeApi()
    const facts = await loadTeardownFacts('/p', makeSpec(), api)
    expect(facts.placements).toEqual([A])
    expect(calls.placements).toBe(1)
  })
})
