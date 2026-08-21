// migratePlan.ts — 既存プロジェクトを `public/` の形へ移すときの、何を移すかの判断。
//
// ── 決めごと（2026-08-20 Ryosuke 指示）────────────────────────────────
//   ・**確認は出すが、拒否はできない。** 押すまで進まない案内にする。
//   ・**黙ってはやらない。** 何をどこへ移したかを終わってから伝える。
//   ・移す前に 🕘 履歴のスナップショットを取る（Koto 自身の安全網。
//     利用者は「元に戻す」で丸ごと戻せる）。
//   ・移すのは**公開されるものだけ**。素材・Koto の内部・README は直下に残す。
//   ・**途中で失敗したら、そこで止めて元へ戻す**（半分だけ移った状態を残さない）。
//
// 判断（何が公開されるか）は publishExclude.ts に任せる。ここは並べ替えるだけ。

import { PUBLISH_DIR, PUBLISH_DIR_LABEL, shouldMove } from './publishRoot'

/** プロジェクト直下の1件（呼び出し側が readdir した結果）。 */
export type Entry = { name: string; isDir: boolean }

/** 移行の計画。 */
export type MigratePlan = {
  /** `public/` へ移す名前（プロジェクト直下からの相対）。 */
  move: string[]
  /** 直下に残す名前（利用者へ見せるため）。 */
  keep: string[]
}

/**
 * 移行の計画を立てる。
 *
 * @param entries       プロジェクト直下の一覧
 * @param isPublishedOf `isPublished(name, isDir)` を返す関数（publishExclude の一元定義）
 */
export function planMigrate(
  entries: readonly Entry[],
  isPublishedOf: (name: string, isDir: boolean) => boolean,
): MigratePlan {
  const move: string[] = []
  const keep: string[] = []
  for (const e of entries ?? []) {
    if (!e || !e.name) continue
    if (shouldMove(e.name, isPublishedOf(e.name, e.isDir))) move.push(e.name)
    else keep.push(e.name)
  }
  return { move, keep }
}

/** すでに移行済みか（フォルダがある）。 */
export function alreadyMigrated(entries: readonly Entry[]): boolean {
  return (entries ?? []).some(e => e?.name === PUBLISH_DIR && e.isDir)
}

/** 移す必要があるか。**移すものが1つも無いなら、案内も出さない**（空のフォルダだけ作らない）。 */
export function needsMigration(entries: readonly Entry[]): boolean {
  if (alreadyMigrated(entries)) return false
  return (entries ?? []).length > 0
}

/** 案内に出す文面（拒否はできないので、「何が起きるか」だけを書く）。 */
export function migrateNotice(plan: MigratePlan): string {
  const n = plan.move.length
  return [
    `このプロジェクトの形を新しくします。`,
    ``,
    `**「${PUBLISH_DIR_LABEL}」フォルダを作り、${n}件をその中へ移します。**`,
    `どれが公開されるのかが、ひと目で分かるようになります。`,
    ``,
    n > 0 ? `移すもの: ${plan.move.join(' / ')}` : `移すものはありません（フォルダだけ作ります）。`,
    plan.keep.length > 0 ? `そのまま残すもの: ${plan.keep.join(' / ')}` : '',
    ``,
    `移す前の状態は **🕘 履歴** に残るので、あとから元に戻せます。`,
  ].filter(l => l !== '').join('\n')
}

/** 終わったあとに伝える文面。**黙って終わらせない**。 */
export function migrateDone(plan: MigratePlan): string {
  if (plan.move.length === 0) return `「${PUBLISH_DIR_LABEL}」フォルダを作りました。ここに入れたものがサーバーへ行きます。`
  return `「${PUBLISH_DIR_LABEL}」へ${plan.move.length}件を移しました（${plan.move.join(' / ')}）。`
    + `\nここに入れたものが、そのままサーバーへ行きます。元に戻すときは 🕘 履歴から。`
}

/** 失敗したときに伝える文面。**途中で止めて戻したことを必ず言う**。 */
export function migrateFailed(reason: string, restored: boolean): string {
  const head = `⚠️ フォルダの整理に失敗しました（${reason}）。`
  return restored
    ? head + '\n途中まで移したものは元へ戻しました。プロジェクトはそのまま使えます。'
    : head + '\n**元へ戻せませんでした。** 🕘 履歴から、この直前の状態に戻してください。'
}
