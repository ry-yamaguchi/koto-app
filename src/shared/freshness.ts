// freshness.ts — 資料の「鮮度」を判断する（純ロジック）。
//
// ── なぜ要るか（2026-08-15 Ryosuke 提案）──────────────────────────────
// RAG の資料は**取り込んだ時点のコピー**である。ところが一覧では、
// 3か月前に取り込んだページも今日取り込んだページも**同じ顔**をしていた。
// AI はどちらも「いまの情報」として読む。つまり Koto は
// **古い情報を最新のつもりで使わせていた**。
//
// これは今日までに直してきたものと同じ形である（「成功と表示されながら
// 壊れている」CLAUDE.md 掟10）。**分からないものを分かったように見せない。**
//
// ── 材料は既にある（新しい記録ファイルを作らない）────────────────────
// Web から作った資料の本文には、取り込み時に次の2行が書かれている
// （renderer/ragContext.ts の buildWebPageMarkdown）:
//
//   - 出典URL: https://example.com/…
//   - 取得日時: 2026-05-20 10:31（Koto で取得）
//
// **だから本文を読めば出どころが分かる。** 別の場所に控えを持つと、
// 資料を消したときに残ったり、ずれたりする（今日の「記録だけ残る」と同じ轍）。

/** 資料の本文から読み取れた出どころ。 */
export type SourceMeta = {
  /** 出典URL（分からなければ null）。 */
  url: string | null
  /** 取り込んだ日時の文字列（分からなければ null）。 */
  fetchedAt: string | null
}

/**
 * 資料の本文から出どころを読み取る（純関数）。
 *
 * 手で書いた資料や、コレクター以外で足した資料には無い。**無いことは失敗ではない。**
 */
export function parseSourceMeta(markdown: string | null | undefined): SourceMeta {
  const t = String(markdown ?? '')
  // ── 行頭に縛らない（2026-08-15 実機）────────────────────────────────
  // 書き込むときは `- 出典URL: https://…` の形だが、**さくらの AI Engine から
  // 読み戻すと形が変わっている**ことが分かった（実機で「出典URLが記録されて
  // いません」になった。10日前の取り込みで、書式は当時から同じ）。
  // 箇条書きの `- ` が落ちる・改行が詰まる等がありうるので、
  // **目印の語のまわりだけを見る**（全角コロンや空白の揺れも許す）。
  const url = /出典\s*URL\s*[:：]\s*(https?:\/\/[^\s"'<>）)]+)/.exec(t)?.[1] ?? null
  const at = /取得日時\s*[:：]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}(?:[ T][0-9]{2}:[0-9]{2})?)/.exec(t)?.[1] ?? null
  return { url, fetchedAt: at }
}

/** 鮮度の段階。**古いと決めつけず、経過を伝えて判断してもらう。** */
export type FreshnessLevel = 'fresh' | 'aging' | 'stale' | 'unknown'

export type Freshness = {
  level: FreshnessLevel
  /** 経過日数（分からなければ null）。 */
  days: number | null
  /** 画面に出す一言。 */
  label: string
}

/** 古いと見なす境目（日）。**根拠のある値ではない**ので、変えやすいよう名前を付けておく。 */
export const AGING_DAYS = 30
export const STALE_DAYS = 90

/** 日付文字列を Date にする（形が違えば null）。 */
function toDate(v: string | null | undefined): Date | null {
  if (!v) return null
  // 「2026-05-20 10:31」形式は Safari/Electron でも通るよう T 区切りに直す
  const s = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\s/.test(v) ? v.replace(' ', 'T') : v
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 経過日数（切り捨て）。どちらかが読めなければ null。 */
export function daysBetween(from: string | null | undefined, now: Date): number | null {
  const d = toDate(from)
  if (!d) return null
  return Math.floor((now.getTime() - d.getTime()) / 86400000)
}

/**
 * 資料の鮮度を判断する（純関数）。
 *
 * **「取り込んだ日」を見る。** 元のページがいつ更新されたかは、取りに行かないと
 * 分からない（それは別の話・checkSourceChanged）。ここで言えるのは
 * 「この写しがいつのものか」だけであり、それを正直に言う。
 */
export function judgeFreshness(opts: { fetchedAt: string | null; now: Date }): Freshness {
  const days = daysBetween(opts.fetchedAt, opts.now)
  if (days === null) return { level: 'unknown', days: null, label: '取り込み日が分かりません' }
  const when = days <= 0 ? '今日' : days === 1 ? '昨日' : `${days}日前`
  if (days >= STALE_DAYS) return { level: 'stale', days, label: `${when}に取り込み` }
  if (days >= AGING_DAYS) return { level: 'aging', days, label: `${when}に取り込み` }
  return { level: 'fresh', days, label: `${when}に取り込み` }
}

/**
 * 取り直した中身が、前と変わっているか（純関数）。
 *
 * **空白と改行の違いで「変わった」と言わない。** ページ側の些細な差で毎回
 * 「更新されています」が出ると、本当に変わったときに気づけなくなる。
 */
export function normalizeForCompare(body: string | null | undefined): string {
  // ── 空白の形を一切見ない（2026-08-15 実機）──────────────────────────
  // さくらの AI Engine から読み戻した本文は、**改行や空白の入り方が変わっている**
  // （出典URLが行頭で見つからなかったのと同じ理由）。改行の違いだけで
  // 「更新されています」と言い続けると、**本当に変わったときに気づけなくなる**。
  // 比べるのは中身の文字列だけにする。
  return String(body ?? '').replace(/\s+/g, ' ').trim()
}

export function checkSourceChanged(opts: { stored: string | null; fetched: string | null }): 'same' | 'changed' | 'unknown' {
  const a = normalizeForCompare(opts.stored)
  const b = normalizeForCompare(opts.fetched)
  if (!a || !b) return 'unknown'
  if (a === b) return 'same'
  // **切り取られた長さの違いで「変わった」と言わない。**
  // 取り込みと確認で取得の上限が違うと、片方が途中で切れる。
  // 片方がもう片方の書き出しそのものなら、中身は変わっていない。
  if (a.startsWith(b) || b.startsWith(a)) return 'same'
  return 'changed'
}

/**
 * 本文から「取り込み時のヘッダ」を外して、中身だけを取り出す（純関数）。
 *
 * ヘッダには**取り込んだ日時が入っている**ので、そのまま比べると
 * **必ず「変わった」になる**。比べるのは中身だけにする。
 */
export function bodyWithoutHeader(markdown: string | null | undefined): string {
  const t = String(markdown ?? '')
  // ── 改行に頼らない（2026-08-15 実機のバグ）──────────────────────────
  // 以前は `\n---\n` を探していた。ところが**読み戻した本文では改行が失われる**
  // ため見つからず、ヘッダ（タイトル・出典URL・**取得日時**）が付いたまま
  // 比べていた。取得日時は毎回変わるので、**何度取り直しても「更新されています」**
  // になり続けた（Ryosuke 指摘「何回でも更新されていますになる」）。
  //
  // ヘッダは短いので、先頭側だけを見て区切りを探す。**区切りが無ければ何も切らない**
  // （手で書いた資料の本文を、誤って削らないため）。
  const head = t.slice(0, 600)
  if (!/出典\s*URL|取得日時/.test(head)) return t
  const i = head.lastIndexOf('---')
  return i === -1 ? t : t.slice(i + 3).replace(/^\s+/, '')
}

/**
 * いま確認しに行くべき資料を選ぶ（純関数）。
 *
 * **開くたびに全部を取りに行かない。** 相手のサイトに負担をかけるし、遅くなる。
 * 前回の確認から一定時間が経ったものだけにする。
 */
export function sourcesDueForCheck<T extends { id: string }>(opts: {
  docs: readonly T[]
  lastCheckedAt: Readonly<Record<string, string>>
  now: Date
  intervalHours?: number
  /** 一度に確認する上限。**まとめて叩かない。** */
  limit?: number
}): T[] {
  const interval = (opts.intervalHours ?? 6) * 3600000
  const limit = opts.limit ?? 5
  const due = opts.docs.filter(d => {
    const last = toDate(opts.lastCheckedAt[d.id])
    return !last || opts.now.getTime() - last.getTime() >= interval
  })
  return due.slice(0, limit)
}

/**
 * 文字列の指紋（純関数・FNV-1a）。
 *
 * ── なぜ指紋を持つのか（2026-08-18 実機）──────────────────────────────
 * これまでは「さくらの AI Engine に保存された本文」と「いま取ってきたページ」を
 * 比べていた。ところが**保存して読み戻すと本文の形が変わる**（改行が失われる等）。
 * どこがどう変わるのかを Koto は決められないので、**この比べ方は最初から
 * 当てにならない**。実機でも、同じ資料が「最新です」と「更新されています」の
 * 両方になった（Ryosuke 指摘）。
 *
 * だから比べるのは**取り込んだときのページ**と**いまのページ**にする。
 * どちらも Koto が自分で取得したものなので、間に何も挟まらない。
 * そのために、取り込んだ時点の指紋を手元に控える。
 */
export function fingerprint(text: string | null | undefined): string {
  const t = normalizeForCompare(text)
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // 長さも混ぜる（短い文字列の衝突を減らす）
  return `${t.length.toString(36)}-${h.toString(36)}`
}

/** 取り込んだときの控え。 */
export type Baseline = { hash: string; at: string }

/** 更新の有無（指紋どうしの比較・純関数）。 */
export type UpdateVerdict = 'same' | 'changed' | 'no-baseline'

/**
 * 取り込んだときと、いまを比べる（純関数）。
 *
 * **控えが無ければ「変わった」とは言わない。** 昔に取り込んだ資料は控えが無く、
 * そこで「更新されています」と出すのは**根拠のない断定**になる（実機で
 * それをやってしまった）。分からないことは分からないと言う。
 */
export function judgeUpdate(opts: { baseline: Baseline | null | undefined; nowText: string | null }): UpdateVerdict {
  if (!opts.baseline?.hash) return 'no-baseline'
  return opts.baseline.hash === fingerprint(opts.nowText) ? 'same' : 'changed'
}
