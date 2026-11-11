// deletionWait.ts — HANAMII が「削除を受け付けた」(202) あと、削除が済んだと確かめるまで待つ（electron に依存しない）。
//
// ── 確かめ方（2段）──────────────────────────────────────────────────────────
// 5秒おきに GET /projects/:id を呼ぶ。GET が 404 になったら合図として、DELETE を送って確かめる（前の DELETE から20秒以上あける）。
// **「消えた」と読むのは `readHanamiiDeleteReply`（deleteReply.ts）の1か所だけ**: DELETE の読みが `deleted` か `not-found` のときだけ gone。
// GET の 404 は「いま DELETE で聞き直す」合図にしか使わない（404 は「存在しない」だけでなく「参照できない」も含む。外部リソースの削除が
// 続いている間に見えなくなる形も、原本からは否定できない）。GET の 200 は、本文に何が書いてあっても「まだある」。
//
// ── 結果ごとの扱い ──────────────────────────────────────────────────────────
//   ・GET 200 → 待つ（失敗の連続は 0 に戻す）
//   ・GET 404 → 確かめの DELETE（間隔が足りなければ待つ）。読みが accepted なら待ち続ける
//   ・GET 401・403／確かめの DELETE の 401・403 → すぐ unconfirmed（何度聞いても変わらない答え）
//   ・GET の 429・5xx・例外／確かめの DELETE の 429・5xx・例外 → 失敗に数える。続けて maxFailures 回で unconfirmed。
//     **待っている間の 429 は「削除に失敗」と読まない**（削除は受け付け済み。gone にも、すぐの打ち切りにもしない）
//   ・上限（約5分）の直前に、確かめの DELETE を1回だけ送る（利用者の押し直しと同じ）。GET が完了後も 200 を返し続ける形への保険。
//     **最初の破棄の回だけ**（`finalConfirm: true`）。次に開いたときの自動の続きは送らない: 確認を見ている人がいないうえ、続きは起動のたび・画面を開くたびに
//     走るので、GET が 200 のまま（確認待ち・却下で残った）のプロジェクトへ DELETE を送り続けることになる（requiresReview 中の DELETE の送り直しは原本に無い）
// DELETE は、確かめの回数の上限 maxConfirms と、間隔 confirmGapMs で押さえる（レート制限: 1プロジェクトあたり 30回/300秒）。
import { hanamiiStatusTag, type HanamiiResult } from './client'
import { readHanamiiDeleteReply } from './deleteReply'
import { HANAMII_DELETION_WAIT_PROGRESS } from '../../shared/hanamiiDeletionText'
import { failureDetailOf } from '../../shared/failureText'

/** 待ち方の調整。**テストだけが変える**（実物は既定のまま。aftercare.ts の `hanamiiWaitTuning` と同じ作法）。 */
export const hanamiiDeletionWaitTuning = {
  pollMs: 5000,
  confirmGapMs: 20000,
  maxWaitMs: 300000,
  maxConfirms: 10,
  maxFailures: 5,
  sleep: (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)),
  now: (): number => Date.now(),
}


export type DeletionWaitOutcome =
  | { kind: 'gone' }
  | { kind: 'timeout' }
  /** 確かめる手段が無い・断られた・失敗が続いた。`detail` は原文（HTTP 503・例外の文など）。 */
  | { kind: 'unconfirmed'; detail: string }

type Fail = { kind: 'fatal'; detail: string }

function detailOf(r: HanamiiResult): string {
  // 200 なのに本文の error で失敗した回は「HTTP 200」と書かず code を使う
  return r.status ? hanamiiStatusTag(r) : (typeof r.data === 'string' && r.data ? r.data : '通信エラー')
}

async function attempt(call: () => Promise<HanamiiResult>): Promise<HanamiiResult> {
  try {
    return await call()
  } catch (e: any) {
    return { ok: false, status: 0, data: failureDetailOf(e) }
  }
}

export async function waitForHanamiiDeletion(opts: {
  /** GET /projects/:id（例外は投げてよい。ここで受ける）。 */
  getProject: () => Promise<HanamiiResult>
  /** 確かめの DELETE（例外は投げてよい。ここで受ける）。 */
  deleteProject: () => Promise<HanamiiResult>
  /** 呼び手が、待ち始める直前に DELETE を送った（その時刻から間隔をあける）。続きの回（GET から始める）は false。 */
  deleteJustSent: boolean
  /** 上限の直前に、確かめの DELETE を1回送るか。最初の破棄は true、自動の続きは false（GET が 404 を見せた回の DELETE だけ）。 */
  finalConfirm: boolean
  /** 進み具合（記録へ）。detail は「N秒経過」。 */
  onProgress?: (label: string, detail: string) => void
}): Promise<DeletionWaitOutcome> {
  const t = hanamiiDeletionWaitTuning
  const startedAt = t.now()
  let lastDeleteAt: number | null = opts.deleteJustSent ? startedAt : null
  let confirms = 0
  let failures = 0

  const gapOk = (): boolean => lastDeleteAt === null || t.now() - lastDeleteAt >= t.confirmGapMs
  /** 確かめの DELETE を1本送る。gone なら 'gone'、fatal なら Fail、それ以外は null（続ける）。 */
  const confirm = async (): Promise<'gone' | Fail | null> => {
    lastDeleteAt = t.now()
    confirms++
    const r = await attempt(opts.deleteProject)
    const reading = readHanamiiDeleteReply(r)
    if (reading === 'deleted' || reading === 'not-found') return 'gone'
    if (reading === 'accepted') { failures = 0; return null }
    if (r.status === 401 || r.status === 403) return { kind: 'fatal', detail: detailOf(r) }
    failures++
    return failures >= t.maxFailures ? { kind: 'fatal', detail: detailOf(r) } : null
  }

  for (;;) {
    const g = await attempt(opts.getProject)
    if (g.status === 404) {
      if (gapOk() && confirms < t.maxConfirms) {
        const c = await confirm()
        if (c === 'gone') return { kind: 'gone' }
        if (c) return { kind: 'unconfirmed', detail: c.detail }
      }
    } else if (g.ok) {
      failures = 0
    } else if (g.status === 401 || g.status === 403) {
      return { kind: 'unconfirmed', detail: detailOf(g) }
    } else {
      failures++
      if (failures >= t.maxFailures) return { kind: 'unconfirmed', detail: detailOf(g) }
    }
    const elapsed = t.now() - startedAt
    if (elapsed + t.pollMs >= t.maxWaitMs) break
    opts.onProgress?.(HANAMII_DELETION_WAIT_PROGRESS, `${Math.round(elapsed / 1000)}秒経過`)
    await t.sleep(t.pollMs)
  }

  // 上限の直前: 確かめの DELETE を1回だけ（間隔があくまで待ってから。回数の上限は守る）。続きの回は送らない。
  if (opts.finalConfirm && confirms < t.maxConfirms) {
    if (!gapOk()) await t.sleep(t.confirmGapMs - (t.now() - (lastDeleteAt as number)))
    const c = await confirm()
    if (c === 'gone') return { kind: 'gone' }
    if (c) return { kind: 'unconfirmed', detail: c.detail }
  }
  return { kind: 'timeout' }
}
