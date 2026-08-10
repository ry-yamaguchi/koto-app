// envDetect.ts — プロジェクト内のソースから環境変数の参照キーを検出する純ロジック（electron 非依存・fs のみ）。HANAMII 公開パネルの候補表示用。

import * as fs from 'fs'
import * as path from 'path'

// プロジェクト内のソースから環境変数の参照キーを検出する（HANAMII 環境変数の候補表示用）。
// 依存の無い純粋な走査。node_modules 等は除外し、テキスト系ファイルのみを対象に既知のパターンで拾う。
// 値は一切読まず、キー名のみを返す（PORT など基盤が自動管理する変数は除外）。
export function detectEnvKeysInProject(projectDir: string): string[] {
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'out', '.sakuraide-backup', '.sakuraide', '.sakura-cloud', '.vscode', 'vendor', '__pycache__'])
  const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.php', '.go', '.rb', '.java'])
  const AUTO_MANAGED = new Set(['PORT'])
  const MAX_FILES = 2000
  const MAX_BYTES = 512 * 1024
  const patterns: RegExp[] = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
    /os\.environ(?:\.get)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /os\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
    /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
    /\$_ENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  ]
  const dotenvLine = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm
  const keys = new Set<string>()
  let scanned = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || scanned >= MAX_FILES) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (scanned >= MAX_FILES) return
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(full, depth + 1)
      } else if (ent.isFile()) {
        if (ent.name === '.hanamii-static.js') continue // 自動同梱の静的サーバは対象外
        const isDotenv = ent.name === '.env' || ent.name.startsWith('.env.')
        const ext = path.extname(ent.name).toLowerCase()
        if (!isDotenv && !EXTS.has(ext)) continue
        let size = 0
        try { size = fs.statSync(full).size } catch { continue }
        if (size > MAX_BYTES) continue
        let text: string
        try { text = fs.readFileSync(full, 'utf8') } catch { continue }
        scanned++
        if (isDotenv) {
          dotenvLine.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = dotenvLine.exec(text))) keys.add(m[1])
        } else {
          for (const re of patterns) {
            re.lastIndex = 0
            let m: RegExpExecArray | null
            while ((m = re.exec(text))) keys.add(m[1])
          }
        }
      }
    }
  }
  try { walk(projectDir, 0) } catch { /* ignore */ }
  for (const k of AUTO_MANAGED) keys.delete(k)
  return Array.from(keys).sort()
}
