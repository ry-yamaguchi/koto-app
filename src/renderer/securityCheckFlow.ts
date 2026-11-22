// securityCheckFlow.ts — 🛡 の節のボタンを押したあとの流れ（画面の部品から切り出したもの。依存は引数で受ける）。
//
// 2段の流れ:
//   1. 【ファイルを点検する】: Koto の点検だけ。AI は呼ばない・外へ送らない。キーがあれば、続けて送る前の見積りを作る
//      （計画は読むだけ・利用量の確かめは数えるだけ。ここでも AI は呼ばない）。
//   2. 【AIに確認してもらう】: 見積りが「送れる」ときだけ、送る口（runSecurityCheck の役）を呼ぶ。
// 送る口を呼ぶのは runAiFlow の1か所だけ。AI の確認が、点検のあとに勝手に始まることは無い。

import { estimateViewOf, type AiEstimate, type EstimateBudget, type EstimatePlan } from './aiCheckEstimate'
import { failureText } from '../shared/failureText'
import type { PublishScanOutcome } from './publishScanRun'
import type { CheckRecord, SecurityCheckResult } from './securityCheck'

/** 走っている間の押し直しを止める札。点検と AI の確認で1つを分け合う。 */
export interface RunGate {
  tryEnter(): boolean
  leave(): void
  readonly busy: boolean
}

export function createRunGate(): RunGate {
  let busy = false
  return {
    tryEnter() {
      if (busy) return false
      busy = true
      return true
    },
    leave() { busy = false },
    get busy() { return busy },
  }
}

/** 見積りを作る。例外は投げず、失敗の見積りにして返す。利用量の確かめが止めるなら、計画の中身によらず送らない（判断は estimateViewOf）。 */
export async function makeEstimate(
  projectDir: string,
  apiKey: string,
  deps: {
    planAiCheck: (projectDir: string) => Promise<EstimatePlan>
    aiCheckBudget: (apiKey: string) => EstimateBudget
  },
): Promise<AiEstimate> {
  try {
    const plan = await deps.planAiCheck(projectDir)
    const budget = deps.aiCheckBudget(apiKey)
    return { state: 'made', plan, budget }
  } catch (e) {
    return { state: 'failed', failure: failureText(e, { readOnly: true }) }
  }
}

export type ScanFlowEnd = 'busy' | 'done'

/** 【ファイルを点検する】の流れ。送る口は持たない（渡されない）ので、呼びようが無い。 */
export async function runScanFlow(a: {
  projectDir: string
  /** 押した時点のキー。無ければ見積りを作らない */
  apiKey: string
  gate: RunGate
  /** その dir が、いまも開いているプロジェクトか */
  isCurrent: (dir: string) => boolean
  deps: {
    runScan: (projectDir: string) => Promise<PublishScanOutcome>
    planAiCheck: (projectDir: string) => Promise<EstimatePlan>
    aiCheckBudget: (apiKey: string) => EstimateBudget
  }
  on: {
    start: () => void
    scan: (o: PublishScanOutcome) => void
    estimate: (e: AiEstimate) => void
    finish: () => void
  }
}): Promise<ScanFlowEnd> {
  if (!a.gate.tryEnter()) return 'busy'
  const started = a.projectDir
  try {
    a.on.start()
    const outcome = await a.deps.runScan(started)
    if (a.isCurrent(started)) a.on.scan(outcome)
    if (a.apiKey && a.isCurrent(started)) {
      const est = await makeEstimate(started, a.apiKey, a.deps)
      if (a.isCurrent(started)) a.on.estimate(est)
    }
    return 'done'
  } finally {
    a.on.finish()
    a.gate.leave()
  }
}

export type AiFlowEnd = 'busy' | 'no-key' | 'not-sendable' | 'sent'

/** 【AIに確認してもらう】の流れ。見積りが「送れる」ときだけ送る口を呼ぶ。 */
export async function runAiFlow(a: {
  projectDir: string
  apiKey: string
  estimate: AiEstimate | null
  gate: RunGate
  isCurrent: (dir: string) => boolean
  deps: {
    runSecurityCheck: (
      projectDir: string,
      apiKey: string,
      onProgress: (msg: string) => void,
      onAbortReady: (abort: () => void) => void,
    ) => Promise<SecurityCheckResult>
    /** 押した時点のプロジェクトの鍵へ書く（画面が変わっていても書く） */
    writeRecord: (projectDir: string, rec: CheckRecord) => void
  }
  on: {
    start: () => void
    progress: (msg: string) => void
    abortReady: (abort: () => void) => void
    /** 押した時点のプロジェクトのままのときだけ呼ばれる。rec は実施できたときだけ */
    result: (r: SecurityCheckResult, rec: CheckRecord | null) => void
    finish: () => void
  }
}): Promise<AiFlowEnd> {
  if (!a.gate.tryEnter()) return 'busy'
  const started = a.projectDir
  try {
    if (!a.apiKey) return 'no-key'
    if (!a.estimate || !estimateViewOf(a.estimate).canSend) return 'not-sendable'
    a.on.start()
    try {
      let r: SecurityCheckResult
      try {
        r = await a.deps.runSecurityCheck(started, a.apiKey, a.on.progress, a.on.abortReady)
      } catch (e) {
        // 例外で終わった回も、画面に何も出ないままにしない（実施できなかった結果として、失敗の文を置く）
        r = { verdict: 'skip', report: failureText(e, { readOnly: true }) }
      }
      // 実施できたときだけ記録する（省略・失敗は「確認した」ではない）
      let rec: CheckRecord | null = null
      if (r.verdict === 'ok' || r.verdict === 'warn') {
        rec = { at: new Date().toISOString(), verdict: r.verdict }
        try { a.deps.writeRecord(started, rec) } catch { /* 保存できなくても続ける */ }
      }
      if (a.isCurrent(started)) a.on.result(r, rec)
      return 'sent'
    } finally {
      a.on.finish()
    }
  } finally {
    a.gate.leave()
  }
}
