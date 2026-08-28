// engine.ts — さくらのAI Engine 呼び出しの実体（electron 非依存）。
//
// ── なぜ ipc/sakura.ts から出したか（B'-3b）───────────────────────────
// これまでは LLM 呼び出しのロジックが ipcMain.handle のコールバックの中に直接書かれており、
// main プロセス（renderer から呼ばれる形）でしか動かせなかった。次の段（chat/turnRunner.ts）で
// このループを main プロセス内で直接走らせるには、呼び出しの実体を electron に依存しない
// 普通の関数として取り出す必要がある。
//
// ロジックはコンテキスト上限の縮小再試行・temperature/top_p・stream_options・streamDelta の
// 畳み込み・abort 時の catch 判定を含め、ipc/sakura.ts にあったものを一字一句そのまま移した。
// 違いは「renderer へイベントを送る（wc.send）」だった箇所を「呼び出し側へ返す（コールバック／
// 戻り値）」に変えただけ。ipc/sakura.ts はこの関数を呼んで wc.send する薄い包みに書き直した。
import OpenAI from 'openai'
import { newStreamState, applyChunk, finishedToolCalls } from '../../shared/streamDelta'
import { pickContent } from '../../shared/chatContent'

const SAKURA_BASE_URL = 'https://api.ai.sakura.ad.jp/v1'
// C3: delegate_implementation（claude/tools.ts）からも同じクライアント生成を再利用する。
// baseURL は既定でさくらの本番エンドポイント。第2引数は tests/sakuraEngine.test.ts が
// ローカルの http サーバへ向けるためだけの差し替え口（本番の呼び出し側は渡さないので挙動は変わらない）。
export function sakuraClient(apiKey: string, baseURL: string = SAKURA_BASE_URL) {
  return new OpenAI({ apiKey, baseURL })
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

/** 非ストリーミング（sakura:chat の中身そのまま）。プロジェクト生成などで使用。 */
export async function runSakuraChat(
  args: { apiKey: string; model: string; messages: any[]; maxTokens?: number; temperature?: number },
): Promise<{ content: string; usage: any | null }> {
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
  // 推論型モデルは本文が空で、答えが reasoning 側に入ることがある（shared/chatContent.ts）。
  return { content: pickContent(res.choices?.[0]?.message), usage: res.usage ?? null }
}

/**
 * ストリーミング（sakura:chat-stream の中身そのまま。イベント送信の代わりにコールバック）。
 *
 * 「⏹ 停止」のため、開始したらすぐ `cbs.onAbortReady` で中断関数を渡す（呼び出し側が
 * ID などで保持して、あとから呼べるようにする）。
 *
 * abort 判定の catch では `{ usage: null, aborted: true }` を **return** する（例外にしない）。
 * それ以外のエラーは throw する（chat-error にするのは呼び出し側＝ハンドラの仕事のまま）。
 *
 * ── なぜ `abortRequested` フラグを持つか（2026-08-28 実測・roadmap 記録）───────────
 * 上のcatchは「abort＝例外を投げる」openai SDKの版を前提にしている。だが 4.104.0 では
 * `stream.controller.abort()` を呼んでも **for-await が例外を投げずに静かに終わる**
 * （ローカルの偽SSEサーバで実証。tests/sakuraEngine.test.ts が同じ形で固定している）。
 * そのため catch に入らず、`aborted` の付かない普通の完了として返っていた
 * （＝「（⏹ 停止しました）」が出ない）。例外に依存せず、abortを要求した事実を
 * フラグで持ち、for-awaitが（例外を投げずに）終わったあとにも見る。
 * 既存のcatch（例外を投げる版のSDKへの対応）は**そのまま残す**（両対応）。
 */
export async function runSakuraStream(
  args: { apiKey: string; model: string; messages: any[]; maxTokens?: number; tools?: any[]; baseURL?: string },
  cbs: { onDelta(d: string): void; onReasoning(d: string): void; onAbortReady(abort: () => void): void },
): Promise<{ usage: any; aborted?: boolean; toolCalls?: any[] | null; reasoningText?: string | null }> {
  let abortRequested = false
  try {
    const client = sakuraClient(args.apiKey, args.baseURL)
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
    cbs.onAbortReady(() => { abortRequested = true; stream.controller.abort() })
    let usage: any = null
    // 推論型モデル（gpt-oss / Kimi 等）は tools 指定時に回答が reasoning_content/reasoning へ流れて
    // 本文が空になることがある。完了時のフォールバック用に蓄積しつつ、**到着した分はそのつど呼び出し側へも流す**
    // （2026-08-03 ユーザー要望: 待っている間「いま何をしているか」を見せる。推論モデルは本文が出るまで
    //  数十秒沈黙することがあり、その間ここだけが唯一の進行の手がかりになる）。
    // デルタの組み立ては純粋ロジックへ切り出してある（src/shared/streamDelta.ts）。
    // ここは「届いた差分を呼び出し側へ流す」ことだけを行う。
    const state = newStreamState()
    for await (const chunk of stream) {
      const { contentDelta, reasoningDelta } = applyChunk(state, chunk)
      if (contentDelta) cbs.onDelta(contentDelta)
      if (reasoningDelta) cbs.onReasoning(reasoningDelta)
    }
    usage = state.usage
    // SDK が例外を投げずに静かに終わる版への対応（2026-08-28 実測・openai 4.104.0）。
    // for-await が正常終了しても、abort を要求していたなら「止めた」ことにする
    // （でないと本文が空のまま正常終了に見え、renderer が推論フォールバックや
    //  ツール外し再試行など、止めたのに何か続いて見える動きへ進んでしまう）。
    if (abortRequested) return { usage: null, aborted: true }
    return {
      usage,
      toolCalls: finishedToolCalls(state),
      reasoningText: state.reasoning || null,
    }
  } catch (err: any) {
    // ユーザーによる停止はエラーではなく正常終了として扱う
    if (err?.name === 'APIUserAbortError' || /abort/i.test(err?.message ?? '')) {
      return { usage: null, aborted: true }
    }
    throw err
  }
}
