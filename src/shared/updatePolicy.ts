// updatePolicy.ts — 自動更新の「いつ何をしてよいか」の判定（純粋ロジック）。
//
// ── なぜ判定を切り出すか ────────────────────────────────────────────────
// 更新の事故は「勝手に再起動されて作業が消える」形で起きる。Koto の利用者は
// 非エンジニアで、消えたものを自力で復旧できない。**判定はここ1箇所に集め、
// テストで固定する**（掟10）。electron に依存しないので単体テストできる。
//
// docs/update-plan.md の段階2で決めた必須要件のうち、判定で担保するのは次の2つ:
//   1. 作業中に再起動しない（未保存の変更・実行中の処理があるときは適用しない）
//   2. 既定は「次回起動時に適用」（利用者が明示的に押したときだけ即時再起動）
// あわせて、更新の確認が失敗したときの画面の1行も、ここの updateFailureText が唯一の作り手。

import { classifyFailure, withFailureDetail, type FailureKind } from './failureText'

/** 更新の状態。renderer の表示もこの型で分岐する。 */
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'none' }
  /** message は画面にそのまま出す1行の日本語（updateFailureText の文か、開発中の断り）。英語の原文は更新の記録にだけ残る。 */
  | { kind: 'error'; message: string }

/** いま再起動して更新を適用してよいか。 */
export type ApplyDecision =
  | { ok: true }
  | { ok: false; reason: 'not-downloaded' | 'busy' | 'unsaved'; message: string }

/**
 * 「いますぐ再起動して適用する」を許してよいか（純関数）。
 *
 * **作業中は必ず断る。** 更新は待てるが、失われた作業は戻らない。
 * 断ったときは、なぜ断ったかと次にどうすればよいかを利用者に伝えられる文言を返す。
 */
export function canApplyNow(opts: {
  state: UpdateState
  isBusy: boolean
  busyLabel?: string
  hasUnsavedChanges: boolean
}): ApplyDecision {
  if (opts.state.kind !== 'downloaded') {
    return {
      ok: false,
      reason: 'not-downloaded',
      message: '更新の準備がまだ終わっていません。ダウンロードが終わってからもう一度お試しください。',
    }
  }
  // 実行中を先に見る。中断の実害が大きいため（AI応答・公開処理・VPS操作）
  if (opts.isBusy) {
    return {
      ok: false,
      reason: 'busy',
      message: `${opts.busyLabel || '処理'}が進行中です。終わってから更新してください。`,
    }
  }
  if (opts.hasUnsavedChanges) {
    return {
      ok: false,
      reason: 'unsaved',
      message: '保存していない変更があります。保存してから更新してください。',
    }
  }
  return { ok: true }
}

/**
 * 自動で更新を確認してよいか（純関数）。
 *
 * 開発中は確認しない（配信元に開発版は無く、毎回エラーになるだけ）。
 * 利用者が設定で切っていれば確認しない。
 */
export function shouldCheckOnStartup(opts: { isPackaged: boolean; enabled: boolean }): boolean {
  return opts.isPackaged && opts.enabled
}

/**
 * 更新の状態を、利用者に見せる短い文にする（純関数）。
 *
 * 画面には素のテキストとして出るので **Markdown 記法は使わない**（v0.2.98 の教訓）。
 */
export function updateStatusText(state: UpdateState): string {
  switch (state.kind) {
    case 'idle': return ''
    case 'checking': return '新しいバージョンがあるか確認しています…'
    case 'available': return `新しいバージョン ${state.version} が見つかりました。ダウンロードしています…`
    case 'downloading': return `新しいバージョン ${state.version} をダウンロードしています…（${Math.round(state.percent)}%）`
    case 'downloaded': return `新しいバージョン ${state.version} の準備ができました。次に Koto を起動したときに切り替わります。`
    case 'none': return 'お使いのバージョンは最新です。'
    case 'error': return state.message
  }
}

const UPDATE_OFFLINE = '更新を確認できませんでした。インターネットに接続してから、もう一度お試しください。'
const UPDATE_OTHER = '更新を確認できませんでした。しばらくしてから、もう一度お試しください。'

// electron-updater（ERR_UPDATER_*）と builder-util-runtime の HttpError（HTTP_ERROR_404 など）が err.code に付ける印。
// 配信元が答えた失敗（公開された版が無い・チャンネルのファイルが無い・混み合い・権限）か、下の「包み」のどちらか。
const UPDATER_SOURCE_CODE = /^(?:ERR_UPDATER_[A-Z0-9_]+|HTTP_ERROR_\d{3})$/

// 「包み」: electron-updater の GitHubProvider は、最新の版の取得（/releases/latest）で投げられた失敗を、通信の層の失敗も含めて
// ERR_UPDATER_LATEST_VERSION_NOT_FOUND で包み、さらに外側を ERR_UPDATER_INVALID_RELEASE_FEED が包む。
// 本文は「…, please ensure a production release exists: <内側の stack>」。印だけでは、配信元が答えた失敗なのか回線が落ちたのか分からない。
const UPDATER_WRAPPER_CODE = /^ERR_UPDATER_(?:LATEST_VERSION_NOT_FOUND|INVALID_RELEASE_FEED)$/
const WRAPPED_INNER = /please ensure a production release exists:\s*([^\n]*)/

/** 包みの中の失敗の1行目（頭の「Error: 」は落とす）。包みでない・読めなければ undefined。
 *  1行目だけを見る: 後ろには stack の行と、配信元の feed（日本語や、通信の語を含みうる XML）が続く。 */
function wrappedInnerOf(err: object, code: string): string | undefined {
  if (!UPDATER_WRAPPER_CODE.test(code)) return undefined
  const message = (err as { message?: unknown }).message
  const first = typeof message === 'string' ? WRAPPED_INNER.exec(message)?.[1] : undefined
  return first?.replace(/^[A-Za-z]*Error:\s*/, '')
}

// 安全な接続（証明書）の失敗に「接続してから」は当たらないので、回線断に数えない
const isOfflineKind = (kind: FailureKind): boolean => kind === 'offline' || kind === 'interrupted' || kind === 'timeout'

/**
 * 更新の確認の失敗を、画面に出す日本語1行にする（純関数）。
 *
 * 画面に出るのは2文のどちらかだけ。回線に出られなかった失敗は「接続してから」、それ以外は「しばらくしてから」。
 * 英語の原文（HTTP の応答のヘッダ付き複数行を含む）は、文の下の「詳細: …」の1行（空白をまとめて短く切ったもの）にだけ添える。
 * 判定の順序は固定: (1) err.code が配信元の印 → 「それ以外」。ただし包みの印は中身の1行目を見て、通信の層の失敗なら「接続してから」
 * (2) 通信の層の失敗（文面の net::ERR_* を含む）→ 「接続してから」。
 * 文面を先に見ると、配信元に情報が無いだけの失敗を回線断と言ってしまう（HttpError の本文には何が書かれていてもおかしくない）ので、印を先に見る。
 * Electron の通信の失敗は code を持たないことがあるため、印が無ければ文面で見る（failureText の判定）。
 */
export function updateFailureText(err: unknown): string {
  return withFailureDetail(updateFailureSentence(err), err)
}

function updateFailureSentence(err: unknown): string {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  if (typeof code === 'string' && UPDATER_SOURCE_CODE.test(code)) {
    const inner = wrappedInnerOf(err as object, code)
    return inner !== undefined && isOfflineKind(classifyFailure(inner).kind) ? UPDATE_OFFLINE : UPDATE_OTHER
  }
  return isOfflineKind(classifyFailure(err).kind) ? UPDATE_OFFLINE : UPDATE_OTHER
}

/**
 * 更新があることを画面で強調すべきか（純関数）。
 * ダウンロード済みのときだけ。確認中や進行中に目立たせても、利用者にできることが無い。
 */
export function shouldHighlight(state: UpdateState): boolean {
  return state.kind === 'downloaded'
}
