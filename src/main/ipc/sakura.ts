// さくらのAI Engine 呼び出しの IPC（sakura:*）。ストリーミング/abort管理の状態（activeChatStreams）はモジュール内に保持する。
// deps は使わない（apiKey は都度引数で渡される＝方式B）。
import { ipcMain } from 'electron'
import OpenAI from 'openai'
import type { IpcDeps } from './types'
import { newStreamState, applyChunk, finishedToolCalls } from '../../shared/streamDelta'

const SAKURA_BASE_URL = 'https://api.ai.sakura.ad.jp/v1'
// C3: delegate_implementation（claude/tools.ts）からも同じクライアント生成を再利用する。
export function sakuraClient(apiKey: string) {
  return new OpenAI({ apiKey, baseURL: SAKURA_BASE_URL })
}

// ── さくらのAI Engine 呼び出し（メインプロセス経由＝CORS回避） ──
// content は文字列、または OpenAI互換のマルチモーダル配列（テキスト＋画像）。
// Function Calling のため tool ロールと tool_calls / tool_call_id も通す。
type ChatMsg = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: any
  tool_calls?: any[]
  tool_call_id?: string
}

// コンテキスト長が小さいモデル（例: llm-jp-3.1-8x13b は 4096＝入力+出力の合計）では、
// max_tokens=4096 が「コンテキスト超過」で 400 になる。エラー文に書かれた上限から安全値を割り出す。
// C3: delegate_implementation（claude/tools.ts）でも同じフォールバックを再利用するため export する。
export function isContextLimitError(msg: string): boolean {
  return /max_tokens|max_completion_tokens|maximum context length/i.test(msg)
}
export function safeMaxTokens(errMsg: string, requested: number): number | null {
  const ctx = errMsg.match(/maximum context length is (\d+)/i)
  if (!ctx) return null
  const contextLen = Number(ctx[1])
  const inp = errMsg.match(/has (\d+) input tokens/i)
  const inputTokens = inp ? Number(inp[1]) : 0
  const safe = contextLen - inputTokens - 32 // 余白を引いた安全な出力上限
  return safe >= 64 && safe < requested ? safe : null
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

  // 非ストリーミングのチャット（プロジェクト生成などで使用）
  ipcMain.handle(
    'sakura:chat',
    async (_, args: { apiKey: string; model: string; messages: ChatMsg[]; maxTokens?: number; temperature?: number }) => {
      const client = sakuraClient(args.apiKey)
      const requested = args.maxTokens ?? 4096
      const mk = (maxTokens: number) => client.chat.completions.create({
        model: args.model, messages: args.messages as any, max_tokens: maxTokens, temperature: args.temperature,
      })
      let res
      try {
        res = await mk(requested)
      } catch (err: any) {
        const safe = isContextLimitError(err?.message ?? '') ? safeMaxTokens(err?.message ?? '', requested) : null
        if (safe == null) throw err
        res = await mk(safe) // モデルのコンテキスト上限に合わせて縮めて再試行
      }
      return { content: res.choices?.[0]?.message?.content ?? '', usage: res.usage ?? null }
    }
  )

  // ストリーミングのチャット（チャット/AIパネル）。チャンクをイベントで返す。
  // 「⏹ 停止」のため、進行中のストリームをIDで保持して中断できるようにする。
  const activeChatStreams = new Map<string, { abort: () => void }>()

  ipcMain.handle(
    'sakura:chat-stream',
    async (event, args: { id: string; apiKey: string; model: string; messages: ChatMsg[]; maxTokens?: number; tools?: any[] }) => {
      const wc = event.sender
      const { id } = args
      try {
        const client = sakuraClient(args.apiKey)
        const requested = args.maxTokens ?? 4096
        const mk = (maxTokens: number) => client.chat.completions.create({
          model: args.model,
          messages: args.messages as any,
          max_tokens: maxTokens,
          // Qwen推奨のサンプリング設定。既定より出力が安定し、
          // 他言語トークンの混入（日本語にハングル等が混じる現象）も抑えられる
          temperature: 0.7,
          top_p: 0.8,
          stream: true,
          stream_options: { include_usage: true },
          ...(args.tools?.length ? { tools: args.tools } : {}),
        })
        let stream
        try {
          stream = await mk(requested)
        } catch (err: any) {
          // コンテキスト長が小さいモデルは max_tokens=4096 が超過扱いになる → 上限に合わせて縮めて再試行
          const safe = isContextLimitError(err?.message ?? '') ? safeMaxTokens(err?.message ?? '', requested) : null
          if (safe == null) throw err
          stream = await mk(safe)
        }
        activeChatStreams.set(id, { abort: () => stream.controller.abort() })
        let usage: any = null
        // 推論型モデル（gpt-oss / Kimi 等）は tools 指定時に回答が reasoning_content/reasoning へ流れて
        // 本文が空になることがある。完了時のフォールバック用に蓄積しつつ、**到着した分はそのつど renderer へも流す**
        // （2026-08-03 ユーザー要望: 待っている間「いま何をしているか」を見せる。推論モデルは本文が出るまで
        //  数十秒沈黙することがあり、その間ここだけが唯一の進行の手がかりになる）。
        // デルタの組み立ては純粋ロジックへ切り出してある（src/shared/streamDelta.ts）。
        // ここは「届いた差分を renderer へ流す」ことだけを行う。
        const state = newStreamState()
        for await (const chunk of stream) {
          const { contentDelta, reasoningDelta } = applyChunk(state, chunk)
          if (contentDelta) wc.send(`sakura:chat-chunk:${id}`, contentDelta)
          if (reasoningDelta) wc.send(`sakura:chat-reasoning:${id}`, reasoningDelta)
        }
        usage = state.usage
        wc.send(`sakura:chat-done:${id}`, {
          usage,
          toolCalls: finishedToolCalls(state),
          reasoningText: state.reasoning || null,
        })
      } catch (err: any) {
        // ユーザーによる停止はエラーではなく正常終了として扱う
        if (err?.name === 'APIUserAbortError' || /abort/i.test(err?.message ?? '')) {
          wc.send(`sakura:chat-done:${id}`, { usage: null, aborted: true })
        } else {
          wc.send(`sakura:chat-error:${id}`, err?.message ?? String(err))
        }
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
