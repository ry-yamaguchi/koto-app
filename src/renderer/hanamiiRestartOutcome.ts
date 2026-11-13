// hanamiiRestartOutcome.ts — HANAMII の「再起動」の結果（main の hanamii:restart の返り値）を、画面の状態にする純関数。
// HanamiiPanel.tsx（巨大ファイル）から切り出した。パネルはこれを呼ぶだけで、成功の ✅ や手元の写しの更新の判断はここだけが持つ。

import { wrapFailureText } from '../shared/failureDetail'

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

/**
 * 再起動が失敗し、かつこの操作でヘルスチェックの設定を変えていたときに、失敗の文に足す一文。
 * 2026-11-10 の 0.6.28-rc.2 の実機の確かめで1回観察: ヘルスチェックを有効にする再起動が HTTP 400 で断られた。
 * いつもそうとは言えないので「ことがあります」と言う。HANAMII の断りの文は見ない——判断は Koto が知っている「変えたか」だけ。
 */
export const HANAMII_RESTART_HEALTH_HINT = 'ヘルスチェックの設定を変えたときは、「🚀 公開する（更新）」で反映できることがあります。'

/**
 * 文の終わりに句点が無ければ足す。失敗の文の後ろは HANAMII の断りの文そのもので、句点なしで来る
 * （2026-11-12 の 0.6.30-rc.1 の実機:「…通常の再デプロイが必要です」のすぐ後ろに案内が続き、
 * 「必要ですヘルスチェックの設定を…」と1つの文に見えた）。すでに文が終わっていれば足さない。
 */
export function endSentence(text: string): string {
  const t = text.trimEnd()
  if (!t) return t
  return /[。．.！!？?]$/.test(t) ? t : `${t}。`
}

/**
 * この操作でヘルスチェックの設定を変えたか。**Koto が記録している設定**（`.sakuraide.json` の publish.hanamii.healthCheck）と、
 * いま送る設定を比べる。記録が無ければ「無効」とみなす（フォームの初期値と同じ）。無効どうしならパスは見ない。
 */
export function healthCheckChangedBy(meta: unknown, next: { enabled: boolean; path: string }): boolean {
  const saved = (meta as any)?.publish?.hanamii?.healthCheck
  const savedEnabled = saved?.enabled === true
  if (savedEnabled !== next.enabled) return true
  if (!next.enabled) return false
  const savedPath = typeof saved?.path === 'string' && saved.path ? saved.path : '/'
  return savedPath !== next.path
}

export function restartOutcomeOf(r: HanamiiRestartReply, ctx?: { healthCheckChanged?: boolean }): HanamiiRestartOutcome {
  if (!r.ok) {
    // 途中の段で止まっても、保存が済んだ側だけは HANAMII に保存された設定と手元の写しを揃える（文は main の失敗の文のまま）。
    // 保存できなかった側は写しを書き換えない（環境変数は保存できて、ヘルスチェックで止まった回など）。
    const base = r.message ?? '再起動に失敗しました'
    // 詳細の行（原文）は最後に保つ。ヘルスチェックを変えた回だけ、文の最後に一文を足す（前の文が句点で終わっていなければ句点を足してから）。
    const message = ctx?.healthCheckChanged ? wrapFailureText(base, t => endSentence(t) + HANAMII_RESTART_HEALTH_HINT) : base
    return { ok: false, message, detail: r.detail ?? '', saveEnvs: r.envsSaved === true, saveHealthCheck: r.healthCheckSaved === true }
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
