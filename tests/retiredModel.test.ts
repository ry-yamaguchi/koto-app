import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { MODELS, MODEL_PURPOSE, retiredModelNoticeText } from '../src/shared/modelInfo'
import {
  PRICING, applyRecord, computeUsageByModel, computeUsageForKey, hashKey, isPriceKnown, priceFor, usageCostNote, DEFAULT_PRICE,
} from '../src/shared/usageBudget'

// 提供終了したモデル（2026-11-09: preview/Kimi-K2.6）の扱い。
// 予備の一覧・料金表・目的表から外したあとも、過去の利用記録にはそのモデルIDが残る。
const RETIRED = 'preview/Kimi-K2.6'
const FP = hashKey('sk-retired-model-test')
const MONTH = '2026-10'

describe('提供終了したモデル（Kimi K2.6）', () => {
  it('予備の一覧・料金表・目的表のどれにも残っていない', () => {
    expect(MODELS.some(m => m.id === RETIRED)).toBe(false)
    expect(RETIRED in MODEL_PURPOSE).toBe(false)
    expect(isPriceKnown(RETIRED)).toBe(false)
  })

  it('過去の記録（K2.6）は、記録済みの額をそのまま保ち、0円（無料）に見せず、「料金表に無い」と添える', () => {
    // 提供終了前に記録した分（額は記録時に確定済み）
    const recorded = { [MONTH]: { keys: { [FP]: { models: { [RETIRED]: { promptTokens: 1_000_000, completionTokens: 100_000, costYen: 90 } } } } } } as any
    const rows = computeUsageByModel(recorded, MONTH)
    expect(rows).toHaveLength(1)
    expect(rows[0].model).toBe(RETIRED)
    expect(rows[0].costYen).toBe(90)          // 再計算せず、0 にもならない
    expect(computeUsageForKey(recorded, MONTH, FP).costYen).toBe(90)
    expect(usageCostNote(RETIRED)).toContain('料金表に無い')
  })

  it('K2.6 の新しい記録が入っても、無料扱い(0円)にならず、料金表でいちばん高い単価で数える', () => {
    const next = applyRecord({} as any, MONTH, FP, RETIRED, 1_000_000, 100_000)
    const yen = computeUsageForKey(next, MONTH, FP).costYen
    expect(priceFor(RETIRED)).toEqual(DEFAULT_PRICE)
    expect(yen).toBeGreaterThan(0)
    const maxIn = Math.max(...Object.values(PRICING).map(p => p.in))
    expect(yen).toBeGreaterThanOrEqual(maxIn)  // 入力100万トークンぶんは最大単価以上
  })
})

describe('提供終了の自動切り替えの案内（IDE チャットとチャットモードで共通）', () => {
  it('古いIDと新しい名前を含む', () => {
    const t = retiredModelNoticeText(RETIRED, 'Kimi K2.7 Code（プレビュー）')
    expect(t).toContain(RETIRED)
    expect(t).toContain('Kimi K2.7 Code（プレビュー）')
    expect(t).toContain('自動で切り替えました')
  })

  it('★ ChatPanel も ChatApp も、案内の文を自前で組まず retiredModelNoticeText を1回ずつ呼ぶ', () => {
    for (const f of ['ChatPanel.tsx', 'ChatApp.tsx']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components', f), 'utf-8')
      expect(src.match(/retiredModelNoticeText\(/g)?.length).toBe(1)
      expect(src).not.toContain('モデル「${model}」は提供終了したため') // さくら側の旧い手組みが戻っていない
    }
  })

  it('★ ChatApp は pickBestModel で切り替える同じ場所で案内を出す', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/ChatApp.tsx'), 'utf-8')
    const i = src.indexOf('const next = pickBestModel(models.map(m => m.id))')
    expect(i).toBeGreaterThan(0)
    expect(src.slice(i, i + 400)).toContain('retiredModelNoticeText(')
  })
})
