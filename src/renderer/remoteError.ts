/**
 * ipcRenderer.invoke が失敗を包む英語の頭を取り除く（W-59・2026-09-27決定、掟10: 一元化）。
 *
 * Electron の ipcRenderer.invoke は、main 側で投げたエラーを必ず
 * 「Error invoking remote method '<channel>': Error: <本文>」の形にくるんで返す。
 * main 側はすでに日本語の本文（describeSakuraError など）を投げているので、
 * 画面に出すときは**頭だけ**を取り除き、本文をそのまま見せる。
 *
 * - 接続テストの失敗表示（CredentialsModal.tsx の5つ）と、初回案内の接続テスト
 *   （OnboardingModal.tsx）の**両方がこの1つを通る**。別々に書くと、片方だけ直して
 *   もう片方に英語の頭が残る（実際に2つ書かれていた）。
 * - 頭が無い・形が違うときはそのまま返す（推測で削り過ぎない）。
 * - Error でない値（文字列・undefined など）を渡しても壊れない。
 *
 * 画面に出る文は日本語の素のテキストにする（Markdown 記法は使わない）。
 */
export function cleanRemoteError(e: unknown): string {
  const raw = (e && typeof e === 'object' && 'message' in e) ? String((e as { message?: unknown }).message) : String(e)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
}
