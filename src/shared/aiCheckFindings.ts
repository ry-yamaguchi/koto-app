// aiCheckFindings.ts — 「AI の確認」の指摘の型・重さ・画面の文・修正の依頼文。
//
// 値（キーやパスワードそのもの）は、型にも文にも依頼文にも入れない。
// 修正の依頼文は、ファイル・行・種類だけから作る（AI の文・引用は入れようがない）。

import {
  cleanPath,
  plainPhraseOf,
  SECRET_FIX_LINES,
  INPUT_FIX_LINES,
  isSecretKind,
  WRITE_MARKS_LIMIT,
  type WriteFindingKind,
  type ScanFinding,
} from './securityFindings'
import { capList } from './capList'
import { sanitizeForWrap } from './untrustedBlock'

export const AI_CHECK_KINDS = [
  'secret-exposed',
  'input-to-command',
  'input-to-html',
  'input-to-path',
  'input-to-query',
  'open-admin',
  'error-leak',
  'external-source',
  'other',
] as const

export type AiCheckKind = (typeof AI_CHECK_KINDS)[number]

/** すぐ直す／直したほうがよい／念のため。 */
export type CheckSeverity = 'now' | 'should' | 'note'
/** ai: AI の判断を、送った本文で確かめられた。unverified: 確かめられていない。 */
export type AiCertainty = 'ai' | 'unverified'

export interface AiFinding {
  kind: AiCheckKind
  severity: CheckSeverity
  certainty: AiCertainty
  file: string
  line?: number
  /** 伏せて1行にして長さを切った文字。値そのものは入れない。 */
  note: string
  /** 伏せて1行にして長さを切った文字。値そのものは入れない。 */
  quote: string
}

export function isAiCheckKind(s: unknown): s is AiCheckKind {
  return typeof s === 'string' && (AI_CHECK_KINDS as readonly string[]).includes(s)
}

/** 重さ。確かめられていない指摘は、「念のため」に下げない。 */
export function aiSeverityOf(kind: AiCheckKind, certainty: AiCertainty, served: boolean): CheckSeverity {
  if (kind === 'secret-exposed') return served ? 'now' : 'should'
  if (kind === 'other') return certainty === 'unverified' ? 'should' : 'note'
  return 'should'
}

/** 画面の1行の言い方。 */
export function aiKindPhrase(kind: AiCheckKind): string {
  switch (kind) {
    case 'secret-exposed':
      return '公開で見えてはいけないものが入っています'
    case 'input-to-command':
    case 'input-to-html':
    case 'input-to-path':
      return plainPhraseOf(kind)
    case 'input-to-query':
      return '訪問者の入力を、そのままデータの問い合わせに使っています'
    case 'open-admin':
      return '管理用の操作を、誰でも使えるようになっています'
    case 'error-leak':
      return 'エラーの内容を、そのまま返しています'
    case 'external-source':
      return 'フォームの送信先や、外部から読み込むスクリプトに、気をつけたい点があります'
    default:
      return '気をつけたい点があります'
  }
}

/**
 * 依頼文の見出し・名前の列に出すファイル名（見かけを変える文字と偽の区切りを除いたもの）。
 * AI はこの名前で答えるので、返事の照合も同じ関数を通した名前どうしで行う。
 * 2回かけても変わらない。
 */
export function promptName(file: string): string {
  return cleanPath(sanitizeForWrap(cleanPath(file)))
}

export function certaintyMark(c: AiCertainty): string {
  return c === 'ai' ? '（AI の判断）' : '（確かめられていません）'
}

/** 画面の1行。値・引用・AI の文は入れない。 */
export function aiFindingLine(f: AiFinding): string {
  const where = typeof f.line === 'number' ? `${cleanPath(f.file)}:${f.line}` : cleanPath(f.file)
  return `${where} ${aiKindPhrase(f.kind)}${certaintyMark(f.certainty)}`
}

const SEVERITY_RANK: Record<CheckSeverity, number> = { now: 0, should: 1, note: 2 }

/** 同じ場所・種類の指摘が重なったとき、重さが高いほうを残す（同じ重さなら先のもの）。 */
export function addFindingKeepingHeavier(into: Map<string, AiFinding>, key: string, f: AiFinding): void {
  const prev = into.get(key)
  if (!prev || SEVERITY_RANK[f.severity] < SEVERITY_RANK[prev.severity]) into.set(key, f)
}

/** 並べ方: 重さ（now → should → note）→ ファイル名（文字の順）→ 行。 */
export function sortAiFindings(items: readonly AiFinding[]): AiFinding[] {
  return [...items].sort((a, b) => {
    if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return (a.line ?? 0) - (b.line ?? 0)
  })
}

/** 依頼文に載せる、種類の説明（AI に見せる）。 */
export function aiKindForPrompt(kind: AiCheckKind): string {
  switch (kind) {
    case 'secret-exposed':
      return '公開されると困る秘密・個人情報・内部の情報が見える'
    case 'input-to-command':
      return '訪問者の入力を、そのままコマンドの実行に使っている'
    case 'input-to-html':
      return '訪問者の入力を、無害にせず HTML に出している'
    case 'input-to-path':
      return '訪問者の入力を、そのままファイルのパスに使っている'
    case 'input-to-query':
      return '訪問者の入力を、そのままデータの問い合わせの文に使っている'
    case 'open-admin':
      return '管理・削除などの操作を、確かめなしに誰でも呼べる'
    case 'error-leak':
      return 'エラーのときに、内部の情報をそのまま返している'
    case 'external-source':
      return 'フォームの送信先や、外部スクリプトの読み込み元が安全でない'
    default:
      return '上のどれでもないが、公開して問題になりうる'
  }
}

export interface SecurityFixItem {
  file: string
  line: number
  kind: AiCheckKind | WriteFindingKind
}

const FIX_REQUEST_LINE =
  '簡易セキュリティチェックで次の指摘がありました。該当するファイルを実際に修正して解消してください。直せない項目があれば、その理由と対処方法を教えてください。'

const AI_ONLY_FIX_LINES: Partial<Record<AiCheckKind, string>> = {
  'secret-exposed':
    '公開で見えてはいけないものは、公開されるファイルから取り除いてください。キーやパスワードなら、値を会話に書かず、公開されない場所から読む形にしてください。',
  'input-to-query': '訪問者の入力は、問い合わせの文に直接入れず、値を別に渡す書き方にしてください。',
  'open-admin': '管理用の操作は、使ってよい人かを確かめてから実行する形にしてください。確かめ方は、先に利用者に聞いてください。',
  'error-leak': 'エラーのときは、内部の情報を返さず、決まった短い文だけを返してください。',
  'external-source': 'フォームの送信先と、外部から読み込むスクリプトの読み込み元が意図したものかを確かめ、要らないものは外してください。',
}

function phraseOfItem(kind: AiCheckKind | WriteFindingKind): string {
  return isAiCheckKind(kind) ? aiKindPhrase(kind) : plainPhraseOf(kind)
}

/** 修正の依頼文。指摘が無ければ null。ファイル・行・種類だけで作る（値・引用・AI の文は入れない）。 */
export function buildSecurityFixPrompt(items: readonly SecurityFixItem[]): string | null {
  if (items.length === 0) return null

  const seen = new Set<string>()
  const rows: string[] = []
  for (const it of items) {
    const row = `・${cleanPath(it.file)}:${it.line} ${phraseOfItem(it.kind)}`
    if (seen.has(row)) continue
    seen.add(row)
    rows.push(row)
  }
  const shown = capList(rows, WRITE_MARKS_LIMIT).map((s, i) => (i < WRITE_MARKS_LIMIT ? s : `・${s}`))

  const fixes: string[] = []
  const add = (line: string) => {
    if (!fixes.includes(line)) fixes.push(line)
  }
  if (items.some(it => !isAiCheckKind(it.kind) && isSecretKind(it.kind))) SECRET_FIX_LINES.forEach(add)
  if (items.some(it => it.kind === 'input-to-command' || it.kind === 'input-to-html' || it.kind === 'input-to-path')) INPUT_FIX_LINES.forEach(add)
  for (const kind of AI_CHECK_KINDS) {
    const line = AI_ONLY_FIX_LINES[kind]
    if (line && items.some(it => it.kind === kind)) add(line)
  }

  return [FIX_REQUEST_LINE, '', ...shown, ...(fixes.length ? ['', ...fixes] : [])].join('\n')
}

/** 「AIに修正させる」に渡す指摘だけを選ぶ。確かめられていない指摘・念のため・行の無い指摘は入れない。 */
export function fixItemsOf(findings: readonly AiFinding[]): SecurityFixItem[] {
  const out: SecurityFixItem[] = []
  for (const f of findings) {
    if (f.certainty !== 'ai') continue
    if (f.severity !== 'now' && f.severity !== 'should') continue
    if (typeof f.line !== 'number') continue
    out.push({ file: f.file, line: f.line, kind: f.kind })
  }
  return out
}

/** Koto の点検の指摘から、修正の項目を選ぶ。行のあるものだけ（名前だけで決めたファイル〔secret-name〕は入れない）。 */
export function scanFixItemsOf(findings: readonly ScanFinding[]): SecurityFixItem[] {
  const out: SecurityFixItem[] = []
  for (const f of findings) {
    if (f.kind === 'secret-name') continue
    if (typeof f.line !== 'number') continue
    out.push({ file: f.file, line: f.line, kind: f.kind })
  }
  return out
}

/** 点検の項目と AI の項目を1つにする。同じ ファイル:行 は点検のほうを残す。並びは、点検 → AI。 */
export function mergeFixItems(scanItems: readonly SecurityFixItem[], aiItems: readonly SecurityFixItem[]): SecurityFixItem[] {
  const keyOf = (it: SecurityFixItem) => `${cleanPath(it.file)}:${it.line}`
  const seen = new Set(scanItems.map(keyOf))
  return [...scanItems, ...aiItems.filter(it => !seen.has(keyOf(it)))]
}
