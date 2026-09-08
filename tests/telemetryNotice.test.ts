import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #30: 画面（AppRunPanel + TelemetryNotice）の配線を固定する。
// 「何をすべきか」の判断そのものは appLog.test.ts（decideTelemetryAction・decideEnableTelemetry）
// で確認済み。ここで確かめるのは、画面がその判断を実際に両方の kind で使っているか、そして
// 「置き場が無い（＝費用が発生する）」ときに、同意（confirming）を経ずに
// 費用の発生する `enable()`（cloud:enableTelemetry）へ辿り着けてしまわないか。
//
// ── #30 検分の指摘2（2026-09-08）───────────────────────────────────────
// 以前のこのファイルは `not.toContain('onClick={enable}')` という**厳密な文字列一致**
// でしか守っておらず、検分役が ask の確認前ボタンを
//   onClick={() => { setError(''); setConfirming(true); void enable() }}
// （＝同意カードを開くのと同時に enable() も呼ぶ）に変異させたところ、33件すべて通過した。
// `onClick={enable}` という「ハンドラそのものが enable 関数」という**完全一致**しか
// 見ておらず、`enable(...)` という**呼び出し**そのものを見ていなかったのが原因。
//
// 直したいまの2段構え（掟10・当て先が他の行に出ないかを必ず確認する、を踏まえる）:
//   ① バックエンド（shared/appLog.ts の decideEnableTelemetry・
//      main/cloud/monitoring.ts の enableTelemetry）が、`consented !== true` のときは
//      課金の始まる初期化を絶対に呼ばない。**画面のボタン配線がどう壊れても、
//      ここが最終防御**（振る舞いは tests/monitoring.test.ts が偽サーバで直接確かめる）。
//   ② ここ（画面側）は「確認前のボタンは enable を一切呼ばない」
//      「同意カードの中だけが enable(true) を呼ぶ」を、
//      **呼び出しの形**（`enable(` を含むかどうか。完全一致ではなく正規表現）で確認する。

const panel = readFileSync(join(__dirname, '..', 'src', 'renderer', 'components', 'AppRunPanel.tsx'), 'utf-8')
const notice = readFileSync(join(__dirname, '..', 'src', 'renderer', 'components', 'TelemetryNotice.tsx'), 'utf-8')

describe('画面にログ・メトリクスの案内が両方出る（#30）', () => {
  it('AppRunPanel は TelemetryNotice を logs・metrics 両方の kind で描画する', () => {
    expect(panel).toContain('import TelemetryNotice')
    expect(panel).toContain('<TelemetryNotice projectDir={projectDir} kind="logs" />')
    expect(panel).toContain('<TelemetryNotice projectDir={projectDir} kind="metrics" />')
  })

  // ★ ログのUIを複製してメトリクス用を別に書くと、この形（同じ部品名を2回描画）が崩れる
  it('ログ・メトリクスは同じ部品（TelemetryNotice）で、判断を複製していない', () => {
    const count = (panel.match(/<TelemetryNotice /g) ?? []).length
    expect(count).toBe(2)
  })

  it('ログ用・メトリクス用に画面を複製していない（専用コンポーネントを別に作っていない）', () => {
    // 「メトリクス」の案内だけの専用コンポーネントファイルを別に作っていないこと
    expect(panel).not.toMatch(/MetricsNotice|LogNotice/)
  })
})

/**
 * TelemetryNotice.tsx の3ブロック（route / ask-確認前 / ask-確認中＝同意カード）を、
 * 一意の見出しから次の見出しの直前までで切り出す。
 * **範囲の切り出しを固定オフセットにせず、境界をそれぞれ assert してから使う**
 * （掟10: ソースを読んで確かめるテストは、当て先が他の行にも出ないか必ず確認する）。
 */
function extractBlocks(src: string) {
  const routeAt = src.indexOf("action.kind === 'route'")
  const askAt = src.indexOf("action.kind === 'ask'")
  const confirmingAt = src.indexOf('confirming ? (', askAt)
  const elseAt = src.indexOf(') : (', confirmingAt)
  const askBlockEnd = src.indexOf('{error &&', elseAt)
  expect(routeAt).toBeGreaterThan(-1)
  expect(askAt).toBeGreaterThan(routeAt)
  expect(confirmingAt).toBeGreaterThan(askAt)
  expect(elseAt).toBeGreaterThan(confirmingAt)
  expect(askBlockEnd).toBeGreaterThan(elseAt)
  return {
    routeBlock: src.slice(routeAt, askAt),
    confirmingBlock: src.slice(confirmingAt, elseAt), // 同意カードの中（同意済みのときだけ）
    unconfirmedBlock: src.slice(elseAt, askBlockEnd), // 確認前の最初のボタン（まだ同意していない）
  }
}

describe('TelemetryNotice は同意なしに費用の発生する初期化を呼ばない（#30 検分の指摘2）', () => {
  const { routeBlock, confirmingBlock, unconfirmedBlock } = extractBlocks(notice)

  // ★ 検分役の変異（同意カードを開くのと同時に enable() も呼ぶ）が二度と通らないための核心。
  //   `onClick={enable}` という完全一致ではなく、`enable(` という**呼び出しの形**そのもので見る。
  it('確認前のボタン（同意していない）は、enable を一切呼ばない', () => {
    expect(unconfirmedBlock).not.toMatch(/\benable\s*\(/)
    expect(unconfirmedBlock).toContain('setConfirming(true)')
  })

  it('費用が発生する enable(true) は、同意カード（confirming）の中だけで呼ばれる', () => {
    expect(confirmingBlock).toContain('enable(true)')
    expect(confirmingBlock).toContain('月額の基本料金')
    expect(unconfirmedBlock).not.toContain('enable(true)')
    expect(routeBlock).not.toContain('enable(true)')
  })

  it('保存場所が既にある（route）ときは、追加費用が無い旨を示してから enable(false) を呼ぶ', () => {
    expect(routeBlock).toContain('追加費用はありません')
    expect(routeBlock).toContain('enable(false)')
  })

  // ★ 変異試験④が壊す想定: 確認前のボタンが enable(true) を呼び、同意カードを飛ばす
  it('ファイル全体で enable(true) の呼び出しは1箇所だけ（同意カードの外に漏れていない）', () => {
    const matches = notice.match(/enable\(true\)/g) ?? []
    expect(matches.length).toBe(1)
  })

  // ★ 万一 ①・②の画面側の歯止めが破られても（例: 上のテストが見落とす形で変異しても）、
  //   main 側は `consented` の値をそのまま使うだけで、画面の意図を推測しない。
  //   つまり実際に課金を止めているのは main 側（decideEnableTelemetry・
  //   tests/monitoring.test.ts）であり、ここは「画面が正しく意図を伝えているか」の確認である。
  it('enableTelemetry の呼び出しは、そのつど consented を明示的に渡している（真偽値を省略していない）', () => {
    const calls = notice.match(/electronAPI\.cloud\.enableTelemetry\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call).toMatch(/consented/)
  })
})
