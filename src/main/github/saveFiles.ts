// saveFiles.ts — GitHub保存で保存されるファイルの一覧（main 側）。
// 保存と、保存の窓から押す点検が、同じ一覧を使う。

import * as path from 'path'
import * as fs from 'fs'
import { partitionEntries, isSkippedDirName, isSkippedFileName, type EnumerateEntry, type EnumerateResult } from './enumerate'

// プロジェクト内のファイルを列挙する（node_modules 等の除外＋ .env系除外＋ 5MB超過除外は
// partitionEntries が担当。ここではディレクトリ走査のみを行う）。
// 上限は envDetect.ts / fs.ts と同じ（深さ8・最大2000ファイル）。
function walkProjectFiles(projectDir: string): EnumerateEntry[] {
  const MAX_FILES = 2000
  const entries: EnumerateEntry[] = []
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 8 || entries.length >= MAX_FILES) return
    let dirents: fs.Dirent[]
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of dirents) {
      if (entries.length >= MAX_FILES) return
      const full = path.join(dir, ent.name)
      const relPath = rel + ent.name
      if (ent.isDirectory()) {
        if (isSkippedDirName(ent.name)) continue
        walk(full, relPath + '/', depth + 1)
      } else if (ent.isFile()) {
        if (isSkippedFileName(ent.name)) continue
        let size = 0
        try { size = fs.statSync(full).size } catch { continue }
        entries.push({ rel: relPath, sizeBytes: size })
      }
    }
  }
  walk(projectDir, '', 0)
  return entries
}

/** GitHub保存で保存されるファイル（included）と、保存から外すファイル（excluded）。 */
export function githubSaveFilesFs(projectDir: string): EnumerateResult {
  return partitionEntries(walkProjectFiles(projectDir))
}
