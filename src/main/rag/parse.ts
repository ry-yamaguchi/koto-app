// parse.ts — さくらのAI Engine RAG API のレスポンス→型への純粋パーサ。
//
// electron や fetch を一切 import しない（Vitest で単体テスト可能な状態を保つ）。
// レスポンスの形は docs/rag-plan.md §1（検証済み）のみを信じ、フィールド欠落時も
// 例外を投げず防御的にパースする（実APIの揺れに強くするため）。

/** ドキュメントの状態ライフサイクル: pending → processing → available / error / deleted。 */
export type RagDocumentStatus = 'pending' | 'processing' | 'available' | 'error' | 'deleted'

/** documents 一覧・個別取得に共通する資料の型（content は個別取得のみ含む）。 */
export interface RagDocument {
  id: string
  name: string
  status: RagDocumentStatus | string
  tags: string[]
  model: string | null
  chunkSize: number | null
  chunkCount: number | null
  errorMessage: string | null
  content: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** チャンク1件。 */
export interface RagChunk {
  document: string | null
  chunkIndex: number | null
  content: string
  metadata: Record<string, unknown> | null
}

/** query API の1ヒット分（documentはDocumentList相当）。 */
export interface RagQueryHit {
  document: RagDocument | null
  chunkIndex: number | null
  distance: number | null
  content: string
  metadata: Record<string, unknown> | null
}

/** chat API の応答。 */
export interface RagChatResult {
  answer: string
  sources: RagQueryHit[]
}

/** 一覧系APIのページネーション情報。 */
export interface RagPageMeta {
  page: number | null
  pageSize: number | null
  totalPages: number | null
  count: number | null
  next: string | null
  previous: string | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** 状態が終端（それ以上変化しない）かどうか。ポーリング停止条件に使う。 */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return status === 'available' || status === 'error' || status === 'deleted'
}

/** 状態を非エンジニア向けの日本語ラベルに変換する。 */
export function statusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'pending':
    case 'processing':
      return '取り込み中'
    case 'available':
      return '利用可能'
    case 'error':
      return 'エラー'
    case 'deleted':
      return '削除済み'
    default:
      return status ? String(status) : '不明'
  }
}

/** 1件の Document（一覧・個別共通。個別取得のみ content が入る）をパースする。 */
export function parseDocument(raw: unknown): RagDocument | null {
  const d = record(raw)
  if (!d) return null
  const id = str(d.id)
  if (!id) return null
  return {
    id,
    name: str(d.name) ?? id,
    status: str(d.status) ?? 'pending',
    tags: strArray(d.tags),
    model: str(d.model),
    chunkSize: num(d.chunk_size),
    chunkCount: num(d.chunk_count),
    errorMessage: str(d.error_message),
    content: str(d.content),
    createdAt: str(d.created_at),
    updatedAt: str(d.updated_at),
  }
}

/** GET /documents/ の応答 { meta, results } をパースする。 */
export function parseDocumentList(raw: unknown): { meta: RagPageMeta; documents: RagDocument[] } {
  const d = record(raw)
  const results = Array.isArray(d?.results) ? d!.results : []
  const documents = results.map(parseDocument).filter((x): x is RagDocument => x !== null)
  return { meta: parsePageMeta(d?.meta), documents }
}

/** meta オブジェクトをパースする（欠落時は全て null）。 */
export function parsePageMeta(raw: unknown): RagPageMeta {
  const m = record(raw)
  return {
    page: num(m?.page),
    pageSize: num(m?.page_size),
    totalPages: num(m?.total_pages),
    count: num(m?.count),
    next: str(m?.next),
    previous: str(m?.previous),
  }
}

/** 1件のチャンクをパースする。 */
export function parseChunk(raw: unknown): RagChunk | null {
  const c = record(raw)
  if (!c) return null
  return {
    document: str(c.document),
    chunkIndex: num(c.chunk_index),
    content: str(c.content) ?? '',
    metadata: record(c.metadata),
  }
}

/** GET .../chunks/ の応答 { meta, results } をパースする。 */
export function parseChunkList(raw: unknown): { meta: RagPageMeta; chunks: RagChunk[] } {
  const d = record(raw)
  const results = Array.isArray(d?.results) ? d!.results : []
  const chunks = results.map(parseChunk).filter((x): x is RagChunk => x !== null)
  return { meta: parsePageMeta(d?.meta), chunks }
}

/** query の1ヒット分をパースする。 */
export function parseQueryHit(raw: unknown): RagQueryHit | null {
  const h = record(raw)
  if (!h) return null
  return {
    document: parseDocument(h.document),
    chunkIndex: num(h.chunk_index),
    distance: num(h.distance),
    content: str(h.content) ?? '',
    metadata: record(h.metadata),
  }
}

/** POST /documents/query/ の応答 { results } をパースする。 */
export function parseQueryResult(raw: unknown): RagQueryHit[] {
  const d = record(raw)
  const results = Array.isArray(d?.results) ? d!.results : []
  return results.map(parseQueryHit).filter((x): x is RagQueryHit => x !== null)
}

/** POST /documents/chat/ の応答 { answer, sources } をパースする。 */
export function parseChatResult(raw: unknown): RagChatResult {
  const d = record(raw)
  const sourcesRaw = Array.isArray(d?.sources) ? d!.sources : []
  return {
    answer: str(d?.answer) ?? '',
    sources: sourcesRaw.map(parseQueryHit).filter((x): x is RagQueryHit => x !== null),
  }
}

/** upload の応答 { id, status, content, name, tags, model, chunk_size } をパースする（Document型と共通）。 */
export function parseUploadResult(raw: unknown): RagDocument | null {
  return parseDocument(raw)
}
