// askAi.ts — 失敗したときに「AIに相談する」入力欄へ入れる定型文（純関数・shared/preflight.ts の
// askAiAboutCheck と同じ流儀）。
//
// ── なぜ要るか（判断2・2026-09-11）───────────────────────────────────────
// これまでAIへの相談導線は preflight（押す前の確認）と、AppRun の一部の hint
// （'app-unhealthy' 等）にしか無かった。押した後（公開・破棄・再公開・ロールバック）の
// 失敗は、AppRun・HANAMII・Vercel のどのパネルでも「生のエラーとコピーボタンだけ」で、
// 直し方の入口が無かった。ここに定型文を1箇所へ集約し、各パネルはボタンを置くだけにする。
//
// エラー本文は**外部サービスの応答をそのまま含む**（untrusted）。プロンプトインジェクション
// 境界ガード（src/shared/untrustedBlock.ts・2026-08-30）と同じ流儀で、必ず境界トークンで
// 囲んでから渡す（AIが応答本文中の指示文を「ユーザーの指示」と誤認しないようにする）。

import { wrapUntrusted } from './untrustedBlock'

export type AskAiFailureKind = '公開' | '破棄' | '再公開' | 'ロールバック'

/**
 * 失敗を AI に相談するための文面を組み立てる。
 *
 * @param kind    何をしようとして失敗したか。
 * @param target  どこへの操作か（例: 'さくらのAppRun' / 'HANAMII' / 'Vercel'）。
 * @param message 失敗メッセージ（画面に出しているもの）。
 * @param detail  生ログ等の詳細（あれば）。
 */
export function askAiAboutFailure(kind: AskAiFailureKind, target: string, message: string, detail?: string): string {
  const body = [message, detail].filter(Boolean).join('\n\n')
  const wrapped = wrapUntrusted(`${target}からの応答（${kind}の失敗）`, body)
  return `${target} への${kind}で次の失敗が出ました。原因と、私（プログラミング初心者）が次にすべきことを教えてください。\n\n${wrapped}`
}

/**
 * **失敗ではない**お知らせ（公開はできたが、次にすべきことが残っている）を AI に相談する文面
 * （2026-09-24 検分の指摘3）。
 *
 * これまで Vercel の初回公開の案内（「もう一度『公開する』を押すと…」）は、
 * **失敗専用のブロック**に出ていた。🤖ボタンは `askAiAboutFailure` を使うので、
 * 公開が成功しているのに AI が「起きていない失敗」の原因探しを始め、動いているものを直そうとする。
 * お知らせには**お知らせ用の文面**を使う。
 *
 * お知らせ本文は main 側が組み立てた Koto の文だが、外部サービスの応答に由来する語が
 * 混じりうるので、失敗と同じく境界トークンで囲む（untrustedBlock）。
 *
 * @param target 公開先の名前（例: 'Vercel'）。
 * @param notice 画面に出しているお知らせ本文。
 */
export function askAiAboutNotice(target: string, notice: string): string {
  const wrapped = wrapUntrusted(`${target}への公開のあとのお知らせ`, notice)
  return `${target} への公開は成功しました。そのうえで次のお知らせが出ています。`
    + `意味と、私（プログラミング初心者）が次にすべきことを教えてください。`
    + `**失敗ではないので、動いているものを直そうとしないでください。**\n\n${wrapped}`
}
