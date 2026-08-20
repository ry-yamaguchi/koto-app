// publishTag.ts — 公開のたびに違うイメージのタグを付ける（純ロジック）。
//
// ── なぜ要るか（2026-08-19 実機・Ryosuke 報告）──────────────────────────
// 「試すだと画像が表示されるが、公開すると画像が表示されていない」
//
// 実測すると、公開先には**画像を入れる前の古いページ**が出ていた
// （配信中の index.html は 4,841 バイト・画像の参照が1つも無い／手元は 5,168 バイト、
//   `images/` は 404）。tar の往復も python の配信も手元では正常だったので、
// 配り方ではなく**新しいイメージが使われていない**ということ。
//
// 原因は、公開のたびに**同じ参照**（`…/landingtest:latest`）を渡していたこと。
// 中身が変わっても名前が同じなので、AppRun 側からは「同じイメージ」に見える。
// 公開のたびに**別の名前**にすれば、必ず新しいものが取りに行かれる。
//
// タグの規則（docker.ts の TAG_PATTERN）: 英数字・ドット・アンダースコア・ハイフン。

/** 既定のタグ（これが付いていたら、公開のたびに置き換える）。 */
export const DEFAULT_TAG = 'latest'

/**
 * その場かぎりのタグを作る（純関数）。
 *
 * 例: 2026-08-19 18:23:00 → `v20260819-182300`
 * **時刻は手元の時計**（並べたときに新しい順が分かる形にする）。
 */
export function publishTag(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `v${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/**
 * env.json のタグを置き換えるべきか（純関数）。
 *
 * **利用者がわざわざ決めたタグは尊重する**（エキスパートが固定したい場合がある）。
 * 置き換えるのは、既定のまま（`latest`）か、空のときだけ。
 */
export function shouldReplaceTag(tag: string | null | undefined): boolean {
  const t = String(tag ?? '').trim()
  return t === '' || t === DEFAULT_TAG
}

/** 実際に使うタグを決める（純関数）。 */
export function tagForPublish(specTag: string | null | undefined, now: Date): string {
  return shouldReplaceTag(specTag) ? publishTag(now) : String(specTag)
}
