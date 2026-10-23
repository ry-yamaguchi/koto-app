import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import StageTimingDetails from '../src/renderer/components/StageTimingDetails'
import StageEstimate from '../src/renderer/components/StageEstimate'
import { progressReporter, getOps, resetProjectOpsForTests } from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import { resumedCreateResult, resumedPublishResult } from '../src/renderer/apprunDedicatedActions'
import { resumedTeardownView } from '../src/shared/teardownResult'
import { readStageTimings } from '../src/shared/stageTiming'

// ── 「かかった時間を見る」を実際に描いて確かめる（2026-10-07）──────────────────────────────────────
// 部品（StageTimingDetails）を実際に HTML へ描き、**その場で終わった結果**（IPC の返り値の stageTimings）と
// **閉じて開き直したときに記録（projectOps）から出す結果**が、**同じ HTML** になることを確かめる（双子）。
// 画面（AppRunDedicatedPanel）は、どちらの経路でも同じ部品に stageTimings を渡す（配線は stageTimingWiring が固定）。

const html = (timings: unknown) => renderToStaticMarkup(createElement(StageTimingDetails, { timings: timings as any }))

describe('StageTimingDetails: 折りたたみ（開いたときだけ段ごとの時間と合計）', () => {
  const timings = { totalMs: 11 * 60_000 + 3000, stages: [{ stage: 'teardown.app', ms: 90_000 }, { stage: 'teardown.lb', ms: 9 * 60_000 + 12_000 }] }

  it('★ 見出し「かかった時間を見る」の <details>。**閉じた状態**で描く（open が付かない）。中に段ごとの時間（分と秒）と合計', () => {
    const h = html(timings)
    expect(h).toContain('<details')
    expect(h).not.toMatch(/<details[^>]*\sopen/)
    expect(h).toContain('<summary')
    expect(h).toContain('かかった時間を見る')
    expect(h).toContain('アプリケーションの削除')
    expect(h).toContain('1分30秒')
    expect(h).toContain('ロードバランサの削除')
    expect(h).toContain('9分12秒')
    expect(h).toContain('合計')
    expect(h).toContain('11分3秒')
    // 並びは通った順（アプリ → LB → 合計）
    expect(h.indexOf('アプリケーションの削除')).toBeLessThan(h.indexOf('ロードバランサの削除'))
    expect(h.indexOf('ロードバランサの削除')).toBeLessThan(h.indexOf('合計'))
  })

  it('★ 時間が無いとき（段を渡さなかった・形が違う・空）は何も描かない', () => {
    for (const bad of [undefined, null, { totalMs: 0, stages: [] }]) expect(html(bad), JSON.stringify(bad)).toBe('')
  })

  it('内部名（teardown.lb など）は画面に出さない（出すのは画面の名前）', () => {
    expect(html(timings)).not.toMatch(/teardown\.|publish\.|create\./)
  })

  it('表に無い段（別の版が記録したもの）は内部名のまま出す（落ちない）', () => {
    expect(html({ totalMs: 1000, stages: [{ stage: 'future.stage', ms: 1000 }] })).toContain('future.stage')
  })
})

describe('★★ 双子: その場で終わった結果と、開き直したときの記録から出す結果は、同じ HTML', () => {
  const T0 = Date.UTC(2026, 9, 7, 3, 0, 0)
  beforeEach(() => { resetProjectOpsForTests(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0) })
  afterEach(() => { vi.useRealTimers(); resetProjectOpsForTests() })

  async function run(handler: string, op: '作成' | '削除' | '公開', value: Record<string, unknown>) {
    const progress = progressReporter('/p/render-twin')
    const r = await withProjectLock('/p/render-twin', op, async () => {
      progress('…', { stage: 'x.first' }); vi.setSystemTime(T0 + 125_000)
      progress('…', { stage: 'x.second' }); vi.setSystemTime(T0 + 125_000 + 3_000)
      return value
    }, { target: 'sakura-apprun-dedicated', handler })
    return { inPlace: r.busy ? undefined : r.stageTimings, record: getOps('/p/render-twin').last! }
  }

  it.each([
    ['手順5（作成）', 'apprunDedicated:create', '作成', { ok: true, stage: 'done', message: 'ok' }, resumedCreateResult],
    ['手順6（削除）', 'apprunDedicated:teardown', '削除', { ok: true, executed: [], message: 'ok', remaining: {} }, (rec: { result: any }) => resumedTeardownView('sakura-apprun-dedicated', rec.result)],
    ['手順8（公開）', 'apprunDedicated:publishApp', '公開', { ok: true, stage: 'done', message: 'ok' }, resumedPublishResult],
  ] as const)('%s', async (_n, handler, op, value, resumed) => {
    const { inPlace, record } = await run(handler, op, value as any)
    const fromRecord = (resumed as any)(record).stageTimings
    expect(html(inPlace)).toContain('かかった時間を見る')
    expect(html(fromRecord)).toBe(html(inPlace))
    expect(html(inPlace)).toContain('2分5秒') // 125 秒
    expect(html(inPlace)).toContain('合計')
  })
})

// ── 途中で止まった回（earlierRuns。設計書 10.13）を実際に描く ──────────────────────────────────────

describe('V1 止まった回が無いと、描く HTML は今までと同じ（1文字も変わらない）', () => {
  // 止まった回を足す前の部品が描いていた HTML をそのまま写した（2026-10-13 に、足す前のコードで書き出した）。
  const GOLDEN = '<details class="text-[11px] text-ink-muted" data-stage-timing-details="true"><summary class="cursor-pointer select-none hover:text-ink">かかった時間を見る</summary><ul class="mt-1 space-y-0.5 select-text"><li class="flex items-baseline justify-between gap-3"><span>アプリケーションの削除</span><span class="font-mono tabular-nums">1分30秒</span></li><li class="flex items-baseline justify-between gap-3"><span>ロードバランサの削除</span><span class="font-mono tabular-nums">9分12秒</span></li><li class="flex items-baseline justify-between gap-3 border-t border-line pt-0.5 font-semibold text-ink-secondary"><span>合計</span><span class="font-mono tabular-nums">11分3秒</span></li></ul></details>'
  const base = { totalMs: 11 * 60_000 + 3000, stages: [{ stage: 'teardown.app', ms: 90_000 }, { stage: 'teardown.lb', ms: 9 * 60_000 + 12_000 }] }

  it('★ earlierRuns が無い・空・形が違うとき、HTML は足す前と同じ文字列', () => {
    expect(html(base)).toBe(GOLDEN)
    expect(html({ ...base, earlierRuns: [] })).toBe(GOLDEN)
    expect(html(readStageTimings({ ...base, earlierRuns: [{ endedBy: 'crash' }, null] }))).toBe(GOLDEN)
    expect(html(readStageTimings(base))).toBe(GOLDEN)
  })
})

describe('V2・V5 止まった回を描く（見出し・途中まで・今回・合計）', () => {
  // 端末の時計で作る（見出しは端末の時計で言うので、どこの時差でも同じ文になる）。
  const at = (h: number, m: number, sec = 0) => new Date(2026, 9, 10, h, m, sec).getTime()
  const quit = {
    startedAt: at(14, 2), lastKnownAt: at(14, 9, 8), endedBy: 'quit', knownMs: 7 * 60_000 + 8000,
    stages: [{ stage: 'teardown.app', ms: 72_000 }, { stage: 'teardown.lb', ms: 5 * 60_000 + 8000 }], partialLast: true,
  }
  const now = { totalMs: 3 * 60_000 + 2000 + 142_000 + 1000 + 4000 + 2000, stages: [
    { stage: 'teardown.lb', ms: 3 * 60_000 + 2000 }, { stage: 'teardown.asg', ms: 142_000 }, { stage: 'teardown.cluster', ms: 400 }, { stage: 'teardown.storage', ms: 4000 },
  ], earlierRuns: [quit] }
  const h = html(now)

  it('★★ 止まった回の見出しと行 → 「今回」の見出しと行 → 合計の順に並ぶ。値は仕様の例どおり', () => {
    expect(h).toContain('Koto の終了で止まった回（10/10 14:02〜14:09 ごろ）')
    expect(h).toContain('途中まで（少なくとも5分8秒）')
    expect(h).toContain('今回')
    expect(h).toContain('合計（止まっていた間を除く）')
    // 7分8秒（止まった回の knownMs）＋ 5分31秒（今回の totalMs）＝ 12分39秒
    expect(h).toContain('12分39秒')
    const order = ['Koto の終了で止まった回', 'アプリケーションの削除', '1分12秒', '途中まで（少なくとも5分8秒）', '今回', 'オートスケーリンググループの削除', '2分22秒', '保存場所の削除', '合計（止まっていた間を除く）']
    const idx = order.map(t => h.indexOf(t))
    expect(idx.every(i => i >= 0), JSON.stringify(idx)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    // 止まった回のロードバランサの行（途中まで）は、今回のロードバランサの行（3分2秒）より前
    expect(h.indexOf('途中まで（少なくとも5分8秒）')).toBeLessThan(h.indexOf('3分2秒'))
  })

  it('★ 止まった回の行が閉じた状態の <details> の中にある（開いたときだけ見える）。今回の行・合計の行は今までの作りのまま', () => {
    expect(h).toMatch(/^<details[^>]*>/)
    expect(h).not.toMatch(/<details[^>]*\sopen/)
    expect(h).toContain('border-t border-line pt-0.5 font-semibold text-ink-secondary"><span>合計（止まっていた間を除く）</span>')
  })

  it('★ 待ち切れた回の見出しは「ごろ」なし。2回分あれば古い順に2つ並ぶ', () => {
    const two = html({ ...now, earlierRuns: [quit, { ...quit, endedBy: 'unfinished', startedAt: at(15, 0), lastKnownAt: at(15, 11) }] })
    expect(two).toContain('待ち切れずに止まった回（10/10 15:00〜15:11）')
    expect(two.indexOf('Koto の終了で止まった回')).toBeLessThan(two.indexOf('待ち切れずに止まった回'))
    expect(two).not.toContain('15:11 ごろ')
  })

  it('V5 内部名（teardown.lb など）は出さない。表に無い段は内部名のまま（落ちない）', () => {
    expect(h).not.toMatch(/teardown\.|publish\.|create\./)
    const unknown = html({ ...now, earlierRuns: [{ ...quit, stages: [{ stage: 'future.stage', ms: 1000 }], partialLast: false }] })
    expect(unknown).toContain('future.stage')
  })

  it('止まった回の行は、今回の行より字下げされる（見出しの下にまとまって見える）。止まった回が無いときの行は字下げされない', () => {
    expect(h).toMatch(/<li class="flex items-baseline justify-between gap-3 pl-3"><span>アプリケーションの削除<\/span>/)
    expect(html({ totalMs: 1000, stages: [{ stage: 'teardown.app', ms: 1000 }] })).not.toContain('pl-3')
  })
})

describe('StageEstimate: 目安は IPC の一覧から、待っている段のぶんだけ（描く前は何も出さない）', () => {
  it('段が無い・まだ読めていないときは何も描かない（目安を作らない）', () => {
    expect(renderToStaticMarkup(createElement(StageEstimate, { stage: undefined }))).toBe('')
    expect(renderToStaticMarkup(createElement(StageEstimate, { stage: 'teardown.lb' }))).toBe('') // 一覧を読む前（初回描画）は出さない
  })
})
