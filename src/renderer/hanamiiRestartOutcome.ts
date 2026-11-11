// hanamiiRestartOutcome.ts — HANAMII の「再起動」の結果（main の hanamii:restart の返り値）を、画面の状態にする純関数。
// HanamiiPanel.tsx（巨大ファイル）から切り出した。パネルはこれを呼ぶだけで、成功の ✅ や手元の写しの更新の判断はここだけが持つ。

/** main の hanamii:restart の返り値（画面が読む項目）。 */
export type HanamiiRestartReply = {
  ok: boolean
  noop?: boolean
  /** 再起動の結果を確かめられなかった（ok:true のまま来る）。成功とは言わない。 */
  unconfirmed?: boolean
  /** 環境変数の保存は済んでいる（そのあとの段で止まった回に付く）。 */
  envsSaved?: boolean
  /** ヘルスチェックの保存は済んでいる（そのあとの段で止まった回に付く）。 */
  healthCheckSaved?: boolean
  message?: string
  detail?: string
}

export type HanamiiRestartOutcome = {
  /** 成功の表示（✅ か「不要でした」）にしてよいか。確かめられない回・失敗は false。 */
  ok: boolean
  message: string
  detail: string
  /** 手元の写しの環境変数を、HANAMII に保存された設定に更新するか。 */
  saveEnvs: boolean
  /** 手元の写しのヘルスチェックを、HANAMII に保存された設定に更新するか。 */
  saveHealthCheck: boolean
}

export const HANAMII_RESTART_NOOP_TEXT = '設定に変更がなかったため、再起動は不要でした。'
export const HANAMII_RESTART_DONE_TEXT = '✅ 再起動して設定を反映しました。'

export function restartOutcomeOf(r: HanamiiRestartReply): HanamiiRestartOutcome {
  if (!r.ok) {
    // 途中の段で止まっても、保存が済んだ側だけは HANAMII に保存された設定と手元の写しを揃える（文は main の失敗の文のまま）。
    // 保存できなかった側は写しを書き換えない（環境変数は保存できて、ヘルスチェックで止まった回など）。
    return { ok: false, message: r.message ?? '再起動に失敗しました', detail: r.detail ?? '', saveEnvs: r.envsSaved === true, saveHealthCheck: r.healthCheckSaved === true }
  }
  // 結果を確かめられなかった回は成功の ✅ を出さない（設定は HANAMII に保存済みなので写しは更新する）。
  if (r.unconfirmed) {
    return { ok: false, message: r.message ?? '⚠️ 再起動の結果を確かめられませんでした。', detail: r.detail ?? '', saveEnvs: true, saveHealthCheck: true }
  }
  return { ok: true, message: r.noop ? HANAMII_RESTART_NOOP_TEXT : HANAMII_RESTART_DONE_TEXT, detail: '', saveEnvs: true, saveHealthCheck: true }
}

/** 手元の写しへ書く差分（書く側だけを入れる）。何も書かないなら null。 */
export function restartMetaPatchOf<E, H>(out: Pick<HanamiiRestartOutcome, 'saveEnvs' | 'saveHealthCheck'>, envs: E, healthCheck: H): { envs?: E; healthCheck?: H } | null {
  if (!out.saveEnvs && !out.saveHealthCheck) return null
  return { ...(out.saveEnvs ? { envs } : {}), ...(out.saveHealthCheck ? { healthCheck } : {}) }
}
