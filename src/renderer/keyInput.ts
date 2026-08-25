// keyInput.ts — キー入力の判定（純ロジック）。いまは Enter の扱いだけ。
//
// ── なぜ一元化するのか（2026-08-24 Ryosuke 報告）────────────────────────
// 「資料に質問してみる」で、**何か書いた途端に回答の生成が始まる**という報告があった。
// 原因は**日本語入力（IME）**。漢字に変換して確定するときにも Enter を押すので、
// `e.key === 'Enter'` だけを見ていると**変換の確定で実行してしまう**。
//
// 調べたら、`Enter` を見ている7箇所のうち**5箇所が同じ穴**で、
// **変換中かどうかを見ている場所はひとつも無かった**:
//
//   ・資料への質問（報告された症状）
//   ・Webから資料を作る（検索）
//   ・AppRun の名前・値の入力（2箇所）
//   ・**サイドバーの名前ダイアログ**（変換途中の名前でファイルが作られる＝実害）
//
// **日本語で使う製品**なのにここが揃っていないのは、1件ずつ直しても必ず取り残す。
// 判定をここに集め、テストで固定する（掟10）。
//
// ── ⌘+Enter の場所は、あえて通していない ─────────────────────────────
// チャットの送信（`ChatPanel` / `ChatApp`）は **⌘+Enter**。修飾キーが要るので
// 変換の確定と重ならず、症状も報告されていない。**動いているものを触らない。**

/** React の KeyboardEvent から、判定に要るところだけを取り出した形（DOM 非依存＝テストできる）。 */
export type EnterKeyLike = {
  key: string
  /** React が包む前の生のイベント。`isComposing` はここにある。 */
  nativeEvent?: { isComposing?: boolean; keyCode?: number } | null
  /** 古い環境向けの控え（React が直接持っていることもある）。 */
  keyCode?: number
}

/**
 * いま変換の途中か（純関数）。
 *
 * `isComposing` が本命。取れない環境のために `keyCode === 229`（IME 処理中を表す
 * 昔からの目印）も見る。**どちらかが立っていれば変換中とみなす**——
 * 「分からないから実行する」より「分からないから待つ」ほうが安全。
 */
export function isComposing(e: EnterKeyLike): boolean {
  if (e?.nativeEvent?.isComposing) return true
  if (e?.nativeEvent?.keyCode === 229) return true
  if (e?.keyCode === 229) return true
  return false
}

/**
 * 「実行してよい Enter」か（純関数）。**変換の確定では実行しない。**
 *
 * 修飾キーなしの Enter を実行の合図にしている場所は、必ずこれを通すこと。
 */
export function isSubmitEnter(e: EnterKeyLike): boolean {
  return e?.key === 'Enter' && !isComposing(e)
}
