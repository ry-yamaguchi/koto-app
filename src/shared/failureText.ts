// 失敗の判定と、画面に出す日本語の文（純関数のみ・electron 非依存）。
// 回線断・時間切れ・安全な接続・フォルダの権限や空きを、投げられた値から見分けて、利用者向けの1文にする。
// 回線断の errno 表と状態番号の見分けは shared/connectionFailure.ts が唯一の定義で、ここはそれを読む。
//
// 判定の順序は固定（tests/failureText.test.ts が固める）:
//  1. IPC の頭（「Error invoking remote method '…': Error: 」）を落とす
//  2. status が数値なら（HTTP の応答が返った失敗）回線断・時間切れに数えない
//  3. 構造の印（code・cause.code・cause.cause.code・cause.errors[0].code・name・構成子名）
//  4. 文面（日本語を含む文は判定にかけない。英語の定型だけを見る）
//  5. どれにも当たらなければ原文のまま
// 時間切れは中断（abort）より先に見る。'The operation was aborted due to timeout' は中断の文面を含む。
import {
  errorCodesOf, isJudgeableMessage, connectionHitOfCode, hitOfCliMessage,
} from './connectionFailure'
import { joinFailureDetail } from './failureDetail'
import { maskSecretShapes } from './secretShapes'
import { maskHomePath } from './homePath'

export type FailureKind = 'offline' | 'tls' | 'interrupted' | 'timeout' | 'fs-denied' | 'fs-full' | 'fs-missing' | 'unknown'
/** 要求が相手に出たか。'no' と言い切れるのは、名前が引けない・つながらない失敗だけ。 */
export type FailureSent = 'no' | 'maybe'

export interface FailureInfo {
  kind: FailureKind
  sent: FailureSent
  code?: string
  status?: number
  /** フォルダ・ファイルの失敗で、例外か文面から読めたパス。 */
  path?: string
  /** IPC の頭を落とした原文。 */
  original: string
}

export interface FailureTextOptions {
  /** 接続テスト・一覧などの読み取り。省略時は書き込み側の慎重な文（操作が済んだかは分からない）。 */
  readOnly?: boolean
  /** 再試行を促す言い方（既定は「もう一度お試しください」。チャットは「もう一度送信してください」）。 */
  tail?: string
  /** 書き込みの途中で切れたとき、状態を確かめる場所（例: ファイル一覧）。無ければ「この画面を開き直して」と言う。 */
  checkAt?: string
  /** false: 詳細の行を付けない。呼び出し元が自分で詳細を運ぶとき（既定は true）。 */
  detail?: boolean
}

/** 詳細の最大の長さ（これを超えたら切って … を付ける）。 */
export const FAILURE_DETAIL_MAX = 240

const REMOTE_HEAD = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/

/** 失敗の値から message を読む（Error でない値も壊れない）。 */
function rawMessageOf(e: unknown): string {
  return (e && typeof e === 'object' && 'message' in e) ? String((e as { message?: unknown }).message) : String(e)
}

// main が IPC の失敗の message の頭に付ける「種類の印」。IPC を越えると例外は message だけの Error になり、
// 構造の印（code・cause・status）が消えるので、main で判定した結果をここに載せて renderer で読み戻す。
// 印の作りと読みはこのファイルの1か所だけ（messageForIpc が作り、classifyFailure が読み、stripRemoteHead が落とす）。
const CARRIED = /^⟦koto-failure ([^⟧]*)⟧/
const FAILURE_KINDS: readonly FailureKind[] = ['offline', 'tls', 'interrupted', 'timeout', 'fs-denied', 'fs-full', 'fs-missing', 'unknown']

/** IPC の頭だけを落とした message（印は残す）。 */
function withoutRemoteHead(e: unknown): string {
  return rawMessageOf(e).replace(REMOTE_HEAD, '')
}

/** ipcRenderer.invoke が失敗を包む英語の頭（「Error invoking remote method '…': Error: 」。TypeError: など別の型名も）と、
 *  main が付けた種類の印（messageForIpc）を落とす。頭も印も無い・形が違うときはそのまま返す。
 *  Error でない値（文字列・undefined など）を渡しても壊れない。 */
export function stripRemoteHead(e: unknown): string {
  return withoutRemoteHead(e).replace(CARRIED, '')
}

/** e.cause・e.cause.cause・e.cause.errors[0] の message（文字列で空でないもの）。 */
function causeMessagesOf(e: unknown): string[] {
  const err = (e && typeof e === 'object' ? e : {}) as { cause?: unknown }
  const c1 = err.cause as { message?: unknown; cause?: unknown; errors?: unknown } | null | undefined
  const c2 = (c1 && typeof c1 === 'object' ? c1.cause : undefined) as { message?: unknown } | null | undefined
  const errs = c1 && typeof c1 === 'object' && Array.isArray(c1.errors) ? c1.errors : []
  const c3 = errs[0] as { message?: unknown } | null | undefined
  return [c1, c2, c3]
    .map(c => (c && typeof c === 'object' ? (c as { message?: unknown }).message : undefined))
    .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
}

/** 原文に、まだ含まれていない原因の message を ` / ` でつなぐ。 */
function appendCauseMessages(base: string, e: unknown): string {
  let out = base
  for (const m of causeMessagesOf(e)) {
    if (!out.includes(m)) out = out ? `${out} / ${m}` : m
  }
  return out
}

/** main で投げ直す失敗の message。判定の結果（種類・要求が出たか・errno 名・状態番号）を頭に載せ、原文はそのまま続ける。
 *  載せるものが無い失敗（見分けられず状態番号も無い）は原文だけ。renderer の classifyFailure が印を読み戻す。 */
export function messageForIpc(e: unknown): string {
  const info = classifyFailure(e)
  if (info.kind === 'unknown' && info.status === undefined) return info.original
  // IPC を越えると cause が消える（ホスト名などが残らない）ので、種類を言い換える回だけ原因の連なりを原文に足す
  const original = info.kind === 'unknown' ? info.original : appendCauseMessages(info.original, e)
  const fields = [`kind=${info.kind}`, `sent=${info.sent}`]
  if (info.code && /^[A-Za-z0-9_:]+$/.test(info.code)) fields.push(`code=${info.code}`)
  if (info.status !== undefined) fields.push(`status=${info.status}`)
  return `⟦koto-failure ${fields.join(' ')}⟧${original}`
}

/** 印を読み戻す。形が違う・知らない種類なら null。 */
function carriedOf(e: unknown): Omit<FailureInfo, 'original' | 'path'> | null {
  const m = CARRIED.exec(withoutRemoteHead(e))
  if (!m) return null
  const f = Object.fromEntries(m[1].split(' ').map(kv => kv.split('=') as [string, string]))
  if (!FAILURE_KINDS.includes(f.kind as FailureKind)) return null
  const info: Omit<FailureInfo, 'original' | 'path'> = { kind: f.kind as FailureKind, sent: f.sent === 'no' ? 'no' : 'maybe' }
  if (f.code) info.code = f.code
  if (/^\d+$/.test(f.status ?? '')) info.status = Number(f.status)
  return info
}

const FS_DENIED_CODES = ['EACCES', 'EPERM', 'EROFS']
const FS_FULL_CODES = ['ENOSPC', 'EDQUOT']
const FS_MISSING_CODES = ['ENOENT', 'ENOTDIR']

type Hit = Pick<FailureInfo, 'kind' | 'sent'>

function hitOfCode(code: string): Hit | null {
  const conn = connectionHitOfCode(code)
  if (conn) return conn
  if (FS_DENIED_CODES.includes(code)) return { kind: 'fs-denied', sent: 'no' }
  if (FS_FULL_CODES.includes(code)) return { kind: 'fs-full', sent: 'maybe' }
  if (FS_MISSING_CODES.includes(code)) return { kind: 'fs-missing', sent: 'no' }
  return null
}

/** Electron の通信の失敗（net::ERR_*）。要求が出ていないと言えるのは、回線が無い・名前が引けないの2つだけ。 */
function hitOfNetError(name: string): Hit {
  if (name === 'INTERNET_DISCONNECTED' || name === 'NAME_NOT_RESOLVED') return { kind: 'offline', sent: 'no' }
  if (/^(?:CERT_|SSL_|TLS_)/.test(name)) return { kind: 'tls', sent: 'maybe' }
  if (/TIMED_OUT$/.test(name)) return { kind: 'timeout', sent: 'maybe' }
  if (/^(?:CONNECTION_(?:RESET|CLOSED|ABORTED)|NETWORK_CHANGED|EMPTY_RESPONSE|ABORTED)$/.test(name)) return { kind: 'interrupted', sent: 'maybe' }
  return { kind: 'offline', sent: 'maybe' }
}

// 'connect ECONNREFUSED 127.0.0.1:443'・'getaddrinfo ENOTFOUND host'・'EACCES: permission denied, open …' の errno 名
const ERRNO_HEAD = /^(?:(?:connect|getaddrinfo|read|write)\s+)?(E[A-Z][A-Z0-9_]*)\b/

/** 構造の印（例外の値そのもの）から見分ける。 */
function hitOfStructure(e: unknown): (Hit & { code?: string }) | null {
  for (const code of errorCodesOf(e)) {
    const hit = hitOfCode(code)
    if (hit) return { ...hit, code }
  }
  const err = (e && typeof e === 'object' ? e : {}) as { name?: unknown; constructor?: { name?: unknown } }
  const ctor = err.constructor?.name
  if (err.name === 'TimeoutError' || ctor === 'APIConnectionTimeoutError') return { kind: 'timeout', sent: 'maybe' }
  if (err.name === 'AbortError') return { kind: 'interrupted', sent: 'maybe' }
  if (ctor === 'APIConnectionError') return { kind: 'offline', sent: 'maybe' }
  return null
}

/** 文面から見分ける。英語の定型だけを見る（日本語を含む文・状態番号で始まる文は見ない。見ない文の決まりは connectionFailure.ts の isJudgeableMessage の1か所）。 */
function hitOfMessage(message: string): (Hit & { code?: string }) | null {
  if (!isJudgeableMessage(message)) return null
  const net = /\bnet::ERR_([A-Z0-9_]+)/.exec(message)
  if (net) return { ...hitOfNetError(net[1]), code: `net::ERR_${net[1]}` }
  const errno = ERRNO_HEAD.exec(message.trim())
  if (errno) {
    const hit = hitOfCode(errno[1])
    if (hit) return { ...hit, code: errno[1] }
  }
  // 時間切れは中断より先。'The operation was aborted due to timeout' は中断の語を含む。
  if (/^request timed out\.?$/i.test(message.trim()) || /aborted due to timeout/i.test(message)) return { kind: 'timeout', sent: 'maybe' }
  if (/\baborted\b/i.test(message)) return { kind: 'interrupted', sent: 'maybe' }
  if (/\bfetch failed\b|\bconnection error\b/i.test(message)) return { kind: 'offline', sent: 'maybe' }
  // 英語の CLI（crane・docker・Claude の CLI・npm）の文。型の定義は connectionFailure.ts
  return hitOfCliMessage(message, hitOfCode)
}

/** 例外の文面のパス。Node の fs の失敗の形だけを読む（形に合わなければ、誤ったパスを言うより言わない）。
 *  errno 名で始まる文の、1つ: 「<syscall> '<path>'」が文末にある（閉じる ' は文末の最後の1つ。パスの中の ' は逃がされずに出るので、Kids' Photos も Taro's も欠けない）。
 *  2つ（rename など）: 「<syscall> '<src>' -> '<dest>'」。元のパス（src）を返す。
 *  どちらの形にも当たらない・区切りの ' -> ' がパスの中にもあって分け方が決まらないときは undefined。 */
function pathOfMessage(message: string): string | undefined {
  const tail = /^(?:\w*Error:\s*)?E[A-Z0-9_]+:\s[^']*?,\s\w+\s'(.*)'\s*$/.exec(message)?.[1]
  if (tail === undefined || tail === '') return undefined
  const parts = tail.split("' -> '")
  if (parts.length === 1) return tail
  // 2つのパス。区切りが1つだけのときだけ決められる（パスの中に ' -> ' が混ざると分け方が複数ある）
  return parts.length === 2 && parts[0] !== '' && parts[1] !== '' ? parts[0] : undefined
}

/** 投げられた値から、失敗の種類・要求が出たか・パスを読む。 */
export function classifyFailure(e: unknown): FailureInfo {
  const original = stripRemoteHead(e)
  const err = (e && typeof e === 'object' ? e : {}) as { status?: unknown; path?: unknown }
  const status = typeof err.status === 'number' ? err.status : undefined
  // HTTP の応答が返った失敗は、回線断・時間切れに数えない
  if (status !== undefined) return { kind: 'unknown', sent: 'maybe', status, original }
  // main で判定して IPC に載せた印があれば、それが判定（IPC を越えた値は構造の印を失っている）
  const carried = carriedOf(e)
  if (carried?.status !== undefined) return { ...carried, original }
  const hit = carried ?? hitOfStructure(e) ?? hitOfMessage(original)
  if (!hit) return { kind: 'unknown', sent: 'maybe', original }
  const info: FailureInfo = { kind: hit.kind, sent: hit.sent, original }
  if (hit.code) info.code = hit.code
  if (hit.kind.startsWith('fs-')) {
    const path = typeof err.path === 'string' && err.path !== '' ? err.path : pathOfMessage(original)
    if (path) info.path = path
  }
  return info
}

const RETRY = 'もう一度お試しください'

/** 書き込みの途中で切れた（または切れたかもしれない）ときの文。「もう一度」とは言わない（二重に作る・二重に課金されるおそれがある）。 */
function interruptedWriteText(checkAt: string | undefined): string {
  const where = checkAt?.trim() ? `${checkAt.trim()}で` : 'この画面を開き直して'
  return `通信が途中で切れました。操作が済んだかは確かめられていません。少し待ってから、${where}状態を確かめてください。`
}

/** 失敗を利用者向けの日本語1文にする。見分けられない失敗は原文のまま返す（IPC の頭だけ落とす）。
 *  既定は書き込み側の慎重な文。接続テスト・一覧などの読み取りだけ readOnly: true。 */
export function failureText(e: unknown, opts: FailureTextOptions = {}): string {
  const info = classifyFailure(e)
  if (info.kind === 'unknown') return info.original
  const sentence = sentenceOf(info, opts)
  return opts.detail === false ? sentence : joinFailureDetail(sentence, failureDetailOf(e))
}

/** コピーに足す文（API の応答など）の秘密の形とホームのパスを伏せる。 */
export function maskForCopy(text: string): string {
  return maskHomePath(maskSecretShapes(text))
}

/** 置き換えた日本語の文に、原文（詳細）を添える。自前の固定文で原文を捨てる所が使う。 */
export function withFailureDetail(sentence: string, e: unknown): string {
  return joinFailureDetail(sentence, failureDetailOf(e))
}

/** 置き換えた文に添える原文。原因の連なり・符号・状態番号を足し、秘密の形とホームのパスを伏せて、長ければ切る。無ければ ''。 */
export function failureDetailOf(e: unknown): string {
  // 値が無い失敗は、文字にすると 'undefined' になるので詳細を付けない
  if (e === undefined || e === null) return ''
  const info = classifyFailure(e)
  let out = appendCauseMessages(info.original, e)
  const add = (piece: string): void => {
    out = out ? `${out} / ${piece}` : piece
  }
  for (const code of [...errorCodesOf(e), info.code]) {
    if (code && !out.includes(code)) add(code)
  }
  if (typeof info.status === 'number' && !out.includes(String(info.status))) add(`HTTP ${info.status}`)
  // 行頭を前提にする秘密の形（ENV 名 値 など）が当たるよう、改行をまとめる前に伏せる。
  // 伏せてから切る（切れ目にかかった秘密の前半を残さない）。URL のクエリは署名などが入りうるので、原因の見分けに要らない分を落とす。
  const noQuery = maskSecretShapes(out).replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, '$1?…')
  const masked = maskHomePath(noQuery).replace(/\s+/g, ' ').trim()
  return masked.length > FAILURE_DETAIL_MAX ? `${masked.slice(0, FAILURE_DETAIL_MAX)}…` : masked
}

// 権限で断られた操作が読み取りか。readOnly は「もう一度押してよいか」の印でもあり（手元のフォルダを作る取得・npm install も readOnly）、
// それだけでは読み書きを決められないので、文面の操作名（Node の「…, mkdir '<path>'」・npm の「syscall mkdir」）を先に見る。
// open は読み書きどちらでも出るので、そのときだけ readOnly に従う。
const READ_SYSCALLS = new Set(['scandir', 'opendir', 'readdir', 'stat', 'lstat', 'readlink', 'read', 'access'])
function isReadingDenied(original: string, opts: FailureTextOptions): boolean {
  const syscall = (/,\s(\w+)\s'[^']*'/.exec(original) ?? /\bsyscall\s+(\w+)/.exec(original))?.[1]
  if (syscall === undefined || syscall === 'open') return opts.readOnly === true
  return READ_SYSCALLS.has(syscall)
}

function sentenceOf(info: FailureInfo, opts: FailureTextOptions): string {
  const retry = (opts.tail ?? RETRY).replace(/。$/, '')
  const pathNote = info.path ? `（${info.path}）` : ''
  switch (info.kind) {
    case 'offline':
      // 要求が出ていないと言い切れる失敗は、書き込みでも「もう一度」と言ってよい
      if (opts.readOnly || info.sent === 'no') return `インターネットに接続できませんでした。接続を確かめてから、${retry}。`
      return interruptedWriteText(opts.checkAt)
    case 'tls':
      return '安全な接続を確認できませんでした。社内ネットワークやセキュリティソフトの設定を確かめてください。'
    case 'interrupted':
    case 'timeout':
      // 要求が出ていないと言い切れる失敗（つながる前に止まった）は、書き込みでも「済んだか」を言わない
      if (opts.readOnly || (info.kind === 'timeout' && info.sent === 'no')) return `時間内に返事がありませんでした。混み合っているかもしれません。少し待ってから、${retry}。`
      return interruptedWriteText(opts.checkAt)
    case 'fs-denied':
      // 読み取りで断られたのに「書き込めません」「別の場所を選ぶか」と言うと、原因も直し方も取り違える
      if (isReadingDenied(info.original, opts)) return `読み込めませんでした${pathNote}。Finder で権限を確かめてください。`
      return `このフォルダには書き込めません${pathNote}。別の場所を選ぶか、Finder で権限を確かめてください。`
    case 'fs-full':
      return `ディスクの空きが足りません。空きを作ってから、${retry}。`
    case 'fs-missing':
      return `ファイルまたはフォルダが見つかりませんでした${pathNote}。`
    default:
      return info.original
  }
}
