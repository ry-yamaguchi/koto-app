// チャット履歴のファイル保存（IPC chat:*）の読み書きと、旧 localStorage 形式からの移行を担う。
// 優先順位判定などの純粋ロジックは chatMigration.ts に分離してある（ここは IO のみ）。
// 送信ロジック（useAiChat.ts）には触れない。ChatPanel/ChatApp から呼ばれる薄い永続化層（掟7の範囲内）。
import type { ChatMessage } from './hooks/useAiChat'
import { getWorkspaceDir } from './workspace'
import { parseJsonArray, resolveChatSource } from './chatMigration'
import { rescueTargets, withoutImages, droppedNote, stampOf } from '../shared/chatImages'
import { MATERIALS_DIR } from '../shared/publishExclude'

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

/** 保存の結果。**画像を落としたときは、それを呼び出し側へ必ず返す**（画面で伝えるため）。 */
export type SaveAppResult =
  | { ok: true }
  /** 保存はできたが、**画像を落とした**。note を画面に出すこと。 */
  | { ok: true; droppedImages: number; note: string }
  | { ok: false; message: string }

/**
 * 単独チャット（ChatApp）のセッション一覧を保存する。
 *
 * ── 画像を落とすときの決まり（2026-08-20 実測で作り直した）────────────────
 * 以前は、保存に失敗すると**全セッションの画像を黙って落として**保存し直し、
 * console.warn を出すだけだった。「画像を使う」を押していない画像は**ここにしか無い**ので、
 * 利用者は次に開いたとき、理由も分からないまま画像を失っていた。
 *
 * いまは **①先にファイルへ書き出して助ける ②落としたことを返して画面に出す** の順で行う。
 */
export async function saveAppSessions(workspaceDir: string, sessions: any[]): Promise<SaveAppResult> {
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
  if (first.ok) return { ok: true }

  // ここから先は「画像を落とさないと保存できない」状態。**落とす前に助ける。**
  const stamp = stampOf(new Date())
  const targets = rescueTargets(cleaned, stamp)
  let saved = 0
  for (const t of targets) {
    try {
      // ワークスペース直下の「素材（公開しません）」へ書き出す（公開物には入らない場所）。
      const r = await window.electronAPI.fs.importImageData(workspaceDir, t.name, t.url, 'material')
      if (r?.ok) saved++
    } catch { /* 1枚失敗しても続ける（助けられた分は助ける） */ }
  }

  const second = await trySave(withoutImages(cleaned))
  if (!second.ok) {
    const message = second.message ?? first.message ?? '保存に失敗しました'
    console.warn('[chatStorage] チャット履歴の保存に失敗しました:', message)
    return { ok: false, message }
  }
  if (targets.length === 0) return { ok: true }
  return { ok: true, droppedImages: targets.length, note: droppedNote(saved, targets.length, MATERIALS_DIR) }
}
