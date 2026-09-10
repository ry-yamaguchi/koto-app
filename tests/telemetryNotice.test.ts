import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refetchStatusForConsent } from '../src/renderer/components/TelemetryNotice'

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

// ══════════════════════════════════════════════════════════════════════════
// 2026-09-10 検分の直し: enable() が needsConsent を受けたとき、setConfirming(true)
// だけでは何も起きない（action.kind === 'route' の分岐は confirming を描画しない）。
// jsdom 等の DOM テスト基盤がこのプロジェクトには無く、実際にクリックして確かめる
// テストは書けない。**可能な範囲で**、直した判断（refetchStatusForConsent）を
// 純関数として呼び出し、偽の telemetryStatus を渡して振る舞いで固定する
// （文字列一致は「そう書いてあるか」しか見ない・掟10）。
// ══════════════════════════════════════════════════════════════════════════
describe('refetchStatusForConsent: needsConsent を受けたときの状態の取り直し', () => {
  it('取り直しに成功 → ok:true と、取り直した action をそのまま返す（呼び出し側が setAction に使う）', async () => {
    const askAction = { kind: 'ask' as const, note: 'メトリクスの保存場所を新しく用意します。' }
    const r = await refetchStatusForConsent(async () => ({ ok: true, action: askAction }), '/proj', 'metrics')
    expect(r).toEqual({ ok: true, action: askAction })
  })

  it('action が無い応答（ok:true だが action 未定義）は null を返す（存在しないものを作らない）', async () => {
    const r = await refetchStatusForConsent(async () => ({ ok: true }), '/proj', 'metrics')
    expect(r).toEqual({ ok: true, action: null })
  })

  it('★ 取り直しが ok:false → ok:false（呼び出し側はエラーを出す。同意カードへは進めない）', async () => {
    const r = await refetchStatusForConsent(async () => ({ ok: false }), '/proj', 'metrics')
    expect(r).toEqual({ ok: false })
  })

  it('★ 取り直しが例外を投げても落ちない（ok:false として扱う）', async () => {
    const r = await refetchStatusForConsent(async () => { throw new Error('network error') }, '/proj', 'metrics')
    expect(r).toEqual({ ok: false })
  })

  it('projectDir・kind をそのまま渡す（別プロジェクト・別種類の状態を読まない）', async () => {
    let seen: [string, string] | null = null
    await refetchStatusForConsent(async (dir, kind) => { seen = [dir, kind]; return { ok: true, action: null } }, '/proj-x', 'logs')
    expect(seen).toEqual(['/proj-x', 'logs'])
  })
})

describe('TelemetryNotice: enable() の needsConsent 分岐は refetchStatusForConsent を経由してから同意カードへ進む', () => {
  // enable 関数だけを切り出す（掟10: 当て先が他の行に出ないか確認する。次の関数の
  // 直前のコメントで止め、render 側の JSX に迷い込まない一意な境界にする）。
  const enableAt = notice.indexOf('const enable = async (consented: boolean) => {')
  const enableEnd = notice.indexOf('// 確認できない間（読み込み中・未公開・API失敗）は黙る', enableAt)
  expect(enableAt).toBeGreaterThan(-1)
  expect(enableEnd).toBeGreaterThan(enableAt)
  const enableBody = notice.slice(enableAt, enableEnd)

  // 実装の説明コメント（例: 「⚠️ ここで setConfirming(true) するだけでは…」）にも
  // 同じ文字列が登場する（掟10: 当て先が他の行にも出ないか必ず確認する）。
  // 行コメントを除いてから探すことで、実際の呼び出しだけを見る。
  const stripLineComments = (s: string) => s.replace(/\/\/[^\n]*/g, '')

  it('needsConsent の分岐は refetchStatusForConsent を呼んでいる（setConfirming(true) だけで済ませない）', () => {
    const needsConsentAt = enableBody.indexOf('r.needsConsent')
    expect(needsConsentAt).toBeGreaterThan(-1)
    const branch = enableBody.slice(needsConsentAt)
    expect(branch).toContain('refetchStatusForConsent(')
  })

  // ★ 直す前の穴（setConfirming(true) を呼ぶだけ）に戻っていないことを、呼び出しの
  //   順序で固定する。refetchStatusForConsent の**後**に setConfirming(true) が来ること。
  //   コメント中の言及を拾わないよう、行コメントを除いた本文（コード）だけで比べる。
  it('★ setConfirming(true) は refetchStatusForConsent の呼び出しより後（取り直す前に同意カードを開かない）', () => {
    const needsConsentAt = enableBody.indexOf('r.needsConsent')
    const branch = stripLineComments(enableBody.slice(needsConsentAt))
    const refetchAt = branch.indexOf('refetchStatusForConsent(')
    const setConfirmingAt = branch.indexOf('setConfirming(true)')
    expect(refetchAt).toBeGreaterThan(-1)
    expect(setConfirmingAt).toBeGreaterThan(-1)
    expect(setConfirmingAt).toBeGreaterThan(refetchAt)
  })

  it('取り直した action を setAction している（route のまま固まらない）', () => {
    const needsConsentAt = enableBody.indexOf('r.needsConsent')
    const branch = enableBody.slice(needsConsentAt)
    expect(branch).toContain('setAction(refetched.action)')
  })

  it('取り直しに失敗したときのエラー文言を出す', () => {
    expect(enableBody).toContain('保存場所の状態を確認できませんでした。もう一度お試しください')
  })
})
