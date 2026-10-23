// chatMarkdown.ts — AI の返事の「説明文」を、太字・箇条書き・見出し・インラインコードに分ける（純関数）。
//
// ── なぜ作ったか（2026-10-09 作者決定）──────────────────────────────────
// AI の吹き出しは、コードブロック以外をただの文字で出していた。AI が書く **太字** や
// 「- 」の箇条書き・「### 見出し」・`インラインコード` の記号がそのまま見え、
// 非エンジニアの利用者には読みにくい。「太字と箇条書きを描けるようにする」を選んだ。
//
// ── 決まり ──────────────────────────────────────────────────────────────
//  ・React に依存しない。HTML の文字列も作らない（描くのは AiMessage.tsx。タグは作れないので
//    AI の返事に <script> が入っても文字として出る）
//  ・受け取るのは parseMessage（AiMessage.tsx）が先にコードブロック（```）を切り出した「文」の部分だけ
//  ・太字は 1 行の中の **…** の対で見る（CommonMark の左右の決まりは使わない）。
//    日本語の句読点・括弧・絵文字に隣り合っていても太字にする。対にならない ** は文字のまま
//  ・閉じられる ** は、左にあるいちばん近い開きと対にする。数式の 2**3 や src/**/*.js が先にあっても、
//    あとの本物の太字が対になり、数式の ** は文字のまま残る（`2**3 と **太字**` は「太字」だけが太字）。
//    対にしたら、それより前の開きは捨てる（太字を入れ子にしない）。
//    3 個以上続く * は区切りにしない（`***強調***` は文字のまま）。両側が空白の ** どうしは対にしない（`x ** 2 ... y ** 3`）。
//    1 行に `x**2 と y**3` のような数式が 2 つあると、間を太字にしてしまう（日本語の語の途中の太字 A**B**C と見分けられない）
//  ・`…` の中は太字にしない。`…` が先（CommonMark と同じ）
//  ・番号つき（1. ）は変えない（そのままで読める）。段落の中の改行は保つ
//  ・例外を投げない。長さに対して線形（入れ子の量指定をする正規表現を使わない）。
//    流し込み中の閉じていない ** や ` は文字のまま出る（閉じたら太字になる）
//  ・閉じていない ``` （流し込み中。parseMessage は閉じた ``` しか切り出さない）の行から終わりまでは、
//    コードの途中なので何も解釈せず、そのまま（raw）にする。解釈すると、コードの中の # ・字下げ・** が消える

export type ChatInline =
  | { t: 'text'; s: string }
  | { t: 'bold'; s: string }
  | { t: 'code'; s: string }

export type ChatBlock =
  | { kind: 'para'; lines: ChatInline[][] }
  | { kind: 'list'; items: ChatInline[][] }
  | { kind: 'heading'; inlines: ChatInline[] }
  | { kind: 'raw'; text: string }

/** 行頭の「#」〜「######」＋空白。 */
const HEADING_MARK = /^#{1,6}[ \t]+/
/** 行頭（前の空白は許す）の「- 」「* 」「・」。「・」は空白なしでも箇条書き。 */
const LIST_MARK = /^[ \t]*(?:[-*][ \t]+|・[ \t]*)/

/** 行頭（前の空白は許す）の ```。閉じていないコードブロックの始まり。 */
const FENCE_OPEN = /^[ \t]*```/

function pushInline(out: ChatInline[], t: ChatInline['t'], s: string): void {
  if (!s) return
  const last = out[out.length - 1]
  if (t === 'text' && last && last.t === 'text') last.s += s
  else if (t === 'bold' && last && last.t === 'bold') last.s += s
  else out.push({ t, s })
}

/**
 * 1 行の中の ChatInline への分解。
 *  1. `…` の範囲を先に決める（中の ** は太字にしない）
 *  2. コードの外の ** を、閉じられるものから順に「いちばん近い開き」と対にする（上のヘッダの決まり）
 *  3. 太字の中にコードがあれば「太字・コード・太字」に割る
 */
export function parseChatInline(line: string): ChatInline[] {
  const out: ChatInline[] = []
  if (typeof line !== 'string' || line === '') return out
  const n = line.length

  // 1. コードの範囲 [開始, 終了)（バッククォートを含む）
  const codes: Array<[number, number]> = []
  const inCode = new Uint8Array(n)
  for (let i = 0; i < n; ) {
    const a = line.indexOf('`', i)
    if (a < 0) break
    const b = line.indexOf('`', a + 1)
    if (b < 0) break
    if (b === a + 1) { i = b + 1; continue } // 空の `` は文字のまま
    codes.push([a, b + 1])
    for (let k = a; k <= b; k++) inCode[k] = 1
    i = b + 1
  }

  // コードの外にある次の ** の位置（無ければ -1）。3 個以上続く * の一部（*** や ****）は区切りに数えない
  const nextStars = (from: number): number => {
    let p = from
    for (;;) {
      const q = line.indexOf('**', p)
      if (q < 0) return -1
      if (!inCode[q] && line[q - 1] !== '*' && line[q + 2] !== '*') return q
      p = q + 1
    }
  }
  const isSpaceAt = (i: number): boolean => i < 0 || i >= n || /\s/.test(line[i])

  // 2. 太字の対 [開き, 閉じ]（** の位置）。開きの候補を積み、閉じられる ** が来たら、いちばん近い開きと対にする
  const bolds: Array<[number, number]> = []
  let opens: Array<{ at: number; float: boolean }> = []
  for (let p = 0; ; ) {
    const at = nextStars(p)
    if (at < 0) break
    p = at + 2
    const before = isSpaceAt(at - 1) // 直前が空白（行頭を含む）
    const after = isSpaceAt(at + 2) // 直後が空白（行末を含む）
    const float = before && after // 両側が空白: a ** b
    const canOpen = before || !after // 「直前が文字で直後が空白」(foo** ) は閉じ専用
    const canClose = !before || after // 「直前が空白で直後が文字」( **foo) は開き専用
    const top = opens[opens.length - 1]
    if (top && canClose && !(top.float && float) && line.slice(top.at + 2, at).trim() !== '') {
      bolds.push([top.at, at])
      opens = [] // 対にしたら、それより前の開きは捨てる（入れ子にしない）
      continue
    }
    if (canOpen) opens.push({ at, float })
  }

  // 3. 組み立て。範囲 [from, to) を、コードで割りながら kind（text か bold）で出す
  let ci = 0
  const emit = (from: number, to: number, kind: 'text' | 'bold'): void => {
    let pos = from
    while (pos < to) {
      while (ci < codes.length && codes[ci][1] <= pos) ci++
      const c = codes[ci]
      if (c && c[0] < to && c[0] >= pos) {
        pushInline(out, kind, line.slice(pos, c[0]))
        pushInline(out, 'code', line.slice(c[0] + 1, c[1] - 1))
        pos = c[1]
      } else {
        pushInline(out, kind, line.slice(pos, to))
        pos = to
      }
    }
  }
  let cursor = 0
  for (const [open, close] of bolds) {
    emit(cursor, open, 'text')
    emit(open + 2, close, 'bold')
    cursor = close + 2
  }
  emit(cursor, n, 'text')
  return out
}

/** 返事の「文」の部分を、段落・箇条書き・見出しのブロックに分ける。 */
export function parseChatText(text: string): ChatBlock[] {
  const blocks: ChatBlock[] = []
  if (typeof text !== 'string' || text === '') return blocks

  let para: ChatInline[][] | null = null
  let list: ChatInline[][] | null = null
  const flush = (): void => {
    if (para) { blocks.push({ kind: 'para', lines: para }); para = null }
    if (list) { blocks.push({ kind: 'list', items: list }); list = null }
  }

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 閉じていない ```: ここから終わりまではコードの途中。何も解釈しない（# ・字下げ・** を消さない）
    if (FENCE_OPEN.test(line)) {
      flush()
      blocks.push({ kind: 'raw', text: lines.slice(i).join('\n').trimEnd() })
      break
    }
    if (line.trim() === '') { flush(); continue }

    const h = HEADING_MARK.exec(line)
    if (h) {
      const rest = line.slice(h[0].length).trim()
      if (rest) {
        flush()
        blocks.push({ kind: 'heading', inlines: parseChatInline(rest) })
        continue
      }
    }

    const l = LIST_MARK.exec(line)
    if (l) {
      const rest = line.slice(l[0].length).trim()
      if (rest) {
        if (para) { blocks.push({ kind: 'para', lines: para }); para = null }
        if (!list) list = []
        list.push(parseChatInline(rest))
        continue
      }
    }

    if (list) { blocks.push({ kind: 'list', items: list }); list = null }
    if (!para) para = []
    para.push(parseChatInline(line))
  }
  flush()
  return blocks
}
