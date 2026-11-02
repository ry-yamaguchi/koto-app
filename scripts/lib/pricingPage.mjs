// pricingPage.mjs — さくらのAI Engine 製品ページの「提供モデルと料金」を読み、Koto の PRICING と突き合わせる純関数。
// CLI（scripts/check-pricing.mjs）から使う。ネットワーク・ファイルには触れない（テストしやすく）。
//
// ── ページの形（原本で確認した構造。値ではなく形だけをここに書く）──────────
// ■ 2026-11 の形（2026-11-02 の週次で確認した形。下の古い形も今までどおり読む）
// - 表の右端に「入出力形式」の列が増えた。各行の最後のセルが、料金のセルと**同じ形**
//   （<dl><dt>Input</dt><dd>テキスト</dd></dl><dl><dt>Output</dt><dd>テキスト</dd></dl>）で、
//   値は媒体の語（テキスト・画像・動画・音声・ベクトル）を「、」で並べたものか「-」。
//   Input/Output の見出しだけで読むと、料金で読めた値がこのセルで null に上書きされ、全行が「読めない」になる。
//   → isFormatCell で見分けて読み飛ばす（rowspan で下へ及ぶものも料金を上書きしない）。
// - パブリックプレビューのモデルが、別の表ではなく「通常モデル」の表の中に並ぶ。名前のセルの先頭に札
//   （<span class="…tag">パブリックプレビューモデル</span>）が付き、札は名前ではなく**その行の区分が preview**の印。
//   提供開始日は名前のセルの (…〜) の文字から読む（タグは問わない。2026-11 は <small>）。
// - カテゴリ列のセルに <small>（テキスト生成 など）が付いた: <th rowSpan><b>Chat completions</b><small>…</small></th>。
//   RAG の行は <th colSpan="2"><b>RAG</b><small>…</small></th> でモデル名のセルが無く、料金も <p>…円 / …チャンク</p>、
//   入出力形式は「-」。モデルの行として読まない。
// ■ 2026-09 の形（2026-09-25 に確認した古い形。今も読める）
// - 料金表は <table> の <tbody> の <tr> 1行が1モデル。モデル名は行の最後の <th>
//   （先頭行だけ rowspan のカテゴリ列 <th rowSpan><b>…</b></th> が前に付く）。
// - 料金は <dl><dt>Input</dt><dd>0.9円 <span>/ 10,000トークン</span></dd></dl>（Output も同じ形）。
//   **列の位置では読まない**（rowspan で列の数が行ごとに変わる）。Input/Output の見出しで読む。
// - 表は <h3> の見出しで区分される: 「通常モデル」「パブリックプレビューモデル」「クローズドモデル料金」。
//   古い形では、プレビューは見出し「パブリックプレビューモデル」の別の表にあり、札は無い。
// - カテゴリ列のセルは <th><b>…</b></th>（中身が <b> だけ）。モデル名のセルは <b> で包まれない。
//   「ドキュメント（RAG）」の行は <th colSpan="2"><b>ドキュメント（RAG）</b></th> がモデル名の列まで及び、
//   **モデル名のセルが無い**（モデルの行ではない）。料金も <p>…円 / …チャンク</p> の形。
// ■ どちらの形にも共通
// - 料金が Input/Output の形でない行が、通常の表にある: 音声認識（<p>…円 / …秒</p>）と
//   音声合成（<p>…円 / …モーラ</p> が rowspan で複数行に及び、続きの行はモデル名のセルだけ）。
//   どちらもモデル名が NON_CHAT に当たる（whisper… / VOICEVOX:…）ので、照合では外れる。
// - 同じ表がページ描画用の <script> の中にも複写されている。**script の中は数えない**（二重に数える）。
// - 無償枠が無いモデルは、その行に <td>対象外</td> がある（rowspan で下の行へ及ぶこともあるので引き継ぐ）。
// - クローズドモデルは料金を公開していない（申請が承認された人にだけ表示）。
//
// ── 読み違いで「全部一致」と言わない ────────────────────────────────────────
// ページの形が変わると、読めた行が減る。そのまま照合すると「差分なし」になり得る（最悪の誤診）。
// 料金を読めたチャット用の行が MIN_PRICED_ROWS 未満なら comparePricing は例外を投げる。
// 1行だけ読めない場合も黙って捨てない（2026-09-26 検分）: 通常・プレビューの表にある、チャット用で
// 名前のある行の料金を読めなければ「料金を読めなかった行」として報告し、終了コード 1 にする
// （<p>0.5円 / 10,000トークン</p>・「お問い合わせください」・<dt>入力</dt> などの新しいモデルを、
//   既存の行が一致しているからと「差分なし」で済ませない）。
// 札しか無くて名前が空になる行も黙って捨てない（2026-11-02 検分）: 札の文字を名前に戻して、新顔か
// 「料金を読めなかった行」として出す。名前がまったく読めないのに料金がある行は、読み違いとして例外にする。
// ⚠️ 既知の穴: 見出しが読めない（区分不明）表で、料金のセルが「-」と「-」だけの行は、入出力形式のセルと
// 区別できないので読み飛ばす（RAG の行の入出力形式も「-」/「-」で、これを料金のセルと見ると RAG の行が
// モデルの行になる）。通常・プレビューの表なら行は残り、「料金を読めなかった行」になる。
// 発生は見出しが変わったときに限られ、そのとき通常・プレビューの行が読めなくなって門でも止まる。
import { NON_CHAT } from './appConfig.mjs'

export const PRICING_PAGE_URL = 'https://ai.sakura.ad.jp/sakura-ai/ai-engine/'

/** 料金を読めたチャット用の行がこれ未満なら「ページの形が変わった＝読み違い」と見なす */
export const MIN_PRICED_ROWS = 5

/** 区分（<h3> の見出しから決める） */
export const SECTION = Object.freeze({
  standard: 'standard', // 通常モデル
  preview: 'preview',   // パブリックプレビューモデル
  closed: 'closed',     // クローズドモデル（料金非公開）
  unknown: 'unknown',   // 見出しが上のどれでもない
})

export const SECTION_LABEL = Object.freeze({
  standard: '通常モデル',
  preview: 'パブリックプレビュー',
  closed: 'クローズド',
  unknown: '区分不明',
})

export class PricingPageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PricingPageError'
  }
}

/** 浮動小数の端数を落とす（0.57 × 100 = 56.99999999999999 → 57）。円の小数6桁で丸める */
export function roundYen(x) {
  return Math.round(x * 1e6) / 1e6
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : all
    }
    return ENTITIES[e.toLowerCase()] ?? all
  })
}

/** タグを外した文字列。<br> は改行にする */
function textOf(fragment) {
  return decodeEntities(fragment.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((l) => l.replace(/[\s ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** 描画されない部分（script・style・noscript・コメント）を除く。script の中の表の複写を数えないため */
export function stripNonContent(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
}

function sectionOf(headingText) {
  if (/クローズド/.test(headingText)) return SECTION.closed
  if (/プレビュー/.test(headingText)) return SECTION.preview
  if (/通常/.test(headingText)) return SECTION.standard
  return SECTION.unknown
}

/**
 * カテゴリ列のセル（中身が <b>…</b>、または <b>…</b> の後ろに <small>…</small> が続くだけ）か。モデル名のセルではない。
 * 2026-11 に <small>（テキスト生成 など）が付いた。<small> を許さないと、RAG の行のカテゴリ列がモデル名と読まれる。
 */
function isCategoryCell(thHtml) {
  return /^\s*<b\b[^>]*>[\s\S]*?<\/b\s*>(?:\s*<small\b[^>]*>[\s\S]*?<\/small\s*>)*\s*$/i.test(thHtml)
}

function rowspanOf(attrs) {
  const m = attrs.match(/rowspan\s*=\s*["']?(\d+)/i)
  const n = m ? Number(m[1]) : 1
  return Number.isFinite(n) && n > 1 ? n : 1
}

/**
 * 料金1つ（<dd> の中身）を ¥/100万トークン へ換算する。読めなければ null。
 * 「無料」は 0。単位の数（10,000 / 1万 など）を読んで換算する（単位が変わっても桁を誤らない）。
 */
export function parseYenPerMillion(ddHtml) {
  const t = textOf(ddHtml).replace(/\s+/g, ' ').trim()
  if (t === '無料') return 0
  const m = t.match(/^([\d,]+(?:\.\d+)?)\s*円\s*\/\s*([\d,]+(?:\.\d+)?)\s*(万)?\s*トークン$/)
  if (!m) return null
  const yen = Number(m[1].replace(/,/g, ''))
  const per = Number(m[2].replace(/,/g, '')) * (m[3] ? 10000 : 1)
  if (!Number.isFinite(yen) || !Number.isFinite(per) || per <= 0) return null
  return roundYen(yen * (1_000_000 / per))
}

/** セルの中の <dt>Input|Output</dt><dd>…</dd> の <dd> の中身。無ければ null */
function ddIn(cellHtml, label) {
  const m = cellHtml.match(new RegExp(String.raw`<dt\b[^>]*>\s*${label}\s*</dt>\s*<dd\b[^>]*>([\s\S]*?)</dd\s*>`, 'i'))
  return m ? m[1] : null
}

function priceIn(cellHtml, label) {
  const dd = ddIn(cellHtml, label)
  return dd === null ? undefined : parseYenPerMillion(dd)
}

// 入出力形式の値に使われる媒体の語。ここに無い語（新しい媒体）は形式と見なさない＝料金のセルとして読み、
// 読めなければ null になって「料金を読めなかった行」に出る（黙って誤読するより、うるさく止まる側へ倒す）
const MEDIA_WORD = /^(?:テキスト|画像|動画|映像|音声|ベクトル|ドキュメント|PDF)$/i
const DASH_ONLY = /^[-\u2010\u2011\u2013\u2014\u2015\u2212\uFF0D]$/

/** 入出力形式の <dd> の中身か。媒体の語を「、」「,」「・」「/」で並べたもの、または「-」だけ */
function isFormatValue(ddHtml) {
  const t = textOf(ddHtml).replace(/\s+/g, ' ').trim()
  if (!t) return false
  if (DASH_ONLY.test(t)) return true
  return t.split(/\s*[、,，・/／]\s*/).every((w) => MEDIA_WORD.test(w))
}

/**
 * 入出力形式のセルか（2026-11 に増えた列。料金のセルと同じ <dl><dt>Input</dt>… の形をしている）。
 * Input/Output の <dd> が、あるものすべて媒体の語か「-」なら形式。1つでも円・無料・「お問い合わせください」など
 * 媒体の語でないものがあれば料金のセルのまま扱う（書き方が変わった料金を、形式と誤認して捨てない）。
 */
function isFormatCell(cellHtml) {
  const dds = ['Input', 'Output'].map((l) => ddIn(cellHtml, l)).filter((d) => d !== null)
  return dds.length > 0 && dds.every(isFormatValue)
}

/** カテゴリ列のセルの末尾の <small>…</small>（テキスト生成 などの説明）を除く。カテゴリ列を名前の代わりに読むときに使う */
function stripTrailingSmall(thHtml) {
  return thHtml.replace(/(?:\s*<small\b[^>]*>[\s\S]*?<\/small\s*>)+\s*$/i, '')
}

/** 名前のセルの先頭の札（<span class="…tag">…</span>）を外す。札でなければ何もしない */
function splitLeadingTag(thHtml) {
  const m = thHtml.match(/^\s*<span\b([^>]*)>([\s\S]*?)<\/span\s*>/i)
  if (m) {
    const cls = m[1].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2] ?? ''
    // class の単語に tag を含む（page-module__xxx__tag など）。stage のような別の語は札にしない
    if (/(?:^|[^a-z0-9])tag(?:[^a-z0-9]|$)/i.test(cls)) return { rest: thHtml.slice(m[0].length), tagText: textOf(m[2]) }
  }
  return { rest: thHtml, tagText: null }
}

/** 札の文字だけの行か（class の無い札の保険）。モデル名は英数字を含むので、英数字の無い「…プレビュー…」だけを札と見る */
function isTagLine(line) {
  return /プレビュー/.test(line) && !/[A-Za-z0-9]/.test(line)
}

/**
 * 見出しセル（<th>）の中身から、モデル名・提供開始日・提供元・プレビューの札の有無を取り出す。
 * 2026-11 から、プレビューのモデルは名前のセルの先頭に札（パブリックプレビューモデル）が付く。
 * 札は名前に含めず、次の行を名前にする（札の文字が プレビュー を含めば previewTag）。
 * ⚠️ 札の文字に プレビュー を含めば preview と見なすのは文字からの推定（札の意味まで確かめてはいない。
 * 「プレビュー終了予定」のような札も preview として照合される）。札しか無く名前が空になるときは name が '' になる
 * （札の文字は tagText に残す。呼び出し側が、札の文字を名前に戻して黙って捨てないようにする）。
 */
function nameCell(thHtml) {
  const split = splitLeadingTag(thHtml)
  let tagText = split.tagText
  let lines = textOf(split.rest).split('\n')
  if (tagText === null && isTagLine(lines[0] ?? '')) {
    tagText = lines[0]
    lines = lines.slice(1)
  }
  const all = lines.join('\n')
  const sinceM = all.match(/\((\d{4})年(\d{1,2})月(\d{1,2})日\s*〜?\s*\)/)
  const since = sinceM ? `${sinceM[1]}-${sinceM[2].padStart(2, '0')}-${sinceM[3].padStart(2, '0')}` : null
  const providerLine = lines.find((l) => /^提供元\s*[:：]/.test(l))
  const provider = providerLine ? providerLine.replace(/^提供元\s*[:：]\s*/, '').trim() : null
  const first = (lines[0] ?? '')
    .replace(/\(\d{4}年\d{1,2}月\d{1,2}日\s*〜?\s*\)/, '')
    .replace(/^提供モデル\s*[:：]\s*/, '')
    .replace(/※/g, '')
    .trim()
  return { name: first, since, provider, tagText, previewTag: tagText !== null && /プレビュー/.test(tagText) }
}

/**
 * 製品ページの HTML から料金表の行を読む（script などを除いた HTML の <table> だけから）。
 * 返すのは、通常・プレビュー・クローズドの区分でモデル名のある行（料金を読めない行も含む）と、
 * 区分不明の表で料金（Input/Output）のセルを持つ行。
 * 料金の書き方が読めなかった行は in/out が null になる（黙って落とさない。照合側で報告する）。
 * モデル名のセルが無い行（カテゴリ列だけの「ドキュメント（RAG）」など）は、料金のセルも無ければ読まない。
 * 入出力形式のセル（isFormatCell）は料金として読まない（同じ行で先に読んだ料金も、rowspan で引き継いだ料金も上書きしない）。
 * 名前のセルの先頭に プレビュー の札がある行は、札を名前に含めず、表の見出しが通常なら区分を preview にする
 * （見出しがクローズド・区分不明の表の中の札は、区分を変えない。クローズドを preview と名乗って照合しない）。
 * 札しか無く名前が空になる行は、札の文字を名前に戻して残す。名前がまったく読めないのに料金がある
 * 通常・プレビューの行は PricingPageError（黙って捨てない）。
 * @param {string} html
 * @throws {PricingPageError} 通常・プレビューの表で、料金があるのにモデル名を読めない行があるとき
 * @returns {{ name: string, section: string, since: string|null, in: number|null, out: number|null, noFreeTier: boolean, provider: string|null }[]}
 */
export function parsePricingPage(html) {
  if (typeof html !== 'string') throw new TypeError('parsePricingPage: html は文字列で渡してください')
  const doc = stripNonContent(html)

  const headings = [...doc.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi)]
    .map((m) => ({ at: m.index, section: sectionOf(textOf(m[1])) }))

  const rows = []
  for (const tm of doc.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const heading = headings.filter((h) => h.at < tm.index).pop()
    const section = heading ? heading.section : SECTION.unknown
    const inner = tm[1]
    const tbody = inner.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/i)
    const body = tbody ? tbody[1] : inner.replace(/<thead\b[^>]*>[\s\S]*?<\/thead\s*>/gi, '')

    // rowspan で下の行へ及ぶもの（料金のセルと「対象外」のセル）を引き継ぐ
    let carryPrice = null // { in, out, left }
    let carryNoFree = 0   // 残り行数

    for (const rm of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [...rm[1].matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)]
        .map((c) => ({ tag: c[1].toLowerCase(), attrs: c[2], html: c[3] }))

      let price = null
      if (carryPrice && carryPrice.left > 0) {
        price = { in: carryPrice.in, out: carryPrice.out }
        carryPrice.left -= 1
      }
      let noFreeTier = false
      if (carryNoFree > 0) { noFreeTier = true; carryNoFree -= 1 }

      for (const c of cells) {
        if (c.tag !== 'td') continue
        // 入出力形式のセルは料金ではない。ここで読むと、料金で読めた値（rowspan で引き継いだ分も）が null で上書きされる
        if (isFormatCell(c.html)) continue
        const pin = priceIn(c.html, 'Input')
        const pout = priceIn(c.html, 'Output')
        if (pin !== undefined || pout !== undefined) {
          price = { in: pin ?? null, out: pout ?? null }
          const span = rowspanOf(c.attrs)
          carryPrice = span > 1 ? { ...price, left: span - 1 } : null
        }
        if (textOf(c.html) === '対象外') {
          noFreeTier = true
          const span = rowspanOf(c.attrs)
          if (span > 1) carryNoFree = Math.max(carryNoFree, span - 1)
        }
      }

      const ths = cells.filter((c) => c.tag === 'th' && textOf(c.html))
      if (!ths.length) continue
      // モデル名は、カテゴリ列でない最後の <th>。カテゴリ列しか無い行（RAG）はモデルの行ではない。
      // ただし料金のセル（Input/Output）がある行は、従来どおり最後の <th> を名前として拾う（黙って落とさない）
      const nameThs = ths.filter((c) => !isCategoryCell(c.html))
      if (!nameThs.length && !price) continue
      // カテゴリ列を名前の代わりに読むときは、その <small>（文章の生成 など）を名前に混ぜない
      const nameFrom = nameThs.length ? nameThs : ths.map((c) => ({ ...c, html: stripTrailingSmall(c.html) }))
      const parsed = nameFrom.map((c) => nameCell(c.html))
      // 名前は、札を外しても名前が残る最後の <th>。札が独立した <th> に分かれていても、行のどこかに札があれば区分の印にする。
      // 札しか無くて名前が空になる行は、札の文字を名前に戻す（黙って捨てない。通常・プレビューの表なら新顔か
      // 料金を読めなかった行として出る。札の文字を名前にするので、区分は変えない）
      const named = parsed.filter((p) => p.name)
      const last = parsed[parsed.length - 1]
      const { name, since, provider, previewTag } = named.length
        ? { ...named[named.length - 1], previewTag: parsed.some((p) => p.previewTag) }
        : { ...last, name: last.tagText ?? '', previewTag: false }
      if (!name) {
        // 名前がどうしても読めないのに料金がある、通常・プレビューの行は黙って捨てない（読み違いとして止める）
        if (price && (section === SECTION.standard || section === SECTION.preview)) {
          throw new PricingPageError(`モデル名を読めない行に料金がありました（${SECTION_LABEL[section]}）。ページの形が変わった可能性があります。`)
        }
        continue
      }
      // 通常の表の中の札つきの行はプレビュー。クローズド・区分不明の表の中の札は区分を変えない
      const rowSection = previewTag && section === SECTION.standard ? SECTION.preview : section
      // 区分不明の表（料金表以外の表かもしれない）は、料金のセルのある行だけを読む。
      // 通常・プレビューの行は料金を読めなくても落とさない（照合で「料金を読めなかった行」にする）
      if (section === SECTION.unknown && !price) continue

      rows.push({
        name,
        section: rowSection,
        since,
        in: section === SECTION.closed || !price ? null : price.in,
        out: section === SECTION.closed || !price ? null : price.out,
        noFreeTier,
        provider,
      })
    }
  }
  return rows
}

/**
 * API で使う名前の候補（区分から導く）。通常 → 表の名前そのまま、プレビュー → 'preview/'＋表の名前。
 * ⚠️ これは 2026-09-25 時点の観察（10件すべてそうだった）であって、仕様に書かれてはいない。
 * 実在は npm run check:models（キーが要る）かお知らせで確かめること。クローズド・区分不明は null。
 */
export function apiIdCandidate(row) {
  if (row.section === SECTION.standard) return row.name
  if (row.section === SECTION.preview) return `preview/${row.name}`
  return null
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const sameYen = (a, b) => isNum(a) && isNum(b) && Math.abs(a - b) < 1e-9

/**
 * 公式の料金表の行と Koto の PRICING（¥/100万トークン）を突き合わせる。
 * チャット用でないもの（NON_CHAT・check-models.mjs と同じ判定）は、公式の行からも Koto の PRICING からも外す。
 * 返り値:
 *   matched      … 一致
 *   mismatched   … 食い違い（公式・Koto とも料金を読めたもの）
 *   newcomers    … 公式にあって Koto の PRICING に無い（新顔・料金を読めたもの）
 *   unreadable   … 料金を読めなかった行（公式の表にあるが Input/Output の形で読めない。一致とも新顔とも判定しない）
 *   kotoOnly     … Koto の PRICING にだけある（提供終了の可能性）
 *   closed       … クローズド（料金非公開）
 *   excluded     … 公式の行のうち、チャット用でないので外したもの（表示用）
 *   kotoExcluded … Koto の PRICING のうち、チャット用でないので照合しなかったもの（表示用）
 * 料金を読めたチャット用の行が MIN_PRICED_ROWS 未満、同じ API 名の行が2つ、Koto の PRICING が空、のときは例外。
 * @param {ReturnType<typeof parsePricingPage>} rows
 * @param {Record<string, {in:number,out:number}>} pricing
 */
export function comparePricing(rows, pricing) {
  const kotoIds = Object.keys(pricing ?? {})
  if (!kotoIds.length) throw new PricingPageError('Koto の PRICING が空です（読み先がずれていないか確認してください）')

  const excluded = rows.filter((r) => NON_CHAT.test(r.name)).map((r) => r.name)
  const chat = rows.filter((r) => !NON_CHAT.test(r.name))
  const closedRows = chat.filter((r) => r.section === SECTION.closed)
  const open = chat.filter((r) => r.section !== SECTION.closed)

  // 門: 区分の分かる行で料金まで読めたものが少なすぎる＝ページの形が変わった。差分を出さない
  const priced = open.filter((r) => (r.section === SECTION.standard || r.section === SECTION.preview) && isNum(r.in) && isNum(r.out))
  if (priced.length < MIN_PRICED_ROWS) {
    throw new PricingPageError(
      `料金表を読めたチャット用の行が ${priced.length}件しかありません（${MIN_PRICED_ROWS}件未満）。`
      + 'ページの形が変わった可能性があります。読み違いのまま照合しないよう、ここで止めます。',
    )
  }

  // 同じ API 名の行が2回＝二重に数えている（script の複写など）。読み違いとして止める
  const seen = new Set()
  for (const r of open) {
    const key = apiIdCandidate(r) ?? `${r.section}:${r.name}`
    if (seen.has(key)) throw new PricingPageError(`同じモデルの行が2回読めました（${key}）。ページの読み方がずれている可能性があります。`)
    seen.add(key)
  }

  const matched = []
  const mismatched = []
  const newcomers = []
  const unreadable = []
  const onPage = new Set()
  const bare = (id) => id.replace(/^preview\//, '')

  for (const r of open) {
    const id = apiIdCandidate(r)
    const official = { in: r.in, out: r.out }
    const inKoto = !!id && Object.prototype.hasOwnProperty.call(pricing, id)
    if (inKoto) onPage.add(id)
    // 料金を読めない行は、一致・食い違い・新顔のどれにもしない（読めた分だけで判定しない）
    if (!isNum(r.in) || !isNum(r.out)) {
      unreadable.push({
        id,
        name: r.name,
        section: r.section,
        since: r.since,
        ...official,
        koto: inKoto ? { in: pricing[id].in, out: pricing[id].out } : null,
        sameNameInKoto: inKoto ? null : (kotoIds.find((k) => bare(k) === r.name) ?? null),
      })
      continue
    }
    if (inKoto) {
      const koto = pricing[id]
      if (sameYen(official.in, koto.in) && sameYen(official.out, koto.out)) matched.push({ id, name: r.name, section: r.section, ...official })
      else mismatched.push({ id, name: r.name, section: r.section, official, koto: { in: koto.in, out: koto.out } })
      continue
    }
    newcomers.push({
      id,
      name: r.name,
      section: r.section,
      since: r.since,
      in: r.in,
      out: r.out,
      noFreeTier: r.noFreeTier,
      // 区分が変わった（プレビュー → 通常 など）可能性の手がかり
      sameNameInKoto: kotoIds.find((k) => bare(k) === r.name) ?? null,
    })
  }

  // Koto 側もチャット用でないものは外す（公式側で外したものを「提供終了の可能性」と誤報しない）
  const kotoExcluded = kotoIds.filter((id) => NON_CHAT.test(id))
  const kotoOnly = kotoIds
    .filter((id) => !NON_CHAT.test(id) && !onPage.has(id))
    .map((id) => ({ id, sameNameOnPage: open.find((r) => r.name === bare(id)) ? bare(id) : null }))

  const closed = closedRows.map((r) => ({ name: r.name, provider: r.provider }))
  return { matched, mismatched, newcomers, unreadable, kotoOnly, closed, excluded, kotoExcluded }
}

/** 終了コード: 食い違い・新顔・料金を読めなかった行・Koto にだけある のどれかがあれば 1、全部一致なら 0（クローズドは数えない） */
export function exitCodeFor(result) {
  return result.mismatched.length || result.newcomers.length || result.unreadable.length || result.kotoOnly.length ? 1 : 0
}

const per10k = (v) => (isNum(v) ? String(roundYen(v / 100)) : '?')
const yen = (v) => (isNum(v) ? String(v) : '読めず')

/**
 * 新顔1件ぶんの、そのまま貼れる登録案（行の配列）。
 * ツール・画像の対応は書かない（ページに無い。Koto が使いながら学ぶ）。
 * @param {ReturnType<typeof comparePricing>['newcomers'][number]} n
 * @param {{ today: string, knownModelIds?: string[] }} opts
 */
export function registrationLines(n, { today, knownModelIds = [] }) {
  const out = []
  if (!n.id) {
    out.push(`    API 名を区分から導けません（${SECTION_LABEL[n.section] ?? n.section}）。登録案は出しません。お知らせで API 名を確かめてください。`)
    return out
  }
  out.push('    src/shared/usageBudget.ts の PRICING へ:')
  if (isNum(n.in) && isNum(n.out)) {
    out.push(`      '${n.id}': { in: ${n.in}, out: ${n.out} },  // ${per10k(n.in)} / ${per10k(n.out)} 円（1万tok）${today} 公式料金表`)
  } else {
    out.push(`      （料金を読めませんでした。公式ページで確かめてから書いてください: 入力 ${yen(n.in)} / 出力 ${yen(n.out)}）`)
  }
  if (knownModelIds.includes(n.id)) {
    out.push('    src/shared/modelInfo.ts の MODELS: すでに載っています。')
  } else {
    const label = n.section === SECTION.preview ? `${n.name}（プレビュー）` : n.name
    out.push('    src/shared/modelInfo.ts の MODELS へ（ラベルは仮。読みやすく整えてよい）:')
    if (n.since) out.push(`      // ${n.since} 提供開始（公式料金表）`)
    out.push(`      { id: '${n.id}', label: '${label}' },`)
  }
  out.push('    src/shared/modelInfo.ts の MODEL_PURPOSE へ（目的はページに無い。お知らせで確かめて埋める。分からなければこの行は足さない）:')
  out.push(n.noFreeTier
    ? `      '${n.id}': { purpose: '（目的）', note: '無償枠なし' },`
    : `      '${n.id}': { purpose: '（目的）' },`)
  return out
}

/**
 * 照合結果を日本語の行の配列にする（画面の文は素のテキスト・Markdown 記法を使わない）。
 * @param {ReturnType<typeof comparePricing>} result
 * @param {{ today: string, knownModelIds?: string[] }} opts
 */
export function formatReport(result, opts) {
  const L = []
  const { matched, mismatched, newcomers, unreadable, kotoOnly, closed, excluded, kotoExcluded } = result
  L.push('=== さくらのAI Engine 公式料金表 × Koto の PRICING ===')
  L.push(`出どころ: ${PRICING_PAGE_URL}（提供モデルと料金）`)
  L.push(`一致 ${matched.length}件 / 食い違い ${mismatched.length}件 / 新顔 ${newcomers.length}件 / 料金を読めなかった行 ${unreadable.length}件 / Koto にだけある ${kotoOnly.length}件 / クローズド ${closed.length}件`)
  if (excluded.length) L.push(`チャット用でないので外したもの: ${excluded.join('、')}`)
  if (kotoExcluded.length) L.push(`Koto の PRICING のうちチャット用でないので照合しなかったもの: ${kotoExcluded.join('、')}`)
  L.push('単位: Koto は 100万トークンあたり円、公式は 1万トークンあたり円（×100 して比べています）')

  if (matched.length) {
    L.push('')
    L.push(`● 一致（${matched.length}件）`)
    for (const m of matched) L.push(`    - ${m.id}  入力 ${m.in} / 出力 ${m.out}`)
  }
  if (mismatched.length) {
    L.push('')
    L.push(`● 食い違い（${mismatched.length}件）— src/shared/usageBudget.ts の PRICING を公式に合わせてください`)
    for (const m of mismatched) {
      L.push(`    - ${m.id}  公式: 入力 ${yen(m.official.in)} / 出力 ${yen(m.official.out)}  Koto: 入力 ${m.koto.in} / 出力 ${m.koto.out}`)
      if (!isNum(m.official.in) || !isNum(m.official.out)) L.push('      公式の料金を読めませんでした。ページで確かめてください。')
    }
  }
  if (newcomers.length) {
    L.push('')
    L.push(`● 新顔（公式にあって Koto の PRICING に無い・${newcomers.length}件）`)
    L.push('  API 名は区分から導いた候補です（通常 → 表の名前そのまま、プレビュー → preview/＋表の名前）。')
    L.push('  実在は npm run check:models（キーが要る）か、さくらのお知らせで確かめてから登録してください。')
    L.push('  ツール・画像の対応はページに無いので書いていません（Koto が使いながら学びます）。')
    for (const n of newcomers) {
      L.push('')
      const since = n.since ? `・${n.since} 提供開始` : ''
      const free = n.noFreeTier ? '・無償枠なし' : ''
      L.push(`  - ${n.name}（${SECTION_LABEL[n.section] ?? n.section}${since}${free}）→ API 名の候補: ${n.id ?? '導けません'}`)
      if (n.sameNameInKoto) L.push(`    Koto には ${n.sameNameInKoto} として載っています。区分が変わった可能性があります。`)
      L.push(...registrationLines(n, opts))
    }
  }
  if (unreadable.length) {
    L.push('')
    L.push(`● 料金を読めなかった行（公式の料金表にあるが、料金を「Input / Output」の形で読めない・${unreadable.length}件）— 公式ページで確かめてください`)
    L.push('  一致とも新顔とも判定していません（書き方が変わった・お問い合わせ・別の単位 などの可能性）。')
    L.push('  チャット用でないモデルなら、scripts/lib/appConfig.mjs と src/renderer/usage.ts の NON_CHAT に足してください（両方そろえる）。')
    for (const u of unreadable) {
      const since = u.since ? `・${u.since} 提供開始` : ''
      L.push(`    - ${u.name}（${SECTION_LABEL[u.section] ?? u.section}${since}）→ API 名の候補: ${u.id ?? '導けません'}  読めた値: 入力 ${yen(u.in)} / 出力 ${yen(u.out)}`)
      if (u.koto) L.push(`      Koto には ${u.id} として載っています（入力 ${u.koto.in} / 出力 ${u.koto.out}）。公式の料金が変わっていないか確かめてください。`)
      if (u.sameNameInKoto) L.push(`      Koto には ${u.sameNameInKoto} として載っています。区分が変わった可能性があります。`)
    }
  }
  if (kotoOnly.length) {
    L.push('')
    L.push(`● Koto にだけある（公式の料金表に見当たらない・${kotoOnly.length}件）— 提供終了の可能性`)
    L.push('  提供終了かどうかは npm run check:models（キーが要る）かお知らせで確かめてください。')
    for (const k of kotoOnly) {
      L.push(`    - ${k.id}`)
      if (k.sameNameOnPage) L.push(`      公式には ${k.sameNameOnPage} が別の区分で載っています。区分が変わった可能性があります。`)
    }
  }
  if (closed.length) {
    L.push('')
    L.push(`● クローズド（料金は公開されていない・${closed.length}件）— 照合していません`)
    for (const c of closed) L.push(`    - ${c.name}${c.provider ? `（提供元: ${c.provider}）` : ''}`)
  }
  L.push('')
  L.push(exitCodeFor(result)
    ? '要確認: 上の食い違い・新顔・料金を読めなかった行・Koto にだけある を見直してください。'
    : '差分なし: チャット用モデルの料金は公式の料金表と一致しています。')
  return L
}
