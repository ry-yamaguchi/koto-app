// connectionCheck.ts — 接続テストの「請求（コスト）参照」チェックを一元化する（roadmap #35）。
//
// 共用型（cloud:testConnection・src/main/ipc/cloud.ts）と専有型
// （apprunDedicated:testConnection・src/main/ipc/apprunDedicated.ts）の両方が、
// この同じ関数を呼ぶ。判断・表示を複製しない（掟10）。
//
// **専有型は常時課金**なので、共用型よりむしろ請求（コスト）参照が要る
// （2026-09-09 Ryosuke さん指摘）。auth-status → accountId → bill の順に GET する
// だけの読み取り専用チェックで、どちらの型でも意味は同じ。

import { extractAccountId, apiErrorMessage } from './client'
import type { RequestResult } from './client'

/** 各接続チェック結果の形（成否・HTTPステータス・失敗時メッセージ）。共用型・専有型で共通。 */
export type ConnCheck = { ok: boolean; status?: number; message?: string }

/** この処理が必要とするクライアントの最小の形（実体は SakuraCloudClient。テストでは偽物を渡せる）。 */
export type BillingClient = {
  getAuthStatus(zone: string): Promise<RequestResult>
  getBillByContract(zone: string, accountId: string): Promise<RequestResult>
}

/**
 * 請求（コスト）参照チェック。GET のみ（読み取り専用・何も作らない・掟4の方式Bを踏襲）。
 *
 * 失敗時は応答本文（`apiErrorMessage`）を message に併記する（P・2026-09-10 レビューの修理・
 * バッチ3。直す前は HTTPステータスだけで応答本文を捨てており、共用型のレジストリ項目
 * （src/main/ipc/cloud.ts の apiErrorMessage 併記パターン）と扱いが揃っていなかった）。
 */
export async function checkBilling(client: BillingClient, zone: string): Promise<ConnCheck> {
  try {
    const st = await client.getAuthStatus(zone)
    if (st.dryRun === false && !st.ok) {
      const detail = apiErrorMessage(st.data)
      return { ok: false, status: st.status, message: `アカウント情報の取得に失敗（HTTP ${st.status}）${detail ? ' — ' + detail : ''}` }
    }
    const accountId = st.dryRun === false ? extractAccountId(st.data) : null
    if (!accountId) {
      return { ok: false, message: 'アカウントIDを取得できませんでした' }
    }
    const b = await client.getBillByContract(zone, accountId)
    if (b.dryRun === false && b.ok) {
      return { ok: true, status: b.status }
    }
    const detail = b.dryRun === false ? apiErrorMessage(b.data) : ''
    return {
      ok: false,
      status: b.dryRun === false ? b.status : undefined,
      message: `請求の取得に失敗 HTTP ${b.dryRun === false ? b.status : '?'}${detail ? ' — ' + detail : ''}`,
    }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}
