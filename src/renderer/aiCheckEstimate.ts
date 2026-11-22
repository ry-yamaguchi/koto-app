// aiCheckEstimate.ts — AI の確認の「送る前の見積り」の文と、送ってよいかの判断（純関数。画面の部品は読まない）。
//
// 見積りは、計画（読むだけ・通信なし）と利用量の確かめの戻りから作る。
// 画面に出す文と、【AIに確認してもらう】を出すかの判断は、ここの estimateViewOf の1か所を通る。

/** 送る口が返す文と同じもの（定数を1つにして、見積りの枠と送る口の両方が読む）。 */
export const NOTHING_TO_CHECK_REPORT = 'チェック対象のコードファイルが見つかりませんでした。'
export const OVER_LIMIT_REPORT = 'AI利用上限に達しているため、セキュリティチェックを省略しました。'

export const ESTIMATE_PREPARE_FAILED = 'AI の確認の準備ができませんでした。'
export const ESTIMATE_NOTHING_TO_SEND = 'AI の確認: 送れるファイルがありません。'

/** 見積りに使う計画の一部。 */
export interface EstimatePlan {
  files: number
  promptChars: number
  requests: number
  skipped: readonly string[]
  partial: readonly string[]
  nothing: boolean
}

/** 利用量の確かめの戻り。 */
export interface EstimateBudget {
  allowed: boolean
  message?: string
  warning?: string
}

/** 見積りの材料。計画を作れなかったときは failure（失敗の文）を持つ。 */
export type AiEstimate =
  | { state: 'failed'; failure: string }
  | { state: 'made'; plan: EstimatePlan; budget: EstimateBudget }

export interface EstimateLine {
  kind: 'text' | 'note' | 'warning' | 'failure'
  text: string
}

export interface EstimateView {
  lines: EstimateLine[]
  /** 【AIに確認してもらう】を出してよいか（送ってよいか）。 */
  canSend: boolean
}

/** 3桁ごとの「,」で区切る（ロケールに頼らない）。 */
export function groupDigits(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 判断の順: 例外 → 上限で止める → 送るものが無い（対象が無い・送る回が無い）→ 送れる（名前だけ・中身つき）。 */
export function estimateViewOf(est: AiEstimate): EstimateView {
  if (est.state === 'failed') {
    return {
      lines: [{ kind: 'text', text: ESTIMATE_PREPARE_FAILED }, { kind: 'failure', text: est.failure }],
      canSend: false,
    }
  }
  const { plan, budget } = est
  if (!budget.allowed) {
    return { lines: [{ kind: 'text', text: budget.message || OVER_LIMIT_REPORT }], canSend: false }
  }
  if (plan.nothing) {
    return { lines: [{ kind: 'text', text: NOTHING_TO_CHECK_REPORT }], canSend: false }
  }
  // 読めるファイルが1つも無かった回は、送る回が無い（結果の枠ではなく、ここで言う）
  if (plan.requests <= 0) {
    return { lines: [{ kind: 'text', text: ESTIMATE_NOTHING_TO_SEND }], canSend: false }
  }
  // 中身を送るファイルが無く、ファイルの名前だけを伝える回
  const size = plan.files <= 0
    ? `ファイルの名前だけ（約${groupDigits(plan.promptChars)}文字）を、`
    : `${plan.files}個のファイル・約${groupDigits(plan.promptChars)}文字を、`
  const head = plan.requests >= 2
    ? `AI の確認: ${size}${plan.requests}回に分けて さくらのAI Engine へ送ります。`
    : `AI の確認: ${size}さくらのAI Engine へ送ります。`
  const lines: EstimateLine[] = [{ kind: 'text', text: head }]
  if (plan.skipped.length >= 1) lines.push({ kind: 'note', text: `量が多いため、${plan.skipped.length}個のファイルは送りません。` })
  if (plan.partial.length >= 1) lines.push({ kind: 'note', text: `量が多いため、${plan.partial.length}個のファイルは途中までしか送りません。` })
  if (budget.warning) lines.push({ kind: 'warning', text: budget.warning })
  return { lines, canSend: true }
}

/** 送ってよい見積りか。見積りが無い（null）ときは送らない。 */
export function canSendOf(est: AiEstimate | null | undefined): boolean {
  return !!est && estimateViewOf(est).canSend
}
