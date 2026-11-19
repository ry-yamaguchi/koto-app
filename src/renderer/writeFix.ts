// writeFix.ts — ⚠️ の吹き出し（書いた中身の点検）の「🛠 AIに修正させる」ボタン。
//
// ボタンを押したときだけ AI へ送る（押すまで費用は出ない）。押した時点で印のファイルを読み直し、
// もう直っているものは外して、残っているものだけを、いまの行で頼む。
// 外との出入り（ファイルの読み取り・吹き出し・送信）はすべて ports で受けるので、
// 偽の ports を渡せば「送った依頼の一覧」を検査できる（electron・DOM 非依存）。

import { isChatUsable } from './claudeMode'
import { findingsInWrite } from '../shared/writeCheck'
import { WRITE_CHECK_MAX_CHARS } from '../shared/writeCheckLimits'
import { buildWriteFixPrompt, hasHiddenPathChar, WRITE_FINDING_KINDS, WRITE_MARK_LINE_MAX, WRITE_MARKS_LIMIT, type WriteFixMark } from '../shared/securityFindings'
import { TARGET_CHECK_OTHER_BUSY_NOTE } from './targetCheck'

/** 吹き出しのボタンに出す文（公開前チェックの既存のボタンと同じ）。 */
export const WRITE_FIX_BUTTON_LABEL = '🛠 AIに修正させる'

/** 押した時点で、印の指摘がもう無かったときに出す一言。 */
export const WRITE_FIX_ALREADY_FIXED_NOTE = 'ℹ️ もう直っているので、AI には頼みませんでした。'

/** これより長いファイルは、確かめられないので印を残す（上限の定義は shared/writeCheckLimits.ts）。 */
const MAX_CHECKED_LENGTH = WRITE_CHECK_MAX_CHARS

/** 吹き出し（表示専用。AI へは送らない）。 */
export interface WriteFixBubble {
  role: 'assistant'
  content: string
  toolNote: true
}

export interface WriteFixPorts {
  /** プロジェクトの中のファイルをいまの内容で読む。`missing` はファイルが無い */
  read(dir: string, file: string): Promise<{ state: 'text'; content: string } | { state: 'missing' } | { state: 'unreadable' }>
  /** 開いているプロジェクトの会話へ吹き出しを足す */
  appendBubble(msg: WriteFixBubble): void
  /** 会話へ送る（利用者が打ったのと同じ扱いで吹き出しに並ぶ） */
  send(text: string, images: string[]): unknown
  /** いま開いているプロジェクト。待っている間に切り替わったかを見るため、呼ぶたびに返す */
  currentDir(): string | null | undefined
  /** 応答中か。押した時点と、送る直前の2回見る */
  isBusy(): boolean
  /** ほかのプロジェクトで AI が動いていて、いま送るとその作業を止めてしまうか */
  otherProjectBusy(): boolean
  keys(): { apiKey: string | null | undefined; claudeActive: boolean }
  /** AI が読み書きする根（絶対パス。ふつうはプロジェクトの `public/`）。無ければ・分からなければプロジェクト直下として扱う */
  aiRoot(): string | null | undefined
}

export type RunWriteFixResult =
  | { sent: true; dir: string; marks: WriteFixMark[] }
  | { sent: false; reason: 'busy' | 'no-key' | 'other-busy' | 'no-project' | 'no-marks' | 'already-fixed' | 'project-changed' }

/** 吹き出しのボタンの見え方。印が1件以上あり、プロジェクトが開いているときだけ出す。応答中は押せない。 */
export function writeFixButtonState(args: {
  marks: readonly WriteFixMark[] | undefined
  dir: string | null | undefined
  isLoading: boolean
}): { show: boolean; disabled: boolean } {
  const { marks, dir, isLoading } = args
  return { show: Array.isArray(marks) && marks.length > 0 && !!dir, disabled: isLoading }
}

/** プロジェクトの中の相対パスか。絶対パス・`..` の段・空・制御文字を含むものは false。 */
export function isProjectRelativePath(file: unknown): file is string {
  if (typeof file !== 'string' || file.trim() === '') return false
  if (hasHiddenPathChar(file)) return false
  if (file.startsWith('/') || file.startsWith('\\') || file.startsWith('~') || /^[A-Za-z]:/.test(file)) return false
  return !file.split(/[\\/]/).includes('..')
}

function isMark(m: unknown): m is WriteFixMark {
  const x = m as WriteFixMark | null
  return !!x && WRITE_FINDING_KINDS.includes(x.kind) && Number.isInteger(x.line) && x.line >= 1 && x.line <= WRITE_MARK_LINE_MAX && isProjectRelativePath(x.file)
}

type Reread = { gone: true } | { gone: false; content: string | null }

/** 押した時点のファイルの中身。無い → gone。読めない・長すぎる → content は null（確かめられない）。 */
async function reread(dir: string, file: string, ports: WriteFixPorts): Promise<Reread> {
  try {
    const r = await ports.read(dir, file)
    if (r.state === 'missing') return { gone: true }
    if (r.state !== 'text') return { gone: false, content: null }
    const content = r.content
    if (typeof content !== 'string' || content.length > MAX_CHECKED_LENGTH) return { gone: false, content: null }
    return { gone: false, content }
  } catch {
    return { gone: false, content: null }
  }
}

/** 印のうち、いまも残っているものを、いまの行で返す。 */
async function stillOpen(dir: string, marks: WriteFixMark[], ports: WriteFixPorts): Promise<WriteFixMark[]> {
  const byFile = new Map<string, WriteFixMark[]>()
  for (const m of marks) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m])
  const out: WriteFixMark[] = []
  for (const [file, fileMarks] of byFile) {
    const now = await reread(dir, file, ports)
    if (now.gone) continue
    if (now.content === null) { out.push(...fileMarks); continue } // 確かめられない: 頼む側
    const kinds = new Set(fileMarks.map(m => m.kind))
    for (const f of findingsInWrite({ path: file, before: null, after: now.content })) {
      if (kinds.has(f.kind)) out.push({ file, kind: f.kind, line: f.line })
    }
  }
  return out
}

/**
 * 依頼文に書くパスを、AI の根からの相対にする。印のパスはプロジェクト直下からの相対（`public/app.js`）だが、
 * AI のファイル操作の根は `public/` で、頭に `public/` を付けると二重になる。根の外のファイルはそのまま。
 */
function rootRelativeMarks(dir: string, marks: WriteFixMark[], ports: WriteFixPorts): WriteFixMark[] {
  const root = ports.aiRoot()
  if (typeof root !== 'string') return marks
  const base = dir.replace(/\/+$/, '')
  const r = root.replace(/\/+$/, '')
  if (!base || !r.startsWith(base + '/')) return marks
  const prefix = r.slice(base.length + 1) + '/'
  return marks.map(m => (m.file.startsWith(prefix) ? { ...m, file: m.file.slice(prefix.length) } : m))
}

/** 送った直後に押し直されても、応答中の印が立つまでは通さない時間（ミリ秒）。 */
const RESEND_GUARD_MS = 3000

export interface PressGate {
  /** 押しを通してよいか。応答中のときは（印が立ったので）ここでは止めず、印を下ろして runWriteFix の判断に任せる */
  allow(busy: boolean): boolean
  /** 送ったことを覚える */
  markSent(): void
}

/** 「🛠 AIに修正させる」の二重押しの歯止め。送ったあと、応答中の印が立つ前の押し直しは通さない。 */
export function createPressGate(now: () => number = Date.now): PressGate {
  let until = 0
  return {
    allow(busy) {
      if (busy) { until = 0; return true }
      return now() >= until
    },
    markSent() { until = now() + RESEND_GUARD_MS },
  }
}

// 送り終わる前に同じプロジェクトで押し直されても、2回送らない
const inFlight = new Set<string>()

/** ほかのプロジェクトで AI が動いているときは送らず、押したプロジェクトの会話に一言だけ出す。 */
function refuseWhileOtherBusy(dir: string, ports: WriteFixPorts): RunWriteFixResult | null {
  if (!ports.otherProjectBusy()) return null
  if (dir === ports.currentDir()) ports.appendBubble({ role: 'assistant', content: TARGET_CHECK_OTHER_BUSY_NOTE, toolNote: true })
  return { sent: false, reason: 'other-busy' }
}

/**
 * ボタンを押したとき: 印のファイルを読み直し、残っている分だけを AI へ頼む（1回）。
 * 応答中・キーが無い・プロジェクトが無い・ほかのプロジェクトで AI が作業中のときは、読まず・送らない。
 * 残りが無ければ、AI は呼ばず一言だけ出す。
 */
export async function runWriteFix(ports: WriteFixPorts, marks: readonly WriteFixMark[] | undefined): Promise<RunWriteFixResult> {
  if (ports.isBusy()) return { sent: false, reason: 'busy' }
  const { apiKey, claudeActive } = ports.keys()
  if (!isChatUsable(!!apiKey, claudeActive)) return { sent: false, reason: 'no-key' }
  const dir = ports.currentDir()
  if (!dir) return { sent: false, reason: 'no-project' }
  const valid = (Array.isArray(marks) ? marks : []).filter(isMark).slice(0, WRITE_MARKS_LIMIT)
  if (valid.length === 0) return { sent: false, reason: 'no-marks' }
  if (inFlight.has(dir)) return { sent: false, reason: 'busy' }
  inFlight.add(dir)
  try {
    const busyAtPress = refuseWhileOtherBusy(dir, ports)
    if (busyAtPress) return busyAtPress
    const remaining = await stillOpen(dir, valid, ports)
    if (dir !== ports.currentDir()) return { sent: false, reason: 'project-changed' }
    if (remaining.length === 0) {
      ports.appendBubble({ role: 'assistant', content: WRITE_FIX_ALREADY_FIXED_NOTE, toolNote: true })
      return { sent: false, reason: 'already-fixed' }
    }
    if (ports.isBusy()) return { sent: false, reason: 'busy' }
    const busyBeforeSend = refuseWhileOtherBusy(dir, ports)
    if (busyBeforeSend) return busyBeforeSend
    void ports.send(buildWriteFixPrompt(rootRelativeMarks(dir, remaining, ports)), [])
    return { sent: true, dir, marks: remaining }
  } finally {
    inFlight.delete(dir)
  }
}
