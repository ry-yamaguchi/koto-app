// rollback.ts — トラフィック切り替え（ロールバック・固定の解除）を実クラウドへ適用する実行層（純ロジック）。
//
// ※electron に依存しない（apply.ts と同じ理由）。クライアントは TrafficClientLike として
//   「注入」で受け取るので、esbuild 単体・偽の client でテストできる
//   （client.ts の SakuraCloudClient がこのインターフェースを満たす）。
//
// ── 安全規約（掟5・cloud:apply / cloud:teardown と同じ書き方に揃える）─────────────
// confirmed !== true なら putTraffics を一切呼ばない。
//
// 2026-09-08 検分で指摘: cloud:apply / cloud:teardown / cloud:cleanupImages は main 側で
// opts.confirmed === true を要求しているのに、この機能だけ「確認は画面側」と書いて
// main 側の歯止めが無かった。検分役が実際に画面側の `if (!window.confirm(` を
// `if (false && !window.confirm(` に変異させても、既存のテスト（文字列一致）は
// 32件すべて緑のまま素通りした——**歯止めが振る舞いで守られていなかった**ということ。
// ここに main 側のガードを置き、偽の client を注入した振る舞いテスト（tests/rollback.test.ts）
// で「confirmed でなければ putTraffics が一度も呼ばれない」ことを固定する。

import { buildRollbackBody } from '../../shared/apprunTraffic'
import { apiErrorMessage, type RequestResult } from './client'

/** performRollback が要求するクライアントの最小インターフェース。 */
export interface TrafficClientLike {
  putTraffics(appId: string, body: unknown): Promise<RequestResult>
}

export interface RollbackOptions {
  appId: string
  /** 切り替え先のバージョン名。`null` なら「最新に追従」へ戻す（buildRollbackBody(null)）。 */
  versionName: string | null
  /** 画面の確認ダイアログを通ったときだけ true。true でなければ何も実行しない。 */
  confirmed: boolean
  client: TrafficClientLike
}

export interface RollbackResult {
  ok: boolean
  message?: string
}

/**
 * トラフィックの切り替え（ロールバック／固定の解除）を実行する。
 *
 * 分岐の優先順位:
 *  1. confirmed !== true → 何も実行せず ok:false を返す（putTraffics を呼ばない）。
 *  2. dryRun（client.dryRun===true 相当の応答）→ 何も実行しなかった旨を返す。
 *  3. 通常実行: buildRollbackBody(versionName) を PUT する。
 */
export async function performRollback(opts: RollbackOptions): Promise<RollbackResult> {
  // 1. 確認ガード（cloud:apply の hasDestructive && confirmed!==true と同じ形）。
  if (opts.confirmed !== true) {
    return { ok: false, message: '確認が必要です' }
  }

  const r = await opts.client.putTraffics(opts.appId, buildRollbackBody(opts.versionName))
  if (r.dryRun === false && r.ok) return { ok: true }
  if (r.dryRun === false && (r.status === 401 || r.status === 403)) {
    return { ok: false, message: '認証に失敗しました（クラウドのAPIキーを確認してください）' }
  }
  return {
    ok: false,
    message: r.dryRun === false
      ? `切り替えに失敗しました（HTTP ${r.status}）${apiErrorMessage(r.data) ? ' — ' + apiErrorMessage(r.data) : ''}`
      : '予期しない応答',
  }
}
