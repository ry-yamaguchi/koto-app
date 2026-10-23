import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// E3 は本物の保存の部品（stageTimingStore）を一時フォルダに差して確かめる。electron の app は、userData を読んだら落ちる偽物。
vi.mock('electron', () => ({ app: { getPath: () => { throw new Error('利用者の保存領域（userData）を読もうとした') }, getVersion: () => '0.0.0-test' }, ipcMain: { handle: () => {} } }))

import {
  getOps, progressReporter, stageReporter, reportStage, reportProgress, setStageTimingSink, setProjectOpsListener, adoptStoppedOps,
  resetProjectOpsForTests, type StageTimingSinkEntry,
} from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import { initStageTimingStore, loadStageTimings, recordStageTimings, stageTimingFilePath } from '../src/main/stageTimingStore'
import { resumedCreateResult, resumedPublishResult } from '../src/renderer/apprunDedicatedActions'
import { resumedTeardownView } from '../src/shared/teardownResult'
import { readStageTimings, UNMEASURED } from '../src/shared/stageTiming'
import type { StoppedEntry } from '../src/shared/inFlightOps'

// ── 段ごとの所要時間の「記録」（projectOps・メモリ）（2026-10-07・どこにどれくらい時間がかかったか）───────────
// 進み具合の送り口（reportProgress / progressReporter）に任意の `stage`（段の内部名）を渡せる。ハンドラが段の切り替わりで渡すと、
// projectOps が段ごとの開始・終了の時刻をメモリに持ち、操作が終わったとき段ごとの所要時間と合計を結果の extra に載せる。
// **画面に出す文は変えない**。うまくいった操作だけ、段の所要時間を保存の口（sink）へ渡す。
// 本物の鍵（withProjectLock）を通し、時計（Date）だけを偽物にして固定する（実際には待たない）。

const A = '/p/stage-a'
const B = '/p/stage-b'
const META = { target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown' }
const T0 = Date.UTC(2026, 9, 7, 3, 0, 0)

beforeEach(() => {
  resetProjectOpsForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => { vi.useRealTimers(); resetProjectOpsForTests() })
const at = (ms: number) => vi.setSystemTime(T0 + ms)

/** sink に渡ったもの（うまくいった操作だけが来る）。 */
function captureSink(): StageTimingSinkEntry[] {
  const got: StageTimingSinkEntry[] = []
  setStageTimingSink(e => { got.push(e) })
  return got
}

describe('段ごとの開始・終了の時刻 → 結果の extra.stageTimings', () => {
  it('★ 偽のハンドラが stage を渡して進めると、段ごとの時間と合計が結果の extra に載る（その場の返り値にも同じ値）', async () => {
    const progress = progressReporter(A)
    const r = await withProjectLock(A, '削除', async () => {
      progress('アプリを削除しています…', { stage: 'teardown.app' })
      at(4_000)
      progress('ロードバランサの削除を待っています…', { stage: 'teardown.lb' })
      at(4_000 + 540_000)
      progress('クラスタの削除を待っています…', { stage: 'teardown.cluster' })
      at(4_000 + 540_000 + 20_000)
      return { ok: true, executed: ['クラスタを削除しました'] }
    }, META)
    expect(r.busy).toBe(false)
    const expected = {
      totalMs: 564_000,
      stages: [{ stage: 'teardown.app', ms: 4_000 }, { stage: 'teardown.lb', ms: 540_000 }, { stage: 'teardown.cluster', ms: 20_000 }],
    }
    const rec = getOps(A).last!
    expect(rec.result!.extra.stageTimings).toEqual(expected)
    if (!r.busy) expect(r.stageTimings).toEqual(expected) // その場の返り値と、記録（開き直したとき読む）が同じ値
  })

  it('★ 文だけの更新（stage なし）は、いまの段を続ける。stage を渡すと切り替わる', async () => {
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress('待っています（1分経過）…', { stage: 'teardown.lb' })
      at(30_000)
      progress('待っています（2分経過）…') // 段は渡さない＝まだ LB の段
      at(90_000)
      return { ok: true }
    }, META)
    const t = getOps(A).last!.result!.extra.stageTimings as any
    expect(t.stages).toEqual([{ stage: 'teardown.lb', ms: 90_000 }])
  })

  it('★ 同じ段に何度か戻っても足し合わせる（409 の回復で LB を待ち直す形）。並びは最初に入った順', async () => {
    const onStage = stageReporter(A)
    await withProjectLock(A, '削除', async () => {
      onStage('teardown.asg'); at(1_000)
      onStage('teardown.lb'); at(31_000)
      onStage('teardown.asg'); at(35_000)
      onStage('teardown.cluster'); at(40_000)
      return { ok: true }
    }, META)
    const t = getOps(A).last!.result!.extra.stageTimings as any
    expect(t.stages).toEqual([{ stage: 'teardown.asg', ms: 5_000 }, { stage: 'teardown.lb', ms: 30_000 }, { stage: 'teardown.cluster', ms: 5_000 }])
    expect(t.totalMs).toBe(40_000)
  })

  it('同じ段を続けて渡しても、区間は増えない・通知も出ない（切り替わったときだけ）', async () => {
    const pushed: number[] = []
    setProjectOpsListener(() => { pushed.push(1) })
    const onStage = stageReporter(A)
    await withProjectLock(A, '削除', async () => {
      onStage('teardown.lb')
      const n = pushed.length
      onStage('teardown.lb'); onStage('teardown.lb')
      expect(pushed.length).toBe(n)
      at(1_000)
      return { ok: true }
    }, META)
    expect((getOps(A).last!.result!.extra.stageTimings as any).stages).toEqual([{ stage: 'teardown.lb', ms: 1_000 }])
  })

  it('★★ 段だけの切り替わり（reportStage。文を出さない作成の ASG・LB の段）は、押し出しの受け手へ新しい段を知らせる（画面がその段の目安を出せる）', async () => {
    const seen: Array<string | undefined> = []
    setProjectOpsListener((_dir, snap) => { seen.push(snap.running?.progress.stage) })
    const onStage = stageReporter(A)
    await withProjectLock(A, '作成', async () => {
      onStage('create.cluster')
      onStage('create.asg')
      onStage('create.lb')
      return { ok: true }
    }, { ...META, handler: 'apprunDedicated:create' })
    // 始まり（段なし）→ 3回の切り替え（そのつど新しい段が見える）→ 終わり（走っていない）
    expect(seen).toEqual([undefined, 'create.cluster', 'create.asg', 'create.lb', undefined])
  })

  it('★ 段を1つも渡さなかった操作には、時間は載らない（これまでどおり）。保存もしない', async () => {
    const sunk = captureSink()
    const progress = progressReporter(A)
    const r = await withProjectLock(A, '公開', async () => { progress('公開しています…'); at(5_000); return { ok: true } }, META)
    expect(getOps(A).last!.result!.extra).not.toHaveProperty('stageTimings')
    if (!r.busy) expect(r.stageTimings).toBeUndefined()
    expect(sunk).toEqual([])
  })

  it('形の合わない段の名前は無視する（記録に変な文字列を入れない）', async () => {
    await withProjectLock(A, '削除', async () => {
      reportStage(A, '../etc/passwd'); reportStage(A, 'BAD NAME'); reportProgress(A, 'x', { stage: '' })
      at(1_000)
      return { ok: true }
    }, META)
    expect(getOps(A).last!.result!.extra).not.toHaveProperty('stageTimings')
  })

  it('走っていない（鍵を取っていない）ときの reportStage は何もしない。別のプロジェクトの記録を汚さない', async () => {
    reportStage(A, 'teardown.lb') // 走っていない
    expect(getOps(A).running).toBeNull()
    let release!: () => void
    const wait = new Promise<void>(r => { release = r })
    const pa = withProjectLock(A, '削除', async () => { await wait; return { ok: true } }, META)
    reportStage(B, 'teardown.asg') // B は走っていない
    reportStage(A, 'teardown.lb')
    at(2_000)
    release(); await pa
    expect(getOps(B).last).toBeNull()
    expect((getOps(A).last!.result!.extra.stageTimings as any).stages).toEqual([{ stage: 'teardown.lb', ms: 2_000 }])
  })

  it('別のプロジェクトの段・時間は混ざらない（掟11）', async () => {
    let releaseA!: () => void, releaseB!: () => void
    const waitA = new Promise<void>(r => { releaseA = r })
    const waitB = new Promise<void>(r => { releaseB = r })
    const pa = withProjectLock(A, '削除', async () => { await waitA; return { ok: true } }, META)
    reportStage(A, 'teardown.lb')
    at(1_000) // B は A より後に始まる（同じミリ秒に始まった記録は識別子のために +1ms 進めてあるので、時刻をずらして始める）
    const pb = withProjectLock(B, '公開', async () => { await waitB; return { ok: true } }, { target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:publishApp' })
    reportStage(B, 'publish.image')
    at(11_000)
    releaseA(); await pa
    at(26_000)
    releaseB(); await pb
    expect((getOps(A).last!.result!.extra.stageTimings as any).stages).toEqual([{ stage: 'teardown.lb', ms: 11_000 }])
    expect((getOps(B).last!.result!.extra.stageTimings as any).stages).toEqual([{ stage: 'publish.image', ms: 25_000 }])
  })
})

describe('画面に出す文は今までどおり（段は文とは別に渡す）', () => {
  it('★ progress の label・detail は渡した文のまま。stage-only（reportStage）は文を変えない。renderer へ送るのも文だけ', async () => {
    const sent: string[] = []
    const progress = progressReporter(A, m => sent.push(m))
    const onStage = stageReporter(A)
    let release!: () => void
    const wait = new Promise<void>(r => { release = r })
    const p = withProjectLock(A, '削除', async () => { await wait; return { ok: true } }, META)
    progress('ロードバランサの削除を待っています（1分経過）…', { stage: 'teardown.lb', detail: '補足' })
    expect(getOps(A).running!.progress).toMatchObject({ label: 'ロードバランサの削除を待っています（1分経過）…', detail: '補足', stage: 'teardown.lb' })
    onStage('teardown.asg') // 文は出さない段の切り替わり
    expect(getOps(A).running!.progress).toMatchObject({ label: 'ロードバランサの削除を待っています（1分経過）…', detail: '補足', stage: 'teardown.asg' })
    expect(sent).toEqual(['ロードバランサの削除を待っています（1分経過）…']) // 段の内部名は renderer へ送らない
    release(); await p
  })

  it('★ 走っている間の progress.stage が、いまの段（画面は文ではなくこれで「いま待っている段」を見分ける）', async () => {
    const progress = progressReporter(A)
    let release!: () => void
    const wait = new Promise<void>(r => { release = r })
    const p = withProjectLock(A, '公開', async () => { await wait; return { ok: true } }, META)
    expect(getOps(A).running!.progress.stage).toBeUndefined() // 段を渡すまでは無い
    progress('イメージをビルドしています…', { stage: 'publish.image' })
    expect(getOps(A).running!.progress.stage).toBe('publish.image')
    progress('ロードバランサの IP が付くのを待っています（10秒経過）…', { stage: 'publish.lb-address' })
    progress('ロードバランサの IP が付くのを待っています（20秒経過）…') // 段なし＝同じ段のまま
    expect(getOps(A).running!.progress.stage).toBe('publish.lb-address')
    release(); await p
  })
})

describe('保存の口（sink）: うまくいった操作の、終わった段の所要時間だけ', () => {
  it('★ ok:true の操作が終わると、段の所要時間・操作・公開先・IPC・終わった時刻・ゾーンが1回だけ渡る', async () => {
    const sunk = captureSink()
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress('…', { stage: 'teardown.app' }); at(3_000)
      progress('…', { stage: 'teardown.lb' }); at(13_000)
      return { ok: true }
    }, { ...META, zone: 'tk1b' })
    expect(sunk).toEqual([{
      op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown',
      finishedAt: T0 + 13_000, zone: 'tk1b',
      stages: [{ stage: 'teardown.app', ms: 3_000 }, { stage: 'teardown.lb', ms: 10_000 }],
    }])
  })

  it('★★ 失敗した操作は保存しない（ok:false の返り値）。時間は記録（画面の「かかった時間を見る」）には載る', async () => {
    const sunk = captureSink()
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => { progress('…', { stage: 'teardown.lb' }); at(8_000); return { ok: false, message: '失敗' } }, META)
    expect(sunk).toEqual([])
    expect((getOps(A).last!.result!.extra.stageTimings as any).stages).toEqual([{ stage: 'teardown.lb', ms: 8_000 }])
  })

  it('★★ 例外で終わった操作も保存しない。鍵は外れ、時間は記録に載る', async () => {
    const sunk = captureSink()
    const progress = progressReporter(A)
    await expect(withProjectLock(A, '公開', async () => { progress('…', { stage: 'publish.image' }); at(2_000); throw new Error('boom') }, META)).rejects.toThrow('boom')
    expect(sunk).toEqual([])
    expect(getOps(A).running).toBeNull()
    expect((getOps(A).last!.result!.extra.stageTimings as any).stages).toEqual([{ stage: 'publish.image', ms: 2_000 }])
  })

  it('HANAMII の公開が「受け付けたが新しい版が起動に失敗」（deployState:error）のときは、成功にしない（保存しない）', async () => {
    const sunk = captureSink()
    const progress = progressReporter(A)
    await withProjectLock(A, '公開', async () => { progress('…', { stage: 'publish.image' }); at(1_000); return { ok: true, deployState: 'error' } }, META)
    expect(sunk).toEqual([])
  })

  it('★ 保存の口が例外を投げても、操作の結果は変わらず、鍵も外れる', async () => {
    setStageTimingSink(() => { throw new Error('ディスクが一杯') })
    const progress = progressReporter(A)
    const r = await withProjectLock(A, '削除', async () => { progress('…', { stage: 'teardown.lb' }); at(1_000); return { ok: true } }, META)
    expect(r.busy).toBe(false)
    expect(getOps(A).running).toBeNull()
    expect(getOps(A).last!.result!.ok).toBe(true)
  })

  it('ゾーンは画面の記録（ProjectOpRecord）には入れない。無ければ null', async () => {
    const sunk = captureSink()
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => { progress('…', { stage: 'teardown.app' }); at(1_000); return { ok: true } }, { ...META, zone: 'tk1b' })
    expect(JSON.stringify(getOps(A))).not.toContain('tk1b')
    await withProjectLock(B, '削除', async () => { reportStage(B, 'teardown.app'); at(2_000); return { ok: true } }, META)
    expect(sunk[1].zone).toBeNull()
  })

  it('resetProjectOpsForTests は保存の口も外す（テスト同士で漏れない）', async () => {
    const sunk = captureSink()
    resetProjectOpsForTests()
    await withProjectLock(A, '削除', async () => { reportStage(A, 'teardown.app'); at(1_000); return { ok: true } }, META)
    expect(sunk).toEqual([])
  })

  it('返り値に stageTimings が入っていても、記録へは写さない（測ったものだけを載せる）', async () => {
    await withProjectLock(A, '削除', async () => ({ ok: true, stageTimings: { totalMs: 1, stages: [{ stage: 'x.y', ms: 1 }] } }), META)
    expect(getOps(A).last!.result!.extra).not.toHaveProperty('stageTimings')
  })
})

describe('★★ 保存の口（sink）: ok:true でも「測れていない」の印（unmeasured）が付いた段は渡さない（2026-10-07 検分）', () => {
  it('★ 印を付けた段だけが sink から外れ、ほかの段は渡る。時間そのものは結果と記録に載ったまま（かかった時間を見る）', async () => {
    const sunk = captureSink()
    const onStage = stageReporter(A)
    const r = await withProjectLock(A, '公開', async () => {
      onStage('publish.check'); at(2_000)
      onStage('publish.lb-address'); at(2_000 + 180_000)
      onStage('publish.lb-address', { unmeasured: true }) // IP が付かないまま待ち切った（同じ段のまま印だけ付く）
      onStage('publish.verify'); at(2_000 + 180_000 + 5_000)
      return { ok: true }
    }, { ...META, handler: 'apprunDedicated:publishApp' })
    expect(sunk).toHaveLength(1)
    expect(sunk[0].stages).toEqual([{ stage: 'publish.check', ms: 2_000 }, { stage: 'publish.verify', ms: 5_000 }])
    const timings = { totalMs: 187_000, stages: [{ stage: 'publish.check', ms: 2_000 }, { stage: 'publish.lb-address', ms: 180_000 }, { stage: 'publish.verify', ms: 5_000 }] }
    expect(getOps(A).last!.result!.extra.stageTimings).toEqual(timings)
    if (!r.busy) expect(r.stageTimings).toEqual(timings)
  })

  it('★ 全部の段に印が付いたら、sink は呼ばれない（空の記録を渡さない）', async () => {
    const sunk = captureSink()
    const onStage = stageReporter(A)
    await withProjectLock(A, '削除', async () => {
      onStage('teardown.lb', { unmeasured: true }); at(1_000)
      return { ok: true }
    }, META)
    expect(sunk).toEqual([])
    expect((getOps(A).last!.result!.extra.stageTimings as any).stages).toEqual([{ stage: 'teardown.lb', ms: 1_000 }]) // 時間は載る
  })

  it('★ 切り替えと印を1回で渡せる（段を切り替える呼び出しに印を添えると、新しい段に付く。前の段には付かない）', async () => {
    const sunk = captureSink()
    const onStage = stageReporter(A)
    await withProjectLock(A, '削除', async () => {
      onStage('teardown.asg'); at(1_000)
      onStage('teardown.lb', { unmeasured: true }); at(2_000) // 409 の回復: 残っていた LB の残りの待ち
      onStage('teardown.asg'); at(3_000)
      return { ok: true }
    }, META)
    expect(sunk[0].stages).toEqual([{ stage: 'teardown.asg', ms: 2_000 }]) // asg は 1000 + 1000、lb は外れる
  })

  it('印は段ごと・操作ごと。次の操作には持ち越さない（同じ段名でも、次の回に印が無ければ保存される）', async () => {
    const sunk = captureSink()
    const onStage = stageReporter(A)
    await withProjectLock(A, '削除', async () => { onStage('teardown.lb', { unmeasured: true }); at(1_000); return { ok: true } }, META)
    await withProjectLock(A, '削除', async () => { onStage('teardown.lb'); at(1_000 + 540_000); return { ok: true } }, META)
    expect(sunk).toHaveLength(1)
    expect(sunk[0].stages).toEqual([{ stage: 'teardown.lb', ms: 540_000 }])
  })

  it('印を付けても、失敗した操作は（もともと）保存しない。形の合わない段名への印は無視する', async () => {
    const sunk = captureSink()
    const onStage = stageReporter(A)
    await withProjectLock(A, '削除', async () => { onStage('teardown.lb', { unmeasured: true }); return { ok: false } }, META)
    at(100_000)
    await withProjectLock(A, '削除', async () => {
      onStage('Bad Name!', { unmeasured: true }) // 無視（段も作られない）
      onStage('teardown.lb'); at(100_500)
      return { ok: true }
    }, META)
    expect(sunk).toHaveLength(1)
    expect(sunk[0].stages).toEqual([{ stage: 'teardown.lb', ms: 500 }])
  })

  it('走っていない（鍵を取っていない）ときの印は何もしない。別のプロジェクトの操作に印が付かない（掟11）', async () => {
    const sunk = captureSink()
    const onStageB = stageReporter(B)
    const onStageA = stageReporter(A)
    await withProjectLock(A, '削除', async () => {
      onStageA('teardown.lb')
      onStageB('teardown.lb', { unmeasured: true }) // B は走っていない
      at(2_000)
      return { ok: true }
    }, META)
    expect(sunk[0].stages).toEqual([{ stage: 'teardown.lb', ms: 2_000 }])
  })
})

describe('双子: その場の結果と、開き直したときに記録から出す結果は、同じ「かかった時間」を持つ', () => {
  const run = async (handler: string, op: '作成' | '削除' | '公開', value: Record<string, unknown>) => {
    const progress = progressReporter(A)
    const r = await withProjectLock(A, op, async () => {
      progress('…', { stage: 'a.first' }); at(2_500)
      progress('…', { stage: 'a.second' }); at(2_500 + 61_000)
      return value
    }, { target: 'sakura-apprun-dedicated', handler })
    return { inPlace: r.busy ? undefined : r.stageTimings, record: getOps(A).last! }
  }

  it('★ 手順5（作成）', async () => {
    const { inPlace, record } = await run('apprunDedicated:create', '作成', { ok: true, stage: 'done', message: '作成できました。', clusterID: 'c', asgID: 'a', loadBalancerID: 'l' })
    expect(inPlace).toBeTruthy()
    expect(resumedCreateResult(record).stageTimings).toEqual(inPlace)
  })

  it('★ 手順6（削除）', async () => {
    const { inPlace, record } = await run('apprunDedicated:teardown', '削除', { ok: true, executed: ['x'], message: 'ok', remaining: {} })
    expect(resumedTeardownView('sakura-apprun-dedicated', record.result).stageTimings).toEqual(inPlace)
  })

  it('★ 手順8（公開）', async () => {
    const { inPlace, record } = await run('apprunDedicated:publishApp', '公開', { ok: true, stage: 'done', message: '公開しました', url: 'https://x/' })
    expect(resumedPublishResult(record).stageTimings).toEqual(inPlace)
  })

  it('★ 失敗した結果でも、記録から出す結果は同じ時間を持つ', async () => {
    const { inPlace, record } = await run('apprunDedicated:teardown', '削除', { ok: false, executed: [], message: '失敗', remaining: { clusterID: 'c' } })
    expect(inPlace).toBeTruthy()
    expect(resumedTeardownView('sakura-apprun-dedicated', record.result).stageTimings).toEqual(inPlace)
  })

  it('記録の時間が壊れていても、結果は出る（時間だけ出さない）', async () => {
    const { record } = await run('apprunDedicated:teardown', '削除', { ok: true, executed: [], message: 'ok', remaining: {} })
    const broken = JSON.parse(JSON.stringify(record))
    broken.result.extra.stageTimings = { totalMs: 'x', stages: 'x' }
    expect(resumedTeardownView('sakura-apprun-dedicated', broken.result).stageTimings).toBeNull()
    expect(resumedTeardownView('sakura-apprun-dedicated', broken.result).ok).toBe(true)
  })

  it('読み戻した値は、画面が使う読み取り（readStageTimings）を通った形', async () => {
    const { record } = await run('apprunDedicated:teardown', '削除', { ok: true, executed: [], message: 'ok', remaining: {} })
    expect(readStageTimings(record.result!.extra.stageTimings)).toEqual({ totalMs: 63_500, stages: [{ stage: 'a.first', ms: 2_500 }, { stage: 'a.second', ms: 61_000 }] })
  })
})

// ── 目安に入れない（設計書 10.13.7・判断 K）──────────────────────────────────────────────────
// 止まった回の時間は結果（かかった時間を見る）に出すが、所要時間の目安（stage-timings.json）には入れない。止まった回を合わせた回
// （earlierRuns が付いた回）は、今回の段も含めて何も渡さない: 続きの回は、印の付かない段（アプリの削除の「コンテナがもう止まっていた」・
// 保存場所の削除の「中身が途中まで消えていた」）が短い時間のままで目安に入り、狂わせうるため。
describe('E 止まった回を合わせた回は、所要時間の目安に何も入れない', () => {
  const NOW = T0 + 30 * 60_000
  const stopped = (): Record<string, StoppedEntry> => ({
    [A]: {
      op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', noticeSeen: true,
      runs: [{
        op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', version: '0.6.22', endedBy: 'quit',
        startedAt: T0, lastSeenAt: T0 + 400_000,
        segments: [{ stage: 'teardown.app', startedAt: T0, endedAt: T0 + 60_000 }, { stage: 'teardown.lb', startedAt: T0 + 60_000 }],
      }],
    },
  })
  const run = async (stages: [string, number][], result: unknown = { ok: true }, mark?: { unmeasured?: boolean }) => {
    const progress = progressReporter(A)
    return withProjectLock(A, '削除', async () => {
      for (const [stage, ms] of stages) { progress('…', { stage }); if (mark && stage === 'teardown.lb') reportStage(A, stage, mark); vi.setSystemTime(Date.now() + ms) }
      return result
    }, META)
  }
  beforeEach(() => { vi.setSystemTime(NOW); adoptStoppedOps(stopped(), NOW) })

  it('★ E1 earlierRuns が付いた回でも、今回の段（timings.stages）に止まった回の段は混ざらない', async () => {
    const r = await run([['teardown.cluster', 10_000]])
    if (r.busy) throw new Error('busy')
    expect(r.stageTimings!.stages).toEqual([{ stage: 'teardown.cluster', ms: 10_000 }])
    expect(r.stageTimings!.totalMs).toBe(10_000)
    expect(r.stageTimings!.earlierRuns!.map(x => x.stages.map(y => y.stage))).toEqual([['teardown.app', 'teardown.lb']]) // 止まった回の段は earlierRuns の中だけ
    expect(getOps(A).last!.result!.extra.stageTimings).toEqual(r.stageTimings)
  })

  it('★ E4 earlierRuns が付いた回は sink を呼ばない（ok:true・印の付かない段だけの回でも）。付かない回は今までどおり丸ごと渡る', async () => {
    const sunk = captureSink()
    const first = await run([['teardown.cluster', 10_000]])
    if (first.busy) throw new Error('busy')
    expect(first.stageTimings!.earlierRuns).toHaveLength(1)
    expect(sunk).toEqual([]) // 続きの回: 何も渡さない
    // 止まった回を合わせたので消えている。次の回は付かず、今までどおり渡る。
    const second = await run([['teardown.cluster', 10_000]])
    if (second.busy) throw new Error('busy')
    expect('earlierRuns' in second.stageTimings!).toBe(false)
    expect(sunk).toEqual([{
      op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', finishedAt: Date.now(), zone: null,
      stages: [{ stage: 'teardown.cluster', ms: 10_000 }],
    }])
  })

  it('★ E2 今回の UNMEASURED の段は、earlierRuns があっても渡らない（印の付かない段も、付いた段も）。印だけの回でも同じ', async () => {
    const sunk = captureSink()
    const r = await run([['teardown.lb', 5_000], ['teardown.cluster', 10_000]], { ok: true }, UNMEASURED)
    if (r.busy) throw new Error('busy')
    expect(r.stageTimings!.earlierRuns).toHaveLength(1)
    expect(sunk).toEqual([])
    // 付かない回では、印の付いた段だけが外れ、ほかの段は渡る（E4 の対照。この検査が空振りでないことを示す）
    const again = await run([['teardown.lb', 5_000], ['teardown.cluster', 10_000]], { ok: true }, UNMEASURED)
    if (again.busy) throw new Error('busy')
    expect(sunk).toHaveLength(1)
    expect(sunk[0].stages).toEqual([{ stage: 'teardown.cluster', ms: 10_000 }])
  })

  it('★ E3 止まった回の段は stage-timings.json（本物の保存の部品・一時フォルダ）に1行も入らない。続きの回の段も入らない', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-stage-timing-resume-'))
    initStageTimingStore(dir)
    try {
      setStageTimingSink(entry => {
        recordStageTimings({ at: new Date(entry.finishedAt).toISOString(), version: 'test', zone: entry.zone, stages: entry.stages })
      })
      const first = await run([['teardown.cluster', 10_000]])
      if (first.busy) throw new Error('busy')
      expect(first.stageTimings!.earlierRuns).toHaveLength(1)
      expect(fs.existsSync(stageTimingFilePath())).toBe(false) // 続きの回: 何も書かれない
      const second = await run([['teardown.asg', 20_000]]) // 付かない回: 書かれる
      if (second.busy) throw new Error('busy')
      expect(Object.keys(loadStageTimings().stages)).toEqual(['teardown.asg'])
      expect(fs.readFileSync(stageTimingFilePath(), 'utf-8')).not.toMatch(/teardown\.(app|lb|cluster)/) // 止まった回の段も、続きの回の段も入っていない
    } finally {
      initStageTimingStore(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
