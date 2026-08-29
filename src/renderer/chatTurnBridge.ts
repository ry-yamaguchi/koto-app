// chatTurnBridge.ts — main で走る1ターン（chatTurn:start）からの ask を、renderer の実装
// （buildPorts の中身と同じもの）へ振り分ける（B'-3b・renderer側の配線）。
//
// ── なぜ要るか ─────────────────────────────────────────────────────
// AI Engine のループ本体（runEngineTurn）は main プロセスで走るようになった
// （src/main/chat/turnRunner.ts）。renderer にしか無い副作用（ツール実行・承認・
// システムプロンプト組み立て等）は、main から IPC 経由の「問い合わせ」（ask・
// src/shared/chatTurnRpc.ts の ASK_PATHS）として飛んでくる。このファイルは、その ask を
// useAiChat.ts の handlers（buildPorts と同じ実装）へつなぎ直す**だけ**の薄い配線。
// ロジックの二重実装はしない。
//
// ⚠️ 学習記録（toolSupport.* / vision.*）は B'-3d-1a で main（learningStore.ts）へ移り、
// ask ではなくなった（ASK_PATHS から削除・main の turnRunner.ts が直接呼ぶ）。ここにはもう
// 対応する case が無い。

import type { AskPath } from '../shared/chatTurnRpc'

/**
 * spec.turnOpts を IPC に載せられる形にする（関数の項目を落とす。値はそのまま）。
 *
 * ── なぜ要るか ─────────────────────────────────────────────────────
 * turnOpts（buildExecuteOpts() の返り値）には applyFile / ragSearch のような
 * 関数が入っている。electron の IPC（構造化複製）は関数を運べないため、main へ渡す
 * spec.turnOpts からは関数を落とす。落とした関数は、executeTool の ask を受けたとき
 * （dispatchAsk）に turnOptsFull（この関数を通していない、そのままの turnOpts）を
 * 敷き直すことで復元する。
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
 * - executeTool だけ特別: main から来た opts の**前に** turnOptsFull を敷く
 *   （{...turnOptsFull, ...opts}）。関数の項目（applyFile / ragSearch）はここで復元される。
 *   値の項目は main 側の opts が同じ値で上書きするので、結果は今までの
 *   executeTool(name, args, {...turnOpts, search, snapshotId, snapshotLabel}) と完全に一致する。
 * - approveToolCall は main から来た scope をそのまま渡す。
 * - 知らない path は Error を投げる（黙って undefined を返さない）。
 * - optional（approveToolCall / onUserMessage / buildRagBlock）が undefined のまま
 *   ask が来たら Error を投げる（caps の食い違い＝バグを黙らせない）。
 *
 * ── handlers の型について ────────────────────────────────────────
 * buildSystemPrompt / getHistory / compactWarnOnce の返り値を
 * `T | Promise<T>` にしてある。renderer の実装（useAiChat.ts の buildPorts）は今日も同期
 * （T のみ）だが、この関数はその ports をそのまま（型を狭め直さずに）handlers として使う
 * ため、EngineTurnPorts（src/shared/chatTurn.ts）の型に合わせてある。
 */
export function dispatchAsk(
  handlers: {
    executeTool(name: string, argsJson: string, opts: Record<string, unknown>): Promise<string>
    approveToolCall?(name: string, args: string, scope?: unknown): Promise<string | null>
    buildSystemPrompt(): string | Promise<string>
    getHistory(): unknown[] | Promise<unknown[]>
    onUserMessage?(text: string, isFirst: boolean): void
    buildRagBlock?(text: string): Promise<string>
    getSearchConfig(): Promise<unknown>
    fetchPagesBlock(urls: string[]): Promise<string>
    autoSearchBlock(text: string, search: unknown): Promise<string>
    usageCheck(): unknown
    usageRecord(model: string, p: number, c: number): void
    compactWarnOnce(): boolean | Promise<boolean>
  },
  turnOptsFull: Record<string, unknown>,
  path: AskPath,
  args: unknown[],
): unknown | Promise<unknown> {
  switch (path) {
    case 'executeTool': {
      const [name, argsJson, opts] = args as [string, string, Record<string, unknown>]
      // main からの opts の**前に** turnOptsFull を敷く。値の項目（search/snapshotId/
      // snapshotLabel 等）は main 側の opts が同じ値で上書きするので、今までの
      // { ...turnOpts, search, snapshotId, snapshotLabel } と完全に一致する。
      return handlers.executeTool(name, argsJson, { ...turnOptsFull, ...opts })
    }
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
    case 'usage.check':
      return handlers.usageCheck()
    case 'usage.record': {
      const [model, p, c] = args as [string, number, number]
      return handlers.usageRecord(model, p, c)
    }
    case 'compactWarnOnce':
      return handlers.compactWarnOnce()
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
