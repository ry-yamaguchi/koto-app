import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  applyRecord, checkBeforeRequestOf, computeUsageForKey, hashKey,
  priceFor, isPriceKnown, unknownModelPriceFrom, priceLabel, usageCostNote, unknownPriceRuleText,
  PRICING, DEFAULT_PRICE, DEFAULT_SETTINGS, type BudgetSettings, type Price,
} from '../src/shared/usageBudget'

// 2026-09-25: 料金表（PRICING）に無いモデルを安く数えない（お金の歯止め・掟10「迷ったら警告に倒す」）。
//
// さくらの AI Engine に Weblab-MedLLM（1万トークンあたり 0.9／4.5 円）が加わったとき、Koto は料金表に
// 無いモデルを固定の既定値（0.15／0.75 円＝いちばん安い部類）で数えていたため、**6倍安く**数えていた。
// 月の上限が遅れて効き、止まるべきところで止まらない。新しいモデルは予告なく現れ、料金が公開されない
// モデルもあるので、「載せ忘れ」は今後も起きる。そこで知らないモデルは料金表の最大（入力・出力それぞれ）で
// 数える。ここでは**既定値の数字に依らず**、振る舞いで固定する:
//   - 同じトークン数なら、知っているどのモデルより安く数えない
//   - 月の上限が、知っているどのモデルで同じだけ使った場合より遅く効かない
//   - 既定値は表から導く（表にもっと高いモデルが載れば、勝手に上がる）
//   - 設定画面で、知らないモデルに実在しない料金を出さない

const FP = hashKey('sk-unknown-model-test')
const MONTH = '2026-09'
const KNOWN = Object.keys(PRICING)
// 料金表に無い id（どれも実在の料金を Koto が知らないモデルの想定）
const UNKNOWN = ['preview/次に来る新モデル', 'PLaMo-3.0-Prime', 'cotomi-v3', '見たことのないモデル']
// Object のプロトタイプにある名前。料金表の「自分のキー」ではないので、知らないモデルとして扱う
const PROTO_NAMES = ['constructor', 'toString', 'hasOwnProperty', '__proto__']

function settings(overrides: Partial<BudgetSettings> = {}): BudgetSettings {
  return { ...DEFAULT_SETTINGS, perKeyLimits: {}, ...overrides }
}

function costOf(model: string, promptTokens: number, completionTokens: number): number {
  const months = applyRecord({}, MONTH, FP, model, promptTokens, completionTokens)
  return computeUsageForKey(months, MONTH, FP).costYen
}

// 入力だけ・出力だけ・混ぜたもの・ごく少量
const TOKEN_MIXES: Array<[number, number]> = [
  [1_000_000, 0], [0, 1_000_000], [123_457, 98_765], [1, 1], [5_000_000, 20_000],
]

describe('知らないモデルを安く数えない（applyRecord）', () => {
  it('★★★ 同じトークン数なら、知っているどのモデルより安く数えない', () => {
    for (const unknown of UNKNOWN) {
      for (const [p, c] of TOKEN_MIXES) {
        const u = costOf(unknown, p, c)
        for (const known of KNOWN) {
          expect(u, `${unknown} と ${known}（入力 ${p}・出力 ${c}）`).toBeGreaterThanOrEqual(costOf(known, p, c))
        }
      }
    }
  })

  it('★★ 知らないモデルでも課金は0にならず、有限の額になる', () => {
    for (const unknown of UNKNOWN) {
      const u = costOf(unknown, 1_000_000, 1_000_000)
      expect(u).toBeGreaterThan(0)
      expect(Number.isFinite(u)).toBe(true)
    }
  })
})

describe('知らないモデルで使っても、月の上限が遅れて効かない（checkBeforeRequestOf）', () => {
  // 各既知モデルについて「そのモデルならちょうど上限に届くトークン数」を求め、
  // 同じトークン数を知らないモデルで使ったら、同じく止まることを確かめる
  for (const limit of [1, 100, 1000]) {
    it(`★★★ 上限 ¥${limit}: 知っているどのモデルで止まる量でも、知らないモデルは止まる（入力だけ・出力だけ）`, () => {
      const s = settings({ enforce: true, monthlyLimitYen: limit })
      for (const known of KNOWN) {
        const price = priceFor(known)
        const inputOnly = Math.ceil((limit / price.in) * 1_000_000)
        const outputOnly = Math.ceil((limit / price.out) * 1_000_000)
        for (const [p, c] of [[inputOnly, 0], [0, outputOnly]] as Array<[number, number]>) {
          // 前提: 既知モデルはこの量で止まる
          const knownMonths = applyRecord({}, MONTH, FP, known, p, c)
          expect(checkBeforeRequestOf(s, knownMonths, MONTH, FP).allowed).toBe(false)
          for (const unknown of UNKNOWN) {
            const months = applyRecord({}, MONTH, FP, unknown, p, c)
            expect(
              checkBeforeRequestOf(s, months, MONTH, FP).allowed,
              `${unknown} は ${known} なら止まる量（入力 ${p}・出力 ${c}）で止まらなかった`,
            ).toBe(false)
          }
        }
      }
    })
  }

  it('★★ 小分けに何度も使っても、知っているどのモデルより遅く止まらない', () => {
    const s = settings({ enforce: true, monthlyLimitYen: 50 })
    const step: [number, number] = [20_000, 5_000]
    // 何回目で止まるかを数える
    const stopsAfter = (model: string): number => {
      let months = {}
      for (let i = 1; i <= 1_000_000; i++) {
        months = applyRecord(months, MONTH, FP, model, step[0], step[1])
        if (!checkBeforeRequestOf(s, months, MONTH, FP).allowed) return i
      }
      throw new Error('止まらなかった')
    }
    const earliestKnown = Math.min(...KNOWN.map(stopsAfter))
    for (const unknown of UNKNOWN) expect(stopsAfter(unknown)).toBeLessThanOrEqual(earliestKnown)
  })
})

describe('既定値は料金表から導く（unknownModelPriceFrom）', () => {
  it('★★ 入力は表の入力の最大、出力は表の出力の最大（別々に取る）', () => {
    const table: Record<string, Price> = {
      a: { in: 1, out: 30 },
      b: { in: 10, out: 3 },
    }
    expect(unknownModelPriceFrom(table)).toEqual({ in: 10, out: 30 })
  })

  it('★★★ 表にもっと高いモデルを足すと、知らないモデルの見積もりも上がる（手で書いた数字ではない）', () => {
    const before = unknownModelPriceFrom(PRICING)
    const pricier = { in: before.in * 2 + 1, out: before.out * 3 + 1 }
    const after = unknownModelPriceFrom({ ...PRICING, 'preview/もっと高い新モデル': pricier })
    expect(after).toEqual(pricier)
    expect(after.in).toBeGreaterThan(before.in)
    expect(after.out).toBeGreaterThan(before.out)
  })

  it('安いモデルを足しても、見積もりは下がらない', () => {
    const before = unknownModelPriceFrom(PRICING)
    expect(unknownModelPriceFrom({ ...PRICING, 'preview/安い新モデル': { in: 0, out: 0 } })).toEqual(before)
  })

  it('★★ 実際に使う既定値（DEFAULT_PRICE）は、いまの料金表から導いた値そのもの', () => {
    expect(DEFAULT_PRICE).toEqual(unknownModelPriceFrom(PRICING))
    for (const unknown of UNKNOWN) expect(priceFor(unknown)).toEqual(unknownModelPriceFrom(PRICING))
  })

  it('壊れた行（NaN・負・無限）は数えない（見積もりを NaN や負にしない）', () => {
    const table = {
      ok: { in: 5, out: 7 },
      nan: { in: NaN, out: NaN },
      neg: { in: -100, out: -100 },
      inf: { in: Infinity, out: Infinity },
    } as Record<string, Price>
    expect(unknownModelPriceFrom(table)).toEqual({ in: 5, out: 7 })
  })

  it('★ 使える行が1つも無い表は例外にする（0円で数えて上限を永遠に効かなくしない）', () => {
    expect(() => unknownModelPriceFrom({})).toThrow()
    expect(() => unknownModelPriceFrom({ nan: { in: NaN, out: NaN } })).toThrow()
  })
})

describe('料金表が知っているか（isPriceKnown）', () => {
  it('料金表のモデルはすべて知っている・載っていないものは知らない', () => {
    for (const known of KNOWN) expect(isPriceKnown(known)).toBe(true)
    for (const unknown of UNKNOWN) expect(isPriceKnown(unknown)).toBe(false)
  })

  it('★ Object のプロトタイプにある名前を、料金として拾わない', () => {
    for (const name of PROTO_NAMES) {
      expect(isPriceKnown(name)).toBe(false)
      expect(priceFor(name)).toEqual(DEFAULT_PRICE)
    }
  })
})

describe('設定画面のモデル選択に出す料金（priceLabel）', () => {
  it('★★ 料金表にあるモデルは、従来の書式と1文字も違わない', () => {
    for (const known of KNOWN) {
      const p = PRICING[known]
      // 2026-09-25 までの SettingsModal.tsx の書式（2か所に複製されていたもの）を、そのまま書き写した
      expect(priceLabel(known)).toBe(`（入力¥${p.in} / 出力¥${p.out} ・100万トークン）`)
    }
  })

  it('★★★ 料金表に無いモデルには、料金の数字を出さない（実在しない料金をそのモデルの料金として見せない）', () => {
    for (const unknown of [...UNKNOWN, ...PROTO_NAMES]) {
      const label = priceLabel(unknown)
      expect(label).not.toMatch(/[0-9０-９]/)
      expect(label).not.toContain('¥')
      expect(label).toContain('料金表に無い')
    }
  })

  it('★ 知らないモデルの料金を「実際より高い」と断定しない', () => {
    for (const unknown of UNKNOWN) expect(priceLabel(unknown)).not.toMatch(/実際より高/)
  })
})

describe('モデル別の利用額に添える一言（usageCostNote）', () => {
  it('料金表にあるモデルには何も添えない（従来どおり）', () => {
    for (const known of KNOWN) expect(usageCostNote(known)).toBe('')
  })

  it('★★ 料金表に無いモデルの額は、確かな額のように見せない（一言添える・数字は出さない）', () => {
    for (const unknown of [...UNKNOWN, ...PROTO_NAMES]) {
      const note = usageCostNote(unknown)
      expect(note).toContain('料金表に無い')
      expect(note).not.toMatch(/[0-9０-９]/)
    }
  })
})

describe('「単価について」の説明（unknownPriceRuleText）', () => {
  it('知らないモデルを何で数えるかと、その限界を言う', () => {
    const t = unknownPriceRuleText()
    expect(t).toContain('料金表に無いモデル')
    expect(t).toContain(`入力 ¥${DEFAULT_PRICE.in}`)
    expect(t).toContain(`出力 ¥${DEFAULT_PRICE.out}`)
    // 表の最大より高い新モデルは、安く数えうる（正直に書く）
    expect(t).toContain('実際より少なく数えることがあります')
  })
})

// 画面（renderer）の配線。DOM を持たない node 環境なのでソースを読む。
// 掟10: 当て先は呼び出しの形ごと書き、直す前の形（書式の複製）が戻っていないことも見る。
describe('設定画面の配線（SettingsModal.tsx）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/SettingsModal.tsx'), 'utf-8')
  const count = (needle: string) => src.split(needle).length - 1

  it('★★ 2つのモデル選択は、どちらも priceLabel を呼ぶだけ', () => {
    expect(count('{modelPickerText(id).name}{priceLabel(id)}')).toBe(2)
  })

  it('★★ 料金の書式を画面側に複製していない（直す前の形が戻っていない）', () => {
    expect(src).not.toContain('（入力¥{p.in} / 出力¥{p.out} ・100万トークン）')
    // 「単価について」の見出し「（¥/100万トークン）」には当てない。モデル選択の書式の末尾だけを見る
    expect(src).not.toContain('・100万トークン）')
    expect(src).not.toContain('priceFor(id)')
  })

  it('★ モデル別の利用額に、料金表に無いモデルの一言を添える', () => {
    expect(src).toContain('const note = usageCostNote(row.model)')
    expect(src).toContain('{note && <p className="text-[10px] text-ink-muted">{note}</p>}')
  })

  it('「単価について」に、知らないモデルの数え方を出す', () => {
    expect(src).toContain('<p className="pt-1">{unknownPriceRuleText()}</p>')
  })
})
