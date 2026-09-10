// appLog.ts — 公開したアプリの「ログ」「メトリクス」を残すかどうかの判断（純ロジック）。
//
// ── なぜ要るか（2026-08-14 Ryosuke 指摘）────────────────────────────────
// 「AppRun は単体でログを持っているのではなく、モニタリングスイートから確認する
// ように見える。ログが既定では ON になっていないので、作った時に ON にできないか」
//
// そのとおりだった。**作っただけではログが残らない。** そして今日、公開したアプリが
// 動かなかったとき、原因はログにしか無かった。非エンジニアがコントロールパネルで
// モニタリングスイートの連携を設定する、というのは現実的ではない。
//
// ── #30 でメトリクスへ拡張（2026-09-08）────────────────────────────────
// さくらの開発者から「ログとメトリクスは有効にしてて欲しい」と助言があった。
// ログと同じ AppRun 用モニタリングスイートに、メトリクス専用の publisher variant
// （`applicationmetrics`）が並んでいることを実測で確認した（掟1）。判断のロジックは
// ログとまったく同じ形なので、**種類（`TelemetryKind`）で分岐する1本にまとめる**
// （掟10・同じ形の処理を複製しない）。既存の名前（`decideLogAction` 等）は
// 呼び出し側の互換のため、`kind: 'logs'` 固定の薄い皮として残す。
//
// ── 実測で確定した値 ────────────────────────────────────────────────
//   ログ    （2026-08-14・Ryosuke の実アカウント）
//     POST /logs/routings/
//       { resource_id, publisher_code: 'apprun', variant: 'applicationlog', log_storage_id }
//   メトリクス（2026-09-08・Ryosuke の実アカウント。GET /publishers/apprun/ で確認）
//     POST /metrics/routings/
//       { resource_id, publisher_code: 'apprun', variant: 'applicationmetrics', metrics_storage_id }
//   ・resource_id      … `GET /applications/{id}` の `resource_id`（UUID とは別の数値）
//   ・{log,metrics}_storage_id … `GET /{logs,metrics}/storages/` の既定領域（例「デフォルト」）
//   ・`GET /management/provisioning/state/` は `{ logs: {...}, metrics: {...} }` と、
//     2つの種類を同じ形で並べて返す（実測）。
//   推測ではない。実際に設定済みのルーティングを読んで確かめた（掟1）。
//
// ── 費用の考え方 ──────────────────────────────────────────────────────
// 課金は**ストレージ単位**（ログ・メトリクスそれぞれで月額の基本料金・日割なし）。
// **ルーティングを足すこと自体には費用がかからない。** したがって:
//   ・ストレージが無い  → 作ると月額が発生する → **同意を取る**
//   ・ストレージが既にある → 追加費用なし → **黙って足してよい**（利用者の利益しかない）
// これはログ・メトリクスどちらでも同じ判断。

/** モニタリングスイートで扱う2つの種類。 */
export type TelemetryKind = 'logs' | 'metrics'

/**
 * kind が 'logs' | 'metrics' のどちらかであることを検証する（R・2026-09-10 レビューの修理・
 * バッチ3）。main の IPC ハンドラ（cloud:telemetryStatus / cloud:enableTelemetry）は renderer
 * から渡された kind を検証せずそのまま URL とPOST本文へ入れていた——ここが「最後の砦」として、
 * 不正な値なら fetch を一切呼ばせない（掟10と同じ形。TS の型注釈は実行時には効かない）。
 */
export function isTelemetryKind(v: unknown): v is TelemetryKind {
  return v === 'logs' || v === 'metrics'
}

/** AppRun 用の publisher（実測で確定・ログ／メトリクス共通）。 */
export const APPRUN_PUBLISHER = 'apprun'

/** 種類ごとの variant（実測で確定。`GET /publishers/apprun/` で確認）。 */
export const APPRUN_VARIANT: Record<TelemetryKind, string> = {
  logs: 'applicationlog',
  metrics: 'applicationmetrics',
}

/** 画面文言に使う、種類ごとの言い回し。 */
const TELEMETRY_COPY: Record<TelemetryKind, { label: string; already: string; ask: string; preparing: string }> = {
  logs: {
    label: 'ログ',
    already: 'ログはすでに残るようになっています。',
    ask: 'アプリが動かなかったときに原因を調べられるよう、ログを残せます。'
      + 'ログの保存場所（さくらのモニタリングスイート）をこのアカウントに用意します。',
    preparing: 'ログの保存場所を用意しています…',
  },
  metrics: {
    label: 'メトリクス',
    already: 'メトリクスはすでに残るようになっています。',
    ask: 'アプリの負荷や利用状況をあとから確認できるよう、メトリクスを残せます。'
      + 'メトリクスの保存場所（さくらのモニタリングスイート）をこのアカウントに用意します。',
    preparing: 'メトリクスの保存場所を用意しています…',
  },
}

/** いまのモニタリングスイートの状態（ログ・メトリクス共通の形）。 */
export type TelemetrySetup = {
  /** ユーザーの領域が用意されているか（`provisioning/state` の `<kind>.user_exist`）。 */
  storageReady: boolean
  /** 使えるストレージのID（無ければ null）。 */
  storageId: string | null
  /** このアプリの分がすでに流れているか。 */
  alreadyRouted: boolean
}

/** 公開のときに何をするか（ログ・メトリクス共通の形）。 */
export type TelemetryAction =
  /** 何もしない（既に流れている／対象外）。 */
  | { kind: 'none'; note?: string }
  /** そのまま繋ぐ（追加費用なし）。 */
  | { kind: 'route'; storageId: string }
  /** 費用が発生するので、同意を取ってから。 */
  | { kind: 'ask'; note: string }

/**
 * 残すために、公開のときに何をすべきかを決める（純関数）。ログ・メトリクス共通。
 *
 * **費用の発生する操作だけを「同意」に回す。** 追加費用のかからない接続まで
 * 尋ねると、利用者は意味の分からない確認を1つ増やされるだけになる。
 */
export function decideTelemetryAction(
  setup: TelemetrySetup,
  kind: TelemetryKind,
  opts: { consented?: boolean } = {},
): TelemetryAction {
  const copy = TELEMETRY_COPY[kind]
  if (setup.alreadyRouted) return { kind: 'none', note: copy.already }

  // 領域があるなら、繋ぐだけ。**費用は増えない**ので確認しない
  if (setup.storageReady && setup.storageId) return { kind: 'route', storageId: setup.storageId }

  // 領域が無い＝作ると月額が発生する。同意が要る
  if (!opts.consented) return { kind: 'ask', note: copy.ask }
  // 同意済みだが領域がまだ無い → 呼び出し側が用意してから繋ぐ
  return { kind: 'ask', note: copy.preparing }
}

/**
 * `cloud:enableTelemetry` が実際に何をすべきかの4状態（純関数）。
 *
 * ── なぜ足したか（#30 検分・2026-09-08）────────────────────────────────
 * 検分役が実物を読んだところ、`cloud:enableTelemetry`（IPCハンドラ）は
 * `decideTelemetryAction` を**一度も参照せず**、無条件で `initializeProvisioning`
 * （課金の始まる呼び出し）から始まっていた。画面（`TelemetryNotice.tsx`）に
 * 「置き場がある（route）」の分岐があっても無くても、同じ初期化から始まる形で、
 * **同意なしに課金される経路**になっていた。
 *
 * 直し方は「判断をここに一元化し、IPCハンドラ（`src/main/cloud/monitoring.ts` の
 * `enableTelemetry` 経由）はこの関数の結果に従うだけにする」。**`'initialize-then-route'`
 * は `opts.consented === true` のときにしか返さない**——呼び出し側（画面）が
 * 明示的に同意を渡さない限り、課金の始まる操作は実行されない。
 *
 * - `'nothing'`               … 既に繋がっている。何もしない
 * - `'route'`                 … 保存場所は既にある。**追加費用は無いので同意は不要**
 * - `'need-consent'`          … 保存場所が無い（作ると課金が始まる）。同意が無いので、
 *                                ここで止まる（初期化を呼ばせない）
 * - `'initialize-then-route'` … 保存場所が無く、**利用者が同意した**ときだけ。
 *                                このときに限り初期化してよい
 */
export type EnableTelemetryDecision =
  | { do: 'nothing' }
  | { do: 'route'; storageId: string }
  | { do: 'need-consent' }
  | { do: 'initialize-then-route' }

export function decideEnableTelemetry(
  setup: TelemetrySetup,
  opts: { consented: boolean },
): EnableTelemetryDecision {
  if (setup.alreadyRouted) return { do: 'nothing' }
  // 保存場所があるなら、繋ぐだけ。**費用は増えないので同意は要らない**
  if (setup.storageReady && setup.storageId) return { do: 'route', storageId: setup.storageId }
  // ここに来るのは「保存場所が無い（またはIDが取れない）」→ 作ると課金が始まる
  if (!opts.consented) return { do: 'need-consent' }
  return { do: 'initialize-then-route' }
}

/** `management/provisioning/state/` の応答から、指定した種類のユーザー領域があるかを読む。 */
export function parseProvisioningState(data: unknown, kind: TelemetryKind): boolean {
  const d = (data ?? {}) as Record<string, unknown>
  const section = (d[kind] ?? {}) as Record<string, unknown>
  return section.user_exist === true
}

/**
 * `{logs,metrics}/storages/` の応答から、使うストレージのIDを選ぶ。
 * 応答の形はログ・メトリクスで同じなので、種類の区別は要らない。
 */
export function pickStorageId(data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>
  const results = Array.isArray(d.results) ? d.results : []
  // システム領域ではなく、利用者の領域を使う
  const usable = results.filter((r: any) => r && r.is_system !== true && r.id)
  if (usable.length === 0) return null
  return String(usable[0].id)
}

/**
 * `{logs,metrics}/routings/` の応答に、このアプリの、指定した種類のルーティングが既にあるか。
 *
 * **同じものを二重に作らない。** 作っても害は小さいが、一覧が汚れて
 * 「どれが効いているのか」が分からなくなる。**ログとメトリクスも取り違えない**
 * （variant で区別する）。
 */
export function hasAppRouting(data: unknown, resourceId: string, kind: TelemetryKind): boolean {
  const d = (data ?? {}) as Record<string, unknown>
  const results = Array.isArray(d.results) ? d.results : []
  return results.some((r: any) =>
    r
    && String(r.resource_id ?? '') === String(resourceId)
    && String(r?.publisher?.code ?? '') === APPRUN_PUBLISHER
    && String(r.variant ?? '') === APPRUN_VARIANT[kind],
  )
}

// ── 後方互換の薄い皮（`kind: 'logs'` 固定）─────────────────────────────
// 既存の呼び出し側（src/main/ipc/cloud.ts の旧経路・tests）を壊さないために残す。
// 中身は上の一般化した関数を呼ぶだけで、判断を複製しない（掟10）。

/** @deprecated `APPRUN_PUBLISHER` を使う。 */
export const APPRUN_LOG_PUBLISHER = APPRUN_PUBLISHER
/** @deprecated `APPRUN_VARIANT.logs` を使う。 */
export const APPRUN_LOG_VARIANT = APPRUN_VARIANT.logs

/** @deprecated `LogSetup` は `TelemetrySetup` の別名。 */
export type LogSetup = TelemetrySetup
/** @deprecated `LogAction` は `TelemetryAction` の別名。 */
export type LogAction = TelemetryAction

/** @deprecated `decideTelemetryAction(setup, 'logs', opts)` を使う。 */
export function decideLogAction(setup: LogSetup, opts: { consented?: boolean } = {}): LogAction {
  return decideTelemetryAction(setup, 'logs', opts)
}

/** @deprecated `pickStorageId(data)` を使う（ログ専用の判断は無い）。 */
export function pickLogStorageId(data: unknown): string | null {
  return pickStorageId(data)
}

/** @deprecated `hasAppRouting(data, resourceId, 'logs')` を使う。 */
export function hasAppLogRouting(data: unknown, resourceId: string): boolean {
  return hasAppRouting(data, resourceId, 'logs')
}
