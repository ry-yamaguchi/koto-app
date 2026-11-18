// claudeOpenPreview.ts — Claude の open_preview の知らせを、送信時のプロジェクトで実行して結果を返す。
// 知らせが届いた時点で見ているプロジェクトは使わない（別のプロジェクトへ切り替えていても、始めたプロジェクトで開く）。

import { failureText } from '../shared/failureText'

export type OpenPreviewNoticeEvent = { id: string; path: string; projectDir: string; writeRoot: string }

export async function handleOpenPreviewNotice(
  ev: OpenPreviewNoticeEvent,
  deps: {
    execute: (name: string, argsJson: string, ctx: { writeRoot: string; projectRoot: string }) => Promise<string>
    reply: (id: string, result: string) => void | Promise<unknown>
  },
): Promise<void> {
  let result: string
  try {
    result = await deps.execute('open_preview', JSON.stringify({ path: ev.path }), { writeRoot: ev.writeRoot, projectRoot: ev.projectDir })
  } catch (e) {
    result = `エラー: 開けませんでした（${failureText(e)}）`
  }
  try { await deps.reply(ev.id, result) } catch { /* ウィンドウ破棄時は無視 */ }
}
