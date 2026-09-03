// appChatDirs.ts — 単独チャット（ChatApp）のセッション置き場の一元定義（B'-3e-a・純関数のみ）。
//
// ── なぜ一元化するか（掟10）────────────────────────────────────────────
// ChatApp の各セッションは、convStore.ts（プロジェクト別チャットの持ち主）へ「擬似的な
// プロジェクトフォルダ」を渡すことで、そのまま同じ実装（追記式 chat.json v2・デバウンス保存・
// quit時フラッシュ）を再利用する（複製ゼロ）。この「擬似 dir をどう組み立てるか」と
// 「IPC 越しに渡ってくる sessionId を信用してよいか」を1箇所に集める。複製すると片方だけ
// 直され、抜けても誰も気づかない。
//
// electron に依存しない（node の Vitest から直接テストできる）。
// ⚠️ node の `path` も import しない: shared は renderer からも import され、vite は node 組み込みを
// 空の shim にするため、`path.join` が実行時に (void 0) is not a function で死ぬ（2026-09-02 実測・
// ChatApp が起動できなかった）。区切りは '/' の文字列連結で組む（publishRoot.ts と同じ流儀）。
// この決まりは tests/appChatDirs.test.ts が src/shared 全体に対して固定している。

/**
 * 単独チャットの置き場フォルダ名。`workspaceDir`（プロジェクトの親・例 `~/SAKURAIDE`）直下、
 * 既存の appChatPath（`<workspace>/.sakuraide/chats/chat-app.json`）の隣に置く新フォルダ。
 *
 * ドット始まりで隠す（**公開物に混ざらない場所**であること）。workspaceDir 自体はどのプロジェクトの
 * 公開物にも含まれない（publishExclude.ts はプロジェクトフォルダ配下だけを見る）ため、
 * この位置に置くこと自体が「混ざらない」ことの理由になる。ドット始まりにするのは、
 * Finder 等の通常表示や `ls` で目に入らないようにする慣習（`.sakuraide-backup` と同じ作法）。
 */
export const APP_CHAT_DIRNAME = '.sakuraide-app-chat'

/**
 * セッション1件の「擬似 dir」（convStore.loadConversation/applyConversationOps などへ
 * `projectDir` として渡す文字列）。実体は `<戻り値>/.sakuraide/chat.json`（v2 追記式）に
 * convStore がそのまま書く。
 */
export function sessionDir(workspaceDir: string, sessionId: string): string {
  return `${workspaceDir}/${APP_CHAT_DIRNAME}/sessions/${sessionId}`
}

/**
 * sessionDir() の逆関数（B'-3e-b）: main（convStore.ts）が押し出す chat:applied の
 * dir（実体は convStore のキー文字列。projectDir というフィールド名だが ChatApp では
 * セッション擬似 dir が入る）が、このワークスペースのどのセッションの擬似 dir かを判定する。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────
 * ChatApp は main が書き主になったことで chat:applied を購読する（ChatPanel と同じ
 * B-1a パターン）。ただし ChatPanel は「dir === projectDir」の単純比較で済むのに対し、
 * ChatApp は複数セッションを同時に持つため「この dir はどのセッションのものか」を
 * 逆算する必要がある。組み立て（sessionDir）と判定を同じファイルに集約する（掟10）。
 *
 * @returns 一致するセッションIDがあればそれ。ワークスペース不一致・セッション直下ではない
 *  形（ネストしすぎ・空）なら null。
 */
export function sessionIdFromDir(workspaceDir: string, dir: string): string | null {
  const prefix = `${workspaceDir}/${APP_CHAT_DIRNAME}/sessions/`
  if (!dir.startsWith(prefix)) return null
  const rest = dir.slice(prefix.length)
  return isValidSessionId(rest) ? rest : null
}

/** セッション索引（id/title/model/createdAt）の保存先。メッセージ本文は含めない。 */
export function sessionsIndexPath(workspaceDir: string): string {
  return `${workspaceDir}/${APP_CHAT_DIRNAME}/sessions.json`
}

/**
 * IPC 越しに渡ってくる sessionId の検証（掟10: 「守り」の一元化）。
 *
 * パス区切り（`/` `\`）・`..`・`.`・空文字を拒否する。これらを許すと、`sessionDir` が組み立てる
 * 擬似 dir が `workspaceDir` の外（例: `../../etc`）を指しかねない。sessionId は本来
 * `Date.now().toString()` のような単純な文字列（newSession() が作る）だが、IPC の引数は
 * renderer 側の型で守られないため、main 側（appSessionsStore.ts）が実際に使う前に必ずここを通す。
 */
export function isValidSessionId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0) return false
  if (id === '.' || id === '..') return false
  if (id.includes('/') || id.includes('\\')) return false
  return true
}

/**
 * IPC 越しに渡ってくる workspaceDir の検証（掟10: 「守り」の一元化・#16）。
 *
 * 空でない・NUL を含まない・`/` 始まりの絶対パス・パス区切りで分割したどのセグメントも
 * `..` ではない、を確かめる。sessionId と違い workspaceDir は「絶対パスであるべき」値
 * （相対パスを許すと、cwd 相対の思わぬ場所へ書く）。**なぜ守るか**: 実際に「相対パス
 * `"undefined"` が cwd 相対に書いた」事故があった（appSessionsStore.ts が workspaceDir を
 * 検証せずに使っていたため）。isValidSessionId と同じ流儀で、main 側が実際に使う前に
 * 必ずここを通す。
 */
export function isValidWorkspaceDir(dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir.length === 0) return false
  if (dir.includes('\0')) return false
  if (!dir.startsWith('/')) return false
  if (dir.split('/').includes('..')) return false
  return true
}
