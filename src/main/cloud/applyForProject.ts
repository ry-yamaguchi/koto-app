// applyForProject.ts — 公開の apply（applyPlan）を、プロジェクトのフォルダつきで呼ぶ入口（ipc/cloud.ts の公開が使う）。
//
// ── なぜ切り出したか（2026-10-21）────────────────────────────────────────────────
// applyPlan の保存場所の削除（plan に bucket の delete があるとき）も、バケットごと消す前に**ほかのプロジェクトの記録**を読む
// （storageTeardown.ts の teardownStorage）。そのために applyPlan はプロジェクトのフォルダを要る（`projectDir`・必須）。
// 巨大な ipc/cloud.ts の中で applyPlan を呼ぶ節を、ここへ出した。**渡し忘れは型で止まる**（任意の引数にしない）。
// 一時的に発行した保存場所の鍵（adapter 自身の分）を片づけるのも、ここ。
import { applyPlan, type ApplyOptions, type ApplyResult } from './apply'

/** `ApplyOptions` と同じ（`projectDir` は必須）。`storage` を渡したら、呼び終えたあとに必ず `dispose()` する。 */
export type ApplyForProjectOptions = ApplyOptions & { storage?: ApplyOptions['storage'] & { dispose(): Promise<void> } }

/** applyPlan を呼び、終わったら（失敗しても）保存場所のアダプタが自分用に発行した一時キーを片づける。公開の結果は変えない。 */
export async function applyForProject(opts: ApplyForProjectOptions): Promise<ApplyResult> {
  try {
    return await applyPlan(opts)
  } finally {
    if (opts.storage) await opts.storage.dispose()
  }
}
