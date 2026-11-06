import { stripRemoteHead } from '../shared/failureText'

/**
 * ipcRenderer.invoke が失敗を包む英語の頭を取り除く（W-59・2026-09-27決定、掟10: 一元化）。
 *
 * Electron の ipcRenderer.invoke は、main 側で投げたエラーを必ず
 * 「Error invoking remote method '<channel>': Error: <本文>」の形にくるんで返す
 * （型名は Error とは限らず、TypeError: などのこともある）。
 * main 側はすでに日本語の本文（describeSakuraError など）を投げているので、
 * 画面に出すときは**頭だけ**を取り除き、本文をそのまま見せる。
 *
 * - 頭を落とす処理の本体は `shared/failureText.ts` の `stripRemoteHead`（失敗の文を作る層と同じ1つ）。
 *   この名前は、呼び出し側（接続テストの失敗表示 5つ・初回案内・ファイル操作の断り）を変えずに残すための別名。
 * - 接続テストの失敗表示（CredentialsModal.tsx の5つ）と、初回案内の接続テスト
 *   （OnboardingModal.tsx）の**両方がこの1つを通る**。別々に書くと、片方だけ直して
 *   もう片方に英語の頭が残る（実際に2つ書かれていた）。
 * - 頭が無い・形が違うときはそのまま返す（推測で削り過ぎない）。
 * - Error でない値（文字列・undefined など）を渡しても壊れない。
 * - 頭の落とし方を2つ目に書かない（preload にも足さない）。例外の message をそのまま文にする書き方
 *   （`e?.message ?? String(e)` など）は、この頭が付いたまま画面に届く。新しく書かず、失敗の文は
 *   `failureText`（頭も落ちる）を通す。ファイルごとの今の数は tests/rawFailureText.test.ts の表が上限。
 *
 * 画面に出る文は日本語の素のテキストにする（Markdown 記法は使わない）。
 */
export const cleanRemoteError = stripRemoteHead
