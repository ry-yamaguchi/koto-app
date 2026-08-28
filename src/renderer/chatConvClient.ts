// chatConvClient.ts — IDEのプロジェクト別チャットの renderer 側クライアント（B'-3c・B-1a）。
//
// ── なぜ（土台の入れ替え その3c）─────────────────────────────────────
// 会話データの持ち主は main（src/main/chat/convStore.ts）へ移った。renderer（ChatPanel.tsx）は
// 「読み込む」（loadConversationView）と「書き換えを main へ ops として送る」（makeConvClient）
// の2つだけを持つ薄い層になる。ロジックの二重実装はしない（読み込みの優先順位判定は
// chatMigration.ts の resolveChatSource をそのまま使う。今までの loadProjectChat と同じ手順）。
//
// ── B-1a: makeConvClient はもう画面へ反映しない ─────────────────────────
// 以前は「画面へ即時反映」も兼ねていたが、それが main のターンの出来事とは別の「もう1本の
// 画面更新経路」になっており、ターン中のプロジェクト切替で誤配する原因だった。画面への反映は
// main（convStore.ts）が押し出す chat:applied（ChatPanel.tsx が購読）に一本化した。
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
 * 書き換え1件を「main へ ops として送る」クライアントを作る。
 *
 * ── B-1a: 画面への反映はもうここではやらない ─────────────────────────────
 * 以前はここで「画面へ即時反映」と「main へ ops 送信」の両方をやっていたが、それが
 * 「会話の書き換え経路」とは別に「画面の更新経路」をもう1本作ってしまい、main のターンの
 * 出来事（もう1本の更新経路）と合わせて2経路になっていた——ターン中にプロジェクトを
 * 切り替えると、走っているターンの吹き出しが切り替え先の画面に誤配される原因（B-1a が直す不具合）。
 * ここは ops を送るだけにし、画面への反映は main（convStore.ts）が「当てた結果」を
 * 押し出す chat:applied（ChatPanel.tsx が購読）に一本化する。main への往復は数msなので
 * 体感の遅れはない。
 *
 * ── なぜ送信を直列化するか ────────────────────────────────────────
 * main への chat:ops は IPC（非同期）。直列に送らないと、ストリーミングの差分
 * （replaceLast の連打）のように短い間隔で apply が連続したとき、後から送った ops が
 * 先に main へ届く可能性があり、保存される会話の順序が壊れる。前の invoke が返って
 * から次を送ることで、main への到着順を送った順と一致させる。
 */
export function makeConvClient(
  projectDir: string,
): { apply(op: Op): void; idle(): Promise<void> } {
  // 送信キュー（Promiseチェーン）。1本の chain を使い回すことで直列化する。
  let chain: Promise<void> = Promise.resolve()

  return {
    apply(op: Op) {
      chain = chain
        .then(() => window.electronAPI.chat.ops(projectDir, [op]))
        .then(res => {
          if (!res.ok) console.warn('[chatConvClient] 書き換えの送信に失敗しました:', res.message)
        })
        .catch(e => {
          // IPC自体が失敗しても、main が持ち主のため次のデバウンス保存機会は無いが、
          // この1件を失うだけで会話全体は壊れない。
          console.warn('[chatConvClient] 書き換えの送信に失敗しました:', e)
        })
    },
    /** 送信の完了を待つ（プロジェクト切替時の取りこぼし防止・テスト用）。 */
    idle: () => chain,
  }
}
