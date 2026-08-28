// askBridge.ts — main → renderer への問い合わせ（ask）の帳簿。electron 非依存の純粋なロジックで、
// 単体テストの対象（tests/askBridge.test.ts）。
//
// ── なぜ要るか（B'-3b）─────────────────────────────────────────────
// main で走るターン（turnRunner.ts）は、renderer にしか無い副作用（ツール実行・承認・
// システムプロンプト組み立て等・shared/chatTurnRpc.ts の ASK_PATHS）を IPC 経由で呼ぶ。
// 呼び出しは非同期・複数が同時に飛ぶことがあるため、「どの答えがどの問い合わせに対応するか」を
// callId で対応付けて管理する必要がある。turnRunner.ts はこのモジュールを呼ぶだけの薄い配線にし、
// 対応付けそのもの（帳簿の出し入れ）はここへ一元化する（掟10: 守りのコードは一元化してテストする）。

import type { AskPath, TurnAsk } from '../../shared/chatTurnRpc'

/** callId の採番。連番＋乱数（衝突しなければ形は問わない・仕様書どおり）。 */
let callSeq = 0
function nextCallId(): string {
  callSeq += 1
  return `${callSeq}-${Math.random().toString(36).slice(2)}`
}

type PendingEntry = { resolve: (result: unknown) => void; reject: (err: Error) => void }

export type AskBridge = {
  /** renderer へ問い合わせ、答えが返るまで待つ Promise を返す。 */
  ask(path: AskPath, args: unknown[]): Promise<unknown>
  /** renderer からの回答を帳簿へ反映する。知らない callId・二重回答は false を返して無視する。 */
  answer(a: { callId: string; ok: boolean; result?: unknown; error?: string }): boolean
  /** 未解決の ask を全部 reject する（画面が閉じられた等）。 */
  rejectAll(reason: string): void
  /** 未解決の ask の件数。 */
  pendingCount(): number
}

/**
 * ask の帳簿を持つブリッジを作る。
 *
 * @param send `chatTurn:ask:{turnId}` などへ実際に送る関数（turnRunner.ts が wc.send を渡す）。
 *   ここでは何チャンネルへ送るかを知らない（呼び出し側の関心事）。
 */
export function createAskBridge(send: (ask: TurnAsk) => void): AskBridge {
  const pending = new Map<string, PendingEntry>()

  function ask(path: AskPath, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const callId = nextCallId()
      pending.set(callId, { resolve, reject })
      send({ callId, path, args })
    })
  }

  function answer(a: { callId: string; ok: boolean; result?: unknown; error?: string }): boolean {
    const entry = pending.get(a.callId)
    if (!entry) return false // 知らない callId・二重回答（1回目で既に帳簿から消えている）は無視
    pending.delete(a.callId)
    if (a.ok) entry.resolve(a.result)
    else entry.reject(new Error(a.error ?? '不明なエラーです'))
    return true
  }

  function rejectAll(reason: string): void {
    for (const entry of pending.values()) entry.reject(new Error(reason))
    pending.clear()
  }

  function pendingCount(): number {
    return pending.size
  }

  return { ask, answer, rejectAll, pendingCount }
}
