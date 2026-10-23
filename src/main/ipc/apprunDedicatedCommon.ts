// apprunDedicatedCommon.ts — 専有型の IPC（作成・削除・公開）が共通で使う小さな部品（main）。
//
// ── なぜ別のファイルか ───────────────────────────────────────────────────────
// 削除（ipc/apprunDedicatedTeardown.ts）は ipc/apprunDedicated.ts から切り出したが、`isCreds` と `recordedZone` は
// 作成・公開も使う。main は tsc で CommonJS へ変換するので、2つのファイルが互いに require し合うと、先に評価される
// ほうが相手の export を undefined のまま受け取りうる（`zoneOf: recordedZone` のように関数を値で渡すと、ゾーンが
// 黙って記録されなくなる）。だから**両方が使うものはここへ置き、ここは ipc/apprunDedicated*.ts のどれも import しない**
// （向きは一方向。tests/dedicatedTeardownShell.test.ts と dedicatedTeardownEntriesF が固定する）。
import type { CloudCredentials } from '../cloud/auth'
import { readApprunDedicatedFs } from '../publishMetaFs'

/** renderer から渡された値が使える認証情報の形か（token/secretが非空の文字列か）。 */
export function isCreds(v: unknown): v is CloudCredentials {
  const c = v as any
  return !!c && typeof c.token === 'string' && typeof c.secret === 'string' && !!c.token && !!c.secret
}

/** このプロジェクトの記録にあるゾーン（段の所要時間を保存するとき、日付・版と一緒に残す。無ければ null）。 */
export function recordedZone(projectDir: string): string | null {
  try { return readApprunDedicatedFs(projectDir).zone ?? null } catch { return null }
}
