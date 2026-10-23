import { describe, it, expect } from 'vitest'
import { readActualMinScale, judgeScale, scaleLabel } from '../src/shared/scaleDecision'

// 委譲仕様: 再公開のときの「起動のしかた（min_scale）」の食い違いを、黙って上書きせず聞く
// （Ryosuke さん決定・案②・2026-09-10）。ここは判断の純関数のみを固定する。IO は apply.ts 側。

describe('readActualMinScale: GET /applications/{id} の応答から min_scale を読む', () => {
  it('number ならそれを返す', () => {
    expect(readActualMinScale({ min_scale: 0 })).toBe(0)
    expect(readActualMinScale({ min_scale: 3 })).toBe(3)
  })

  it('min_scale が無ければ null', () => {
    expect(readActualMinScale({})).toBeNull()
  })

  it('★ min_scale が文字列 "1" でも number でなければ null（他のキーを当てにいかない）', () => {
    expect(readActualMinScale({ min_scale: '1' })).toBeNull()
  })

  it('data 自体が unknown の形（null・配列・プリミティブ）でも null', () => {
    expect(readActualMinScale(null)).toBeNull()
    expect(readActualMinScale(undefined)).toBeNull()
    expect(readActualMinScale([1, 2, 3])).toBeNull()
    expect(readActualMinScale('min_scale: 1')).toBeNull()
  })
})

describe('judgeScale: 食い違ったときだけ止めて聞く（案②）', () => {
  it('actual が null（確認できない）→ proceed・Koto の設定（recorded）で進める。ただし note に残す', () => {
    const j = judgeScale({ recorded: 0, actual: null })
    expect(j).toEqual({ kind: 'proceed', min: 0, note: expect.stringContaining('確認できませんでした') })
    if (j.kind === 'proceed') expect(j.note).toContain('Koto の設定')
  })

  it('actual === recorded → proceed・note は null（普段どおり・何も言わない）', () => {
    expect(judgeScale({ recorded: 0, actual: 0 })).toEqual({ kind: 'proceed', min: 0, note: null })
    expect(judgeScale({ recorded: 1, actual: 1 })).toEqual({ kind: 'proceed', min: 1, note: null })
  })

  it('食い違い・decision 未指定 → ask（fetch も PATCH もしない、という約束は呼び出し側＝apply.ts が守る）', () => {
    expect(judgeScale({ recorded: 0, actual: 1 })).toEqual({ kind: 'ask', recorded: 0, actual: 1 })
    expect(judgeScale({ recorded: 1, actual: 0 })).toEqual({ kind: 'ask', recorded: 1, actual: 0 })
  })

  it("decision:'koto' → proceed・recorded を採用（実物と食い違っていても Koto の設定で進める）", () => {
    expect(judgeScale({ recorded: 0, actual: 1, decision: 'koto' })).toEqual({ kind: 'proceed', min: 0, note: null })
    expect(judgeScale({ recorded: 3, actual: 5, decision: 'koto' })).toEqual({ kind: 'proceed', min: 3, note: null })
  })

  it("decision:'sakura' → proceed・actual を採用（実物を Koto の設定に取り込む）", () => {
    expect(judgeScale({ recorded: 0, actual: 1, decision: 'sakura' })).toEqual({ kind: 'proceed', min: 1, note: null })
    expect(judgeScale({ recorded: 3, actual: 5, decision: 'sakura' })).toEqual({ kind: 'proceed', min: 5, note: null })
  })

  it('actual===recorded のときは decision が付いていても無視して一致扱い（note なし）', () => {
    expect(judgeScale({ recorded: 2, actual: 2, decision: 'sakura' })).toEqual({ kind: 'proceed', min: 2, note: null })
    expect(judgeScale({ recorded: 2, actual: 2, decision: 'koto' })).toEqual({ kind: 'proceed', min: 2, note: null })
  })
})

describe('scaleLabel: AppRunPanel のボタンの名前と同じ言葉（名前だけ。説明は付けない）', () => {
  it('0 → 最初のアクセスが遅くてもよい', () => {
    expect(scaleLabel(0)).toBe('最初のアクセスが遅くてもよい')
  })
  it('1以上 → 常時起動', () => {
    expect(scaleLabel(1)).toBe('常時起動')
    expect(scaleLabel(10)).toBe('常時起動')
    // 0.6.21: 「すぐ返す（常時動かす）」は「常時起動」に揃えた。直す前の言い方は戻さない
    expect(scaleLabel(1)).not.toContain('すぐ返す')
  })
  it('★ 括弧の説明を付けない（0.6.22: 設定の画面のボタンが語の途中で折れていた。説明は画面の本文が言う）', () => {
    for (const n of [0, 1, 10]) expect(scaleLabel(n)).not.toMatch(/[（()）]/)
  })
})
