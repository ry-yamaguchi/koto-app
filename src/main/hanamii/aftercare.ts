// aftercare.ts — HANAMII の公開の「あと」: 新しい版が動いたと確かめるまで待つ（純粋に近いロジック）。
//
// ── なぜ main にあるか（2026-09-29）────────────────────────────────────────
// これまでは HanamiiPanel（画面）の setInterval が「READY になったか確かめる → URL を記録に書く →
// 古い保存場所の鍵を片づける」を担っていた。**ダイアログを閉じるとその setInterval ごと消える**ので、
// 古い鍵が残り、記録の url が null のままになった。公開の本体は main の1回の IPC で最後まで進むのだから、
// 「動いたと確かめる」ところまで main が担う（ipc/hanamii.ts の hanamii:publish の後段）。
//
// ── 何を「動いた」と読むか（掟1・掟10）──────────────────────────────────────
// 原本（HANAMII 公式 API リファレンス・2026-09-29 に取得）:
//   ・`GET /api/v1/projects/:id` の `latestDeployment` は `{ id, readyState, errorCode }`
//   ・**latestDeployment は「現在稼働中の deployment」ではなく「直近の deployment 試行」**
//   ・再デプロイに失敗しても、前回成功版は稼働中のまま（project.url は稼働中のアプリを指す）
//   ・完了後の URL は、latestDeployment.readyState が READY になった応答から取る
// だから「新しい版が動いた」は **latestDeployment.id が今回の deployment の id と一致し、かつ READY**
// の場合だけ。id が違う（前回の版が latest のまま）READY は「新しい版が動いた」の証拠にならない。
// **古い保存場所の鍵を消してよいのは、これで READY と確かめられたときだけ**（CLAUDE.md 掟10
// 「切り替わる前に、古いほうの足元を外さない」・2026-08-14 の 403 事故）。
// 確かめられなかったとき（ERROR・時間切れ・状態を取れない・どの deployment か分からない）は
// **消さない**。消さなかった鍵は、次に「動いたと確かめられた」公開で片づく。
import { extractProjectStatus, extractLatestDeploymentId, type HanamiiResult } from './client'

/**
 * 待ち方の調整。**テストだけが変える**（実物は既定のまま）。
 * 3秒おきに最長 maxPolls 回（既定 100 回＝約5分。Vercel の公開の待ちと同じ）。
 */
export const hanamiiWaitTuning = {
  intervalMs: 3000,
  maxPolls: 100,
  sleep: (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)),
}

/** 状態を取れないことが続いたら打ち切る回数（Vercel の公開と同じ）。 */
const MAX_CONSECUTIVE_FAILURES = 5

export type NewVersionOutcome =
  /** 新しい版が READY になったと確かめた。 */
  | { kind: 'ready'; url: string | null }
  /** 新しい版が ERROR になった（前の版が動き続けている場合がある）。 */
  | { kind: 'error'; errorCode: string | null }
  /** 待つ時間のうちに READY にも ERROR にもならなかった。`readyState` は最後に見た今回の版の状態（見えなかったら null）。 */
  | { kind: 'pending'; readyState: string | null; waitedSec: number }
  /** 確かめる手段が無い・断られた・取れないことが続いた。理由を画面の文にして持つ。 */
  | { kind: 'unknown'; message: string }

export async function waitForNewVersion(opts: {
  /** GET /api/v1/projects/:id を1回呼ぶ（例外は投げてよい。ここで受ける）。 */
  getProject: () => Promise<HanamiiResult>
  /** 今回の公開が作った deployment の id（createProject / redeploy の応答から）。無ければ確かめようがない。 */
  deploymentId: string | null
  /** 進み具合（記録へ）。 */
  onProgress?: (label: string, detail: string) => void
}): Promise<NewVersionOutcome> {
  if (!opts.deploymentId) {
    return { kind: 'unknown', message: 'HANAMII の応答から、今回の公開の番号（deployment の id）を読み取れませんでした' }
  }
  const { intervalMs, maxPolls, sleep } = hanamiiWaitTuning
  const startedAt = Date.now()
  let failures = 0
  let ourState: string | null = null
  for (let i = 0; i < maxPolls; i++) {
    let res: HanamiiResult
    try {
      res = await opts.getProject()
    } catch (e: any) {
      res = { ok: false, status: 0, data: e?.message ?? String(e) }
    }
    if (res.ok) {
      failures = 0
      if (extractLatestDeploymentId(res.data) === opts.deploymentId) {
        const st = extractProjectStatus(res.data)
        ourState = st.readyState
        if (st.readyState === 'READY') return { kind: 'ready', url: st.url }
        if (st.readyState === 'ERROR') return { kind: 'error', errorCode: st.errorCode }
      }
      // id が違う（前回の版が latest のまま・まだ切り替わっていない）は、READY でも「新しい版が動いた」ではない。待つ。
    } else if (res.status === 401 || res.status === 403 || res.status === 404) {
      // 何度聞いても変わらない答え（トークンの権限・プロジェクトが見えない）。待たずに打ち切る。
      return { kind: 'unknown', message: `HANAMII から状態を取れませんでした（HTTP ${res.status}）` }
    } else {
      failures++
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        return { kind: 'unknown', message: `HANAMII から状態を取れない状態が続きました（HTTP ${res.status || '通信エラー'}）` }
      }
    }
    const sec = Math.round((Date.now() - startedAt) / 1000)
    opts.onProgress?.('⏳ HANAMII が新しい版を起動するのを待っています…', `状態: ${ourState ?? '確認中'}（${sec}秒経過）`)
    if (i < maxPolls - 1) await sleep(intervalMs)
  }
  return { kind: 'pending', readyState: ourState, waitedSec: Math.round((Date.now() - startedAt) / 1000) }
}
