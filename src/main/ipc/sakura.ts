// さくらのAI Engine 呼び出しの IPC（sakura:*）。ストリーミング/abort管理の状態（activeChatStreams）はモジュール内に保持する。
// deps は使わない（apiKey は都度引数で渡される＝方式B）。
//
// ── B'-3b（土台の入れ替え・main側 その1）─────────────────────────────
// LLM 呼び出しの実体（sakuraClient・isContextLimitError・safeMaxTokens・非ストリーミング/
// ストリーミングのロジック本体）は electron 非依存の src/main/sakura/engine.ts へ移した
// （main プロセス内で直接ループを走らせる chat/turnRunner.ts からも同じ実体を呼ぶため）。
// ここに残る2つのハンドラは、その関数を呼んで wc.send する薄い包みに書き直してある
// （activeChatStreams の管理・チャンネル名・成功/失敗の形は従来のまま）。
// sakuraClient・isContextLimitError・safeMaxTokens は既存の呼び出し元（claude/tools.ts）が
// このファイルから import しているため、re-export して壊さないようにする（重複定義はしない）。
import { ipcMain } from 'electron'
import type { IpcDeps } from './types'
import { sakuraClient, isContextLimitError, safeMaxTokens, runSakuraChat, runSakuraStream } from '../sakura/engine'

export { sakuraClient, isContextLimitError, safeMaxTokens }

// ── さくらのAI Engine 呼び出し（メインプロセス経由＝CORS回避） ──
// content は文字列、または OpenAI互換のマルチモーダル配列（テキスト＋画像）。
// Function Calling のため tool ロールと tool_calls / tool_call_id も通す。
type ChatMsg = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: any
  tool_calls?: any[]
  tool_call_id?: string
}

// さくらのAI Engine（OpenAI SDK）の生エラーを日本語の一言に変換する（純粋関数）。
// 所見14: `sakura:models`（接続テスト）が OpenAI SDK の生エラー（英語＋HTTPステータス）を
// そのまま投げていたため、オンボーディング画面・CredentialsModal の KeyTestButton に英語のまま出ていた。
// src/main/github/client.ts の describeCreateRepoError、src/main/claude/client.ts の describeClaudeError と
// 同じ考え方（既知の原因のみ日本語化し、未知はメッセージの先頭を短く見せる）。
export function describeSakuraError(e: unknown): string {
  const err = (e ?? {}) as { status?: number; message?: string; code?: string; cause?: { code?: string } }
  const status = typeof err.status === 'number' ? err.status : undefined
  const message = typeof err.message === 'string' ? err.message : String(e ?? '')
  if (status === 401 || status === 403) {
    return 'APIキーが正しくないようです。コピーし直して貼り付けてください'
  }
  if (status === 429) {
    return 'アクセスが集中しています。しばらく待ってからもう一度お試しください'
  }
  const causeCode = err.cause?.code ?? err.code
  if (
    causeCode === 'ENOTFOUND' || causeCode === 'ECONNREFUSED' || causeCode === 'ETIMEDOUT' || causeCode === 'EAI_AGAIN' ||
    /enotfound|econnrefused|etimedout|fetch failed|network/i.test(message)
  ) {
    return 'インターネット接続を確認してください'
  }
  return `接続テストに失敗しました: ${message.slice(0, 120)}`
}

export function registerSakuraHandlers(_deps: IpcDeps) {
  // モデル一覧（接続テストにも使われる）。生エラーは describeSakuraError() で日本語化してから投げ直す。
  ipcMain.handle('sakura:models', async (_, apiKey: string) => {
    try {
      const res = await sakuraClient(apiKey).models.list()
      return (res.data ?? []).map((m: any) => m.id).filter((x: any) => typeof x === 'string')
    } catch (e) {
      throw new Error(describeSakuraError(e))
    }
  })

  // 非ストリーミングのチャット（プロジェクト生成などで使用）。実体は engine.ts の runSakuraChat。
  ipcMain.handle(
    'sakura:chat',
    async (_, args: { apiKey: string; model: string; messages: ChatMsg[]; maxTokens?: number; temperature?: number }) => {
      return runSakuraChat(args)
    }
  )

  // ストリーミングのチャット（チャット/AIパネル）。チャンクをイベントで返す。
  // 「⏹ 停止」のため、進行中のストリームをIDで保持して中断できるようにする。
  // 実体は engine.ts の runSakuraStream。ここは呼んで wc.send するだけの薄い包み
  // （activeChatStreams の管理・チャンネル名・成功/失敗の形は従来のまま）。
  const activeChatStreams = new Map<string, { abort: () => void }>()

  ipcMain.handle(
    'sakura:chat-stream',
    async (event, args: { id: string; apiKey: string; model: string; messages: ChatMsg[]; maxTokens?: number; tools?: any[] }) => {
      const wc = event.sender
      const { id } = args
      try {
        const result = await runSakuraStream(
          { apiKey: args.apiKey, model: args.model, messages: args.messages, maxTokens: args.maxTokens, tools: args.tools },
          {
            onDelta: (d) => wc.send(`sakura:chat-chunk:${id}`, d),
            onReasoning: (d) => wc.send(`sakura:chat-reasoning:${id}`, d),
            onAbortReady: (abortFn) => { activeChatStreams.set(id, { abort: abortFn }) },
          },
        )
        // runSakuraStream は正常終了（usage・toolCalls・reasoningText）と、ユーザーによる停止
        // （{ usage: null, aborted: true }）のどちらも return する（throw しない）。従来どおり
        // 両方とも chat-done へ送る。他のエラー（throw されたもの）だけ catch 側で chat-error にする。
        wc.send(`sakura:chat-done:${id}`, result)
      } catch (err: any) {
        wc.send(`sakura:chat-error:${id}`, err?.message ?? String(err))
      } finally {
        activeChatStreams.delete(id)
      }
    }
  )

  // 進行中のAI応答を停止する
  ipcMain.handle('sakura:chat-abort', (_, id: string) => {
    activeChatStreams.get(id)?.abort()
  })
}
