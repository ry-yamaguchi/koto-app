import { describe, it, expect } from 'vitest'
import {
  applyRecord, checkBeforeRequestOf, computeUsageForKey, priceFor, hashKey, isPriceKnown,
  PRICING, DEFAULT_SETTINGS, type BudgetSettings,
} from '../src/shared/usageBudget'
import { MODELS, MODEL_PURPOSE, modelPickerText, pickBestModel } from '../src/shared/modelInfo'

// 2026-09-25: さくらのAI Engine に「Weblab-MedLLM-gpt-oss-120b」が加わった（2026-09-24 提供開始）。
//
// ── なぜ料金を載せることが「お金の歯止め」なのか ─────────────────────────
// 載せる前の Koto は、料金表に無いモデルを固定の既定値（1万トークンあたり 0.15／0.75 円）で数えていた。
// このモデルの実際の料金は 0.9／4.5 円で、**6倍安く数えていた**。月の上限を ¥1,000 にしていると、
// Koto が「¥167 使った」と思っている間に実際は ¥1,000 に届き、**止まるべきところで止まらない**。
// しかもこのモデルは**無償枠が無い**（使った分がそのまま請求になる）。
// 同日、知らないモデルは料金表の最大（入力・出力それぞれ）で数える形に改めた
// （src/shared/usageBudget.ts の unknownModelPriceFrom・tests/unknownModelPrice.test.ts）。
// それでも「知っているどのモデルより高い新モデル」は安く数えうるので、原本の料金を載せることが本筋である。
//
// 料金の出どころ（原本・2つで一致）:
// - https://cloud.sakura.ad.jp/news/2026/09/24/ai-engine-weblab-medllm-gpt-oss-120b-pubprev/
// - https://ai.sakura.ad.jp/sakura-ai/ai-engine/ の料金表

const MED = 'preview/Weblab-MedLLM-gpt-oss-120b'
const FP = hashKey('sk-medllm-test')
const MONTH = '2026-09'

function settings(overrides: Partial<BudgetSettings> = {}): BudgetSettings {
  return { ...DEFAULT_SETTINGS, perKeyLimits: {}, ...overrides }
}

describe('Weblab-MedLLM の料金（お金の歯止め・掟10）', () => {
  it('★★ 原本どおりの料金で数える（¥/100万トークン: 入力 90・出力 450）', () => {
    expect(priceFor(MED)).toEqual({ in: 90, out: 450 })
  })

  // 2026-09-25 書き換え: 以前はここで `priceFor(MED).out / DEFAULT_PRICE.out` が 6 であることを見ていたが、
  // それは既定値の数字に釘で留めた時限式だった（既定値を料金表から導く形に変えると落ちる）。
  // 既定値の値に依らない形で「料金表の値で数える」「載せ忘れても MedLLM より安く数えない」を固定する。
  it('★★ 料金表の値で数える（知らないモデルとして見積もらない）', () => {
    expect(isPriceKnown(MED)).toBe(true)
    expect(priceFor(MED)).toEqual(PRICING[MED])
  })

  // MedLLM が料金表にある限り、表から導く「知らないモデルの見積もり」は MedLLM 以上になる。
  // ＝次に MedLLM の派生（別の id）が載せ忘れのまま来ても、MedLLM より安くは数えない。
  it('★★ 料金表に無い id は、MedLLM より安く数えない（同じ量なら MedLLM と同じか、より早く止まる）', () => {
    const notListed = 'preview/Weblab-MedLLM-次の版（料金表に未掲載の想定）'
    expect(isPriceKnown(notListed)).toBe(false)
    expect(priceFor(notListed).in).toBeGreaterThanOrEqual(priceFor(MED).in)
    expect(priceFor(notListed).out).toBeGreaterThanOrEqual(priceFor(MED).out)

    const s = settings({ enforce: true, monthlyLimitYen: 1000 })
    const months = applyRecord({}, MONTH, FP, notListed, 0, 2_222_223) // MedLLM ならちょうど ¥1,000 に届く量
    expect(checkBeforeRequestOf(s, months, MONTH, FP).allowed).toBe(false)
  })

  // 本命: 数えた額が正しいことより、**上限で本当に止まる**こと
  it('★★★ 実際の請求が月の上限に届いたら、Koto も止める', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 1000 })
    // 出力だけで ¥1,000 ぶん使う（450円 / 100万トークン → 約222万トークン）
    const months = applyRecord({}, MONTH, FP, MED, 0, 2_222_223)
    expect(computeUsageForKey(months, MONTH, FP).costYen).toBeGreaterThanOrEqual(1000)
    expect(checkBeforeRequestOf(s, months, MONTH, FP).allowed).toBe(false)
  })
})

describe('Weblab-MedLLM の表示（原本に書いてあることだけを言う）', () => {
  it('一覧の名前と、マウスオーバーの説明が出る', () => {
    expect(MODELS.map(m => m.id)).toContain(MED)
    const t = modelPickerText(MED)
    expect(t.name).toBe('Weblab-MedLLM 120B（医療・プレビュー）')
    expect(t.description).toBe('医療特化（無償枠なし）')
  })

  // 新しい会話の既定（MODELS[0]）にしない。医療特化で、コード作成の既定には向かない
  it('★ 一覧の先頭（新しい会話の既定）にしない', () => {
    expect(MODELS[0].id).not.toBe(MED)
  })

  it('★ 「コード作成にいちばん良いモデル」の自動選択に紛れ込まない', () => {
    const ids = ['preview/Kimi-K2.7-Code', MED, 'gpt-oss-120b']
    expect(pickBestModel(ids)).not.toBe(MED)
    expect(pickBestModel([MED, 'preview/Qwen3.6-35B-A3B'])).toBe('preview/Qwen3.6-35B-A3B')
  })

  // ツール対応はお知らせに書かれていない。実際に使ったときに modelLearning.ts が学ぶ（掟1）
  it('★ ツール対応を推測して書かない（「ツール非対応」とも「ツール対応」とも言わない）', () => {
    const p = MODEL_PURPOSE[MED]
    expect(`${p.purpose}${p.note ?? ''}`).not.toMatch(/ツール/)
  })
})
