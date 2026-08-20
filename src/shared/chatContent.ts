// chatContent.ts — 非ストリーミング応答から「本文」を取り出す（純粋ロジック）。
//
// ── なぜ切り出したか（2026-08-20）──────────────────────────────────────
// 推論型モデル（gpt-oss / Kimi 等）は、**本文が空で、答えが reasoning_content /
// reasoning に入る**ことがある。ストリーミング側は最初からその対策を持っている
// （shared/streamDelta.ts の applyChunk、renderer 側の reasoningText フォールバック）。
// ところが **非ストリーミングの `sakura:chat` には無く**、`choices[0].message.content` を
// そのまま返していた。
//
// そのため、推論型モデルを選んでいると
//   ・会話のまとめ（historyCompact）が **毎回空** になり、静かに一度も作られない
//   ・公開前セキュリティチェックが「結果を取得できませんでした」になる
// という、**どこにもエラーが出ない失敗**になっていた。
//
// ipcMain の中に置くと electron 依存でテストできない（streamDelta.ts を切り出したのと同じ理由）。

/** OpenAI互換の `choices[0].message` から本文を取り出す。本文が空なら推論内容で代替する。 */
export function pickContent(message: unknown): string {
  const m = (message ?? {}) as Record<string, unknown>
  const content = typeof m.content === 'string' ? m.content : ''
  if (content.trim()) return content
  // 提供側によって reasoning_content / reasoning のどちらで来るかが違う（streamDelta.ts と同じ扱い）。
  const reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content
    : typeof m.reasoning === 'string' ? m.reasoning : ''
  return reasoning.trim() ? reasoning : content
}
