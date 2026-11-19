// securityFindings.ts — 書いた中身の点検で見つけたものの型と、画面の文・AI への依頼文。
//
// 値そのものは、型にも文にも入れない（吹き出しは会話の記録に保存されるので、入れると同じ秘密が2か所に残る）。
// 出してよいのは、種類・ファイル・行・文字数・形の接頭辞だけ。

import type { SecretShapeKind } from './secretShapes'
import { capList } from './capList'

export type WriteFindingKind = SecretShapeKind | 'input-to-command' | 'input-to-html' | 'input-to-path'

export interface WriteFinding {
  kind: WriteFindingKind
  /** 1 始まりの行。 */
  line: number
  /** 値の文字数。秘密の種類だけ。 */
  length?: number
  /** 形の接頭辞（例: `ghp_…`）。秘密の種類だけ。 */
  sample?: string
}

/** 吹き出しに付ける印。値・文字数・見本は持たない。 */
export interface WriteFixMark {
  file: string
  kind: WriteFindingKind
  line: number
}

export interface WriteCheckNotice {
  text: string
  marks: WriteFixMark[]
}

/** 吹き出しの1回で並べる件数。 */
const NOTICE_LIST_LIMIT = 5
/** 印に持つ件数の上限。 */
const MARKS_LIMIT = 50

const SECRET_KINDS: readonly WriteFindingKind[] = ['known-key', 'named-secret', 'private-key', 'connection-string']

/** テスト・fixture のパスでは出さない種類（名前だけで決める形。見本のパスワードが定番のため）。 */
export const TEST_PATH_QUIET_KINDS: readonly WriteFindingKind[] = ['named-secret']

/** 点検が返す種類のすべて。吹き出しの印を読む側が、知らない種類を断るのに使う。 */
export const WRITE_FINDING_KINDS: readonly WriteFindingKind[] = [...SECRET_KINDS, 'input-to-command', 'input-to-html', 'input-to-path']

/** 印の行番号として受け入れる上限。 */
export const WRITE_MARK_LINE_MAX = 10_000_000

/** 印の件数の上限（持つ側・読む側で同じ）。 */
export const WRITE_MARKS_LIMIT = MARKS_LIMIT

function isSecretKind(kind: WriteFindingKind): boolean {
  return SECRET_KINDS.includes(kind)
}

/** 見つけたものの言い方（値は含まない。文字数と見本は、あれば括弧で添える）。 */
function phraseOf(f: WriteFinding): string {
  switch (f.kind) {
    case 'known-key':
      return `APIキーが直接書かれています${shapeNote(f)}`
    case 'named-secret':
      return `パスワードやキーらしい値が直接書かれています${typeof f.length === 'number' ? `（${f.length}文字）` : ''}`
    case 'private-key':
      return '秘密鍵が直接書かれています'
    case 'connection-string':
      return '接続先の文字列に、ユーザー名とパスワードが入っています'
    case 'input-to-command':
      return '訪問者の入力を、そのままコマンドに使っています'
    case 'input-to-html':
      return '訪問者の入力を、そのまま画面（HTML）に出しています'
    case 'input-to-path':
      return '訪問者の入力を、そのままファイルのパスに使っています'
    default:
      return '気をつけたい点があります'
  }
}

function shapeNote(f: WriteFinding): string {
  if (typeof f.length !== 'number') return ''
  return f.sample ? `（${f.sample}・${f.length}文字）` : `（${f.length}文字）`
}

/** 依頼文用の言い方。値・文字数・見本は入れない。 */
function plainPhraseOf(kind: WriteFindingKind): string {
  return phraseOf({ kind, line: 0 })
}

/** 保存のあとに出す吹き出しの文。指摘が無ければ null。 */
export function writeCheckNotice(items: { file: string; findings: WriteFinding[] }[]): WriteCheckNotice | null {
  const all = items.flatMap(it => it.findings.map(f => ({ file: it.file, f })))
  if (all.length === 0) return null

  const marks: WriteFixMark[] = all.slice(0, MARKS_LIMIT).map(({ file, f }) => ({ file, kind: f.kind, line: f.line }))

  if (all.length === 1) {
    const { file, f } = all[0]
    const tail = isSecretKind(f.kind) ? '公開すると、他の人に使われるおそれがあります。' : ''
    return { text: `⚠️ ${cleanPath(file)} の${f.line}行目に、${phraseOf(f)}。${tail}`, marks }
  }

  const rows = all.map(({ file, f }) => `・${cleanPath(file)}:${f.line} ${phraseOf(f)}`)
  const shown = capList(rows, NOTICE_LIST_LIMIT).map((s, i) => (i < NOTICE_LIST_LIMIT ? s : `・${s}`))
  const text = [`⚠️ 今回の保存で、気をつけたい点が${all.length}件あります。`, ...shown, '公開する前に直すことをおすすめします。'].join('\n')
  return { text, marks }
}

/** 画面と依頼文に出さない文字: 改行・制御文字・見かけを変える文字（向きの制御・幅のない文字・BOM）。 */
const HIDDEN_CHAR_SRC = '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]'

/** パスにそのまま出してはいけない文字を含むか（印の読み直しが、そういうパスを受けないために使う）。 */
export function hasHiddenPathChar(file: string): boolean {
  return new RegExp(HIDDEN_CHAR_SRC).test(file)
}

/** 画面と依頼文に出すパスの長さの上限。 */
const SHOWN_PATH_MAX = 200

/** 改行と制御文字を除き、長すぎれば先頭を省く（パスは利用者やAIが決めた文字列なので、依頼文の行を増やさせない）。 */
function cleanPath(file: string): string {
  const s = file.replace(new RegExp(HIDDEN_CHAR_SRC, 'g'), '')
  return s.length > SHOWN_PATH_MAX ? '…' + s.slice(s.length - (SHOWN_PATH_MAX - 1)) : s
}

const SECRET_FIX_LINES = [
  'キーやパスワードは、コードに直接書かず、環境変数などから読む形にしてください。',
  'キーやパスワードの値そのものは、この会話に書かないでください。',
  '値をどこに設定するか（入れ先）は決めつけず、先に私に確かめてください。',
]
const INPUT_FIX_LINES = ['訪問者の入力をそのまま使っている所は、入力をそのまま使わない形に直してください。']

/** 「AIに修正させる」で送る依頼文。値・文字数・見本は入れない。直し方の文は、見つかった種類に合うものだけ。 */
export function buildWriteFixPrompt(marks: WriteFixMark[]): string {
  // 依頼文は、印を（印の上限まで）全部並べる。吹き出しの文の上限は読む人のためで、AI への依頼は押し直しの費用に響く
  const list = marks.slice(0, MARKS_LIMIT).map(m => `・${cleanPath(m.file)}:${m.line} ${plainPhraseOf(m.kind)}`)
  return [
    '次の点を直してください。',
    ...list,
    '',
    ...(marks.some(m => isSecretKind(m.kind)) ? SECRET_FIX_LINES : []),
    ...(marks.some(m => !isSecretKind(m.kind)) ? INPUT_FIX_LINES : []),
  ].join('\n')
}
