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
// ── 通す範囲（2026-09-29 に広げた）──────────────────────────────────────────
// 最初は専有型（apprunDedicated.ts）だけだった。共用型（cloud:apply・cloud:teardown）・
// HANAMII（hanamii:publish・hanamii:teardown）・Vercel（vercel:publish）には無く、
// **処理中に公開ダイアログを閉じて開き直し、もう一度「公開」を押すと二重に走った**
// （公開の本体は main の1回の IPC で最後まで進むので、窓を閉じても止まらない）。
// HANAMII は projectId を保存する前（初回の公開の最中）に二重に走ると、プロジェクトが二重に作られる。
// 定義はこのファイル1か所（複製しない・掟10）。どのハンドラも、**`markPendingFs` より外側**で鍵を取る
// （断られた側が、走っている公開の印を後始末の finally で消さないため）。
// 「いま走っているか」は publishMeta:runningOp で画面へ伝え、「中断された可能性」の誤表示を防ぐ
// （src/renderer/publishStatus.ts の judgePendingPublish）。
//
// ── `markPendingFs` を流用しないこと ──────────────────────────────────────────
// あれは「途中で落ちたときのための印」であって鍵ではない。落ちたあとも残るので、
// 鍵として使うと「二度と押せない」になる。ここは**プロセスの寿命だけ**の印にする。

import { beginOp, finishOp, runningOpName, type ProjectOp, type OpMeta } from './projectOps'

/** いま走っている操作（画面に出す日本語そのもの）。定義は projectOps.ts（記録と同じ場所）。 */
export type { ProjectOp } from './projectOps'

// ── 鍵は「記録」そのもの（2026-09-29）────────────────────────────────────────
// 以前はここに `Map<projectDir, ProjectOp>` を持っていた。いまは**走っている操作の記録**
// （projectOps.ts の `live`）が鍵を兼ねる: 記録が1つ入っていれば、そのプロジェクトは使用中。
// 「走っているか」と「何が起きているか」を**2か所で持たない**（掟10）。鍵を取るとき始まりを、
// 抜けるとき（成功でも例外でも）終わりを、ここが自動で書く——9本のハンドラが**同じ道**で記録される。
//
// **鍵はプロジェクト単位**（公開先をまたいでも、同じプロジェクトなら1つずつ）。
// `.sakuraide.json` の publish.pending（開始マーカー）・`.sakura-cloud/` の記録・koto-data の置き直しは
// どれもプロジェクトに1つで、公開先ごとに分かれていない。公開先ごとに鍵を分けると、
// たとえば HANAMII と Vercel を同時に走らせて、先に終わったほうが**もう一方の印を消す**。

/**
 * 断るときの文面（純関数）。**何が走っているかを名指しする**——
 * 「いま使えません」だけでは、壊れているのと区別がつかない。
 */
export function projectBusyMessage(op: ProjectOp): string {
  return `いま別の操作（${op}）を実行中です。終わってからもう一度お試しください。`
}

/** いま走っている操作（画面へは publishMeta:runningOp と projectOps:get が同じ記録から答える。走っていなければ undefined）。 */
export function runningOp(projectDir: string): ProjectOp | undefined {
  return runningOpName(projectDir)
}

/**
 * 同じ `projectDir` で作成・削除・公開が同時に走らないようにして `fn` を実行する。
 *
 * - すでに走っていれば `fn` を**呼ばず**に `{ busy: true, running }` を返す（記録も作らない）
 * - 走っていなければ、**始まりを記録**して `fn` を実行し、`{ busy: false, value }` を返す。
 *   終わりと結果（`value` のうち画面に出すもの）も自動で記録する（projectOps.ts の `summarizeResult`）
 * - **`fn` が例外を投げても必ず印を外す**（外れないと「二度と押せない」になる。
 *   それは無効化より悪い）。例外はそのまま投げ直す
 * - 別の `projectDir` どうしは互いに影響しない
 *
 * `meta` は記録のためのもの（どの公開先か・どの IPC か・引数で受け取った秘密）。
 * **型では必須**——渡し忘れると本体が通らない。テストだけが省ける（target は 'unknown' になる）。
 */
export async function withProjectLock<T>(
  projectDir: string,
  op: ProjectOp,
  fn: () => Promise<T>,
  meta: OpMeta,
): Promise<{ busy: true; running: ProjectOp } | { busy: false; value: T }> {
  const current = runningOpName(projectDir)
  if (current) return { busy: true, running: current }
  beginOp(projectDir, op, meta)
  let outcome: { value: unknown } | { error: unknown } = { error: new Error('中断されました') }
  try {
    const value = await fn()
    outcome = { value }
    return { busy: false, value }
  } catch (e) {
    outcome = { error: e }
    throw e
  } finally {
    finishOp(projectDir, outcome)
  }
}
