// チャット履歴のファイル保存（IPC chat:*）の読み書きと、旧 localStorage 形式からの移行を担う。
// 優先順位判定などの純粋ロジックは chatMigration.ts に分離してある（ここは IO のみ）。
// 送信ロジック（useAiChat.ts）には触れない。ChatPanel/ChatApp から呼ばれる薄い永続化層（掟7の範囲内）。
import type { ChatMessage } from './hooks/useAiChat'
import { getWorkspaceDir } from './workspace'
import { parseJsonArray, resolveChatSource } from './chatMigration'

const LEGACY_PROJECT_PREFIX = 'sakura_chat:'
const LEGACY_APP_KEY = 'sakura_sessions'

/** IDEのプロジェクト別チャット履歴を読み込む（ファイル優先→localStorage移行→空）。 */
export async function loadProjectChat(projectDir: string): Promise<ChatMessage[]> {
  let fileData: ChatMessage[] | null = null
  try {
    const res = await window.electronAPI.chat.loadProject(projectDir)
    if (res.ok) fileData = parseJsonArray(res.json) as ChatMessage[] | null
  } catch { /* IPC失敗はlocalStorageへフォールバック */ }

  const legacyKey = LEGACY_PROJECT_PREFIX + projectDir
  const legacyData = parseJsonArray(localStorage.getItem(legacyKey)) as ChatMessage[] | null
  const resolved = resolveChatSource<ChatMessage>(fileData, legacyData)

  if (resolved.kind === 'file') return resolved.data
  if (resolved.kind === 'migrate') {
    void saveProjectChat(projectDir, resolved.data) // 即ファイルへ移行
    localStorage.removeItem(legacyKey)
    return resolved.data
  }
  return []
}

/**
 * 保存用にメッセージを整える（純粋関数・テスト対象）。
 * 推論モデルの「思考」（thinking）は表示専用で、本文の何倍にもなることがあるため保存しない
 * （2026-08-03。保存すると chat.json が肥大し、読み込み・GitHub保存にも響く）。
 */
export function forStorage(messages: ChatMessage[]): ChatMessage[] {
  return (messages ?? []).map(m => {
    if (!m || m.thinking === undefined) return m
    const { thinking, ...rest } = m
    return rest
  })
}

/** IDEのプロジェクト別チャット履歴を保存する。失敗は握りつぶさず console.warn する。 */
export async function saveProjectChat(projectDir: string, messages: ChatMessage[]): Promise<void> {
  let json: string
  try {
    json = JSON.stringify(forStorage(messages))
  } catch (e) {
    console.warn('[chatStorage] チャット履歴の直列化に失敗しました:', e)
    return
  }
  try {
    const res = await window.electronAPI.chat.saveProject(projectDir, json)
    if (!res.ok) console.warn('[chatStorage] チャット履歴の保存に失敗しました:', res.message)
  } catch (e) {
    console.warn('[chatStorage] チャット履歴の保存に失敗しました:', e)
  }
}

/**
 * 単独チャット（ChatApp）のセッション一覧を読み込む（ファイル優先→localStorage移行→未取得=null）。
 * 未取得（kind: 'empty'）の場合、呼び出し側は初期状態（新規セッション1件）をそのまま使ってよい。
 */
export async function loadAppSessions<T = any>(): Promise<{ workspaceDir: string; sessions: T[] | null }> {
  const workspaceDir = await getWorkspaceDir()

  let fileData: T[] | null = null
  try {
    const res = await window.electronAPI.chat.loadApp(workspaceDir)
    if (res.ok) fileData = parseJsonArray(res.json) as T[] | null
  } catch { /* IPC失敗はlocalStorageへフォールバック */ }

  const legacyData = parseJsonArray(localStorage.getItem(LEGACY_APP_KEY)) as T[] | null
  const resolved = resolveChatSource<T>(fileData, legacyData)

  if (resolved.kind === 'file') return { workspaceDir, sessions: resolved.data }
  if (resolved.kind === 'migrate') {
    void saveAppSessions(workspaceDir, resolved.data as any[]) // 即ファイルへ移行
    localStorage.removeItem(LEGACY_APP_KEY)
    return { workspaceDir, sessions: resolved.data }
  }
  return { workspaceDir, sessions: null }
}

/**
 * 単独チャット（ChatApp）のセッション一覧を保存する。画像でサイズ超過した場合は画像を落として再試行する
 * （旧 localStorage 実装の QuotaExceeded 対策と同じ考え方を踏襲）。失敗は握りつぶさず console.warn する。
 */
export async function saveAppSessions(workspaceDir: string, sessions: any[]): Promise<void> {
  const trySave = async (payload: any[]): Promise<{ ok: boolean; message?: string }> => {
    let json: string
    try {
      json = JSON.stringify(payload)
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) }
    }
    try {
      return await window.electronAPI.chat.saveApp(workspaceDir, json)
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) }
    }
  }

  // 思考（thinking）は表示専用なので保存しない（forStorage と同じ理由。ChatApp はセッション構造のため個別に落とす）
  const cleaned = sessions.map((s: any) => ({
    ...s,
    messages: Array.isArray(s.messages) ? forStorage(s.messages) : s.messages,
  }))

  const first = await trySave(cleaned)
  if (first.ok) return

  const slim = cleaned.map((s: any) => ({
    ...s,
    messages: Array.isArray(s.messages) ? s.messages.map((m: any) => (m.images ? { ...m, images: undefined } : m)) : s.messages,
  }))
  const second = await trySave(slim)
  if (!second.ok) console.warn('[chatStorage] チャット履歴の保存に失敗しました:', second.message ?? first.message)
}
