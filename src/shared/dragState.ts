// dragState.ts — 「いまファイルがドラッグされているか」の判断（純ロジック）。
//
// ── なぜ要るか（2026-08-19 実機・Ryosuke 報告）──────────────────────────
// 画像をアプリに重ねてから**落とさずに外へ出す**と、「ここに落とすと…」の
// 表示が出たまま残り、**他の操作ができなくなった**。
//
// 画面全体の受け口はこう書いていた:
//   onDragLeave={e => { if (e.currentTarget === e.target) setWindowDragOver(false) }}
//
// 中の部品（エディタなど）へ移ったときに消えないようにする工夫だったが、
// **窓の外へ出たときの離脱は、中の部品から出る形で届く**ので、この条件では
// 一度も消えない。「中へ移った」と「外へ出た」を取り違えていた。
//
// 判断はここに集め、消し忘れの受け皿（窓の外・取り消し・別の場所へ落とした）も
// 1か所で持つ（掟10）。

/**
 * ドラッグされているのがファイルか（純関数）。
 *
 * 文字の選択をドラッグしただけで受け口を光らせない。
 */
export function isFileDrag(types: readonly string[] | null | undefined): boolean {
  return Array.from(types ?? []).includes('Files')
}

/**
 * 窓の外へ出たか（純関数）。
 *
 * 窓から出るときの離脱には**行き先が無い**（relatedTarget が空）。
 * 中の部品へ移っただけなら、そこが行き先として入っている。
 *
 * ── 窓ぜんたいの見張りは、これだけを見る（2026-08-19 実測）──────────
 * ここで leftReceiver を使ったら、**中の部品へ移るたびに表示が消えた**
 * （受け口の中かどうかを見張り側は知らないため）。ブラウザに実際の
 * 出来事を投げて分かった。表を眺めているだけでは気づけない類の間違い。
 */
export function leftWindow(relatedTarget: unknown): boolean {
  return relatedTarget === null || relatedTarget === undefined
}

/**
 * その離脱で表示を消すか（純関数）。**受け口自身が使う。**
 *
 * **中の部品へ移っただけなら消さない**（消すとチラつく）。
 *
 * @param contains 離脱先が受け口の中にあるか（DOM の contains の結果）
 */
export function leftReceiver(relatedTarget: unknown, contains: boolean): boolean {
  if (leftWindow(relatedTarget)) return true
  return !contains
}

/**
 * ドラッグが終わったと見なす出来事か（純関数）。
 *
 * **`dragend` だけに頼らない。** Finder から持ってきたドラッグは、外で
 * 手を離しても `dragend` が届かないことがある。ドラッグ中はマウスの移動
 * イベントが出ないので、`mousemove` が来た＝もう終わっている、と読める。
 */
export function endsDrag(type: string): boolean {
  return type === 'drop' || type === 'dragend' || type === 'mousemove' || type === 'blur'
}
