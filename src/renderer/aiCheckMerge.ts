// aiCheckMerge.ts — 「AI の確認」の回ごとの結果を、1つの結果の文へ合成する（純関数）。
//
// 並べ方（parts の順）は mergeCheckResults の本文を見る。すべて ai: false（文字のまま描く）。
// AI の文（note）も Markdown として解釈させない。値（キーやパスワードそのもの）は、ここへ来る前に
// 伏せてある（aiCheckReply.ts の cleanText）。この合成は新しい文を AI の文から作らない。

import { looksSecretButPublished } from '../shared/publishExclude'
import { capList } from '../shared/capList'
import { cleanPath } from '../shared/securityFindings'
import { wrapFailureText } from '../shared/failureDetail'
import { AI_FINDINGS_PER_BATCH, AI_FINDINGS_SHOWN } from '../shared/aiCheckLimits'
import { addFindingKeepingHeavier, aiFindingLine, sortAiFindings, type AiFinding } from '../shared/aiCheckFindings'
import type { CheckMode, ReportPart } from './securityCheck'

/** 1回の送信の結果。 */
export type BatchResult =
  | { state: 'ok'; findings: AiFinding[]; malformed: number; cut: number; files: string[] }
  | { state: 'failed'; report: string; files: string[] }

/** 報告末尾「中身を確認していないファイル」に載せる上限（dataLike + others 合算）。 */
const UNCHECKED_NOTE_LIMIT = 50
/** 報告先頭の dataLike 固定文に載せる上限。 */
const DATA_LIKE_NOTE_LIMIT = 20
/** 報告先頭の「秘密が入っていそうなファイル」固定文に載せる上限。 */
const SECRET_NOTE_LIMIT = 20

/**
 * 名前で見つけた秘密らしいファイル（secretFiles）のうち、**公開物に入るもの**（純関数）。
 * 判定は publishExclude.ts の looksSecretButPublished（唯一の定義）。`.env`・`*.pem` など、
 * どの公開先でも除外される名前は数えない（数えると、`.env` のある普通のプロジェクトがいつも「要確認」になる）。
 */
export function publishedSecretFiles(secretFiles: readonly string[]): string[] {
  return secretFiles.filter(looksSecretButPublished)
}

export interface MergeInfo {
  files: number
  batches: number
  skipped: readonly string[]
  /** 量が多くて、途中までしか送っていないファイル。1件でもあれば要確認に倒す。 */
  partial: readonly string[]
  /** 中身を確認していない「データっぽい」ファイル。1件でもあれば要確認に倒す。 */
  dataLike?: readonly string[]
  /** 表示用の「資産」ファイル。名指しせず件数だけを報告し、判定は左右しない。 */
  assets?: readonly string[]
  /** 中身を確認していない、その他のファイル（名前だけAIに判定させる対象）。 */
  others?: readonly string[]
  /** ファイル一覧そのものが打ち切られていたか。あれば要確認に倒す。 */
  truncated?: boolean
  /** 名前だけで秘密らしいと分かったファイル。公開物に入るものが1件でもあれば要確認に倒す。 */
  secretFiles?: readonly string[]
  /** 読み込めなかったファイル。 */
  unreadable?: readonly string[]
  mode?: CheckMode
  /** 利用量の上限が近いときの Koto の文。見出しの行のすぐ次に、そのまま入れる。 */
  warning?: string
}

export interface MergedCheck {
  verdict: 'ok' | 'warn' | 'skip'
  report: string
  parts: ReportPart[]
  findings: AiFinding[]
}

/** 名前の一覧を、見かけを変える文字・改行を除いて、件数で切る（名前は利用者のファイル名で、AI の返事ではないが、画面とコピーに出る）。 */
function capNames(names: readonly string[], limit: number): string[] {
  return capList(names.map(cleanPath), limit)
}

const NOTE_HEADING = '念のため'

/**
 * 回ごとの結果を1つにまとめる（純関数）。
 *
 * ── 判定 ──────────────────────────────────────────────────────────────
 * AI の側（aiVerdict）: ok の回が1つも無ければ skip。あれば、「すぐ直す」「直したほうがよい」の指摘・
 * 読めなかった回（failed）・読み取れなかった指摘（malformed）・多すぎて切った指摘（cut）のどれかがあれば warn、
 * どれも無ければ ok（「念のため」だけの回は ok）。
 * Koto の側（forceWarn）: データらしいファイル・一覧の打ち切り・公開される秘密らしい名前・
 * 中身を読めたファイルが1つも無いこと、は AI の答えに関わらず warn。
 * 読み込めなかったファイル・量が多くて送らなかった・途中までしか送らなかったファイルがある回は、AI が ok でも「問題なし」にしない
 * （warn に倒す）。ただし AI が1回も読めなかった回（skip）は、実施できなかったまま skip で返す。
 */
export function mergeCheckResults(results: readonly BatchResult[], info: MergeInfo): MergedCheck {
  const dataLike = info.dataLike ?? []
  const assets = info.assets ?? []
  const others = info.others ?? []
  const truncated = info.truncated ?? false
  const secrets = publishedSecretFiles(info.secretFiles ?? [])
  const unreadable = info.unreadable ?? []
  const skipped = info.skipped
  const partial = info.partial

  const oks = results.filter((r): r is Extract<BatchResult, { state: 'ok' }> => r.state === 'ok')
  const failed = results.filter((r): r is Extract<BatchResult, { state: 'failed' }> => r.state === 'failed')

  // 指摘: 全部集めて、同じ file・line・kind は1回だけ
  const byKey = new Map<string, AiFinding>()
  for (const r of oks) {
    for (const f of r.findings) addFindingKeepingHeavier(byKey, `${f.file}\u0000${f.line ?? ''}\u0000${f.kind}`, f)
  }
  const findings = sortAiFindings([...byKey.values()])
  const shown = findings.slice(0, AI_FINDINGS_SHOWN)
  const hidden = findings.length - shown.length
  const malformed = oks.reduce((n, r) => n + r.malformed, 0)
  const cut = oks.reduce((n, r) => n + r.cut, 0)
  const hasHeavy = findings.some(f => f.severity === 'now' || f.severity === 'should')

  const aiVerdict: 'ok' | 'warn' | 'skip' =
    oks.length === 0 ? 'skip'
      : hasHeavy || failed.length > 0 || malformed >= 1 || cut >= 1 ? 'warn' : 'ok'
  // 読めたファイルが1つも無いのに、読めなかったものがある。AI が見たのは名前だけなので、その ok を「確認した」にしない
  const nothingRead = info.files <= 0 && unreadable.length > 0 && aiVerdict === 'ok'
  const forceWarn =
    dataLike.length > 0 || truncated || secrets.length > 0 || nothingRead
    || (aiVerdict !== 'skip' && (unreadable.length > 0 || skipped.length > 0 || partial.length > 0))
  const verdict: 'ok' | 'warn' | 'skip' = forceWarn ? 'warn' : aiVerdict

  const unreadableNote = unreadable.length
    ? [`※ 読み込めなかったため、次のファイルは確認していません: ${capNames(unreadable, UNCHECKED_NOTE_LIMIT).join(', ')}`]
    : []
  const nothingReadNote = nothingRead ? ['※ 中身を読めたファイルが1つも無く、AIはファイルの名前だけを見ています'] : []

  if (verdict === 'skip') {
    // 実施できなかった理由は Koto が書いた文（失敗の理由には外部の応答の文が入りうる）。解釈しない
    const base = failed[0]?.report ?? 'チェックを実施できませんでした。'
    // 失敗の詳細（原文）は最後の行に残す。読めなかったファイルの注記より後ろへ移す。
    const text = wrapFailureText(base, t => [t, ...unreadableNote].join('\n'))
    return { verdict, report: text, parts: [{ text, ai: false }], findings }
  }

  const head = verdict === 'warn' ? '判定: 要確認' : '判定: 問題なし'
  const note = aiVerdict === 'skip' || failed.length > 0 || info.files <= 0
    ? null // AIは未実施（または一部の回を読めなかった・中身を1つも読んでいない）なので「N個のファイルを確認しました」とは書かない（嘘になる）
    : info.batches > 1
      ? `（${info.files}個のファイルを${info.batches}回に分けて確認しました）`
      : `（${info.files}個のファイルを確認しました）`
  const skipNote = skipped.length
    ? [`※ 量が多いため、次のファイルは確認していません: ${capNames(skipped, UNCHECKED_NOTE_LIMIT).join(', ')}`]
    : []
  const partialNote = partial.length
    ? [`※ 量が多いため、次のファイルは途中までしか確認していません: ${capNames(partial, UNCHECKED_NOTE_LIMIT).join(', ')}`]
    : []
  const failedFiles = [...new Set(failed.flatMap(r => r.files))]
  const failedNote = failed.length
    ? [
        `※ AIが確認できなかった回があります（${results.length}回中${failed.length}回）。もう一度お試しください`,
        ...(failedFiles.length ? [`※ 次のファイルは、確認できていない部分があります: ${capNames(failedFiles, UNCHECKED_NOTE_LIMIT).join(', ')}`] : []),
      ]
    : []
  const secretNote = secrets.length
    ? [`${capNames(secrets, SECRET_NOTE_LIMIT).join('、')}: 名前からして、秘密が入っていそうなファイルです（中身は確認していません）。公開が不要なら公開されるフォルダから移動してください`]
    : []
  const dataLikeNote = dataLike.length
    ? [`${capNames(dataLike, DATA_LIKE_NOTE_LIMIT).join('、')}: 公開するとデータの中身を誰でも見られるようになる種類のファイルです（中身は確認していません）。公開が不要なら公開されるフォルダから移動してください`]
    : []
  const truncatedNote = truncated
    ? ['※ ファイルが多いため、チェックは一部のファイルにとどまります']
    : []
  const assetsNote = assets.length
    ? [`※ 画像・フォント・音声など ${assets.length} 件は、中身の確認の対象外です`]
    : []
  const uncheckedNote = others.length
    ? [`※ 中身を確認できない種類のファイルです（名前だけで判定しました）: ${capNames(others, UNCHECKED_NOTE_LIMIT).join(', ')}`]
    : []

  // 指摘の行（重さごと）。AI の文は note だけで、そのまま文字として入れる
  const itemText = (f: AiFinding): string => `・${aiFindingLine(f)}${f.note ? `\n　${f.note}` : ''}`
  const nowItems = shown.filter(f => f.severity === 'now')
  const shouldItems = shown.filter(f => f.severity === 'should')
  const noteItems = shown.filter(f => f.severity === 'note')
  const findingLines: string[] = []
  if (nowItems.length) findingLines.push('すぐ直す', ...nowItems.map(itemText))
  if (shouldItems.length) findingLines.push('直したほうがよい', ...shouldItems.map(itemText))

  const brokenNote: string[] = []
  if (hidden > 0) brokenNote.push(`※ 指摘が多いため、重いものから${AI_FINDINGS_SHOWN}件を出しています（ほか${hidden}件）`)
  if (malformed >= 1) brokenNote.push(`※ AI の指摘のうち、読み取れなかったものが${malformed}件あります`)
  if (cut >= 1) brokenNote.push(`※ AI の指摘が多いため、1回につき${AI_FINDINGS_PER_BATCH}件までを出しています`)

  const clearNote = verdict === 'ok'
    ? ['確認した範囲では、問題は見つかりませんでした。']
    : []

  const foldLabel = `${NOTE_HEADING}（${noteItems.length}件）`

  const joined = (lines: string[]): ReportPart => ({ text: lines.join('\n'), ai: false })
  const head1: string[] = [
    head,
    ...(info.warning ? [info.warning] : []),
    ...(note ? [note] : []),
    ...skipNote, ...partialNote, ...unreadableNote, ...nothingReadNote, ...failedNote, ...secretNote, ...dataLikeNote,
  ]
  const parts: ReportPart[] = [
    joined(head1),
    joined(findingLines),
    joined(brokenNote),
    joined(clearNote),
    ...noteItems.map((f): ReportPart => ({ text: itemText(f), ai: false, fold: foldLabel })),
    joined([...truncatedNote, ...assetsNote, ...uncheckedNote]),
  ].filter(p => p.text)

  const reportLines: string[] = []
  let headingPut = false
  for (const p of parts) {
    if (p.fold && !headingPut) { reportLines.push(NOTE_HEADING); headingPut = true }
    reportLines.push(p.text)
  }
  return { verdict, report: reportLines.join('\n'), parts, findings }
}
