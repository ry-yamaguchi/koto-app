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
 * さくらのAppRun 専有型（roadmap #23）: `publish.apprunDedicated` に記録する内容。
 *
 * ── なぜここに置くか（段階②・掟10の一元化）───────────────────────────────
 * 段階①は `consentedAt`／`servicePrincipalId` だけを持っていたが、段階②で
 * クラスタ・ASG・ロードバランサの ID を追加で記録するようになった。
 * 「実際に作られたものを記録する」書き込みは main（apprunDedicatedApply.ts）と
 * renderer（AppRunDedicatedPanel.tsx の同意・リソースID保存）の両方から起きるため、
 * `withPublishRecord` 等と同じ形で1箇所にまとめる。
 *
 * 各 ID は「実際に作られたか」を表す。**成功した段だけ値を持つ**——途中で失敗しても、
 * 作れたところまでの ID は残す（2026-08-14「失敗しても、途中まで起きたことは記録する」）。
 * 破棄で消せたものは `null` に戻す（消せなかったものは値を残し、「残っている」と示せるようにする）。
 */
export type ApprunDedicatedRecord = {
  /** ②で案内している、手作業で用意したサービスプリンシパルのID。 */
  servicePrincipalId?: string | null
  /** 費用に同意した日時（ISO文字列）。無ければ「同意していない」。 */
  consentedAt?: string | null
  /** 作られたクラスタのID。 */
  clusterID?: string | null
  /** 作られたオートスケーリンググループのID（クラスタの下）。 */
  asgID?: string | null
  /** 作られたロードバランサのID（ASGの下。クラスタとは別の資源＝5-6）。 */
  loadBalancerID?: string | null
  /** クラスタ・ASG・LBに共通で使った名前（作成時の入力）。 */
  name?: string | null
  /** ASG作成に使ったゾーン。 */
  zone?: string | null
  /** 選んだワーカプランの path（`/service_classes/worker` の値）。 */
  workerServiceClassPath?: string | null
  /** 選んだロードバランサプランの path（`/service_classes/lb` の値）。 */
  lbServiceClassPath?: string | null
  /** クラスタを作成した時刻（ISO文字列）。 */
  createdAt?: string | null
}

/**
 * `publish.apprunDedicated` へパッチをマージ書き込みする（他のキー・他の publish.* は保つ）。
 * 段階①からある `consentedAt`／`servicePrincipalId` の書き込みも、段階②のID記録も、
 * 必ずこの1箇所を通す（同じ形のマージを別々に書かない・掟10）。
 */
export function withApprunDedicatedRecord(meta: unknown, patch: Partial<ApprunDedicatedRecord>): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  const existing = asRecord(publish.apprunDedicated)
  return {
    ...m,
    publish: {
      ...publish,
      apprunDedicated: { ...existing, ...patch },
    },
  }
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
