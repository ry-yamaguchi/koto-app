// client.ts — さくらのAI Engine RAG API（ドキュメント管理・検索・チャット）への fetch ラッパ。
//
// src/main/hanamii/client.ts と同じ構成を踏襲する。Electron メインプロセス（Node）専用:
// グローバルの fetch / AbortController を用いる純粋ロジックのみで、electron や renderer 側の
// コードは一切 import しない（esbuild で単体テスト可能な状態を保つ）。
//
// 認証: 全APIコールで `Authorization: Bearer <AI EngineのAPIキー>`（引数で受け取る。main は保持しない）。
// API仕様は docs/rag-plan.md §1（検証済み OpenAPI）のみを信頼する。

import * as fs from 'fs'
import { parseDocument, parseDocumentList, parseChunkList, parseQueryResult, parseChatResult, type RagDocument, type RagPageMeta, type RagChunk, type RagQueryHit, type RagChatResult } from './parse'

/** RAG API のベースURL（/v1 は含めない。パス側に書く）。 */
export const RAG_API_BASE = 'https://api.ai.sakura.ad.jp'

/** 埋め込みモデル。ゴールデンパス固定（distance関数・チャンクサイズと同じ思想）。 */
export const RAG_EMBED_MODEL = 'multilingual-e5-large'

/** IDE経由で登録した資料に必ず付与するタグ（由来識別・「IDEで追加した資料のみ表示」フィルタ用）。 */
export const RAG_IDE_TAG = 'sakura-ide'

/** query/chat に送信する質問文の最大長。超過分は呼び出し側で切り詰める。 */
export const RAG_QUERY_MAX = 1000

function documentsPath(): string {
  return '/v1/documents/'
}
function documentPath(id: string): string {
  return `/v1/documents/${encodeURIComponent(id)}/`
}
function chunksPath(documentId: string): string {
  return `/v1/documents/${encodeURIComponent(documentId)}/chunks/`
}
function queryPath(): string {
  return '/v1/documents/query/'
}
function chatPath(): string {
  return '/v1/documents/chat/'
}
function uploadPath(): string {
  return '/v1/documents/upload/'
}

/** HTTPエラーを日本語メッセージに整形する（status と本文先頭200字を含める）。 */
function formatHttpError(status: number, bodyText: string): Error {
  const snippet = bodyText ? bodyText.slice(0, 200) : ''
  if (status === 401 || status === 403) {
    return new Error(`認証に失敗しました（AI Engine のAPIキーを確認してください。HTTP ${status}）${snippet ? ': ' + snippet : ''}`)
  }
  return new Error(`さくらのAI Engine への通信に失敗しました（HTTP ${status}）${snippet ? ': ' + snippet : ''}`)
}

async function requestJson(
  apiKey: string,
  method: string,
  pathname: string,
  opts: { query?: Record<string, string | number | undefined>; body?: unknown; timeoutMs?: number } = {}
): Promise<unknown> {
  const url = new URL(pathname, RAG_API_BASE)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  let res: Response
  try {
    res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error('さくらのAI Engine への通信がタイムアウトしました。しばらくしてから再度お試しください。')
    }
    throw new Error(`さくらのAI Engine への通信に失敗しました: ${e?.message ?? String(e)}`)
  }
  const text = await res.text()
  if (!res.ok) throw formatHttpError(res.status, text)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** タグ配列に RAG_IDE_TAG を重複無しで追加する。 */
export function withIdeTag(tags: string[] | undefined): string[] {
  const set = new Set((tags ?? []).map(t => t.trim()).filter(Boolean))
  set.add(RAG_IDE_TAG)
  return Array.from(set)
}

export interface RagListOpts {
  page?: number
  pageSize?: number
  name?: string
  tag?: string
}

/** GET /v1/documents/ — 一覧。model では絞らない（コンパネ登録の別モデル資料も見せ、UI側でモデル名を表示する）。 */
export async function listDocuments(apiKey: string, opts: RagListOpts = {}): Promise<{ meta: RagPageMeta; documents: RagDocument[] }> {
  const raw = await requestJson(apiKey, 'GET', documentsPath(), {
    query: { name: opts.name, tag: opts.tag, page: opts.page, page_size: opts.pageSize },
  })
  return parseDocumentList(raw)
}

/** GET /v1/documents/{id}/ — 個別取得（content・error_message を含む）。 */
export async function getDocument(apiKey: string, id: string): Promise<RagDocument | null> {
  const raw = await requestJson(apiKey, 'GET', documentPath(id))
  return parseDocument(raw)
}

/** PUT /v1/documents/{id}/ — 更新（書込可能なのは name / tags のみ）。 */
export async function updateDocument(apiKey: string, id: string, fields: { name?: string; tags?: string[] }): Promise<RagDocument | null> {
  const raw = await requestJson(apiKey, 'PUT', documentPath(id), { body: fields })
  return parseDocument(raw)
}

/** DELETE /v1/documents/{id}/ — 削除。 */
export async function deleteDocument(apiKey: string, id: string): Promise<void> {
  await requestJson(apiKey, 'DELETE', documentPath(id))
}

/** GET /v1/documents/{document_pk}/chunks/ — チャンク一覧。 */
export async function listChunks(apiKey: string, documentId: string, opts: { page?: number; pageSize?: number } = {}): Promise<{ meta: RagPageMeta; chunks: RagChunk[] }> {
  const raw = await requestJson(apiKey, 'GET', chunksPath(documentId), {
    query: { page: opts.page, page_size: opts.pageSize },
  })
  return parseChunkList(raw)
}

export interface RagQueryOpts {
  tags?: string[]
  topK?: number
  threshold?: number
}

/** query 文を送信前に必ず RAG_QUERY_MAX 文字へ切り詰める。 */
function clampQuery(query: string): string {
  return query.length > RAG_QUERY_MAX ? query.slice(0, RAG_QUERY_MAX) : query
}

/** POST /v1/documents/query/ — ベクトル検索のみ。 */
export async function queryDocuments(apiKey: string, query: string, opts: RagQueryOpts = {}): Promise<RagQueryHit[]> {
  const raw = await requestJson(apiKey, 'POST', queryPath(), {
    body: {
      query: clampQuery(query),
      model: RAG_EMBED_MODEL,
      ...(opts.tags && opts.tags.length ? { tags: opts.tags } : {}),
      ...(opts.topK !== undefined ? { top_k: opts.topK } : {}),
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    },
  })
  return parseQueryResult(raw)
}

export interface RagChatOpts {
  chatModel: string
  tags?: string[]
  topK?: number
  threshold?: number
  prompt?: string
  useFullContent?: boolean
}

/** POST /v1/documents/chat/ — 検索＋回答生成。 */
export async function chatDocuments(apiKey: string, query: string, opts: RagChatOpts): Promise<RagChatResult> {
  const raw = await requestJson(apiKey, 'POST', chatPath(), {
    body: {
      query: clampQuery(query),
      chat_model: opts.chatModel,
      model: RAG_EMBED_MODEL,
      ...(opts.tags && opts.tags.length ? { tags: opts.tags } : {}),
      ...(opts.topK !== undefined ? { top_k: opts.topK } : {}),
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(opts.useFullContent !== undefined ? { use_full_content: opts.useFullContent } : {}),
    },
    timeoutMs: 60000,
  })
  return parseChatResult(raw)
}

export interface RagUploadArgs {
  filePath?: string
  content?: string
  filename: string
  name?: string
  tags?: string[]
}

/** POST /v1/documents/upload/ — multipart/form-data アップロード。model は RAG_EMBED_MODEL 固定・chunk_size は送らない。 */
export async function uploadDocument(apiKey: string, args: RagUploadArgs): Promise<RagDocument | null> {
  if (!args.filePath && args.content === undefined) {
    throw new Error('アップロードするファイル、または内容がありません')
  }
  const buffer = args.filePath ? fs.readFileSync(args.filePath) : Buffer.from(args.content ?? '', 'utf-8')
  const form = new FormData()
  const blob = new Blob([buffer])
  form.append('file', blob, args.filename)
  form.append('model', RAG_EMBED_MODEL)
  if (args.name) form.append('name', args.name)
  for (const tag of withIdeTag(args.tags)) form.append('tags', tag)

  let res: Response
  try {
    res = await fetch(new URL(uploadPath(), RAG_API_BASE).toString(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120000),
    })
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error('アップロードがタイムアウトしました。ファイルサイズを確認し、しばらくしてから再度お試しください。')
    }
    throw new Error(`アップロードに失敗しました: ${e?.message ?? String(e)}`)
  }
  const text = await res.text()
  if (!res.ok) throw formatHttpError(res.status, text)
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return parseDocument(data)
}
