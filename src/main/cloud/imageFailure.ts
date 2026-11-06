// imageFailure.ts — 組み立て・push・ログインの失敗が「回線断」「手元のファイル」「それ以外」のどれかを見分ける。
//
// 英語の道具（crane・docker・npm）の失敗は、そのままでは「レジストリの不調」「package.json の記述ミス」
// と取り違えやすい。回線が切れていても `no such host` が出て、レジストリが消えたときと同じに見えるため。
// 失敗の種類は shared/failureText.ts の classifyFailure が決め、ここは「その種類のとき、どの文を出すか」だけを持つ。
import { classifyFailure, failureText, withFailureDetail, type FailureTextOptions } from '../../shared/failureText'
import { looksLikeRegistryProblem } from '../../shared/registryTrouble'
import { probeOnline } from '../net/onlineProbe'

const NETWORK_KINDS: readonly string[] = ['offline', 'timeout', 'tls', 'interrupted']
/** さくらのコンテナレジストリのホスト。ここへの失敗だけは「レジストリの不調」の可能性が残る。 */
const SAKURA_REGISTRY_HOST = /\.sakuracr\.jp\b/i

export type ImageFailureVerdict =
  /** 回線断・手元のファイルの失敗。message は日本語の文（詳細つき）。レジストリや package.json のせいにしない。 */
  | { handled: true; message: string }
  /** 見分けられない、またはレジストリへつながっているのに失敗した。呼び出し側が今までの見立てを使う。
   *  networkLike: 回線系の失敗だった（今までの見立ての文に、原文を詳細として添える）。 */
  | { handled: false; networkLike: boolean }

export interface ImageFailureDeps {
  probeOnline?: () => Promise<boolean>
}

/** 失敗の原文から、出す文を決める。 */
export async function diagnoseImageFailure(
  raw: string,
  opts: FailureTextOptions = {},
  deps: ImageFailureDeps = {},
): Promise<ImageFailureVerdict> {
  const info = classifyFailure(raw)
  if (info.kind.startsWith('fs-')) return { handled: true, message: failureText(raw, opts) }
  if (!NETWORK_KINDS.includes(info.kind)) return { handled: false, networkLike: false }
  // 相手がレジストリ以外（docker.io・npm など）なら、回線の文でよい。
  // 時間切れ・途中の切断・証明書の失敗はレジストリが消えたからではないので、相手に関係なく回線の文にする。
  // 名前が引けない（offline）ときだけ、消えたレジストリも同じ文になるので、相手がレジストリなら本当に回線が切れているかを別に確かめる
  if (info.kind === 'offline' && SAKURA_REGISTRY_HOST.test(raw)) {
    const online = await (deps.probeOnline ?? probeOnline)()
    if (online) return { handled: false, networkLike: true }
  }
  return { handled: true, message: failureText(raw, opts) }
}

/** 公開の失敗の返り値（prepareAppImage の ok:false と同じ形）。 */
export interface ImageFailureResult {
  ok: false
  message: string
  detail?: string
  hint?: 'reset-registry'
}

const BUILD_SENTENCE = 'アプリのビルド（Docker）に失敗しました。よくある原因: Dockerfile の記述ミス、存在しないライブラリ名、対応していないベースイメージ。'
const LOGIN_SENTENCE = 'レジストリへのログインに失敗しました。下の「レジストリを設定し直す」で push 用のパスワードを作り直してから、もう一度お試しください。'
const PUSH_SENTENCE = 'レジストリへのプッシュに失敗しました。インターネット接続を確認して、もう一度お試しください。'
const REGISTRY_SENTENCE = 'コンテナレジストリへプッシュできませんでした。'
  + '削除された、または接続情報が古い可能性があります。'
  + '下の「レジストリを設定し直す」を押してから、もう一度お試しください。'
const BUILTIN_SENTENCE = 'アプリのビルドに失敗しました。よくある原因: package.json の記述ミス、存在しないライブラリ名、対応していないベースイメージ。'

/** つながっているのに回線系の失敗だったときは、今までの見立ての文に原文を詳細として添える。 */
function withReachable(sentence: string, networkLike: boolean, raw: string | undefined): string {
  return networkLike ? withFailureDetail(sentence, raw) : sentence
}

/** エキスパート（Docker）: docker build の失敗。 */
export async function dockerBuildFailure(log: string, deps: ImageFailureDeps = {}): Promise<ImageFailureResult> {
  const v = await diagnoseImageFailure(log, { readOnly: true }, deps)
  // コンテナの中の npm の権限・空きの失敗は、手元のフォルダのせいではない（Dockerfile を直す）ので、手元のファイルの文にしない
  if (v.handled && !classifyFailure(log).kind.startsWith('fs-')) return { ok: false, message: v.message, detail: log }
  return { ok: false, message: BUILD_SENTENCE, detail: log }
}

/** エキスパート（Docker）: docker login の失敗。回線断のときに「パスワードを作り直して」と案内しない。 */
export async function dockerLoginFailure(message: string, deps: ImageFailureDeps = {}): Promise<ImageFailureResult> {
  const v = await diagnoseImageFailure(message, { readOnly: true }, deps)
  if (v.handled) return { ok: false, message: v.message, detail: message }
  return { ok: false, hint: 'reset-registry', message: withReachable(LOGIN_SENTENCE, v.networkLike, message), detail: message }
}

/** エキスパート（Docker）: docker push の失敗。 */
export async function dockerPushFailure(log: string, deps: ImageFailureDeps = {}): Promise<ImageFailureResult> {
  const v = await diagnoseImageFailure(log, {}, deps)
  if (v.handled) return { ok: false, message: v.message, detail: log }
  return { ok: false, message: withReachable(PUSH_SENTENCE, v.networkLike, log), detail: log }
}

/**
 * 標準（内蔵ビルダー）: 組み立て・push の失敗。
 * 回線断・手元のファイルの失敗はその文にし、レジストリの不調（消えた・接続情報が古い）はレジストリのボタンへ案内する。
 * npm の失敗は npmInstall が種類を見分けた文を作っている（diagnosed）ので、そのまま見出しにする。
 */
export async function builtinBuildFailure(
  built: { message?: string; log: string; diagnosed?: boolean },
  deps: ImageFailureDeps = {},
): Promise<ImageFailureResult> {
  const detail = [built.message, built.log].filter(Boolean).join('\n')
  const verdict: ImageFailureVerdict = built.diagnosed
    ? { handled: true, message: built.message ?? '' }
    : await diagnoseImageFailure(detail, {}, deps)
  if (verdict.handled) return { ok: false, message: verdict.message, detail }
  const registryTrouble = looksLikeRegistryProblem(detail)
  return {
    ok: false,
    ...(registryTrouble ? { hint: 'reset-registry' as const } : {}),
    message: registryTrouble ? withReachable(REGISTRY_SENTENCE, verdict.networkLike, built.message) : BUILTIN_SENTENCE,
    detail,
  }
}
