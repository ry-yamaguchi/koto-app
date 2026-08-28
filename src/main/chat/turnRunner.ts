// turnRunner.ts — chatTurn:* の IPC。AI Engine 経路のループ（src/shared/chatTurn.ts の
// runEngineTurn）を main プロセスで直接走らせる（B'-3b・土台の入れ替え その1・本体）。
//
// ── 方針 ─────────────────────────────────────────────────────────────
// ツール実行・承認・学習記録（localStorage）・システムプロンプト組み立てなど、renderer に
// しか無い副作用は renderer へ「問い合わせ」（ask・chat/askBridge.ts）て、今のコードを
// そのまま使う。main が直接持つのは LLM 呼び出し（sakura/engine.ts）・emit・純粋関数の束
// （h・src/shared 配下の本物の実装）だけ。「見かけが変わらない」を最優先し、直せる不具合が
// あってもここでは直さない（sakura.ts から移した部分は engine.ts の説明を参照）。
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import type { IpcDeps } from '../ipc/types'
import { createAskBridge, type AskBridge } from './askBridge'
import { applyConversationOps } from './convStore'
import { runEngineTurn, type EngineTurnPorts, type TurnHelpers } from '../../shared/chatTurn'
import { runSakuraChat, runSakuraStream } from '../sakura/engine'
import type { TurnStartPayload, TurnAnswer, TurnAsk } from '../../shared/chatTurnRpc'
import {
  formatChatError, condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, isToolArgsComplete, isToolUnsupportedError,
  toolStatusLabel, WRITING_TOOLS, toolsFor, searchStatusContext,
} from '../../shared/aiToolsCore'
import { estimateTokens, isImageUnsupportedError, modelLabel, pickBestModel } from '../../shared/modelInfo'
import { extractUrls, wantsWebSearch } from '../../shared/webContextCore'
import { planSend, planCompact, compactPrompt, acceptSummary, compactSource } from '../../shared/historyCompact'

// h は shared から**本物の実装**を import して組み立てる（renderer は import できないモジュールなので、
// ここで初めて main 側から使われる。aiToolsCore / modelInfo / webContextCore / historyCompact /
// chatTurn の型に合っていることは `npx tsc -p tsconfig.main.json --noEmit` が担保する）。
const h: TurnHelpers = {
  formatChatError,
  condenseReasoning,
  hasTextToolMarkup,
  stripToolMarkup,
  unexecutedToolWarning,
  claimsFileChange,
  unexecutedChangeWarning,
  isToolArgsComplete,
  isToolUnsupportedError,
  isImageUnsupportedError,
  toolStatusLabel,
  modelLabel,
  pickBestModel,
  writingTools: WRITING_TOOLS,
  extractUrls,
  wantsWebSearch,
  toolsFor,
  planSend,
  planCompact,
  compactPrompt,
  acceptSummary,
  compactSource,
  searchStatusContext,
}

/** ターンごとの管理表の1件。 */
type TurnEntry = {
  bridge: AskBridge
  /** 進行中の応答を止める関数（ports.setAbort が差し込む）。未設定・停止済みは null。 */
  abort: (() => void) | null
}

/** renderer にしか無い副作用を ask で組み立てる。optional な ports は caps が false なら undefined にする
 *  （無いのに ask すると挙動が変わるため・仕様書の注記）。 */
function buildMainPorts(turnId: string, wc: WebContents, payload: TurnStartPayload, entry: TurnEntry): EngineTurnPorts {
  const { bridge } = entry
  const { caps } = payload
  return {
    // B'-3c: message系（append/replaceLast/removeLast）は、まず main の会話ストア
    // （convStore.ts）へ直接当ててから画面へ送る。renderer を経由しない書き込みの第一歩
    // （ウィンドウが閉じていても・出来事を取りこぼしても、会話は必ず保存される）。
    // toolsProjectDir が無いとき（単独チャット・今回対象外）はストアに触らない。
    // loading/status/routed はストアに関係しないので、これまでどおり send のみ。
    emit: (ev) => {
      if ((ev.kind === 'append' || ev.kind === 'replaceLast' || ev.kind === 'removeLast') && payload.spec.toolsProjectDir) {
        applyConversationOps(payload.spec.toolsProjectDir, [ev])
      }
      if (!wc.isDestroyed()) wc.send(`chatTurn:event:${turnId}`, { type: 'emit', ev })
    },
    chatStream: (req, onDelta, onAbortReady, onThinking) =>
      runSakuraStream(req, { onDelta, onReasoning: onThinking, onAbortReady }),
    // 🗂 まとめ作り中の ⏹ 停止（0.3.50）: runSakuraChat の onAbortReady で受け取った中断関数を
    // entry.abort へ差し込む（chatTurn:abort → turns.get(turnId)?.abort?.() から呼べるように）。
    // ports.setAbort は経由しない（EngineTurnPorts.chatOnce の型に abort registration は無く、
    // まとめ作りは main だけで完結する処理のため、この配線も main 内で完結させる）。
    // まとめが終わったあとも entry.abort にはこの中断関数が残り続けるが、完了済みリクエストへの
    // abort は無害（呼んでも何も起きない）。次にストリーミングが始まれば ports.setAbort が
    // 新しい中断関数で上書きするので、古いものが誤って呼ばれる実害は無い。
    chatOnce: (req) => runSakuraChat(req, { onAbortReady: (abort) => { entry.abort = abort } }),
    getHistory: () => bridge.ask('getHistory', []) as any,
    buildSystemPrompt: () => bridge.ask('buildSystemPrompt', []) as any,
    onUserMessage: caps.onUserMessage
      ? (text, isFirst) => bridge.ask('onUserMessage', [text, isFirst]) as any
      : undefined,
    approveToolCall: caps.approveToolCall
      ? (name, argsJson, scope) => bridge.ask('approveToolCall', [name, argsJson, scope]) as any
      : undefined,
    executeTool: (name, argsJson, opts) => bridge.ask('executeTool', [name, argsJson, opts]) as any,
    buildRagBlock: caps.buildRagBlock
      ? (text) => bridge.ask('buildRagBlock', [text]) as any
      : undefined,
    getSearchConfig: () => bridge.ask('getSearchConfig', []) as any,
    fetchPagesBlock: (urls) => bridge.ask('fetchPagesBlock', [urls]) as any,
    autoSearchBlock: (text, search) => bridge.ask('autoSearchBlock', [text, search]) as any,
    notifyActivity: () => { if (!wc.isDestroyed()) wc.send(`chatTurn:event:${turnId}`, { type: 'activity' }) },
    setAbort: (fn) => { entry.abort = fn },
    usage: {
      check: () => bridge.ask('usage.check', []) as any,
      record: (model, promptTokens, completionTokens) => bridge.ask('usage.record', [model, promptTokens, completionTokens]) as any,
      estimate: (text) => estimateTokens(text), // 純粋関数。main が直接持つ（往復しない・仕様書の注記）
    },
    toolSupport: {
      shouldSendTools: (model) => bridge.ask('toolSupport.shouldSendTools', [model]) as any,
      isKnownToolCapable: (model) => bridge.ask('toolSupport.isKnownToolCapable', [model]) as any,
      record: (model, supported) => bridge.ask('toolSupport.record', [model, supported]) as any,
    },
    vision: {
      shouldTryDirect: (model) => bridge.ask('vision.shouldTryDirect', [model]) as any,
      record: (model, supported) => bridge.ask('vision.record', [model, supported]) as any,
      defaultModel: () => bridge.ask('vision.defaultModel', []) as any,
    },
    compactWarnOnce: () => bridge.ask('compactWarnOnce', []) as any,
    h,
  }
}

export function registerChatTurnHandlers(_deps: IpcDeps): void {
  const turns = new Map<string, TurnEntry>()

  ipcMain.handle('chatTurn:start', async (event, payload: TurnStartPayload) => {
    const wc = event.sender
    const { turnId } = payload
    const entry: TurnEntry = {
      bridge: createAskBridge((ask: TurnAsk) => { if (!wc.isDestroyed()) wc.send(`chatTurn:ask:${turnId}`, ask) }),
      abort: null,
    }
    turns.set(turnId, entry)

    // 画面が閉じられた・リロードされたとき、未回答の ask が永遠に残らないようにする
    // （2026-08-28 仕様書の注記: wc.once('destroyed') が使える。リロード＝did-navigate も同様に扱う）。
    // 正常終了時はここで登録した分をきちんと外す（did-navigate は 'once' ではないため、
    // 外し忘れるとターンのたびにリスナーが積み上がる）。
    const onGone = () => { entry.bridge.rejectAll('画面が閉じられました') }
    wc.once('destroyed', onGone)
    wc.on('did-navigate', onGone)

    try {
      await runEngineTurn(payload.spec, buildMainPorts(turnId, wc, payload, entry))
    } catch (e) {
      // chatTurn.ts 自身がエラーを会話の吹き出しにするので、ここへ来るのは想定外のバグのみ。
      // ハンドラの外へ投げ直さず（invoke を reject させない）、ログにだけ残す（仕様書の注記）。
      console.error('[chatTurn:start] runEngineTurn failed', e)
    } finally {
      // 破棄済みの WebContents はメソッド呼び出し自体が例外を投げることがある
      // （windowSend.ts の isDestroyed() と同じ注意）。触れなくても実害は無いので無視する。
      try { wc.off('destroyed', onGone); wc.off('did-navigate', onGone) } catch { /* 破棄済みで触れない場合は無視 */ }
      entry.bridge.rejectAll('ターンが終了しました')
      turns.delete(turnId)
    }
    return { ok: true }
  })

  // 進行中の応答を止める（sakura:chat-abort と同じ考え方）。turnId が無ければ何もしない。
  ipcMain.handle('chatTurn:abort', (_, turnId: string) => {
    turns.get(turnId)?.abort?.()
  })

  // renderer からの ask への回答。該当 turn の帳簿へ渡す（無ければ何もしない）。
  ipcMain.handle('chatTurn:answer', (_, a: TurnAnswer) => {
    turns.get(a.turnId)?.bridge.answer(a)
  })
}
