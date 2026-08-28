// chatConvClient.ts — IDEのプロジェクト別チャットの renderer 側クライアント（B'-3c）。
//
// ── なぜ（土台の入れ替え その3c）─────────────────────────────────────
// 会話データの持ち主は main（src/main/chat/convStore.ts）へ移った。renderer（ChatPanel.tsx）は
// 「読み込む」（loadConversationView）と「書き換えを画面へ即時反映しつつ main へ ops として送る」
// （makeConvClient）の2つだけを持つ薄い層になる。ロジックの二重実装はしない
// （読み込みの優先順位判定は chatMigration.ts の resolveChatSource をそのまま使う。
//   今までの loadProjectChat と同じ手順）。
import type { ChatMessage } from './hooks/useAiChat'
import type { ChatEvent } from '../shared/chatEvents'
import { parseJsonArray, resolveChatSource } from './chatMigration'

const LEGACY_PROJECT_PREFIX = 'sakura_chat:'

/** 会話への書き換え1件。main の convStore.ts の Op と同じ形（IPCでそのまま運ぶ）。 */
export type Op = ChatEvent<ChatMessage> | { kind: 'replaceAll'; messages: ChatMessage[] }

/**
 * 読み込み（ファイル→無ければ旧localStorage移行→空）。
 * 移行時は replaceAll を送って main のストアへ載せ、旧キーを消す
 * （今までの loadProjectChat と同じ手順・resolveChatSource を使う）。
 */
export async function loadConversationView(projectDir: string): Promise<ChatMessage[]> {
  let fileData: ChatMessage[] | null = null
  try {
    const res = await window.electronAPI.chat.load(projectDir)
    if (res.ok) fileData = res.messages as ChatMessage[] | null
  } catch { /* IPC失敗はlocalStorageへフォールバック */ }

  const legacyKey = LEGACY_PROJECT_PREFIX + projectDir
  const legacyData = parseJsonArray(localStorage.getItem(legacyKey)) as ChatMessage[] | null
  const resolved = resolveChatSource<ChatMessage>(fileData, legacyData)

  if (resolved.kind === 'file') return resolved.data
  if (resolved.kind === 'migrate') {
    // 即 main のストアへ載せる（replaceAll）。以前の loadProjectChat と同じく await はしない
    // （旧キーの削除を待たせない。IPC失敗時は次回この関数を呼んだときにまた移行を試みる）。
    void window.electronAPI.chat.ops(projectDir, [{ kind: 'replaceAll', messages: resolved.data }])
    localStorage.removeItem(legacyKey)
    return resolved.data
  }
  return []
}

/**
 * 書き換え1件を「画面へ即時反映」しつつ「main へ ops として送る」クライアントを作る。
 *
 * ── なぜ送信を直列化するか ────────────────────────────────────────
 * main への chat:ops は IPC（非同期）。直列に送らないと、ストリーミングの差分
 * （replaceLast の連打）のように短い間隔で apply が連続したとき、後から送った ops が
 * 先に main へ届く可能性があり、保存される会話の順序が壊れる。前の invoke が返って
 * から次を送ることで、main への到着順を送った順と一致させる。
 */
export function makeConvClient(
  projectDir: string,
  applyLocal: (op: Op) => void,
): { apply(op: Op): void; idle(): Promise<void> } {
  // 送信キュー（Promiseチェーン）。1本の chain を使い回すことで直列化する。
  let chain: Promise<void> = Promise.resolve()

  return {
    apply(op: Op) {
      applyLocal(op) // 画面へは即時反映（main への往復を待たない）
      chain = chain
        .then(() => window.electronAPI.chat.ops(projectDir, [op]))
        .then(res => {
          if (!res.ok) console.warn('[chatConvClient] 書き換えの送信に失敗しました:', res.message)
        })
        .catch(e => {
          // IPC自体が失敗しても、画面は既に更新済み。次のデバウンス保存機会は無いが
          // （main が持ち主のため）、この1件を失うだけで会話全体は壊れない。
          console.warn('[chatConvClient] 書き換えの送信に失敗しました:', e)
        })
    },
    /** 送信の完了を待つ（プロジェクト切替時の取りこぼし防止・テスト用）。 */
    idle: () => chain,
  }
}
