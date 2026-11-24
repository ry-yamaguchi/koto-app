// unusedImagesTrash.ts — 「🗑 使っていない画像をゴミ箱へ」の移す側（P-137）。
//
// 見た目のチェック（main の findSiteIssues）が返す名前（unusedFiles）は、**公開の根からの相対**
// （`public/` があればその中、無ければプロジェクト直下。resolvePublishRoot が決める。掟10）。
// 移す先も同じ根の下にする。プロジェクト直下へつなぐと、public/ があるプロジェクトでは1件も見つからず、
// 直下に同じ名前の別のファイル（公開されないもの）があれば、それを移してしまう。
// 絶対パス・`..` を含む・根の外を指す名前は移さず、移せなかった名前に数える。

import { resolvePublishRoot } from './publishRootRenderer'

/** 公開の根の下に収まる相対パスか（絶対パス・`..` の段・空・NUL を含むものは外を指しうるので不可）。 */
export function isInsideRoot(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel.trim() === '' || rel.includes('\0')) return false
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel) || rel.startsWith('~')) return false
  const segs = rel.split(/[\\/]+/)
  if (segs.some(s => s === '..')) return false
  return segs.some(s => s !== '' && s !== '.')
}

/**
 * `files`（公開の根からの相対）を、公開の根の下から1件ずつゴミ箱へ移す。移せなかった名前（外を指す・移すのに失敗した）を返す。
 * 根は1回だけ決める（途中で public/ が現れても、同じ一覧の中で根を変えない）。
 * `checkedRoot` は、一覧を作った見た目のチェックの時点で決めた根。渡されたらそれを使う
 * （チェックの後に public/ ができたり消えたりしても、古い一覧の名前を別の根の下へ当てない）。
 * なお一覧を作る findSiteIssues は、シンボリックリンクをたどらない（Dirent が isFile/isDirectory のどちらでもない）ので、
 * リンク経由の名前は一覧に入らない。
 */
export async function trashUnusedImages(projectDir: string, files: string[], checkedRoot?: string): Promise<string[]> {
  const failed: string[] = []
  const root = checkedRoot || await resolvePublishRoot(projectDir)
  for (const rel of files) {
    if (!root || !isInsideRoot(rel)) { failed.push(rel); continue }
    try { await window.electronAPI.fs.trash(`${root}/${rel}`) } catch { failed.push(rel) }
  }
  return failed
}
