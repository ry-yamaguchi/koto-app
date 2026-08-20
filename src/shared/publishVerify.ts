// publishVerify.ts — 「公開が本当に反映されたか」を確かめる（純ロジック）。
//
// ── なぜ要るか（2026-08-19 実機・Ryosuke 報告）──────────────────────────
// 「試すだと画像が表示されるが、公開すると画像が表示されていない」
//
// 公開は「✅ 完了」と出ていた。実際には**画像を入れる前の古いページ**が
// 配られ続けていた（毎回同じ `:latest` を渡していたため）。タグは直したが、
// **誰も確かめていなかったこと自体**が本当の問題である。
//
//   ・デプロイのAPIが 200 を返したこと … 反映された証拠にならない
//   ・アプリが動いていること（起動確認）… 中身が新しい証拠にならない
//
// そこで、配る中身に**版の名前を書いた目印**を1つ混ぜ、公開のあとに
// その目印を読みに行く。一致したら反映済み、しなければ**正直にそう言う**。
//
// ── 対象（2026-08-19 時点）────────────────────────────────────────────
// 静的配信（ファイルをそのまま配る）だけ。Node で動かすアプリは自分で経路を
// 決めるので、目印のファイルが読めるとは限らない（**読めないことを失敗と
// 呼ばない**ため、はじめから確認の対象にしない）。

/** 配る中身に混ぜる目印のファイル名。 */
export const MARKER_FILE = '.koto-build'

/** 目印の中身（版の名前だけを書く）。 */
export function markerContent(tag: string): string {
  return `${tag}\n`
}

/** 読み取った中身が、その版のものか（純関数・前後の空白は無視）。 */
export function matchesMarker(body: string | null | undefined, tag: string): boolean {
  return String(body ?? '').trim() === String(tag ?? '').trim() && String(tag ?? '').trim() !== ''
}

/** 確認しに行く先（純関数）。 */
export function markerUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/${MARKER_FILE}`
}

/**
 * 確認できる公開か（純関数）。
 *
 * **できない場合を「失敗」と言わない。** 確認しないだけ。
 */
export function canVerify(runtime: string, publicUrl: string | null | undefined): boolean {
  return runtime === 'static' && /^https?:\/\//.test(String(publicUrl ?? ''))
}

/**
 * 待ち時間（ミリ秒）。合計およそ90秒まで。
 *
 * 反映には時間がかかる（新しいイメージを取りに行って、入れ替わるまで）。
 * **短く諦めない**。ただし待たせすぎない。
 */
export function verifyDelaysMs(): number[] {
  return [2000, 3000, 5000, 8000, 12000, 20000, 20000, 20000]
}

/** 確認の結果。 */
export type VerifyOutcome = 'ok' | 'stale' | 'unreachable'

/** 画面に出す一言（純関数）。**分からないときは分からないと言う。** */
export function verifyMessage(outcome: VerifyOutcome): string {
  switch (outcome) {
    case 'ok':
      return '✅ 新しい内容が公開されたことを確認しました'
    case 'stale':
      return '⚠️ 公開は完了しましたが、**まだ古い内容が表示されています**。'
        + '数分待ってから公開先を再読み込みしてください。変わらなければ、もう一度【③ 公開】をお試しください。'
    case 'unreachable':
      return 'ℹ️ 公開先に接続できなかったため、内容が新しくなったかは確認できませんでした（公開そのものは完了しています）。'
  }
}
