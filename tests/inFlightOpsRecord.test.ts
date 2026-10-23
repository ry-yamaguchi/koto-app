import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getOps, progressReporter, stageReporter, setInFlightSink, flushInFlightOps, runningOpName, listRunningOps,
  resetProjectOpsForTests,
} from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import { IN_FLIGHT_PROGRESS_INTERVAL_MS, isInFlightDirty, isInFlightSinkConnected } from '../src/main/inFlightOutlet'
import { sanitizeInFlightFile, MAX_SEGMENTS, type InFlightFile } from '../src/shared/inFlightOps'

// ── 途中で止まった回の記録（projectOps・書く口）（設計書 10.13.4・10.13.12 の R1〜R10）──────────────────────────
// projectOps は自分のメモリ（走っている操作の段の時刻）から、**ファイルの中身を丸ごと**組み立てて「口」へ渡す。
// ファイルに触るのは口の先（inFlightOpsStore.ts。S1〜S6 は tests/inFlightOpsStore.test.ts）。ここは本物の鍵（withProjectLock）と
// 偽の口を使い、時計は `Date` だけを偽物にして固定する（実際には待たない）。間引きの時計は `monotonicNow` を差し替える。

const A = '/p/inflight-a'
const B = '/p/inflight-b'
const META = { target: 'sakura-apprun-dedicated' as const, handler: 'apprunDedicated:teardown' }
const T0 = Date.UTC(2026, 9, 12, 3, 0, 0)
const SEC = 1000

beforeEach(() => {
  resetProjectOpsForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  mono = 0
})
afterEach(() => { vi.useRealTimers(); resetProjectOpsForTests() })

/** 単調な時計（間引き用）。Date とは別に進める。 */
let mono = 0
const at = (ms: number) => vi.setSystemTime(T0 + ms)

type Mode = 'ok' | 'false' | 'throw'
/**
 * 偽の口をつなぐ。`attempts` は口に渡ったもの全部（書けなかった回も）、`disk()` は最後に「書けた」中身（ファイルに残っているもの）。
 * 渡された中身は JSON で写し取る（あとから projectOps のメモリが変わっても、渡した時点の中身で比べる）。
 */
function connect(opts: { version?: string } = {}) {
  const attempts: InFlightFile[] = []
  const state = { mode: 'ok' as Mode, disk: null as InFlightFile | null }
  setInFlightSink(file => {
    attempts.push(JSON.parse(JSON.stringify(file)) as InFlightFile)
    if (state.mode === 'throw') throw new Error('ディスクが一杯')
    if (state.mode === 'false') return false
    state.disk = JSON.parse(JSON.stringify(file)) as InFlightFile
    return true
  }, { ...opts, monotonicNow: () => mono })
  return { attempts, state }
}

/** 外から開けるまで止まっている処理（「走っている最中」を作る）。 */
function gate<T>(value: T) {
  let open!: () => void
  const closed = new Promise<void>(r => { open = r })
  return { open, wait: async () => { await closed; return value } }
}

describe('R1 始まり・段の切り替え・終わりで、口に渡るファイルの running が変わる。終われば消える', () => {
  it('★ 始まり → 段A → 段B → 終わり: 口に渡るたびの中身を書き下して比べる', async () => {
    const s = connect({ version: '0.6.22' })
    const progress = progressReporter(A)
    const run = { op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', version: '0.6.22', startedAt: T0 }
    await withProjectLock(A, '削除', async () => {
      expect(s.attempts).toHaveLength(1)
      expect(s.attempts[0]).toEqual({ v: 1, running: { [A]: { ...run, lastSeenAt: T0, segments: [] } }, stopped: {} })

      progress('アプリを削除しています…', { stage: 'teardown.app' })
      expect(s.attempts).toHaveLength(2)
      expect(s.attempts[1].running[A]).toEqual({ ...run, lastSeenAt: T0, segments: [{ stage: 'teardown.app', startedAt: T0 }] })

      at(4 * SEC)
      progress('ロードバランサの削除を待っています…', { stage: 'teardown.lb' })
      expect(s.attempts).toHaveLength(3)
      expect(s.attempts[2].running[A]).toEqual({
        ...run, lastSeenAt: T0 + 4 * SEC,
        segments: [{ stage: 'teardown.app', startedAt: T0, endedAt: T0 + 4 * SEC }, { stage: 'teardown.lb', startedAt: T0 + 4 * SEC }],
      })
      at(10 * SEC)
      return { ok: true }
    }, META)
    expect(s.attempts).toHaveLength(4)
    expect(s.attempts[3]).toEqual({ v: 1, running: {}, stopped: {} })
    expect(s.state.disk).toEqual({ v: 1, running: {}, stopped: {} })
  })

  it('★ 失敗した回・例外で終わった回も、running から消える（例外はそのまま投げ直す）', async () => {
    const s = connect()
    await withProjectLock(A, '削除', async () => ({ ok: false, message: '失敗' }), META)
    expect(s.state.disk!.running).toEqual({})
    await expect(withProjectLock(A, '削除', async () => { throw new Error('boom') }, META)).rejects.toThrow('boom')
    expect(s.state.disk!.running).toEqual({})
    expect(s.attempts.at(-1)!.running).toEqual({})
  })

  it('★ 口に渡る中身は、いつも決まった形に整っている（整える関数を通しても変わらない）', async () => {
    const s = connect({ version: '0.6.22' })
    const onStage = stageReporter(A)
    await withProjectLock(A, '削除', async () => {
      onStage('teardown.app'); at(SEC); onStage('teardown.lb'); at(2 * SEC); onStage('teardown.app'); at(3 * SEC)
      return { ok: true }
    }, META)
    expect(s.attempts.length).toBeGreaterThanOrEqual(5)
    for (const f of s.attempts) expect(sanitizeInFlightFile(f)).toEqual(f)
  })

  it('同じフォルダを指す別の書き方（末尾の / ・..）は同じ鍵。走っている間、鍵は正規化した形で入る', async () => {
    const s = connect()
    const g = gate({ ok: true })
    const p = withProjectLock('/p/./x/../inflight-a/', '削除', g.wait, META)
    expect(Object.keys(s.attempts[0].running)).toEqual([A])
    g.open(); await p
  })

  it('Koto の版は、口をつないだときに渡したものが回に写る。渡さなければ空', async () => {
    const withVersion = connect({ version: '0.6.22-rc.1' })
    await withProjectLock(A, '削除', async () => ({ ok: true }), META)
    expect(withVersion.attempts[0].running[A].version).toBe('0.6.22-rc.1')
    resetProjectOpsForTests()
    const without = connect()
    await withProjectLock(A, '削除', async () => ({ ok: true }), META)
    expect(without.attempts[0].running[A].version).toBe('')
  })

  it('公開先・種類・ハンドラ名は回に写る。鍵を取るとき meta を渡さなければ unknown・空', async () => {
    const s = connect()
    const g = gate({ ok: true })
    const p = withProjectLock(A, '公開', g.wait, { target: 'vercel', handler: 'vercel:publish' })
    expect(s.attempts.at(-1)!.running[A]).toMatchObject({ op: '公開', target: 'vercel', handler: 'vercel:publish' })
    g.open(); await p
    const g2 = gate({ ok: true })
    const p2 = withProjectLock(B, '作成', g2.wait, undefined as any)
    expect(s.attempts.at(-1)!.running[B]).toMatchObject({ op: '作成', target: 'unknown', handler: '' })
    g2.open(); await p2
  })

  it('段の内部名の形に合わないものは区間に入らない。区間は50までで、新しいほうを残す', async () => {
    const s = connect()
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress('x', { stage: 'Bad Stage!' })
      expect(s.attempts.at(-1)!.running[A].segments).toEqual([])
      for (let i = 0; i < MAX_SEGMENTS + 7; i++) { at(i * SEC); progress('x', { stage: i % 2 ? 'teardown.lb' : 'teardown.asg' }) }
      const segs = s.attempts.at(-1)!.running[A].segments
      expect(segs).toHaveLength(MAX_SEGMENTS)
      expect(segs.at(-1)).toEqual({ stage: (MAX_SEGMENTS + 6) % 2 ? 'teardown.lb' : 'teardown.asg', startedAt: T0 + (MAX_SEGMENTS + 6) * SEC })
      return { ok: true }
    }, META)
  })
})

describe('R2 進み具合だけのときは30秒に1回まで。段が変われば30秒を待たない', () => {
  it('★ 29秒では書かない・30秒で書く（間引きの時計で測る）', async () => {
    const s = connect()
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      expect(IN_FLIGHT_PROGRESS_INTERVAL_MS).toBe(30_000)
      progress('待っています（1回目）', { stage: 'teardown.lb' })
      const base = s.attempts.length // 始まり＋段の切り替え
      expect(base).toBe(2)
      mono = 29 * SEC; at(29 * SEC)
      progress('待っています（29秒）')
      expect(s.attempts).toHaveLength(base)
      mono = 30 * SEC; at(30 * SEC)
      progress('待っています（30秒）')
      expect(s.attempts).toHaveLength(base + 1)
      expect(s.attempts.at(-1)!.running[A].lastSeenAt).toBe(T0 + 30 * SEC) // 書かなかった間の更新も、次に書くときに入る
      mono = 59 * SEC; at(59 * SEC)
      progress('待っています（59秒）')
      expect(s.attempts).toHaveLength(base + 1)
      mono = 60 * SEC; at(60 * SEC)
      progress('待っています（60秒）')
      expect(s.attempts).toHaveLength(base + 2)
      return { ok: true }
    }, META)
  })

  it('★ 段が変われば30秒を待たない。同じ段のまま stage を渡し直しても、進み具合だけの扱い', async () => {
    const s = connect()
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress('LB', { stage: 'teardown.lb' })
      const n = s.attempts.length
      mono = 1 * SEC; at(SEC)
      progress('LB（同じ段）', { stage: 'teardown.lb' })
      expect(s.attempts).toHaveLength(n)
      mono = 2 * SEC; at(2 * SEC)
      progress('ASG', { stage: 'teardown.asg' })
      expect(s.attempts).toHaveLength(n + 1)
      expect(s.attempts.at(-1)!.running[A].segments.map(x => x.stage)).toEqual(['teardown.lb', 'teardown.asg'])
      mono = 3 * SEC; at(3 * SEC)
      stageReporter(A)('teardown.cluster') // 文を出さない段の切り替えも、待たない
      expect(s.attempts).toHaveLength(n + 2)
      stageReporter(A)('teardown.cluster') // 同じ段のままなら何もしない
      expect(s.attempts).toHaveLength(n + 2)
      return { ok: true }
    }, META)
  })

  it('段を持たないハンドラ（共用型・HANAMII・Vercel）の進み具合も、30秒に1回まで。lastSeenAt は進む', async () => {
    const s = connect()
    const progress = progressReporter(A)
    await withProjectLock(A, '公開', async () => {
      expect(s.attempts).toHaveLength(1)
      mono = 5 * SEC; at(5 * SEC)
      progress('アップロード中… (1/5)', { step: 1, total: 5 })
      expect(s.attempts).toHaveLength(1)
      mono = 31 * SEC; at(31 * SEC)
      progress('アップロード中… (2/5)', { step: 2, total: 5 })
      expect(s.attempts).toHaveLength(2)
      expect(s.attempts[1].running[A]).toMatchObject({ lastSeenAt: T0 + 31 * SEC, segments: [] })
      return { ok: true }
    }, META)
  })
})

describe('R2b 間引きの時計の既定は performance.now()（monotonicNow を渡さない本番の形）', () => {
  it('★ 続けて来た進み具合だけの更新は間引かれ、段の切り替わりは書かれる（Date を何度動かしても、間引きは変わらない）', async () => {
    const attempts: InFlightFile[] = []
    setInFlightSink(f => { attempts.push(JSON.parse(JSON.stringify(f))); return true }) // opts なし
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress('x', { stage: 'teardown.lb' })
      const n = attempts.length
      expect(n).toBe(2)
      for (let i = 1; i <= 5; i++) { at(i * 60 * SEC); progress(`待っています（${i}分）`) } // Date は5分進むが、実時間はほぼ0
      expect(attempts).toHaveLength(n)
      progress('次の段', { stage: 'teardown.cluster' })
      expect(attempts).toHaveLength(n + 1)
      expect(attempts.at(-1)!.running[A].lastSeenAt).toBe(T0 + 5 * 60 * SEC) // 書かなかった間の更新も、次に書くときに入る
      return { ok: true }
    }, META)
  })
})

describe('R3 口が例外を投げても（false を返しても）、操作の値・結果・鍵は変わらない', () => {
  it.each<Mode>(['throw', 'false'])('★ 口が %s: 値・結果・鍵（runningOpName）・listRunningOps・段の時間は書けるときと同じ', async (mode) => {
    const s = connect()
    s.state.mode = mode
    const progress = progressReporter(A)
    const r = await withProjectLock(A, '削除', async () => {
      progress('アプリを削除しています…', { stage: 'teardown.app' })
      at(4 * SEC)
      progress('ロードバランサを待っています…', { stage: 'teardown.lb' })
      expect(runningOpName(A)).toBe('削除')
      expect(listRunningOps()).toEqual([{ projectDir: A, op: '削除', target: 'sakura-apprun-dedicated' }])
      expect(getOps(A).running!.progress.stage).toBe('teardown.lb')
      at(10 * SEC)
      return { ok: true, message: '消しました' }
    }, META)
    expect(s.attempts.length).toBeGreaterThanOrEqual(4) // 口は呼ばれている（検査が空振りしない）
    const expected = { totalMs: 10 * SEC, stages: [{ stage: 'teardown.app', ms: 4 * SEC }, { stage: 'teardown.lb', ms: 6 * SEC }] }
    expect(r).toEqual({ busy: false, value: { ok: true, message: '消しました' }, stageTimings: expected })
    expect(getOps(A).last!.result).toMatchObject({ ok: true, message: '消しました' })
    expect(getOps(A).last!.result!.extra.stageTimings).toEqual(expected)
    // 鍵は外れている: 同じプロジェクトでもう一度始められる
    expect(runningOpName(A)).toBeUndefined()
    expect(listRunningOps()).toEqual([])
    const again = await withProjectLock(A, '削除', async () => ({ ok: true }), META)
    expect(again.busy).toBe(false)
  })

  it('口が途中から壊れても（書けた → 投げる）、走っている操作は続く。直れば書き直す', async () => {
    const s = connect()
    const progress = progressReporter(A)
    const g = gate({ ok: true })
    const p = withProjectLock(A, '削除', async () => { progress('x', { stage: 'teardown.app' }); return g.wait() }, META)
    expect(s.state.disk!.running[A].segments).toHaveLength(1)
    s.state.mode = 'throw'
    mono = 1 * SEC; at(SEC)
    expect(() => progress('y', { stage: 'teardown.lb' })).not.toThrow()
    expect(getOps(A).running!.progress.stage).toBe('teardown.lb')
    s.state.mode = 'ok'
    mono = 2 * SEC; at(2 * SEC)
    progress('y2', { stage: 'teardown.cluster' })
    expect(s.state.disk!.running[A].segments.map(x => x.stage)).toEqual(['teardown.app', 'teardown.lb', 'teardown.cluster'])
    g.open(); await p
  })
})

describe('R4 口をつなぐ前は一度も呼ばれない', () => {
  it('★ つなぐ前の操作は誰にも渡らない。つないだだけでは書かない。外したあとも呼ばれない', async () => {
    expect(isInFlightSinkConnected()).toBe(false)
    await withProjectLock(A, '削除', async () => ({ ok: true }), META) // 口なし: 何も起きない・落ちない
    flushInFlightOps(T0) // 口なしの flush も何もしない
    expect(isInFlightDirty()).toBe(false) // 口が無いことは「書けなかった」ではない
    const fn = vi.fn((_f: InFlightFile) => true)
    setInFlightSink(fn, { monotonicNow: () => mono })
    expect(fn).not.toHaveBeenCalled() // つないだだけでは書かない
    await withProjectLock(B, '削除', async () => ({ ok: true }), META)
    expect(fn).toHaveBeenCalled()
    expect(JSON.stringify(fn.mock.calls)).not.toContain(A) // つなぐ前に終わった回は、どの中身にも出てこない
    const n = fn.mock.calls.length
    setInFlightSink(null)
    await withProjectLock(B, '削除', async () => ({ ok: true }), META)
    flushInFlightOps(T0 + SEC)
    expect(fn.mock.calls.length).toBe(n)
  })

  it('テスト用の初期化（resetProjectOpsForTests）で口が外れ、書いた時刻・印・版も初めに戻る', async () => {
    const s = connect({ version: '0.6.22' })
    s.state.mode = 'false'
    await withProjectLock(A, '削除', async () => ({ ok: true }), META) // 書けなかった印が立つ
    resetProjectOpsForTests()
    const n = s.attempts.length
    await withProjectLock(A, '削除', async () => ({ ok: true }), META)
    flushInFlightOps(T0 + SEC)
    expect(s.attempts).toHaveLength(n) // 外れている
    const s2 = connect() // 版を渡さずにつなぎ直す
    flushInFlightOps(T0 + SEC) // 前の「書けなかった」の印は引き継がれない
    expect(s2.attempts).toHaveLength(0)
    await withProjectLock(A, '削除', async () => ({ ok: true }), META)
    expect(s2.attempts[0].running[A].version).toBe('') // 前の版は引き継がれない
  })

  it('鍵の形に合わないもの（空の projectDir）は、口に渡る中身に入れない', async () => {
    const s = connect()
    const g = gate({ ok: true })
    const p = withProjectLock('', '削除', g.wait, META)
    expect(s.attempts.length).toBeGreaterThan(0)
    for (const f of s.attempts) expect(f.running).toEqual({})
    g.open(); await p
  })

  it('つなぐ前に始まっていた回は、つないだあとの最初の書き込みで入る', async () => {
    const g = gate({ ok: true })
    const p = withProjectLock(A, '削除', g.wait, META)
    const s = connect()
    expect(s.attempts).toHaveLength(0)
    at(SEC)
    stageReporter(A)('teardown.app')
    expect(Object.keys(s.attempts[0].running)).toEqual([A])
    g.open(); await p
  })
})

describe('R5 秘密・文が入らない', () => {
  const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const URL_WITH_CRED = 'https://user:pass@registry.example.com/img'
  const RES_ID = '110000000123'

  it('★ 渡した秘密・進み具合の文・資格情報つきの URL・資源の ID・ゾーンを、口に渡った中身の全体から探して0件', async () => {
    const s = connect({ version: '0.6.22' })
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress(`トークン ${TOKEN} で ${URL_WITH_CRED} を削除しています（ID ${RES_ID}）`, { stage: 'teardown.app', detail: `${TOKEN} ${RES_ID}`, step: 1, total: 4 })
      at(5 * SEC); mono = 40 * SEC
      progress(`ロードバランサ ${RES_ID} の削除を待っています`, { stage: 'teardown.lb', detail: URL_WITH_CRED })
      at(9 * SEC)
      return { ok: false, message: `失敗しました ${TOKEN}`, url: URL_WITH_CRED, loadBalancerID: RES_ID, clusterID: RES_ID, lines: [`削除 ${RES_ID}`] }
    }, { ...META, secrets: [TOKEN], zone: 'is1a' })
    const all = JSON.stringify(s.attempts)
    expect(s.attempts.length).toBeGreaterThanOrEqual(4)
    for (const leaked of [TOKEN, 'ghp_', 'user:pass', 'registry.example.com', RES_ID, 'トークン', '削除しています', '待っています', '失敗しました', 'is1a', 'zone', 'label', 'detail', 'message']) {
      expect(all, `口に渡った中身に「${leaked}」がある`).not.toContain(leaked)
    }
  })

  it('★ キーは決まった名前だけ（書き下す）: ファイル・run・区間', async () => {
    const s = connect({ version: '0.6.22' })
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress('x', { stage: 'teardown.app' }); at(SEC); progress('y', { stage: 'teardown.lb' })
      return { ok: true }
    }, { ...META, secrets: [TOKEN] })
    const last = s.attempts.find(f => (f.running[A]?.segments.length ?? 0) === 2)!
    expect(Object.keys(last).sort()).toEqual(['running', 'stopped', 'v'])
    expect(Object.keys(last.running[A]).sort()).toEqual(['handler', 'lastSeenAt', 'op', 'segments', 'startedAt', 'target', 'version'])
    expect(last.running[A].segments.map(x => Object.keys(x).sort())).toEqual([['endedAt', 'stage', 'startedAt'], ['stage', 'startedAt']])
  })
})

describe('R5b 待ち切れて止まった回（unfinished）も、秘密・文を口に渡さない', () => {
  const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const URL_WITH_CRED = 'https://user:pass@registry.example.com/img'
  const RES_ID = '110000000123'

  // ファイルがきれいなのは、書く前の整え（sanitizeInFlightFile）だけの手柄にしない。口に渡る中身そのもの（整える前）を見る。
  it('★ ok:false・inProgress で終わる回のあと、口に渡った stopped の run は決まった名前のキーだけ。秘密・文・URL・資源の ID・ゾーンを全体から探して0件', async () => {
    const s = connect({ version: '0.6.22' })
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress(`トークン ${TOKEN} で ${URL_WITH_CRED} を削除しています（ID ${RES_ID}）`, { stage: 'teardown.app', detail: `${TOKEN} ${RES_ID}`, step: 1, total: 4 })
      at(5 * SEC); mono = 40 * SEC
      progress(`ロードバランサ ${RES_ID} の削除を待っています`, { stage: 'teardown.lb', detail: URL_WITH_CRED })
      at(9 * SEC)
      return {
        ok: false, message: `まだ削除中です ${TOKEN}`, url: URL_WITH_CRED, lines: [`削除 ${RES_ID}`],
        inProgress: { loadBalancerID: RES_ID },
      }
    }, { ...META, secrets: [TOKEN], zone: 'is1a' })
    // 前提: 待ち切れた回として止まった回に入った（空振りの試験にしない）
    const withStopped = s.attempts.filter(f => f.stopped[A] !== undefined)
    expect(withStopped.length).toBeGreaterThan(0)
    const run = withStopped.at(-1)!.stopped[A].runs[0]
    expect(run.endedBy).toBe('unfinished')
    // キーは決まった名前だけ（書き下す）: run・区間・項目
    expect(Object.keys(run).sort()).toEqual(['endedBy', 'handler', 'lastSeenAt', 'op', 'segments', 'startedAt', 'target', 'version'])
    expect(run.segments.map(x => Object.keys(x).sort())).toEqual([['endedAt', 'stage', 'startedAt'], ['endedAt', 'stage', 'startedAt']])
    expect(Object.keys(withStopped.at(-1)!.stopped[A]).sort()).toEqual(['handler', 'noticeSeen', 'op', 'runs', 'target'])
    // 中身そのもの: 決まった語と数と段の内部名だけ
    expect(run).toEqual({
      op: '削除', target: 'sakura-apprun-dedicated', handler: 'apprunDedicated:teardown', version: '0.6.22',
      startedAt: T0, lastSeenAt: T0 + 9 * SEC, endedBy: 'unfinished',
      segments: [{ stage: 'teardown.app', startedAt: T0, endedAt: T0 + 5 * SEC }, { stage: 'teardown.lb', startedAt: T0 + 5 * SEC, endedAt: T0 + 9 * SEC }],
    })
    const all = JSON.stringify(s.attempts)
    for (const leaked of [TOKEN, 'ghp_', 'user:pass', 'registry.example.com', RES_ID, 'トークン', '削除しています', '待っています', 'まだ削除中', 'is1a', 'zone', 'label', 'detail', 'message', 'inProgress']) {
      expect(all, `口に渡った中身に「${leaked}」がある`).not.toContain(leaked)
    }
  })
})

describe('R6 掟11: 2つのプロジェクトが同時に走っても、互いの running を消さない・混ぜない', () => {
  it('★ A と B を同時に走らせる: 段の切り替えも終わりも、相手の running を変えない', async () => {
    const s = connect({ version: '0.6.22' })
    const ga = gate({ ok: true })
    const gb = gate({ ok: true })
    const pa = withProjectLock(A, '削除', ga.wait, META)
    at(2 * SEC)
    const pb = withProjectLock(B, '公開', gb.wait, { target: 'vercel', handler: 'vercel:publish' })
    expect(Object.keys(s.attempts.at(-1)!.running).sort()).toEqual([A, B])
    const bStarted = s.attempts.at(-1)!.running[B].startedAt

    at(3 * SEC)
    stageReporter(A)('teardown.app')
    let now = s.attempts.at(-1)!.running
    expect(now[A].segments).toEqual([{ stage: 'teardown.app', startedAt: T0 + 3 * SEC }])
    expect(now[B]).toMatchObject({ op: '公開', target: 'vercel', handler: 'vercel:publish', startedAt: bStarted, segments: [] })

    at(4 * SEC); mono = 40 * SEC
    stageReporter(B)('publish.build')
    now = s.attempts.at(-1)!.running
    expect(now[A].segments).toEqual([{ stage: 'teardown.app', startedAt: T0 + 3 * SEC }]) // A の区間に B の段が混ざらない
    expect(now[B].segments).toEqual([{ stage: 'publish.build', startedAt: T0 + 4 * SEC }])

    ga.open(); await pa
    now = s.attempts.at(-1)!.running
    expect(Object.keys(now)).toEqual([B])
    expect(now[B].segments).toEqual([{ stage: 'publish.build', startedAt: T0 + 4 * SEC }])
    expect(runningOpName(B)).toBe('公開')

    gb.open(); await pb
    expect(s.attempts.at(-1)!.running).toEqual({})
  })

  it('別のプロジェクトの書き込みで、相手の最後に分かった時刻が止まることはない（ファイルは丸ごと書き直される）', async () => {
    const s = connect()
    const ga = gate({ ok: true })
    const gb = gate({ ok: true })
    const pa = withProjectLock(A, '削除', ga.wait, META)
    const pb = withProjectLock(B, '削除', gb.wait, META)
    mono = 40 * SEC; at(40 * SEC)
    progressReporter(A)('A', { stage: 'teardown.app' })
    expect(s.attempts.at(-1)!.running[A].lastSeenAt).toBe(T0 + 40 * SEC)
    expect(s.attempts.at(-1)!.running[B].lastSeenAt).toBe(s.attempts.at(-1)!.running[B].startedAt) // B は進み具合が来ていないので、始まりのまま
    ga.open(); gb.open(); await pa; await pb
  })
})

describe('R7 will-quit の書き切り（flushInFlightOps(now)）', () => {
  it('★ 走っているものの lastSeenAt が now になる（全部・1回）。間引きの30秒を待たない', async () => {
    const s = connect()
    const ga = gate({ ok: true })
    const gb = gate({ ok: true })
    const pa = withProjectLock(A, '削除', ga.wait, META)
    const pb = withProjectLock(B, '削除', gb.wait, META)
    stageReporter(A)('teardown.lb')
    const n = s.attempts.length
    mono += 1 // 直前に書いたばかり
    flushInFlightOps(T0 + 50 * SEC)
    expect(s.attempts).toHaveLength(n + 1)
    const last = s.attempts.at(-1)!.running
    expect(last[A].lastSeenAt).toBe(T0 + 50 * SEC)
    expect(last[B].lastSeenAt).toBe(T0 + 50 * SEC)
    expect(last[A].segments).toEqual([{ stage: 'teardown.lb', startedAt: T0 }]) // 区間は変えない
    expect(getOps(A).running!.running).toBe(true) // 画面の記録も変えない
    ga.open(); gb.open(); await pa; await pb
  })

  it('★ 走っていなくて、前の書き込みも失敗していなければ書かない。口が無くても落ちない', async () => {
    const s = connect()
    await withProjectLock(A, '削除', async () => ({ ok: true }), META)
    const n = s.attempts.length
    flushInFlightOps(T0 + 99 * SEC)
    expect(s.attempts).toHaveLength(n)
    setInFlightSink(null)
    expect(() => flushInFlightOps(T0 + 99 * SEC)).not.toThrow()
  })

  it('lastSeenAt は戻らない（now が前の値より小さい・数でないときは、いまの値のまま）', async () => {
    const s = connect()
    const g = gate({ ok: true })
    const p = withProjectLock(A, '削除', g.wait, META)
    mono = 40 * SEC; at(60 * SEC)
    stageReporter(A)('teardown.lb')
    flushInFlightOps(T0 + 10 * SEC)
    expect(s.attempts.at(-1)!.running[A].lastSeenAt).toBe(T0 + 60 * SEC)
    flushInFlightOps(Number.NaN)
    expect(s.attempts.at(-1)!.running[A].lastSeenAt).toBe(T0 + 60 * SEC)
    g.open(); await p
  })
})

describe('R8 finishOp の書き込みが失敗しても、終了の直前の書き切りで running が消える（偽の「止まりました」を残さない）', () => {
  it.each<Mode>(['false', 'throw'])('★ 口が %s: 終わった回が running に残ったままになる → flush で、running が消えたファイルが書かれる', async (mode) => {
    const s = connect()
    const g = gate({ ok: true })
    const p = withProjectLock(A, '削除', g.wait, META)
    expect(Object.keys(s.state.disk!.running)).toEqual([A])
    s.state.mode = mode
    g.open(); await p // finishOp の書き込みが失敗する
    expect(Object.keys(s.state.disk!.running)).toEqual([A]) // ファイルには走っている印が残ったまま（このままだと次の起動で偽の「止まりました」）
    s.state.mode = 'ok'
    const n = s.attempts.length
    flushInFlightOps(T0 + 60 * SEC) // 走っているものが無くても、前の書き込みが失敗したままなので書く
    expect(s.attempts).toHaveLength(n + 1)
    expect(s.state.disk!.running).toEqual({})
    flushInFlightOps(T0 + 61 * SEC) // 書けたので、もう書かない
    expect(s.attempts).toHaveLength(n + 1)
  })

  it('flush の書き込みも失敗したら、印は残る（次の flush でもう一度書く）', async () => {
    const s = connect()
    s.state.mode = 'false'
    await withProjectLock(A, '削除', async () => ({ ok: true }), META)
    const n = s.attempts.length
    flushInFlightOps(T0 + SEC)
    flushInFlightOps(T0 + 2 * SEC)
    expect(s.attempts).toHaveLength(n + 2)
    s.state.mode = 'ok'
    flushInFlightOps(T0 + 3 * SEC)
    expect(s.attempts).toHaveLength(n + 3)
    expect(s.state.disk!.running).toEqual({})
  })
})

describe('R9 書けなかったあとは、30秒の間引きを待たずに、次の書く機会で書き直す', () => {
  it('★ 段の切り替えの書き込みが失敗 → 進み具合だけの更新でも、30秒を待たずに書き直す。書けたらまた間引く', async () => {
    const s = connect()
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress('x', { stage: 'teardown.app' })
      const n = s.attempts.length
      mono = 2 * SEC; at(2 * SEC)
      s.state.mode = 'false'
      progress('y', { stage: 'teardown.lb' }) // 失敗
      expect(s.attempts).toHaveLength(n + 1)
      expect(s.state.disk!.running[A].segments.map(x => x.stage)).toEqual(['teardown.app']) // ファイルは古いまま
      s.state.mode = 'ok'
      mono = 3 * SEC; at(3 * SEC)
      progress('y（進み具合だけ）') // 1秒後。ふつうなら間引かれる
      expect(s.attempts).toHaveLength(n + 2)
      expect(s.state.disk!.running[A].segments.map(x => x.stage)).toEqual(['teardown.app', 'teardown.lb']) // 直った
      mono = 4 * SEC; at(4 * SEC)
      progress('z（進み具合だけ）')
      expect(s.attempts).toHaveLength(n + 2) // 書けたので、また30秒に1回まで
      return { ok: true }
    }, META)
  })

  it('★ finishOp の書き込みが失敗 → 次の操作の始まりで丸ごと書き直され、終わった回は消える', async () => {
    const s = connect()
    const g = gate({ ok: true })
    const p = withProjectLock(A, '削除', g.wait, META)
    s.state.mode = 'false'
    g.open(); await p
    expect(Object.keys(s.state.disk!.running)).toEqual([A])
    s.state.mode = 'ok'
    const g2 = gate({ ok: true })
    const p2 = withProjectLock(B, '削除', g2.wait, META)
    expect(Object.keys(s.state.disk!.running)).toEqual([B]) // A の残りは直った
    g2.open(); await p2
  })

  it('口をつなぎ直すと、「書けなかった」の印は初めに戻る', async () => {
    const s = connect()
    s.state.mode = 'false'
    await withProjectLock(A, '削除', async () => ({ ok: true }), META)
    const s2 = connect()
    flushInFlightOps(T0 + SEC)
    expect(s2.attempts).toHaveLength(0)
  })
})

describe('R10 間引きは単調な時計で測る（Date が戻っても進んでも影響されない）', () => {
  it('★ Date を1時間戻しても、単調な時計が30秒進めば書く。Date が1時間進んでも、単調な時計が進んでいなければ書かない', async () => {
    const s = connect()
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      progress('x', { stage: 'teardown.lb' })
      const n = s.attempts.length
      vi.setSystemTime(T0 - 3600 * SEC) // 時計が戻った
      mono = 30 * SEC
      progress('時計が戻ったあと')
      expect(s.attempts).toHaveLength(n + 1)
      vi.setSystemTime(T0 + 3600 * SEC) // 時計が1時間進んだ
      mono = 31 * SEC
      progress('時計が進んだあと')
      expect(s.attempts).toHaveLength(n + 1)
      return { ok: true }
    }, META)
  })

  it('★ Date が戻っても、最後に分かった時刻は戻らない（止まった回の時間が縮まない）', async () => {
    const s = connect()
    const progress = progressReporter(A)
    await withProjectLock(A, '削除', async () => {
      at(60 * SEC)
      progress('x', { stage: 'teardown.lb' })
      expect(s.attempts.at(-1)!.running[A].lastSeenAt).toBe(T0 + 60 * SEC)
      at(10 * SEC) // 50秒戻った
      mono = 31 * SEC
      progress('戻ったあと') // 書かれる
      expect(s.attempts.at(-1)!.running[A].lastSeenAt).toBe(T0 + 60 * SEC)
      return { ok: true }
    }, META)
  })
})
