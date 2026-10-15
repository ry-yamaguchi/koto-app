import { describe, it, expect } from 'vitest'
import {
  STAGE, DEDICATED_STAGES, ALL_STAGES, STAGE_ID_PATTERN, STAGE_TIMING_SUMMARY,
  isStageIdShape, stageLabelOf, buildStageTimings, readStageTimings, formatDuration, stageTimingView,
} from '../src/shared/stageTiming'

// ── 段の内部名と、かかった時間の組み立て・読み取り・文（2026-10-07）─────────────────────────────
// 段は**画面の文ではなく内部の名前**で記録する（画面の言葉を直しても記録がつながる）。ここは、その名前の表と、
// 時間の足し合わせ・読み取り・「N分M秒」の言い方を、振る舞いで固定する（純関数）。

describe('段の内部名の表（定義は1か所）', () => {
  it('★ STAGE の値はすべて、操作ごとの並び（DEDICATED_STAGES）に1回ずつ入っている（表に無い名前・重複が無い）', () => {
    const inTable = ALL_STAGES.map(s => s.id)
    expect([...inTable].sort()).toEqual(Object.values(STAGE).sort())
    expect(new Set(inTable).size).toBe(inTable.length)
  })

  it('操作ごとの並びは 作成3・公開9・削除5（flow が通る順）', () => {
    expect(DEDICATED_STAGES.create.map(s => s.id)).toEqual(['create.cluster', 'create.asg', 'create.lb'])
    expect(DEDICATED_STAGES.teardown.map(s => s.id)).toEqual(['teardown.app', 'teardown.lb', 'teardown.asg', 'teardown.cluster', 'teardown.storage'])
    expect(DEDICATED_STAGES.publish.map(s => s.id)).toEqual([
      'publish.prepare', 'publish.image', 'publish.check', 'publish.app', 'publish.cleanup',
      'publish.lb-address', 'publish.verify', 'publish.containers', 'publish.key-cleanup',
    ])
  })

  it('★ 内部名は形の検査（STAGE_ID_PATTERN）に通り、画面の名前（label）は日本語で、内部名そのものではない', () => {
    for (const s of ALL_STAGES) {
      expect(isStageIdShape(s.id)).toBe(true)
      expect(STAGE_ID_PATTERN.test(s.id)).toBe(true)
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.label).not.toBe(s.id)
      expect(s.label, `${s.id} の名前に丸数字が入っている`).not.toMatch(/[①-⓿❶-➓㉑-㊿]/)
      expect(stageLabelOf(s.id)).toBe(s.label)
    }
  })

  it('画面の言葉は wording-decisions.md に従う（「削除」であり「破棄」「壊す」ではない・「ビルド」・「バージョン」）', () => {
    const labels = ALL_STAGES.map(s => s.label).join('\n')
    expect(labels).not.toMatch(/破棄|壊す|片づけ|組み立て|版/)
    expect(DEDICATED_STAGES.teardown.every(s => s.label.endsWith('の削除'))).toBe(true)
    expect(stageLabelOf(STAGE.publishImage)).toBe('イメージのビルドとプッシュ')
    expect(stageLabelOf(STAGE.publishApp)).toBe('アプリとバージョンの作成・有効化')
  })

  it('表に無い名前（別の版が記録したもの）は、内部名のまま出す（落ちない・隠さない）', () => {
    expect(stageLabelOf('future.stage')).toBe('future.stage')
  })

  it('isStageIdShape: 記録・IPC から来た値を信用しない（大文字・空白・長すぎ・文字列以外は不可）', () => {
    for (const bad of ['', 'Publish.image', 'publish image', '1abc', 'a'.repeat(65), '../x', 'a/b', null, undefined, 3, {}]) {
      expect(isStageIdShape(bad), String(bad)).toBe(false)
    }
    expect(isStageIdShape('x.y-z')).toBe(true)
  })
})

describe('buildStageTimings: 段ごとの区間 → 段ごとの所要時間と合計', () => {
  it('★ 通った順に並べ、各段の時間は区間の長さ。合計は操作の始まりから終わりまで', () => {
    const t = buildStageTimings([
      { stage: 'a.one', startedAt: 1000, endedAt: 3000 },
      { stage: 'a.two', startedAt: 3000, endedAt: 10_500 },
    ], 900, 10_600)
    expect(t).toEqual({ totalMs: 9700, stages: [{ stage: 'a.one', ms: 2000 }, { stage: 'a.two', ms: 7500 }] })
  })

  it('★ 同じ段に何度か入ったときは足し合わせる。並びは最初に入った順', () => {
    const t = buildStageTimings([
      { stage: 'a.asg', startedAt: 0, endedAt: 1000 },
      { stage: 'a.lb', startedAt: 1000, endedAt: 4000 },
      { stage: 'a.asg', startedAt: 4000, endedAt: 4500 },
    ], 0, 4500)
    expect(t!.stages).toEqual([{ stage: 'a.asg', ms: 1500 }, { stage: 'a.lb', ms: 3000 }])
  })

  it('区間が無ければ null（段を渡さなかった操作に、時間を出さない）', () => {
    expect(buildStageTimings([], 0, 5000)).toBeNull()
  })

  it('形の合わない名前の区間は数えない。終わりが始まりより前（時計の巻き戻り）は 0 にする', () => {
    const t = buildStageTimings([
      { stage: 'BAD NAME', startedAt: 0, endedAt: 10 },
      { stage: 'ok.stage', startedAt: 100, endedAt: 50 },
    ], 0, 100)
    expect(t).toEqual({ totalMs: 100, stages: [{ stage: 'ok.stage', ms: 0 }] })
    expect(buildStageTimings([{ stage: 'BAD', startedAt: 0, endedAt: 1 }], 0, 1)).toBeNull()
  })
})

describe('readStageTimings: 記録・IPC から来た値を、画面が使える形にする（信用しない）', () => {
  it('正しい形はそのまま読める（ミリ秒は整数に丸める）', () => {
    expect(readStageTimings({ totalMs: 5000.4, stages: [{ stage: 'a.b', ms: 1234.6 }] })).toEqual({ totalMs: 5000, stages: [{ stage: 'a.b', ms: 1235 }] })
  })

  it('合計が無い・壊れているときは、段の合計にする', () => {
    expect(readStageTimings({ stages: [{ stage: 'a.b', ms: 1000 }, { stage: 'a.c', ms: 2000 }] })!.totalMs).toBe(3000)
    expect(readStageTimings({ totalMs: -5, stages: [{ stage: 'a.b', ms: 1000 }] })!.totalMs).toBe(1000)
    expect(readStageTimings({ totalMs: 'x', stages: [{ stage: 'a.b', ms: 1000 }] })!.totalMs).toBe(1000)
  })

  it('★ 使えない行（負・巨大・NaN・形違い・名前違い）は捨て、使える行だけ残す。1行も無ければ null', () => {
    const t = readStageTimings({ totalMs: 10, stages: [
      { stage: 'a.ok', ms: 10 }, { stage: 'a.neg', ms: -1 }, { stage: 'a.nan', ms: NaN }, { stage: 'a.big', ms: 1e12 },
      { stage: 'BAD', ms: 5 }, { stage: 'a.str', ms: '5' }, null, 'x', { ms: 5 },
    ] })
    expect(t!.stages).toEqual([{ stage: 'a.ok', ms: 10 }])
    for (const bad of [null, undefined, 3, 'x', [], {}, { stages: 'x' }, { stages: [] }, { stages: [{ stage: 'BAD', ms: 1 }] }]) {
      expect(readStageTimings(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('行数に上限がある（巨大な配列で画面を埋めない）', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ stage: `a.s${i}`, ms: 1 }))
    expect(readStageTimings({ stages: many })!.stages.length).toBe(50)
  })
})

describe('formatDuration: かかった時間を分と秒で言う', () => {
  it.each([
    [0, '1秒未満'], [999, '1秒未満'], [1000, '1秒'], [5000, '5秒'], [59_400, '59秒'],
    [59_600, '1分0秒'], [60_000, '1分0秒'], [125_000, '2分5秒'], [9 * 60_000 + 12_000, '9分12秒'],
    [3_599_000, '59分59秒'], [3_725_000, '1時間2分5秒'],
  ])('%i ミリ秒 → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })
  it('負・NaN は「—」（落ちない）', () => {
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(NaN)).toBe('—')
  })
})

describe('stageTimingView: 「かかった時間を見る」を開いたとき並べる行', () => {
  it('★ 見出しは「かかった時間を見る」。行は通った順で、段の名前と「分と秒」。最後に合計', () => {
    const v = stageTimingView({ totalMs: 11 * 60_000 + 3000, stages: [
      { stage: STAGE.teardownApp, ms: 90_000 },
      { stage: STAGE.teardownLb, ms: 9 * 60_000 + 12_000 },
    ] })
    expect(v.summary).toBe('かかった時間を見る')
    expect(STAGE_TIMING_SUMMARY).toBe('かかった時間を見る')
    expect(v.rows).toEqual([
      { stage: 'teardown.app', label: 'アプリケーションの削除', text: '1分30秒' },
      { stage: 'teardown.lb', label: 'ロードバランサの削除', text: '9分12秒' },
    ])
    expect(v.total).toEqual({ label: '合計', text: '11分3秒' })
  })
})
