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
// ここは**ソースの文字列を読まない**（掟10「お金・破壊の歯止めは、振る舞いで固定する」。配線の形は tests/apprunDedicatedWiring.test.ts）。
//   (A) 流れの歯止め: 偽の口に流し、「やめる」なら IPC は0回・「削除する」なら confirmed:true で1回だけ、を数える
//   (B) 確認の文: 2つの入口で同じ入力なら同じ文。消えるもの・課金・ロードバランサの時間（目安の仕組みの出力）が入る
//   (C) 本物の main のハンドラ＋偽の HTTP サーバ（偽 client）: 📡 の入口から アプリ → LB → ASG → クラスタ の順に要求が出る
//   (D) 公開の記録: main が消す。画面（renderer）は消さない（偽の記録で、消えたこと・画面の口が呼ばれなかったことを見る）
//   (E) 📡 の行のフック（useDedicatedTeardown）を、React の小さな代役の上で実際に動かす:
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
import { useDedicatedTeardown, type DedicatedTeardownOutcome } from '../src/renderer/hooks/useDedicatedTeardown'
import {
  runDedicatedTeardown, buildDedicatedTeardownConfirm, loadDedicatedTeardownFacts, electronTeardownDeps, electronFactsApi,
  dedicatedTeardownTargets, lbWaitNote, teardownProgressText, unreadableCautions, DEDICATED_TEARDOWN_ACTIVITY_LABEL, NOTHING_TO_DELETE_MESSAGE,
  type DedicatedTeardownFacts, type DedicatedTeardownFactsApi, type RunDedicatedTeardownDeps, type DedicatedTeardownResult,
} from '../src/renderer/dedicatedTeardownFlow'
import DedicatedTeardownRow from '../src/renderer/components/DedicatedTeardownRow'
import { dedicatedTeardownHasWork } from '../src/shared/teardownSupport'
import { withProjectLock } from '../src/main/projectLock'
import { watchDedicatedOps, shouldShowTeardownButton, shouldShowTeardownList, teardownConfirmMessage, type DedicatedOpsApi } from '../src/renderer/apprunDedicatedActions'
import { PUBLISH_CLOSE_WARNING } from '../src/renderer/activity'
import { estimatesFor, emptyStore } from '../src/shared/stageEstimate'
import { PUBLISH_TARGET_LABEL } from '../src/renderer/publishStatus'

registerApprunDedicatedHandlers({} as any)

const AUTH = { token: 'tok', secret: 'sec' }
const tick = async () => { for (let k = 0; k < 6; k++) await new Promise<void>(r => setTimeout(r, 0)) }
const FULL_RECORD = { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1', applicationName: 'myapp' } as const
const OK_RESULT: DedicatedTeardownResult = { ok: true, executed: ['x'], message: '', remaining: {} }

// ═══════════════════════════════════════════════════════════════════════════════
// (A) 流れの歯止め（偽の口）
// ═══════════════════════════════════════════════════════════════════════════════

const FACTS: DedicatedTeardownFacts = {
  projectName: 'myapp',
  record: FULL_RECORD,
  placements: [],
  placementsUnreadable: false,
  otherTargets: [],
  otherTargetsUnreadable: false,
  lbEstimateLine: '目安 約9分（開発時の実測・2026-09-10）',
}

function fakeDeps(over: Partial<RunDedicatedTeardownDeps> & { answer?: boolean } = {}) {
  const calls = {
    teardown: [] as Array<{ dir: string; auth: unknown; opts: unknown }>,
    confirm: [] as unknown[],
    begin: [] as Array<{ label: string; opts: unknown }>,
    ended: 0, started: 0, keyLoads: 0, facts: 0,
  }
  const deps: RunDedicatedTeardownDeps = {
    loadFacts: async () => { calls.facts++; return FACTS },
    confirm: async o => { calls.confirm.push(o); return over.answer ?? true },
    loadKey: async () => { calls.keyLoads++; return AUTH },
    teardown: async (dir, auth, opts) => { calls.teardown.push({ dir, auth, opts }); return OK_RESULT },
    beginActivity: (label, opts) => { calls.begin.push({ label, opts }); return () => { calls.ended++ } },
    onStart: () => { calls.started++ },
    keyMissingMessage: 'キーが未登録です（テスト）',
    ...over,
  }
  delete (deps as any).answer
  return { deps, calls }
}

describe('(A) runDedicatedTeardown: 確認が no なら IPC は0回・yes なら confirmed:true で1回だけ', () => {
  it('★★ yes: IPC（apprunDedicated:teardown）が { confirmed: true } 付きで1回だけ。窓を閉じるときの警告つきで活動レジストリに載り、終われば必ず外れる', async () => {
    const { deps, calls } = fakeDeps()
    const out = await runDedicatedTeardown('/p', deps)
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
      loadKey: async () => { order.push('loadKey'); return AUTH },
      teardown: async () => { order.push('teardown'); return OK_RESULT },
    })
    await runDedicatedTeardown('/p', deps)
    expect(order).toEqual(['onStart', 'loadKey', 'teardown'])
  })

  it('★★ no（やめる）: IPC は0回。キーも読まず、活動レジストリにも載せず、画面を「削除しています…」にもしない', async () => {
    const { deps, calls } = fakeDeps({ answer: false })
    const out = await runDedicatedTeardown('/p', deps)
    expect(out).toEqual({ cancelled: true })
    expect(calls.teardown).toEqual([])
    expect(calls.keyLoads).toBe(0)
    expect(calls.begin).toEqual([])
    expect(calls.started).toBe(0)
    expect(calls.confirm).toHaveLength(1) // 確認は出した
  })

  it('★ 確認の材料が読めなければ、確認も IPC も出さずに失敗の結果を返す（消すものが分からないまま消させない）', async () => {
    const { deps, calls } = fakeDeps({ loadFacts: async () => { throw new Error('読めない') } })
    const out = await runDedicatedTeardown('/p', deps)
    expect(out.cancelled).toBe(false)
    expect((out as any).result.ok).toBe(false)
    expect((out as any).result.message).toContain('読めない')
    expect(calls.confirm).toEqual([])
    expect(calls.teardown).toEqual([])
    expect(calls.begin).toEqual([])
  })

  it('★ キーが無ければ IPC は0回。入口ごとの案内文を返す。活動レジストリは外れる', async () => {
    const { deps, calls } = fakeDeps({ loadKey: async () => null })
    const out = await runDedicatedTeardown('/p', deps)
    expect((out as any).result).toEqual({ ok: false, executed: [], message: 'キーが未登録です（テスト）', remaining: {} })
    expect(calls.teardown).toEqual([])
    expect(calls.ended).toBe(calls.begin.length)
    expect(calls.begin).toHaveLength(1)
  })

  it('★ IPC が例外でも、活動レジストリは必ず外れる（実行中の印が残らない）', async () => {
    const { deps, calls } = fakeDeps({ teardown: async () => { throw new Error('通信失敗') } })
    await expect(runDedicatedTeardown('/p', deps)).rejects.toThrow('通信失敗')
    expect(calls.begin).toHaveLength(1)
    expect(calls.ended).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// (B) 確認の文: 2つの入口で同じ入力なら同じ文
// ═══════════════════════════════════════════════════════════════════════════════

describe('(B) buildDedicatedTeardownConfirm: 消えるもの・課金・ロードバランサの時間', () => {
  it('★★ 手順6の入口で作った確認と、📡 の入口で作った確認は、同じ入力なら1文字も違わない（入口は同じ関数を呼ぶだけ）', async () => {
    const step6 = fakeDeps()
    const list = fakeDeps({ keyMissingMessage: '別の案内文（入口ごとに違ってよいのはここだけ）' })
    await runDedicatedTeardown('/p', step6.deps)
    await runDedicatedTeardown('/p', list.deps)
    expect(step6.calls.confirm).toHaveLength(1)
    expect(list.calls.confirm).toEqual(step6.calls.confirm)
    expect(step6.calls.confirm[0]).toEqual(buildDedicatedTeardownConfirm(FACTS))
  })

  it('消えるもの（アプリ → LB → ASG → クラスタ）の名前・課金が止まること・ロードバランサの時間（目安の仕組みの出力）が入る', () => {
    const c = buildDedicatedTeardownConfirm(FACTS)
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
    // 「アプリだけ」の文・「残ります」の文は戻らない
    for (const gone of ['アプリだけ', 'クラスタ・ロードバランサは残ります', '手順6から', '消さない限り課金が続きます']) expect(c.body).not.toContain(gone)
    expect(c.body, '丸数字').not.toMatch(/[①-⑳]/)
  })

  it('★ ロードバランサの目安は、目安の仕組み（shared/stageEstimate.ts の estimatesFor）の出力そのもの。数字はここで持たない', async () => {
    const api: DedicatedTeardownFactsApi = {
      state: async () => FULL_RECORD,
      placements: async () => [],
      otherTargets: async () => [],
      estimates: async () => estimatesFor(emptyStore()), // この Mac に記録が無い状態＝開発時の実測
    }
    const facts = await loadDedicatedTeardownFacts('/p', api)
    expect(facts.lbEstimateLine).toBe('目安 約9分（開発時の実測・2026-09-10）')
    expect(buildDedicatedTeardownConfirm(facts).body).toContain('目安 約9分（開発時の実測・2026-09-10）')
    // この Mac で測れていれば、その中央値に変わる（文は同じ仕組み）
    const measured = { ...emptyStore(), stages: { 'teardown.lb': [{ ms: 6 * 60_000, at: '2026-10-01T00:00:00.000Z', version: '0', zone: null }] } }
    const facts2 = await loadDedicatedTeardownFacts('/p', { ...api, estimates: async () => estimatesFor(measured) })
    expect(facts2.lbEstimateLine).toBe('目安 約6分（この Mac での前回の実測）')
  })

  it('ロードバランサが記録に無い・目安が読めないときは、時間の予告を作らない（無い段に目安を作らない）', async () => {
    expect(lbWaitNote({ clusterID: 'c1' }, '目安 約9分（開発時の実測・2026-09-10）')).toBeNull()
    expect(lbWaitNote(FULL_RECORD, null)).toBeNull()
    const api: DedicatedTeardownFactsApi = {
      state: async () => FULL_RECORD, placements: async () => [], otherTargets: async () => [],
      estimates: async () => { throw new Error('読めない') },
    }
    const facts = await loadDedicatedTeardownFacts('/p', api)
    expect(facts.lbEstimateLine).toBeNull()
    expect(buildDedicatedTeardownConfirm(facts).body).not.toContain('⏳')
  })

  it('★★ 保存場所は全件を名指しし、保存場所を共有しているほかの公開先も言う。材料は押した時点で読み直す', async () => {
    const api: DedicatedTeardownFactsApi = {
      state: async () => FULL_RECORD,
      placements: async () => [{ bucket: 'koto-data-x', prefix: 'projects/a/', shared: true }, { bucket: 'koto-data-y', prefix: 'projects/a/', shared: true }],
      otherTargets: async () => ['🌸 HANAMII'],
      estimates: async () => ({}),
    }
    const body = buildDedicatedTeardownConfirm(await loadDedicatedTeardownFacts('/p', api)).body
    expect(body).toContain("保存場所『koto-data-x』『koto-data-y』にある、このプロジェクトのデータ")
    expect(body).toContain('も削除します')
    expect(body).toContain('🌸 HANAMII')
  })

  it('資源の記録が読めなければ投げる（消すものが分からないまま確認を出さない）。保存場所・ほかの公開先が読めないだけなら空に倒す', async () => {
    await expect(loadDedicatedTeardownFacts('/p', {
      state: async () => { throw new Error('記録なし') }, placements: async () => [], otherTargets: async () => [], estimates: async () => ({}),
    })).rejects.toThrow('記録なし')
    const facts = await loadDedicatedTeardownFacts('/p', {
      state: async () => FULL_RECORD,
      placements: async () => { throw new Error('x') }, otherTargets: async () => { throw new Error('y') }, estimates: async () => { throw new Error('z') },
    })
    expect(facts.placements).toEqual([])
    expect(facts.otherTargets).toEqual([])
    expect(facts.lbEstimateLine).toBeNull()
    // 空に倒すが、**読めなかった事実は残す**（確認の文で言う。黙って「消えるものは無い」ことにしない・2026-10-08 検分）
    expect(facts.placementsUnreadable).toBe(true)
    expect(facts.otherTargetsUnreadable).toBe(true)
    // 読めた回は立たない（空の配列が返ったのは「読めて、無かった」）
    const ok = await loadDedicatedTeardownFacts('/p', { state: async () => FULL_RECORD, placements: async () => [], otherTargets: async () => [], estimates: async () => ({}) })
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
    expect(teardownProgressText({ runningKind: 'teardown', runningRecord: rec, local: '手元の文' })).toBe('記録の文 （2分経過）')
    expect(teardownProgressText({ runningKind: null, runningRecord: null, local: '手元の文' })).toBe('手元の文')
    expect(teardownProgressText({ runningKind: 'publish', runningRecord: rec, local: null })).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// (B2) 確認の中身: プロジェクト名・読めなかった材料の注意・消すものが記録に無いとき（2026-10-08 検分）
// ═══════════════════════════════════════════════════════════════════════════════

describe('(B2) 確認の中身: 対象のプロジェクト名・読めなかった材料の注意', () => {
  const apiOf = (over: Partial<DedicatedTeardownFactsApi> = {}): DedicatedTeardownFactsApi => ({
    state: async () => FULL_RECORD, placements: async () => [], otherTargets: async () => [], estimates: async () => ({}), ...over,
  })

  it('★ 先頭に対象のプロジェクト名が入る（全プロジェクトが並ぶ 📡 の一覧で、どのプロジェクトのものを消すか確かめられる）', async () => {
    const facts = await loadDedicatedTeardownFacts('/Users/x/projects/myapp-copy', apiOf())
    expect(facts.projectName).toBe('myapp-copy')
    const body = buildDedicatedTeardownConfirm(facts).body
    expect(body.startsWith('対象のプロジェクト: 『myapp-copy』\n\n')).toBe(true)
    // 入口ではなく、渡されたプロジェクトで決まる
    expect(buildDedicatedTeardownConfirm({ ...facts, projectName: 'other' }).body).toContain('『other』')
    expect(buildDedicatedTeardownConfirm({ ...facts, projectName: 'other' }).body).not.toContain('myapp-copy')
  })

  it('★★ 保存場所の設定を読めなかったら、確認の文がそれを言う。言うのは事実どおり「保存場所の削除は行われず、残る」こと。読めた回は言わない', () => {
    const base = buildDedicatedTeardownConfirm(FACTS).body
    expect(base).not.toContain('読めない')
    expect(base).not.toContain('読めなかった')
    expect(unreadableCautions(FACTS)).toEqual([])
    const body = buildDedicatedTeardownConfirm({ ...FACTS, placementsUnreadable: true, placementsUnreadableCause: 'settings' }).body
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
      const call = buildDedicatedTeardownConfirm({ ...FACTS, placementsUnreadable: true, placementsUnreadableCause: cause }).body
      expect(call, String(cause)).toContain('保存場所の設定を問い合わせられなかったため、ここに保存場所の名前を挙げられません')
      expect(call, String(cause)).toContain('その中のこのプロジェクトのデータも削除される場合があります')
      expect(call, String(cause)).not.toContain('保存場所の削除は行われません')
      expect(call, String(cause)).not.toContain('その保存場所は残り、月額が続きます')
    }
    // 読めた回（原因だけが残っていても、placementsUnreadable が false なら言わない）
    expect(unreadableCautions({ ...FACTS, placementsUnreadable: false, placementsUnreadableCause: 'settings' })).toEqual([])
    const others = buildDedicatedTeardownConfirm({ ...FACTS, otherTargetsUnreadable: true }).body
    expect(others).toContain('ほかの公開先の記録を読めなかったため')
    expect(others).not.toContain('保存場所の設定を読めない')
  })

  it('★ 消すものの一覧が空でも「次を削除します: 」と空のまま出さない（名指ししないまま「削除する」を押させない・最後の砦）', () => {
    const msg = teardownConfirmMessage({ targets: [], placements: [], dataNote: '' })
    expect(msg).not.toMatch(/次を削除します: \n/)
    expect(msg).toContain('次を削除します: （記録に名前を挙げられるものがありません）')
    // 一覧があるときの文は変わらない
    expect(teardownConfirmMessage({ targets: ["クラスタ『c1』"], placements: [], dataNote: '' })).toContain("次を削除します: クラスタ『c1』")
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
    // 画面は、この判断で一覧を出す（hasAnyResource のまま戻らない）
    const panel = fs.readFileSync(path.join(__dirname, '../src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')
    expect(panel).toContain('{shouldShowTeardownList(apprunState) && (')
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

describe('(B2) electronFactsApi（本物の口）: storage:placement の全件を、確認の文まで落とさない', () => {
  const A = { bucket: 'koto-data-a', prefix: 'projects/myapp/', shared: true }
  const B = { bucket: 'koto-data-b', prefix: 'projects/myapp/', shared: true }
  const reply = (r: unknown) => { (globalThis as any).window.electronAPI.storage.placement = async () => r }

  it('★★★ 2件返れば2件とも確認の文に名指しされる（先頭1件だけを読むと『B』が名指しされないまま消える）', async () => {
    reply({ ok: true, placement: A, placements: [A, B] })
    const facts = await loadDedicatedTeardownFacts(dir, electronFactsApi())
    expect(facts.placements).toEqual([A, B])
    expect(facts.placementsUnreadable).toBe(false)
    const body = buildDedicatedTeardownConfirm(facts).body
    expect(body).toContain('保存場所『koto-data-a』『koto-data-b』にある、このプロジェクトのデータ')
  })

  it('★★ placements が無い古い応答でも、先頭1件は拾う（黙って空にしない）', async () => {
    reply({ ok: true, placement: A })
    const facts = await loadDedicatedTeardownFacts(dir, electronFactsApi())
    expect(facts.placements).toEqual([A])
    expect(buildDedicatedTeardownConfirm(facts).body).toContain('保存場所『koto-data-a』')
  })

  it('★★ 読めなかった（ok:false）は、空とは別の事実。placementsUnreadable が立ち、確認の文が「読めなかった」と言う', async () => {
    reply({ ok: false, placement: null, placements: [], message: 'env.json が壊れています' })
    const facts = await loadDedicatedTeardownFacts(dir, electronFactsApi())
    expect(facts.placements).toEqual([])
    expect(facts.placementsUnreadable).toBe(true)
    expect(facts.placementsUnreadableCause).toBe('settings')
    expect(buildDedicatedTeardownConfirm(facts).body).toContain('保存場所の設定を読めないため、保存場所の削除は行われません')
    // 例外で読めなかったとき（IPC の失敗）も「読めなかった」事実は残る。ただし理由が違う——設定を読めなかったのではなく、問い合わせそのものが失敗した。
    // main は env.json を読めて保存場所を削除するかもしれないので、「削除は行われません」とは言わない（2026-10-08 検分）
    ;(globalThis as any).window.electronAPI.storage.placement = async () => { throw new Error('IPC 失敗') }
    const facts2 = await loadDedicatedTeardownFacts(dir, electronFactsApi())
    expect(facts2.placementsUnreadable).toBe(true)
    expect(facts2.placementsUnreadableCause).toBe('call')
    const body2 = buildDedicatedTeardownConfirm(facts2).body
    expect(body2).toContain('保存場所の設定を問い合わせられなかったため')
    expect(body2).toContain('削除される場合があります')
    expect(body2).not.toContain('保存場所の削除は行われません')
  })

  it('読めた回は理由も立たない（placementsUnreadable:false・placementsUnreadableCause:null）', async () => {
    reply({ ok: true, placement: null, placements: [] })
    const facts = await loadDedicatedTeardownFacts(dir, electronFactsApi())
    expect(facts.placementsUnreadable).toBe(false)
    expect(facts.placementsUnreadableCause).toBeNull()
  })

  it('読めて 0 件（保存場所を用意していない）なら、「読めなかった」とは言わない', async () => {
    reply({ ok: true, placement: null, placements: [] })
    const facts = await loadDedicatedTeardownFacts(dir, electronFactsApi())
    expect(facts.placements).toEqual([])
    expect(facts.placementsUnreadable).toBe(false)
    expect(buildDedicatedTeardownConfirm(facts).body).not.toContain('読めなかった')
  })
})

// ── (B3) ほかの公開先の記録（.sakuraide.json）を読めなかったら、otherTargetsUnreadable が立つ（2026-10-08 検分 A）──────────
// 直す前は、本物の口（electronFactsApi）の otherTargets が readPublishTargets（失敗も壊れた JSON も [] に倒して投げない）を呼んでいた。
// そのため loadDedicatedTeardownFacts の「投げたら unreadable」の道は、偽の口の試験でしか通らず、**本物の口では一度も立たなかった**
// （確認の文の「ほかの公開先の記録を読めなかったため…」の注意が、実際には出ない）。偽 window の fs.readFile を壊して、本物の口で見る。
describe('(B3) electronFactsApi（本物の口）: ほかの公開先の記録を読めなかったら、otherTargetsUnreadable が立ち、確認の文が注意を言う', () => {
  const setReadFile = (fn: (p: string) => Promise<string>) => { (globalThis as any).window.electronAPI.fs.readFile = fn }
  const CAUTION = 'ほかの公開先の記録を読めなかったため'

  it('★★★ fs.readFile が reject すると立つ。ほかの公開先は空に倒すが、「読めなかった」事実は残り、確認の文が言う', async () => {
    setReadFile(async () => { throw new Error('EACCES: permission denied') })
    const facts = await loadDedicatedTeardownFacts(dir, electronFactsApi())
    expect(facts.otherTargets).toEqual([])
    expect(facts.otherTargetsUnreadable).toBe(true)
    expect(buildDedicatedTeardownConfirm(facts).body).toContain(CAUTION)
  })

  it.each([
    ['壊れた JSON', '{ 壊れた'],
    ['中身がオブジェクトでない（配列）', '[]'],
    ['中身がオブジェクトでない（null）', 'null'],
    ['publish が文字列', JSON.stringify({ publish: 'x' })],
    ['publish.targets が文字列', JSON.stringify({ publish: { targets: 'x' } })],
  ])('★★ 読めたが形が違う／壊れている（%s）も「読めなかった」。空に倒して続けるが、事実は残る', async (_label, text) => {
    setReadFile(async () => text)
    const facts = await loadDedicatedTeardownFacts(dir, electronFactsApi())
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
      const facts = await loadDedicatedTeardownFacts(dir, electronFactsApi())
      expect(facts.otherTargets, text).toEqual([])
      expect(facts.otherTargetsUnreadable, text).toBe(false)
      expect(buildDedicatedTeardownConfirm(facts).body, text).not.toContain(CAUTION)
    }
  })

  it('★ 読めて、ほかの公開先がある（このプロジェクトの記録は Vercel もある）なら、その名前を出し、「読めなかった」とは言わない', async () => {
    const facts = await loadDedicatedTeardownFacts(dir, electronFactsApi()) // beforeEach の本物の .sakuraide.json（専有型 ＋ Vercel）
    expect(facts.otherTargets).toEqual([PUBLISH_TARGET_LABEL.vercel])
    expect(facts.otherTargetsUnreadable).toBe(false)
    expect(buildDedicatedTeardownConfirm(facts).body).not.toContain(CAUTION)
  })

  it('★★ 入口（electronTeardownDeps）から確認ダイアログまで通しても、読めなかった注意が出る。やめれば IPC は0回', async () => {
    setReadFile(async () => { throw new Error('ENOENT') })
    const { deps, asked } = entryDeps(false)
    const out = await runDedicatedTeardown(dir, deps)
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
      fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8') },
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

/** 手順6の入口と同じ作り方（electronTeardownDeps）。確認の答えと入口ごとの文だけを渡す。 */
function entryDeps(answer: boolean, keyMissingMessage = '入口ごとの案内文') {
  const asked: unknown[] = []
  const deps = electronTeardownDeps(dir, { confirm: async o => { asked.push(o); return answer }, keyMissingMessage })
  return { deps, asked }
}

describe('(C) 本物の main ＋ 偽 client: 手順6も 📡 の入口も、アプリ → ロードバランサ → ASG → クラスタ の順に要求が出る', () => {
  it('★★★ 確認 yes: DELETE はこの4本がこの順で出る。IPC は { confirmed: true } 付きで1回だけ', async () => {
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const { deps } = entryDeps(true)
    const out = await runDedicatedTeardown(dir, deps)

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
    const out = await runDedicatedTeardown(dir, deps)

    expect(out).toEqual({ cancelled: true })
    expect(asked).toHaveLength(1)
    expect(calls).toEqual([])
    expect(win.ipcTeardown).toEqual([])
    expect(JSON.stringify(readApprunDedicatedFs(dir))).toBe(before)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
  })

  // 注意（2026-10-08 検分）: この試験は**同じ factory（electronTeardownDeps）を2回通して比べる**だけで、入口が食い違っても落ちない。
  // 「手順6の画面と 📡 の行が、どちらもこの factory を通っているか」は tests/apprunDedicatedWiring.test.ts（配線の試験。
  // 手順6は runDedicatedTeardown(projectDir, electronTeardownDeps(…))・📡 は useDedicatedTeardown 経由）が受け持つ。
  it('★ 同じ factory（electronTeardownDeps）を通せば、確認の文も、出る要求の列も、結果も同じ（入口が同じ factory を通っているかは配線の試験が見る）', async () => {
    const run = async () => {
      const calls: string[] = []
      h.baseUrl = await startServer(allRoutes(), calls)
      const { deps, asked } = entryDeps(true)
      const out = await runDedicatedTeardown(dir, deps)
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
    const out = await runDedicatedTeardown(dir, deps)
    const result = (out as any).result as DedicatedTeardownResult
    expect(result.ok).toBe(false)
    expect(calls.filter(c => c.startsWith('DELETE '))).toEqual(['DELETE /applications/app1'])
    expect(result.remaining).toMatchObject({ applicationID: 'app1', loadBalancerID: 'l1', asgID: 'a1', clusterID: 'c1' })
  })

  it('キーが無ければ、さくらへの要求は1本も出ない（入口ごとの案内文が結果になる）', async () => {
    installWindow({ key: null })
    const calls: string[] = []
    h.baseUrl = await startServer(allRoutes(), calls)
    const { deps } = entryDeps(true, '「認証情報」で登録してください')
    const out = await runDedicatedTeardown(dir, deps)
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
    const out = await runDedicatedTeardown(dir, deps)
    expect((out as any).result.ok).toBe(true)
    expect(targetsOf(dir)).toEqual(['vercel']) // main が消した
    expect(win.forgetTarget).toEqual([]) // 画面は消していない
  })

  it('★★ アプリの削除に失敗したら、公開記録は残る（まだ公開中のものを一覧から隠さない）。画面は消さない', async () => {
    h.baseUrl = await startServer(allRoutes({ 'DELETE /applications/app1': { status: 500, body: { status: 500, title: 'fail' } } }), [])
    const { deps } = entryDeps(true)
    await runDedicatedTeardown(dir, deps)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
    expect(win.forgetTarget).toEqual([])
  })

  it('★★ 確認で「やめる」なら、公開記録はそのまま', async () => {
    h.baseUrl = await startServer(allRoutes(), [])
    const { deps } = entryDeps(false)
    await runDedicatedTeardown(dir, deps)
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel'])
    expect(win.forgetTarget).toEqual([])
  })
})

describe('(D2) 途中で止まった削除の押し直し: 全部消せた回に、📡 の行（公開記録）が消える（幽霊の行を作らない・2026-10-08 検分）', () => {
  it('★★★ 1回目: ロードバランサの削除が失敗して止まる（行は残る）→ 2回目: 全部成功 → 専有型の行が消え、Vercel は残る。画面は消さない', async () => {
    const calls1: string[] = []
    h.baseUrl = await startServer(allRoutes({ 'DELETE /clusters/c1/asg/a1/load_balancers/l1': { status: 500, body: { status: 500, title: 'fail' } } }), calls1)
    const first = await runDedicatedTeardown(dir, entryDeps(true).deps)
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
    const second = await runDedicatedTeardown(dir, entryDeps(true).deps)
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
    const out = await runDedicatedTeardown(dir, deps)

    expect(out.cancelled).toBe(false)
    expect((out as any).result).toEqual({ ok: false, executed: [], message: NOTHING_TO_DELETE_MESSAGE, remaining: {} })
    expect(asked).toEqual([])
    expect(win.ipcTeardown).toEqual([])
    expect(calls).toEqual([])
    expect(targetsOf(dir)).toEqual(['sakura-apprun-dedicated', 'vercel']) // 行を消すのは「一覧から削除」（案内する）
    expect(NOTHING_TO_DELETE_MESSAGE).toContain('一覧から削除')
    expect(NOTHING_TO_DELETE_MESSAGE).toContain('さくらのクラウドには何も要求していません')
  })

  // 2026-10-08 検分 F: 「一覧から削除」は Koto の記録の行を消すだけで、さくら側の実物には触れない。記録が失われただけで実物が残っていることもある。
  // 押す前に、さくら側に残っていないかを確かめてもらう。案内が指す名前は、画面に実在するものだけ（掟9。README・使い方ガイドの引用も同じ）。
  it('★★ 案内は、「一覧から削除」の前に、さくら側に残っていないかを確かめるよう言う。指す画面の名前は実在し、README・使い方ガイドの引用と一致する', () => {
    const SENTENCE = 'さくら側に残っていないかは、📡 の「さくら側にあるものと、かかっている費用」で「調べる」を押すか、コントロールパネルで確かめてから、「一覧から削除」してください。'
    expect(NOTHING_TO_DELETE_MESSAGE).toContain(SENTENCE)
    // 順序: 「一覧から削除」で消せる、のあとに、確かめてから、が来る
    expect(NOTHING_TO_DELETE_MESSAGE.indexOf('その行の「一覧から削除」で消せます')).toBeLessThan(NOTHING_TO_DELETE_MESSAGE.indexOf(SENTENCE))
    // 指している画面の名前が、実際の画面（📡 の一覧）に実在する
    const modal = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/PublishedListModal.tsx'), 'utf-8')
    expect(modal).toContain('さくら側にあるものと、かかっている費用</h3>')
    expect(modal).toContain("{checking ? '調べています…' : '↻ 調べる'}")
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
    const out = await runDedicatedTeardown(dir, deps)
    expect(out).toEqual({ cancelled: true })
    expect(asked).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// (E) 📡 の行のフック（useDedicatedTeardown）を実際に動かす
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
function mountHook(over: { onOutcome?: (o: DedicatedTeardownOutcome) => void; onFinished?: () => void } = {}) {
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.r = 0; rt.e = 0
  const outcomes: DedicatedTeardownOutcome[] = []
  const finished: number[] = []
  let latest!: ReturnType<typeof useDedicatedTeardown>
  const history: Array<{ tearingDown: boolean; progress: string | null; runningKind: string | null }> = []
  const render = () => {
    rt.i = 0; rt.r = 0; rt.e = 0; rt.queue = []
    latest = useDedicatedTeardown(dir, {
      keyMissingMessage: 'API キーが未登録です（📡）',
      onOutcome: o => { outcomes.push(o); over.onOutcome?.(o) },
      onFinished: () => { finished.push(outcomes.length); over.onFinished?.() },
    })
    history.push({ tearingDown: latest.tearingDown, progress: latest.progress, runningKind: latest.runningKind })
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
    expect(m.outcomes[0].result.ok).toBe(true)
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

  it('★★ 確認の文は手順6と同じ関数の出力。ロードバランサの時間（約9分）が入っている', async () => {
    h.baseUrl = await startServer(allRoutes(), [])
    const m = mountHook()
    const started = m.latest.start()
    for (let k = 0; k < 400 && !(m.latest.confirmElement as any).props.open; k++) await tick()
    const props = (m.latest.confirmElement as any).props
    const expected = buildDedicatedTeardownConfirm({
      projectName: path.basename(dir),
      record: { ...FULL_RECORD, activeVersion: 1 } as any, placements: [], placementsUnreadable: false,
      otherTargets: ['▲ Vercel'], otherTargetsUnreadable: false, lbEstimateLine: '目安 約9分（開発時の実測・2026-09-10）',
    })
    expect(props.title).toBe(expected.title)
    expect(props.body).toBe(expected.body)
    expect(props.confirmLabel).toBe('削除する')
    expect(props.body).toContain('目安 約9分（開発時の実測・2026-09-10）')
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
    expect(win.busy[0]).toEqual([true, DEDICATED_TEARDOWN_ACTIVITY_LABEL, true, DEDICATED_TEARDOWN_ACTIVITY_LABEL, PUBLISH_CLOSE_WARNING.detail, PUBLISH_CLOSE_WARNING.confirmLabel])
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
    expect(m.latest.runningKind === 'teardown' || m.latest.tearingDown).toBe(true)
    open()
    await started

    // main が送った進み具合の文（待ちの経過）が、この行の画面状態に届いた
    expect(win.progressSent.some(s => s.includes('ロードバランサの削除を待っています'))).toBe(true)
    const shown = m.history.map(x => x.progress).filter((x): x is string => !!x)
    expect(shown.some(s => s.includes('ロードバランサの削除を待っています'))).toBe(true)
    // 記録（projectOps）の監視: 走っている間に「削除が走っている」と読めた
    expect(m.history.some(x => x.runningKind === 'teardown')).toBe(true)
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
    expect(reopened.latest.runningKind).toBe('teardown')
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
    expect(m.outcomes[0].result.ok).toBe(true)
    expect(m.outcomes[0].notes).toHaveLength(1)
    expect(m.outcomes[0].notes[0].kind).toBe('teardown')
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
    expect(m.outcomes[0].result.message).toBe('API キーが未登録です（📡）')
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
    expect(m.outcomes[0].result.ok).toBe(false)
    expect(m.outcomes[0].result.message).toBe(NOTHING_TO_DELETE_MESSAGE)
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
  hanamiiProjectId: null, registryName: null, registryAdopted: false,
})

/** 📡 の行（DedicatedTeardownRow）を、react の小さな代役の上で実際に動かす。行が一覧へ渡す部品（button・below・busy）と、行の末尾に描く確認ダイアログを読む。 */
function mountRow(over: { blocked?: boolean } = {}) {
  rt.slots = []; rt.refs = []; rt.effects = []; rt.queue = []; rt.i = 0; rt.r = 0; rt.e = 0
  const busy: boolean[] = []
  const outcomes: DedicatedTeardownOutcome[] = []
  let element: any
  let parts: any
  const render = () => {
    rt.i = 0; rt.r = 0; rt.e = 0; rt.queue = []
    element = DedicatedTeardownRow({
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

describe('(E3) 📡 の行（DedicatedTeardownRow）の配線: 確認ダイアログ・押せる条件・実行中の印', () => {
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
    await tick()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// watchDedicatedOps の kinds（📡 の行は削除だけを受け持つ）
// ═══════════════════════════════════════════════════════════════════════════════

describe('watchDedicatedOps({ kinds: [teardown] }): 📡 の行は削除の記録だけを読み、作成・公開の記録は読まない・見たことにもしない', () => {
  const rec = (handler: string, startedAt: number, extra: Record<string, unknown> = {}) => ({
    op: '削除', target: 'sakura-apprun-dedicated', handler, startedAt, finishedAt: startedAt + 1, running: false, seen: false,
    result: { ok: true, lines: [], warnings: [] }, ...extra,
  })

  function makeApi(snap: any) {
    const acks: Array<number | undefined> = []
    const api: DedicatedOpsApi = {
      get: async () => snap,
      ack: async (_d: string, upTo?: number) => { acks.push(upTo); return { ok: true, acked: 1 } },
      onChanged: () => () => {},
    }
    return { api, acks }
  }

  it('★ 走っている公開（publishApp）は、この行の「削除中」にならず、別の操作として1行の知らせになる', async () => {
    const { api } = makeApi({ running: { ...rec('apprunDedicated:publishApp', 5), running: true, op: '公開' }, last: null, earlier: [] })
    const views: any[] = []
    const w = watchDedicatedOps({ api, projectDir: '/p', kinds: ['teardown'], onRunning: v => views.push(v), onFinished: () => {} })
    await tick()
    expect(views[views.length - 1].running).toBeNull()
    expect(views[views.length - 1].other).not.toBeNull()
    w.stop()
  })

  it('★★ 削除の結果だけを渡す。手順5（作成）の結果は渡さず、ack の連鎖もそこで止まる（見ていないものを見たことにしない）', async () => {
    const { api, acks } = makeApi({ running: null, earlier: [rec('apprunDedicated:create', 10, { op: '作成' })], last: rec('apprunDedicated:teardown', 20) })
    const finished: any[] = []
    const w = watchDedicatedOps({ api, projectDir: '/p', kinds: ['teardown'], onRunning: () => {}, onFinished: f => finished.push(...f) })
    await tick()
    expect(finished.map(f => f.kind)).toEqual(['teardown'])
    expect(acks).toEqual([]) // 先頭の作成を見ていないので、削除も見たことにしない
    w.stop()
  })

  it('kinds を渡さなければ（専有型タブ）、3種類とも読む', async () => {
    const { api } = makeApi({ running: null, earlier: [rec('apprunDedicated:create', 10, { op: '作成' })], last: rec('apprunDedicated:teardown', 20) })
    const finished: any[] = []
    const w = watchDedicatedOps({ api, projectDir: '/p', onRunning: () => {}, onFinished: f => finished.push(...f) })
    await tick()
    expect(finished.map(f => f.kind)).toEqual(['create', 'teardown'])
    w.stop()
  })
})
