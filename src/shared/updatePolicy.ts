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

/** 更新の状態。renderer の表示もこの型で分岐する。 */
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'none' }
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
    case 'checking': return '新しい版があるか確認しています…'
    case 'available': return `新しい版 ${state.version} が見つかりました。ダウンロードしています…`
    case 'downloading': return `新しい版 ${state.version} をダウンロードしています…（${Math.round(state.percent)}%）`
    case 'downloaded': return `新しい版 ${state.version} の準備ができました。次に Koto を起動したときに切り替わります。`
    case 'none': return 'お使いの版が最新です。'
    case 'error': return `更新を確認できませんでした: ${state.message}`
  }
}

/**
 * 更新があることを画面で強調すべきか（純関数）。
 * ダウンロード済みのときだけ。確認中や進行中に目立たせても、利用者にできることが無い。
 */
export function shouldHighlight(state: UpdateState): boolean {
  return state.kind === 'downloaded'
}
