import { beforeEach, afterEach } from 'vitest'
import { hanamiiDeletionWaitTuning } from '../src/main/hanamii/deletionWait'

// 偽の HANAMII サーバの、プロジェクト削除（DELETE /api/v1/projects/:id）の応答。HANAMII の破棄を流すテストが共有する。
//
// **応答は原本から写す**（掟1・掟10の4。2026-09-07 の事故）。原本は https://hanamii.jp/docs/api の「プロジェクトを削除」の節（2026-10-09 に読んだ）:
//   200 … 物理削除済み。応答例は { "project": { "id": "prj_123", "deleted": true, "deletion": "completed" } }
//   202 … 削除受付済み（deleted=false・deletion=accepted。外部リソースの削除が続くとき）。応答例は
//         { "project": { "id": "prj_123", "deleted": false, "deletion": "accepted", "operationId": "operation_123", "requiresReview": false } }
//         （2026-10-29 版の原本から写す。以前の版には本文の例が無かった）
//   403 … トークン scope または project 権限不足
//   404 … project が存在しない、または参照できない（本文の形は読んでいないので、組まない）
// GET /api/v1/projects/:id（プロジェクトの取得）の 200 は、原本の応答例の一部（id・name・status）だけを組む。
//   429 … レート制限超過
// 以前のテストは 204・空の本文を「削除できた」の応答にしていたが、**204 は原本の一覧に無い**。

/** 原本の 202 の例の operationId。 */
export const ACCEPTED_OPERATION_ID = 'operation_123'

/** DELETE の応答の本文（JSON の文字列）。本文の形を読んでいない状態（403・404・429・500 など）は空。`requiresReview` は 202 の本文の値（既定 false）。 */
export function deleteProjectReplyText(status: number, projectId: string, opts: { requiresReview?: unknown; omitReview?: boolean } = {}): string {
  if (status === 200) return JSON.stringify({ project: { id: projectId, deleted: true, deletion: 'completed' } })
  if (status === 202) {
    const project: Record<string, unknown> = { id: projectId, deleted: false, deletion: 'accepted', operationId: ACCEPTED_OPERATION_ID }
    if (!opts.omitReview) project.requiresReview = opts.requiresReview ?? false
    return JSON.stringify({ project })
  }
  return ''
}

/** GET /projects/:id の応答の本文。200 は原本の例の一部（id・name・status）。ほかの状態は空。 */
export function getProjectReplyText(status: number, projectId: string): string {
  return status === 200 ? JSON.stringify({ project: { id: projectId, name: 'my-app', status: 'healthy' } }) : ''
}

/** 偽の fetch が返す応答（実物の HanamiiClient が読む項目だけ: ok・status・text）。 */
export function deleteProjectReply(status: number, projectId: string) {
  return { ok: status >= 200 && status < 300, status, async text() { return deleteProjectReplyText(status, projectId) } }
}

/**
 * 偽の HANAMII サーバの fetch を、**メソッドごとの台本**で作る（GET と DELETE を別々に振り分ける）。
 * `get`・`del` は、そのメソッドの n 回目（0 から）の応答のステータス（または { status, text }）の並び。並びを使い切ったら最後の値を繰り返す。ステータス 0 は通信エラー（fetch が投げる）。
 * 出た要求は `calls` に `<METHOD> <URL>` で積み、Authorization も `auths` に積む（D8: 渡したトークンだけが使われたか）。
 */
export function routedHanamiiFetch(script: {
  projectId: string
  get: ReadonlyArray<number | { status: number; text?: string }>
  del: ReadonlyArray<number | { status: number; text?: string }>
  calls?: string[]
  auths?: string[]
  /** 要求を受けた直後（応答を返す前）に呼ぶ。待ちの途中の状態を見る・止めるために使う（返した Promise を待つ）。 */
  onRequest?: (method: 'GET' | 'DELETE', n: number) => void | Promise<void>
}): typeof fetch {
  const n = { GET: 0, DELETE: 0 }
  return (async (input: unknown, init: any) => {
    const method = String(init?.method ?? 'GET') as 'GET' | 'DELETE'
    script.calls?.push(`${method} ${String(input)}`)
    script.auths?.push(String(init?.headers?.Authorization ?? init?.headers?.authorization ?? ''))
    const list = method === 'DELETE' ? script.del : script.get
    await script.onRequest?.(method, n[method])
    const item = list[Math.min(n[method]++, list.length - 1)]
    const status = typeof item === 'number' ? item : item.status
    if (status === 0) throw new Error('fetch failed')
    const text = typeof item === 'object' && item.text !== undefined
      ? item.text
      : method === 'DELETE' ? deleteProjectReplyText(status, script.projectId) : getProjectReplyText(status, script.projectId)
    return { ok: status >= 200 && status < 300, status, async text() { return text } }
  }) as unknown as typeof fetch
}

/**
 * HANAMII の削除を待つ側（main/hanamii/deletionWait.ts）の時計を、偽の時計に差し替える。**本物の sleep で待たない**。
 * sleep は偽の時計を進めるだけで、すぐ返る。戻り値の `restore()` を afterEach で呼ぶ。入れ忘れたテストは、既定の sleep が投げるので落ちる（tests/setup/noRealDeletionSleep.ts。testTimeout は30秒なので、本物の待ちに任せると黙って緑になる）。
 */
export function fastHanamiiDeletionWait(): { now(): number; restore(): void; sleeps: number[] } {
  const t = hanamiiDeletionWaitTuning
  const saved = { sleep: t.sleep, now: t.now }
  let clock = 1_000_000
  const sleeps: number[] = []
  t.now = () => clock
  t.sleep = async (ms: number) => { sleeps.push(ms); clock += ms }
  return { now: () => clock, restore: () => { t.sleep = saved.sleep; t.now = saved.now }, sleeps }
}

/** ファイルの先頭で1回呼ぶ: 各テストの前に偽の時計へ差し替え、あとで戻す（`fastHanamiiDeletionWait` の beforeEach／afterEach 版）。 */
export function useFastHanamiiDeletionWait(): void {
  let w: ReturnType<typeof fastHanamiiDeletionWait> | null = null
  beforeEach(() => { w = fastHanamiiDeletionWait() })
  afterEach(() => { w?.restore(); w = null })
}
