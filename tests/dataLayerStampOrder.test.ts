import { describe, it, expect, vi } from 'vitest'

// dataLayer.ts は electron の app を（テンプレートの場所を探すためだけに）読み込む。
// ここで見るのは版の印の比べ方だけなので、最小の偽物を置く。
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { dataLayerPlacement, compareDataLayerStamp } from '../src/main/dataLayer'

// ── なぜこのテストが要るか（2026-09-25 検分の指摘27）──────────────────────
// 版の印（`// koto-data-template: 2026-09-24.2`）の比較が**文字列のまま**だった。
// 文字列は桁数を見ないので `'2026-09-24.9' > '2026-09-24.10'` が **true** になる。
// つまり同じ日に10版目を配った瞬間から、利用者の手元にある `.9` のファイルは
// 「もう新しい」と判定され、**差し替えが黙って止まる**（画面にも何も出ない）。
// 混み合ったときのやり直しも同時更新の検知も入らないまま、公開中のアプリが動き続ける。
//
// tests/dataLayerScan.test.ts は `.1 → .2` しか見ていないので素通りした。
// ここは**実物の判断（dataLayerPlacement）に本物のファイルの中身を流して**固定する
// （ソースの文字列は読まない・掟10）。

/** テンプレートと同じ形の中身（印は3行目のコメント）。 */
const stamped = (v: string) => `// koto-data.js\n//\n// koto-data-template: ${v}\nconst BUCKET = ''\n`

describe('版の印は数として比べる（同じ日の10版目でも差し替えが止まらない）', () => {
  it('★★★ 手元が .9 で、配るのが .10 なら差し替える（文字列比較だとここで止まる）', () => {
    expect(dataLayerPlacement(stamped('2026-09-24.9'), stamped('2026-09-24.10'))).toBe('replace')
  })

  it('★★★ 手元が .10 で、配るのが .9 なら差し替えない（古い版を配って巻き戻さない）', () => {
    expect(dataLayerPlacement(stamped('2026-09-24.10'), stamped('2026-09-24.9'))).toBe('up-to-date')
  })

  it('★★ .2 → .11 も、.19 → .20 も、.99 → .100 も差し替える', () => {
    expect(dataLayerPlacement(stamped('2026-09-24.2'), stamped('2026-09-24.11'))).toBe('replace')
    expect(dataLayerPlacement(stamped('2026-09-24.19'), stamped('2026-09-24.20'))).toBe('replace')
    expect(dataLayerPlacement(stamped('2026-09-24.99'), stamped('2026-09-24.100'))).toBe('replace')
  })

  it('★★ 日付が進んだときは、連番の大小に引きずられない', () => {
    // 文字列でも数でも replace だが、日付→連番の順で見ていることを固定する
    expect(dataLayerPlacement(stamped('2026-09-24.10'), stamped('2026-10-01.1'))).toBe('replace')
    expect(dataLayerPlacement(stamped('2026-10-01.1'), stamped('2026-09-24.10'))).toBe('up-to-date')
    expect(dataLayerPlacement(stamped('2026-09-09.1'), stamped('2026-09-10.1'))).toBe('replace')
  })

  it('★ これまでの振る舞いは変わらない（同じ版・古い版・印なし）', () => {
    expect(dataLayerPlacement(stamped('2026-09-24.2'), stamped('2026-09-24.2'))).toBe('up-to-date')
    expect(dataLayerPlacement(stamped('2026-09-24.1'), stamped('2026-09-24.2'))).toBe('replace')
    expect(dataLayerPlacement(null, stamped('2026-09-24.2'))).toBe('place')
    expect(dataLayerPlacement('// データベース版に差し替え済み', stamped('2026-09-24.2'))).toBe('leave-alone')
  })

  it('★ 数字を1つも読めない印どうしは動かさない（分からないときは触らない側へ倒す）', () => {
    expect(compareDataLayerStamp('dev', 'rc')).toBe(0)
    expect(dataLayerPlacement(stamped('dev'), stamped('rc'))).toBe('up-to-date')
  })

  it('比べた向きが逆になっていない（新しい側が正・古い側が負）', () => {
    expect(compareDataLayerStamp('2026-09-24.10', '2026-09-24.9')).toBeGreaterThan(0)
    expect(compareDataLayerStamp('2026-09-24.9', '2026-09-24.10')).toBeLessThan(0)
    expect(compareDataLayerStamp('2026-09-24.2', '2026-09-24.2')).toBe(0)
  })
})
