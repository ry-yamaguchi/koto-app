// claudeSession.ts — Claude頭脳モードの「会話の続き」をアプリ再起動・プロジェクト再オープンをまたいで
// 保てるようにするための、セッションIDの永続化ヘルパー（純粋・IO は localStorage のみ）。
//
// 背景（所見10・2026-07-12 総点検）: これまで Claude のセッションID（Agent SDK の session_id）は
// useAiChat.ts の useRef にしか無く、再起動やプロジェクト切替で失われていた。一方チャット履歴は
// .sakuraide/chat.json に残り画面へ復元されるため、「画面には前回の会話が見えるのに Claude は何も
// 覚えていない」という食い違いが起きていた。プロジェクトごとに最後の session_id を保存し、次回起動時に
// resume（再開）へ渡すことで続きを扱えるようにする。
// ※ 保存した session_id が失効・不在で復元に失敗した場合は、main 側 agent.ts が resume 無しの新規
//   セッションで1回だけ自己修復リトライするため、行き止まりにはならない。

/** プロジェクトごとのセッションID保存キーの接頭辞。値は Agent SDK の session_id 文字列。 */
const CLAUDE_SESSION_KEY_PREFIX = 'sakura_claude_session:'

function keyFor(projectDir: string): string {
  return `${CLAUDE_SESSION_KEY_PREFIX}${projectDir}`
}

/** 指定プロジェクトの保存済みセッションIDを返す（無ければ null）。 */
export function getClaudeSessionId(projectDir: string | null | undefined): string | null {
  if (!projectDir) return null
  try {
    const v = localStorage.getItem(keyFor(projectDir))
    return v && v.trim() ? v : null
  } catch {
    return null
  }
}

/** 指定プロジェクトのセッションIDを保存する（id が空なら保存済みを削除する）。 */
export function setClaudeSessionId(projectDir: string | null | undefined, id: string | null | undefined): void {
  if (!projectDir) return
  try {
    if (id && id.trim()) localStorage.setItem(keyFor(projectDir), id)
    else localStorage.removeItem(keyFor(projectDir))
  } catch {
    /* localStorage 不可時は継続不能でも致命ではないので無視（メモリ上の ref は従来どおり動く） */
  }
}
