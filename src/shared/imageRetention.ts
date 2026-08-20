// imageRetention.ts — レジストリに溜まった「古いイメージのタグ」を、どれだけ残すか（純ロジック）。
//
// ── なぜ要るか（2026-08-19 Ryosuke 指摘）────────────────────────────────
// 同日、「公開しても古いイメージのまま反映されない」を直すため、公開のたびに
// **新しいタグ**を打つようにした（shared/publishTag.ts）。副作用として、
// コンテナレジストリに**タグが1公開につき1つ増え続ける**。
//
// ── どれくらい増えるのか（2026-08-19 実測。推測ではない）──────────────────
// 同梱 crane を実際に走らせて、push される層をバイト単位で数えた。
//   ・ベースイメージ（1レジストリにつき1回だけ）
//       python:3.12-alpine  17.2 MiB ／ node:22-alpine  55.1 MiB（圧縮後）
//   ・1公開で**増える分** ＝ プロジェクトのファイル層1つ ＋ 設定(約5KB) ＋ manifest(約0.5KB)
//       文字だけのサイト        0.5 KB 〜 20 KB
//       node_modules あり       約 3.1 MiB（syosetuReader 実測）
//       画像あり                約 5.31 MiB（landingTEST 実測）
//   ・**ファイルを変えずに公開し直した場合は増えない**（層のダイジェストが同じになる。実測で確認）
//
// 料金は shared/cloudCost.ts（220円／5GiB込み、超過1GiBごと22円）。
// 5GiB に達するまでの公開回数は、画像入りでも約970回・文字だけなら実質到達しない。
// **急いで消す必要は無い**。だから既定は「消さない」。
//
// ── 守りの考え方（掟10）────────────────────────────────────────────────
// これは**利用者の資産（公開に使ったイメージ）を消す**判断なので、定義を1箇所に集める。
//   ① Koto が自分で打ったタグ以外は**絶対に触らない**（利用者が固定した `v1.2.3` や `latest`）
//   ② いま動いているアプリが使っているタグは**必ず残す**（足元を外さない。2026-08-14 の教訓）
//   ③ 既定は**消さない**。消す件数を明示的に指定されたときだけ消す
//   ④ 何件指定されても、最低1件は残す（全部消す事故を防ぐ）

/**
 * Koto が公開のたびに打つタグの形（publishTag.ts の `publishTag` が作る形）。
 * 例: `v20260819-182300`。**この形に一致するものだけが片づけの対象**になる。
 */
export const AUTO_TAG_PATTERN = /^v\d{8}-\d{6}$/

/** 片づけるときに残す既定の件数（利用者が「片づける」を選んだときの初期値）。 */
export const DEFAULT_KEEP = 5

/** 何件指定されても、これより少なくは残さない（全部消す事故を防ぐ）。 */
export const MIN_KEEP = 1

/** Koto が公開のたびに打ったタグか（＝片づけてよい候補か）。 */
export function isAutoTag(tag: unknown): boolean {
  return typeof tag === 'string' && AUTO_TAG_PATTERN.test(tag)
}

/** 片づけの計画。**消す前にこの3つを画面へ出す**（何が消えるか見せてから実行する）。 */
export type CleanupPlan = {
  /** 消してよいタグ（古い順）。 */
  remove: string[]
  /** 残す自動タグ（新しい順）。 */
  keep: string[]
  /** 触らないタグ（自動タグでないもの＋いま使っているタグ）。 */
  untouched: string[]
}

/**
 * 残す件数を丸める純関数。null/undefined は「消さない」（既定）。
 * 数値なら MIN_KEEP 以上の整数にする。
 */
export function normalizeKeep(keep: number | null | undefined): number | null {
  if (keep === null || keep === undefined) return null
  const n = Math.floor(Number(keep))
  if (!Number.isFinite(n)) return null
  return Math.max(MIN_KEEP, n)
}

/**
 * どのタグを消し、どれを残すかを決める純関数。
 *
 * - `keep` が null/undefined のときは**何も消さない**（remove は空）。既定はこちら。
 * - 自動タグ（AUTO_TAG_PATTERN）でないものは untouched へ。**利用者が決めた名前は尊重する。**
 * - `currentTag` は自動タグでも untouched へ。**動いているアプリの足元を外さない。**
 * - 残った自動タグを新しい順に並べ、先頭 `keep` 件を残し、それ以外を remove へ。
 *
 * タグは固定長（`v` + 8桁 + `-` + 6桁）なので、文字列の降順＝新しい順になる。
 */
export function planTagCleanup(opts: {
  tags: readonly string[]
  keep?: number | null
  currentTag?: string | null
}): CleanupPlan {
  const current = typeof opts.currentTag === 'string' ? opts.currentTag.trim() : ''
  // 重複と空を落とす（レジストリの応答をそのまま信じない）
  const all = [...new Set((opts.tags ?? []).map(t => String(t ?? '').trim()).filter(t => t.length > 0))]

  const untouched: string[] = []
  const candidates: string[] = []
  for (const tag of all) {
    if (!isAutoTag(tag) || tag === current) untouched.push(tag)
    else candidates.push(tag)
  }
  untouched.sort()
  candidates.sort().reverse() // 新しい順

  const keep = normalizeKeep(opts.keep)
  if (keep === null) {
    // 既定: 消さない。**何件たまっているかだけを見せる。**
    return { remove: [], keep: candidates, untouched }
  }
  return {
    keep: candidates.slice(0, keep),
    remove: candidates.slice(keep).reverse(), // 古い順に消す
    untouched,
  }
}

/**
 * 「消してよい」と判断した digest から、**残すタグと同じ実体を指すもの**を除く純関数。
 *
 * ── なぜ要るのか（2026-08-19 実測）──────────────────────────────────────
 * ファイルを変えずに公開し直すと、**層も設定も同じ**になるので manifest のダイジェストが
 * 一致する。つまり `v20260819-101500` と `v20260819-113000` が**同じ実体を指す**ことがある。
 * レジストリの削除は実体（digest）に対して効くので、片方を消したつもりで**両方消える**。
 * 残す側が指している digest は、消す対象から外す。
 *
 * @param digestOf タグ → digest の対応（引けなかったタグは含めない）
 */
export function digestsToDelete(opts: {
  plan: CleanupPlan
  digestOf: Readonly<Record<string, string>>
}): { digests: string[]; sharedWithKept: string[] } {
  const keptDigests = new Set(
    [...opts.plan.keep, ...opts.plan.untouched]
      .map(t => opts.digestOf[t])
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
  )
  const digests: string[] = []
  const sharedWithKept: string[] = []
  const seen = new Set<string>()
  for (const tag of opts.plan.remove) {
    const d = opts.digestOf[tag]
    // **引けなかったものは消さない。**（分からないものに破壊操作をしない）
    if (!d) continue
    if (keptDigests.has(d)) {
      sharedWithKept.push(tag)
      continue
    }
    if (seen.has(d)) continue
    seen.add(d)
    digests.push(d)
  }
  return { digests, sharedWithKept }
}

/**
 * 溜まり具合を伝える文（画面にそのまま出る。**Markdown 記法は使わない** — 掟5・cloudCost.ts と同じ）。
 * 消す前・消した後のどちらでも使えるよう、件数だけを述べる。
 */
export function retentionNotice(opts: { removable: number; keep: number }): string {
  if (opts.removable <= 0) return ''
  return `過去の公開でできたイメージが ${opts.removable} 件たまっています`
    + `（直近 ${opts.keep} 件を残して片づけられます）。`
}
