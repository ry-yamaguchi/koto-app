// teardownSupport.ts — 公開先ごとに「Koto から破棄できるか」を判定する（純粋ロジック）。
//
// ── なぜ一元化するのか（2026-08-09 Ryosuke の指摘）──────────────────────
// 破棄の導線を「③公開」の各パネル以外にも増やす（📡 公開したもの一覧・プロジェクト削除時）。
// 公開先は4つあるが**破棄の口があるのは2つだけ**なので、置き場所ごとに判定を書くと
// 「押しても何も起きないボタン」がどこかに生まれる。判定はここ1箇所に置く。
//
// 破棄できない2つは、サービス側で消してもらうしかない。**消す方法を必ず添える**こと。
// 「できません」だけでは、月額課金が続くものを放置させることになる。

import type { PublishTargetKind } from '../renderer/publishStatus'

/** Koto から破棄できるか。'manual' はサービス側で消してもらう。 */
export type TeardownSupport = 'supported' | 'manual'

/**
 * その公開先を Koto から破棄できるか。
 * - `sakura-apprun` … `cloud:teardown`（アプリ＋コンテナレジストリ）
 * - `hanamii`       … `hanamii:teardown`（プロジェクト削除）
 * - `vercel` / `sakura-rental` … 破棄の実装が無い
 */
export function teardownSupport(target: PublishTargetKind): TeardownSupport {
  return target === 'sakura-apprun' || target === 'hanamii' ? 'supported' : 'manual'
}

/**
 * 破棄できない公開先について、どこで消せばよいかを伝える文。
 * 画面には素のテキストとして出るので、Markdown 記法は使わない（v0.2.98 の教訓）。
 */
export function manualTeardownGuide(target: PublishTargetKind): string {
  switch (target) {
    case 'vercel':
      return 'Koto からは削除できません。Vercel のダッシュボード（vercel.com）でプロジェクトを削除してください。'
    case 'sakura-rental':
      return 'Koto からは削除できません。さくらのレンタルサーバのファイルマネージャか FTP で、'
        + 'アップロードしたファイルを削除してください。'
    default:
      return ''
  }
}

/** 破棄したときに、その公開先で何が消えるかの一言（確認画面用）。 */
export function teardownScopeNote(target: PublishTargetKind): string {
  switch (target) {
    case 'sakura-apprun':
      return 'AppRun アプリとコンテナレジストリ（登録済みイメージごと）を削除します。'
    case 'hanamii':
      return 'HANAMII のプロジェクトを削除します。'
    default:
      return ''
  }
}

/**
 * 破棄したときに、保存場所のデータがどうなるかを伝える文（確認画面用）。
 *
 * ── なぜ別の文が要るのか（2026-08-14）────────────────────────────────
 * 破棄の確認画面は「アプリとレジストリを消します」としか言っていなかった。
 * だが永続データを使うプロジェクトでは、**利用者が入れたデータも消える**。
 * それを言わずに押させてはいけない。
 *
 * 実際に何が消えるかの判断は `src/shared/objectStorage.ts` の `teardownPlanFor`
 * が中身を一覧してから決める（ほかのプロジェクトや、利用者が自分で置いた
 * ファイルがあれば保存場所そのものは残す）。**ここはその約束を先に伝える**。
 *
 * 画面には素のテキストとして出るので、Markdown 記法は使わない（v0.2.98 の教訓）。
 */
export function teardownDataNote(placement: { bucket: string; prefix?: string; shared?: boolean } | null | undefined): string {
  if (!placement || typeof placement.bucket !== 'string' || placement.bucket.length === 0) return ''
  const head = `保存場所『${placement.bucket}』にある、このプロジェクトのデータも削除します。`
  const keep = 'ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。'
  return placement.shared === false
    ? `${head}${keep}残るものが無ければ、保存場所そのものも削除して月額を止めます。`
    : `${head}${keep}この保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。`
}
