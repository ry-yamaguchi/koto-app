// チャット履歴のファイル保存（IPC chat:*）の読み書きと、旧 localStorage 形式からの移行を担う。
// 優先順位判定などの純粋ロジックは chatMigration.ts に分離してある（ここは IO のみ）。
// 送信ロジック（useAiChat.ts）には触れない。ChatApp から呼ばれる薄い永続化層（掟7の範囲内）。
//
// ── B'-3c（プロジェクト別チャットの持ち主が main へ移った）─────────────────
// IDEのプロジェクト別チャット履歴の読み書き（loadProjectChat / saveProjectChat）はここから
// 消した。読み込みは src/renderer/chatConvClient.ts の loadConversationView、書き換えは
// makeConvClient の client.apply（ops として main の convStore.ts へ送る）に置き換わった
// （ChatPanel.tsx のみが使う）。単独チャット（ChatApp）は今回対象外で、このファイルの
// loadAppSessions / saveAppSessions がこれまでどおり持ち主のまま。
import { getWorkspaceDir } from './workspace'
import { parseJsonArray, resolveChatSource } from './chatMigration'
import { rescueTargets, withoutImages, droppedNote, stampOf } from '../shared/chatImages'
import { MATERIALS_DIR } from '../shared/publishExclude'
import { forStorage } from '../shared/chatStorage'

const LEGACY_APP_KEY = 'sakura_sessions'

// forStorage は shared（src/shared/chatStorage.ts）へ移した。convStore.ts（main）と
// ここ（ChatApp の保存）の両方が同じ「thinkingは保存しない」規則を使うため（2026-08-03 の決まり）。
// import 元を変えずに使えるよう re-export する。
export { forStorage }

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
