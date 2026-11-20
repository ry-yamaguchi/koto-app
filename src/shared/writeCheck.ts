// writeCheck.ts — AI が書いたファイルの中身の点検（純関数）。
//
// 見つけるのは、キーやパスワードの直書き（形の判定は secretShapes.ts に任せる）と、
// 訪問者の入力をそのまま使う危ない書き方3つ。後者は、同じ行の中に入口と出口の両方が見えるものだけを数える
// （流れは追わない）。迷う形は通す。誤検知が続くと、本物の警告が読まれなくなるため。
// 前からあった行は出さない。AI は既存のファイルを全文で書き戻すので、全文を調べると毎回同じ警告になる。

import { findSecretShapes } from './secretShapes'
import { TEST_PATH_QUIET_KINDS, type WriteFinding } from './securityFindings'
import { WRITE_CHECK_MAX_LINE_CHARS } from './writeCheckLimits'

/** 1ファイルから返す件数の上限（画面に出す上限とは別）。 */
const FINDINGS_PER_FILE_LIMIT = 200

/** 危ない書き方を見るファイルの拡張子。秘密は拡張子によらず見る。 */
const CODE_EXT_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|html|vue|svelte)$/i

/** 見本のファイル（本物の値が入らない）。`config.example.js` のように、その後ろに拡張子が付くものも含む。 */
const SAMPLE_FILE_RE = /\.(?:example|sample|template|dist)(?:\.[a-z0-9]+)?$/i

/** テスト・fixture のパス。ここの見本のパスワードは、名前だけで決める形を出さない。 */
const TEST_PATH_RE = /(?:^|[\\/])(?:tests?|__tests__|fixtures?)[\\/]|\.(?:test|spec)\.[a-z0-9]+$/i

/** 訪問者の入力の入口。 */
const INPUT_SRC =
  '\\b(?:req|request)\\.(?:query|body|params)\\b' +
  '|\\blocation\\.(?:search|hash|href)\\b' +
  '|\\bsearchParams\\b' +
  '|\\.target\\.value\\b' +
  '|\\b(?:getElementById|querySelector)\\([^)]*\\)\\.value\\b' +
  '|\\b(?:\\w*[Ii]nput|\\w*[Ff]ield|\\w*[Ee]lem(?:ent)?|el)\\.value\\b'
const INPUT_RE = new RegExp(INPUT_SRC)

const INPUT_ALL_RE = new RegExp(INPUT_SRC, 'g')

/**
 * 入力を無害にする関数・数や真偽に変える関数の呼び出し（この中の入力は数えない）。
 * 数・長さ・真偽にしてから使う書き方は、そのまま使うことにならない。
 */
const SAFE_CALL_RE = /\b\w*(?:escape|sanitize|encode|purify|quote)\w*\s*\(|\b(?:Number|parseInt|parseFloat|Boolean|Math\.\w+)\s*\(/gi

/** 入力の直後が、長さ（`.length`）・条件（`?`・`==`・`<` など）なら、入力の中身は出口へ届かない。 */
const HARMLESS_AFTER_INPUT_RE = /^\s*(?:\.length\b|\?(?![?.])|[=!]==?|[<>]=?)/
const BASENAME_CALL_RE = /\b(?:path\.)?basename\s*\(/g

// 前置き無しの呼びと、コマンド実行の持ち主（child_process・cp・shell）の呼びだけ。正規表現の `.exec(` は数えない
const COMMAND_CALL_RE = /(?:(?<![.\w])|\b(?:child_process|childProcess|cp|shell)\.)(?:exec|execSync|spawn)\s*\(/g
const PATH_CALL_RE = /\b(?:readFile|readFileSync|createReadStream|sendFile|writeFile|writeFileSync)\s*\(/g
const HTML_ASSIGN_RE = /\b(?:innerHTML|outerHTML)\s*\+?=(?!=)\s*(.*)$/
const HTML_CALL_RE = /\b(?:document\.write|insertAdjacentHTML)\s*\(/g
const SEND_CALL_RE = /\bres\.send\s*\(/g

/** 最初の `;`（引用符・括弧の外）までを返す。行の中の別の文を、代入の右辺に数えないため。 */
function untilStatementEnd(s: string): string {
  let depth = 0
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ';' && depth <= 0) return s.slice(0, i)
  }
  return s
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return p.slice(i + 1)
}

/** `(` の次から、閉じ括弧の位置を返す（無ければ文字列の長さ）。引用符の中は数えない。 */
function closeIndex(s: string, from: number): number {
  let depth = 0
  let quote = ''
  for (let i = from; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i
      depth--
    }
  }
  return s.length
}

/** 最初の引数の文字列（`(` の次から）。 */
function firstArg(s: string): string {
  let depth = 0
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return s.slice(0, i)
      depth--
    } else if (ch === ',' && depth === 0) return s.slice(0, i)
  }
  return s
}

/** 名前に当たる呼び出し（括弧の中ごと）を取り除く。 */
function stripCalls(s: string, re: RegExp): string {
  let out = ''
  let pos = 0
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m: RegExpExecArray | null
  while ((m = g.exec(s)) !== null) {
    if (m.index < pos) continue
    out += s.slice(pos, m.index)
    const end = closeIndex(s, m.index + m[0].length)
    pos = Math.min(s.length, end + 1)
    g.lastIndex = pos
  }
  return out + s.slice(pos)
}

/** 引用符の中の文字（固定の文字列）を空にする。バッククォートは `${…}` の中だけ残す。 */
function dropLiterals(s: string): string {
  return s
    .replace(/`(?:\\.|[^`\\])*`/g, t => (t.match(/\$\{[^}]*\}/g) ?? []).join(' '))
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
}

/** 無害にする関数を通した分と、長さ・条件に使うだけの分を除いて、入力が残っているか。 */
function hasRawInput(s: string): boolean {
  const t = stripCalls(s, SAFE_CALL_RE)
  for (const m of t.matchAll(INPUT_ALL_RE)) {
    const rest = t.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40)
    if (!HARMLESS_AFTER_INPUT_RE.test(rest)) return true
  }
  return false
}

/** 長すぎて、危ない書き方の点検から外す行か。長さの上限の判断はここだけ。 */
function isTooLongLine(trimmed: string): boolean {
  return trimmed.length > WRITE_CHECK_MAX_LINE_CHARS
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('<!--')
}

function allArgs(line: string, re: RegExp): string[] {
  const g = new RegExp(re.source, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = g.exec(line)) !== null) out.push(line.slice(m.index + m[0].length))
  return out
}

function riskyKindsOfLine(line: string): Array<'input-to-command' | 'input-to-html' | 'input-to-path'> {
  const kinds: Array<'input-to-command' | 'input-to-html' | 'input-to-path'> = []
  if (!INPUT_RE.test(line)) return kinds

  // コマンド: 最初の引数に、文字列の埋め込み・連結・入力そのものが入っている。引数の配列は通す
  for (const rest of allArgs(line, COMMAND_CALL_RE)) {
    const arg = firstArg(rest).trim()
    if (arg && !arg.startsWith('[') && hasRawInput(dropLiterals(arg))) {
      kinds.push('input-to-command')
      break
    }
  }

  // HTML: res.send の HTML・innerHTML・outerHTML・document.write・insertAdjacentHTML
  let html = false
  const assign = HTML_ASSIGN_RE.exec(line)
  if (assign && hasRawInput(dropLiterals(untilStatementEnd(assign[1])))) html = true
  if (!html) {
    for (const rest of allArgs(line, HTML_CALL_RE)) {
      if (hasRawInput(dropLiterals(rest.slice(0, closeIndex(rest, 0))))) { html = true; break }
    }
  }
  if (!html) {
    for (const rest of allArgs(line, SEND_CALL_RE)) {
      const arg = rest.slice(0, closeIndex(rest, 0))
      if (/<\w/.test(arg) && hasRawInput(dropLiterals(arg))) { html = true; break }
    }
  }
  if (html) kinds.push('input-to-html')

  // パス: ファイルを開く関数の最初の引数に入力が入っている。basename を通す形は通す
  for (const rest of allArgs(line, PATH_CALL_RE)) {
    const arg = stripCalls(firstArg(rest), BASENAME_CALL_RE)
    if (hasRawInput(dropLiterals(arg))) {
      kinds.push('input-to-path')
      break
    }
  }
  return kinds
}

/** 見本の名前（.example・.sample・.template・.dist がつくもの）のファイルか。点検の対象にしない判断はここの1か所。 */
export function isSampleFileName(path: string): boolean {
  return SAMPLE_FILE_RE.test(baseName(path))
}

/** findingsInWrite が、行が長すぎるという理由で1行以上を危ない書き方の点検から外すファイルか。 */
export function hasLongLineSkipped(path: string, text: string): boolean {
  const base = baseName(path)
  if (isSampleFileName(path) || !CODE_EXT_RE.test(base)) return false
  return text.split('\n').some(raw => {
    const trimmed = raw.trim()
    return !!trimmed && !isCommentLine(trimmed) && isTooLongLine(trimmed)
  })
}

/**
 * 書いたファイルの中身を点検する。`before` は書く前の中身（新しいファイルなら null）。
 * `before` にある行（前後の空白を除いて同じ）は出さない。値そのものは戻り値に入れない。
 */
export function findingsInWrite(input: { path: string; before: string | null; after: string }): WriteFinding[] {
  const { path, before, after } = input
  const base = baseName(path)
  if (isSampleFileName(path)) return []

  const afterLines = after.split('\n')
  // テスト・fixture の見本のパスワードは、名前だけで決める形を出さない。キー・秘密鍵・接続文字列は出す
  const inTestPath = TEST_PATH_RE.test(path)
  const found: WriteFinding[] = findSecretShapes(after)
    .filter(s => !(inTestPath && TEST_PATH_QUIET_KINDS.includes(s.kind)))
    .map(s => ({
      kind: s.kind,
      line: s.line,
      length: s.length,
      sample: s.sample,
    }))

  if (CODE_EXT_RE.test(base)) {
    afterLines.forEach((raw, i) => {
      const trimmed = raw.trim()
      if (!trimmed || isCommentLine(trimmed)) return
      // とても長い行は見ない（点検の時間が行の長さの2乗で伸びるため。迷う形は通す）
      if (isTooLongLine(trimmed)) return
      for (const kind of riskyKindsOfLine(trimmed)) found.push({ kind, line: i + 1 })
    })
  }

  const beforeLines = before === null ? null : new Set(before.split('\n').map(l => l.trim()))
  return found
    .filter(f => !beforeLines || !beforeLines.has((afterLines[f.line - 1] ?? '').trim()))
    .sort((a, b) => a.line - b.line)
    .slice(0, FINDINGS_PER_FILE_LIMIT)
}
