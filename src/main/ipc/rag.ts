// 📚 資料（さくらのAI Engine RAG API）の IPC（rag:* — knowledgeDir 含む）。
// 方式B: apiKey は renderer が中央ストアから引数で渡す。main は保持しない。deps は使わない。
import { app, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as ragClient from '../rag/client'
import type { IpcDeps } from './types'

export function registerRagHandlers(_deps: IpcDeps) {
  ipcMain.handle('rag:list', async (_, apiKey: string, opts?: { page?: number; pageSize?: number; name?: string; tag?: string }) => {
    try {
      const r = await ragClient.listDocuments(apiKey, opts ?? {})
      return { ok: true, meta: r.meta, documents: r.documents }
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
  })

  ipcMain.handle('rag:get', async (_, apiKey: string, id: string) => {
    try {
      const doc = await ragClient.getDocument(apiKey, id)
      return { ok: true, document: doc }
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
  })

  ipcMain.handle('rag:upload', async (_, apiKey: string, args: { filePath?: string; content?: string; filename: string; name?: string; tags?: string[] }) => {
    try {
      const doc = await ragClient.uploadDocument(apiKey, args)
      return { ok: true, document: doc }
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
  })

  ipcMain.handle('rag:update', async (_, apiKey: string, id: string, fields: { name?: string; tags?: string[] }) => {
    try {
      const doc = await ragClient.updateDocument(apiKey, id, fields)
      return { ok: true, document: doc }
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
  })

  ipcMain.handle('rag:delete', async (_, apiKey: string, id: string) => {
    try {
      await ragClient.deleteDocument(apiKey, id)
      return { ok: true }
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
  })

  ipcMain.handle('rag:chunks', async (_, apiKey: string, documentId: string, opts?: { page?: number; pageSize?: number }) => {
    try {
      const r = await ragClient.listChunks(apiKey, documentId, opts ?? {})
      return { ok: true, meta: r.meta, chunks: r.chunks }
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
  })

  ipcMain.handle('rag:query', async (_, apiKey: string, args: { query: string; tags?: string[]; topK?: number; threshold?: number }) => {
    try {
      const hits = await ragClient.queryDocuments(apiKey, args.query, args)
      return { ok: true, hits }
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
  })

  ipcMain.handle('rag:chat', async (_, apiKey: string, args: { query: string; chatModel: string; tags?: string[] }) => {
    try {
      const result = await ragClient.chatDocuments(apiKey, args.query, { chatModel: args.chatModel, tags: args.tags })
      return { ok: true, answer: result.answer, sources: result.sources }
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
  })

  // 📚 資料（R3・ナレッジコレクター）: Webから作った資料のローカル控えを保存するフォルダの絶対パスを返す。
  // 無ければ作成する。プロジェクトフォルダには置かない（公開物への混入防止・rag-plan.md §2機能C）。
  ipcMain.handle('rag:knowledgeDir', () => {
    const dir = path.join(app.getPath('userData'), 'knowledge')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  })
}
