// appLog.ts — 公開したアプリのログを残すかどうかの判断（純ロジック）。
//
// ── なぜ要るか（2026-08-14 Ryosuke 指摘）────────────────────────────────
// 「AppRun は単体でログを持っているのではなく、モニタリングスイートから確認する
// ように見える。ログが既定では ON になっていないので、作った時に ON にできないか」
//
// そのとおりだった。**作っただけではログが残らない。** そして今日、公開したアプリが
// 動かなかったとき、原因はログにしか無かった。非エンジニアがコントロールパネルで
// モニタリングスイートの連携を設定する、というのは現実的ではない。
//
// ── 実測で確定した値（2026-08-14・Ryosuke の実アカウント）────────────────
//   POST /logs/routings/
//     { resource_id, publisher_code: 'apprun', variant: 'applicationlog', log_storage_id }
//   ・resource_id  … `GET /applications/{id}` の `resource_id`（UUID とは別の数値）
//   ・log_storage_id … `GET /logs/storages/` の既定領域（例「デフォルト」）
//   推測ではない。実際に設定済みのルーティングを読んで確かめた（掟1）。
//
// ── 費用の考え方 ──────────────────────────────────────────────────────
// 課金は**ログストレージ単位**（月額の基本料金・日割なし・月1GiBの書き込み込み）。
// **ルーティングを足すこと自体には費用がかからない。** したがって:
//   ・ログストレージが無い  → 作ると月額が発生する → **同意を取る**
//   ・ログストレージが既にある → 追加費用なし → **黙って足してよい**（利用者の利益しかない）

/** AppRun のログを流すための固定値（実測で確定）。 */
export const APPRUN_LOG_PUBLISHER = 'apprun'
export const APPRUN_LOG_VARIANT = 'applicationlog'

/** いまのモニタリングスイートの状態。 */
export type LogSetup = {
  /** ユーザーのログ領域が用意されているか（`provisioning/state` の logs.user_exist）。 */
  storageReady: boolean
  /** 使えるログストレージのID（無ければ null）。 */
  storageId: string | null
  /** このアプリのログが既に流れているか。 */
  alreadyRouted: boolean
}

/** 公開のときに何をするか。 */
export type LogAction =
  /** 何もしない（既に流れている／対象外）。 */
  | { kind: 'none'; note?: string }
  /** そのまま繋ぐ（追加費用なし）。 */
  | { kind: 'route'; storageId: string }
  /** 費用が発生するので、同意を取ってから。 */
  | { kind: 'ask'; note: string }

/**
 * ログを残すために、公開のときに何をすべきかを決める（純関数）。
 *
 * **費用の発生する操作だけを「同意」に回す。** 追加費用のかからない接続まで
 * 尋ねると、利用者は意味の分からない確認を1つ増やされるだけになる。
 */
export function decideLogAction(setup: LogSetup, opts: { consented?: boolean } = {}): LogAction {
  if (setup.alreadyRouted) return { kind: 'none', note: 'ログはすでに残るようになっています。' }

  // ログ領域があるなら、繋ぐだけ。**費用は増えない**ので確認しない
  if (setup.storageReady && setup.storageId) return { kind: 'route', storageId: setup.storageId }

  // 領域が無い＝作ると月額が発生する。同意が要る
  if (!opts.consented) {
    return {
      kind: 'ask',
      note: 'アプリが動かなかったときに原因を調べられるよう、ログを残せます。'
        + 'ログの保存場所（さくらのモニタリングスイート）をこのアカウントに用意します。',
    }
  }
  // 同意済みだが領域がまだ無い → 呼び出し側が用意してから繋ぐ
  return { kind: 'ask', note: 'ログの保存場所を用意しています…' }
}

/** `provisioning/state` の応答から、ユーザーのログ領域があるかを読む。 */
export function parseProvisioningState(data: unknown): boolean {
  const d = (data ?? {}) as Record<string, unknown>
  const logs = (d.logs ?? {}) as Record<string, unknown>
  return logs.user_exist === true
}

/** `logs/storages/` の応答から、使うログストレージのIDを選ぶ。 */
export function pickLogStorageId(data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>
  const results = Array.isArray(d.results) ? d.results : []
  // システム領域ではなく、利用者の領域を使う
  const usable = results.filter((r: any) => r && r.is_system !== true && r.id)
  if (usable.length === 0) return null
  return String(usable[0].id)
}

/**
 * `logs/routings/` の応答に、このアプリのログのルーティングが既にあるか。
 *
 * **同じものを二重に作らない。** 作っても害は小さいが、一覧が汚れて
 * 「どれが効いているのか」が分からなくなる。
 */
export function hasAppLogRouting(data: unknown, resourceId: string): boolean {
  const d = (data ?? {}) as Record<string, unknown>
  const results = Array.isArray(d.results) ? d.results : []
  return results.some((r: any) =>
    r
    && String(r.resource_id ?? '') === String(resourceId)
    && String(r?.publisher?.code ?? '') === APPRUN_LOG_PUBLISHER
    && String(r.variant ?? '') === APPRUN_LOG_VARIANT,
  )
}
