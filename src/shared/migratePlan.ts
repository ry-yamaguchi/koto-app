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

/**
 * 公開しないプロジェクトか（純関数）。
 *
 * ── なぜ要るか（2026-08-24 の実機・Ryosuke 指摘）──────────────────────
 * `public/` は「**サーバーへ置かれるもの**」を入れる場所である。
 * ローカルで動かすだけのもの（ゲーム・手元の道具）には、置く先が無い。
 * それなのに案内を出していたので、Unreal Engine のゲームで
 * `Source/` や `.uproject` まで `public/` へ移そうとしていた。**害のほうが大きい。**
 *
 * 公開先が決まっていない（`local`）・公開しない（`other`）ものでは、案内を出さない。
 * あとで公開先を選べば、そのとき案内が出る（機会は失われない）。
 */
export function skipMigrationForTarget(target: string | null | undefined): boolean {
  return target === 'local' || target === 'other'
}

/**
 * 移す必要があるか。**移すものが1つも無いなら、案内も出さない**（空のフォルダだけ作らない）。
 * `target` を渡すと、公開しないプロジェクトでは案内しない（`skipMigrationForTarget`）。
 *
 * ── 注意: ここは「プロジェクト直下に何かあるか」（件数）しか見ない ──────────────
 * 実際に**何を**移すか（`plan.move`）までは見ていない。`.sakuraide.json` のような
 * 隠しメタしか無い新規プロジェクトでも「要る」を返してしまう。案内を実際に出すかどうかの
 * 最終判定は `shouldOfferMigration`（plan まで見る）で行う。
 */
export function needsMigration(entries: readonly Entry[], target?: string | null): boolean {
  if (skipMigrationForTarget(target)) return false
  if (alreadyMigrated(entries)) return false
  return (entries ?? []).length > 0
}

/**
 * 移す提案を実際に出すか。**移すもの（`plan.move`）が1件も無いなら出さない。**
 *
 * ── なぜ `needsMigration` だけでは足りないか（2026-08-29・0.3.52 実機確認）────────
 * `needsMigration` はプロジェクト直下の**件数**だけで判定するため、`.sakuraide.json`
 * （隠しメタ・公開対象ではない）しか無い新規プロジェクトでも「要る」と判定してしまう。
 * このとき実際に移すもの（plan.move）は0件なのに、案内は「0件をその中へ移します」と
 * 出てしまっていた（改善1-3）。ここで plan（実際に何を移すか）まで見て、0件なら出さない。
 *
 * 既に `public/` があるプロジェクトでは `needsMigration` の時点で false になっているので
 * ここへは来ない＝既存プロジェクトの動きは変えない（影響は「public/ の無い空プロジェクト」だけ）。
 */
export function shouldOfferMigration(plan: MigratePlan): boolean {
  return plan.move.length > 0
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
