// chatTurnBridge.ts — main で走る1ターン（chatTurn:start）からの ask を、renderer の実装
// （buildPorts の中身と同じもの）へ振り分ける（B'-3b・renderer側の配線）。
//
// ── なぜ要るか ─────────────────────────────────────────────────────
// AI Engine のループ本体（runEngineTurn）は main プロセスで走るようになった
// （src/main/chat/turnRunner.ts）。renderer にしか無い副作用（承認・
// システムプロンプト組み立て等）は、main から IPC 経由の「問い合わせ」（ask・
// src/shared/chatTurnRpc.ts の ASK_PATHS）として飛んでくる。このファイルは、その ask を
// useAiChat.ts の handlers（buildPorts と同じ実装）へつなぎ直す**だけ**の薄い配線。
// ロジックの二重実装はしない。
//
// ⚠️ 学習記録（toolSupport.* / vision.*）は B'-3d-1a で main（learningStore.ts）へ移り、
// ask ではなくなった（ASK_PATHS から削除・main の turnRunner.ts が直接呼ぶ）。予算・利用実績
// （usage.check / usage.record）と compactWarnOnce も B'-3d-1b で main（usageStore.ts・
// モジュール内 Set）へ移り、同じく ask ではなくなった。executeTool も B'-3d-2b で
// main（buildMainIo・turnRunner.ts）が直呼びするようになり、ask ではなくなった。
// ここにはもうそれらに対応する case が無い。

import type { AskPath } from '../shared/chatTurnRpc'

/**
 * spec.turnOpts を IPC に載せられる形にする（関数の項目を落とす。値はそのまま）。
 *
 * ── なぜ要るか ─────────────────────────────────────────────────────
 * turnOpts（buildExecuteOpts() の返り値）は、electron の IPC（構造化複製）が運べない
 * 関数を含むことがある値。main へ渡す spec.turnOpts からは関数を落とす。
 *
 * ── B'-3d-2b: executeTool が main 直呼びになった後も残す理由（安全網） ────────────
 * 以前は「落とした関数（applyFile/ragSearch）を、executeTool の ask を受けたとき
 * （dispatchAsk）に turnOptsFull を敷き直して復元する」ためにここが必須だった。
 * いま buildExecuteOpts() はそもそも関数を含まない（applyFile/ragSearch を外し、
 * rag: {tags} | null という値だけを持つ・ChatPanel.tsx）ため、通常はここで落ちるものは無い。
 * それでも「万一 turnOpts に関数が紛れ込んでも IPC を壊さない」安全網として残す。
 */
export function stripFunctions(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(o)) {
    if (typeof value === 'function') continue
    out[key] = value
  }
  return out
}

/**
 * main からの ask を、renderer の実装（buildPorts の中身と同じもの）へ振り分ける。
 *
 * - approveToolCall は main から来た scope をそのまま渡す。
 * - 知らない path は Error を投げる（黙って undefined を返さない）。
 * - optional（approveToolCall / onUserMessage / buildRagBlock）が undefined のまま
 *   ask が来たら Error を投げる（caps の食い違い＝バグを黙らせない）。
 *
 * ── handlers の型について ────────────────────────────────────────
 * buildSystemPrompt / getHistory の返り値を
 * `T | Promise<T>` にしてある。renderer の実装（useAiChat.ts の buildPorts）は今日も同期
 * （T のみ）だが、この関数はその ports をそのまま（型を狭め直さずに）handlers として使う
 * ため、EngineTurnPorts（src/shared/chatTurn.ts）の型に合わせてある。
 *
 * ── B'-3d-2b: executeTool を外した ─────────────────────────────────
 * executeTool は main（buildMainIo・turnRunner.ts）が直呼びするようになり、ASK_PATHS から
 * 消えた。ここには case が無く、handlers 型にも executeTool は無い。turnOptsFull を敷く
 * 合成（{...turnOptsFull, ...opts}）は executeTool のためだけの仕組みだったため、残る ask
 * のどれも使っていないことを確認したうえで、この関数の引数からも turnOptsFull を外した。
 */
export function dispatchAsk(
  handlers: {
    approveToolCall?(name: string, args: string, scope?: unknown): Promise<string | null>
    buildSystemPrompt(): string | Promise<string>
    getHistory(): unknown[] | Promise<unknown[]>
    onUserMessage?(text: string, isFirst: boolean): void
    buildRagBlock?(text: string): Promise<string>
    getSearchConfig(): Promise<unknown>
    fetchPagesBlock(urls: string[]): Promise<string>
    autoSearchBlock(text: string, search: unknown): Promise<string>
  },
  path: AskPath,
  args: unknown[],
): unknown | Promise<unknown> {
  switch (path) {
    case 'approveToolCall': {
      if (!handlers.approveToolCall) throw new Error(`ask '${path}' に対応する handler がありません（caps の食い違い）`)
      const [name, argsStr, scope] = args as [string, string, unknown]
      return handlers.approveToolCall(name, argsStr, scope)
    }
    case 'buildSystemPrompt':
      return handlers.buildSystemPrompt()
    case 'getHistory':
      return handlers.getHistory()
    case 'onUserMessage': {
      if (!handlers.onUserMessage) throw new Error(`ask '${path}' に対応する handler がありません（caps の食い違い）`)
      const [text, isFirst] = args as [string, boolean]
      return handlers.onUserMessage(text, isFirst)
    }
    case 'buildRagBlock': {
      if (!handlers.buildRagBlock) throw new Error(`ask '${path}' に対応する handler がありません（caps の食い違い）`)
      const [text] = args as [string]
      return handlers.buildRagBlock(text)
    }
    case 'getSearchConfig':
      return handlers.getSearchConfig()
    case 'fetchPagesBlock': {
      const [urls] = args as [string[]]
      return handlers.fetchPagesBlock(urls)
    }
    case 'autoSearchBlock': {
      const [text, search] = args as [string, unknown]
      return handlers.autoSearchBlock(text, search)
    }
    default: {
      // ASK_PATHS（src/shared/chatTurnRpc.ts）に新しい path が増えたのに、ここへ
      // case を足し忘れると、この行は `path` を `never` へ代入できずコンパイルエラーになる
      // （網羅性チェック）。実行時に来る「本当に知らない path」（型を経由しない・テスト由来）は
      // ここまで来て Error を投げる。
      const exhaustive: never = path
      throw new Error(`未知の ask path です: ${String(exhaustive)}`)
    }
  }
}
