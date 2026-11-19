// osvCheckWords.ts — 「ライブラリの脆弱性」の節の文と、結果から画面の行への組み立て（純関数）。
//
// 「✅ と言ってよいか」の判断は osvIsAllClear の1か所。
// 失敗の文は joinFailureDetail で原文を添えた1つの文字列にして、'failure' の行に入れる。

import { OSV_SEND_NOTE } from '../shared/dataDestinationNotes'
import { joinFailureDetail } from '../shared/failureDetail'
import type { LockSkipped, ManifestMatch } from '../shared/lockfileDeps'
import type { OsvCheckReply, OsvDone, OsvPreview, OsvStopReason } from '../shared/osvTypes'

export const OSV_SECTION_TITLE = 'ライブラリの脆弱性'
export const OSV_BUTTON_LABEL = 'ライブラリの脆弱性を調べる'
export const OSV_BUTTON_BUSY_LABEL = '調べています…'
export const OSV_DESCRIPTION = `使っているライブラリに、既知の脆弱性が無いかを調べます。${OSV_SEND_NOTE}AI は使いません。`
export const OSV_CONFIRM_TITLE = 'ライブラリの脆弱性を調べますか'
export const OSV_CONFIRM_OK = '送って調べる'
export const OSV_CONFIRM_CANCEL = 'やめる'
export const OSV_SETTINGS_TITLE = 'セキュリティ'
export const OSV_SETTINGS_CONSENTED = 'ライブラリの脆弱性の照会: 同意済み'
export const OSV_SETTINGS_NOT_CONSENTED = 'ライブラリの脆弱性の照会: まだ同意していません。調べるときに確認します。'
export const OSV_SETTINGS_REVOKE = '取り消す'

/** 初回の確認の本文。件数は送る件数（sendCount）。例は先頭の2件まで。 */
export function osvConfirmBody(sendCount: number, examples: string[]): string {
  const ex = examples.slice(0, 2)
  const lines = [`本番で使うライブラリ${sendCount}件の名前とバージョンを、脆弱性データベース OSV.dev に送ります。`]
  if (ex.length > 0) lines.push(`例: ${ex.join('、')}`)
  return lines.join('\n') +
    '\n\nソースコード・ファイルの中身・プロジェクト名は送りません。送信元の IP アドレスは OSV.dev に伝わります。' +
    '\n\nこの確認は初回だけです。設定から取り消せます。'
}

export type OsvVerdict = 'ok' | 'warn' | 'skip' | 'info'
export interface OsvViewLine { kind: 'head' | 'text' | 'lib' | 'vuln' | 'failure' | 'note'; text: string; link?: string; linkText?: string }
export interface OsvView { verdict: OsvVerdict; lines: OsvViewLine[] }

const count = (n: number) => `${n}件`

const STOP_SENTENCE: Record<OsvStopReason, string> = {
  offline: '⏭ 調べられませんでした。インターネットに接続できているか確認して、もう一度お試しください。',
  timeout: '⏭ OSV.dev から応答がありませんでした。しばらくしてからもう一度お試しください。',
  http: '⏭ OSV.dev が照会を受け付けませんでした。',
  shape: '⏭ OSV.dev の返事を読み取れませんでした。',
  'too-large': '⏭ OSV.dev の返事を読み取れませんでした。',
}

/** ✅ と言ってよいのは、全部がそろった回だけ。 */
export function osvIsAllClear(r: OsvDone, manifest: ManifestMatch): boolean {
  return r.stop === null && r.checked === r.total && r.total === r.sent && r.findings.length === 0 && manifest === 'match'
}

function skippedNotes(s: LockSkipped): OsvViewLine[] {
  const out: OsvViewLine[] = []
  if (s.dev > 0) out.push(note(`開発用のライブラリは調べていません（${count(s.dev)}）。`))
  if (s.notPublic > 0) out.push(note(`公開されているライブラリと確かめられないため、調べていません（${count(s.notPublic)}）。`))
  if (s.badShape > 0) out.push(note(`名前かバージョンを読み取れないため、調べていません（${count(s.badShape)}）。`))
  return out
}

function note(text: string): OsvViewLine { return { kind: 'note', text } }
function text(t: string): OsvViewLine { return { kind: 'text', text: t } }

function unavailableView(state: 'bad-dir' | 'no-manifest' | 'no-deps' | 'no-lockfile' | 'unsupported' | 'unreadable'): OsvView {
  switch (state) {
    case 'no-manifest':
      // 「公開されるもの」の外（プロジェクトの直下など）に package.json があることはありうるので、「使っていない」とは言わない。
      // 呼び名は、ファイル一覧の見出し「公開されるもの」に合わせる
      return { verdict: 'info', lines: [text('ℹ️ 調べるライブラリがありません（「公開されるもの」に package.json がありません）。')] }
    case 'no-deps':
      return { verdict: 'info', lines: [text('ℹ️ 使っているライブラリはありません。')] }
    case 'no-lockfile':
      return { verdict: 'info', lines: [text('ℹ️ package-lock.json が無いため、バージョンが分からず調べられません。')] }
    case 'unsupported':
      return { verdict: 'info', lines: [text('ℹ️ この形式の package-lock.json には対応していないため、調べられません。')] }
    case 'unreadable':
      return { verdict: 'skip', lines: [text('⏭ package-lock.json を読み取れないため、調べられません。')] }
    case 'bad-dir':
      return { verdict: 'skip', lines: [text('⏭ プロジェクトのフォルダを読めないため、調べられません。')] }
  }
}

function nothingToSend(skipped: LockSkipped): OsvView {
  return { verdict: 'info', lines: [text('ℹ️ 調べられるライブラリがありません。'), ...skippedNotes(skipped)] }
}

/** 確認へ進める回（state 'ok' で sendCount > 0）は null。それ以外は、その場で見せる画面。 */
export function osvViewOfPreview(p: OsvPreview): OsvView | null {
  if (p.state === 'ok') return p.sendCount > 0 ? null : nothingToSend(p.skipped)
  return unavailableView(p.state)
}

function doneView(r: OsvDone, skipped: LockSkipped, manifest: ManifestMatch): OsvView {
  const lines: OsvViewLine[] = []
  const F = r.findings.length
  const clear = osvIsAllClear(r, manifest)
  const partial = r.stop !== null || r.checked < r.total
  const NO_GUARANTEE = '見つからないことは、安全の保証ではありません。'
  const tail: OsvViewLine[] = []
  if (r.sent > 0) tail.push(note(`${count(r.sent)}の名前とバージョンを OSV.dev に送りました。`))
  tail.push(...skippedNotes(skipped))
  if (r.withdrawn > 0) tail.push(note(`取り下げられた記録は数えていません（${count(r.withdrawn)}）。`))
  // 出典は、弱点の一覧を出した回だけ（見つからない回は、本文が OSV.dev の名前を言っている）
  if (F > 0) tail.push(note('出典: OSV.dev'))

  // 1件も調べられず、分かったことも無い回は、失敗の文だけ
  if (r.checked === 0 && r.stop && F === 0) {
    lines.push({ kind: 'failure', text: joinFailureDetail(STOP_SENTENCE[r.stop.reason], r.stop.detail) })
    return { verdict: 'skip', lines: [...lines, ...tail] }
  }
  if (r.checked === 0 && r.total === 0) {
    return { verdict: 'info', lines: [text('ℹ️ 調べられるライブラリがありません。'), ...tail] }
  }

  if (partial) {
    lines.push({
      kind: 'head',
      text: r.checked === 0
        ? `⚠️ ${count(r.total)}を、最後まで調べられませんでした。`
        : `⚠️ ${count(r.total)}のうち${count(r.checked)}だけ調べられました。残りは確認できていません。`,
    })
  }
  if (F > 0) {
    lines.push({ kind: 'head', text: `⚠️ ${count(F)}のライブラリに、既知の脆弱性が見つかりました。` })
    for (const f of r.findings) {
      const n = count(f.vulns.length)
      lines.push({
        kind: 'lib',
        text: f.fixedAll === null
          ? `${f.name} ${f.version} に、既知の脆弱性が${n}あります。`
          : `${f.name} ${f.version} に、既知の脆弱性が${n}あります（直ったバージョン: ${f.fixedAll}）。`,
      })
      for (const v of f.vulns) {
        let inner: string
        if (v.detail === 'ok') {
          inner = v.fixed === null ? '直ったバージョンの記載なし' : `直ったバージョン: ${v.fixed}`
          if (v.severityLabel) inner += `・重さの記載: ${v.severityLabel}`
        } else if (v.detail === 'not-fetched') {
          inner = '詳細は取得していません'
        } else {
          inner = '詳細を読み取れませんでした'
        }
        const line: OsvViewLine = { kind: 'vuln', text: `・${v.id}（${inner}）` }
        if (v.link) { line.link = v.link; line.linkText = v.id }
        lines.push(line)
      }
    }
  } else if (partial) {
    if (r.checked > 0) {
      lines.push(text(`調べられた${count(r.checked)}には、既知の脆弱性は見つかりませんでした。`))
      lines.push(text(NO_GUARANTEE))
    }
  } else {
    const body = `調べた${count(r.total)}に、OSV.dev に登録された既知の脆弱性は見つかりませんでした。`
    lines.push(clear ? { kind: 'head', text: `✅ ${body}` } : text(body))
    lines.push(text(NO_GUARANTEE))
  }
  if (r.stop) lines.push({ kind: 'failure', text: joinFailureDetail(STOP_SENTENCE[r.stop.reason], r.stop.detail) })

  if (r.checked > 0) {
    if (manifest === 'mismatch') lines.push(text('⚠️ package-lock.json が package.json と合っていません。公開するときに入るライブラリのバージョンが、調べたものと違うかもしれません。'))
    else if (manifest === 'unreadable') lines.push(text('⚠️ package-lock.json が package.json と合っているか、確かめられませんでした。'))
  }
  return { verdict: F > 0 ? 'warn' : clear ? 'ok' : 'warn', lines: [...lines, ...tail] }
}

export function osvViewOfReply(r: OsvCheckReply): OsvView {
  switch (r.state) {
    case 'not-consented':
      return { verdict: 'skip', lines: [text('⏭ 送信に同意していないため、調べていません。')] }
    case 'nothing-to-send':
      return nothingToSend(r.skipped)
    case 'done':
      return doneView(r.result, r.skipped, r.manifest)
    case 'failed':
      return { verdict: 'skip', lines: [{ kind: 'failure', text: `⏭ ${r.message}` }] }
    default:
      return unavailableView(r.state)
  }
}

/** コピー用。行を改行でつなぐ（'failure' の行は原文つきのまま）。 */
export function osvViewText(v: OsvView): string {
  return v.lines.map(l => l.text).join('\n')
}
