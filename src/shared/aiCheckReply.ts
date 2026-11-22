// aiCheckReply.ts — 「AI の確認」の返事の取り出しと検証。
//
// AI の返事は、そのまま信用しない。送っていないファイルの指摘は捨て、引用が送った本文にあるかで
// 行と確かさを Koto が決める（AI が書いた行番号は、近さを比べるためだけに使う）。
// note・quote は、伏せ直して1行にして長さを切る（値そのものを、戻り値に残さない）。

import { maskSecretShapes } from './secretShapes'
import { HIDDEN_CHAR_SRC } from './securityFindings'
import {
  AI_FINDINGS_PER_BATCH,
  AI_QUOTE_NEAR_LINES,
  AI_QUOTE_MIN_CHARS,
  AI_NOTE_MAX_CHARS,
  AI_QUOTE_MAX_CHARS,
  AI_REPLY_MAX_CHARS,
  AI_JSON_SCAN_LIMIT,
  AI_EMPTY_AROUND_MAX_CHARS,
} from './aiCheckLimits'
import { addFindingKeepingHeavier, aiSeverityOf, isAiCheckKind, promptName, sortAiFindings, type AiCertainty, type AiCheckKind, type AiFinding } from './aiCheckFindings'

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 自分の鍵だけを読む（__proto__・constructor などを継承で読まない）。 */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined
}

/** start の「{」から、文字列とエスケープを考えて、閉じる所の次の位置を返す。閉じなければ -1。 */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function matchOf(text: string, start: number, end: number): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end))
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  const findings = own(parsed, 'findings')
  return Array.isArray(findings) ? findings : null
}

/** 頼んだ形の書き出し（{"findings":）。文字列の中に写されたもの（\\" で始まる）には当たらない。 */
const FINDINGS_OPEN_RE = /\{\s*"findings"\s*:/g

/** 括弧を数える手間の上限（文字数の合計）。超えたら、そこまでに見つけたものを使う。 */
const SCAN_WORK_LIMIT = 20_000_000

/** 始まりの候補を後ろから試し、形の合う塊のうち、終わりがいちばん後ろのものを返す。 */
function pickLast(text: string, starts: number[]): { start: number; end: number; findings: unknown[] } | null {
  let best: { start: number; end: number; findings: unknown[] } | null = null
  let work = 0
  for (let k = starts.length - 1; k >= 0 && work <= SCAN_WORK_LIMIT; k--) {
    const end = balancedEnd(text, starts[k])
    work += (end < 0 ? text.length : end) - starts[k]
    if (end < 0) continue
    if (best && end <= best.end) continue // 前に見つけた塊の中にある（中の塊は採らない）
    const findings = matchOf(text, starts[k], end)
    if (findings) best = { start: starts[k], end, findings }
  }
  return best
}

/**
 * 返事の中の、最後の「findings が配列のオブジェクト」を取り出す。採れなければ null（例外は投げない）。
 * 始まりの候補は2種類: 頼んだ形の書き出し（{"findings":）と、後ろから数えた「{」（findings が先頭の鍵でない書き方のため）。
 * 書き出しの形は JSON の本当の始まりなので、前置きの文・思考の文に引用符や「{」があっても乱されず、指摘が多くても採れる。
 * 候補のうち、形が合い、終わりがいちばん後ろのもの（＝いちばん外側の、最後の塊）を採る。
 */
export function extractLastFindingsJson(raw: string): { findings: unknown[] } | null {
  const got = extractLastFindings(raw)
  return got ? { findings: got.findings } : null
}

/** extractLastFindingsJson と同じ。あわせて、塊の前（head）と後ろ（tail）の文字も返す。 */
function extractLastFindings(raw: string): { findings: unknown[]; head: string; tail: string } | null {
  try {
    if (typeof raw !== 'string' || raw.length === 0) return null
    const text = raw.length > AI_REPLY_MAX_CHARS ? raw.slice(raw.length - AI_REPLY_MAX_CHARS) : raw
    const opens: number[] = []
    for (const m of text.matchAll(FINDINGS_OPEN_RE)) opens.push(m.index ?? 0)
    const braces: number[] = []
    for (let at = text.lastIndexOf('{'); at >= 0 && braces.length < AI_JSON_SCAN_LIMIT; at = at === 0 ? -1 : text.lastIndexOf('{', at - 1)) braces.push(at)
    const starts = [...new Set([...opens.slice(-AI_JSON_SCAN_LIMIT), ...braces])].sort((x, y) => x - y)
    const best = pickLast(text, starts)
    return best ? { findings: best.findings, head: text.slice(0, best.start), tail: text.slice(best.end) } : null
  } catch {
    return null
  }
}

/** 送ったかたまり。lines は、送った本文（伏せたあと）の行。startLine は最初の行の番号（1 始まり）。 */
export interface SentPiece {
  file: string
  startLine: number
  lines: string[]
  served: boolean
}

/** 中身を送らず、名前だけを渡したファイル。 */
export interface SentName {
  file: string
  served: boolean
  /** 指摘を取り上げない名前（数えもしない）。公開から外れる秘密らしい名前。 */
  ignore?: boolean
}

export type AiReplyResult = { state: 'unreadable' } | { state: 'ok'; findings: AiFinding[]; malformed: number; cut: number }

const LINE_BREAK_RE = new RegExp('\\r\\n|[\\n\\r\\u2028\\u2029]')
const HIDDEN_RE = new RegExp(HIDDEN_CHAR_SRC, 'g')

/** 幅のない文字・向きの制御・BOM（空白にせず、取り除く。語の途中に挟まれて分割されるのを防ぐ）。 */
const INVISIBLE_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** 伏せて、改行・制御文字・見かけを変える文字を除き、前後を除き、長さを切る。値を分割して残さないよう、除くたびに伏せ直す。 */
function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  let s = maskSecretShapes(v)
  s = maskSecretShapes(s.replace(INVISIBLE_RE, ''))
  s = maskSecretShapes(s.replace(HIDDEN_RE, ' ')).trim()
  const chars = Array.from(s)
  return chars.length > max ? chars.slice(0, max).join('') : s
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function isLineNo(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v)
}

export function parseAiReply(raw: string, sent: { pieces: SentPiece[]; names: SentName[] }): AiReplyResult {
  const got = extractLastFindings(raw)
  if (!got) return { state: 'unreadable' }
  // 指摘が空の塊の前にも後ろにも文があるときは、考えの文に書かれた例かもしれない。「問題なし」と読まない
  const around = (t: string) => t.replace(/[\s`]/g, '').length
  if (got.findings.length === 0 && around(got.head) > AI_EMPTY_AROUND_MAX_CHARS && around(got.tail) > AI_EMPTY_AROUND_MAX_CHARS) return { state: 'unreadable' }

  // 依頼文の見出しは promptName 済みの名前なので、AI はその名前で答える。送った側も同じ名前に直して照合し、
  // 戻りの file は送った名前（実ファイルに戻せる名前）にする。
  const piecesBy = new Map<string, SentPiece[]>()
  for (const p of sent.pieces) piecesBy.set(p.file, [...(piecesBy.get(p.file) ?? []), p])
  const namesBy = new Map<string, SentName>()
  for (const n of sent.names) namesBy.set(n.file, n)
  const rawsByShown = new Map<string, Set<string>>()
  for (const f of [...piecesBy.keys(), ...namesBy.keys()]) {
    const shown = promptName(f)
    rawsByShown.set(shown, (rawsByShown.get(shown) ?? new Set<string>()).add(f))
  }

  const items = got.findings
  const cut = Math.max(0, items.length - AI_FINDINGS_PER_BATCH)
  let malformed = 0
  const byKey = new Map<string, AiFinding>()

  for (const item of items.slice(0, AI_FINDINGS_PER_BATCH)) {
    if (!isObject(item)) {
      malformed++
      continue
    }
    const rawFile = own(item, 'file')
    const rawKind = own(item, 'kind')
    if (typeof rawFile !== 'string' || rawFile === '' || typeof rawKind !== 'string') {
      malformed++
      continue
    }
    let file: string
    if (piecesBy.has(rawFile) || namesBy.has(rawFile)) file = rawFile
    else {
      const raws = rawsByShown.get(promptName(rawFile))
      if (!raws || raws.size !== 1) {
        malformed++
        continue
      }
      file = [...raws][0]
    }
    const filePieces = piecesBy.get(file)
    const name = namesBy.get(file)
    if (name?.ignore && !filePieces) continue

    let kind: AiCheckKind = 'other'
    let certainty: AiCertainty = 'ai'
    if (isAiCheckKind(rawKind)) kind = rawKind
    else certainty = 'unverified'

    const rawQuote = own(item, 'quote')
    const note = cleanText(own(item, 'note'), AI_NOTE_MAX_CHARS)
    const quote = cleanText(rawQuote, AI_QUOTE_MAX_CHARS)

    const aiLine = own(item, 'line')
    let line: number | undefined
    let served: boolean

    if (!filePieces) {
      // 名前だけ渡したファイル: 行は付けない
      served = name!.served
    } else {
      served = filePieces[0].served
      const firstLine = typeof rawQuote === 'string' ? maskSecretShapes(rawQuote).split(LINE_BREAK_RE)[0] : ''
      // 番号ごと写してきた引用（「12| const a」）は、番号を除いて照合する
      const q = squash(firstLine.replace(/^\s*\d+\|\s?/, ''))
      let found: number | undefined
      if (Array.from(q).length >= AI_QUOTE_MIN_CHARS) {
        const hits: number[] = []
        for (const p of filePieces) {
          p.lines.forEach((l, i) => {
            if (squash(l).includes(q)) hits.push(p.startLine + i)
          })
        }
        hits.sort((a, b) => a - b)
        if (hits.length) {
          // AI の言う行の近くにあれば、その中でいちばん近い行。近くに無いときは、ファイルの中に1つだけなら
          // その行に直す。離れた所に2つ以上あるときは、どれを指しているか決められない（確かめられていません）
          const near = isLineNo(aiLine) ? hits.filter(n => Math.abs(n - aiLine) <= AI_QUOTE_NEAR_LINES) : []
          if (near.length) found = near.reduce((x, y) => (Math.abs(y - (aiLine as number)) < Math.abs(x - (aiLine as number)) ? y : x))
          else if (hits.length === 1) found = hits[0]
        }
      }
      if (found !== undefined) {
        // 種類が列挙に無いときの unverified は、引用が見つかっても変えない
        line = found
      } else {
        certainty = 'unverified'
        if (isLineNo(aiLine) && filePieces.some(p => aiLine >= p.startLine && aiLine < p.startLine + p.lines.length)) line = aiLine
      }
    }

    const key = `${file}\u0000${line ?? ''}\u0000${kind}`

    const f: AiFinding = { kind, severity: aiSeverityOf(kind, certainty, served), certainty, file, note, quote }
    if (line !== undefined) f.line = line
    addFindingKeepingHeavier(byKey, key, f)
  }

  return { state: 'ok', findings: sortAiFindings([...byKey.values()]), malformed, cut }
}
