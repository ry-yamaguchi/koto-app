import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import StageTimingDetails from '../src/renderer/components/StageTimingDetails'
import StageEstimate from '../src/renderer/components/StageEstimate'
import { progressReporter, getOps, resetProjectOpsForTests } from '../src/main/projectOps'
import { withProjectLock } from '../src/main/projectLock'
import { resumedCreateResult, resumedTeardownResult, resumedPublishResult } from '../src/renderer/apprunDedicatedActions'

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
    ['手順6（削除）', 'apprunDedicated:teardown', '削除', { ok: true, executed: [], message: 'ok', remaining: {} }, resumedTeardownResult],
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

describe('StageEstimate: 目安は IPC の一覧から、待っている段のぶんだけ（描く前は何も出さない）', () => {
  it('段が無い・まだ読めていないときは何も描かない（目安を作らない）', () => {
    expect(renderToStaticMarkup(createElement(StageEstimate, { stage: undefined }))).toBe('')
    expect(renderToStaticMarkup(createElement(StageEstimate, { stage: 'teardown.lb' }))).toBe('') // 一覧を読む前（初回描画）は出さない
  })
})
