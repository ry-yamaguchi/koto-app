import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getOps, ackOps, progressReporter, setInFlightSink, setProjectOpsListener, flushInFlightOps, adoptStoppedOps,
  runningOpName, listRunningOps, summarizeResult, resetProjectOpsForTests, type ProjectOp, type ProjectOpsSnapshot,
} from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import * as stoppedOps from '../src/main/stoppedOps'
import { adoptAtStartup, emptyInFlightFile, type InFlightFile, type InFlightRun } from '../src/shared/inFlightOps'
import { formatDuration, stageTimingView } from '../src/shared/stageTiming'

// ── 止まった回の読み戻し・知らせ・合わせる（projectOps・stoppedOps）（設計書 10.13.5・10.13.6・10.13.9・10.13.12 の U1〜U11）─────────────
// 「Koto を終了して開き直す」は、終了の直前の書き切り（flushInFlightOps）→ メモリを捨てる（resetProjectOpsForTests）→
// 前のファイルを整えて読み戻す（adoptAtStartup）→ 止まった回を渡す（adoptStoppedOps）、で模す。本物の鍵（withProjectLock）と偽の口を使い、
// 時計は Date だけを偽物にして固定する（実際には待たない）。ファイルには触らない（口の先は偽物）。

const A = '/p/resume-a'
const B = '/p/resume-b'
const DED = { target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown' }
const HAN = { target: 'hanamii' as const, handler: 'hanamii:teardown' }
const T0 = Date.UTC(2026, 9, 12, 3, 0, 0)
const SEC = 1000
const MIN = 60 * SEC
const PROBE = { exists: () => true, hasWork: () => true }

let mono = 0
/** 口の先に「残っているファイル」（最後に書けた中身）。 */
let disk: InFlightFile

const setNow = (ms: number) => vi.setSystemTime(ms)

/** 偽の口をつなぐ。渡された中身は JSON で写し取る（あとから projectOps のメモリが変わっても、渡した時点の中身で比べる）。 */
function connect(): InFlightFile[] {
  const writes: InFlightFile[] = []
  setInFlightSink(file => {
    const copy = JSON.parse(JSON.stringify(file)) as InFlightFile
    writes.push(copy)
    disk = copy
    return true
  }, { version: '0.6.22', monotonicNow: () => mono })
  return writes
}

beforeEach(() => {
  resetProjectOpsForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  setNow(T0)
  mono = 0
  disk = emptyInFlightFile()
  connect()
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); resetProjectOpsForTests() })

/** 外から開けるまで止まっている処理。 */
function gate<T>(value: T) {
  let open!: () => void
  const closed = new Promise<void>(r => { open = r })
  return { open, wait: async () => { await closed; return value } }
}

/** 「起動」: ファイルを整えて読み戻し、止まった回を渡し、口をつなぐ（inFlightOpsArm.ts がすること。ファイルの代わりに disk を使う）。 */
function boot(file: InFlightFile, now: number, probe = PROBE): InFlightFile[] {
  resetProjectOpsForTests()
  setNow(now)
  const adopted = adoptAtStartup(file, now, probe)
  adoptStoppedOps(adopted.stopped, now)
  disk = adopted // 読み戻しは整えた中身を書き戻す
  return connect()
}

/** Koto の終了（will-quit の書き切り）のあと、開き直す。 */
function quitAndBoot(quitAt: number, bootAt: number, probe = PROBE): InFlightFile[] {
  setNow(quitAt)
  flushInFlightOps(quitAt)
  return boot(disk, bootAt, probe)
}

/**
 * 削除を始めて、アプリ → ロードバランサの段へ進めたまま、閉じない（Koto の終了で止まる前の状態）。
 * アプリは startAt〜+72秒、ロードバランサは +72秒から（開いたまま）。
 */
function stuckDeletion(dir: string, meta: { target: 'sakura-apprun-dedicated' | 'hanamii'; handler: string } = DED, startAt = T0): void {
  setNow(startAt)
  const g = gate({ ok: true })
  void withProjectLock(dir, '削除', g.wait, meta) // 開けない
  const progress = progressReporter(dir)
  progress('アプリを削除しています…', { stage: 'teardown.app' })
  setNow(startAt + 72 * SEC)
  progress('ロードバランサの削除を待っています…', { stage: 'teardown.lb' })
}

/** 段を順に通って終わる操作。`stages` は［段, かかる時間］。 */
async function runOp(dir: string, op: ProjectOp, meta: { target: 'sakura-apprun-dedicated' | 'hanamii'; handler: string }, result: unknown, stages: [string, number][] = [['teardown.cluster', 10 * SEC]]) {
  const progress = progressReporter(dir)
  return withProjectLock(dir, op, async () => {
    for (const [stage, ms] of stages) { progress('進み具合', { stage }); setNow(Date.now() + ms) }
    return result
  }, meta)
}

const OK = { ok: true, message: '消しました' }
const NOT_YET = { ok: false, message: 'まだ削除中です。しばらくして手順6をもう一度押してください', inProgress: { loadBalancerID: 'lb-1' } }

/** 手で作る止まった回（時計のずれの試験用）。 */
const craftedRun = (startedAt: number, lastSeenAt: number, stage = 'teardown.app'): InFlightRun => ({
  op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', version: '0.6.22',
  startedAt, lastSeenAt, segments: [{ stage, startedAt }],
})

// 10.13.6 の見せ方の例: 止まった回は 6分20秒まで分かっている（アプリ 1分12秒 → ロードバランサ 5分8秒）。
const QUIT_AT = T0 + 380 * SEC
const REBOOT_AT = T0 + 20 * MIN

describe('U1 止まった削除が、そのプロジェクトの getOps().last に出る。別のプロジェクトには出ない', () => {
  it('★ 開き直すと、決まった文の「止まりました」が1件（ok:false・stoppedByQuit・警告なし・時間なし）。走っているとは言わない', () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    const ops = getOps(A)
    expect(ops.running).toBeNull()
    expect(ops.earlier).toEqual([])
    expect(ops.last).toEqual({
      op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown',
      startedAt: T0, running: false, seen: false,
      progress: { label: '', detail: '', at: QUIT_AT }, finishedAt: QUIT_AT,
      result: { ok: false, message: 'もう一度削除を押すと、続きから進みます。', lines: [], warnings: [], extra: { stoppedByQuit: true } },
    })
    expect(ops.last!.result!.extra.stageTimings).toBeUndefined()
  })

  it('★ 別のプロジェクトの getOps には出ない（掟11）。ファイルにも書いた状態（読み戻した中身）が残る', () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    expect(getOps(B)).toEqual({ running: null, last: null, earlier: [] })
    expect(Object.keys(disk.stopped)).toEqual([A])
    expect(disk.running).toEqual({})
  })

  it('共用型・HANAMII の知らせは、続きからとは言わない（確かめていない。判断 I）', () => {
    stuckDeletion(A, HAN)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    expect(getOps(A).last!.target).toBe('hanamii')
    expect(getOps(A).last!.result!.message).toBe('どこまで済んだか管理画面で確かめてから、もう一度破棄を押してください。')
  })

  it('★ 作成・公開が止まっても知らせは出ない（表のとおり捨てる）。止まった削除があるプロジェクトの知らせも置き換えない', () => {
    // 公開が止まった: 知らせなし
    setNow(T0)
    void withProjectLock(A, '公開', gate({ ok: true }).wait, DED)
    quitAndBoot(T0 + 5 * SEC, REBOOT_AT)
    expect(getOps(A).last).toBeNull()
    expect(disk.stopped).toEqual({})
    // 削除が止まったあと、同じプロジェクトで作成が止まっても、止まった削除は残る
    resetProjectOpsForTests(); connect(); disk = emptyInFlightFile(); setNow(T0)
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    expect(Object.keys(disk.stopped)).toEqual([A])
    void withProjectLock(A, '作成', gate({ ok: true }).wait, DED)
    quitAndBoot(REBOOT_AT + 5 * SEC, REBOOT_AT + 20 * MIN)
    expect(disk.stopped[A].runs.map(r => r.op)).toEqual(['削除'])
    expect(getOps(A).last!.op).toBe('削除')
  })

  it('いちばん新しい回が「待ち切れて止まった」ものだけ・見た後のものには、知らせを置かない', () => {
    const unfinished = { ...craftedRun(T0, T0 + 600 * SEC), endedBy: 'unfinished' as const }
    const entry = (noticeSeen: boolean) => ({ op: '削除' as const, target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown', runs: [unfinished], noticeSeen })
    boot({ v: 1, running: {}, stopped: { [A]: entry(true) } }, REBOOT_AT)
    expect(getOps(A).last).toBeNull() // 待ち切れた回は、その回の結果そのものが知らせだった
    boot({ v: 1, running: {}, stopped: { [A]: entry(false) } }, REBOOT_AT)
    expect(getOps(A).last).toBeNull() // 見ていなくても、いちばん新しい回が 'unfinished' なら置かない
    boot({ v: 1, running: {}, stopped: { [A]: { ...entry(true), runs: [{ ...craftedRun(T0, T0 + 60 * SEC), endedBy: 'quit' as const }] } } }, REBOOT_AT)
    expect(getOps(A).last).toBeNull() // quit でも、見たあとなら出ない
  })
})

describe('U2 ackOps で消え、口に渡ったファイルの noticeSeen が true。もう一度「再起動」しても出ない', () => {
  it('★ 画面が見たと伝えると知らせが消え、ファイルに見た印が書かれる。時間（止まった回）は消えない', () => {
    stuckDeletion(A)
    const writes = quitAndBoot(QUIT_AT, REBOOT_AT)
    const id = getOps(A).last!.startedAt
    expect(disk.stopped[A].noticeSeen).toBe(false)
    const n = writes.length
    expect(ackOps(A, id)).toBe(1)
    expect(getOps(A).last).toBeNull()
    expect(writes.length).toBe(n + 1)
    expect(disk.stopped[A].noticeSeen).toBe(true)
    expect(disk.stopped[A].runs).toHaveLength(1) // 時間は消えない
    quitAndBoot(REBOOT_AT + MIN, REBOOT_AT + 2 * MIN)
    expect(getOps(A).last).toBeNull() // もう一度開き直しても出ない
    expect(disk.stopped[A].noticeSeen).toBe(true)
    expect(disk.stopped[A].runs).toHaveLength(1)
  })

  it('★ 引数なしの ackOps（見られていない全部）でも見た印が付く。ほかのプロジェクトの印は変わらない', () => {
    stuckDeletion(A)
    stuckDeletion(B, DED, T0 + MIN)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    expect(ackOps(A)).toBe(1)
    expect(disk.stopped[A].noticeSeen).toBe(true)
    expect(disk.stopped[B].noticeSeen).toBe(false)
    expect(getOps(B).last).not.toBeNull()
  })

  it('知らせではない記録を見ても、見た印は書かない（口へ余分に書かない）', async () => {
    stuckDeletion(A)
    const writes = quitAndBoot(QUIT_AT, REBOOT_AT)
    await runOp(B, '削除', DED, OK) // B の普通の結果
    const n = writes.length
    expect(ackOps(B)).toBe(1)
    expect(writes.length).toBe(n)
    expect(disk.stopped[A].noticeSeen).toBe(false)
  })
})

describe('U2b 見た印は、見たときだけ書く', () => {
  it('★ 上限（見られていない記録は5件まで）で押し出された知らせは、見たことにならない。ほかの記録を見ても、次の起動でまた出る', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    // 違う種類の失敗を5回: 知らせ（ok:false・警告なし）は、警告も失敗も無い成功ではないので、いちばん古いものとして押し出される。
    for (let i = 0; i < 5; i++) await runOp(A, '公開', DED, { ok: false, message: `失敗${i}` }, [['publish.image', SEC]])
    expect(getOps(A).last!.result!.message).toBe('失敗4')
    expect([getOps(A).last!, ...getOps(A).earlier].some(r => r.result!.extra.stoppedByQuit === true)).toBe(false) // 知らせは押し出された
    expect(ackOps(A)).toBe(5)
    expect(disk.stopped[A].noticeSeen).toBe(false) // 見ていないので、見た印は付かない
    quitAndBoot(Date.now(), Date.now() + MIN)
    expect(getOps(A).last!.result!.extra.stoppedByQuit).toBe(true) // もう一度開き直すと、また出る
  })
})

describe('U3 同じ公開先・種類の操作が始まると知らせが消える。違うなら消えない', () => {
  it('★ 同じ公開先の削除が始まる: 知らせが消え、ファイルの noticeSeen が true（時間は残る）', () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    expect(getOps(A).last).not.toBeNull()
    const g = gate(OK)
    const p = withProjectLock(A, '削除', g.wait, DED)
    expect(getOps(A).last).toBeNull() // 始まった時点で消える（押し出しも）
    expect(getOps(A).running!.op).toBe('削除')
    expect(disk.stopped[A].noticeSeen).toBe(true)
    expect(disk.stopped[A].runs).toHaveLength(1)
    g.open(); void p
  })

  it('★ 違う公開先の削除・違う種類の操作が始まっても、知らせは消えない（見た印も付かない）', () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    const keep = (): void => {
      expect(getOps(A).last!.result!.extra.stoppedByQuit).toBe(true)
      expect(disk.stopped[A].noticeSeen).toBe(false)
    }
    const g1 = gate(OK)
    void withProjectLock(A, '削除', g1.wait, HAN) // 違う公開先
    keep()
    g1.open()
  })

  it('違う種類（公開）でも消えない', () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    void withProjectLock(A, '公開', gate(OK).wait, DED)
    expect(getOps(A).last!.result!.extra.stoppedByQuit).toBe(true)
    expect(disk.stopped[A].noticeSeen).toBe(false)
  })
})

describe('U3b 止まった回が「作り直した」で消えたら、見られていない知らせも消える（画面が言うことと main が持つことを割らない）', () => {
  /** 見られていない記録のうち、「止まりました」の知らせ（last と earlier の両方を見る）。 */
  const noticesOf = (dir: string) => [getOps(dir).last, ...getOps(dir).earlier].filter(r => r?.result?.extra.stoppedByQuit === true)

  it('★ 同じ公開先の公開・作成が ok:true で終わると、知らせも消える（getOps・押し出しの写し・ファイルの3つとも）。公開の結果は残る', async () => {
    for (const op of ['公開', '作成'] as const) {
      resetProjectOpsForTests(); connect(); disk = emptyInFlightFile()
      stuckDeletion(A)
      quitAndBoot(QUIT_AT, REBOOT_AT)
      expect(noticesOf(A)).toHaveLength(1) // 前提: 知らせが出ている
      const pushed: ProjectOpsSnapshot[] = []
      setProjectOpsListener((_dir, snap) => { pushed.push(snap) })
      const r = await runOp(A, op, DED, OK, [['publish.image', 5 * SEC]])
      if (r.busy) throw new Error('busy')
      expect(noticesOf(A)).toEqual([])
      expect(getOps(A).earlier).toEqual([])
      expect(getOps(A).last!.op).toBe(op) // 公開・作成の結果そのものは残る
      expect(getOps(A).last!.result!.ok).toBe(true)
      const lastPushed = pushed.at(-1)!
      expect([lastPushed.last, ...lastPushed.earlier].filter(x => x?.result?.extra.stoppedByQuit === true)).toEqual([]) // 画面へ押し出した写しにも無い
      expect(disk.stopped).toEqual({}) // main が持つ止まった回ももう無い（割れていない）
      setProjectOpsListener(null)
    }
  })

  it('★ 公開が ok:false で終わったときは、知らせも止まった回も残る（作り直せていない）', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    await runOp(A, '公開', DED, { ok: false, message: '失敗' }, [['publish.image', 5 * SEC]])
    expect(noticesOf(A)).toHaveLength(1)
    expect(disk.stopped[A].runs).toHaveLength(1)
  })

  it('★ 違う公開先の公開が ok:true で終わっても、知らせは消えない（止まった回も残る）', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    await runOp(A, '公開', HAN, OK, [['publish.image', 5 * SEC]])
    expect(noticesOf(A)).toHaveLength(1)
    expect(disk.stopped[A].runs).toHaveLength(1)
  })

  it('★ 別のプロジェクトの知らせは消さない（掟11）。同じプロジェクトの別の記録も巻き込まない', async () => {
    stuckDeletion(A)
    stuckDeletion(B, DED, T0 + MIN)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    await runOp(A, '公開', HAN, { ok: false, message: '別の失敗' }, [['publish.image', SEC]]) // A の知らせより後ろに積まれた別の記録
    await runOp(A, '作成', DED, OK, [['publish.image', 5 * SEC]])
    expect(noticesOf(A)).toEqual([])
    expect(getOps(A).last!.op).toBe('作成')
    expect(getOps(A).earlier.map(r => r.result!.message)).toEqual(['別の失敗']) // 知らせだけが外れ、ほかは残る
    expect(noticesOf(B)).toHaveLength(1)
    expect(Object.keys(disk.stopped)).toEqual([B])
  })
})

describe('U4 合計: 止まった回と今回を合わせて出す。止まっていた間は含まない', () => {
  /** 今回: ロードバランサ 3分2秒・ASG 2分22秒・クラスタ 0.4秒・保存場所 4秒。最初の段に入る前の 3秒は段の外（合計にだけ入る）。 */
  async function secondRun() {
    const S = REBOOT_AT
    const progress = progressReporter(A)
    return withProjectLock(A, '削除', async () => {
      setNow(S + 3 * SEC); progress('LB', { stage: 'teardown.lb' })
      setNow(S + 185 * SEC); progress('ASG', { stage: 'teardown.asg' })
      setNow(S + 327 * SEC); progress('クラスタ', { stage: 'teardown.cluster' })
      setNow(S + 327.4 * SEC); progress('保存場所', { stage: 'teardown.storage' })
      setNow(S + 331.4 * SEC)
      return OK
    }, DED)
  }

  it('★ 結果の earlierRuns に止まった回の段と partialLast。その場の戻り値と記録は同じ値（双子）。合計は止まっていた間を含まない', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    const r = await secondRun()
    expect(r.busy).toBe(false)
    if (r.busy) return
    const quitRun = {
      startedAt: T0, lastKnownAt: QUIT_AT, endedBy: 'quit', knownMs: 380_000, partialLast: true,
      stages: [{ stage: 'teardown.app', ms: 72_000 }, { stage: 'teardown.lb', ms: 308_000 }],
    }
    const expected = {
      totalMs: 331_400,
      stages: [{ stage: 'teardown.lb', ms: 182_000 }, { stage: 'teardown.asg', ms: 142_000 }, { stage: 'teardown.cluster', ms: 400 }, { stage: 'teardown.storage', ms: 4_000 }],
      earlierRuns: [quitRun],
    }
    expect(r.stageTimings).toEqual(expected)
    expect(getOps(A).last!.result!.extra.stageTimings).toEqual(expected) // 開き直したとき読む記録
    // 見せ方の合計: 止まった回の分（6分20秒）＋今回（5分31.4秒）。止まっていた間（約13分）は数えない。
    const view = stageTimingView(r.stageTimings!)
    expect(view.total).toEqual({ label: '合計（止まっていた間を除く）', text: '11分51秒' })
    expect(view.total.text).not.toBe(formatDuration(REBOOT_AT + 331_400 - T0))
    expect(view.earlier![0].rows.map(x => x.text)).toEqual(['1分12秒', '途中まで（少なくとも5分8秒）'])
    expect(view.rows.map(x => x.text)).toEqual(['3分2秒', '2分22秒', '1秒未満', '4秒'])
    expect(view.thisRunHeading).toBe('今回')
  })

  it('止まった回が無い削除は、今までと同じ（earlierRuns のキーが無い）', async () => {
    const r = await runOp(A, '削除', DED, OK, [['teardown.lb', 3 * SEC]])
    if (r.busy) throw new Error('busy')
    expect('earlierRuns' in r.stageTimings!).toBe(false)
    expect('earlierRuns' in (getOps(A).last!.result!.extra.stageTimings as object)).toBe(false)
  })
})

describe('U5 ok:true で出したら消える', () => {
  it('★ 次の削除には earlierRuns が付かない。ファイルの stopped から消える', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    const first = await runOp(A, '削除', DED, OK)
    if (first.busy) throw new Error('busy')
    expect(first.stageTimings!.earlierRuns).toHaveLength(1)
    expect(disk.stopped).toEqual({})
    expect(disk.running).toEqual({})
    const second = await runOp(A, '削除', DED, OK)
    if (second.busy) throw new Error('busy')
    expect('earlierRuns' in second.stageTimings!).toBe(false)
    quitAndBoot(Date.now(), Date.now() + MIN)
    expect(getOps(A).last).toBeNull() // 開き直しても、もう出ない
  })
})

describe('U6 違う公開先・違う種類の操作は止まった回を消さず、合わせない', () => {
  async function stoppedThen<T>(fn: () => Promise<T>): Promise<T> {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    return fn()
  }

  it('★ 違う公開先の削除（ok:true）: earlierRuns を付けず、止まった回を消さない', async () => {
    const r = await stoppedThen(() => runOp(A, '削除', HAN, OK))
    if (r.busy) throw new Error('busy')
    expect('earlierRuns' in r.stageTimings!).toBe(false)
    expect(disk.stopped[A].runs).toHaveLength(1)
    expect(disk.stopped[A].target).toBe('sakura-apprun-dedicated')
  })

  it('★ 違う種類（公開）が失敗: 止まった回は残り、合わせない', async () => {
    const r = await stoppedThen(() => runOp(A, '公開', DED, { ok: false, message: '失敗' }, [['publish.image', 5 * SEC]]))
    if (r.busy) throw new Error('busy')
    expect('earlierRuns' in r.stageTimings!).toBe(false)
    expect(disk.stopped[A].runs).toHaveLength(1)
  })

  it('★ 同じ公開先の公開・作成が ok:true で終わると、止まった削除の回は消える（作り直した＝別の一生）', async () => {
    for (const op of ['公開', '作成'] as const) {
      resetProjectOpsForTests(); connect(); disk = emptyInFlightFile()
      const r = await stoppedThen(() => runOp(A, op, DED, OK, [['publish.image', 5 * SEC]]))
      if (r.busy) throw new Error('busy')
      expect('earlierRuns' in r.stageTimings!).toBe(false)
      expect(disk.stopped).toEqual({})
    }
  })

  it('違う公開先の公開が ok:true で終わっても、止まった削除の回は消えない', async () => {
    await stoppedThen(() => runOp(A, '公開', HAN, OK, [['publish.image', 5 * SEC]]))
    expect(disk.stopped[A].runs).toHaveLength(1)
  })

  it('★ 今回に段の時間が無い: ok:false なら残る（次に押したときに合わせる）・ok:true なら消える（合わせる相手がもう無い）', async () => {
    const failed = await stoppedThen(() => runOp(A, '削除', DED, { ok: false, message: '失敗' }, []))
    if (failed.busy) throw new Error('busy')
    expect(failed.stageTimings).toBeUndefined()
    expect(disk.stopped[A].runs).toHaveLength(1)
    const done = await runOp(A, '削除', DED, OK, [])
    if (done.busy) throw new Error('busy')
    expect(done.stageTimings).toBeUndefined()
    expect(disk.stopped).toEqual({})
  })

  it('★ 今回が続けられない失敗（ok:false）でも、止まった回は残り、今回の回は足されない。次の成功で合わせる', async () => {
    const failed = await stoppedThen(() => runOp(A, '削除', DED, { ok: false, message: '失敗' }, [['teardown.lb', 20 * SEC]]))
    if (failed.busy) throw new Error('busy')
    expect(failed.stageTimings!.earlierRuns).toHaveLength(1) // 失敗した回にも、止まった回は並ぶ
    expect(disk.stopped[A].runs.map(r => r.endedBy)).toEqual(['quit'])
    const done = await runOp(A, '削除', DED, OK)
    if (done.busy) throw new Error('busy')
    expect(done.stageTimings!.earlierRuns).toHaveLength(1) // 失敗した回の時間は足されていない
    expect(done.stageTimings!.earlierRuns![0].endedBy).toBe('quit')
    expect(disk.stopped).toEqual({})
  })
})

describe('U7 時計: 知らせの識別子は起動時の now を超えない。新しい操作の識別子はそれより大きい', () => {
  it('★ (a) 止まった回の startedAt が起動時の now より未来（5分未満）でも、識別子は now − 1。新しい操作は now で始まり、各段の時間が0に潰れない', async () => {
    const NOW = T0 + 40 * MIN
    boot({
      v: 1, stopped: {},
      running: { [A]: craftedRun(NOW + 4 * MIN, NOW + 4 * MIN + 59 * SEC) },
    }, NOW)
    expect(getOps(A).last!.startedAt).toBe(NOW - 1) // min(startedAt, now − 1)
    const progress = progressReporter(A)
    const r = await withProjectLock(A, '削除', async () => {
      progress('1', { stage: 'teardown.app' }); setNow(NOW + 10 * SEC)
      progress('2', { stage: 'teardown.lb' }); setNow(NOW + 20 * SEC)
      progress('3', { stage: 'teardown.asg' }); setNow(NOW + 30 * SEC)
      return OK
    }, DED)
    if (r.busy) throw new Error('busy')
    expect(r.stageTimings!.stages).toEqual([{ stage: 'teardown.app', ms: 10_000 }, { stage: 'teardown.lb', ms: 10_000 }, { stage: 'teardown.asg', ms: 10_000 }])
    const startedAt = getOps(A).last!.startedAt
    expect(startedAt).toBeGreaterThan(NOW - 1)
    expect(startedAt).toBeLessThanOrEqual(NOW + 20) // 起動時の now を、複数の知らせの数 ms 以上は超えない
  })

  it('★ (b) 知らせが何件あっても識別子は古い順に増え（1msずつ）、ackOps(識別子) は新しい操作の結果を消さない', async () => {
    const NOW = T0 + 40 * MIN
    const future = (i: number) => craftedRun(NOW + (60 + i) * SEC, NOW + 90 * SEC)
    const P = (i: number) => `/p/resume-p${i}`
    boot({ v: 1, stopped: {}, running: { [P(1)]: future(0), [P(2)]: future(1), [P(3)]: future(2) } }, NOW)
    const ids = [1, 2, 3].map(i => getOps(P(i)).last!.startedAt)
    expect(ids).toEqual([NOW - 1, NOW, NOW + 1])
    // 3つ目の知らせがあるプロジェクトで、別の公開先の公開が終わる。知らせは残る（同じ公開先の公開が ok:true で終わると知らせも消える＝U3b）。
    const r = await runOp(P(3), '公開', HAN, OK, [['publish.image', 1]])
    if (r.busy) throw new Error('busy')
    const last = getOps(P(3)).last!
    expect(last.op).toBe('公開')
    expect(last.startedAt).toBeGreaterThan(ids[2]) // 知らせの識別子より大きい
    expect(ackOps(P(3), ids[2])).toBe(1) // 知らせだけ見た
    expect(getOps(P(3)).last!.op).toBe('公開') // 公開の結果は消えていない
  })

  it('識別子は、止まった回の startedAt が起動時より前なら、その startedAt そのもの', () => {
    boot({ v: 1, stopped: {}, running: { [A]: craftedRun(T0, T0 + 60 * SEC) } }, REBOOT_AT)
    expect(getOps(A).last!.startedAt).toBe(T0)
  })
})

describe('U8 止まった回は「走っている」に入らない（quitGuard の材料）', () => {
  it('★ listRunningOps・runningOpName・getOps().running に止まった回は出ない。同じプロジェクトでもう一度始められる', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    expect(listRunningOps()).toEqual([])
    expect(runningOpName(A)).toBeUndefined()
    expect(getOps(A).running).toBeNull()
    const again = await runOp(A, '削除', DED, OK)
    expect(again.busy).toBe(false)
  })
})

describe('U9 偽の知らせを作れない', () => {
  it('★ 返り値に stoppedByQuit があっても、記録の extra には写らない', () => {
    const r = summarizeResult({ ok: false, stoppedByQuit: true, message: 'x' })
    expect(r.extra).not.toHaveProperty('stoppedByQuit')
    expect(r.extra).toEqual({})
  })

  it('ハンドラの返り値に stoppedByQuit があっても、終わった結果は知らせとして扱われない（見た印も付かない）', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    await runOp(B, '削除', DED, { ok: false, stoppedByQuit: true, message: 'x' })
    expect(getOps(B).last!.result!.extra).not.toHaveProperty('stoppedByQuit')
    ackOps(B)
    expect(disk.stopped[A].noticeSeen).toBe(false) // B の結果を見ても A の知らせは見たことにならない
  })
})

describe('U10 押し出しの写し: その場・開き直し・押し出しの3つが割れない', () => {
  it('★ setProjectOpsListener が最後に受けた写しの earlierRuns が、finishOp の戻り値の earlierRuns と同じ', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    const got: { dir: string; snap: ProjectOpsSnapshot }[] = []
    setProjectOpsListener((dir, snap) => { got.push({ dir, snap }) })
    const r = await runOp(A, '削除', DED, OK, [['teardown.lb', 20 * SEC], ['teardown.asg', 10 * SEC]])
    if (r.busy) throw new Error('busy')
    expect(r.stageTimings!.earlierRuns).toHaveLength(1)
    const pushed = got.filter(g => g.dir === A).at(-1)!.snap.last!.result!.extra.stageTimings as { earlierRuns?: unknown }
    expect(pushed.earlierRuns).toEqual(r.stageTimings!.earlierRuns)
    expect(getOps(A).last!.result!.extra.stageTimings).toEqual(r.stageTimings) // 開き直したとき読む記録
  })
})

describe('U11 待ち切れた回（判断 J）: 止まった回として足し、消すのは ok:true のときだけ', () => {
  it('★ 止まった回（quit）→ 待ち切れた回 → 最後まで消えた回: 最後の結果は3回分の時間（古い順）を並べる', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    // 2回目: ロードバランサの削除を10分待って「まだ削除中」。止まった回（quit）が並ぶ。
    const second = await runOp(A, '削除', DED, NOT_YET, [['teardown.lb', 10 * MIN]])
    if (second.busy) throw new Error('busy')
    expect(second.stageTimings!.earlierRuns!.map(r => r.endedBy)).toEqual(['quit'])
    expect(disk.stopped[A].runs.map(r => r.endedBy)).toEqual(['quit', 'unfinished'])
    expect(disk.stopped[A].noticeSeen).toBe(true) // この回の結果そのものが知らせ
    const unfinished = disk.stopped[A].runs[1]
    expect(unfinished.segments).toEqual([{ stage: 'teardown.lb', startedAt: REBOOT_AT, endedAt: REBOOT_AT + 10 * MIN }])
    expect(unfinished.lastSeenAt).toBe(REBOOT_AT + 10 * MIN)
    // 「再起動」しても残る（知らせは出ない）
    const bootAt = REBOOT_AT + 40 * MIN
    quitAndBoot(Date.now(), bootAt)
    expect(getOps(A).last).toBeNull()
    expect(disk.stopped[A].runs).toHaveLength(2)
    // 3回目: 最後まで消える。止まった2回分（古い順）と今回の合計。
    const third = await runOp(A, '削除', DED, OK, [['teardown.asg', 2 * MIN], ['teardown.cluster', 30 * SEC]])
    if (third.busy) throw new Error('busy')
    const earlier = third.stageTimings!.earlierRuns!
    expect(earlier.map(r => r.endedBy)).toEqual(['quit', 'unfinished'])
    expect(earlier[1]).toMatchObject({ knownMs: 10 * MIN, partialLast: true, stages: [{ stage: 'teardown.lb', ms: 10 * MIN }] })
    expect(stageTimingView(third.stageTimings!).total.text).toBe(formatDuration(380_000 + 10 * MIN + 150_000)) // 止まっていた間は含まない
    expect(disk.stopped).toEqual({}) // ok:true で消える
  })

  it('★ 止まった回が無い最初の inProgress の回も、unfinished として残る（その回の結果に earlierRuns は付かない）', async () => {
    const first = await runOp(A, '削除', DED, NOT_YET, [['teardown.lb', 10 * MIN]])
    if (first.busy) throw new Error('busy')
    expect('earlierRuns' in first.stageTimings!).toBe(false)
    expect(disk.stopped[A].runs.map(r => r.endedBy)).toEqual(['unfinished'])
    expect(disk.stopped[A]).toMatchObject({ op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', noticeSeen: true })
    expect(getOps(A).last!.result!.extra.stoppedByQuit).toBeUndefined() // 画面に出るのはこの回の結果で、知らせではない
  })

  it('★ 失敗（続けられない形ではない）は足さない。HANAMII の受付済み（段なし）も足さない', async () => {
    await runOp(A, '削除', DED, { ok: false, message: '失敗', remaining: { loadBalancerID: 'lb-1' } }, [['teardown.lb', 10 * SEC]])
    expect(disk.stopped).toEqual({})
    await runOp(B, '削除', HAN, { ok: false, deletionAccepted: true, message: '受け付けました' }, [])
    expect(disk.stopped).toEqual({})
  })

  it('止まった回は3回まで。4回目を足すと、いちばん古い回から捨てる', async () => {
    const starts: number[] = []
    for (let i = 0; i < 4; i++) {
      starts.push(Date.now())
      await runOp(A, '削除', DED, NOT_YET, [['teardown.lb', 10 * MIN]])
      setNow(Date.now() + MIN)
    }
    expect(disk.stopped[A].runs.map(r => r.startedAt)).toEqual(starts.slice(1))
  })

  it('別の公開先の止まった回があるときは置き換える（新しいほうだけが残る。ハンドラ名も新しいほう）', async () => {
    stuckDeletion(A, HAN)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    const r = await runOp(A, '削除', DED, NOT_YET, [['teardown.lb', 10 * MIN]])
    if (r.busy) throw new Error('busy')
    expect('earlierRuns' in r.stageTimings!).toBe(false) // 公開先が違うので合わせない
    expect(disk.stopped[A]).toMatchObject({ target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown' })
    expect(disk.stopped[A].runs.map(x => x.endedBy)).toEqual(['unfinished'])
  })

  it('持つ項目は20件まで。足して超えたら、いちばん新しい回の時刻が古いものを捨てる', async () => {
    for (let i = 0; i < 21; i++) {
      setNow(T0 + i * MIN)
      await runOp(`/p/resume-many-${i}`, '削除', DED, NOT_YET, [['teardown.lb', 10 * SEC]])
    }
    expect(Object.keys(disk.stopped)).toHaveLength(20)
    expect(Object.keys(disk.stopped)).not.toContain('/p/resume-many-0')
    expect(Object.keys(disk.stopped)).toContain('/p/resume-many-20')
  })
})

describe('U12 止まった回を合わせる処理が落ちても、結果・鍵は変わらない', () => {
  it('★ settleStopped が投げても、結果は記録され、鍵は外れ、段の時間も載る（earlierRuns だけ付かない）', async () => {
    stuckDeletion(A)
    quitAndBoot(QUIT_AT, REBOOT_AT)
    vi.spyOn(stoppedOps, 'settleStopped').mockImplementation(() => { throw new Error('合わせられない') })
    const r = await runOp(A, '削除', DED, OK, [['teardown.cluster', 10 * SEC]])
    if (r.busy) throw new Error('busy')
    expect(stoppedOps.settleStopped).toHaveBeenCalled() // 空振りしない
    expect(r.stageTimings).toEqual({ totalMs: 10_000, stages: [{ stage: 'teardown.cluster', ms: 10_000 }] })
    expect(getOps(A).last!.result).toMatchObject({ ok: true, message: '消しました' })
    expect(runningOpName(A)).toBeUndefined()
    expect(disk.running).toEqual({})
  })
})
