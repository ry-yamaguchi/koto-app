// projectLock.ts — 同じプロジェクトで、作成・削除・公開を同時に走らせない（main の歯止め）。
//
// ── なぜ要るか（H-1・2026-09-17。横断点検の6視点のうち4つが独立にここへ収束した）──────
// ⑥「すべて削除する」は実測で約9分かかる。そのあいだ⑧「公開する」が押せてしまうと:
//
//   ・破棄がロードバランサを消している最中に公開すると、公開はその場で記録を読み直すが
//     clusterID 等がまだ残っているため通過し、**消えかけのクラスタに新しいアプリを作って**
//     applicationID を記録する。破棄は先頭で読んだ記録のまま進み、最後に clusterID だけを
//     null にする。結果 **applicationID があるのに clusterID が無い**記録が残り、
//     次に⑥を押しても「クラスタのIDが記録にありません」で止まる＝**Koto からは二度と消せない**
//   ・アプリの段に割り込めば、破棄が無効にしたアプリを公開が作り直して有効化するので、
//     削除が 400 を繰り返して**破棄そのものが失敗する**（月額およそ2万2千円が止まらない）
//
// ── なぜ画面のフラグだけでは足りないか ────────────────────────────────────────
// 画面の `tearingDown` / `publishing` は**窓が持っている状態**でしかない。
// **破棄の最中に窓を再読み込みするとフラグが消え**、main 側の破棄だけが走り続ける。
// そこへ⑧を押せば同じ交錯が起きる。だから main にも歯止めを置く。
//
// ── `markPendingFs` を流用しないこと ──────────────────────────────────────────
// あれは「途中で落ちたときのための印」であって鍵ではない。落ちたあとも残るので、
// 鍵として使うと「二度と押せない」になる。ここは**プロセスの寿命だけ**の印にする。

/** いま走っている操作（画面に出す日本語そのもの）。 */
export type ProjectOp = '作成' | '削除' | '公開'

/** projectDir → いま走っている操作。プロセスが終われば消える（ファイルに残さない）。 */
const running = new Map<string, ProjectOp>()

/**
 * 断るときの文面（純関数）。**何が走っているかを名指しする**——
 * 「いま使えません」だけでは、壊れているのと区別がつかない。
 */
export function projectBusyMessage(op: ProjectOp): string {
  return `いま別の操作（${op}）を実行中です。終わってからもう一度お試しください。`
}

/** いま走っている操作（テストと診断のため。走っていなければ undefined）。 */
export function runningOp(projectDir: string): ProjectOp | undefined {
  return running.get(projectDir)
}

/**
 * 同じ `projectDir` で作成・削除・公開が同時に走らないようにして `fn` を実行する。
 *
 * - すでに走っていれば `fn` を**呼ばず**に `{ busy: true, running }` を返す
 * - 走っていなければ `fn` を実行し、`{ busy: false, value }` を返す
 * - **`fn` が例外を投げても必ず印を外す**（外れないと「二度と押せない」になる。
 *   それは無効化より悪い）
 * - 別の `projectDir` どうしは互いに影響しない
 */
export async function withProjectLock<T>(
  projectDir: string,
  op: ProjectOp,
  fn: () => Promise<T>,
): Promise<{ busy: true; running: ProjectOp } | { busy: false; value: T }> {
  const current = running.get(projectDir)
  if (current) return { busy: true, running: current }
  running.set(projectDir, op)
  try {
    return { busy: false, value: await fn() }
  } finally {
    running.delete(projectDir)
  }
}
