// チャット履歴のファイル保存（IDEプロジェクト別 / 単独チャットアプリ）先パスの組み立てと、
// 保存前のJSONバリデーションを担う純粋ロジック（electron 非依存・fs は path のみ・Vitest対象）。
//
// 保存先:
//   - IDEのプロジェクト別チャット: `<project>/.sakuraide/chat.json`
//   - 単独チャット（ChatApp）:     `<workspace>/.sakuraide/chats/chat-app.json`
// `.sakuraide/` はバックアップ・公開物・GitHub保存から除外する
// （envDetect.ts / github/enumerate.ts / ipc/fs.ts の SKIP_DIRS、cloud/imageBuild.ts の EXCLUDE_NAMES、
//   ipc/hanamii.ts の zip 除外に `.sakuraide-backup` と並べて追加してある）。
import * as path from 'path'

/** root 配下に閉じ込めたパスを組み立てる（ipc/backup.ts の confineToProject と同等の防御）。 */
function confineToRoot(root: string, relParts: string[]): string {
  // 末尾セパレータを除去してから比較する（'/a/b/' のようなルートで startsWith 判定が壊れないように）
  const normalizedRoot = path.normalize(root).replace(/[/\\]+$/, '')
  const full = path.normalize(path.join(normalizedRoot, ...relParts))
  if (full !== normalizedRoot && !full.startsWith(normalizedRoot + path.sep)) {
    throw new Error('不正なパスです（対象フォルダの外は操作できません）')
  }
  return full
}

/** IDEのプロジェクト別チャット履歴の保存先。 */
export function projectChatPath(projectDir: string): string {
  return confineToRoot(projectDir, ['.sakuraide', 'chat.json'])
}

/** 単独チャット（ChatApp）のセッション一覧の保存先。 */
export function appChatPath(workspaceDir: string): string {
  return confineToRoot(workspaceDir, ['.sakuraide', 'chats', 'chat-app.json'])
}

/** 保存前のJSON妥当性チェック（空文字列・パース不能な文字列は不可）。 */
export function isValidJson(json: unknown): json is string {
  if (typeof json !== 'string' || json.length === 0) return false
  try {
    JSON.parse(json)
    return true
  } catch {
    return false
  }
}
