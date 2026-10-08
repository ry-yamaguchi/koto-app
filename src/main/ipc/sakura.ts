// さくらのAI Engine 呼び出しの IPC（sakura:*）。abort管理の状態（activeChats・ストリーミングと非ストリーミングで共有）はモジュール内に保持する。
// deps は使わない（apiKey は都度引数で渡される＝方式B）。
//
// ── B'-3b（土台の入れ替え・main側 その1）─────────────────────────────
// LLM 呼び出しの実体（sakuraClient・isContextLimitError・safeMaxTokens・非ストリーミング/
// ストリーミングのロジック本体）は electron 非依存の src/main/sakura/engine.ts へ移した
// （main プロセス内で直接ループを走らせる chat/turnRunner.ts からも同じ実体を呼ぶため）。
// ここに残る2つのハンドラは、その関数を呼んで wc.send する薄い包みに書き直してある
// （abort管理・チャンネル名・成功/失敗の形は従来のまま）。
// sakuraClient・isContextLimitError・safeMaxTokens は既存の呼び出し元（claude/tools.ts）が
// このファイルから import しているため、re-export して壊さないようにする（重複定義はしない）。
import { ipcMain } from 'electron'
import type { IpcDeps } from './types'
import { sakuraClient, isContextLimitError, safeMaxTokens, runSakuraChat, runSakuraStream } from '../sakura/engine'
import { MODELS_TIMEOUT_MS, MODELS_MAX_RETRIES } from '../../shared/chatTimeouts'

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
      // 待ち時間の上限（2026-09-23 検分の指摘13）。sakuraClient は `new OpenAI({ apiKey, baseURL })`
      // だけなので、渡さないと openai 4.104.0 の既定（600秒・再試行2回＝最悪およそ1,800秒）のまま。
      // この口は ⚙️ 設定の「接続テスト」とモデル選択の両方から呼ばれ、**⏹ に相当する止め方が無い**。
      // ※ models.list の引数は RequestOptions ひとつ（node_modules/openai/resources/models.d.ts:14）。
      const res = await sakuraClient(apiKey).models.list({ timeout: MODELS_TIMEOUT_MS, maxRetries: MODELS_MAX_RETRIES })
      return (res.data ?? []).map((m: any) => m.id).filter((x: any) => typeof x === 'string')
    } catch (e) {
      throw new Error(describeSakuraError(e))
    }
  })

  // ── 「⏹ 停止」の置き場（ストリーミングと非ストリーミングで**同じもの**を使う）──────────
  // 進行中の呼び出しの中断関数を id で保持し、sakura:chat-abort で呼べるようにする。
  //
  // ⚠️ ここを2つに分けてはいけない（2026-09-25 検分の指摘4）。
  // 0.3.50 で engine.ts の runSakuraChat に中断の口（cbs.onAbortReady）を足したとき、
  // 使ったのは main のターン経路（chat/turnRunner.ts）だけで、**renderer から呼ばれるこの口
  // （sakura:chat）には配線しなかった**。そのため手動の【🗂 まとめる】は、画面が
  // 「⏹ で停止できます」と出しているのに押しても何も起きず、最悪およそ600秒
  // （NON_STREAM_TIMEOUT_MS × 再試行）抜けられなかった。置き場も口も1つにして、
  // 「片方だけ直る」形を作らない。
  //
  // ⚠️ renderer から `sakura.chat` を呼ぶ口は**2つある**（2026-09-25 検分の指摘6）。
  // 足すときは、増やしたぶんも必ず onStart を渡すこと（`grep -rn 'electronAPI.sakura.chat(' src`）:
  //   ① src/renderer/hooks/useAiChat.ts の chatOnce（🗂 まとめ作り）
  //   ② src/renderer/securityCheck.ts の runSecurityCheck（公開前セキュリティチェック）
  // 指摘4 を直したとき配線したのは①だけで、②は onStart を渡さないまま残っていた
  // （＝「片方だけ直る」の5度目を作りかけた）。onStart は任意の引数なので、
  // **渡し忘れても型検査は通る**。増えたら数え直す。
  const activeChats = new Map<string, { abort: () => void }>()

  // 非ストリーミングのチャット（🗂 まとめ作り・公開前セキュリティチェック）。実体は engine.ts の runSakuraChat。
  // id は preload が採番して必ず渡す（任意にすると渡し忘れても誰も気づかない＝掟10）。
  ipcMain.handle(
    'sakura:chat',
    async (_, args: { id: string; apiKey: string; model: string; messages: ChatMsg[]; maxTokens?: number; temperature?: number }) => {
      const { id } = args
      try {
        // ★ runSakuraChat は**リクエストを投げる前に** onAbortReady を呼ぶ（engine.ts の
        //   「先に中断関数を渡す」）。await より先に登録が終わるので、返事が一度も返ってこない
        //   相手でも ⏹ が届く。
        return await runSakuraChat(args, {
          onAbortReady: (abortFn) => { activeChats.set(id, { abort: abortFn }) },
        })
      } finally {
        activeChats.delete(id)
      }
    }
  )

  // ストリーミングのチャット（チャット/AIパネル）。チャンクをイベントで返す。
  // 「⏹ 停止」のため、進行中のストリームをIDで保持して中断できるようにする（上の activeChats）。
  // 実体は engine.ts の runSakuraStream。ここは呼んで wc.send するだけの薄い包み
  // （チャンネル名・成功/失敗の形は従来のまま）。
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
            onAbortReady: (abortFn) => { activeChats.set(id, { abort: abortFn }) },
          },
        )
        // runSakuraStream は正常終了（usage・toolCalls・reasoningText）と、ユーザーによる停止
        // （{ usage: null, aborted: true }）のどちらも return する（throw しない）。従来どおり
        // 両方とも chat-done へ送る。他のエラー（throw されたもの）だけ catch 側で chat-error にする。
        wc.send(`sakura:chat-done:${id}`, result)
      } catch (err: any) {
        wc.send(`sakura:chat-error:${id}`, err?.message ?? String(err))
      } finally {
        activeChats.delete(id)
      }
    }
  )

  // 進行中のAI応答を停止する（ストリーミング・非ストリーミングの両方。id は preload が採番する）。
  // 登録が無ければ何もしない（すでに終わっている・知らない id）。
  ipcMain.handle('sakura:chat-abort', (_, id: string) => {
    activeChats.get(id)?.abort()
  })
}
