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
import { unreadableFrom, copiesFrom, type UnreadableChat } from '../shared/chatUnreadable'

const LEGACY_PROJECT_PREFIX = 'sakura_chat:'

/** 会話への書き換え1件。main の convStore.ts の Op と同じ形（IPCでそのまま運ぶ）。 */
export type Op = ChatEvent<ChatMessage> | { kind: 'replaceAll'; messages: ChatMessage[] }

/** 読み込みの結果。`readable` は、main の会話ストアに問い合わせて答えが返り、記録を読めたか。 */
export interface ConversationLoad {
  messages: ChatMessage[]
  /**
   * 問い合わせに失敗した（IPC の失敗・ok:false）回と、記録が読めなかった（unreadable）回は false。
   * そのとき messages は旧 localStorage か空で、保存済みの会話が無いことの証拠にならない。
   */
  readable: boolean
  /** 記録が壊れていて読めなかった回の知らせ（写しの名前。作れなかった回は backupName が null）。読めた回・問い合わせに失敗した回は null。 */
  unreadable: UnreadableChat | null
  /** 記録は読めたが、同じフォルダに読めなかった記録の写しが残っているときの、その名前。無いときは付かない。 */
  copies?: string[]
}

/**
 * 読み込み（ファイル→無ければ旧localStorage移行→空）。読めたかどうかも返す。
 * 移行時は replaceAll を送って main のストアへ載せ、旧キーを消す
 * （今までの loadProjectChat と同じ手順・resolveChatSource を使う）。
 * 記録が読めなかった回（unreadable）は「会話が無い」ではないので、旧 localStorage の移行へは進まない
 * （進むと replaceAll が壊れた記録の上へ旧データを書く）。
 */
export async function loadConversationChecked(projectDir: string): Promise<ConversationLoad> {
  let fileData: ChatMessage[] | null = null
  let readable = false
  let copies: string[] = []
  try {
    const res = await window.electronAPI.chat.load(projectDir)
    if (res.ok) {
      fileData = res.messages as ChatMessage[] | null
      const unreadable = unreadableFrom(res.unreadable)
      // main の手元に会話があればそれを映す（読めなかった記録のあとに書き始めた回・壊れた行の手前まで読めた回）。無ければ空
      if (unreadable) return { messages: fileData ?? [], readable: false, unreadable }
      readable = true
      copies = copiesFrom(res.copies)
    }
  } catch { /* IPC失敗はlocalStorageへフォールバック（読めた扱いにはしない） */ }

  const legacyKey = LEGACY_PROJECT_PREFIX + projectDir
  const legacyData = parseJsonArray(localStorage.getItem(legacyKey)) as ChatMessage[] | null
  const resolved = resolveChatSource<ChatMessage>(fileData, legacyData)

  const kept = copies.length > 0 ? { copies } : {}
  if (resolved.kind === 'file') return { messages: resolved.data, readable, unreadable: null, ...kept }
  if (resolved.kind === 'migrate') {
    // 即 main のストアへ載せる（replaceAll）。以前の loadProjectChat と同じく await はしない
    // （旧キーの削除を待たせない。IPC失敗時は次回この関数を呼んだときにまた移行を試みる）。
    void window.electronAPI.chat.ops(projectDir, [{ kind: 'replaceAll', messages: resolved.data }])
    localStorage.removeItem(legacyKey)
    return { messages: resolved.data, readable, unreadable: null, ...kept }
  }
  return { messages: [], readable, unreadable: null, ...kept }
}

/** 読み込み。読めたかどうかを使わない呼び手向け（loadConversationChecked の messages だけ）。 */
export async function loadConversationView(projectDir: string): Promise<ChatMessage[]> {
  return (await loadConversationChecked(projectDir)).messages
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

/**
 * renderer 発の書き換えの行き先。`turnDir` はターンを始めたプロジェクト、`viewingDir` はいま見ているもの、
 * `viewingReady` は、いま見ている会話の読み込みが済んで client が付いているか。
 * 同じで読み込み済みなら 'viewing'（いまの client。送信の順序を守る）、違えば 'turn'（始めたプロジェクトの会話へ送る）。
 * 同じでも読み込み中（A→B→A で A を読み直している間）は 'turn'：画面だけに当てると、読み込み結果に
 * 上書きされて記録から落ちる。始めたプロジェクトが分からない（null）ときは 'viewing'（これまでどおり）。
 */
export function opRouteOf(turnDir: string | null, viewingDir: string | null, viewingReady = true): 'viewing' | 'turn' {
  if (turnDir === null) return 'viewing'
  return turnDir !== viewingDir || !viewingReady ? 'turn' : 'viewing'
}

/** 見ていないプロジェクトの会話へ送る client（dir ごとに1つ。同じ会話への書き換えの順序を守る）。 */
const turnClients = new Map<string, ReturnType<typeof makeConvClient>>()

/**
 * ターン中に別のプロジェクトへ切り替わったあとの書き換えを、始めたプロジェクトの会話へ送る（掟11）。
 * 画面へは反映しない（そのプロジェクトを開いたときに読む。chat:applied は見ているプロジェクト宛てだけ受ける）。
 */
export function applyOpToConversation(dir: string, op: Op): void {
  let client = turnClients.get(dir)
  if (!client) {
    client = makeConvClient(dir)
    turnClients.set(dir, client)
  }
  client.apply(op)
}
