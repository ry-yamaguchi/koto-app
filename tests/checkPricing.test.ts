import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
// @ts-expect-error — ビルド用スクリプト（型定義は持たない）
import { parsePricingPage, apiIdCandidate, comparePricing, exitCodeFor, formatReport, registrationLines, parseYenPerMillion, PricingPageError, MIN_PRICED_ROWS } from '../scripts/lib/pricingPage.mjs'
// @ts-expect-error — ビルド用スクリプト（型定義は持たない）
import { parseAppConfig, readAppConfig, NON_CHAT } from '../scripts/lib/appConfig.mjs'
import { PRICING } from '../src/shared/usageBudget'
import { MODELS, VISION_MODELS, DEFAULT_MODEL } from '../src/shared/modelInfo'

// ── なぜ要るか（2026-09-25）──────────────────────────────────────────────
// 新しいモデルが増えたときの料金（お金の歯止め）を、キー無しで公式の料金表と突き合わせる
// npm run check:pricing（scripts/check-pricing.mjs）の読み取り・照合を固定する。
// 最悪の誤診は「ページの形が変わって読めていないのに『全部一致』と言う」こと。
// 読めた行が少なすぎれば差分を出さずに止まる、を振る舞いで固定する（掟10）。
//
// 下の HTML は**自分で書いた短いもの**で、さくらのページの構造だけを真似ている
// （rowspan のカテゴリ列・3つの区分・プレビューの行・対象外の行・Embeddings の行・
//   料金が Input/Output の形でない行（音声認識・rowspan で続く音声合成・カテゴリ列だけの RAG）・
//   描画用 <script> の中の複写）。モデル名・料金は架空。

const tok = (yen: string) => `<dd>${yen}円 <span>/ 10,000トークン</span></dd>`
const price = (i: string, o: string) =>
  `<dl class="p-in"><dt>Input</dt>${tok(i)}</dl><dl class="p-out"><dt>Output</dt>${o === '無料' ? '<dd>無料</dd>' : tok(o)}</dl>`

const STANDARD = `
<h3 class="headline">通常モデル</h3>
<table class="t"><thead>
<tr><th rowSpan="2">カテゴリー</th><th rowSpan="2">提供モデル</th><th rowSpan="2">無償プラン</th><th colSpan="2">従量課金</th></tr>
<tr><th><span>無償枠</span></th><th><span>超過分</span></th></tr></thead><tbody>
<tr><th rowSpan="2"><b>Chat completions</b></th><th>alpha-large</th><td rowSpan="2">月 100 回まで</td><td rowSpan="2">月 100 回まで</td><td>${price('0.15', '0.75')}</td></tr>
<tr><th>beta-mid-ja</th><td>${price('0.57', '0.07')}</td></tr>
<tr><th><b>Audio transcription</b></th><th>whisper-tiny</th><td>月 5 回</td><td>月 5 回</td><td><p>0.5円 <span>/ 60秒</span></p></td></tr>
<tr><th><b>Embeddings</b></th><th>tiny-e5-base</th><td>月 10 回</td><td>月 10 回</td><td>${price('2', '無料')}</td></tr>
<tr><th rowSpan="2"><b>Text-to-Speech</b></th><th>VOICEVOX:架空A</th><td rowSpan="2">月 5 回</td><td rowSpan="2">月 5 回</td><td rowSpan="2"><p>3円 <span>/ 10,000モーラ</span></p></td></tr>
<tr><th>VOICEVOX:架空B</th></tr>
<tr><th colSpan="2"><b>ドキュメント（RAG）</b></th><td colSpan="3"><p>3円<span>/ 100チャンク</span></p></td></tr>
</tbody></table>`

const CLOSED = `
<h3 class="headline">クローズドモデル料金</h3>
<table class="t"><thead><tr><th>カテゴリー</th><th>提供モデル・提供元</th><th>無償プラン</th><th>従量課金</th></tr></thead><tbody>
<tr><th rowSpan="2"><b>Chat Completions</b></th><th>提供モデル：Secret One<br/>提供元：Example社</th><td rowSpan="2">対象外</td><td rowSpan="2">お問い合わせください</td></tr>
<tr><th>提供モデル：Secret Two<sup>※</sup><br/>提供元：Other社</th></tr>
</tbody></table>`

const PREVIEW_ROWS = {
  gamma: `<tr><th>gamma-7b<br/><span>(2026年1月2日〜)</span></th><td rowSpan="3">月 100 回まで</td><td rowSpan="3">月 100 回まで</td><td>${price('0.1', '0.3')}</td></tr>`,
  delta: `<tr><th>delta-9b<br/><span>(2026年3月4日〜)</span></th><td>${price('0.01', '0.03')}</td></tr>`,
  eta: `<tr><th>eta-code-32b<br/><span>(2026年5月6日〜)</span></th><td>${price('0.52', '5.04')}</td></tr>`,
  epsilon: `<tr><th>epsilon-Embedding-1B<br/><span>(2026年7月8日〜)</span></th><td>月 10 回</td><td>月 10 回</td><td>${price('3', '無料')}</td></tr>`,
  zeta: `<tr><th>zeta-med-20b<br/><span>(2026年9月24日〜)</span></th><td>対象外</td><td>対象外</td><td>${price('0.9', '4.5')}</td></tr>`,
}
const preview = (rows: string[]) => `
<h3 class="headline">パブリックプレビューモデル</h3>
<table class="t"><thead>
<tr><th rowSpan="2">提供モデル</th><th rowSpan="2">無償プラン</th><th colSpan="2">従量課金</th></tr>
<tr><th><span>無償枠</span></th><th><span>超過分</span></th></tr></thead><tbody>
${rows.join('\n')}
</tbody></table>`

// ページ描画用 <script> の中の複写（実物は JSON 文字列）。ここに**だけ**ある theta-ghost と、
// 表と同じ gamma-7b を入れておく。script を数えると、架空の新顔と二重の行が出る。
const SCRIPT_COPY = `<script>self.__copy = "<h3>パブリックプレビューモデル</h3><table><tbody><tr><th>gamma-7b</th><td>${price('0.1', '0.3')}</td></tr><tr><th>theta-ghost</th><td>${price('1', '2')}</td></tr></tbody></table>";</script>`

const page = (body: string) => `<!DOCTYPE html><html lang="ja"><head><title>架空の料金ページ</title></head><body>
<h2>提供モデルと料金</h2>${body}
${SCRIPT_COPY}
</body></html>`

const FULL_HTML = page(STANDARD + CLOSED + preview(Object.values(PREVIEW_ROWS)))

// 架空の Koto の PRICING（¥/100万トークン）。5分類がそれぞれ1件以上出るように組む
const KOTO = {
  'alpha-large': { in: 15, out: 75 },          // 一致
  'beta-mid-ja': { in: 57, out: 7 },           // 一致（0.57・0.07 の ×100 は丸めないと端数が出る）
  'preview/gamma-7b': { in: 10, out: 30 },     // 一致
  'preview/delta-9b': { in: 1, out: 4 },       // 食い違い（公式は 1 / 3）
  'preview/eta-code-32b': { in: 52, out: 504 },// 一致
  'preview/old-model': { in: 5, out: 5 },      // Koto にだけある
}                                              // zeta-med-20b は新顔

// 架空の Koto の PRICING のうち、FULL_HTML のチャット用の行と全部一致するもの
const KOTO_ALL = {
  'alpha-large': { in: 15, out: 75 }, 'beta-mid-ja': { in: 57, out: 7 },
  'preview/gamma-7b': { in: 10, out: 30 }, 'preview/delta-9b': { in: 1, out: 3 },
  'preview/eta-code-32b': { in: 52, out: 504 }, 'preview/zeta-med-20b': { in: 90, out: 450 },
}

// describe の直下では計算しない（例外が出るとファイルごと読めず、どの振る舞いが壊れたか分からない）
const byNameIn = (html: string) => (n: string) => parsePricingPage(html).find((r: any) => r.name === n)

describe('parsePricingPage — 料金表の行を読む', () => {
  const rows = () => parsePricingPage(FULL_HTML)
  const byName = byNameIn(FULL_HTML)

  it('★ モデル名のある行を（料金を読めない行も）ページの順に読む（script の中の複写は数えない）', () => {
    expect(rows().map((r: any) => r.name)).toEqual([
      'alpha-large', 'beta-mid-ja', 'whisper-tiny', 'tiny-e5-base', 'VOICEVOX:架空A', 'VOICEVOX:架空B',
      'Secret One', 'Secret Two',
      'gamma-7b', 'delta-9b', 'eta-code-32b', 'epsilon-Embedding-1B', 'zeta-med-20b',
    ])
  })

  it('★★ script の中の複写を二重に数えない（script にだけある行を拾わない）', () => {
    expect(rows().filter((r: any) => r.name === 'gamma-7b')).toHaveLength(1)
    expect(byName('theta-ghost')).toBeUndefined()
    // 照合まで通しても、二重の行で止まらない＝ちょうど1回ずつ数えている
    expect(() => comparePricing(rows(), KOTO)).not.toThrow()
  })

  it('rowspan の先頭行でも、モデル名はカテゴリ列ではなく名前の列から読む', () => {
    expect(byName('alpha-large')).toMatchObject({ section: 'standard', in: 15, out: 75, since: null })
    expect(byName('Chat completions')).toBeUndefined()
    expect(byName('Text-to-Speech')).toBeUndefined()
  })

  it('★ カテゴリ列だけの行（RAG: <th colSpan="2"><b>…</b></th>）はモデル名のセルが無いので、モデルの行として読まない', () => {
    expect(byName('ドキュメント（RAG）')).toBeUndefined()
  })

  it('ただしカテゴリ列だけの行でも、料金（Input/Output）を読めるなら落とさない（外しすぎない）', () => {
    const omega = `<tr><th colSpan="2"><b>omega-chat</b></th><td colSpan="2">月 1 回</td><td>${price('0.2', '0.4')}</td></tr>`
    const html = page(STANDARD.replace('</tbody>', `${omega}\n</tbody>`) + CLOSED + preview(Object.values(PREVIEW_ROWS)))
    expect(byNameIn(html)('omega-chat')).toMatchObject({ section: 'standard', in: 20, out: 40 })
    expect(comparePricing(parsePricingPage(html), KOTO_ALL).newcomers.map((n: any) => n.id)).toEqual(['omega-chat'])
  })

  it('★ 料金が Input/Output の形でない行も落とさず、in/out を null で返す（照合で判定する）', () => {
    expect(byName('whisper-tiny')).toMatchObject({ section: 'standard', in: null, out: null })
    // rowspan で続く音声合成の行（続きの行はモデル名のセルだけ）
    expect(byName('VOICEVOX:架空A')).toMatchObject({ section: 'standard', in: null, out: null })
    expect(byName('VOICEVOX:架空B')).toMatchObject({ section: 'standard', in: null, out: null })
  })

  it('区分を <h3> の見出しから決める（通常・クローズド・プレビュー）', () => {
    expect(byName('beta-mid-ja').section).toBe('standard')
    expect(byName('Secret One').section).toBe('closed')
    expect(byName('gamma-7b').section).toBe('preview')
  })

  it('プレビューの行から提供開始日を読み、名前に日付を混ぜない', () => {
    expect(byName('gamma-7b')).toMatchObject({ since: '2026-01-02', in: 10, out: 30 })
    expect(byName('zeta-med-20b').since).toBe('2026-09-24')
  })

  it('クローズドは名前（「提供モデル：」と ※ を除く）と提供元を読み、料金は null', () => {
    expect(byName('Secret One')).toMatchObject({ provider: 'Example社', in: null, out: null })
    expect(byName('Secret Two')).toMatchObject({ provider: 'Other社', in: null, out: null })
  })

  it('★ 対象外の行 → 無償枠なし。無償枠のある行は無償枠なしにしない', () => {
    expect(byName('zeta-med-20b').noFreeTier).toBe(true)
    expect(byName('gamma-7b').noFreeTier).toBe(false)
    expect(byName('delta-9b').noFreeTier).toBe(false)
  })

  it('Output が「無料」の行（Embeddings）は 0 として読む', () => {
    expect(byName('tiny-e5-base')).toMatchObject({ in: 200, out: 0 })
  })

  it('rowspan で下の行へ及ぶ「対象外」と料金のセルを引き継ぐ（無償枠なしを言い落とさない）', () => {
    const html = page(preview([
      `<tr><th>kappa-a</th><td rowSpan="2">対象外</td><td rowSpan="2">${price('0.2', '0.4')}</td></tr>`,
      `<tr><th>kappa-b</th></tr>`,
      `<tr><th>kappa-c</th><td>月 1 回</td><td>${price('0.3', '0.6')}</td></tr>`,
    ]))
    const r = parsePricingPage(html)
    expect(r.map((x: any) => [x.name, x.in, x.out, x.noFreeTier])).toEqual([
      ['kappa-a', 20, 40, true],
      ['kappa-b', 20, 40, true],
      ['kappa-c', 30, 60, false],
    ])
  })
})

describe('円の換算（公式は 1万トークンあたり・Koto は 100万トークンあたり）', () => {
  it('★★ ×100 で浮動小数の端数を出さない（0.57 → 57・0.07 → 7・1.1 → 110）', () => {
    // 0.57 * 100 は 56.99999999999999、0.07 * 100 は 7.000000000000001 になる（実測）
    expect(parseYenPerMillion('0.57円 <span>/ 10,000トークン</span>')).toBe(57)
    expect(parseYenPerMillion('0.07円 <span>/ 10,000トークン</span>')).toBe(7)
    expect(parseYenPerMillion('1.1円 <span>/ 10,000トークン</span>')).toBe(110)
    expect(parseYenPerMillion('0.52円 <span>/ 10,000トークン</span>')).toBe(52)
    expect(parseYenPerMillion('5.04円 <span>/ 10,000トークン</span>')).toBe(504)
  })

  it('★ 読んだ行でも端数が出ない（照合で食い違いにしない）', () => {
    const r = parsePricingPage(FULL_HTML).find((x: any) => x.name === 'beta-mid-ja')
    expect(r.in).toBe(57)
    expect(r.out).toBe(7)
  })

  it('単位の数を読んで換算する（1万トークン・100万トークン）。トークン以外の単位は読まない', () => {
    expect(parseYenPerMillion('0.9円 / 1万トークン')).toBe(90)
    expect(parseYenPerMillion('90円 / 1,000,000トークン')).toBe(90)
    expect(parseYenPerMillion('0.5円 <span>/ 60秒</span>')).toBeNull()
    expect(parseYenPerMillion('お問い合わせください')).toBeNull()
    expect(parseYenPerMillion('無料')).toBe(0)
  })
})

describe('apiIdCandidate — 区分から API 名の候補を導く', () => {
  const byName = byNameIn(FULL_HTML)
  it('通常 → 表の名前そのまま・プレビュー → preview/＋表の名前・クローズド → 導かない', () => {
    expect(apiIdCandidate(byName('alpha-large'))).toBe('alpha-large')
    expect(apiIdCandidate(byName('gamma-7b'))).toBe('preview/gamma-7b')
    expect(apiIdCandidate(byName('Secret One'))).toBeNull()
    expect(apiIdCandidate({ name: 'x', section: 'unknown' })).toBeNull()
  })
})

describe('comparePricing — 5つに分ける', () => {
  let result: any
  beforeAll(() => { result = comparePricing(parsePricingPage(FULL_HTML), KOTO) })

  it('★ 一致', () => {
    expect(result.matched.map((m: any) => m.id)).toEqual(['alpha-large', 'beta-mid-ja', 'preview/gamma-7b', 'preview/eta-code-32b'])
  })
  it('★ 食い違い（公式と Koto の両方の値を持つ）', () => {
    expect(result.mismatched).toEqual([
      { id: 'preview/delta-9b', name: 'delta-9b', section: 'preview', official: { in: 1, out: 3 }, koto: { in: 1, out: 4 } },
    ])
  })
  it('★ 新顔（公式にあって Koto に無い）', () => {
    expect(result.newcomers).toHaveLength(1)
    expect(result.newcomers[0]).toMatchObject({ id: 'preview/zeta-med-20b', in: 90, out: 450, noFreeTier: true, since: '2026-09-24' })
  })
  it('★ Koto にだけある（提供終了の可能性）', () => {
    expect(result.kotoOnly.map((k: any) => k.id)).toEqual(['preview/old-model'])
  })
  it('★ クローズド（料金非公開）', () => {
    expect(result.closed).toEqual([
      { name: 'Secret One', provider: 'Example社' },
      { name: 'Secret Two', provider: 'Other社' },
    ])
  })
  it('★ チャット用でないもの（音声認識・Embeddings・e5・音声合成）は外す（新顔にも一致にも、料金を読めなかった行にも出さない）', () => {
    expect(result.excluded).toEqual(['whisper-tiny', 'tiny-e5-base', 'VOICEVOX:架空A', 'VOICEVOX:架空B', 'epsilon-Embedding-1B'])
    const all = [...result.matched, ...result.mismatched, ...result.newcomers, ...result.unreadable].map((x: any) => x.name)
    for (const n of result.excluded) expect(all).not.toContain(n)
  })
  it('差分があれば終了コード 1', () => {
    expect(exitCodeFor(result)).toBe(1)
  })
  it('全部一致なら終了コード 0（クローズドは数えない）', () => {
    const r = comparePricing(parsePricingPage(FULL_HTML), KOTO_ALL)
    expect(r.matched).toHaveLength(6)
    expect(r.closed).toHaveLength(2)
    // 料金の形が違う正当な行（音声認識・音声合成の続き・RAG）は「料金を読めなかった行」にしない
    expect(r.unreadable).toEqual([])
    expect(exitCodeFor(r)).toBe(0)
    expect(formatReport(r, { today: '2026-09-25' }).join('\n')).toContain('差分なし')
  })
  it('区分が変わった（プレビュー → 通常）ときは、新顔と Koto にだけある の両方に手がかりを出す', () => {
    const r = comparePricing(parsePricingPage(FULL_HTML), { ...KOTO, 'preview/alpha-large': { in: 15, out: 75 } })
    expect(r.kotoOnly.find((k: any) => k.id === 'preview/alpha-large').sameNameOnPage).toBe('alpha-large')
  })
})

describe('★★★ 読めないページで「一致」と言わない（ページの形が変わった）', () => {
  it(`料金を読めたチャット用の行が ${MIN_PRICED_ROWS}件未満なら、差分を出さずに例外`, () => {
    // Koto の PRICING がちょうど読めた4行と同じ → 門が無いと「全部一致（終了コード 0）」と言ってしまう
    const html = page(STANDARD + preview([PREVIEW_ROWS.gamma, PREVIEW_ROWS.delta]))
    const rows = parsePricingPage(html)
    const four = {
      'alpha-large': { in: 15, out: 75 }, 'beta-mid-ja': { in: 57, out: 7 },
      'preview/gamma-7b': { in: 10, out: 30 }, 'preview/delta-9b': { in: 1, out: 3 },
    }
    expect(() => comparePricing(rows, four)).toThrow(PricingPageError)
  })

  it('料金の書き方が変わって1行も読めない → 例外（全部 Koto にだけある、とも言わない）', () => {
    const changed = FULL_HTML.replace(/<dt>Input<\/dt>/g, '<dt>入力</dt>').replace(/<dt>Output<\/dt>/g, '<dt>出力</dt>')
    expect(() => comparePricing(parsePricingPage(changed), KOTO)).toThrow(/ページの形が変わった/)
  })

  it('見出し（区分）が読めない → 例外（区分の分からない行は数えない）', () => {
    const noHeadings = FULL_HTML.replace(/<h3\b[^>]*>[\s\S]*?<\/h3>/g, '')
    expect(() => comparePricing(parsePricingPage(noHeadings), KOTO)).toThrow(PricingPageError)
  })

  it('空のページ → 例外', () => {
    expect(() => comparePricing(parsePricingPage('<html><body>メンテナンス中</body></html>'), KOTO)).toThrow(PricingPageError)
  })

  it('同じモデルの行が2回読めた（二重に数えている）→ 例外', () => {
    const twice = page(STANDARD + preview(Object.values(PREVIEW_ROWS)) + preview([PREVIEW_ROWS.gamma]))
    expect(() => comparePricing(parsePricingPage(twice), KOTO)).toThrow(/2回/)
  })

  it('コメント・noscript の中の複写も数えない', () => {
    const copy = `<table><tbody><tr><th>gamma-7b</th><td>${price('0.1', '0.3')}</td></tr></tbody></table>`
    const html = FULL_HTML.replace('</body>', `<!-- ${copy} --><noscript>${copy}</noscript></body>`)
    expect(parsePricingPage(html).filter((r: any) => r.name === 'gamma-7b')).toHaveLength(1)
  })

  it('Koto の PRICING が空 → 例外（全部を新顔と言わない）', () => {
    expect(() => comparePricing(parsePricingPage(FULL_HTML), {})).toThrow(PricingPageError)
  })
})

describe('★★★ 料金を読めない行を黙って捨てない（1行だけ形が違う・2026-09-26 検分）', () => {
  // 既存の6行は Koto と全部一致している。そこへ料金を読めないチャット用の行が1つ加わる。
  // 捨てると「差分なし・終了コード 0」になる（最悪の誤診）
  const iota = (priceCell: string) =>
    `<tr><th>iota-new-8b<br/><span>(2026年9月26日〜)</span></th><td>月 1 回</td><td>月 1 回</td><td>${priceCell}</td></tr>`
  const withPreviewRow = (row: string) => page(STANDARD + CLOSED + preview([...Object.values(PREVIEW_ROWS), row]))

  const shapes: [string, string][] = [
    ['<p> で書かれた料金', '<p>0.5円 <span>/ 10,000トークン</span></p>'],
    ['「お問い合わせください」', '<p>お問い合わせください</p>'],
    ['見出しが日本語（<dt>入力</dt>）', '<dl><dt>入力</dt><dd>0.5円 <span>/ 10,000トークン</span></dd></dl><dl><dt>出力</dt><dd>1円 <span>/ 10,000トークン</span></dd></dl>'],
  ]
  for (const [label, cell] of shapes) {
    it(`★ プレビューの新しい行の料金が${label} → 料金を読めなかった行・終了コード 1（差分なしと言わない）`, () => {
      const r = comparePricing(parsePricingPage(withPreviewRow(iota(cell))), KOTO_ALL)
      expect(r.matched).toHaveLength(6)
      expect(r.unreadable).toEqual([
        { id: 'preview/iota-new-8b', name: 'iota-new-8b', section: 'preview', since: '2026-09-26', in: null, out: null, koto: null, sameNameInKoto: null },
      ])
      expect(r.newcomers).toEqual([]) // 料金の分からない行に登録案を出さない
      expect(exitCodeFor(r)).toBe(1)
      const report = formatReport(r, { today: '2026-09-26' }).join('\n')
      expect(report).toContain('料金を読めなかった行 1件')
      expect(report).toContain('● 料金を読めなかった行')
      expect(report).toContain('iota-new-8b（パブリックプレビュー・2026-09-26 提供開始）→ API 名の候補: preview/iota-new-8b')
      expect(report).not.toContain('差分なし')
    })
  }

  it('★ 通常の表（Chat completions）に加わった行でも同じ', () => {
    const lambda = `<tr><th><b>Chat completions</b></th><th>lambda-std</th><td>月 1 回</td><td>月 1 回</td><td><p>お問い合わせください</p></td></tr>`
    const html = page(STANDARD.replace('</tbody>', `${lambda}\n</tbody>`) + CLOSED + preview(Object.values(PREVIEW_ROWS)))
    const r = comparePricing(parsePricingPage(html), KOTO_ALL)
    expect(r.unreadable.map((u: any) => [u.id, u.section])).toEqual([['lambda-std', 'standard']])
    expect(exitCodeFor(r)).toBe(1)
  })

  it('★ 片方（出力）だけ読めない行も、料金を読めなかった行（読めた値は添える）', () => {
    const cell = `<dl><dt>Input</dt>${tok('0.5')}</dl><dl><dt>Output</dt><dd>お問い合わせください</dd></dl>`
    const r = comparePricing(parsePricingPage(withPreviewRow(iota(cell))), KOTO_ALL)
    expect(r.unreadable).toHaveLength(1)
    expect(r.unreadable[0]).toMatchObject({ id: 'preview/iota-new-8b', in: 50, out: null })
    expect(exitCodeFor(r)).toBe(1)
    expect(formatReport(r, { today: '2026-09-26' }).join('\n')).toContain('読めた値: 入力 50 / 出力 読めず')
  })

  it('★ Koto に載っているモデルの料金の書き方が変わった → 料金を読めなかった行（一致にも「Koto にだけある」にもしない）', () => {
    const gammaChanged = PREVIEW_ROWS.gamma.replace(price('0.1', '0.3'), '<p>0.1円 <span>/ 10,000トークン</span></p>')
    const html = page(STANDARD + CLOSED + preview([gammaChanged, PREVIEW_ROWS.delta, PREVIEW_ROWS.eta, PREVIEW_ROWS.epsilon, PREVIEW_ROWS.zeta]))
    const r = comparePricing(parsePricingPage(html), KOTO_ALL)
    expect(r.unreadable).toEqual([
      { id: 'preview/gamma-7b', name: 'gamma-7b', section: 'preview', since: '2026-01-02', in: null, out: null, koto: { in: 10, out: 30 }, sameNameInKoto: null },
    ])
    expect(r.matched.map((m: any) => m.id)).not.toContain('preview/gamma-7b')
    expect(r.kotoOnly).toEqual([])
    expect(exitCodeFor(r)).toBe(1)
    expect(formatReport(r, { today: '2026-09-26' }).join('\n')).toContain('Koto には preview/gamma-7b として載っています（入力 10 / 出力 30）')
  })

  it('チャット用でない名前（NON_CHAT に当たる）の行は、料金を読めなくても報告しない', () => {
    const r = comparePricing(parsePricingPage(withPreviewRow(iota('<p>1円 / 60秒</p>').replace('iota-new-8b', 'iota-whisper-8b'))), KOTO_ALL)
    expect(r.unreadable).toEqual([])
    expect(r.excluded).toContain('iota-whisper-8b')
    expect(exitCodeFor(r)).toBe(0)
  })
})

describe('★ Koto 側のチャット用でない id を「提供終了の可能性」と誤報しない', () => {
  it('Koto の PRICING に NON_CHAT に当たる id があっても、Koto にだけある にしない（照合しなかったと添える）', () => {
    const withNonChat = { ...KOTO_ALL, 'tiny-e5-base': { in: 200, out: 0 }, 'whisper-gone-v9': { in: 1, out: 1 } }
    const r = comparePricing(parsePricingPage(FULL_HTML), withNonChat)
    expect(r.kotoOnly).toEqual([])
    expect(r.kotoExcluded).toEqual(['tiny-e5-base', 'whisper-gone-v9'])
    expect(exitCodeFor(r)).toBe(0)
    const report = formatReport(r, { today: '2026-09-26' }).join('\n')
    expect(report).toContain('Koto の PRICING のうちチャット用でないので照合しなかったもの: tiny-e5-base、whisper-gone-v9')
    expect(report).not.toContain('提供終了の可能性')
  })

  it('チャット用の id が公式に無ければ、従来どおり Koto にだけある', () => {
    const r = comparePricing(parsePricingPage(FULL_HTML), { ...KOTO_ALL, 'preview/old-model': { in: 5, out: 5 } })
    expect(r.kotoOnly.map((k: any) => k.id)).toEqual(['preview/old-model'])
    expect(r.kotoExcluded).toEqual([])
    expect(exitCodeFor(r)).toBe(1)
  })
})

describe('登録案（新顔にそのまま貼れる行）', () => {
  let result: any
  let lines: string[] = []
  let text = ''
  beforeAll(() => {
    result = comparePricing(parsePricingPage(FULL_HTML), KOTO)
    lines = registrationLines(result.newcomers[0], { today: '2026-09-25' })
    text = lines.join('\n')
  })

  it('★ PRICING の1行（¥/100万トークン・1万tok あたりの公式値と日付のコメント付き）', () => {
    expect(lines).toContain("      'preview/zeta-med-20b': { in: 90, out: 450 },  // 0.9 / 4.5 円（1万tok）2026-09-25 公式料金表")
  })
  it('MODELS と MODEL_PURPOSE のひな形。対象外なら「無償枠なし」', () => {
    expect(lines).toContain("      { id: 'preview/zeta-med-20b', label: 'zeta-med-20b（プレビュー）' },")
    expect(lines).toContain("      'preview/zeta-med-20b': { purpose: '（目的）', note: '無償枠なし' },")
  })
  it('★ 無償枠がある新顔には「無償枠なし」と書かない', () => {
    // alpha-large（無償枠あり）を Koto から外して新顔にする
    const { 'alpha-large': _dropped, ...withoutAlpha } = KOTO
    const r = comparePricing(parsePricingPage(FULL_HTML), withoutAlpha)
    const alpha = r.newcomers.find((n: any) => n.name === 'alpha-large')
    expect(alpha).toBeTruthy()
    const t = registrationLines(alpha, { today: '2026-09-25' }).join('\n')
    expect(t).not.toContain('無償枠なし')
    expect(t).toContain("'alpha-large': { purpose: '（目的）' },")
    const report = formatReport(r, { today: '2026-09-25' }).join('\n')
    expect(report).toContain('alpha-large（通常モデル）')
  })
  it('ツール・画像の対応は書かない（ページに無い）', () => {
    expect(text).not.toMatch(/supportsTools|VISION_MODELS|isVisionModel/)
  })
  it('MODELS にすでに載っているなら、MODELS のひな形は出さない', () => {
    const t = registrationLines(result.newcomers[0], { today: '2026-09-25', knownModelIds: ['preview/zeta-med-20b'] }).join('\n')
    expect(t).toContain('すでに載っています')
    expect(t).not.toContain("{ id: 'preview/zeta-med-20b'")
  })

  it('★ 報告: API 名は候補であり、check:models かお知らせで確かめる、と添える。Markdown 記法を使わない', () => {
    const report = formatReport(result, { today: '2026-09-25' }).join('\n')
    expect(report).toContain('API 名は区分から導いた候補')
    expect(report).toContain('npm run check:models（キーが要る）')
    expect(report).toContain('提供終了の可能性')
    expect(report).toContain('Secret One')
    expect(report).not.toContain('**')
    expect(report).not.toContain('差分なし')
  })
})

// ── ページの形が変わった（2026-11）──────────────────────────────────────────
// 1. 表の右端に「入出力形式」の列が増えた。各行の最後のセルが料金のセルと同じ <dl><dt>Input</dt>… の形で、
//    値は媒体の語（テキスト・画像・動画・音声・ベクトル）か「-」。料金で読めた値がこのセルで null に上書きされると、
//    全行が「料金を読めなかった行」になる（rowspan で引き継いだ料金も同じ）。
// 2. パブリックプレビューのモデルが「通常モデル」の表の中に、名前のセルの先頭の札つきで並ぶ
//    （以前は見出し「パブリックプレビューモデル」の別の表）。札を名前と読むと、モデル名がずれて区分も通常になる。
// 3. カテゴリ列のセルに <small> が付いた。RAG の行（カテゴリ列だけ・料金のセルが無い）がモデル名と読まれていた。
// 古い形は上のテストが固定している。ここは新しい形を、自分で書いた短い HTML で固定する。
// モデル名は架空。料金の数と日付は、換算の確かめのため実際に出てくる桁・書き方を使っている（公開されている値）。

// 入出力形式のセル（値は媒体の語か「-」）
const fmt = (i: string, o: string) => `<dl class="f-in"><dt>Input</dt><dd>${i}</dd></dl><dl class="f-out"><dt>Output</dt><dd>${o}</dd></dl>`
const TXT = fmt('テキスト', 'テキスト')
const MEDIA = fmt('テキスト、画像、動画', 'テキスト')
// 名前のセル（先頭に札・提供開始日つき）
const tagged = (name: string, since: string) =>
  `<th><span class="t__tag">パブリックプレビューモデル</span><br/>${name}<br/><small>${since}</small></th>`

const NEW_HEAD = `<thead>
<tr><th rowSpan="2">カテゴリー</th><th rowSpan="2">提供モデル</th><th rowSpan="2">無償プラン</th><th colSpan="2">従量課金</th><th rowSpan="2" class="t__format">入出力形式</th></tr>
<tr><th><span>無償枠</span></th><th><span>超過分</span></th></tr></thead>`
const newTable = (rows: string[], heading = '通常モデル') =>
  `<h3 class="headline">${heading}</h3>\n<table class="t">${NEW_HEAD}<tbody>\n${rows.join('\n')}\n</tbody></table>`

const NEW_ROWS = {
  large: `<tr><th rowSpan="7"><b>Chat completions</b><small>（文章の生成）</small></th><th>nova-large</th><td rowSpan="4">月 100 回まで</td><td rowSpan="4">月 100 回まで</td><td>${price('0.15', '0.75')}</td><td>${TXT}</td></tr>`,
  mid: `<tr><th>nova-mid-ja</th><td>${price('0.57', '0.07')}</td><td>${TXT}</td></tr>`,
  small: `<tr>${tagged('pre-small-cpu', '(2026年2月3日〜)')}<td>${price('0.01', '0.03')}</td><td>${TXT}</td></tr>`,
  vl: `<tr>${tagged('pre-vl-30b', ' (2026年4月5日〜)')}<td>${price('0.1', '0.3')}</td><td>${MEDIA}</td></tr>`,
  code: `<tr>${tagged('pre-code-32b', '(2026年7月28日〜)')}<td>対象外</td><td>対象外</td><td>${price('0.52', '5.04')}</td><td>${MEDIA}</td></tr>`,
  // 料金のセルと入出力形式のセルが、どちらも rowspan で下の行へ及ぶ
  twinA: `<tr><th>nova-twin-a</th><td rowSpan="2">月 1 回</td><td rowSpan="2">月 1 回</td><td rowSpan="2">${price('0.2', '0.4')}</td><td rowSpan="2">${TXT}</td></tr>`,
  twinB: `<tr><th>nova-twin-b</th></tr>`,
  audio: `<tr><th><b>Audio transcription</b><small>（音声の書き起こし）</small></th><th>whisper-tiny</th><td>月 5 回</td><td>月 5 回</td><td><p>0.5円 <span>/ 60秒</span></p></td><td>${fmt('音声', 'テキスト')}</td></tr>`,
  embed: `<tr><th><b>Embeddings</b><small>（ベクトル化）</small></th><th>mini-e5-base</th><td>月 10 回</td><td>月 10 回</td><td>${price('2', '無料')}</td><td>${fmt('テキスト', 'ベクトル')}</td></tr>`,
  tts: `<tr><th rowSpan="2"><b>Text-to-Speech</b><small>（音声の合成）</small></th><th>VOICEVOX:架空A</th><td rowSpan="2">月 5 回</td><td rowSpan="2">月 5 回</td><td rowSpan="2"><p>3円 <span>/ 10,000モーラ</span></p></td><td rowSpan="2">${fmt('テキスト', '音声')}</td></tr>`,
  ttsB: `<tr><th>VOICEVOX:架空B</th></tr>`,
  rag: `<tr><th colSpan="2"><b>RAG</b><small>（文書の管理と検索）</small></th><td><p>対象外</p></td><td><p>対象外</p></td><td><p>3円<span>/ 100チャンク</span></p></td><td>${fmt('-', '-')}</td></tr>`,
}
const NEW_STANDARD = newTable(Object.values(NEW_ROWS))
// クローズドの表は入出力形式の列を持たない。カテゴリ列に <small> が付いた
const NEW_CLOSED = CLOSED.replace('<b>Chat Completions</b>', '<b>Chat Completions</b><small>（文章の生成）</small>')
const NEW_HTML = page(NEW_STANDARD + NEW_CLOSED)
const NEW_NAMES = ['nova-large', 'nova-mid-ja', 'pre-small-cpu', 'pre-vl-30b', 'pre-code-32b', 'nova-twin-a', 'nova-twin-b']

// 架空の Koto の PRICING のうち、NEW_HTML のチャット用の行と全部一致するもの
const NEW_KOTO_ALL = {
  'nova-large': { in: 15, out: 75 }, 'nova-mid-ja': { in: 57, out: 7 },
  'preview/pre-small-cpu': { in: 1, out: 3 }, 'preview/pre-vl-30b': { in: 10, out: 30 },
  'preview/pre-code-32b': { in: 52, out: 504 },
  'nova-twin-a': { in: 20, out: 40 }, 'nova-twin-b': { in: 20, out: 40 },
}
const NEW_IDS = Object.keys(NEW_KOTO_ALL)

describe('★★★ 新しい形（2026-11）— 入出力形式のセルを料金と読まない', () => {
  const rows = () => parsePricingPage(NEW_HTML)
  const byName = byNameIn(NEW_HTML)

  it('モデル名のある行を、ページの順に読む（カテゴリ列・RAG の行・script の複写は数えない）', () => {
    expect(rows().map((r: any) => r.name)).toEqual([
      ...NEW_NAMES, 'whisper-tiny', 'mini-e5-base', 'VOICEVOX:架空A', 'VOICEVOX:架空B', 'Secret One', 'Secret Two',
    ])
  })

  it('★★ 料金のセルの値が読める（同じ行の後ろにある入出力形式のセルで null に上書きされない）', () => {
    expect(byName('nova-large')).toMatchObject({ section: 'standard', in: 15, out: 75 })
    expect(byName('nova-mid-ja')).toMatchObject({ section: 'standard', in: 57, out: 7 })
    expect(byName('pre-small-cpu')).toMatchObject({ in: 1, out: 3 })
    expect(byName('pre-vl-30b')).toMatchObject({ in: 10, out: 30 }) // 入出力形式は「テキスト、画像、動画」
  })

  it('★★ rowspan で引き継いだ料金も、入出力形式のセル（これも rowspan）で上書きされない', () => {
    expect(byName('nova-twin-a')).toMatchObject({ in: 20, out: 40 })
    expect(byName('nova-twin-b')).toMatchObject({ in: 20, out: 40 })
  })

  it('料金が Input/Output の形でない行は、入出力形式があっても null のまま。Embeddings の「無料」は 0', () => {
    expect(byName('whisper-tiny')).toMatchObject({ in: null, out: null })
    expect(byName('VOICEVOX:架空A')).toMatchObject({ in: null, out: null })
    expect(byName('VOICEVOX:架空B')).toMatchObject({ in: null, out: null })
    expect(byName('mini-e5-base')).toMatchObject({ in: 200, out: 0 }) // 入出力形式の「ベクトル」で 0 を消さない
  })

  it('対象外の行 → 無償枠なし。入出力形式の列が増えても引き継ぎがずれない', () => {
    expect(byName('pre-code-32b').noFreeTier).toBe(true)
    expect(byName('nova-large').noFreeTier).toBe(false)
    expect(byName('pre-small-cpu').noFreeTier).toBe(false)
  })

  // 媒体の語を並べたもの・ダッシュだけのものは入出力形式。位置（同じ行の前後・rowspan）にかかわらず料金を上書きしない
  const formats: [string, string][] = [
    ['テキスト', 'テキスト'], ['テキスト、画像、動画', 'テキスト'], ['テキスト, 画像', 'テキスト'],
    ['音声', 'テキスト'], ['テキスト', 'ベクトル'], ['-', '-'], ['－', '－'], ['—', '—'],
  ]
  for (const [i, o] of formats) {
    it(`入出力形式「${i} / ${o}」は料金を上書きしない（料金のセルの前でも後でも・rowspan でも）`, () => {
      const p = price('0.2', '0.4')
      const html = page(preview([
        `<tr><th>kappa-after</th><td>${p}</td><td>${fmt(i, o)}</td></tr>`,
        `<tr><th>kappa-before</th><td>${fmt(i, o)}</td><td>${p}</td></tr>`,
        `<tr><th>kappa-span-a</th><td rowSpan="2">${p}</td><td rowSpan="2">${fmt(i, o)}</td></tr>`,
        `<tr><th>kappa-span-b</th></tr>`,
      ]))
      expect(parsePricingPage(html).map((r: any) => [r.name, r.in, r.out])).toEqual([
        ['kappa-after', 20, 40], ['kappa-before', 20, 40], ['kappa-span-a', 20, 40], ['kappa-span-b', 20, 40],
      ])
    })
  }

  it('★ 入出力形式でないセル（円・無料・「お問い合わせください」・媒体の語でない語）は、料金のセルのまま扱う', () => {
    const cells: [string, string][] = [
      ['お問い合わせください', 'お問い合わせください'],
      ['-', 'お問い合わせください'], // 片方がダッシュでも、もう片方が媒体の語でなければ形式と見なさない
      ['テキスト', '3D'],            // 知らない媒体の語は形式と見なさない（読めないとして残る側へ倒す）
    ]
    for (const [i, o] of cells) {
      const html = page(preview([`<tr><th>kappa-x</th><td>${fmt(i, o)}</td><td>${TXT}</td></tr>`]))
      expect(parsePricingPage(html)).toMatchObject([{ name: 'kappa-x', in: null, out: null }])
    }
    // 円・無料は料金（Input が円・Output が無料）
    const priced = page(preview([`<tr><th>kappa-y</th><td>${price('2', '無料')}</td><td>${TXT}</td></tr>`]))
    expect(parsePricingPage(priced)).toMatchObject([{ name: 'kappa-y', in: 200, out: 0 }])
  })

  // 「お問い合わせください」の <dl> を、円・無料を含まないからと形式扱いで捨てると、次の2つの行が黙って消える
  const contact = '<dl><dt>Input</dt><dd>お問い合わせください</dd></dl><dl><dt>Output</dt><dd>お問い合わせください</dd></dl>'

  it('★ 区分不明の表では、料金のセル（Input/Output）を持つ行だけを読む。入出力形式のセルだけの行は読まない', () => {
    const html = page(newTable([
      `<tr><th>unk-contact</th><td>${contact}</td><td>${TXT}</td></tr>`,          // 料金のセルはある（読めない）→ 残す
      `<tr><th>unk-priced</th><td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`,
      `<tr><th>unk-format-only</th><td>${TXT}</td></tr>`,                         // 入出力形式のセルだけ → 料金のセルが無い
    ], 'その他のモデル'))
    expect(parsePricingPage(html).map((r: any) => [r.name, r.section, r.in, r.out])).toEqual([
      ['unk-contact', 'unknown', null, null],
      ['unk-priced', 'unknown', 10, 20],
    ])
  })

  it('★ カテゴリ列だけの行でも、料金のセルが「お問い合わせください」の <dl> なら落とさない（料金を読めなかった行として残す）', () => {
    const row = `<tr><th colSpan="2"><b>omega-chat</b><small>（文章の生成）</small></th><td colSpan="2">月 1 回</td><td>${contact}</td><td>${TXT}</td></tr>`
    const rows = parsePricingPage(page(newTable([row])))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ section: 'standard', in: null, out: null })
    expect(rows[0].name).toBe('omega-chat') // カテゴリ列の <small>（文章の生成）を名前に混ぜない
  })
})

describe('★★★ 新しい形（2026-11）— 通常の表の中の札つきプレビュー', () => {
  const byName = byNameIn(NEW_HTML)

  it('★ 札つきの行は preview の区分・札を含まない名前・提供開始日つきで読む', () => {
    expect(byName('pre-small-cpu')).toMatchObject({ name: 'pre-small-cpu', section: 'preview', since: '2026-02-03', in: 1, out: 3 })
    expect(byName('pre-vl-30b')).toMatchObject({ section: 'preview', since: '2026-04-05' }) // 日付の前の空白を許す
    expect(byName('pre-code-32b')).toMatchObject({ section: 'preview', since: '2026-07-28', in: 52, out: 504 })
    // 札を名前にしない（札の文字が名前・since に混ざらない）
    const rows = parsePricingPage(NEW_HTML)
    expect(rows.filter((r: any) => /プレビュー/.test(r.name))).toEqual([])
    expect(rows.filter((r: any) => r.section === 'preview').map((r: any) => r.name)).toEqual(['pre-small-cpu', 'pre-vl-30b', 'pre-code-32b'])
    // 札の無い行は通常のまま
    expect(byName('nova-large').section).toBe('standard')
  })

  it('★ API 名の候補は preview/＋名前。Koto の preview/<名前> と一致する', () => {
    expect(apiIdCandidate(byName('pre-small-cpu'))).toBe('preview/pre-small-cpu')
    const r = comparePricing(parsePricingPage(NEW_HTML), NEW_KOTO_ALL)
    expect(r.matched.map((m: any) => [m.id, m.section])).toContainEqual(['preview/pre-small-cpu', 'preview'])
    expect(r.matched.map((m: any) => m.id)).toContain('preview/pre-vl-30b')
  })

  it('★ Koto に無ければ新顔。報告には「パブリックプレビュー」と API 名の候補 preview/＋名前を出す', () => {
    const { 'preview/pre-small-cpu': _dropped, ...without } = NEW_KOTO_ALL
    const r = comparePricing(parsePricingPage(NEW_HTML), without)
    expect(r.newcomers).toHaveLength(1)
    expect(r.newcomers[0]).toMatchObject({ id: 'preview/pre-small-cpu', name: 'pre-small-cpu', section: 'preview', since: '2026-02-03', in: 1, out: 3 })
    const report = formatReport(r, { today: '2026-11-02' }).join('\n')
    expect(report).toContain('pre-small-cpu（パブリックプレビュー・2026-02-03 提供開始）→ API 名の候補: preview/pre-small-cpu')
    expect(report).not.toContain('パブリックプレビューモデル') // 札の文字を名前に出さない
  })

  it('★★ 古い形（別の表・札なし）と新しい形（通常の表の中・札つき）で、同じモデルは同じ値で読む', () => {
    const old = parsePricingPage(page(preview([PREVIEW_ROWS.gamma, PREVIEW_ROWS.delta])))
    const html = page(newTable([
      `<tr>${tagged('gamma-7b', '(2026年1月2日〜)')}<td rowSpan="3">月 100 回まで</td><td rowSpan="3">月 100 回まで</td><td>${price('0.1', '0.3')}</td><td>${TXT}</td></tr>`,
      `<tr>${tagged('delta-9b', '(2026年3月4日〜)')}<td>${price('0.01', '0.03')}</td><td>${TXT}</td></tr>`,
    ]))
    expect(parsePricingPage(html)).toEqual(old)
  })

  it('札の文字だけで class の無いもの（<th>パブリックプレビューモデル<br/>名前）も札として読む', () => {
    const html = page(newTable([`<tr><th>パブリックプレビューモデル<br/>tau-text-8b<br/><small>(2026年8月9日〜)</small></th><td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`]))
    expect(parsePricingPage(html)).toMatchObject([{ name: 'tau-text-8b', section: 'preview', since: '2026-08-09', in: 10, out: 20 }])
  })

  it('プレビューでない札（新着 など）は名前に含めないが、区分は変えない', () => {
    const html = page(newTable([`<tr><th><span class="t__tag">新着</span><br/>sigma-new-8b</th><td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`]))
    expect(parsePricingPage(html)).toMatchObject([{ name: 'sigma-new-8b', section: 'standard' }])
  })

  it('class に tag を含んでも別の語（stage など）は札にしない（名前を落とさない）', () => {
    const html = page(newTable([`<tr><th><span class="t__stage">upsilon-8b</span></th><td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`]))
    expect(parsePricingPage(html)).toMatchObject([{ name: 'upsilon-8b', section: 'standard' }])
  })

  it('★ プレビューの表（見出し「パブリックプレビューモデル」）の中の札つきの行も preview。札は名前に含めない', () => {
    const html = page(newTable([`<tr>${tagged('chi-8b', '(2026年5月6日〜)')}<td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`], 'パブリックプレビューモデル'))
    expect(parsePricingPage(html)).toMatchObject([{ name: 'chi-8b', section: 'preview', since: '2026-05-06' }])
  })

  it('★ クローズドの表の中に札があっても、区分は closed のまま（preview/ を名乗って照合しない）。名前と提供元は札を除いて読む', () => {
    const closedTagged = CLOSED.replace('<th>提供モデル：Secret One<br/>', '<th><span class="t__tag">パブリックプレビューモデル</span><br/>提供モデル：Secret One<br/>')
    expect(closedTagged).not.toBe(CLOSED)
    const rows = parsePricingPage(page(NEW_STANDARD + closedTagged))
    const one = rows.find((r: any) => r.name === 'Secret One')
    expect(one).toMatchObject({ section: 'closed', provider: 'Example社', in: null, out: null })
    expect(apiIdCandidate(one)).toBeNull()
    const r = comparePricing(rows, NEW_KOTO_ALL)
    expect(r.closed.map((c: any) => c.name)).toEqual(['Secret One', 'Secret Two'])
    expect(r.newcomers).toEqual([])
    expect(exitCodeFor(r)).toBe(0)
  })

  it('★ 通常の表の中の札つきの行が、プレビューの表にも載っていたら（二重に数えている）例外', () => {
    const twice = page(NEW_STANDARD + NEW_CLOSED + preview([PREVIEW_ROWS.gamma]).replace(/gamma-7b/g, 'pre-small-cpu'))
    expect(() => comparePricing(parsePricingPage(twice), NEW_KOTO_ALL)).toThrow(/2回/)
  })
})

describe('★★★ 新しい形（2026-11）— カテゴリ列の <small>・RAG の行', () => {
  const byName = byNameIn(NEW_HTML)

  it('★ <b>…</b><small>…</small> のカテゴリ列はモデル名ではない（rowspan の先頭行でも名前の列から読む）', () => {
    expect(byName('nova-large')).toMatchObject({ section: 'standard', in: 15, out: 75 })
    for (const n of ['Chat completions', 'Chat completions（文章の生成）', 'Audio transcription', 'Text-to-Speech']) {
      expect(byName(n)).toBeUndefined()
    }
    const names = parsePricingPage(NEW_HTML).map((r: any) => r.name)
    expect(names.filter((n: string) => /[（）]|生成|書き起こし|合成|ベクトル化|管理/.test(n))).toEqual([])
  })

  it('★★ RAG の行（カテゴリ列だけ・料金のセルが無い・入出力形式は「-」）をモデルの行として読まない', () => {
    const names = parsePricingPage(NEW_HTML).map((r: any) => r.name)
    expect(names.filter((n: string) => /RAG|ドキュメント/.test(n))).toEqual([])
    // 料金を読めなかった行にも出ない
    const r = comparePricing(parsePricingPage(NEW_HTML), NEW_KOTO_ALL)
    expect(r.unreadable).toEqual([])
    expect(formatReport(r, { today: '2026-11-02' }).join('\n')).not.toContain('RAG')
  })

  it('<b>…</b> と <small> の間に空白・改行があっても同じ', () => {
    const spaced = NEW_HTML.replace('<b>RAG</b><small>', '<b>RAG</b>\n   <small>')
    expect(spaced).not.toBe(NEW_HTML)
    expect(parsePricingPage(spaced).map((r: any) => r.name)).toEqual(parsePricingPage(NEW_HTML).map((r: any) => r.name))
  })

  it('カテゴリ列だけの行でも、料金（Input/Output）を読めるなら落とさない（<small> つきでも外しすぎない）', () => {
    const omega = `<tr><th colSpan="2"><b>omega-chat</b><small>（文章の生成）</small></th><td colSpan="2">月 1 回</td><td>${price('0.2', '0.4')}</td><td>${TXT}</td></tr>`
    const html = page(newTable([...Object.values(NEW_ROWS), omega]) + NEW_CLOSED)
    const r = comparePricing(parsePricingPage(html), NEW_KOTO_ALL)
    expect(r.newcomers.map((n: any) => n.id)).toEqual(['omega-chat'])
    expect(r.newcomers[0]).toMatchObject({ in: 20, out: 40 })
  })
})

describe('★★★ 新しい形（2026-11）— ページ全体の照合と、読めないページで「一致」と言わない', () => {
  it('★★ 全部一致 → 食い違い・新顔・読めなかった行・Koto にだけある が 0 件・終了コード 0', () => {
    const r = comparePricing(parsePricingPage(NEW_HTML), NEW_KOTO_ALL)
    expect(r.matched.map((m: any) => m.id)).toEqual(NEW_IDS)
    expect(r.mismatched).toEqual([])
    expect(r.newcomers).toEqual([])
    expect(r.unreadable).toEqual([])
    expect(r.kotoOnly).toEqual([])
    expect(r.closed.map((c: any) => c.name)).toEqual(['Secret One', 'Secret Two'])
    expect(r.excluded).toEqual(['whisper-tiny', 'mini-e5-base', 'VOICEVOX:架空A', 'VOICEVOX:架空B'])
    expect(exitCodeFor(r)).toBe(0)
    expect(formatReport(r, { today: '2026-11-02' }).join('\n')).toContain('差分なし')
  })

  it('★★ 1か所でも料金が違えば食い違い・終了コード 1（通常の行も、札つきの行も）', () => {
    const plain = comparePricing(parsePricingPage(NEW_HTML.replace(price('0.57', '0.07'), price('0.58', '0.07'))), NEW_KOTO_ALL)
    expect(plain.mismatched).toEqual([
      { id: 'nova-mid-ja', name: 'nova-mid-ja', section: 'standard', official: { in: 58, out: 7 }, koto: { in: 57, out: 7 } },
    ])
    expect(exitCodeFor(plain)).toBe(1)
    const koto = comparePricing(parsePricingPage(NEW_HTML), { ...NEW_KOTO_ALL, 'preview/pre-vl-30b': { in: 10, out: 31 } })
    expect(koto.mismatched.map((m: any) => m.id)).toEqual(['preview/pre-vl-30b'])
    expect(koto.matched).toHaveLength(NEW_IDS.length - 1)
    expect(exitCodeFor(koto)).toBe(1)
  })

  // 料金のセルの書き方が変わった行は、入出力形式のセルがあっても「料金を読めなかった行」
  const iota = (priceCell: string) => `<tr>${tagged('iota-new-8b', '(2026年11月3日〜)')}<td>${priceCell}</td><td>${TXT}</td></tr>`
  const withRow = (row: string) => page(newTable([...Object.values(NEW_ROWS), row]) + NEW_CLOSED)
  const shapes: [string, string][] = [
    ['「お問い合わせください」の <dl>', '<dl><dt>Input</dt><dd>お問い合わせください</dd></dl><dl><dt>Output</dt><dd>お問い合わせください</dd></dl>'],
    ['<p> で書かれた料金', '<p>0.5円 <span>/ 10,000トークン</span></p>'],
    ['見出しが日本語（<dt>入力</dt>）', '<dl><dt>入力</dt><dd>0.5円 <span>/ 10,000トークン</span></dd></dl><dl><dt>出力</dt><dd>1円 <span>/ 10,000トークン</span></dd></dl>'],
    ['ダッシュと「お問い合わせください」の <dl>', '<dl><dt>Input</dt><dd>-</dd></dl><dl><dt>Output</dt><dd>お問い合わせください</dd></dl>'],
  ]
  for (const [label, cell] of shapes) {
    it(`★★ 札つきの新しい行の料金が${label} → 料金を読めなかった行・終了コード 1`, () => {
      const r = comparePricing(parsePricingPage(withRow(iota(cell))), NEW_KOTO_ALL)
      expect(r.matched).toHaveLength(NEW_IDS.length)
      expect(r.unreadable).toEqual([
        { id: 'preview/iota-new-8b', name: 'iota-new-8b', section: 'preview', since: '2026-11-03', in: null, out: null, koto: null, sameNameInKoto: null },
      ])
      expect(r.newcomers).toEqual([])
      expect(exitCodeFor(r)).toBe(1)
      const report = formatReport(r, { today: '2026-11-02' }).join('\n')
      expect(report).toContain('料金を読めなかった行 1件')
      expect(report).toContain('iota-new-8b（パブリックプレビュー・2026-11-03 提供開始）→ API 名の候補: preview/iota-new-8b')
      expect(report).not.toContain('差分なし')
    })
  }

  it('★ 片方（出力）だけ読めない行は、読めた入力を残したまま料金を読めなかった行（入出力形式で消さない）', () => {
    const cell = `<dl><dt>Input</dt>${tok('0.5')}</dl><dl><dt>Output</dt><dd>お問い合わせください</dd></dl>`
    const r = comparePricing(parsePricingPage(withRow(iota(cell))), NEW_KOTO_ALL)
    expect(r.unreadable).toHaveLength(1)
    expect(r.unreadable[0]).toMatchObject({ id: 'preview/iota-new-8b', in: 50, out: null })
    expect(exitCodeFor(r)).toBe(1)
  })

  it('★ 通常の札なしの行（Chat completions の表）でも同じ', () => {
    const lambda = `<tr><th>lambda-std</th><td>月 1 回</td><td>月 1 回</td><td><dl><dt>Input</dt><dd>お問い合わせください</dd></dl><dl><dt>Output</dt><dd>お問い合わせください</dd></dl></td><td>${TXT}</td></tr>`
    const r = comparePricing(parsePricingPage(withRow(lambda)), NEW_KOTO_ALL)
    expect(r.unreadable.map((u: any) => [u.id, u.section])).toEqual([['lambda-std', 'standard']])
    expect(exitCodeFor(r)).toBe(1)
  })

  it('★ Koto に載っているモデルの料金の書き方が変わった → 料金を読めなかった行（一致にも「Koto にだけある」にもしない）', () => {
    const changed = NEW_HTML.replace(price('0.15', '0.75'), '<dl><dt>Input</dt><dd>お問い合わせください</dd></dl><dl><dt>Output</dt><dd>お問い合わせください</dd></dl>')
    expect(changed).not.toBe(NEW_HTML)
    const r = comparePricing(parsePricingPage(changed), NEW_KOTO_ALL)
    expect(r.unreadable.map((u: any) => [u.id, u.koto])).toEqual([['nova-large', { in: 15, out: 75 }]])
    expect(r.matched.map((m: any) => m.id)).not.toContain('nova-large')
    expect(r.kotoOnly).toEqual([])
    expect(exitCodeFor(r)).toBe(1)
  })

  it(`★★ 料金を読めたチャット用の行が ${MIN_PRICED_ROWS}件未満なら例外（${MIN_PRICED_ROWS}件ならちょうど通る）`, () => {
    const make = (n: number) => {
      const rows = Array.from({ length: n }, (_, k) => `<tr><th>mu-${k}</th><td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`)
      const koto = Object.fromEntries(Array.from({ length: n }, (_, k) => [`mu-${k}`, { in: 10, out: 20 }]))
      return { html: page(newTable(rows)), koto }
    }
    // 門が無いと、読めた分だけ Koto と一致して「全部一致（終了コード 0）」と言ってしまう
    const few = make(MIN_PRICED_ROWS - 1)
    expect(() => comparePricing(parsePricingPage(few.html), few.koto)).toThrow(PricingPageError)
    // ちょうど MIN 件なら通る（入出力形式のセルで料金を null にしていれば、ここで例外になる）
    const enough = make(MIN_PRICED_ROWS)
    const r = comparePricing(parsePricingPage(enough.html), enough.koto)
    expect(r.matched).toHaveLength(MIN_PRICED_ROWS)
    expect(exitCodeFor(r)).toBe(0)
  })

  it('料金のセルが全部読めない書き方に変わったら（入出力形式のセルだけが Input/Output の形）→ 例外', () => {
    const asP = NEW_HTML.replace(/<td>(?:<dl class="p-in">[\s\S]*?<\/dl><dl class="p-out">[\s\S]*?<\/dl>)<\/td>/g, '<td><p>1円</p></td>')
    expect(asP).not.toBe(NEW_HTML)
    expect(() => comparePricing(parsePricingPage(asP), NEW_KOTO_ALL)).toThrow(/ページの形が変わった/)
    const jp = NEW_HTML.replace(/<dt>Input<\/dt><dd>\d/g, '<dt>入力</dt><dd>0').replace(/<dt>Output<\/dt><dd>\d/g, '<dt>出力</dt><dd>0')
    expect(() => comparePricing(parsePricingPage(jp), NEW_KOTO_ALL)).toThrow(/ページの形が変わった/)
  })

  it('見出し（区分）が読めない → 例外（札つきの行も、区分の分からないまま数えない）', () => {
    const noHeadings = NEW_HTML.replace(/<h3\b[^>]*>[\s\S]*?<\/h3>/g, '')
    expect(() => comparePricing(parsePricingPage(noHeadings), NEW_KOTO_ALL)).toThrow(PricingPageError)
  })
})

// ── 行が黙って消える道を塞ぐ（2026-11-02 の検分）──────────────────────────────
// 札・入出力形式・カテゴリ列を見分ける読み方は、見分けを誤ると行を捨てる側へ倒れやすい。
// 通常・プレビューの表は、料金を読めない行も残る（照合で「料金を読めなかった行」になる）ので差が出にくい。
// 取りこぼしが出るのは、区分不明の表の行・名前が空になる行・片方だけ読めた料金。そこを個別に固定する。
describe('★★★ 新しい形（2026-11）— 行が黙って消えない', () => {
  const withRow = (row: string) => page(newTable([...Object.values(NEW_ROWS), row]) + NEW_CLOSED)
  const unk = (row: string) => page(newTable([row], 'その他のモデル'))
  const cellOf = (i: string, o: string) => `<dl><dt>Input</dt><dd>${i}</dd></dl><dl><dt>Output</dt><dd>${o}</dd></dl>`
  const yenIn = `0.5円 <span>/ 10,000トークン</span>`

  // 名前のセルに札しか無い（名前の行が無い）行。札を外すと名前が空になるが、料金を読めた行を黙って捨てない
  const tagOnly = (inner: string) => `<th><span class="t__tag">パブリックプレビューモデル</span>${inner}</th>`
  const tagOnlyThs: [string, string][] = [
    ['札だけ', tagOnly('')],
    ['札と提供開始日だけ', tagOnly('<br/><small>(2026年11月3日〜)</small>')],
    ['class の無い札と提供開始日だけ', '<th>パブリックプレビューモデル<br/><small>(2026年11月3日〜)</small></th>'],
  ]
  for (const [label, th] of tagOnlyThs) {
    it(`★★ 名前のセルが${label} → 札の文字を名前に戻して残す（新顔として終了コード 1。黙って捨てない）`, () => {
      const html = withRow(`<tr>${th}<td>${price('0.2', '0.4')}</td><td>${TXT}</td></tr>`)
      expect(byNameIn(html)('パブリックプレビューモデル')).toMatchObject({ section: 'standard', in: 20, out: 40 })
      const r = comparePricing(parsePricingPage(html), NEW_KOTO_ALL)
      expect(r.newcomers.map((n: any) => n.name)).toEqual(['パブリックプレビューモデル'])
      expect(exitCodeFor(r)).toBe(1)
    })
  }

  it('★ 札だけのセルで料金も読めない行は、料金を読めなかった行（終了コード 1）', () => {
    const r = comparePricing(parsePricingPage(withRow(`<tr>${tagOnly('')}<td><p>お問い合わせください</p></td><td>${TXT}</td></tr>`)), NEW_KOTO_ALL)
    expect(r.unreadable.map((u: any) => u.name)).toEqual(['パブリックプレビューモデル'])
    expect(exitCodeFor(r)).toBe(1)
  })

  it('★★ 札が独立した最後の <th> にあっても、名前は札の前の <th> から読み、区分は preview', () => {
    const html = withRow(`<tr><th>rho-8b<br/><small>(2026年11月3日〜)</small></th>${tagOnly('')}<td>${price('0.2', '0.4')}</td><td>${TXT}</td></tr>`)
    expect(byNameIn(html)('rho-8b')).toMatchObject({ section: 'preview', since: '2026-11-03', in: 20, out: 40 })
    expect(parsePricingPage(html).filter((r: any) => /プレビュー/.test(r.name))).toEqual([])
    const r = comparePricing(parsePricingPage(html), NEW_KOTO_ALL)
    expect(r.newcomers.map((n: any) => n.id)).toEqual(['preview/rho-8b'])
  })

  it('★ 名前がどうしても読めない行（<th>※</th>）に料金がある → 通常・プレビューの表なら例外。区分不明の表は読み飛ばす', () => {
    const row = `<tr><th>※</th><td>${price('0.2', '0.4')}</td><td>${TXT}</td></tr>`
    expect(() => parsePricingPage(withRow(row))).toThrow(PricingPageError)
    expect(parsePricingPage(unk(row))).toEqual([])
  })

  // 入出力形式の見分け: dd が1つでも円なら料金のセル。「1つでも形式に見えたら捨てる」にしない
  it('★★ 入力が円・出力が「-」の料金のセルは、入出力形式と見なして捨てない（読めた入力を残す）', () => {
    const rows = parsePricingPage(page(newTable([`<tr><th>kappa-half</th><td>${cellOf(yenIn, '-')}</td><td>${TXT}</td></tr>`])))
    expect(rows).toMatchObject([{ name: 'kappa-half', section: 'standard', in: 50, out: null }])
  })

  it('★★ 区分不明の表で、料金のセルが「-」と「お問い合わせください」の行を捨てない（料金のセルの片方が「-」でも）', () => {
    const rows = parsePricingPage(unk(`<tr><th>unk-dash</th><td>${cellOf('-', 'お問い合わせください')}</td><td>${TXT}</td></tr>`))
    expect(rows).toMatchObject([{ name: 'unk-dash', section: 'unknown', in: null, out: null }])
  })

  it('★★ 区分不明の表で、料金のセルの dd が空の行を捨てない（空は入出力形式ではない）', () => {
    const rows = parsePricingPage(unk(`<tr><th>unk-empty</th><td>${cellOf('', '')}</td><td>${TXT}</td></tr>`))
    expect(rows).toMatchObject([{ name: 'unk-empty', section: 'unknown', in: null, out: null }])
  })

  // 札は、通常の表の中でだけ区分を変える。区分不明の表（見出しが読めない）では変えない
  it('★★ 区分不明の表の中の札つきの行は、区分を preview にしない（API 名の候補を作らない）', () => {
    const rows = parsePricingPage(unk(`<tr>${tagged('unk-tagged-8b', '(2026年1月1日〜)')}<td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`))
    expect(rows).toMatchObject([{ name: 'unk-tagged-8b', section: 'unknown', in: 10, out: 20 }])
    expect(apiIdCandidate(rows[0])).toBeNull()
  })

  it(`★★ 見出しが読めないページは、札つきの行が ${MIN_PRICED_ROWS}件あっても、札で preview に数えず門で止まる`, () => {
    const many = Array.from({ length: MIN_PRICED_ROWS }, (_, k) => `<tr>${tagged(`mu-${k}`, '(2026年1月1日〜)')}<td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`)
    const koto = Object.fromEntries(Array.from({ length: MIN_PRICED_ROWS }, (_, k) => [`preview/mu-${k}`, { in: 10, out: 20 }]))
    const noHeadings = page(newTable(many)).replace(/<h3\b[^>]*>[\s\S]*?<\/h3>/g, '')
    expect(() => comparePricing(parsePricingPage(noHeadings), koto)).toThrow(PricingPageError)
    // 見出しがあれば同じ行が preview として通る（上の例外は見出しが無いことが理由）
    expect(comparePricing(parsePricingPage(page(newTable(many))), koto).matched).toHaveLength(MIN_PRICED_ROWS)
  })

  // カテゴリ列は <b>…</b> のあとに <small> だけが続く形。名前が <b> で始まるだけのセルはカテゴリ列ではない
  it('名前が <b> で始まり <br/><small> が続くセルは、カテゴリ列ではなくモデル名', () => {
    const rows = parsePricingPage(page(newTable([`<tr><th><b>bold-8b</b><br/><small>(2026年1月1日〜)</small></th><td><p>お問い合わせください</p></td><td>${TXT}</td></tr>`])))
    expect(rows).toMatchObject([{ name: 'bold-8b', section: 'standard', since: '2026-01-01', in: null, out: null }])
  })

  // 英数字を含む行は札ではない（モデル名に「プレビュー」が入っていても、名前の1行目を札として外さない）。
  // 2行目があるものは、1行目を札と取り違えると名前が2行目になる（1行だけのものは、札の文字を名前に戻すので差が出ない）
  it('名前に「プレビュー」と英数字が入るモデルは、札として外さない', () => {
    const rows = parsePricingPage(page(newTable([
      `<tr><th>Foo-7B プレビュー版</th><td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`,
      `<tr><th>Bar-3B プレビュー版<br/>(試験提供)</th><td>${price('0.1', '0.2')}</td><td>${TXT}</td></tr>`,
    ])))
    expect(rows).toMatchObject([
      { name: 'Foo-7B プレビュー版', section: 'standard', in: 10, out: 20 },
      { name: 'Bar-3B プレビュー版', section: 'standard', in: 10, out: 20 },
    ])
  })

  it('カテゴリ列だけの行で料金がある場合、名前にカテゴリ列の <small>（説明）を混ぜない', () => {
    const omega = `<tr><th colSpan="2"><b>omega-chat</b><small>（文章の生成）</small></th><td colSpan="2">月 1 回</td><td>${price('0.2', '0.4')}</td><td>${TXT}</td></tr>`
    expect(parsePricingPage(page(newTable([omega])))).toMatchObject([{ name: 'omega-chat', section: 'standard', in: 20, out: 40 }])
  })
})

describe('appConfig — Koto の固定設定を読む（check-models.mjs と共用）', () => {
  const MI = [
    'export const MODELS: { id: string; label: string }[] = [',
    "  { id: 'a-model', label: 'A' },",
    ']',
    'export const VISION_MODELS: { id: string; label: string }[] = [',
    "  { id: 'preview/v-model', label: 'V' },",
    ']',
    "export const DEFAULT_MODEL = 'a-model'",
  ].join('\n')
  const UB = [
    'export const PRICING: Record<string, { in: number; out: number }> = {',
    '  // コメント行は読まない',
    "  'a-model': { in: 15, out: 75 },   // 0.15 / 0.75",
    "  'preview/v-model': { in: 0.5, out: 3 },",
    '}',
  ].join('\n')

  it('★ PRICING のキーだけでなく値（in・out）まで読む', () => {
    const cfg = parseAppConfig(MI, UB)
    expect(cfg.pricing).toEqual({ 'a-model': { in: 15, out: 75 }, 'preview/v-model': { in: 0.5, out: 3 } })
    expect(cfg.models).toEqual(['a-model'])
    expect(cfg.visionModels).toEqual(['preview/v-model'])
    expect(cfg.defaultModel).toBe('a-model')
  })

  it('★★ 抽出0件なら例外（読み先がずれたのを「モデルが無い」と誤診しない）', () => {
    expect(() => parseAppConfig(MI, 'export const PRICE_TABLE = {\n}\n')).toThrow(/固定設定を読み取れません/)
    expect(() => parseAppConfig(MI.replace('export const MODELS', 'export const MODEL_LIST'), UB)).toThrow(/固定設定を読み取れません/)
    expect(() => parseAppConfig(MI.replace('DEFAULT_MODEL', 'DEFAULT_ID'), UB)).toThrow(/固定設定を読み取れません/)
  })

  it('★ 値の読めない PRICING 行が1つでもあれば例外（読めた分だけで照合しない）', () => {
    const bad = UB.replace("  'preview/v-model': { in: 0.5, out: 3 },", "  'preview/v-model': DEFAULT_PRICE,")
    expect(() => parseAppConfig(MI, bad)).toThrow(/preview\/v-model/)
  })

  it('★ 実物のソースを読んだ結果が、アプリの実際の値と一致する', () => {
    const cfg = readAppConfig()
    expect(cfg.pricing).toEqual(PRICING)
    expect(cfg.models).toEqual(MODELS.map((m) => m.id))
    expect(cfg.visionModels).toEqual(VISION_MODELS.map((m) => m.id))
    expect(cfg.defaultModel).toBe(DEFAULT_MODEL)
  })

  it('NON_CHAT は renderer/usage.ts と同じ判定（複製がずれていない）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer/usage.ts'), 'utf-8')
    const m = src.match(/const NON_CHAT\s*=\s*(\/.+\/[a-z]*)\s*$/m)
    expect(m).toBeTruthy()
    expect(String(NON_CHAT)).toBe(m![1])
  })

  it('probe-models.mjs は NON_CHAT を lib から使う（自前の複製を持たない）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../scripts/probe-models.mjs'), 'utf-8')
    expect(src).toMatch(/import \{[^}]*NON_CHAT[^}]*\} from '\.\/lib\/appConfig\.mjs'/)
    expect(src).not.toMatch(/const NON_CHAT\s*=/)
  })

  it('scripts/ の中で NON_CHAT を定義しているのは lib/appConfig.mjs だけ（4つ目の複製を作らない）', () => {
    const root = path.join(__dirname, '../scripts')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(mjs|cjs|js|ts)$/.test(e.name)) files.push(p)
      }
    }
    walk(root)
    const defining = files
      .filter((f) => /\b(?:const|let|var)\s+NON_CHAT\s*=/.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
    expect(defining).toEqual(['lib/appConfig.mjs'])
  })

  it('check-models.mjs は固定設定の読み取りと NON_CHAT を lib から使う（自前の複製を持たない）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../scripts/check-models.mjs'), 'utf-8')
    expect(src).toMatch(/import \{[^}]*readAppConfig[^}]*NON_CHAT[^}]*\} from '\.\/lib\/appConfig\.mjs'/)
    expect(src).not.toMatch(/const NON_CHAT\s*=/)
    expect(src).not.toMatch(/function readAppConfig/)
  })
})
