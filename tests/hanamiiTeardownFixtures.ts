// 偽の HANAMII サーバの、プロジェクト削除（DELETE /api/v1/projects/:id）の応答。HANAMII の破棄を流すテストが共有する。
//
// **応答は原本から写す**（掟1・掟10の4。2026-09-07 の事故）。原本は https://hanamii.jp/docs/api の「プロジェクトを削除」の節（2026-10-09 に読んだ）:
//   200 … 物理削除済み。応答例は { "project": { "id": "prj_123", "deleted": true, "deletion": "completed" } }
//   202 … 削除受付済み（deleted=false・deletion=accepted。外部リソースの削除が続くとき）。**本文の例は原本に無い**
//         ので、原本の説明にある項目（id・deleted・deletion）だけを組む。形を推測で足さない。
//   403 … トークン scope または project 権限不足
//   404 … project が存在しない、または参照できない（本文の形は読んでいないので、組まない）
//   429 … レート制限超過
// 以前のテストは 204・空の本文を「削除できた」の応答にしていたが、**204 は原本の一覧に無い**。

/** DELETE の応答の本文（JSON の文字列）。本文の形を読んでいない状態（403・404・429・500 など）は空。 */
export function deleteProjectReplyText(status: number, projectId: string): string {
  if (status === 200) return JSON.stringify({ project: { id: projectId, deleted: true, deletion: 'completed' } })
  if (status === 202) return JSON.stringify({ project: { id: projectId, deleted: false, deletion: 'accepted' } })
  return ''
}

/** 偽の fetch が返す応答（実物の HanamiiClient が読む項目だけ: ok・status・text）。 */
export function deleteProjectReply(status: number, projectId: string) {
  return { ok: status >= 200 && status < 300, status, async text() { return deleteProjectReplyText(status, projectId) } }
}
