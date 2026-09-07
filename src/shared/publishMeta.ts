// publishMeta.ts — `.sakuraide.json` の publish 部分をマージ書き込みする純関数（一元定義・掟10）。
//
// ── なぜ一元化するか ──────────────────────────────────────────────────
// renderer（HanamiiPanel/VercelPanel/AppRunPanel）と main（hanamii:publish/vercel:publish/
// cloud:apply の3経路）の両方が「publish.* を既存キーを消さずにマージ書き込みする」処理を
// 必要とする。2026-09-07 の調査（roadmap #14）まで renderer 側の各パネルがほぼ同じ形の
// マージをバラバラに書いており（saveHanamiiMeta / saveVercelMeta / saveAppRunPublishRecord /
// publishPending.ts）、片方だけ直されて穴が空く事故の温床だった。ここに1箇所へ集め、
// renderer と main の両方がこの関数を呼ぶ（main 側は src/main/publishMetaFs.ts が
// ディスク読み書きを担い、この純関数を使う）。
//
// electron/DOM には依存しない（node からも直接テストできる純粋関数のみ）。
// ⚠️ node の path/fs も import しない: shared は renderer からも import され、vite は node 組み込みを
// 空の shim にするため、実行時に `(void 0) is not a function` で死ぬ（appChatDirs.ts と同じ理由・
// 2026-09-02 実測）。この決まりは tests/appChatDirs.test.ts が src/shared 全体に対して固定している。
//
// PublishTargetKind は src/renderer/publishStatus.ts が唯一の定義（型のみの import・複製しない）。
// src/shared/teardownSupport.ts が既に同じ形でこの型を type-only import している（先例）。
import type { PublishTargetKind } from '../renderer/publishStatus'

export type { PublishTargetKind }

/** 値がプレーンオブジェクトならその浅いコピーを、そうでなければ空オブジェクトを返す。
 *  null・undefined・配列・文字列・壊れた JSON をパースした結果など、何が来ても落ちないための土台。 */
function asRecord(x: unknown): Record<string, unknown> {
  if (x && typeof x === 'object' && !Array.isArray(x)) return { ...(x as Record<string, unknown>) }
  return {}
}

/**
 * `publish.targets[target]` に公開記録を差し込む。
 * 他のキー（他ターゲットの記録・`publish.hanamii.projectId`・`publish.pending`・
 * `publish` 以外のトップレベルキー）はすべて保つ（マージ書き込み）。
 */
export function withPublishRecord(
  meta: unknown,
  target: PublishTargetKind,
  rec: { publishedAt: string | null; url: string | null },
): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  const targets = asRecord(publish.targets)
  return {
    ...m,
    publish: {
      ...publish,
      targets: { ...targets, [target]: rec },
    },
  }
}

/**
 * `publish.pending`（公開開始マーカー）を書く。公開処理の開始時、実際の公開API呼び出しの
 * 直前に呼ぶこと。他の `publish.*` のキー（targets 等）は保つ。
 */
export function withPendingPublish(meta: unknown, target: PublishTargetKind, startedAt: string): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  return {
    ...m,
    publish: {
      ...publish,
      pending: { target, startedAt },
    },
  }
}

/**
 * `publish.pending` を取り除く。公開処理の終了時（成功/失敗どちらでも）、必ず呼ぶこと。
 * 他の `publish.*` のキーは保つ。pending が無ければ何も変えず、そのまま返す。
 */
export function withoutPendingPublish(meta: unknown): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  if (!('pending' in publish)) return m
  const { pending: _pending, ...restPublish } = publish
  return { ...m, publish: restPublish }
}

/**
 * HANAMII 固有: `publish.hanamii.projectId` を保つ/更新する。
 * HANAMII は初回公開で projectId が発行され、これを保存しないまま次回公開すると
 * 新規プロジェクトとして二重作成されうる。`publish.hanamii` の他のキー
 * （workspaceId・envs・healthCheck・name 等）は保つ。
 */
export function withHanamiiProjectId(meta: unknown, projectId: string | null): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  const hanamii = asRecord(publish.hanamii)
  return {
    ...m,
    publish: {
      ...publish,
      hanamii: { ...hanamii, projectId },
    },
  }
}
