import { describe, it, expect, afterEach } from 'vitest'
import {
  runTeardownFlow, electronFlowDeps, type RunTeardownFlowDeps,
} from '../src/renderer/teardown/flow'
import {
  buildTeardownConfirm, buildTeardownConfirmBody, unreadableCautions, teardownKindsOf,
} from '../src/renderer/teardown/confirm'
import type { TargetSpec, TeardownFacts, TeardownWords, TeardownPlacement } from '../src/renderer/teardown/types'
import type { ConfirmOptions } from '../src/renderer/useConfirm'
import { PUBLISH_CLOSE_WARNING, _activeCount, _blockingCount } from '../src/renderer/activity'
import { toTeardownView } from '../src/shared/teardownResult'
import { teardownDataNoteForAll } from '../src/shared/teardownSupport'
// 確認の文の比べは、0.6.21 の手本が返した文の写し（golden）と比べる（3B-0 で向け直し。手本は 3B-7 で消えた）。
// ここで専有型の仕様書から借りているのは、偽の仕様書に渡す**入力側**の小さな関数（消すものの名前・時間の予告・幽霊の行の案内）だけ。
import { dedicatedTeardownTargets, lbWaitNote, DEDICATED_NOTHING_TO_DELETE_MESSAGE as NOTHING_TO_DELETE_MESSAGE } from '../src/renderer/teardown/targets/dedicated'
import {
  GOLDEN_CONFIRM_CASES, GOLDEN_FULL_RECORD, INTENDED_CONFIRM_DIFFERENCES, ADDED_SENTENCE, OLD_EXAMPLE, NEW_EXAMPLE, T161_NEW, readGolden,
  type GoldenConfirmCase, type GoldenRecord,
} from './dedicatedGoldenCases'

// ── 段階0（0a）: 破棄（削除）の共通の流れ（flow.ts）と確認の文（confirm.ts）──────────────────────────────────────
//
// この単位では、どの入口・IPC からもまだ呼ばれない（部品と単体テストだけ）。公開先ごとの違いは仕様書（TargetSpec）に置くので、
// ここでは本物の入口を使わず、**偽の仕様書**（target は 'hanamii'）で流す。
//
//   A 流れの歯止め … 確認が no なら IPC は0回。確認の答えが true 以外でも0回。キーなし・例外・材料が読めない・幽霊の行。
//   B 確認の文   … 保存場所の全件・HANAMII で「残ります」と言わない・読めなかった材料の注意・元に戻せませんの出し分け・保存場所だけ残った回。
//   手本の出力の写しとの比べ … 専有型の仕様書で流すと、0.6.21 の手本が返した文の写し（golden）と同じ文になる。
//                               違ってよいのは「意図して違う文」の表（設計書 10.11.12 の V4〜V6）にあるものだけ（'call' の回の足し・「読めなかった」注意の例・T161）。

type Rec = { projectId: string | null; name: string | null; leftover: string[] | null }
type Auth = { token: string }
type Reply = { ok: boolean; message?: string; tag?: string }

const RECORD: Rec = { projectId: 'p1', name: 'myapp', leftover: null }
const AUTH: Auth = { token: 'tok' }
const OK_REPLY: Reply = { ok: true, tag: 'invoked' }
const KEY_MISSING = 'HANAMII のトークンが未登録です（テスト）'

const HANAMII_WORDS: TeardownWords = {
  verb: '破棄',
  confirmTitle: 'HANAMII の公開を破棄します',
  confirmLabel: '破棄する',
  activityLabel: 'HANAMII の破棄',
  rowButton: '🗑 破棄',
  running: '破棄しています…',
  doneHeadline: '✅ 破棄しました',
  inProgressHeadline: '⏳ 破棄の途中です',
  failedHeadline: '⚠️ 破棄できませんでした',
  factsUnreadable: '破棄するものの記録を読めませんでした',
  nothingToDo: 'HANAMII のプロジェクトIDが記録に無いため、ここからは削除できません。',
  askAiTarget: 'HANAMII',
}

/** HANAMII とは全部の文が違う言葉の組（言葉を仕様書から受け取らず、HANAMII の言葉に固定する回帰を捕まえるための比べ）。 */
const REMOVAL_WORDS: TeardownWords = {
  verb: '削除',
  confirmTitle: '専有型クラスタを削除します',
  confirmLabel: '削除する',
  activityLabel: '専有型クラスタの削除',
  rowButton: '🗑 削除',
  running: '削除しています…',
  doneHeadline: '✅ すべて削除しました',
  inProgressHeadline: '⏳ 削除中です',
  failedHeadline: '⚠️ 削除できませんでした',
  factsUnreadable: '削除するものの記録を読めませんでした',
  nothingToDo: '削除するものが記録にありません。',
  askAiTarget: 'さくらのAppRun（専有型）',
}

const leftoverSentence = (buckets: string[]) =>
  `HANAMII のプロジェクトはすでに削除されています。残っている保存場所${buckets.length > 0 ? buckets.map(b => `『${b}』`).join('') : ''}を削除します。`

/** 偽の仕様書（HANAMII 風）。保存場所だけ残った印（leftover）があれば、プロジェクトはもう無いので targets は空。 */
function makeSpec(over: Partial<TargetSpec<Rec, Auth, Reply>> = {}): TargetSpec<Rec, Auth, Reply> {
  return {
    target: 'hanamii',
    handler: 'hanamii:teardown',
    words: HANAMII_WORDS,
    claimsComputeBillingStops: false,
    irreversibleNote: 'storage-only',
    readRecord: async () => RECORD,
    hasWork: r => !!r.projectId,
    targets: r => (r.leftover ? [] : [`HANAMII のプロジェクト『${r.name ?? r.projectId}』`]),
    leftoverNote: r => (r.leftover ? leftoverSentence(r.leftover) : null),
    loadAuth: async () => AUTH,
    invoke: async () => OK_REPLY,
    failure: message => ({ ok: false, message }),
    toView: raw => toTeardownView('hanamii', raw),
    ...over,
  }
}

function makeFacts(over: Partial<TeardownFacts<Rec>> = {}): TeardownFacts<Rec> {
  return {
    projectName: 'myapp',
    record: RECORD,
    placements: [],
    placementsUnreadable: false,
    placementsUnreadableCause: null,
    otherTargets: [],
    otherTargetsUnreadable: false,
    waitNote: null,
    ...over,
  }
}

const A: TeardownPlacement = { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }
const B: TeardownPlacement = { bucket: 'koto-b', prefix: 'projects/myapp/', shared: true }

type FakeOver = Partial<RunTeardownFlowDeps<Rec, Auth, Reply>> & { answer?: unknown; facts?: TeardownFacts<Rec> }

/** 偽の口。呼ばれた順（order）と中身を全部記録する。 */
function fakeDeps(over: FakeOver = {}) {
  const calls = {
    order: [] as string[],
    facts: 0,
    confirm: [] as ConfirmOptions[],
    auth: [] as Rec[],
    invoke: [] as Array<{ dir: string; auth: Auth; opts: unknown; record: Rec }>,
    begin: [] as Array<{ label: string; opts: unknown }>,
    ended: 0,
    started: 0,
  }
  const { answer, facts, ...rest } = over
  const deps: RunTeardownFlowDeps<Rec, Auth, Reply> = {
    loadFacts: async () => { calls.order.push('loadFacts'); calls.facts++; return facts ?? makeFacts() },
    confirm: async o => { calls.order.push('confirm'); calls.confirm.push(o); return ('answer' in over ? answer : true) as boolean },
    loadAuth: async r => { calls.order.push('loadAuth'); calls.auth.push(r); return AUTH },
    invoke: async (dir, auth, opts, record) => { calls.order.push('invoke'); calls.invoke.push({ dir, auth, opts, record }); return OK_REPLY },
    beginActivity: (label, opts) => {
      calls.order.push('begin'); calls.begin.push({ label, opts })
      return () => { calls.order.push('end'); calls.ended++ }
    },
    onStart: () => { calls.order.push('onStart'); calls.started++ },
    keyMissingMessage: KEY_MISSING,
    ...rest,
  }
  return { deps, calls }
}

afterEach(() => { delete (globalThis as any).window })

// ═══════════════════════════════════════════════════════════════════════════════
// A 流れの歯止め
// ═══════════════════════════════════════════════════════════════════════════════

describe('A runTeardownFlow: 確認が no なら IPC は0回・yes なら confirmed:true で1回だけ', () => {
  it('★★★ A-1 確認 no: invoke 0回・beginActivity 0回・loadAuth 0回・onStart 0回。返り値は { cancelled: true }', async () => {
    const { deps, calls } = fakeDeps({ answer: false })
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: true })
    expect(calls.confirm).toHaveLength(1)
    expect(calls.invoke).toEqual([])
    expect(calls.begin).toEqual([])
    expect(calls.auth).toEqual([])
    expect(calls.started).toBe(0)
    expect(calls.ended).toBe(0)
    expect(calls.order).toEqual(['loadFacts', 'confirm'])
  })

  it('★★★ A-2 確認 yes: invoke が { confirmed: true } 付きで1回だけ。beginActivity は仕様書の名前と窓を閉じる警告つきで1回、終われば end も1回', async () => {
    const { deps, calls } = fakeDeps()
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: false, result: OK_REPLY })
    expect(calls.invoke).toHaveLength(1)
    expect(calls.invoke[0].dir).toBe('/p')
    expect(calls.invoke[0].auth).toBe(AUTH)
    expect(calls.invoke[0].opts).toStrictEqual({ confirmed: true })
    // 窓を閉じる警告: 名前は仕様書の words.activityLabel、警告は活動レジストリの共通の1つ（PUBLISH_CLOSE_WARNING。別の文を持たない）
    expect(calls.begin).toHaveLength(1)
    expect(calls.begin[0].label).toBe('HANAMII の破棄')
    expect(calls.begin[0].opts).toStrictEqual({ closeWarning: PUBLISH_CLOSE_WARNING })
    expect((calls.begin[0].opts as { closeWarning: unknown }).closeWarning).toBe(PUBLISH_CLOSE_WARNING)
    expect(calls.ended).toBe(1)
    expect(calls.started).toBe(1)
  })

  it('★★ 確認に出した文は、確認の文を作る関数（buildTeardownConfirm）の出力そのもの。確認は1回だけ', async () => {
    const facts = makeFacts({ placements: [A], otherTargets: ['Vercel'] })
    const { deps, calls } = fakeDeps({ facts })
    await runTeardownFlow('/p', makeSpec(), deps)
    expect(calls.confirm).toEqual([buildTeardownConfirm(makeSpec(), facts)])
    expect(calls.confirm[0].danger).toBe(true)
  })

  it.each([
    ['文字列 "yes"', 'yes'],
    ['文字列 "true"', 'true'],
    ['数 1', 1],
    ['undefined', undefined],
    ['null', null],
    ['空のオブジェクト', {}],
    ['配列', [true]],
    ['false', false],
  ])('★★★ A-3 確認の答えが true 以外（%s）→ IPC 0回・活動レジストリ 0回・キーも読まない（不明な値を肯定に戻さない）', async (_label, answer) => {
    const { deps, calls } = fakeDeps({ answer })
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: true })
    expect(calls.invoke).toEqual([])
    expect(calls.begin).toEqual([])
    expect(calls.auth).toEqual([])
    expect(calls.started).toBe(0)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('★★ A-4 キーなし（%s）→ invoke 0回・keyMissingMessage の失敗。begin と end は1対1（実行中の印が残らない）', async (_label, none) => {
    const { deps, calls } = fakeDeps({ loadAuth: async () => none })
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: false, result: { ok: false, message: KEY_MISSING } })
    expect(calls.invoke).toEqual([])
    expect(calls.begin).toHaveLength(1)
    expect(calls.ended).toBe(1)
  })

  it('★★ A-5 IPC が例外 → 握らずに投げ直す。end は1回（活動レジストリから外れる）', async () => {
    const { deps, calls } = fakeDeps({ invoke: async () => { throw new Error('IPC が落ちました') } })
    await expect(runTeardownFlow('/p', makeSpec(), deps)).rejects.toThrow('IPC が落ちました')
    expect(calls.begin).toHaveLength(1)
    expect(calls.ended).toBe(1)
  })

  it('★ A-5b キーの読み込みが例外でも、end は1回（実行中の印が残らない）', async () => {
    const { deps, calls } = fakeDeps({ loadAuth: async () => { throw new Error('キーを読めません') } })
    await expect(runTeardownFlow('/p', makeSpec(), deps)).rejects.toThrow('キーを読めません')
    expect(calls.invoke).toEqual([])
    expect(calls.ended).toBe(1)
  })

  it('★★★ A-6 材料が読めない（loadFacts が投げる）→ 確認 0回・IPC 0回・begin 0回・キー 0回。失敗の文は仕様書の言葉＋理由', async () => {
    const { deps, calls } = fakeDeps({ loadFacts: async () => { throw new Error('.sakuraide.json が壊れています') } })
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: false, result: { ok: false, message: '破棄するものの記録を読めませんでした: .sakuraide.json が壊れています' } })
    expect(calls.confirm).toEqual([])
    expect(calls.invoke).toEqual([])
    expect(calls.begin).toEqual([])
    expect(calls.auth).toEqual([])
    expect(calls.started).toBe(0)
  })

  it('A-6b 投げられたものが Error でなくても、文になる（読めない理由が undefined にならない）', async () => {
    const { deps } = fakeDeps({ loadFacts: async () => { throw 'ただの文字列' } })
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: false, result: { ok: false, message: '破棄するものの記録を読めませんでした: ただの文字列' } })
  })

  it('★★ A-7 幽霊の行（hasWork が false）→ 確認 0回・IPC 0回・begin 0回。仕様書の nothingToDo の失敗', async () => {
    const ghost: Rec = { projectId: null, name: null, leftover: null }
    const { deps, calls } = fakeDeps({ facts: makeFacts({ record: ghost }) })
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: false, result: { ok: false, message: HANAMII_WORDS.nothingToDo } })
    expect(calls.confirm).toEqual([])
    expect(calls.invoke).toEqual([])
    expect(calls.begin).toEqual([])
    expect(calls.auth).toEqual([])
    expect(calls.started).toBe(0)
  })

  it('★★ A-9 言葉は仕様書のものが流れに届く（HANAMII の言葉に固定しない）: 窓を閉じる警告の名前・材料が読めない失敗・消すものが無い失敗・確認の見出しとボタン', async () => {
    const spec = makeSpec({ words: REMOVAL_WORDS })
    const ok = fakeDeps()
    await runTeardownFlow('/p', spec, ok.deps)
    expect(ok.calls.begin[0].label).toBe('専有型クラスタの削除')
    expect(ok.calls.confirm[0].title).toBe('専有型クラスタを削除します')
    expect(ok.calls.confirm[0].confirmLabel).toBe('削除する')

    const unreadable = fakeDeps({ loadFacts: async () => { throw new Error('.sakuraide.json が壊れています') } })
    expect(await runTeardownFlow('/p', spec, unreadable.deps)).toEqual({
      cancelled: false, result: { ok: false, message: '削除するものの記録を読めませんでした: .sakuraide.json が壊れています' },
    })

    const ghost = fakeDeps({ facts: makeFacts({ record: { projectId: null, name: null, leftover: null } }) })
    expect(await runTeardownFlow('/p', spec, ghost.deps)).toEqual({ cancelled: false, result: { ok: false, message: '削除するものが記録にありません。' } })
    expect(ghost.calls.begin).toEqual([])
  })

  it('★★ A-8 順序: 材料 → 確認 → 活動レジストリに載せる → onStart → キーを読む → IPC → 外す', async () => {
    const { deps, calls } = fakeDeps()
    await runTeardownFlow('/p', makeSpec(), deps)
    expect(calls.order).toEqual(['loadFacts', 'confirm', 'begin', 'onStart', 'loadAuth', 'invoke', 'end'])
  })

  it('★ キーの読み込みと IPC には、材料から読んだ同じ記録（record）が渡る', async () => {
    const record: Rec = { projectId: 'p9', name: 'other', leftover: null }
    const { deps, calls } = fakeDeps({ facts: makeFacts({ record }) })
    await runTeardownFlow('/p', makeSpec(), deps)
    expect(calls.auth[0]).toBe(record)
    expect(calls.invoke[0].record).toBe(record)
  })

  it('onStart は任意（無くても流れは通る）', async () => {
    const { deps, calls } = fakeDeps({ onStart: undefined })
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: false, result: OK_REPLY })
    expect(calls.invoke).toHaveLength(1)
  })

  it('★ 失敗の結果（ok:false）も握らずにそのまま返す（結果の読み方は仕様書の toView が受け持つ）', async () => {
    const failed: Reply = { ok: false, message: 'HANAMII が断りました' }
    const { deps, calls } = fakeDeps({ invoke: async () => failed })
    const out = await runTeardownFlow('/p', makeSpec(), deps)
    expect(out).toEqual({ cancelled: false, result: failed })
    expect(calls.ended).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 本物の口（electronFlowDeps）: 窓を閉じる警告・材料・キー・IPC を、入口ごとに書き直さない
// ═══════════════════════════════════════════════════════════════════════════════

function installWindow(over: { placement?: () => Promise<unknown>; readFile?: (p: string) => Promise<string> } = {}) {
  const busy: unknown[][] = []
  const dispatched: string[] = []
  ;(globalThis as any).window = {
    electronAPI: {
      storage: { placement: over.placement ?? (async () => ({ ok: true, placement: null, placements: [] })) },
      // exists: 旧い共用型の記録（.sakura-cloud/state.json）は無い（D9=2。.sakuraide.json だけがある）。state.json は読みにいかれない。
      fs: {
        readFile: over.readFile ?? (async () => JSON.stringify({ publish: { targets: { hanamii: { publishedAt: 't' } } } })),
        exists: async (p: string) => String(p).endsWith('/.sakuraide.json'),
      },
      stageTiming: { estimates: async () => null },
      win: { setBusy: (...a: unknown[]) => { busy.push(a) } },
    },
    dispatchEvent: (e: { type: string }) => { dispatched.push(e.type); return true },
  }
  return { busy, dispatched }
}

describe('A electronFlowDeps（本物の口）', () => {
  it('★★★ 本物の beginActivity: 実行中は窓を閉じる警告つきで setBusy に載り、終われば外れる（警告の文は PUBLISH_CLOSE_WARNING）', async () => {
    const { busy } = installWindow()
    expect(_activeCount()).toBe(0)
    let during: unknown[] | undefined
    let activeDuring = -1
    let blockingDuring = -1
    const spec = makeSpec({
      invoke: async () => { during = busy[busy.length - 1]; activeDuring = _activeCount(); blockingDuring = _blockingCount(); return OK_REPLY },
    })
    const deps = electronFlowDeps('/p', spec, { confirm: async () => true, keyMissingMessage: KEY_MISSING })
    const out = await runTeardownFlow('/p', spec, deps)
    expect(out).toEqual({ cancelled: false, result: OK_REPLY })
    expect(during).toEqual([true, 'HANAMII の破棄', true, 'HANAMII の破棄', PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel])
    expect(activeDuring).toBe(1)
    expect(blockingDuring).toBe(1)
    expect(busy[busy.length - 1]).toEqual([false, '', false, '', '', ''])
    expect(_activeCount()).toBe(0)
    expect(_blockingCount()).toBe(0)
  })

  it('★★ IPC が例外でも、窓を閉じる警告の印は外れる', async () => {
    const { busy } = installWindow()
    const spec = makeSpec({ invoke: async () => { throw new Error('落ちた') } })
    const deps = electronFlowDeps('/p', spec, { confirm: async () => true, keyMissingMessage: KEY_MISSING })
    await expect(runTeardownFlow('/p', spec, deps)).rejects.toThrow('落ちた')
    expect(busy[busy.length - 1]).toEqual([false, '', false, '', '', ''])
    expect(_activeCount()).toBe(0)
  })

  it('★★ やめる（no）なら、活動レジストリには何も載らない（setBusy が1回も呼ばれない）・IPC もキーも0回', async () => {
    const { busy } = installWindow()
    const touched: string[] = []
    const spec = makeSpec({
      loadAuth: async () => { touched.push('auth'); return AUTH },
      invoke: async () => { touched.push('invoke'); return OK_REPLY },
    })
    const deps = electronFlowDeps('/p', spec, { confirm: async () => false, keyMissingMessage: KEY_MISSING })
    expect(await runTeardownFlow('/p', spec, deps)).toEqual({ cancelled: true })
    expect(busy).toEqual([])
    expect(touched).toEqual([])
  })

  it('★★ loadAuth・invoke は仕様書の関数をそのまま呼ぶ（入口が書き直さない）。記録は仕様書の readRecord で読んだもの', async () => {
    installWindow()
    const seen: Array<unknown> = []
    const record: Rec = { projectId: 'p-live', name: 'live', leftover: null }
    const spec = makeSpec({
      readRecord: async dir => { seen.push(['readRecord', dir]); return record },
      loadAuth: async r => { seen.push(['loadAuth', r]); return { token: 'spec-token' } },
      invoke: async (dir, auth, opts, r) => { seen.push(['invoke', dir, auth, opts, r]); return OK_REPLY },
    })
    const deps = electronFlowDeps('/proj', spec, { confirm: async () => true, keyMissingMessage: KEY_MISSING })
    await runTeardownFlow('/proj', spec, deps)
    expect(seen).toEqual([
      ['readRecord', '/proj'],
      ['loadAuth', record],
      ['invoke', '/proj', { token: 'spec-token' }, { confirmed: true }, record],
    ])
  })

  it('★ 材料は本物の口から読む: 保存場所は window の storage、ほかの公開先は .sakuraide.json（この公開先は除く）。確認の文に出る', async () => {
    installWindow({
      placement: async () => ({ ok: true, placement: A, placements: [A, B] }),
      readFile: async p => {
        expect(p).toBe('/proj/.sakuraide.json')
        return JSON.stringify({ publish: { targets: { hanamii: { publishedAt: 't' }, vercel: { publishedAt: 't' } } } })
      },
    })
    const asked: ConfirmOptions[] = []
    const spec = makeSpec()
    const deps = electronFlowDeps('/proj', spec, { confirm: async o => { asked.push(o); return false }, keyMissingMessage: KEY_MISSING })
    await runTeardownFlow('/proj', spec, deps)
    expect(asked).toHaveLength(1)
    expect(asked[0].body).toContain('保存場所『koto-a』『koto-b』にある、このプロジェクトのデータ')
    expect(asked[0].body).toContain('Vercel でも使っているため')
    expect(asked[0].body).not.toContain('HANAMII でも使っているため')
  })

  it('onStart は渡したときだけ deps に載る（入口が決める）。キーが無いときの文も入口の文のまま', async () => {
    installWindow()
    const spec = makeSpec({ loadAuth: async () => null })
    const without = electronFlowDeps('/p', spec, { confirm: async () => true, keyMissingMessage: '入口Aの案内' })
    expect('onStart' in without).toBe(false)
    let started = 0
    const withStart = electronFlowDeps('/p', spec, { confirm: async () => true, keyMissingMessage: '入口Bの案内', onStart: () => { started++ } })
    const out = await runTeardownFlow('/p', spec, withStart)
    expect(out).toEqual({ cancelled: false, result: { ok: false, message: '入口Bの案内' } })
    expect(started).toBe(1)
    const outA = await runTeardownFlow('/p', spec, without)
    expect(outA).toEqual({ cancelled: false, result: { ok: false, message: '入口Aの案内' } })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// B 確認の文
// ═══════════════════════════════════════════════════════════════════════════════

const confirmOf = (specOver: Partial<TargetSpec<Rec, Auth, Reply>> = {}, factsOver: Partial<TeardownFacts<Rec>> = {}) =>
  buildTeardownConfirm(makeSpec(specOver), makeFacts(factsOver))

describe('B 確認の文（buildTeardownConfirm）', () => {
  it('★ B-1 同じ材料なら、どの入口の deps から呼んでも同じ文（入口が決めるのはキーなしの文と onStart だけ）', async () => {
    installWindow({ placement: async () => ({ ok: true, placement: A, placements: [A] }) })
    const spec = makeSpec()
    const askedA: ConfirmOptions[] = []
    const askedB: ConfirmOptions[] = []
    const entryA = electronFlowDeps('/proj', spec, { confirm: async o => { askedA.push(o); return false }, keyMissingMessage: '入口Aの案内' })
    const entryB = electronFlowDeps('/proj', spec, { confirm: async o => { askedB.push(o); return false }, keyMissingMessage: '入口Bの案内', onStart: () => {} })
    await runTeardownFlow('/proj', spec, entryA)
    await runTeardownFlow('/proj', spec, entryB)
    expect(askedA).toHaveLength(1)
    expect(askedA).toEqual(askedB)
    // 偽の deps（材料を直接渡す）から呼んでも、同じ材料なら同じ文
    const { deps } = fakeDeps({ answer: false, facts: makeFacts({ projectName: 'proj', placements: [A] }) })
    const asked: ConfirmOptions[] = []
    await runTeardownFlow('/proj', spec, { ...deps, confirm: async o => { asked.push(o); return false } })
    expect(asked).toEqual(askedA)
  })

  it('形: title・confirmLabel は仕様書の words、danger は true、先頭は対象のプロジェクト名', () => {
    const c = confirmOf()
    expect(Object.keys(c).sort()).toEqual(['body', 'confirmLabel', 'danger', 'title'])
    expect(c.title).toBe('HANAMII の公開を破棄します')
    expect(c.confirmLabel).toBe('破棄する')
    expect(c.danger).toBe(true)
    expect(c.body.startsWith('対象のプロジェクト: 『myapp』\n\n次を破棄します: HANAMII のプロジェクト『myapp』')).toBe(true)
  })

  it('★★ 全文: HANAMII で保存場所1件・ほかの公開先 Vercel（段落の並びが変わったら落ちる）', () => {
    const c = confirmOf({}, { placements: [A], otherTargets: ['Vercel'] })
    expect(c.body.split('\n\n')).toEqual([
      '対象のプロジェクト: 『myapp』',
      '次を破棄します: HANAMII のプロジェクト『myapp』・保存場所『koto-a』にある、このプロジェクトのデータ',
      '💾 保存場所『koto-a』にある、このプロジェクトのデータも削除します。ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。'
        + 'この保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。',
      '⚠️ この保存場所は Vercel でも使っているため、そちらで公開中のアプリのデータも消えます（アプリ自体は消えません）。',
      '保存場所にあるデータの削除は元に戻せません。破棄すると、保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。よろしいですか？',
    ])
  })

  it('★★ B-2 保存場所2件 → 一覧にも💾の文にも2件とも名前が出る（先頭1件だけにしない）', () => {
    const c = confirmOf({}, { placements: [A, B] })
    expect(c.body).toContain('次を破棄します: HANAMII のプロジェクト『myapp』・保存場所『koto-a』『koto-b』にある、このプロジェクトのデータ')
    expect(c.body).toContain('💾 保存場所『koto-a』『koto-b』にある、このプロジェクトのデータも削除します。')
    // 💾 の文は共通の定義をそのまま使う（ここで書き起こさない）
    expect(c.body).toContain(`💾 ${teardownDataNoteForAll({ target: 'hanamii', placements: [A, B] })}`)
  })

  it('★★★ B-3 HANAMII で保存場所1件 → 「データも削除します」があり、「残ります」が無い（保存場所を片づける公開先に「残ります」と言うと事実と逆になる）', () => {
    const c = confirmOf({}, { placements: [A] })
    expect(c.body).toContain('保存場所『koto-a』にある、このプロジェクトのデータも削除します')
    expect(c.body).not.toContain('残ります')
    expect(c.body).not.toContain('とその中のデータは残ります')
  })

  it('★★ B-4 ほかの公開先 → 名前を出す（保存場所1件は「この保存場所」・2件は「これらの保存場所」）', () => {
    const one = confirmOf({}, { placements: [A], otherTargets: ['Vercel', 'さくらのAppRun'] })
    expect(one.body).toContain('⚠️ この保存場所は Vercel・さくらのAppRun でも使っているため、そちらで公開中のアプリのデータも消えます（アプリ自体は消えません）。')
    const two = confirmOf({}, { placements: [A, B], otherTargets: ['Vercel'] })
    expect(two.body).toContain('⚠️ これらの保存場所は Vercel でも使っているため、')
  })

  it('★★ B-4b 保存場所が0件なら、ほかの公開先の段落は出ない（写し元と同じ）', () => {
    const c = confirmOf({}, { placements: [], otherTargets: ['Vercel'] })
    expect(c.body).not.toContain('でも使っているため')
    expect(c.body).not.toContain('Vercel')
  })

  it('★★ B-5 読めなかった材料の注意（settings）: 保存場所の削除は行われない。「元に戻せません」もほかの公開先の文も足さない', () => {
    const c = confirmOf({}, { placementsUnreadable: true, placementsUnreadableCause: 'settings', otherTargets: ['Vercel'] })
    const cautions = unreadableCautions({ placementsUnreadable: true, placementsUnreadableCause: 'settings', otherTargetsUnreadable: false, otherTargets: ['Vercel'] }, HANAMII_WORDS, 'storage-only', 'hanamii')
    expect(cautions).toHaveLength(1)
    expect(cautions[0]).toContain('保存場所の設定を読めないため、保存場所の削除は行われません')
    expect(cautions[0]).toContain('月額が続きます')
    expect(cautions[0]).not.toContain('元に戻せません')
    expect(cautions.join('')).not.toContain('Vercel')
    // 本文の先頭（プロジェクト名の次）に注意が入る。保存場所0件なので最後の問いも「元に戻せません」を言わない
    expect(c.body.split('\n\n')[1]).toBe(cautions[0])
    expect(c.body).not.toContain('元に戻せません')
  })

  it('★★★ B-5 読めなかった材料の注意（call・storage-only）: 「削除される場合があります」と「元に戻せません」の両方が出る（本文は保存場所0件でも言い落とさない）', () => {
    const c = confirmOf({}, { placementsUnreadable: true, placementsUnreadableCause: 'call' })
    expect(c.body).toContain('保存場所の設定を問い合わせられなかったため')
    expect(c.body).toContain('削除される場合があります')
    expect(c.body).toContain('削除されたデータは元に戻せません。')
    expect(c.body).not.toContain('保存場所の削除は行われません')
  })

  it('★★ B-5 call・always は手本どおり: 注意の文に「元に戻せません」は足さず、最後の一文が言う', () => {
    const cautions = unreadableCautions({ placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargetsUnreadable: false, otherTargets: [] }, HANAMII_WORDS, 'always', 'hanamii')
    expect(cautions).toHaveLength(1)
    expect(cautions[0]).toContain('削除される場合があります')
    expect(cautions[0]).not.toContain('元に戻せません')
    const c = confirmOf({ irreversibleNote: 'always' }, { placementsUnreadable: true, placementsUnreadableCause: 'call' })
    expect(c.body.match(/元に戻せません/g)).toHaveLength(1)
    expect(c.body.endsWith('この操作は元に戻せません。よろしいですか？')).toBe(true)
  })

  it('★★★ B-5 call で otherTargets が1件以上 → その名前が注意の文に出る（保存場所を使うほかの公開先のデータも消える）', () => {
    const facts = { placementsUnreadable: true, placementsUnreadableCause: 'call' as const, otherTargetsUnreadable: false, otherTargets: ['Vercel', 'さくらのAppRun'] }
    for (const note of ['storage-only', 'always'] as const) {
      const cautions = unreadableCautions(facts, HANAMII_WORDS, note, 'hanamii')
      expect(cautions).toHaveLength(2)
      expect(cautions[1]).toBe('⚠️ このプロジェクトが保存場所を使っていて、それをほかの公開先（Vercel・さくらのAppRun）も使っていれば、'
        + 'そちらで公開中のアプリのデータも消えます（アプリ自体は消えません）。')
    }
    const c = confirmOf({}, { placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargets: ['Vercel'] })
    expect(c.body).toContain('ほかの公開先（Vercel）も使っていれば')
  })

  it('★★ B-5 call で otherTargets が0件 → ほかの公開先の文は出ない。読めなかった回（otherTargetsUnreadable）は既存の「挙げられません」の文のまま', () => {
    const none = unreadableCautions({ placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargetsUnreadable: false, otherTargets: [] }, HANAMII_WORDS, 'storage-only', 'hanamii')
    expect(none).toHaveLength(1)
    expect(none.join('')).not.toContain('ほかの公開先（')
    const unreadable = unreadableCautions({ placementsUnreadable: true, placementsUnreadableCause: 'call', otherTargetsUnreadable: true, otherTargets: [] }, HANAMII_WORDS, 'storage-only', 'hanamii')
    expect(unreadable).toHaveLength(2)
    // HANAMII の確認なので、「ほか」は Vercel・共用型・専有型（自分自身の HANAMII を「ほかの公開先」に数えない。V5: Vercel も挙げる）
    expect(unreadable[1]).toBe('⚠️ ほかの公開先の記録を読めなかったため、ここに挙げられません。'
      + '保存場所をほかの公開先（Vercel・共用型・専有型など）が使っていれば、そちらのアプリのデータも消えます。')
    expect(unreadable.join('')).not.toContain('公開中のアプリのデータも消えます')
  })

  it('B-5 ほかの公開先の記録だけ読めなかった回（保存場所は読めた）: その注意だけが出る。読めた回は何も足さない', () => {
    const onlyOthers = unreadableCautions({ placementsUnreadable: false, placementsUnreadableCause: null, otherTargetsUnreadable: true, otherTargets: [] }, HANAMII_WORDS, 'storage-only', 'hanamii')
    expect(onlyOthers).toEqual(['⚠️ ほかの公開先の記録を読めなかったため、ここに挙げられません。'
      + '保存場所をほかの公開先（Vercel・共用型・専有型など）が使っていれば、そちらのアプリのデータも消えます。'])
    // 読めた回は、otherTargets が何件あっても注意を足さない（'call' の足しは読めなかった回だけ）
    for (const note of ['storage-only', 'always'] as const) {
      expect(unreadableCautions({ placementsUnreadable: false, placementsUnreadableCause: null, otherTargetsUnreadable: false, otherTargets: ['Vercel'] }, HANAMII_WORDS, note, 'hanamii')).toEqual([])
    }
  })

  it('★★★ B-5 「ほかの公開先の記録を読めなかった」注意の例は、この公開先自身を「ほか」に数えない（HANAMII の確認が HANAMII を、共用型の確認が共用型を挙げない）', () => {
    const facts = { placementsUnreadable: false, placementsUnreadableCause: null, otherTargetsUnreadable: true, otherTargets: [] }
    const sentenceFor = (target: 'hanamii' | 'sakura-apprun' | 'sakura-apprun-dedicated') => unreadableCautions(facts, HANAMII_WORDS, 'always', target)[0]
    const head = '⚠️ ほかの公開先の記録を読めなかったため、ここに挙げられません。保存場所をほかの公開先（'
    const tail = 'など）が使っていれば、そちらのアプリのデータも消えます。'
    // V5（段階3B-3）: 例は保存場所を使いうる公開先の唯一の定義（PUBLISH_TARGETS_USING_STORAGE）の並びで、Vercel も挙げる。手本（専有型）の文は「HANAMII・共用型」だった
    expect(sentenceFor('hanamii')).toBe(`${head}Vercel・共用型・専有型${tail}`)
    expect(sentenceFor('sakura-apprun')).toBe(`${head}HANAMII・Vercel・専有型${tail}`)
    expect(sentenceFor('sakura-apprun-dedicated')).toBe(`${head}HANAMII・Vercel・共用型${tail}`)
    // 確認の本文の中でも、その公開先の仕様書で作ると自分を挙げない
    for (const [target, own] of [['hanamii', 'HANAMII'], ['sakura-apprun', '共用型'], ['sakura-apprun-dedicated', '専有型']] as const) {
      const body = confirmOf({ target }, { otherTargetsUnreadable: true }).body
      const caution = body.split('\n\n').find(p => p.includes('ほかの公開先の記録を読めなかった'))!
      expect(caution, target).toBeDefined()
      expect(caution, `${target} が自分（${own}）を「ほか」に挙げている`).not.toContain(own)
    }
  })

  it('★ B-5 ほかの公開先の名前が空文字のものは数えない（「 でも使っているため」「（・Vercel）」にしない）', () => {
    // 本文のほかの公開先の段落
    const body = confirmOf({}, { placements: [A], otherTargets: ['', 'Vercel'] }).body
    expect(body).toContain('⚠️ この保存場所は Vercel でも使っているため、そちらで公開中のアプリのデータも消えます（アプリ自体は消えません）。')
    expect(confirmOf({}, { placements: [A], otherTargets: [''] }).body).not.toContain('でも使っているため') // 空だけなら段落ごと出ない
    // 'call' の注意
    const call = { placementsUnreadable: true, placementsUnreadableCause: 'call' as const, otherTargetsUnreadable: false }
    const some = unreadableCautions({ ...call, otherTargets: ['', 'Vercel'] }, HANAMII_WORDS, 'always', 'hanamii')
    expect(some).toHaveLength(2)
    expect(some[1]).toContain('ほかの公開先（Vercel）も使っていれば')
    expect(unreadableCautions({ ...call, otherTargets: [''] }, HANAMII_WORDS, 'always', 'hanamii')).toHaveLength(1)
  })

  it('B-5 placementsUnreadable なのに理由が null の回は、手本と同じく call と同じ扱い', () => {
    const c = unreadableCautions({ placementsUnreadable: true, placementsUnreadableCause: null, otherTargetsUnreadable: false, otherTargets: ['Vercel'] }, HANAMII_WORDS, 'storage-only', 'hanamii')
    expect(c[0]).toContain('保存場所の設定を問い合わせられなかったため')
    expect(c[0]).toContain('削除されたデータは元に戻せません。')
    expect(c[1]).toContain('ほかの公開先（Vercel）')
  })

  it('★★ B-6 claimsComputeBillingStops: false → 「の課金は止まります」が出ない。true → 消す種類だけ並べて言う', () => {
    const noClaim = confirmOf({ targets: () => ['アプリ『a』', 'クラスタ『c』'] }, { placements: [A] })
    expect(noClaim.body).not.toContain('の課金は止まります')
    const claim = confirmOf({ claimsComputeBillingStops: true, targets: () => ['アプリ『a』', 'クラスタ『c』'] }, { placements: [A] })
    expect(claim.body).toContain('破棄すると、アプリ・クラスタの課金は止まります。保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。よろしいですか？')
    // 保存場所の一文は Koto 自身の判断なので、課金を言わない公開先でも残る
    expect(noClaim.body).toContain('保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。')
  })

  it('★ B-7 verb が破棄 → 「次を削除します」が無く、「次を破棄します」になる。削除の公開先は「次を削除します」', () => {
    const c = confirmOf()
    expect(c.body).not.toContain('次を削除します')
    expect(c.body).toContain('次を破棄します: ')
    const removal = confirmOf({ words: { ...HANAMII_WORDS, verb: '削除' }, claimsComputeBillingStops: true, irreversibleNote: 'always' })
    expect(removal.body).toContain('次を削除します: ')
    expect(removal.body).not.toContain('破棄')
    expect(removal.body).toContain('この操作は元に戻せません。削除すると、HANAMII のプロジェクトの課金は止まります。よろしいですか？')
  })

  describe('B-8 「この操作は元に戻せません」の出し分け（irreversibleNote）', () => {
    it('★★ always → 出る（課金の一文が有る回も無い回も）', () => {
      const withCost = confirmOf({ irreversibleNote: 'always', claimsComputeBillingStops: true }, { placements: [] })
      expect(withCost.body.endsWith('この操作は元に戻せません。破棄すると、HANAMII のプロジェクトの課金は止まります。よろしいですか？')).toBe(true)
      // 消すもの（targets）も保存場所も無く、課金の一文が無い回
      const noCost = confirmOf({ irreversibleNote: 'always', targets: () => [], leftoverNote: undefined }, { placements: [] })
      expect(noCost.body.endsWith('この操作は元に戻せません。よろしいですか？')).toBe(true)
    })

    it('★★★ storage-only で保存場所0件（材料が読めた回）→ 「元に戻せません」が出ない', () => {
      const c = confirmOf({ irreversibleNote: 'storage-only' }, { placements: [] })
      expect(c.body).not.toContain('元に戻せません')
      expect(c.body.endsWith('よろしいですか？')).toBe(true)
      const withClaim = confirmOf({ irreversibleNote: 'storage-only', claimsComputeBillingStops: true }, { placements: [] })
      expect(withClaim.body).not.toContain('元に戻せません')
      expect(withClaim.body.endsWith('破棄すると、HANAMII のプロジェクトの課金は止まります。よろしいですか？')).toBe(true)
    })

    it('★★★ storage-only で保存場所1件以上 → 「保存場所にあるデータの削除は元に戻せません」が出る（プロジェクトそのものは言わない）', () => {
      for (const placements of [[A], [A, B]]) {
        const c = confirmOf({ irreversibleNote: 'storage-only' }, { placements })
        expect(c.body).toContain('保存場所にあるデータの削除は元に戻せません。')
        expect(c.body).not.toContain('この操作は元に戻せません')
        expect(c.body).not.toContain('プロジェクトの削除は元に戻せません')
      }
    })

    it('名前の無い保存場所（null・空の bucket）は数えない（保存場所0件と同じ扱い）', () => {
      const body = buildTeardownConfirmBody({
        verb: '破棄', targets: ['HANAMII のプロジェクト『x』'], placements: [null, undefined, { bucket: '' }],
        dataNote: 'ここには出ない', claimsComputeBillingStops: false, irreversibleNote: 'storage-only',
      })
      expect(body).toBe('次を破棄します: HANAMII のプロジェクト『x』\n\nよろしいですか？')
    })
  })

  describe('B-9 保存場所だけが残った回（leftoverNote）', () => {
    const LEFTOVER: Rec = { projectId: 'p1', name: 'myapp', leftover: ['koto-a'] }

    it('★★★ 先頭の段落がその文で、「次を」で始まる段落が無い', () => {
      const c = confirmOf({}, { record: LEFTOVER, placements: [A] })
      const paragraphs = c.body.split('\n\n')
      expect(paragraphs[0]).toBe('対象のプロジェクト: 『myapp』')
      expect(paragraphs[1]).toBe('HANAMII のプロジェクトはすでに削除されています。残っている保存場所『koto-a』を削除します。')
      expect(paragraphs.some(p => p.startsWith('次を'))).toBe(false)
      expect(c.body).not.toContain('HANAMII のプロジェクト『myapp』')
    })

    it('★★ 💾・ほかの公開先・元に戻せませんの段落は変わらない（先頭の段落だけが差し替わる）', () => {
      const facts = { placements: [A], otherTargets: ['Vercel'], waitNote: '⏳ 時間がかかります。' }
      const without = confirmOf({ leftoverNote: undefined }, { record: LEFTOVER, ...facts })
      const withNote = confirmOf({}, { record: LEFTOVER, ...facts })
      const a = without.body.split('\n\n')
      const b = withNote.body.split('\n\n')
      expect(b).toHaveLength(a.length)
      expect(b.slice(2)).toEqual(a.slice(2))
      expect(b[1]).not.toBe(a[1])
      expect(b.some(p => p.startsWith('💾 '))).toBe(true)
      expect(b.some(p => p.includes('Vercel でも使っているため'))).toBe(true)
      expect(b[b.length - 1]).toContain('保存場所にあるデータの削除は元に戻せません。')
    })

    it('残りの名前が分からない回（空配列）の言い方。渡さなければ今までと同じ文', () => {
      const unknown: Rec = { projectId: 'p1', name: 'myapp', leftover: [] }
      const c = confirmOf({}, { record: unknown, placements: [A] })
      expect(c.body).toContain('HANAMII のプロジェクトはすでに削除されています。残っている保存場所を削除します。')
      // leftoverNote が null を返す（印なし）回は、通常の「次を破棄します」
      const normal = confirmOf({}, { placements: [A] })
      expect(normal.body).toContain('次を破棄します: ')
      expect(normal.body).not.toContain('すでに削除されています')
    })

    it('★★ leftoverNote のときは targets を使わない: 呼び手が targets を空にしなくても、無いものの課金停止を語らない（先頭の一覧にも、課金の一文にも入れない）', () => {
      const ghostTargets = ['アプリ『a』', 'ロードバランサ『lb』']
      const claim = confirmOf({ claimsComputeBillingStops: true, irreversibleNote: 'always', targets: () => ghostTargets }, { record: LEFTOVER, placements: [A] })
      expect(claim.body).not.toContain('アプリ')
      expect(claim.body).not.toContain('ロードバランサ')
      expect(claim.body).not.toContain('の課金は止まります')
      expect(claim.body).toContain('破棄すると、保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。よろしいですか？')
      // 関数そのものも、targets を渡されて leftoverNote があれば無視する
      const body = buildTeardownConfirmBody({
        verb: '削除', targets: ghostTargets, placements: [A], dataNote: 'x', claimsComputeBillingStops: true, irreversibleNote: 'always',
        leftoverNote: '前回の削除で、保存場所だけが残っています。',
      })
      expect(body.startsWith('前回の削除で、保存場所だけが残っています。\n\n')).toBe(true)
      expect(body).not.toContain('アプリ')
      expect(body).not.toContain('の課金は止まります')
      // leftoverNote が無ければ、同じ targets は課金の一文に入る（上の無視は leftoverNote のときだけ）
      const normal = buildTeardownConfirmBody({
        verb: '削除', targets: ghostTargets, placements: [A], dataNote: 'x', claimsComputeBillingStops: true, irreversibleNote: 'always',
      })
      expect(normal).toContain('アプリ・ロードバランサの課金は止まります。')
    })

    it('★★★ 保存場所だけが残った回で、保存場所の設定も読めない（settings）: 1つの確認の中で「削除は行われません」と「削除します」を両方言わない。事実だけの先頭の段落にする', () => {
      for (const leftover of [['koto-a'], []]) {
        const record: Rec = { projectId: 'p1', name: 'myapp', leftover }
        const c = confirmOf({}, { record, placementsUnreadable: true, placementsUnreadableCause: 'settings' })
        const paragraphs = c.body.split('\n\n')
        expect(paragraphs[1], '注意（main は保存場所に触れない）が先頭の次').toContain('保存場所の設定を読めないため、保存場所の削除は行われません')
        expect(paragraphs[2]).toBe('前回の破棄で、保存場所だけが残っています。')
        expect(c.body).not.toContain('を削除します')
        expect(c.body).not.toContain('残っている保存場所')
        expect(c.body).not.toContain('すでに削除されています')
        expect(paragraphs.some(p => p.startsWith('次を'))).toBe(false)
        expect(paragraphs[paragraphs.length - 1]).toBe('よろしいですか？')
      }
      // 動詞は仕様書のもの
      const removal = confirmOf({ words: REMOVAL_WORDS }, { record: LEFTOVER, placementsUnreadable: true, placementsUnreadableCause: 'settings' })
      expect(removal.body).toContain('前回の削除で、保存場所だけが残っています。')
    })

    it('settings 以外の読めなかった回・読めた回は、仕様書の leftoverNote のまま（call は main が保存場所を削除するかもしれない）。残りの印が無ければ settings でも通常の文', () => {
      const call = confirmOf({}, { record: LEFTOVER, placementsUnreadable: true, placementsUnreadableCause: 'call' })
      expect(call.body.split('\n\n')).toContain(leftoverSentence(['koto-a']))
      const nullCause = confirmOf({}, { record: LEFTOVER, placementsUnreadable: true, placementsUnreadableCause: null })
      expect(nullCause.body.split('\n\n')).toContain(leftoverSentence(['koto-a']))
      // 残りの印が無い通常の回は、settings でも「次を破棄します」のまま（先頭を差し替えるのは leftoverNote があるときだけ）
      const normal = confirmOf({}, { placementsUnreadable: true, placementsUnreadableCause: 'settings' })
      expect(normal.body).toContain('次を破棄します: HANAMII のプロジェクト『myapp』')
      expect(normal.body).not.toContain('前回の')
    })

    it('leftoverNote を持たない仕様書（手本の専有型など）は、今までと同じ文', () => {
      const spec = makeSpec()
      delete (spec as { leftoverNote?: unknown }).leftoverNote
      const c = buildTeardownConfirm(spec, makeFacts({ record: LEFTOVER, placements: [A] }))
      expect(c.body).toContain('次を破棄します: ')
    })
  })

  it('時間の予告（waitNote）は、最後の問いの直前に置く。無ければ何も足さない', () => {
    const c = confirmOf({ irreversibleNote: 'always' }, { waitNote: '⏳ ロードバランサの削除には時間がかかります。' })
    const paragraphs = c.body.split('\n\n')
    expect(paragraphs[paragraphs.length - 2]).toBe('⏳ ロードバランサの削除には時間がかかります。')
    expect(confirmOf({ irreversibleNote: 'always' }, { waitNote: null }).body).not.toContain('⏳')
  })

  it('一覧が空なら、空のまま「次を…します: 」と出さない（最後の砦）', () => {
    const body = buildTeardownConfirmBody({
      verb: '破棄', targets: [], placements: [], dataNote: '', claimsComputeBillingStops: true, irreversibleNote: 'always',
    })
    expect(body).toBe('次を破棄します: （記録に名前を挙げられるものがありません）\n\nこの操作は元に戻せません。よろしいですか？')
  })

  it('teardownKindsOf: 名前（『…』）の前だけを種類として、順を保って重複なしで取り出す。名前の無い項目・空は数えない（0.6.21 の手本と同じ結果を書き下した）', () => {
    const cases: Array<[string[], string[]]> = [
      [['アプリ『app』', 'ロードバランサ『lb』', 'オートスケーリンググループ『asg』', 'クラスタ『c』'], ['アプリ', 'ロードバランサ', 'オートスケーリンググループ', 'クラスタ']],
      [['アプリ『a』', 'アプリ『b』'], ['アプリ']],
      [['名前なしの項目', '', '  ', '『だけ』'], ['名前なしの項目']],
      [[], []],
    ]
    for (const [targets, kinds] of cases) expect(teardownKindsOf(targets), JSON.stringify(targets)).toEqual(kinds)
    expect(teardownKindsOf(['アプリ『a』', 'アプリ『b』', 'クラスタ『c』'])).toEqual(['アプリ', 'クラスタ'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 手本の出力の写し（golden）との比べ: 専有型の仕様書で流すと、手本が返した確認の文と同じ文になる
// ═══════════════════════════════════════════════════════════════════════════════
//
// 3B-0 で、手本（buildDedicatedTeardownConfirm）を直接呼ぶ比べから向け直した（設計書 10.11.12）。
// 手本が画面に出ている間に確認の文（confirm.ts）を変える 3B-3（T161・STORAGE_USING_TARGETS）で「手本との比べ」が割れないように、
// 比べる相手は、手本の出力を書き出した JSON（tests/fixtures/dedicated-teardown-golden.json）。手本は 3B-7 で消えた（JSON が唯一の記録）。
// **golden を写しの出力で書き直さない**（書き直すと比べる意味が無くなる）。

describe('手本の出力の写しとの比べ: 専有型の仕様書（verb 削除・full・always・課金を言う）で、手本が返した確認の文と同じになる', () => {
  type DRec = GoldenRecord
  const golden = readGolden()
  const DEDICATED_WORDS: TeardownWords = {
    verb: '削除',
    confirmTitle: '専有型クラスタを削除します',
    confirmLabel: '削除する',
    activityLabel: '専有型クラスタの削除',
    rowButton: '🗑 削除',
    running: '削除しています…',
    doneHeadline: '✅ すべて削除しました',
    inProgressHeadline: '⏳ 削除の途中です',
    failedHeadline: '⚠️ 削除できませんでした',
    factsUnreadable: '削除するものの記録を読めませんでした',
    nothingToDo: NOTHING_TO_DELETE_MESSAGE,
    askAiTarget: 'さくらのAppRun（専有型）',
  }
  const dedicatedSpec: TargetSpec<DRec, { token: string; secret: string }, { ok: boolean }> = {
    target: 'sakura-apprun-dedicated',
    handler: 'apprunDedicated:teardown',
    words: DEDICATED_WORDS,
    claimsComputeBillingStops: true,
    irreversibleNote: 'always',
    readRecord: async () => GOLDEN_FULL_RECORD,
    hasWork: () => true,
    targets: r => dedicatedTeardownTargets(r),
    loadAuth: async () => ({ token: 't', secret: 's' }),
    invoke: async () => ({ ok: true }),
    failure: message => ({ ok: false, message }) as { ok: boolean },
    toView: raw => toTeardownView('sakura-apprun-dedicated', raw),
  }

  /** 新しい部品に渡す材料（材料の定義は golden と同じ tests/dedicatedGoldenCases.ts）。 */
  function commonFactsOf(c: GoldenConfirmCase): TeardownFacts<DRec> {
    const record = c.record ?? GOLDEN_FULL_RECORD
    return {
      projectName: 'myapp',
      record,
      placements: c.placements ?? [],
      placementsUnreadable: c.placementsUnreadable ?? false,
      placementsUnreadableCause: c.placementsUnreadable ? (c.cause ?? null) : null,
      otherTargets: c.otherTargets ?? [],
      otherTargetsUnreadable: c.otherTargetsUnreadable ?? false,
      waitNote: lbWaitNote(record, c.estimate ?? null),
    }
  }

  // ── 意図して違う文の表 ───────────────────────────────────────────────────────────────
  // 定義は tests/dedicatedGoldenCases.ts（本物の専有型の仕様書で流す tests/dedicatedTeardownGolden.test.ts と同じ表）。
  // **この表に無い違いは落ちる**（載せ替えの誤り）。行の id は設計書 10.11.12 の V の番号、count は当たる材料の数（表と実物がずれたら落ちる）。
  const INTENDED_DIFFERENCES = INTENDED_CONFIRM_DIFFERENCES

  const expectedBody = (c: GoldenConfirmCase) => INTENDED_DIFFERENCES.reduce((body, row) => row.apply(body, c), golden.confirm[c.name].body)

  it('写しの材料が、確認の文の材料（GOLDEN_CONFIRM_CASES）と過不足なく同じ', () => {
    expect(Object.keys(golden.confirm).sort()).toEqual(GOLDEN_CONFIRM_CASES.map(c => c.name).sort())
  })

  it.each(GOLDEN_CONFIRM_CASES.map(c => [c.name, c] as const))('★★ %s: 見出し・ボタン・danger が写しと同じで、本文は「意図して違う文」の表を当てた写しと一字一句同じ', (_name, c) => {
    const mine = buildTeardownConfirm(dedicatedSpec, commonFactsOf(c))
    const theirs = golden.confirm[c.name]
    expect(mine.title).toBe(theirs.title)
    expect(mine.confirmLabel).toBe(theirs.confirmLabel)
    expect(mine.danger).toBe(theirs.danger)
    expect(mine.body).toBe(expectedBody(c))
  })

  it.each(INTENDED_DIFFERENCES.map(row => [row.id, row] as const))('★★ 意図して違う文の表 %s: 書いた件数（count）ぶんの材料にだけ当たり、当たった材料の本文は写しと違う（死んだ行・広すぎる行を作らない）', (_id, row) => {
    const hit = GOLDEN_CONFIRM_CASES.filter(c => row.apply(golden.confirm[c.name].body, c) !== golden.confirm[c.name].body)
    expect(hit.map(c => c.name)).toHaveLength(row.count)
  })

  it('★★ 表に無い違いは落ちる: 新しい部品の本文が写しと違う材料は、表のどれかの行に当たる材料と過不足なく同じ', () => {
    const differing = GOLDEN_CONFIRM_CASES.filter(c => buildTeardownConfirm(dedicatedSpec, commonFactsOf(c)).body !== golden.confirm[c.name].body).map(c => c.name)
    const listed = GOLDEN_CONFIRM_CASES.filter(c => expectedBody(c) !== golden.confirm[c.name].body).map(c => c.name)
    expect(differing.sort()).toEqual(listed.sort())
  })

  it('★★ V4: 違うのは1点だけ。保存場所を問い合わせられなかった回（call・理由 null）でほかの公開先の名前を読めているとき、その名前を挙げる1段落が足される', () => {
    for (const name of ['call＋ほかの公開先を読めている', '理由が null＋ほかの公開先を読めている（call と同じ扱い）']) {
      const c = GOLDEN_CONFIRM_CASES.find(x => x.name === name)!
      const mine = buildTeardownConfirm(dedicatedSpec, commonFactsOf(c)).body
      const theirs = golden.confirm[name].body
      expect(mine, name).not.toBe(theirs)
      expect(mine, name).toContain(ADDED_SENTENCE((c.otherTargets ?? []).join('・')))
      expect(mine.replace(`\n\n${ADDED_SENTENCE((c.otherTargets ?? []).join('・'))}`, ''), name).toBe(theirs)
    }
  })

  it('★★ V5: 違うのは1点だけ。「読めなかった」注意の例に Vercel が入る（HANAMII・Vercel・共用型）', () => {
    for (const name of ['ほかの公開先の記録を読めなかった', 'settings とほかの公開先の記録の両方', 'call とほかの公開先の記録の両方']) {
      const c = GOLDEN_CONFIRM_CASES.find(x => x.name === name)!
      const mine = buildTeardownConfirm(dedicatedSpec, commonFactsOf(c)).body
      const theirs = golden.confirm[name].body
      expect(theirs, name).toContain(OLD_EXAMPLE)
      expect(mine, name).toContain(NEW_EXAMPLE)
      expect(mine.replace(NEW_EXAMPLE, OLD_EXAMPLE), name).toBe(theirs)
    }
  })

  it('★★ V6: 違うのは1点だけ。保存場所をほかの公開先も使っている段落が「でも使っているため、そちらで公開中の…」になる（保存場所1件でも2件でも）', () => {
    for (const name of ['保存場所1件＋ほかの公開先2つ', '保存場所2件＋ほかの公開先']) {
      const c = GOLDEN_CONFIRM_CASES.find(x => x.name === name)!
      const others = (c.otherTargets ?? []).join('・')
      const mine = buildTeardownConfirm(dedicatedSpec, commonFactsOf(c)).body
      const theirs = golden.confirm[name].body
      expect(theirs, name).toContain(`でも使っています。${others} で公開中のアプリのデータも消えます`)
      expect(mine, name).toContain(`${others} ${T161_NEW}（アプリ自体は消えません）。`)
      expect(mine, name).not.toContain('でも使っています')
      expect(mine.replace(`${others} ${T161_NEW}`, `${others} でも使っています。${others} で公開中のアプリのデータも消えます`), name).toBe(theirs)
    }
  })

  it('専有型でも settings の回は写しと同じ（ほかの公開先を読めていても、足さない）', () => {
    const c = GOLDEN_CONFIRM_CASES.find(x => x.name === 'settings＋ほかの公開先を読めている（足さない）')!
    expect(buildTeardownConfirm(dedicatedSpec, commonFactsOf(c)).body).toBe(golden.confirm[c.name].body)
  })
})
