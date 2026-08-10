// streamDelta.ts — OpenAI互換ストリーミング応答の組み立て（純粋ロジック）。
//
// さくらのAI Engine の応答は「本文」「思考（reasoning）」「ツール呼び出し」が
// 細かい断片（デルタ）に分かれて届く。特にツール呼び出しは
//   1回目: {index:0, id:'call_1', function:{name:'write_'}}
//   2回目: {index:0, function:{name:'file'}}
//   3回目: {index:0, function:{arguments:'{"path"'}}
// のように名前も引数も分割されて来るため、index ごとに継ぎ足して復元する必要がある。
//
// ── なぜ切り出したか（2026-08-05） ──────────────────────────────────────────
// この組み立ては src/main/ipc/sakura.ts の ipcMain ハンドラの中に直接書かれており、
// electron に依存するため**単体テストが一切できなかった**。チャットの中枢であり、
// ここが壊れると「AIが作業したはずなのに何も起きない」「引数が壊れて誤ったファイルを書く」
// といった分かりにくい不具合になる。同じ構造（テストできない場所に重要ロジック）が
// 「前の状態に戻す」のバグを隠していたため、こちらも純粋関数へ出した。
//
// 挙動は移動前とまったく同じにしてある（tests/streamDelta.test.ts が現在の仕様を固定する）。

export interface ToolCallAcc {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface StreamState {
  /** 到着した本文の全文（renderer へは差分で送るが、完了判定などのため保持する）。 */
  content: string
  /** 推論型モデルの思考。本文が空のときのフォールバックに使う。 */
  reasoning: string
  /** index ごとのツール呼び出し。歯抜けになり得るので配列で持つ。 */
  toolCalls: (ToolCallAcc | undefined)[]
  /** 最後に届いた usage（トークン数）。 */
  usage: any
}

export function newStreamState(): StreamState {
  return { content: '', reasoning: '', toolCalls: [], usage: null }
}

/** 1チャンクを取り込み、**このチャンクで新たに届いた分**（画面へ流す差分）を返す。 */
export function applyChunk(state: StreamState, chunk: any): { contentDelta: string; reasoningDelta: string } {
  if (chunk?.usage) state.usage = chunk.usage
  const delta: any = chunk?.choices?.[0]?.delta ?? {}

  let contentDelta = ''
  if (delta.content) {
    contentDelta = String(delta.content)
    state.content += contentDelta
  }

  // 提供側によって reasoning_content / reasoning のどちらで来るかが違う
  const rd = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
    : typeof delta.reasoning === 'string' ? delta.reasoning : null
  let reasoningDelta = ''
  if (rd) {
    reasoningDelta = rd
    state.reasoning += rd
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      // index が無い提供側もある。その場合はすべて 0 番として1件に継ぎ足される
      // （並行して複数のツールを呼ぶ提供側が index を省くと混ざるが、OpenAI互換の仕様上
      //   ストリーミングでは index が付く。推測で変えず、現在の挙動を維持する）。
      const i = tc?.index ?? 0
      if (!state.toolCalls[i]) state.toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
      const acc = state.toolCalls[i]!
      if (tc?.id) acc.id = tc.id
      if (tc?.function?.name) acc.function.name += tc.function.name
      if (tc?.function?.arguments) acc.function.arguments += tc.function.arguments
    }
  }

  return { contentDelta, reasoningDelta }
}

/** 完了時に renderer へ渡すツール呼び出し（歯抜けを詰める）。1件も無ければ null。 */
export function finishedToolCalls(state: StreamState): ToolCallAcc[] | null {
  const list = state.toolCalls.filter(Boolean) as ToolCallAcc[]
  return list.length ? list : null
}
