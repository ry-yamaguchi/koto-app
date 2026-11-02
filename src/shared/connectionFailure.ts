// 回線が切れて AI のサービスへ届かなかった失敗かどうかの判定（純関数のみ）。
// 接続テスト（main/ipc/sakura.ts の describeSakuraError）とチャットの失敗文（aiToolsCore.ts の formatChatError）が
// 同じこれを通る。判定を2か所で持つと、片方だけ直されて言い分けがずれる。
// 状態番号のある失敗は本文に network などを含むことがあるので回線断に数えない（接続テストとチャットで同じ扱いにするため）。

// 文面が状態番号で始まる（openai・Anthropic の SDK は「<状態番号> <本文>」の形で投げる）。
// IPC で包まれると「Error invoking remote method '…': Error: 400 …」、Claude は「API Error: 404 …」になる。
// 'connect ETIMEDOUT 203.0.113.5:500' のようにアドレスの数字は、行頭でも「error」の後ろでもないので当たらない。
const STATUS_PREFIXED = /(?:^\s*|\berror:?\s+)[1-5]\d\d\b/i

/** エラーの文面から回線断を見分ける（SDK の 'Connection error.'・Node の errno 名・fetch の 'fetch failed'）。 */
export function isConnectionFailureMessage(message: string): boolean {
  if (STATUS_PREFIXED.test(message)) return false
  return /connection error|enotfound|econnrefused|econnreset|etimedout|eai_again|fetch failed|network/i.test(message)
}

const CONNECTION_ERROR_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']

/** 投げられた値そのものから回線断を見分ける。HTTP の応答が返った失敗（status が数値）は数えない。
 *  それ以外は errno 名（cause.code か code）か、文面のどちらかが当たれば真。 */
export function isConnectionFailure(e: unknown): boolean {
  const err = (e ?? {}) as { message?: unknown; status?: unknown; code?: unknown; cause?: { code?: unknown } }
  if (typeof err.status === 'number') return false
  for (const code of [err.cause?.code, err.code]) {
    if (typeof code === 'string' && CONNECTION_ERROR_CODES.includes(code)) return true
  }
  const message = typeof err.message === 'string' ? err.message : String(e ?? '')
  return isConnectionFailureMessage(message)
}
