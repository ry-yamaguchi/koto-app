// opsText.ts — 処理の記録（src/main/projectOps.ts）の文を、画面の文にするための小さな部品。**定義はこの1か所**（掟10）。
//
// ── なぜ1か所か（2026-09-30 検分の指摘2）──────────────────────────────────────────────
// 同じ判断が、画面ごとに別々に書かれていた:
//   ・警告に「⚠️」を付ける（PublishModal の withWarnMark・AppRunPanel と apprunDedicatedActions の warningLine）
//   ・警告から印を外す（HanamiiPanel の opWarningText）
//   ・時刻を「10:32」にする（HanamiiPanel の opClock・AppRunPanel と apprunDedicatedActions の clockText。しかも
//     ゼロ埋めの有無が食い違っていた）
//   ・「⚠️・※ で始まる行は警告」という印そのもの（main の projectOps.ts にも別に書かれていた）
// 複製すると片方だけ直されて、警告の見え方が画面によって変わる（月額が続く警告を見逃す穴になる）。
// main（記録を作る側）と画面（読む側）の両方が使うので src/shared に置く。

/**
 * 「⚠️」「⚠」「※」で始まる行は、**知らせ（警告）**である。
 * main は executed の中のこの印の行を警告へ移し（projectOps.ts の summarizeResult）、画面はこの印の有無で
 * 「⚠️」を付け足すか（付いていればそのまま）を決める。
 */
export const WARN_MARK = /^\s*(⚠️|⚠|※)/

/** 知らせの印が付いているか。 */
export function hasWarnMark(w: string): boolean {
  return WARN_MARK.test(String(w ?? ''))
}

/** 警告を画面の1行にする。印が付いていればそのまま、無ければ「⚠️ 」を添える（二重に付けない）。 */
export function warningLine(w: string): string {
  const t = String(w ?? '')
  return hasWarnMark(t) ? t : `⚠️ ${t}`
}

/** 警告から印を外す（画面が「⚠️」を付け直すので、二重にならないように・コピー用の文にも使う）。 */
export function opWarningText(w: string): string {
  return String(w ?? '').replace(/^\s*(⚠️|⚠|※)\s*/, '')
}

/**
 * 警告のうち、**本文（message）がすでに言っている文**を除く（同じ事実を1つの画面で2回言わない。掟5 の2）。**定義はこの1か所**（掟10）。
 * 先頭の「⚠️」「⚠」「※」と空白は外して比べる（警告は印つきで持たれることがある）。本文がその文を含んでいれば、警告の側を出さない。
 * 空の文（印だけの文を含む）は本文に必ず含まれるので、ここで一緒に落ちる（「⚠️ 」だけの行にしない）。
 *
 * HANAMII が削除を受け付けただけの回は、main が同じ文を message にも warnings にも入れて返す（HANAMII_DELETION_ACCEPTED_WARNING）。
 * 結果カード（【公開】の OpFinishedCard）・結果欄（TeardownResultView）・開き直しの知らせ（resumedTeardownNote）は、本文と警告を同じ枠に出すので、この関数を通す。
 * 本文に含まれない警告は、そのまま残る（月額が続く等の知らせを落とさない）。
 */
export function warningsNotRepeatedIn(message: unknown, warnings: readonly string[]): string[] {
  const body = typeof message === 'string' ? message : ''
  return warnings.filter(w => !body.includes(opWarningText(w).trim()))
}

/**
 * 時刻（epoch ミリ秒）を端末の時計で「10:32」の形（ゼロ埋め）にする。読めなければ空文字
 * （呼び出し側は、空なら時刻の言い回しごと省く）。ロケールに頼らない（環境で「24:05」などにならないように）。
 */
export function clockText(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  if (isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 日付（epoch ミリ秒）を端末の時計で「10/10」の形（月/日・ゼロ埋めなし）にする。読めなければ空文字。
 * 止まった回の見出し（shared/stageTiming.ts の stageTimingView）が、`clockText` と並べて使う。
 */
export function monthDayText(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  if (isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()}`
}
