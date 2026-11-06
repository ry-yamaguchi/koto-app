// 回線が切れて AI のサービスへ届かなかった失敗かどうかの判定（純関数のみ）。
// 接続テスト（main/ipc/sakura.ts の describeSakuraError）とチャットの失敗文（aiToolsCore.ts の formatChatError）が
// 同じこれを通る。判定を2か所で持つと、片方だけ直されて言い分けがずれる。
// 判定の主は shared/failureText.ts（時間切れ・安全な接続も見分ける）。ここは errno 名の表と、
// そこで見分けられない回線断の文面（'request to … failed, reason: …' など）を拾う第二の網。
// 状態番号のある失敗は本文に network などを含むことがあるので回線断に数えない（接続テストとチャットで同じ扱いにするため）。
// 日本語を含む文（Koto 自身の文や、利用者の語を含む文）も、英語の語（network など）だけで回線断に数えない。
// errno 名の表もここが唯一の定義（失敗の文を作る shared/failureText.ts もこの表を読む）。

// 文面が状態番号で始まる（openai・Anthropic の SDK は「<状態番号> <本文>」の形で投げる）。
// IPC で包まれると「Error invoking remote method '…': Error: 400 …」、Claude は「API Error: 404 …」になる。
// 'connect ETIMEDOUT 203.0.113.5:500' のようにアドレスの数字は、行頭でも「error」の後ろでもないので当たらない。
const STATUS_PREFIXED = /(?:^\s*|\berror:?\s+)[1-5]\d\d\b/i

/** 文面が状態番号で始まる（HTTP の応答が返った失敗）。本文に network などを含んでも回線断に数えない。 */
export function hasStatusPrefix(message: string): boolean {
  return STATUS_PREFIXED.test(message)
}

const JAPANESE = /[　-ヿ㐀-鿿＀-￯]/

/** 文面の判定にかけてよい文か。状態番号で始まる文（HTTP の応答が返った失敗）と、日本語を含む文（Koto 自身の文・利用者の語を含む文）は見ない。
 *  文面で見分ける判定は、すべてこれを通す（failureText.ts の hitOfMessage・下の isConnectionFailureMessage）。守りを2か所に書くと、片方だけ抜ける。 */
export function isJudgeableMessage(message: string): boolean {
  return !hasStatusPrefix(message) && !JAPANESE.test(message)
}

/** エラーの文面から回線断を見分ける（SDK の 'Connection error.'・Node の errno 名・fetch の 'fetch failed'・英語の CLI の文）。 */
export function isConnectionFailureMessage(message: string): boolean {
  if (!isJudgeableMessage(message)) return false
  return /connection error|enotfound|econnrefused|econnreset|etimedout|eai_again|fetch failed|network/i.test(message)
    || isCliConnectionMessage(message)
}

/** 英語の CLI の文のうち回線断として数えるもの。符号の無い時間切れ（'Request timed out.' など）は数えない
 *  （つなぐ前の失敗ではなく、返事が来なかっただけなので、チャットでは時間切れの文のまま言う）。 */
function isCliConnectionMessage(message: string): boolean {
  const hit = hitOfCliMessage(message)
  return hit !== null && !(hit.kind === 'timeout' && hit.code === undefined)
}

/** 名前が引けない・つながらない errno。要求はまだ出ていないと言い切れる。 */
export const UNSENT_ERROR_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']
/** 送ったあとで切れた errno。要求が相手に届いたかは分からない。 */
export const INTERRUPTED_ERROR_CODES = ['ECONNRESET', 'EPIPE', 'ECONNABORTED']
/** 時間切れの errno。つなぐ前か後かは分からない。 */
export const TIMEOUT_ERROR_CODES = ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']
/** 安全な接続（TLS）を確かめられなかった印。証明書の検証失敗とプロトコルの不一致。 */
export const TLS_ERROR_CODES = [
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'EPROTO',
]

const CONNECTION_ERROR_CODES = [...UNSENT_ERROR_CODES, ...INTERRUPTED_ERROR_CODES, ...TIMEOUT_ERROR_CODES, ...TLS_ERROR_CODES]

/** 投げられた値から errno 風の印（文字列の code）を、近い順に集める。
 *  e.code → e.cause.code → e.cause.cause.code → e.cause.errors[0].code。
 *  openai の APIConnectionError は fetch の失敗を cause に包み、その cause も errno を cause に持つ（DOMException の code は数値なので数えない）。 */
export function errorCodesOf(e: unknown): string[] {
  const err = (e && typeof e === 'object' ? e : {}) as { code?: unknown; cause?: { code?: unknown; cause?: { code?: unknown }; errors?: Array<{ code?: unknown } | undefined> } }
  const found = [err.code, err.cause?.code, err.cause?.cause?.code, err.cause?.errors?.[0]?.code]
  return found.filter((c): c is string => typeof c === 'string' && c !== '')
}

/** 投げられた値そのものから回線断を見分ける。HTTP の応答が返った失敗（status が数値）は数えない。
 *  それ以外は errno 名（cause.code か code）か、文面のどちらかが当たれば真。 */
export function isConnectionFailure(e: unknown): boolean {
  const err = (e ?? {}) as { message?: unknown; status?: unknown }
  if (typeof err.status === 'number') return false
  if (errorCodesOf(e).some(code => CONNECTION_ERROR_CODES.includes(code))) return true
  const message = typeof err.message === 'string' ? err.message : String(e ?? '')
  return isConnectionFailureMessage(message)
}

/** 回線断の種類。 */
export type ConnectionKind = 'offline' | 'tls' | 'interrupted' | 'timeout'
/** 要求が相手に出たか。'no' と言い切れるのは、名前が引けない・つながらない失敗だけ。 */
export type ConnectionSent = 'no' | 'maybe'
export interface ConnectionHit { kind: ConnectionKind; sent: ConnectionSent }

/** errno 名から回線断の種類を見分ける（回線断の errno だけ。手元のファイルの errno は見ない）。 */
export function connectionHitOfCode(code: string): ConnectionHit | null {
  if (UNSENT_ERROR_CODES.includes(code)) return { kind: 'offline', sent: 'no' }
  if (INTERRUPTED_ERROR_CODES.includes(code)) return { kind: 'interrupted', sent: 'maybe' }
  if (TIMEOUT_ERROR_CODES.includes(code)) return { kind: 'timeout', sent: 'maybe' }
  if (TLS_ERROR_CODES.includes(code)) return { kind: 'tls', sent: 'maybe' }
  return null
}

// 英語の CLI（Go 製の crane・docker、Claude の CLI、npm）が出す回線断の文。型の定義はここだけで、
// 失敗の種類を決める failureText.ts の hitOfMessage と、回線断かを問う isConnectionFailureMessage の両方がこれを読む。
// 上から順に見る。dial と TLS handshake の時間切れは接続の前なので 'no'、それ以外の時間切れ・切断は届いたか分からないので 'maybe'。
const CLI_PATTERNS: ReadonlyArray<{ re: RegExp; hit: ConnectionHit }> = [
  { re: /\bno such host\b/i, hit: { kind: 'offline', sent: 'no' } },
  { re: /\bdial tcp\b[^\n]*\bi\/o timeout\b/i, hit: { kind: 'timeout', sent: 'no' } },
  { re: /\bTLS handshake timeout\b/i, hit: { kind: 'timeout', sent: 'no' } },
  { re: /\bClient\.Timeout exceeded\b/, hit: { kind: 'timeout', sent: 'maybe' } },
  { re: /\bcontext deadline exceeded\b/i, hit: { kind: 'timeout', sent: 'maybe' } },
  { re: /\bconnect: (?:connection refused|network is unreachable)\b/i, hit: { kind: 'offline', sent: 'no' } },
  { re: /\b(?:connection reset by peer|broken pipe|unexpected EOF)\b/i, hit: { kind: 'interrupted', sent: 'maybe' } },
  { re: /\bhttp2: server sent GOAWAY\b/i, hit: { kind: 'interrupted', sent: 'maybe' } },
  { re: /\bx509: /, hit: { kind: 'tls', sent: 'maybe' } },
  { re: /\bRequest timed out\b/i, hit: { kind: 'timeout', sent: 'maybe' } },
]

const CLAUDE_TLS = /\bUnable to connect to API\b[^\n]*(?:SSL|certificate)/i
const CLAUDE_CODE = /\bUnable to connect to API \((E[A-Z0-9_]+)\)/
const NPM_CODE = /\bnpm (?:ERR!|error) code (E[A-Z0-9_]+)\b/

/** 英語の CLI の文から回線断を見分ける。呼び出し側は isJudgeableMessage を通した文だけを渡す。
 *  符号（Claude の「Unable to connect to API (ENOTFOUND)」・npm の code）は codeHit で読む（既定は回線断の errno だけ。
 *  failureText.ts は手元のファイルの errno も読む関数を渡す）。当たらなければ null。 */
export function hitOfCliMessage<H extends { kind: string; sent: ConnectionSent }>(
  message: string,
  codeHit: (code: string) => H | null = connectionHitOfCode as (code: string) => H | null,
): ((H | ConnectionHit) & { code?: string }) | null {
  if (CLAUDE_TLS.test(message)) return { kind: 'tls', sent: 'maybe' }
  const claude = CLAUDE_CODE.exec(message)
  if (claude) {
    const hit = codeHit(claude[1])
    return hit ? { ...hit, code: claude[1] } : { kind: 'offline', sent: 'maybe' }
  }
  const npm = NPM_CODE.exec(message)
  if (npm) {
    const hit = codeHit(npm[1])
    if (hit) return { ...hit, code: npm[1] }
  }
  for (const { re, hit } of CLI_PATTERNS) {
    if (re.test(message)) return { ...hit }
  }
  return null
}
