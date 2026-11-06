// ssh / scp / ssh-keyscan の stderr から、回線の失敗を見分ける。
// ssh の文面は Go の道具や Node の errno とは違う（'Network is unreachable'・'Connection closed by …'）ので、
// 見分けた符号を付けた Error にして、共通の failureText に渡す。見分けられない文は null（呼び出し側が今までどおり扱う）。
import { classifyFailure, failureText, type FailureTextOptions } from '../shared/failureText'

export interface SshFailureFlags {
  /** 時間切れで子プロセスを止めた（stderr が空のことが多い）。 */
  timedOut?: boolean
}

/** stderr を原文にした Error。回線の失敗と読めるときだけ errno 名の code を付ける。 */
export function sshFailureOf(stderr: string, flags: SshFailureFlags = {}): Error {
  const text = (stderr || '').trim()
  const s = text.toLowerCase()
  let code: string | undefined
  if (s.includes('network is unreachable')) code = 'ENETUNREACH'
  else if (s.includes('no route to host')) code = 'EHOSTUNREACH'
  else if (/connection reset by|broken pipe|connection closed by|closed by remote host/.test(s)) code = 'ECONNRESET'
  else if (flags.timedOut) code = 'ETIMEDOUT'
  return Object.assign(new Error(text), code ? { code } : {})
}

/** 回線の失敗なら共通の日本語の文（＋詳細）。そうでなければ null。 */
export function sshNetworkFailureText(stderr: string, opts: FailureTextOptions & SshFailureFlags = {}): string | null {
  const err = sshFailureOf(stderr, opts)
  return classifyFailure(err).kind === 'unknown' ? null : failureText(err, opts)
}
