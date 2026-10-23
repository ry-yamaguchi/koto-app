// registryUsers.ts — あるコンテナレジストリを、ほかのどのプロジェクトが使っているか。**読むだけ**（外へ要求を出さない・何も書かない）。
//
// ── なぜ要るのか（2026-10-19）────────────────────────────────────────────────
// コンテナレジストリの接続情報は Koto 全体で1つ。記録の無いプロジェクトが公開すると、ほかのプロジェクトが作ったレジストリを借りる。
// 借りる側の破棄は「借り物」として既定オフにしてあるが、**借りられた側（作った側）の破棄は、これが無いと既定オンのまま**で、
// 消すと借りている全プロジェクトのイメージが消え、それらのアプリが動かなくなりうる（入口が逆なだけで、害は同じ）。
//
// ── どこまで見るか ───────────────────────────────────────────────────────────
// そのプロジェクトと同じ親フォルダの、直下のプロジェクトだけ（隠しフォルダは見ない。📡 公開したもの一覧の fs:publishedRecords と同じ歩き方）。
// 見るのは `.sakura-cloud/state.json` だけ。「使っている」と数えるのは、次の両方を満たすもの:
//   ・meta.registryName が、このレジストリの名前と完全に一致する
//   ・公開したアプリ（apprun-app）が1件以上ある … 消して動かなくなるのは、アプリ。名前を残しているだけ（アプリは破棄済み）のプロジェクトは数えない
// 読めない・壊れている記録は数えない（何を使っているか分からない）。
//
// **親フォルダの一覧そのものを読めなかったときは投げる**。空に倒すと「使っているプロジェクトは無い」と読んで、既定でオンの確認を出してしまう。
import * as fs from 'fs'
import * as path from 'path'
import { CLOUD_STATE_FILE, cloudFilePath } from './specStore'
import type { RegistryOrigin } from '../../shared/cloudCost'

/** `dir` のプロジェクトが、`registryName` のレジストリを、公開したアプリの置き場として記録しているか。 */
function recordsAppOnRegistry(dir: string, registryName: string): boolean {
  try {
    const st: unknown = JSON.parse(fs.readFileSync(cloudFilePath(dir, CLOUD_STATE_FILE), 'utf-8'))
    const meta = (st as { meta?: { registryName?: unknown } } | null)?.meta
    if (meta?.registryName !== registryName) return false
    const resources = (st as { resources?: unknown }).resources
    return Array.isArray(resources) && resources.some(r => (r as { kind?: unknown } | null)?.kind === 'apprun-app')
  } catch {
    return false // 記録が無い・壊れている
  }
}

/**
 * `projectDir` 以外で、`registryName` のレジストリを使っているプロジェクトの名前（フォルダ名）。名前順（文字コード順）。
 * 親フォルダの一覧を読めなかったときは、確認の文に出せる日本語の理由で投げる。
 */
export function otherProjectsUsingRegistry(projectDir: string, registryName: string): string[] {
  const self = path.resolve(projectDir)
  const workspace = path.dirname(self)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true })
  } catch (e) {
    throw new Error(`ほかのプロジェクトが同じコンテナレジストリを使っていないか、確かめられませんでした（${e instanceof Error ? e.message : String(e)}）`)
  }
  const users: string[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = path.join(workspace, e.name)
    if (dir === self) continue
    if (recordsAppOnRegistry(dir, registryName)) users.push(e.name)
  }
  return users.sort() // 文字コード順（実行する環境の言語設定で並びが変わらない）
}

/**
 * 破棄で**残すと選んだ**レジストリの事実（`cloud:teardown` の返り値の、名前の隣）。由来（owned／adopted／unknown）と、実行した時点で使っているほかのプロジェクト。
 * 結果の警告（shared/cloudCost.ts の `teardownRemainingWarnings`）は、これで「このプロジェクトだけのレジストリ」かを決め、そうでなければ月額の合計に入れず
 * 「後で消す場合は削除して」と言わない（借りたレジストリを言われたとおり消すと、ほかのアプリが動かなくなる）。
 * 親フォルダの一覧を読めなかったときは `keptRegistryUsers` を付けない（「いない」ではなく「分からない」。空に倒すと、借り物を「このプロジェクトだけ」と読む）。
 */
export function keptRegistryFacts(
  projectDir: string, registryName: string, origin: RegistryOrigin,
): { keptRegistryName: string; keptRegistryOrigin: RegistryOrigin; keptRegistryUsers?: string[] } {
  let users: string[] | null
  try { users = otherProjectsUsingRegistry(projectDir, registryName) } catch { users = null }
  return { keptRegistryName: registryName, keptRegistryOrigin: origin, ...(users ? { keptRegistryUsers: users } : {}) }
}
