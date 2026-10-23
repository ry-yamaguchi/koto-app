import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 専有型の「すべて削除」: 手順6と 📡 の 🗑 は、同じ流れ（2026-10-08・作者の決定）──────────────────────────────
//
// 作者の決定: 専有型の 📡 の「🗑 破棄」は、手順6「すべて削除する」と同じ「すべて削除」（アプリ → ロードバランサ →
// オートスケーリンググループ → クラスタ ＋ 保存場所）。アプリだけを消す口（apprunDedicated:teardownApp）は廃止した。
// 中身（処理と画面の流れ）は1つで、押せる場所はいまのまま（専有型タブの手順6と、📡 の各行の 🗑）。
// どちらから押しても、同じ確認の文・同じ進み具合・同じ閉じるときの警告・同じ結果・同じ公開の記録の片づけになる。
//
// 0.6.22 段階3B-4: A〜D3 は、共通の流れ（teardown/flow.ts）に専有型の仕様書（teardown/targets/dedicated.ts）を載せた形に向け直した
// （期待は変えない。変えたのは V2〜V6・V13・V15 に当たる所だけ。設計書 10.11.13）。
// 3B-5: E〜E3（📡 の行のフック・行）も、共通のフック useTeardownFlow と行 TeardownRow に専有型の仕様書を渡す形に向け直した
// （期待は変えない。変えたのは V1〜V2・V8 に当たる所だけ。結果の形が手本の返り値から TeardownView に、閉じて開き直した知らせの見出しが「🔔 削除の結果（…）」になった）。
// 3B-7: 手本が消えたので、手本の見張りの引数 kinds を見ていた節は消した（同じことは tests/teardownWatchCommon.test.ts が持つ。
// パネルの見張り watchDedicatedOps は手順5・6・8の3種類を読む＝tests/ops-dedicated-resume.test.ts）。
//
// ここは**ソースの文字列を読まない**（掟10「お金・破壊の歯止めは、振る舞いで固定する」。配線の形は tests/apprunDedicatedWiring.test.ts）。
//   (A) 流れの歯止め: 偽の口に流し、「やめる」なら IPC は0回・「削除する」なら confirmed:true で1回だけ、を数える
//   (B) 確認の文: 2つの入口で同じ入力なら同じ文。消えるもの・課金・ロードバランサの時間（目安の仕組みの出力）が入る
//   (C) 本物の main のハンドラ＋偽の HTTP サーバ（偽 client）: 📡 の入口から アプリ → LB → ASG → クラスタ の順に要求が出る
//   (D) 公開の記録: main が消す。画面（renderer）は消さない（偽の記録で、消えたこと・画面の口が呼ばれなかったことを見る）
//   (E) 📡 の行のフック（useTeardownFlow＋専有型の仕様書）を、React の小さな代役の上で実際に動かす:
//       確認 → 実行 → 進み具合 → 閉じるときの警告 → 結果。閉じて開き直したときの続き・結果。
//
// React は DOM 環境（jsdom 等）を入れていないので、react の useState／useRef／useCallback／useEffect だけを
// この試験用の小さな実装に差し替えて、フックの関数をそのまま呼ぶ（tests/stageEstimateEffect.test.ts と同じやり方）。

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: void | (() => void) } | undefined>,
  queue: [] as Array<{ idx: number; fn: () => void | (() => void); deps?: readonly unknown[] }>,
  i: 0, r: 0, e: 0,
  rerender: () => {},
}))
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  baseUrl: '',
  /** teardownFlow へ渡る前の sleep（待たずに進める）。 */
  gate: null as null | Promise<void>,
}))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => {
      const idx = rt.i++
      if (!(idx in rt.slots)) rt.slots[idx] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (v: unknown) => {
        const next = typeof v === 'function' ? (v as (p: unknown) => unknown)(rt.slots[idx]) : v
        if (Object.is(next, rt.slots[idx])) return
        rt.slots[idx] = next
        rt.rerender()
      }
      return [rt.slots[idx], set]
    },
    useRef: (init: unknown) => {
      const idx = rt.r++
      if (!rt.refs[idx]) rt.refs[idx] = { current: init }
      return rt.refs[idx]
    },
    useCallback: (fn: unknown) => fn,
    useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
      const idx = rt.e++
      const prev = rt.effects[idx]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps![k]))
      if (changed) rt.queue.push({ idx, fn, deps })
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

// 破棄の本体は実物。偽サーバへ向けるため baseUrl だけを足し、待たない sleep を入れる。
vi.mock('../src/main/cloud/apprunDedicatedApply', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    teardownFlow: (auth: any, dir: string, opts: any) => real.teardownFlow(auth, dir, { ...opts, sleep: async () => {} }, h.baseUrl),
  }
})

import { registerApprunDedicatedHandlers } from '../src/main/ipc/apprunDedicated'
import { writeApprunDedicatedRecordFs, writePublishRecordFs, readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { getOps, ackOps, setProjectOpsListener, resetProjectOpsForTests } from '../src/main/projectOps'
import { useTeardownFlow, type TeardownFlowOutcome } from '../src/renderer/teardown/useTeardownFlow'
import { runTeardownFlow, electronFlowDeps, teardownProgressText, type RunTeardownFlowDeps } from '../src/renderer/teardown/flow'
import { loadTeardownFacts, electronTeardownFactsApi, type TeardownFactsApi } from '../src/renderer/teardown/facts'
import { buildTeardownConfirm, buildTeardownConfirmBody, unreadableCautions } from '../src/renderer/teardown/confirm'
import type { TeardownFacts } from '../src/renderer/teardown/types'
import {
  dedicatedTeardownSpec, dedicatedTeardownTargets, lbWaitNote, DEDICATED_NOTHING_TO_DELETE_MESSAGE, DEDICATED_TEARDOWN_WORDS, DEDICATED_LIST_KEY_MISSING_MESSAGE,
  type DedicatedTeardownRecord, type DedicatedTeardownReply,
} from '../src/renderer/teardown/targets/dedicated'
import TeardownRow from '../src/renderer/components/teardown/TeardownRow'
import { dedicatedTeardownHasWork } from '../src/shared/teardownSupport'
import { withProjectLock } from '../src/main/projectLock'
import { shouldShowTeardownButton, shouldShowTeardownList } from '../src/renderer/apprunDedicatedActions'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import { estimatesFor, emptyStore } from '../src/shared/stageEstimate'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'

registerApprunDedicatedHandlers({} as any)

const AUTH = { token: 'tok', secret: 'sec' }
const tick = async () => { for (let k = 0; k < 6; k++) await new Promise<void>(r => setTimeout(r, 0)) }
const FULL_RECORD = { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1', applicationName: 'myapp' } as const
const OK_RESULT: DedicatedTeardownReply = { ok: true, executed: ['x'], message: '', remaining: {} }

// ═══════════════════════════════════════════════════════════════════════════════
// (A) 流れの歯止め（偽の口）
// ═══════════════════════════════════════════════════════════════════════════════

const FACTS: TeardownFacts<DedicatedTeardownRecord> = {
  projectName: 'myapp',
  record: FULL_RECORD,
  placements: [],
  placementsUnreadable: false,
  placementsUnreadableCause: null,
  otherTargets: [],
  otherTargetsUnreadable: false,
  waitNote: lbWaitNote(FULL_RECORD, '目安 約9分（開発時の実測・2026-09-10）'),
}

type FlowDeps = RunTeardownFlowDeps<DedicatedTeardownRecord, { token: string; secret: string }, DedicatedTeardownReply>
/** 確認の答えは、true／false のほか、不明な値（V15）も渡せる。 */
function fakeDeps(over: Partial<FlowDeps> & { answer?: unknown } = {}) {
  const calls = {
    teardown: [] as Array<{ dir: string; auth: unknown; opts: unknown }>,
    confirm: [] as unknown[],
    begin: [] as Array<{ label: string; opts: unknown }>,
    ended: 0, started: 0, keyLoads: 0, facts: 0,
  }
  const deps: FlowDeps = {
    loadFacts: async () => { calls.facts++; return FACTS },
    confirm: async o => { calls.confirm.push(o); return ('answer' in over ? over.answer : true) as boolean },
    loadAuth: async () => { calls.keyLoads++; return AUTH },
    invoke: async (dir, auth, opts) => { calls.teardown.push({ dir, auth, opts }); return OK_RESULT },
    beginActivity: (label, opts) => { calls.begin.push({ label, opts }); return () => { calls.ended++ } },
    onStart: () => { calls.started++ },
    keyMissingMessage: 'キーが未登録です（テスト）',
    ...over,
  }
  delete (deps as any).answer
  return { deps, calls }
}

const runFlow = (dir: string, deps: FlowDeps) => runTeardownFlow(dir, dedicatedTeardownSpec, deps)
/** 記録の読み口だけを偽物にした専有型の仕様書（確認の材料を読む試験用。ほかの項目は本物）。 */
const specWith = (readRecord: () => Promise<DedicatedTeardownRecord>) => ({ ...dedicatedTeardownSpec, readRecord })
const confirmOf = (facts: TeardownFacts<DedicatedTeardownRecord>) => buildTeardownConfirm(dedicatedTeardownSpec, facts)

describe('(A) runTeardownFlow（専有型の仕様書）: 確認が no なら IPC は0回・yes なら confirmed:true で1回だけ', () => {
  it('★★ yes: IPC（apprunDedicated:teardown）が { confirmed: true } 付きで1回だけ。窓を閉じるときの警告つきで活動レジストリに載り、終われば必ず外れる', async () => {
    const { deps, calls } = fakeDeps()
    const out = await runFlow('/p', deps)
    expect(out).toEqual({ cancelled: false, result: OK_RESULT })
    expect(calls.teardown).toEqual([{ dir: '/p', auth: AUTH, opts: { confirmed: true } }])
    expect(calls.started).toBe(1)
    expect(calls.begin).toEqual([{ label: '専有型クラスタの削除', opts: { closeWarning: PUBLISH_CLOSE_WARNING } }])
    expect(calls.ended).toBe(1)
  })

  it('★ 実行が始まる直前の画面の更新（onStart。手順6では beginLocal）は、キーの読み込み・IPC より前', async () => {
    const order: string[] = []
    const { deps } = fakeDeps({
      onStart: () => { order.push('onStart') },
      loadAuth: async () => { order.push('loadAuth'); return AUTH },
      invoke: async () => { order.push('invoke'); return OK_RESULT },
    })
    await runFlow('/p', deps)
    expect(order).toEqual(['onStart', 'loadAuth', 'invoke'])
  })

  it('★★ no（やめる）: IPC は0回。キーも読まず、活動レジストリにも載せず、画面を「削除しています…」にもしない', async () => {
    const { deps, calls } = fakeDeps({ answer: false })
    const out = await runFlow('/p', deps)
    expect(out).toEqual({ cancelled: true })
    expect(calls.teardown).toEqual([])
    expect(calls.keyLoads).toBe(0)
    expect(calls.begin).toEqual([])
    expect(calls.started).toBe(0)
    expect(calls.confirm).toHaveLength(1) // 確認は出した
  })

  // V15（10.11.12）: 手本は `if (!confirmed)` で真偽の緩い判定だった。共通の流れは true のときだけ進む（不明な値を肯定に戻さない）。
  it.each([['yes'], [1], [{}], ['true'], [undefined], [null]])('★★ V15: 確認の答えが %j（true ではない）なら進まない。IPC は0回、キーも読まず、活動レジストリにも載せない', async answer => {
    const { deps, calls } = fakeDeps({ answer })
    const out = await runFlow('/p', deps)
    expect(out).toEqual({ cancelled: true })
    expect(calls.teardown).toEqual([])
    expect(calls.keyLoads).toBe(0)
    expect(calls.begin).toEqual([])
    expect(calls.started).toBe(0)
  })

  it('★ 確認の材料が読めなければ、確認も IPC も出さずに失敗の結果を返す（消すものが分からないまま消させない）', async () => {
    const { deps, calls } = fakeDeps({ loadFacts: async () => { throw new Error('読めない') } })
    const out = await runFlow('/p', deps)
    expect(out.cancelled).toBe(false)
    expect((out as any).result.ok).toBe(false)
    expect((out as any).result.message).toContain('読めない')
    expect(calls.confirm).toEqual([])
    expect(calls.teardown).toEqual([])
    expect(calls.begin).toEqual([])
  })

  it('★ キーが無ければ IPC は0回。入口ごとの案内文を返す。活動レジストリは外れる', async () => {
    const { deps, calls } = fakeDeps({ loadAuth: async () => null })
    const out = await runFlow('/p', deps)
    expect((out as any).result).toEqual({ ok: false, executed: [], message: 'キーが未登録です（テスト）', remaining: {} })
    expect(calls.teardown).toEqual([])
    expect(calls.ended).toBe(calls.begin.length)
    expect(calls.begin).toHaveLength(1)
  })

  it('★ IPC が例外でも、活動レジストリは必ず外れる（実行中の印が残らない）', async () => {
    const { deps, calls } = fakeDeps({ invoke: async () => { throw new Error('通信失敗') } })
    await expect(runFlow('/p', deps)).rejects.toThrow('通信失敗')
    expect(calls.begin).toHaveLength(1)
    expect(calls.ended).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// (B) 確認の文: 2つの入口で同じ入力なら同じ文
// ═══════════════════════════════════════════════════════════════════════════════

describe('(B) buildTeardownConfirm（専有型の仕様書）: 消えるもの・課金・ロードバランサの時間', () => {
  it('★★ 手順6の入口で作った確認と、📡 の入口で作った確認は、同じ入力なら1文字も違わない（入口は同じ関数を呼ぶだけ）', async () => {
    const step6 = fakeDeps()
    const list = fakeDeps({ keyMissingMessage: '別の案内文（入口ごとに違ってよいのはここだけ）' })
    await runFlow('/p', step6.deps)
    await runFlow('/p', list.deps)
    expect(step6.calls.confirm).toHaveLength(1)
    expect(list.calls.confirm).toEqual(step6.calls.confirm)
    expect(step6.calls.confirm[0]).toEqual(confirmOf(FACTS))
  })

  it('消えるもの（アプリ → LB → ASG → クラスタ）の名前・課金が止まること・ロードバランサの時間（目安の仕組みの出力）が入る', () => {
    const c = confirmOf(FACTS)
    expect(c.title).toBe('専有型クラスタを削除します')
    expect(c.confirmLabel).toBe('削除する')
    expect(c.danger).toBe(true)
    expect(c.body).toContain("次を削除します: アプリ『myapp』・ロードバランサ『l1』・オートスケーリンググループ『a1』・クラスタ『c1』")
    // 並び順（main の teardownFlow と同じ）
    const at = ['アプリ『', 'ロードバランサ『', 'オートスケーリンググループ『', 'クラスタ『'].map(k => c.body.indexOf(k))
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(c.body).toContain('アプリ・ロードバランサ・オートスケーリンググループ・クラスタの課金は止まります。')
    expect(c.body).toContain('この操作は元に戻せません。')
    expect(c.body).toContain('⏳ ロードバランサの削除には時間がかかります。目安 約9分（開発時の実測・2026-09-10）。')
    // 時間の予告は最後の問い（元に戻せません…よろしいですか？）の直前
    expect(c.body.indexOf('⏳')).toBeLessThan(c.body.indexOf('この操作は元に戻せません。'))
    // V2（D10）: ロードバランサが記録にあるので DNS の A レコードの1行が出る。時間の予告の前
    expect(c.body).toContain('🌐 独自ドメインの DNS に、このロードバランサを指す A レコードがあれば、DNS の管理画面で削除してください。')
    expect(c.body.indexOf('🌐')).toBeLessThan(c.body.indexOf('⏳'))
    // 「アプリだけ」の文・「残ります」の文は戻らない
    for (const gone of ['アプリだけ', 'クラスタ・ロードバランサは残ります', '手順6から', '消さない限り課金が続きます']) expect(c.body).not.toContain(gone)
    expect(c.body, '丸数字').not.toMatch(/[①-⑳]/)
  })

  it('★ ロードバランサの目安は、目安の仕組み（shared/stageEstimate.ts の estimatesFor）の出力そのもの。数字はここで持たない', async () => {
    const api: TeardownFactsApi = {
      placements: async () => [],
      otherTargets: async () => [],
      estimates: async () => estimatesFor(emptyStore()), // この Mac に記録が無い状態＝開発時の実測
    }
    const facts = await loadTeardownFacts('/p', specWith(async () => FULL_RECORD), api)
    expect(facts.waitNote).toBe('⏳ ロードバランサの削除には時間がかかります。目安 約9分（開発時の実測・2026-09-10）。')
    expect(confirmOf(facts).body).toContain('目安 約9分（開発時の実測・2026-09-10）')
    // この Mac で測れていれば、その中央値に変わる（文は同じ仕組み）
    const measured = { ...emptyStore(), stages: { 'teardown.lb': [{ ms: 6 * 60_000, at: '2026-10-01T00:00:00.000Z', version: '0', zone: null }] } }
    const facts2 = await loadTeardownFacts('/p', specWith(async () => FULL_RECORD), { ...api, estimates: async () => estimatesFor(measured) })
    expect(facts2.waitNote).toBe('⏳ ロードバランサの削除には時間がかかります。目安 約6分（この Mac での前回の実測）。')
  })

  it('ロードバランサが記録に無い・目安が読めないときは、時間の予告を作らない（無い段に目安を作らない）', async () => {
    expect(lbWaitNote({ clusterID: 'c1' }, '目安 約9分（開発時の実測・2026-09-10）')).toBeNull()
    expect(lbWaitNote(FULL_RECORD, null)).toBeNull()
    const api: TeardownFactsApi = {
      placements: async () => [], otherTargets: async () => [],
      estimates: async () => { throw new Error('読めない') },
    }
    const facts = await loadTeardownFacts('/p', specWith(async () => FULL_RECORD), api)
    expect(facts.waitNote).toBeNull()
    expect(confirmOf(facts).body).not.toContain('⏳')
  })

  it('★★ 保存場所は全件を名指しし、保存場所を共有しているほかの公開先も言う。材料は押した時点で読み直す', async () => {
    const api: TeardownFactsApi = {
      placements: async () => [{ bucket: 'koto-data-x', prefix: 'projects/a/', shared: true }, { bucket: 'koto-data-y', prefix: 'projects/a/', shared: true }],
      otherTargets: async () => ['🌸 HANAMII'],
      estimates: async () => ({}),
    }
    const body = confirmOf(await loadTeardownFacts('/p', specWith(async () => FULL_RECORD), api)).body
    expect(body).toContain("保存場所『koto-data-x』『koto-data-y』にある、このプロジェクトのデータ")
    expect(body).toContain('も削除します')
    expect(body).toContain('🌸 HANAMII')
  })

  it('資源の記録が読めなければ投げる（消すものが分からないまま確認を出さない）。保存場所・ほかの公開先が読めないだけなら空に倒す', async () => {
    await expect(loadTeardownFacts('/p', specWith(async () => { throw new Error('記録なし') }), {
      placements: async () => [], otherTargets: async () => [], estimates: async () => ({}),
    })).rejects.toThrow('記録なし')
    const facts = await loadTeardownFacts('/p', specWith(async () => FULL_RECORD), {
      placements: async () => { throw new Error('x') }, otherTargets: async () => { throw new Error('y') }, estimates: async () => { throw new Error('z') },
    })
    expect(facts.placements).toEqual([])
    expect(facts.otherTargets).toEqual([])
    expect(facts.waitNote).toBeNull()
    // 空に倒すが、**読めなかった事実は残す**（確認の文で言う。黙って「消えるものは無い」ことにしない・2026-10-08 検分）
    expect(facts.placementsUnreadable).toBe(true)
    expect(facts.otherTargetsUnreadable).toBe(true)
    // 読めた回は立たない（空の配列が返ったのは「読めて、無かった」）
    const ok = await loadTeardownFacts('/p', specWith(async () => FULL_RECORD), { placements: async () => [], otherTargets: async () => [], estimates: async () => ({}) })
    expect(ok.placementsUnreadable).toBe(false)
    expect(ok.otherTargetsUnreadable).toBe(false)
  })

  it('dedicatedTeardownTargets: 記録にあるものだけを、アプリ → LB → ASG → クラスタの順に', () => {
    expect(dedicatedTeardownTargets({ clusterID: 'c1', applicationID: 'app1' })).toEqual(["アプリ『app1』", "クラスタ『c1』"])
    expect(dedicatedTeardownTargets({ applicationID: 'app1', applicationName: 'myapp' })).toEqual(["アプリ『myapp』"])
    expect(dedicatedTeardownTargets(null)).toEqual([])
  })

  it('teardownProgressText: 記録が「削除が走っている」と言えばその文・言わなければ、この画面が受けた最新の1行（入口によらず同じ選び方）', () => {
    const rec = { progress: { label: '記録の文', detail: '（2分経過）' } }
    expect(teardownProgressText({ running: true, runningRecord: rec, local: '手元の文' })).toBe('記録の文 （2分経過）')
    expect(teardownProgressText({ running: false, runningRecord: null, local: '手元の文' })).toBe('手元の文')
    expect(teardownProgressText({ running: false, runningRecord: rec, local: null })).toBeNull() // 別の操作（公開など）の記録の文は出さない
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// (B2) 確認の中身: プロジェクト名・読めなかった材料の注意・消すものが記録に無いとき（2026-10-08 検分）
// ═══════════════════════════════════════════════════════════════════════════════

describe('(B2) 確認の中身: 対象のプロジェクト名・読めなかった材料の注意', () => {
  const apiOf = (over: Partial<TeardownFactsApi> = {}): TeardownFactsApi => ({
    placements: async () => [], otherTargets: async () => [], estimates: async () => ({}), ...over,
  })
  const cautionsOf = (f: Partial<TeardownFacts<DedicatedTeardownRecord>>) =>
    unreadableCautions({ ...FACTS, ...f }, DEDICATED_TEARDOWN_WORDS, dedicatedTeardownSpec.irreversibleNote, dedicatedTeardownSpec.target)

  it('★ 先頭に対象のプロジェクト名が入る（全プロジェクトが並ぶ 📡 の一覧で、どのプロジェクトのものを消すか確かめられる）', async () => {
    const facts = await loadTeardownFacts('/Users/x/projects/myapp-copy', specWith(async () => FULL_RECORD), apiOf())
    expect(facts.projectName).toBe('myapp-copy')
    const body = confirmOf(facts).body
    expect(body.startsWith('対象のプロジェクト: 『myapp-copy』\n\n')).toBe(true)
    // 入口ではなく、渡されたプロジェクトで決まる
    expect(confirmOf({ ...facts, projectName: 'other' }).body).toContain('『other』')
    expect(confirmOf({ ...facts, projectName: 'other' }).body).not.toContain('myapp-copy')
  })

  it('★★ 保存場所の設定を読めなかったら、確認の文がそれを言う。言うのは事実どおり「保存場所の削除は行われず、残る」こと。読めた回は言わない', () => {
    const base = confirmOf(FACTS).body
    expect(base).not.toContain('読めない')
    expect(base).not.toContain('読めなかった')
    expect(cautionsOf({})).toEqual([])
    const body = confirmOf({ ...FACTS, placementsUnreadable: true, placementsUnreadableCause: 'settings' }).body
    expect(body).toContain('保存場所の設定を読めないため、保存場所の削除は行われません')
    expect(body).toContain('その保存場所は残り、月額が続きます')
    expect(body).toContain('設定を直してからやり直してください')
    // 直す前の文（事実と逆）は戻さない: 保存場所の設定が読めないとき、main は保存場所に触れない＝データは消えない
    expect(body).not.toContain('その中のこのプロジェクトのデータも削除されます')
    expect(body).not.toContain('ここに保存場所の名前を挙げられません')
    // 読み飛ばされにくい先頭（「次を削除します」より前）
    expect(body.indexOf('保存場所の設定を読めない')).toBeLessThan(body.indexOf('次を削除します'))
    // 2026-10-08 検分: 問い合わせそのものが失敗した（IPC の reject）回は、「削除は行われません」とは言わない（main は env.json を読めて、
    // 保存場所を削除するかもしれない）。名前を挙げられないことと、削除される場合があることを言う。原因が省略された回も同じ（言い切らない側）
    for (const cause of ['call', undefined, null] as const) {
      const call = confirmOf({ ...FACTS, placementsUnreadable: true, placementsUnreadableCause: cause as 'call' | null }).body
      expect(call, String(cause)).toContain('保存場所の設定を問い合わせられなかったため、ここに保存場所の名前を挙げられません')
      expect(call, String(cause)).toContain('その中のこのプロジェクトのデータも削除される場合があります')
      expect(call, String(cause)).not.toContain('保存場所の削除は行われません')
      expect(call, String(cause)).not.toContain('その保存場所は残り、月額が続きます')
    }
    // 読めた回（原因だけが残っていても、placementsUnreadable が false なら言わない）
    expect(cautionsOf({ placementsUnreadable: false, placementsUnreadableCause: 'settings' })).toEqual([])
    const others = confirmOf({ ...FACTS, otherTargetsUnreadable: true }).body
    expect(others).toContain('ほかの公開先の記録を読めなかったため')
    expect(others).not.toContain('保存場所の設定を読めない')
  })

  it('★ 消すものの一覧が空でも「次を削除します: 」と空のまま出さない（名指ししないまま「削除する」を押させない・最後の砦）', () => {
    const common = { verb: '削除', placements: [], dataNote: '', claimsComputeBillingStops: true, irreversibleNote: 'always' } as const
    const msg = buildTeardownConfirmBody({ ...common, targets: [] })
    expect(msg).not.toMatch(/次を削除します: \n/)
    expect(msg).toContain('次を削除します: （記録に名前を挙げられるものがありません）')
    // 一覧があるときの文は変わらない
    expect(buildTeardownConfirmBody({ ...common, targets: ["クラスタ『c1』"] })).toContain("次を削除します: クラスタ『c1』")
  })
})

describe('(B2) dedicatedTeardownHasWork: 「消すものが記録にあるか」は1つの判断', () => {
  it('★★ 手順6のボタンの出し分け（shouldShowTeardownButton）と、記録の全組み合わせ（applicationID を含む5項目・32通り）で同じ答え（判断が2か所に分かれない）', () => {
    // 2026-10-08 検分 E: 以前は applicationID を回さず（手順6は クラスタ・ASG・LB の3つだけで判断）、「全組み合わせで同じ」と言い切れていなかった。
    // いまは手順6も dedicatedTeardownHasWork の1つで判断する。applicationID だけの記録でも、手順6のボタンは出る（押すと main が止める）。
    const vals = [null, 'x']
    let n = 0
    for (const applicationID of vals) for (const clusterID of vals) for (const asgID of vals) for (const loadBalancerID of vals) for (const storageLeftoverBucket of vals) {
      const rec = { applicationID, clusterID, asgID, loadBalancerID, storageLeftoverBucket }
      expect(dedicatedTeardownHasWork(rec), JSON.stringify(rec)).toBe(shouldShowTeardownButton({ record: rec, running: false }))
      n++
    }
    expect(n).toBe(32)
  })

  it('★★★ 何を消すかの一覧（shouldShowTeardownList）はボタンと同じ判断から、保存場所の印だけを除いたもの。ボタンがあるのに一覧が無い、にならない（32通り）', () => {
    // 2026-10-08 検分 E の副作用: ボタンを dedicatedTeardownHasWork に揃えたあと、一覧は「クラスタ・ASG・LB のどれか」のままで、
    // アプリのIDだけの記録ではボタンがあるのに何を消すかの一覧が無かった。一覧もボタンの土台に揃える。
    const vals = [null, 'x']
    for (const applicationID of vals) for (const clusterID of vals) for (const asgID of vals) for (const loadBalancerID of vals) for (const storageLeftoverBucket of vals) {
      const rec = { applicationID, clusterID, asgID, loadBalancerID, storageLeftoverBucket }
      const anyId = !!(applicationID || clusterID || asgID || loadBalancerID)
      expect(shouldShowTeardownList(rec), JSON.stringify(rec)).toBe(anyId)
      // ボタンは「一覧に並べる行がある」または「保存場所の印だけがある」ときに出る。一覧は印だけでは出さない（並べる行が無い）
      expect(shouldShowTeardownButton({ record: rec, running: false }), JSON.stringify(rec)).toBe(shouldShowTeardownList(rec) || !!storageLeftoverBucket)
    }
    // アプリのIDだけの記録（本来は起きない）: ボタンも一覧も出る
    expect(shouldShowTeardownList({ applicationID: 'app1' })).toBe(true)
    // 保存場所の印だけ: ボタンは出る（一言は storageLeftoverNote）が、一覧は空なので出さない
    expect(shouldShowTeardownList({ storageLeftoverBucket: 'koto-data-x' })).toBe(false)
    expect(shouldShowTeardownList(null)).toBe(false)
    expect(shouldShowTeardownList(undefined)).toBe(false)
    // 画面は、この判断で一覧を出す（hasAnyResource のまま戻らない）。0.6.22 3B-6a から、一覧を描くのは手順6の節（DedicatedTeardownSection.tsx）。
    const section = fs.readFileSync(path.join(__dirname, '../src/renderer/components/DedicatedTeardownSection.tsx'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')
    expect(section).toContain('{shouldShowTeardownList(apprunState) && (')
  })

  it('★★ 走っている間は、記録が空でも手順6は出る。📡 の 🗑 の確認（dedicatedTeardownHasWork）は走っているかを見ない（別の話）', () => {
    expect(shouldShowTeardownButton({ record: {}, running: true })).toBe(true)
    expect(dedicatedTeardownHasWork({})).toBe(false)
  })

  it('アプリだけの記録も「消すもの」。空・null・undefined・空文字は「無い」', () => {
    expect(dedicatedTeardownHasWork({ applicationID: 'app1' })).toBe(true)
    expect(dedicatedTeardownHasWork({ storageLeftoverBucket: 'koto-data-x' })).toBe(true)
    expect(dedicatedTeardownHasWork({})).toBe(false)
    expect(dedicatedTeardownHasWork(null)).toBe(false)
    expect(dedicatedTeardownHasWork(undefined)).toBe(false)
    expect(dedicatedTeardownHasWork({ applicationID: '', clusterID: '', asgID: null, loadBalancerID: undefined, storageLeftoverBucket: '' })).toBe(false)
  })
})

describe('(B2) electronTeardownFactsApi（本物の口）: storage:placement の全件を、確認の文まで落とさない', () => {
  const A = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
  const B = { bucket: 'koto-data-b', prefix: 'projects/myapp/', shared: true }
  const reply = (r: unknown) => { (globalThis as any).window.electronAPI.storage.placement = async () => r }

  it('★★★ 2件返れば2件とも確認の文に名指しされる（先頭1件だけを読むと『B』が名指しされないまま消える）', async () => {
    reply({ ok: true, placement: A, placements: [A, B] })
    const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
    expect(facts.placements).toEqual([A, B])
    expect(facts.placementsUnreadable).toBe(false)
    const body = confirmOf(facts).body
    expect(body).toContain('保存場所『koto-data-a』『koto-data-b』にある、このプロジェクトのデータ')
  })

  it('★★ placements が無い古い応答でも、先頭1件は拾う（黙って空にしない）', async () => {
    reply({ ok: true, placement: A })
    const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
    expect(facts.placements).toEqual([A])
    expect(confirmOf(facts).body).toContain('保存場所『koto-data-a』')
  })

  it('★★ 読めなかった（ok:false）は、空とは別の事実。placementsUnreadable が立ち、確認の文が「読めなかった」と言う', async () => {
    reply({ ok: false, placement: null, placements: [], message: 'env.json が壊れています' })
    const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
    expect(facts.placements).toEqual([])
    expect(facts.placementsUnreadable).toBe(true)
    expect(facts.placementsUnreadableCause).toBe('settings')
    expect(confirmOf(facts).body).toContain('保存場所の設定を読めないため、保存場所の削除は行われません')
    // 例外で読めなかったとき（IPC の失敗）も「読めなかった」事実は残る。ただし理由が違う——設定を読めなかったのではなく、問い合わせそのものが失敗した。
    // main は env.json を読めて保存場所を削除するかもしれないので、「削除は行われません」とは言わない（2026-10-08 検分）
    ;(globalThis as any).window.electronAPI.storage.placement = async () => { throw new Error('IPC 失敗') }
    const facts2 = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
    expect(facts2.placementsUnreadable).toBe(true)
    expect(facts2.placementsUnreadableCause).toBe('call')
    const body2 = confirmOf(facts2).body
    expect(body2).toContain('保存場所の設定を問い合わせられなかったため')
    expect(body2).toContain('削除される場合があります')
    expect(body2).not.toContain('保存場所の削除は行われません')
  })

  it('読めた回は理由も立たない（placementsUnreadable:false・placementsUnreadableCause:null）', async () => {
    reply({ ok: true, placement: null, placements: [] })
    const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
    expect(facts.placementsUnreadable).toBe(false)
    expect(facts.placementsUnreadableCause).toBeNull()
  })

  it('読めて 0 件（保存場所を用意していない）なら、「読めなかった」とは言わない', async () => {
    reply({ ok: true, placement: null, placements: [] })
    const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
    expect(facts.placements).toEqual([])
    expect(facts.placementsUnreadable).toBe(false)
    expect(confirmOf(facts).body).not.toContain('読めなかった')
  })
})

// ── (B3) ほかの公開先の記録（.sakuraide.json）を読めなかったら、otherTargetsUnreadable が立つ（2026-10-08 検分 A）──────────
// 直す前は、本物の口（electronFactsApi）の otherTargets が readPublishTargets（失敗も壊れた JSON も [] に倒して投げない）を呼んでいた。
// そのため loadTeardownFacts の「投げたら unreadable」の道は、偽の口の試験でしか通らず、**本物の口では一度も立たなかった**
// （確認の文の「ほかの公開先の記録を読めなかったため…」の注意が、実際には出ない）。偽 window の fs.readFile を壊して、本物の口で見る。
describe('(B3) electronTeardownFactsApi（本物の口）: ほかの公開先の記録を読めなかったら、otherTargetsUnreadable が立ち、確認の文が注意を言う', () => {
  const setReadFile = (fn: (p: string) => Promise<string>) => { (globalThis as any).window.electronAPI.fs.readFile = fn }
  const CAUTION = 'ほかの公開先の記録を読めなかったため'

  it('★★★ fs.readFile が reject すると立つ。ほかの公開先は空に倒すが、「読めなかった」事実は残り、確認の文が言う', async () => {
    setReadFile(async () => { throw new Error('EACCES: permission denied') })
    const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
    expect(facts.otherTargets).toEqual([])
    expect(facts.otherTargetsUnreadable).toBe(true)
    expect(confirmOf(facts).body).toContain(CAUTION)
  })

  it.each([
    ['壊れた JSON', '{ 壊れた'],
    ['中身がオブジェクトでない（配列）', '[]'],
    ['中身がオブジェクトでない（null）', 'null'],
    ['publish が文字列', JSON.stringify({ publish: 'x' })],
    ['publish.targets が文字列', JSON.stringify({ publish: { targets: 'x' } })],
  ])('★★ 読めたが形が違う／壊れている（%s）も「読めなかった」。空に倒して続けるが、事実は残る', async (_label, text) => {
    setReadFile(async () => text)
    const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
    expect(facts.otherTargets).toEqual([])
    expect(facts.otherTargetsUnreadable).toBe(true)
  })

  it('★ 読めて、ほかの公開先が無い（専有型だけ・publish や targets が無い）なら、「読めなかった」とは言わない', async () => {
    for (const text of [
      JSON.stringify({ publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: 't' } } } }),
      JSON.stringify({ publish: {} }),
      JSON.stringify({}),
    ]) {
      setReadFile(async () => text)
      const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
      expect(facts.otherTargets, text).toEqual([])
      expect(facts.otherTargetsUnreadable, text).toBe(false)
      expect(confirmOf(facts).body, text).not.toContain(CAUTION)
    }
  })

  it('★ 読めて、ほかの公開先がある（このプロジェクトの記録は Vercel もある）なら、その名前を出し、「読めなかった」とは言わない', async () => {
    const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi()) // beforeEach の本物の .sakuraide.json（専有型 ＋ Vercel）
    expect(facts.otherTargets).toEqual([PUBLISH_TARGET_LABEL.vercel])
    expect(facts.otherTargetsUnreadable).toBe(false)
    expect(confirmOf(facts).body).not.toContain(CAUTION)
  })

  it('★★ 入口（electronFlowDeps）から確認ダイアログまで通しても、読めなかった注意が出る。やめれば IPC は0回', async () => {
    setReadFile(async () => { throw new Error('ENOENT') })
    const { deps, asked } = entryDeps(false)
    const out = await runFlow(dir, deps)
    expect(out).toEqual({ cancelled: true })
    expect(asked).toHaveLength(1)
    expect((asked[0] as { body: string }).body).toContain(CAUTION)
    expect(win.ipcTeardown).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// (C)(D)(E) 本物の main のハンドラ ＋ 偽の HTTP サーバ（偽 client）
// ═══════════════════════════════════════════════════════════════════════════════

type Route = { status: number; body: unknown }
let server: Server | null = null
/** 偽サーバ。`METHOD /path` をキーに応答する。配列なら n 回目に n 番目（最後は繰り返す）。LB の DELETE だけ `h.gate` で止められる。 */
async function startServer(routes: Record<string, Route | Route[]>, calls: string[]): Promise<string> {
  const seen = new Map<string, number>()
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const key = `${req.method} ${req.url}`
      calls.push(key)
      req.on('data', () => {})
      req.on('end', async () => {
        if (key === 'DELETE /clusters/c1/asg/a1/load_balancers/l1' && h.gate) await h.gate
        const entry = routes[key]
        const n = seen.get(key) ?? 0
        seen.set(key, n + 1)
        const route = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry
        const status = route?.status ?? 404
        if (status === 204) { res.writeHead(204); res.end(); return }
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(route?.body ?? { error: `test router: 未定義のルート ${key}` }))
      })
    })
    server.listen(0, () => {
      const addr = server?.address()
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}/`)
      else reject(new Error('サーバのポートを取得できませんでした'))
    })
  })
}

const LB_GONE: Route = { status: 200, body: { loadBalancers: [] } }
const LB_DELETING: Route = { status: 200, body: { loadBalancers: [{ loadBalancerID: 'l1', name: 'myapp', deleting: true, created: 1, serviceClassPath: 'x' }] } }
function allRoutes(extra: Record<string, Route | Route[]> = {}): Record<string, Route | Route[]> {
  return {
    'GET /applications/app1': { status: 200, body: { application: { applicationID: 'app1', name: 'myapp', clusterID: 'c1', activeVersion: null } } },
    'GET /applications/app1/containers': { status: 200, body: { nodes: [] } },
    'DELETE /applications/app1': { status: 204, body: {} },
    'GET /applications?clusterID=c1&maxItems=20': { status: 200, body: { applications: [] } },
    'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 204, body: {} },
    'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': LB_GONE,
    'DELETE /clusters/c1/asg/a1': { status: 204, body: {} },
    'GET /clusters/c1/asg?maxItems=20': { status: 200, body: { autoScalingGroups: [] } },
    'DELETE /clusters/c1': { status: 204, body: {} },
    'GET /clusters?maxItems=20': { status: 200, body: { clusters: [] } },
    ...extra,
  }
}

let dir = ''
type Win = {
  /** 画面の口が呼ばれた回数（IPC の呼び出し・公開記録を消す口・知らせ）。 */
  ipcTeardown: Array<{ dir: string; auth: unknown; opts: unknown }>
  forgetTarget: unknown[][]
  dispatched: string[]
  busy: unknown[][]
  progressListeners: Set<(m: string) => void>
  progressSent: string[]
  acks: Array<[string, number | undefined]>
}
let win: Win
const EVENT = { sender: { send: (ch: string, msg: string) => { if (ch === 'apprunDedicated:teardown-progress') { win.progressSent.push(msg); for (const cb of [...win.progressListeners]) cb(msg) } } } }

function installWindow(opts: { key?: { token: string; secret: string } | null } = {}) {
  win = { ipcTeardown: [], forgetTarget: [], dispatched: [], busy: [], progressListeners: new Set(), progressSent: [], acks: [] }
  const subs = new Set<(p: any) => void>()
  setProjectOpsListener((projectDir, snapshot) => { for (const cb of [...subs]) cb({ projectDir, ...snapshot }) })
  ;(globalThis as any).window = {
    electronAPI: {
      apprunDedicated: {
        state: async (d: string) => h.handlers.get('apprunDedicated:state')!(EVENT, d),
        teardown: async (d: string, auth: unknown, o: unknown) => {
          win.ipcTeardown.push({ dir: d, auth, opts: o })
          return h.handlers.get('apprunDedicated:teardown')!(EVENT, d, auth, o)
        },
        onTeardownProgress: (cb: (m: string) => void) => { win.progressListeners.add(cb); return () => { win.progressListeners.delete(cb) } },
      },
      cloud: { loadKey: async () => (opts.key === undefined ? AUTH : opts.key) },
      storage: { placement: async () => ({ ok: true, placement: null, placements: [] }) },
      // exists は、旧い記録（state.json）の有無を調べる読み口が使う（D9=2。ほかの公開先の読み口は旧い記録も数える）。
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8'), exists: async (p: string) => fs.existsSync(p) },
      stageTiming: { estimates: async () => estimatesFor(emptyStore()) },
      win: { setBusy: (...a: unknown[]) => { win.busy.push(a) } },
      // 画面が公開記録を消す口。呼ばれたら「画面が消した」ことになる（呼ばれないことを固定する）。
      publishMeta: {
        forgetTarget: async (...a: unknown[]) => { win.forgetTarget.push(a); return { ok: true, meta: {} } },
        merge: async (...a: unknown[]) => { win.forgetTarget.push(a); return { ok: true, meta: {} } },
      },
      projectOps: {
        get: async (d: string) => getOps(d),
        ack: async (d: string, upTo?: number) => { win.acks.push([d, upTo]); return { ok: true, acked: ackOps(d, upTo) } },
        onChanged: (cb: (p: any) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
      },
    },
    dispatchEvent: (e: { type: string }) => { win.dispatched.push(e.type); return true },
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  }
}

const targetsOf = (d: string): string[] => {
  const meta = JSON.parse(fs.readFileSync(path.join(d, '.sakuraide.json'), 'utf-8'))
  return Object.keys(meta?.publish?.targets ?? {}).sort()
}

beforeEach(() => {
  resetProjectOpsForTests()
  h.gate = null
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-dedicated-entries-'))
  writeApprunDedicatedRecordFs(dir, { ...FULL_RECORD, activeVersion: 1 })
  // 📡 一覧が読む公開記録。専有型のほかに Vercel もある（消してよいのは専有型だけ）。
  writePublishRecordFs(dir, 'sakura-apprun-dedicated', { publishedAt: '2026-09-28T00:00:00.000Z', url: 'https://app.example.com/' })
  writePublishRecordFs(dir, 'vercel', { publishedAt: '2026-09-27T00:00:00.000Z', url: 'https://myapp.vercel.app/' })
  installWindow()
})
afterEach(() => {
  if (server) { server.close(); server = null }
  fs.rmSync(dir, { recursive: true, force: true })
  delete (globalThis as any).window
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []
})

/** 手順6の入口と同じ作り方（electronFlowDeps）。確認の答えと入口ごとの文だけを渡す。 */
function entryDeps(answer: boolean, keyMissingMessage = '入口ごとの案内文') {
  const asked: unknown[] = []
  const deps = electronFlowDeps(dir, dedicatedTeardownSpec, { confirm: async o => { asked.push(o); return answer }, keyMissingMessage })
  return { deps, asked }
}

describe('(C) 本物の main ＋ 偽 client: 手順6も 📡 の入口も、アプリ → ロードバランサ → ASG → クラスタ の順に要求が出る', () => {
  it('★★★ 確認 yes: DELETE はこの4本がこの順で出る。IPC は { confirmed: true } 付きで1回だけ', async () => {
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const { deps } = entryDeps(true)
    const out = await runFlow(dir, deps)

    expect(out.cancelled).toBe(false)
    expect((out as any).result.ok).toBe(true)
    expect(calls.filter(c => c.startsWith('DELETE '))).toEqual([
      'DELETE /applications/app1',
      'DELETE /clusters/c1/asg/a1/load_balancers/l1',
      'DELETE /clusters/c1/asg/a1',
      'DELETE /clusters/c1',
    ])
    expect(win.ipcTeardown).toEqual([{ dir, auth: AUTH, opts: { confirmed: true } }])
    // 資源の記録は全部空になる（アプリだけで止まっていない）
    const rec = readApprunDedicatedFs(dir)
    expect([rec.applicationID, rec.loadBalancerID, rec.asgID, rec.clusterID].every(v => !v)).toBe(true)
  })

  it('★★★ 確認 no（やめる）: さくらへの要求は1本も出ない。IPC も呼ばれない。記録は何も変わらない', async () => {
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const before = JSON.stringify(readApprunDedicatedFs(dir))
    const { deps, asked } = entryDeps(false)
    const out = await runFlow(dir, deps)

    expect(out).toEqual({ cancelled: true })
    expect(asked).toHaveLength(1)
    expect(calls).toEqual([])
    expect(win.ipcTeardown).toEqual([])
    expect(JSON.stringify(readApprunDedicatedFs(dir))).toBe(before)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
  })

  // 注意（2026-10-08 検分）: この試験は**同じ factory（electronFlowDeps）を2回通して比べる**だけで、入口が食い違っても落ちない。
  // 「手順6の画面と 📡 の行が、どちらもこの factory を通っているか」は tests/apprunDedicatedWiring.test.ts（配線の試験。
  // 手順6は runTeardownFlow(projectDir, dedicatedTeardownSpec, electronFlowDeps(…))・📡 は useTeardownFlow 経由）が受け持つ。
  it('★ 同じ factory（electronFlowDeps）を通せば、確認の文も、出る要求の列も、結果も同じ（入口が同じ factory を通っているかは配線の試験が見る）', async () => {
    const run = async () => {
      const calls: string[] = []
      h.baseUrl = await startServer(allRoutes(), calls)
      const { deps, asked } = entryDeps(true)
      const out = await runFlow(dir, deps)
      server?.close(); server = null
      return { calls, asked, result: (out as any).result }
    }
    const first = await run()
    // 同じ記録でもう一度（別のプロジェクトとして用意し直す）
    resetProjectOpsForTests()
    writeApprunDedicatedRecordFs(dir, { ...FULL_RECORD, activeVersion: 1 })
    const second = await run()
    expect(second.asked).toEqual(first.asked)
    expect(second.calls).toEqual(first.calls)
    expect({ ...second.result, stageTimings: undefined }).toEqual({ ...first.result, stageTimings: undefined })
  })

  it('★ アプリの削除が失敗したら、LB・ASG・クラスタへは進まない（順序の歯止め）。残ったものを結果に載せる', async () => {
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes({ 'DELETE /applications/app1': { status: 500, body: { status: 500, title: 'fail' } } }), calls)
    const { deps } = entryDeps(true)
    const out = await runFlow(dir, deps)
    const result = (out as any).result as DedicatedTeardownReply
    expect(result.ok).toBe(false)
    expect(calls.filter(c => c.startsWith('DELETE '))).toEqual(['DELETE /applications/app1'])
    expect(result.remaining).toMatchObject({ applicationID: 'app1', loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' })
  })

  it('キーが無ければ、さくらへの要求は1本も出ない（入口ごとの案内文が結果になる）', async () => {
    installWindow({ key: null })
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const { deps } = entryDeps(true, '「認証情報」で登録してください')
    const out = await runFlow(dir, deps)
    expect((out as any).result.message).toBe('「認証情報」で登録してください')
    expect(calls).toEqual([])
    expect(win.ipcTeardown).toEqual([])
  })
})

describe('(D) 公開の記録（📡 の行）: 消すのは main の1か所。画面は消さない', () => {
  it('★★★ 全部消えたら、main が専有型の公開記録だけを消す（Vercel は残る）。画面の口（publishMeta）は1回も呼ばれない', async () => {
    h.baseUrl = await startServer(allRoutes(), [])
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
    const { deps } = entryDeps(true)
    const out = await runFlow(dir, deps)
    expect((out as any).result.ok).toBe(true)
    expect(targetsOf(dir)).toEqual(['vercel']) // main が消した
    expect(win.forgetTarget).toEqual([]) // 画面は消していない
  })

  it('★★ アプリの削除に失敗したら、公開記録は残る（まだ公開中のものを一覧から隠さない）。画面は消さない', async () => {
    h.baseUrl = await startServer(allRoutes({ 'DELETE /applications/app1': { status: 500, body: { status: 500, title: 'fail' } } }), [])
    const { deps } = entryDeps(true)
    await runFlow(dir, deps)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
    expect(win.forgetTarget).toEqual([])
  })

  it('★★ 確認で「やめる」なら、公開記録はそのまま', async () => {
    h.baseUrl = await startServer(allRoutes(), [])
    const { deps } = entryDeps(false)
    await runFlow(dir, deps)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
    expect(win.forgetTarget).toEqual([])
  })
})

describe('(D2) 途中で止まった削除の押し直し: 全部消せた回に、📡 の行（公開記録）が消える（幽霊の行を作らない・2026-10-08 検分）', () => {
  it('★★★ 1回目: ロードバランサの削除が失敗して止まる（行は残る）→ 2回目: 全部成功 → 専有型の行が消え、Vercel は残る。画面は消さない', async () => {
    const calls1: string[] = []
    h.baseUrl = await startServer(allRoutes({ 'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 500, body: { status: 500, title: 'fail' } } }), calls1)
    const first = await runFlow(dir, entryDeps(true).deps)
    expect((first as any).result.ok).toBe(false)
    // アプリは消えて、記録の applicationID は外れた。LB・ASG・クラスタは残る。行はまだ残す（押し直す 🗑 を残す）。
    const rec1 = readApprunDedicatedFs(dir)
    expect(rec1.applicationID).toBeFalsy()
    expect(rec1.loadBalancerID).toBe('l1')
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
    server?.close(); server = null

    // 押し直す。アプリは1回目で消えているので、2回目に出る DELETE は LB → ASG → クラスタ の3本。
    const calls2: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls2)
    const second = await runFlow(dir, entryDeps(true).deps)
    expect((second as any).result.ok).toBe(true)
    expect(calls2.filter(c => c.startsWith('DELETE '))).toEqual([
      'DELETE /clusters/c1/asg/a1/load_balancers/l1',
      'DELETE /clusters/c1/asg/a1',
      'DELETE /clusters/c1',
    ])
    // 2回目は applicationID が無い（hadApplicationID なら false になって、行が永久に残った）。それでも行が消える。
    expect(targetsOf(dir)).toEqual(['vercel'])
    expect(win.forgetTarget).toEqual([]) // 画面は消していない
    expect(win.ipcTeardown).toHaveLength(2)
  })
})

describe('(D3) 消すものが記録に無い行（幽霊の行）: 破壊の確認を出さず、IPC もさくらへの要求も出さない（2026-10-08 検分）', () => {
  const emptyResourceRecord = () => writeApprunDedicatedRecordFs(dir, {
    clusterID: null, asgID: null, loadBalancerID: null, applicationID: null, applicationName: null, activeVersion: null,
  })

  it('★★★ 確認ダイアログは出ない（「次を削除します: 」と何も名指ししないまま押させない）。IPC は0回・さくらへの要求は0本。行はそのまま', async () => {
    emptyResourceRecord()
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const { deps, asked } = entryDeps(true)
    const out = await runFlow(dir, deps)

    expect(out.cancelled).toBe(false)
    expect((out as any).result).toEqual({ ok: false, executed: [], message: DEDICATED_NOTHING_TO_DELETE_MESSAGE, remaining: {} })
    expect(asked).toEqual([])
    expect(win.ipcTeardown).toEqual([])
    expect(calls).toEqual([])
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel']) // 行を消すのは「一覧から削除」（案内する）
    expect(DEDICATED_NOTHING_TO_DELETE_MESSAGE).toContain('一覧から削除')
    expect(DEDICATED_NOTHING_TO_DELETE_MESSAGE).toContain('さくらのクラウドには何も要求していません')
  })

  // 2026-10-08 検分 F: 「一覧から削除」は Koto の記録の行を消すだけで、さくら側の実物には触れない。記録が失われただけで実物が残っていることもある。
  // 押す前に、さくら側に残っていないかを確かめてもらう。案内が指す名前は、画面に実在するものだけ（掟9。README・使い方ガイドの引用も同じ）。
  it('★★ 案内は、「一覧から削除」の前に、さくら側に残っていないかを確かめるよう言う。指す画面の名前は実在し、README・使い方ガイドの引用と一致する', () => {
    const SENTENCE = 'さくら側に残っていないかは、📡 の「さくら側にあるものと、かかっている費用」で「調べる」を押すか、コントロールパネルで確かめてから、「一覧から削除」してください。'
    expect(DEDICATED_NOTHING_TO_DELETE_MESSAGE).toContain(SENTENCE)
    // 順序: 「一覧から削除」で消せる、のあとに、確かめてから、が来る
    expect(DEDICATED_NOTHING_TO_DELETE_MESSAGE.indexOf('その行の「一覧から削除」で消せます')).toBeLessThan(DEDICATED_NOTHING_TO_DELETE_MESSAGE.indexOf(SENTENCE))
    // 指している画面の名前が、実際の画面（📡 の一覧）に実在する
    // 棚卸しのカードは 0.6.22 の3B-5 で PublishedInventoryCard.tsx へ移った。「一覧から削除」のボタンは一覧（PublishedListModal.tsx）に残る
    const card = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/PublishedInventoryCard.tsx'), 'utf-8')
    const modal = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/PublishedListModal.tsx'), 'utf-8')
    expect(card).toContain('さくら側にあるものと、かかっている費用</h3>')
    expect(card).toContain("{checking ? '調べています…' : '↻ 調べる'}")
    expect(modal).toContain('>一覧から削除</button>')
    // README・使い方ガイドの引用（掟9）
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf-8')
    const guide = fs.readFileSync(path.join(__dirname, '..', 'docs/usage-guide.html'), 'utf-8')
    expect(readme).toContain('さくら側に残っていないかを、📡 の「さくら側にあるものと、かかっている費用」で「調べる」を押すか、コントロールパネルで確かめてください')
    expect(guide).toContain('さくら側に残っていないかを、一覧の「💰 さくら側にあるものと、かかっている費用」で<b>「調べる」</b>を押すか、コントロールパネルで確かめてください')
  })

  it('★ 前回の保存場所の残りの印（storageLeftoverBucket）だけがある行は、消すものがある＝確認を出す（押し直せる）', async () => {
    emptyResourceRecord()
    writeApprunDedicatedRecordFs(dir, { storageLeftoverBucket: 'koto-data-x' })
    const { deps, asked } = entryDeps(false)
    const out = await runFlow(dir, deps)
    expect(out).toEqual({ cancelled: true })
    expect(asked).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// (E) 📡 の行のフック（useTeardownFlow＋専有型の仕様書）を実際に動かす
// ═══════════════════════════════════════════════════════════════════════════════

function flushEffects() {
  const todo = rt.queue; rt.queue = []
  for (const q of todo) {
    const prev = rt.effects[q.idx]
    if (prev && typeof prev.cleanup === 'function') prev.cleanup()
    // 効果の中で setState して描き直しが走っても、この効果を「もう付いている」と見られるよう、先に印を置く
    const slot: { deps?: readonly unknown[]; cleanup?: void | (() => void) } = { deps: q.deps }
    rt.effects[q.idx] = slot
    slot.cleanup = q.fn()
  }
}
function mountHook(over: { onOutcome?: (o: TeardownFlowOutcome) => void; onFinished?: () => void } = {}) {
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.r = 0; rt.e = 0
  const outcomes: TeardownFlowOutcome[] = []
  const finished: number[] = []
  let latest!: ReturnType<typeof useTeardownFlow>
  const history: Array<{ tearingDown: boolean; progress: string | null; running: boolean }> = []
  const render = () => {
    rt.i = 0; rt.r = 0; rt.e = 0; rt.queue = []
    latest = useTeardownFlow(dir, dedicatedTeardownSpec, {
      keyMissingMessage: 'API キーが未登録です（📡）',
      onOutcome: o => { outcomes.push(o); over.onOutcome?.(o) },
      onFinished: () => { finished.push(outcomes.length); over.onFinished?.() },
    })
    history.push({ tearingDown: latest.tearingDown, progress: latest.progress, running: latest.running })
    flushEffects()
  }
  rt.rerender = render
  render()
  return {
    get latest() { return latest },
    outcomes, finished, history,
    unmount() { for (const e of rt.effects) if (e && typeof e.cleanup === 'function') e.cleanup(); rt.effects = [] },
  }
}
async function answer(m: ReturnType<typeof mountHook>, yes: boolean) {
  for (let k = 0; k < 400 && !(m.latest.confirmElement as any).props.open; k++) await tick()
  expect((m.latest.confirmElement as any).props.open, '確認ダイアログ（ConfirmModal）が開かない').toBe(true)
  const props = (m.latest.confirmElement as any).props
  expect(props.danger).toBe(true)
  if (yes) props.onConfirm(); else props.onCancel()
}

describe('(E) 📡 の行: 🗑 を押す → 確認（手順6と同じ文）→ 削除 → 結果', () => {
  it('★★★ やめる: IPC は0回、さくらへの要求は0本、結果も出ず、窓を閉じる警告も立たない', async () => {
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const m = mountHook()
    const started = m.latest.start()
    await answer(m, false)
    await started

    expect(win.ipcTeardown).toEqual([])
    expect(calls).toEqual([])
    expect(m.outcomes).toEqual([])
    expect(m.finished).toEqual([])
    expect(win.busy).toEqual([]) // setBusy（窓を閉じる警告）は1回も立たない
    expect(m.latest.tearingDown).toBe(false)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
    m.unmount()
  })

  it('★★★ 削除する: IPC は { confirmed: true } 付きで1回だけ。4本が順に出て、結果が出て、公開の記録は main が消す（画面は消さない）', async () => {
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const m = mountHook()
    const started = m.latest.start()
    await answer(m, true)
    await started

    expect(win.ipcTeardown).toEqual([{ dir, auth: AUTH, opts: { confirmed: true } }])
    expect(calls.filter(c => c.startsWith('DELETE '))).toEqual([
      'DELETE /applications/app1',
      'DELETE /clusters/c1/asg/a1/load_balancers/l1',
      'DELETE /clusters/c1/asg/a1',
      'DELETE /clusters/c1',
    ])
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.ok).toBe(true)
    expect(m.outcomes[0].view.state).toBe('done')
    expect(m.outcomes[0].notes).toEqual([])
    expect(targetsOf(dir)).toEqual(['vercel'])
    expect(win.forgetTarget).toEqual([]) // 画面（フック）は公開の記録を消さない
    expect(win.dispatched).toContain('sakura-meta-changed') // 開いている画面へ知らせる
    // 結果を出したあとで一覧を読み直す（行が消える前に結果を渡している）
    expect(m.finished).toEqual([1])
    // 出し終えたので記録を「見た」にした（行が消えたあとに同じ結果が二度出ない）
    expect(win.acks.length).toBeGreaterThanOrEqual(1)
    expect((await getOps(dir)).last?.seen ?? true).toBe(true)
    expect(m.latest.tearingDown).toBe(false)
    m.unmount()
  })

  it('★★ 確認の文は手順6と同じ関数（buildTeardownConfirm）の出力。ロードバランサの時間（約9分）と、D10 の DNS の1行（V2）が入っている', async () => {
    h.baseUrl = await startServer(allRoutes(), [])
    const m = mountHook()
    const started = m.latest.start()
    for (let k = 0; k < 400 && !(m.latest.confirmElement as any).props.open; k++) await tick()
    const props = (m.latest.confirmElement as any).props
    // 手順6の入口と同じ材料の読み方（loadTeardownFacts＋本物の口）で作った確認と、1文字も違わない
    const facts = await loadTeardownFacts(dir, dedicatedTeardownSpec, electronTeardownFactsApi())
    const expected = confirmOf(facts)
    expect(props.title).toBe(expected.title)
    expect(props.body).toBe(expected.body)
    expect(props.confirmLabel).toBe('削除する')
    expect(props.body).toContain('目安 約9分（開発時の実測・2026-09-10）')
    // V2: ロードバランサが記録にある削除なので、DNS の A レコードの1行（記録に hosts が無いので名前なしの文）
    expect(props.body).toContain('🌐 独自ドメインの DNS に、このロードバランサを指す A レコードがあれば、DNS の管理画面で削除してください。')
    // 材料に、同じ保存場所を使うほかの公開先（Vercel）の記録が入っている
    expect(facts.otherTargets.length).toBeGreaterThan(0)
    props.onCancel()
    await started
    m.unmount()
  })

  it('★★★ 窓を閉じるときの警告: 削除が走っている間だけ立つ（label・detail・確認ボタンは PUBLISH_CLOSE_WARNING）。終われば外れる', async () => {
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r }) // ロードバランサの削除で止める
    h.baseUrl = await startServer(allRoutes(), [])
    const m = mountHook()
    const started = m.latest.start()
    await answer(m, true)
    for (let k = 0; k < 400 && win.busy.length === 0; k++) await tick()

    // 走っている最中: setBusy(true, label, closeBlocking=true, label, detail, confirm)
    expect(win.busy[0]).toEqual([true, DEDICATED_TEARDOWN_WORDS.activityLabel, true, DEDICATED_TEARDOWN_WORDS.activityLabel, PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel])
    expect(m.latest.tearingDown).toBe(true)

    open()
    await started
    const last = win.busy[win.busy.length - 1]
    expect(last[0]).toBe(false) // 実行中が解けた
    expect(last[2]).toBe(false) // 閉じる警告も解けた
    m.unmount()
  })

  it('★★★ 進み具合: 削除中は teardown-progress の購読が張られ、届いた文が出る。記録（projectOps）が「走っている」と言えば記録の文・段の名前が出る', async () => {
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r })
    // ロードバランサが7回の一覧のあいだ「削除中」で残る（30秒ごとの経過の文が1回出る）
    h.baseUrl = await startServer(allRoutes({ 'GET /clusters/c1/asg/a1/load_balancers?maxItems=20': [LB_DELETING, LB_DELETING, LB_DELETING, LB_DELETING, LB_DELETING, LB_DELETING, LB_DELETING, LB_GONE] }), [])
    const m = mountHook()
    expect(win.progressListeners.size).toBe(1) // 付けた（購読を外すと 0 のまま）
    const started = m.latest.start()
    await answer(m, true)
    for (let k = 0; k < 400 && !m.latest.tearingDown; k++) await tick()
    expect(m.latest.running || m.latest.tearingDown).toBe(true)
    open()
    await started

    // main が送った進み具合の文（待ちの経過）が、この行の画面状態に届いた
    expect(win.progressSent.some(s => s.includes('ロードバランサの削除を待っています'))).toBe(true)
    const shown = m.history.map(x => x.progress).filter((x): x is string => !!x)
    expect(shown.some(s => s.includes('ロードバランサの削除を待っています'))).toBe(true)
    // 記録（projectOps）の監視: 走っている間に「削除が走っている」と読めた
    expect(m.history.some(x => x.running)).toBe(true)
    m.unmount()
    expect(win.progressListeners.size).toBe(0) // 外したら購読も外れる
  })

  it('★★ 閉じて開き直したとき（走っている最中）: 新しく付けた行が、記録から「削除中」と進み具合を読み戻す', async () => {
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r })
    h.baseUrl = await startServer(allRoutes(), [])
    const first = mountHook()
    const started = first.latest.start()
    await answer(first, true)
    for (let k = 0; k < 400 && win.busy.length === 0; k++) await tick()
    // 一覧を閉じる（外す）。削除は main が最後まで進める。
    first.unmount()
    const reopened = mountHook()
    await tick()
    expect(reopened.latest.running).toBe(true)
    expect(reopened.latest.tearingDown).toBe(true) // この行を押していなくても「削除しています…」になる（🗑 は止まる）
    expect(reopened.latest.runningRecord?.startedAt).toBeGreaterThan(0)
    open()
    await started
    await tick()
    reopened.unmount()
  })

  it('★★★ 閉じている間に終わった削除: 開き直すと、記録から結果が読み戻されて onOutcome に届く（警告つきの結果は残る）', async () => {
    h.baseUrl = await startServer(allRoutes(), [])
    // 一覧を開かずに（画面が無い状態で）削除が走って終わる。main は最後まで進める。
    const rpc = h.handlers.get('apprunDedicated:teardown')!
    const direct = await rpc(EVENT, dir, AUTH, { confirmed: true })
    expect(direct.ok).toBe(true)

    const m = mountHook()
    await tick()
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.ok).toBe(true)
    expect(m.outcomes[0].notes).toHaveLength(1)
    // V8: 開き直したときの知らせの見出しは「🔔 削除の結果（HH:MM に終わりました）」（入口に関係なく「手順6」とは言わない）
    expect(m.outcomes[0].notes[0].headline).toMatch(/^🔔 削除の結果（.+ に終わりました）$/)
    expect(m.finished).toEqual([1]) // 一覧を読み直す
    // 見た印を返した（警告の無い結果は、二度出ない）
    const m2 = mountHook()
    await tick()
    expect(m2.outcomes).toEqual([])
    m.unmount(); m2.unmount()
  })

  it('キーが無いとき: IPC もさくらへの要求も出ず、📡 の案内文が結果になる', async () => {
    installWindow({ key: null })
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const m = mountHook()
    const started = m.latest.start()
    await answer(m, true)
    await started
    expect(win.ipcTeardown).toEqual([])
    expect(calls).toEqual([])
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.message).toBe('API キーが未登録です（📡）')
    expect(m.outcomes[0].view.ok).toBe(false)
    m.unmount()
  })

  it('二重に押しても、IPC は1回だけ（実行中の行は 🗑 を受け付けない）', async () => {
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r })
    h.baseUrl = await startServer(allRoutes(), [])
    const m = mountHook()
    const first = m.latest.start()
    const second = m.latest.start() // 確認を待っている最中にもう一度
    await answer(m, true)
    for (let k = 0; k < 400 && win.busy.length === 0; k++) await tick()
    open()
    await Promise.all([first, second])
    expect(win.ipcTeardown).toHaveLength(1)
    m.unmount()
  })
})

describe('(E2) 📡 の行のフック: 幽霊の行・別の操作が走っているとき', () => {
  it('★★★ 幽霊の行（資源の記録が空）で 🗑: 確認ダイアログは開かず、IPC は0回。結果は「記録にありません」の案内', async () => {
    writeApprunDedicatedRecordFs(dir, { clusterID: null, asgID: null, loadBalancerID: null, applicationID: null, applicationName: null, activeVersion: null })
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const m = mountHook()
    await m.latest.start()
    expect((m.latest.confirmElement as any).props.open).toBe(false)
    expect(win.ipcTeardown).toEqual([])
    expect(calls).toEqual([])
    expect(m.outcomes).toHaveLength(1)
    expect(m.outcomes[0].view.ok).toBe(false)
    expect(m.outcomes[0].view.message).toBe(DEDICATED_NOTHING_TO_DELETE_MESSAGE)
    expect(win.busy).toEqual([]) // 窓を閉じる警告も立たない
    m.unmount()
  })

  it('★★ 同じプロジェクトで別の操作（手順8の公開など）が走っているあいだは otherRunning。start() は確認も IPC も出さない', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const holder = withProjectLock(dir, '公開', () => gate, { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:publishApp', secrets: [] })
    const m = mountHook()
    for (let k = 0; k < 50 && !m.latest.otherRunning; k++) await tick()
    expect(m.latest.otherRunning).toBe(true)
    expect(m.latest.tearingDown).toBe(false) // 別の操作は「この行の削除中」ではない
    await m.latest.start()
    expect((m.latest.confirmElement as any).props.open).toBe(false)
    expect(win.ipcTeardown).toEqual([])
    release(); await holder
    m.unmount()
  })
})

const ENTRY_FOR = (d: string) => ({
  dir: d, projectName: 'proj', target: 'sakura-apprun-dedicated' as const, label: '📦 さくらのAppRun（専有型）',
  url: 'https://app.example.com/', publishedAt: '2026-09-28T00:00:00.000Z', dateUnknown: false,
  hanamiiProjectId: null, registryName: null,
})

/** 📡 の行（TeardownRow＋専有型の仕様書）を、react の小さな代役の上で実際に動かす。行が一覧へ渡す部品（button・below・busy）と、行の末尾に描く確認ダイアログを読む。 */
function mountRow(over: { blocked?: boolean } = {}) {
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.r = 0; rt.e = 0
  const busy: boolean[] = []
  const outcomes: TeardownFlowOutcome[] = []
  let element: any
  let parts: any
  const render = () => {
    rt.i = 0; rt.r = 0; rt.e = 0; rt.queue = []
    element = TeardownRow({
      spec: dedicatedTeardownSpec, keyMissingMessage: DEDICATED_LIST_KEY_MISSING_MESSAGE,
      entry: ENTRY_FOR(dir), blocked: over.blocked ?? false,
      onBusyChange: b => { busy.push(b) },
      onOutcome: (_e, o) => { outcomes.push(o) },
      onFinished: () => {},
      render: p => { parts = p; return 'ROW' as any },
    })
    flushEffects()
  }
  rt.rerender = render
  render()
  return {
    get element() { return element },
    get parts() { return parts },
    /** 行の末尾に描かれた確認ダイアログ（ConfirmModal）の要素。 */
    get confirm() { return element?.props?.children?.[1] },
    busy, outcomes,
    unmount() { for (const e of rt.effects) if (e && typeof e.cleanup === 'function') e.cleanup(); rt.effects = [] },
  }
}

describe('(E3) 📡 の行（TeardownRow＋専有型の仕様書）の配線: 確認ダイアログ・押せる条件・実行中の印', () => {
  // V1・V16: 専有型の行のボタンは「🗑 削除」（実行中は「削除しています…」）。title は共通の行の文で、手本の末尾の括弧（アプリ・ロードバランサ・…）はなくなる。
  it('★★ V1・V16: ボタンの文字は「🗑 削除」（実行中は「削除しています…」）。title は共通の文で、消えるものの括弧を言い直さない', async () => {
    h.baseUrl = await startServer(allRoutes(), [])
    const m = mountRow()
    expect(m.parts.button.props.children).toBe('🗑 削除')
    expect(m.parts.button.props.title).toBe('公開を止めて、作られたものをすべて削除します')
    expect(m.parts.button.props.title).not.toContain('（')
    expect(m.parts.below, '削除が走っていないのに進み具合の枠が出ている').toBeNull()
    m.unmount()
    // 実行中は文字が替わる（ロードバランサの削除で止める）
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r })
    const running = mountRow()
    running.parts.button.props.onClick()
    for (let k = 0; k < 400 && !running.confirm?.props?.open; k++) await tick()
    running.confirm.props.onConfirm()
    for (let k = 0; k < 400 && !running.parts.busy; k++) await tick()
    expect(running.parts.button.props.children).toBe('削除しています…')
    open()
    for (let k = 0; k < 400 && running.parts.busy; k++) await tick()
    running.unmount()
  })

  it('★★★ 🗑 を押すと、確認ダイアログ（ConfirmModal）が**この行の中に**描かれる（描かないと 🗑 を押しても何も起きない）', async () => {
    h.baseUrl = await startServer(allRoutes(), [])
    const m = mountRow()
    expect(m.confirm.props.open).toBe(false)
    m.parts.button.props.onClick()
    for (let k = 0; k < 400 && !m.confirm?.props?.open; k++) await tick()
    expect(m.confirm?.props?.open, '確認ダイアログが行に描かれていない').toBe(true)
    expect(m.confirm.props.title).toBe('専有型クラスタを削除します')
    expect(m.confirm.props.body).toContain('対象のプロジェクト:')
    m.confirm.props.onCancel()
    await tick()
    expect(win.ipcTeardown).toEqual([])
    m.unmount()
  })

  it('★★ 🗑 が押せない条件: ほかの行の削除が走っている（blocked）・この行の削除が走っている・別の操作が走っている。それ以外は押せる', async () => {
    h.baseUrl = await startServer(allRoutes(), [])
    // 押せる
    const free = mountRow()
    expect(free.parts.button.props.disabled).toBe(false)
    free.unmount()
    // ほかの行が走っている
    const blocked = mountRow({ blocked: true })
    expect(blocked.parts.button.props.disabled).toBe(true)
    blocked.unmount()
    // この行の削除が走っている（ロードバランサの削除で止める）
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r })
    const m = mountRow()
    m.parts.button.props.onClick()
    for (let k = 0; k < 400 && !m.confirm?.props?.open; k++) await tick()
    m.confirm.props.onConfirm()
    for (let k = 0; k < 400 && !m.parts.busy; k++) await tick()
    expect(m.parts.busy, '削除が走っているのに busy が false').toBe(true)
    expect(m.parts.button.props.disabled, '削除が走っているのに 🗑 が押せる').toBe(true)
    expect(m.parts.below, '削除中の進み具合の枠が出ていない').not.toBeNull()
    expect(m.busy).toContain(true) // 一覧へ「実行中」を伝えた
    open()
    for (let k = 0; k < 400 && m.parts.busy; k++) await tick()
    expect(m.parts.busy).toBe(false)
    expect(m.busy[m.busy.length - 1]).toBe(false) // 終わったら下ろす
    m.unmount()
  })

  it('★★ 別の操作（手順8の公開など）が走っているあいだは、🗑 が押せない', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const holder = withProjectLock(dir, '公開', () => gate, { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:publishApp', secrets: [] })
    const m = mountRow()
    for (let k = 0; k < 50 && !m.parts.button.props.disabled; k++) await tick()
    expect(m.parts.button.props.disabled).toBe(true)
    release(); await holder
    m.unmount()
  })

  it('★★★ 行が一覧から消えた（アンマウント）とき、実行中の印を必ず下ろす（下ろさないと、一覧を閉じるまでほかのすべての 🗑 が押せない）', async () => {
    let open!: () => void
    h.gate = new Promise<void>(r => { open = r })
    h.baseUrl = await startServer(allRoutes(), [])
    const m = mountRow()
    m.parts.button.props.onClick()
    for (let k = 0; k < 400 && !m.confirm?.props?.open; k++) await tick()
    m.confirm.props.onConfirm()
    for (let k = 0; k < 400 && !m.busy.includes(true); k++) await tick()
    expect(m.busy[m.busy.length - 1]).toBe(true)
    m.unmount() // 行が消えた（別の再読み込み・「一覧から削除」）
    expect(m.busy[m.busy.length - 1], 'アンマウントで実行中の印が下りていない').toBe(false)
    open()
    // 外した行の削除は、裏で最後まで進み、開いている画面へ知らせて終わる。その終わりを待ってからテストを閉じる
    // （待たないと、afterEach が window を消したあとに通知が投げられ、未処理の例外になって、まれに全体が失敗扱いになる）。
    for (let k = 0; k < 400 && !win.dispatched.includes('sakura-meta-changed'); k++) await tick()
    expect(win.dispatched).toContain('sakura-meta-changed')
  })
})
