// publishScanWords.ts — 公開されるファイルの点検（Koto が自分で読む部分）の文と、結果から画面の行への組み立て（純関数）。

import { scanFindingLine, cleanPath } from '../shared/securityFindings'
import { PUBLISH_SCAN_LIST_LIMIT } from '../shared/publishScanLimits'
import type { PublishScanDone, PublishScanReply } from '../shared/publishScanTypes'

export const PUBLISH_SCAN_TITLE = 'Koto の点検'
export const PUBLISH_SCAN_PROGRESS = '公開されるファイルを点検しています…'
export const PUBLISH_SCAN_BUTTON_NO_AI = 'ファイルを点検する'
export const PUBLISH_SCAN_BUSY = '点検中…'
export const GITHUB_SCAN_TITLE = '🛡 保存するファイルの点検'
export const GITHUB_SCAN_NOTE = 'キーやパスワードの直書きと、秘密が入っていそうな名前のファイルがないかを、Koto が点検します。AI は使いません。'
export const PUBLISH_SCAN_NO_AI_NOTE = 'AI による確認は行っていません（さくらのAI Engine のキーがありません）。'
export const PUBLISH_SCAN_AI_STOPPED_NOTE = 'AI の確認は、中止したため行っていません。'

export type ScanVerdict = 'ok' | 'warn' | 'skip'
export interface ScanViewLine { kind: 'head' | 'group' | 'finding' | 'text' | 'failure' | 'note'; text: string }
export interface ScanView { verdict: ScanVerdict; lines: ScanViewLine[] }

// 'github' では、同じ枠の説明（GITHUB_SCAN_NOTE）が言っているので、末尾の注記は出さない
const SCOPE_NOTE = '見ているのは、キーやパスワードの直書きと、訪問者の入力をそのまま使う書き方（JavaScript・TypeScript・HTML）です。'

function namesNote(label: string, names: string[], count: number): string {
  const rest = count > names.length ? ` ほか${count - names.length}件` : ''
  return `${label}: ${names.map(cleanPath).join('、')}${rest}`
}

function notesOf(r: PublishScanDone): ScanViewLine[] {
  const n = r.notScanned
  const out: string[] = []
  if (n.tooLargeCount > 0) out.push(namesNote('大きすぎるため点検していません', n.tooLarge, n.tooLargeCount))
  if (n.unreadableCount > 0) out.push(namesNote('読めないため点検していません', n.unreadable, n.unreadableCount))
  if (n.overTotalCount > 0) out.push(namesNote('量が多いため点検していません', n.overTotal, n.overTotalCount))
  if (n.binaryCount > 0) out.push(namesNote('文字として読めないため点検していません', n.binary, n.binaryCount))
  if (n.sampleCount > 0) out.push(namesNote('見本の名前のため点検していません', n.sample, n.sampleCount))
  if (n.longLineCount > 0) out.push(namesNote('行が長すぎるため、訪問者の入力の書き方を見ていません', n.longLine, n.longLineCount))
  if (n.listTruncated) out.push('ファイルが多いため、一部のファイルは一覧に入っていません。')
  if (r.scope !== 'github') out.push(SCOPE_NOTE)
  return out.map(text => ({ kind: 'note', text }))
}

/** 大きすぎ・読めない・量の上限・一覧の上限で、点検できなかったファイルがあるか（✅ にしない判断はここの1か所）。 */
function hasUnscanned(r: PublishScanDone): boolean {
  const n = r.notScanned
  return n.tooLargeCount + n.unreadableCount + n.overTotalCount > 0 || n.listTruncated
}

function findingLines(r: PublishScanDone): ScanViewLine[] {
  const shown = r.findings.slice(0, PUBLISH_SCAN_LIST_LIMIT)
  const lines: ScanViewLine[] = []
  const groups: { sev: 'now' | 'should'; title: string }[] = [
    { sev: 'now', title: 'すぐ直す' },
    { sev: 'should', title: '直したほうがよい' },
  ]
  for (const g of groups) {
    const items = shown.filter(f => f.severity === g.sev)
    if (items.length === 0) continue
    lines.push({ kind: 'group', text: g.title })
    for (const f of items) lines.push({ kind: 'finding', text: `・${scanFindingLine(f, r.scope)}` })
  }
  const more = r.findingsTotal - shown.length
  if (more > 0) lines.push({ kind: 'finding', text: `・ほか${more}件` })
  return lines
}

export function publishScanViewOf(r: PublishScanReply): ScanView {
  if (r.state === 'bad-dir') return { verdict: 'skip', lines: [{ kind: 'head', text: '⏭ プロジェクトのフォルダを読めないため、点検できません。' }] }
  if (r.state === 'failed') return { verdict: 'skip', lines: [{ kind: 'failure', text: `⏭ ${r.message}` }] }

  if (r.findingsTotal > 0) {
    return {
      verdict: 'warn',
      lines: [
        { kind: 'head', text: `⚠️ ${r.scope === 'github' ? '保存される' : '公開される'}ファイルに、気をつけたい点が${r.findingsTotal}件あります。` },
        ...findingLines(r),
        ...notesOf(r),
      ],
    }
  }
  const missed = hasUnscanned(r)
  if (missed && r.scanned > 0) {
    return {
      verdict: 'warn',
      lines: [
        { kind: 'head', text: '⚠️ 点検できなかったファイルがあります。' },
        { kind: 'text', text: r.scope === 'github'
          ? `点検した${r.scanned}個のファイルには、キーやパスワードの直書きは見つかりませんでした。`
          : `点検した${r.scanned}個のファイルには、キーやパスワードの直書きなどは見つかりませんでした。` },
        ...notesOf(r),
      ],
    }
  }
  if (missed) {
    return { verdict: 'skip', lines: [{ kind: 'head', text: '⏭ 点検できるファイルを読めませんでした。' }, ...notesOf(r)] }
  }
  if (r.scanned > 0) {
    return {
      verdict: 'ok',
      lines: [
        { kind: 'head', text: r.scope === 'github'
          ? `✅ 点検した${r.scanned}個のファイルに、キーやパスワードの直書きは見つかりませんでした。`
          : `✅ 点検した${r.scanned}個のファイルに、キーやパスワードの直書きなどは見つかりませんでした。` },
        { kind: 'text', text: '見つからないことは、安全の保証ではありません。' },
        ...notesOf(r),
      ],
    }
  }
  return { verdict: 'ok', lines: [{ kind: 'head', text: 'ℹ️ 点検するファイルがありません。' }, ...notesOf(r)] }
}

/** コピー用（行を改行でつなぐ）。 */
export function publishScanViewText(v: ScanView): string {
  return v.lines.map(l => l.text).join('\n')
}
