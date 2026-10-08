// W-85（2026-09-27 決定）の配線の固定テスト: 上限を超えたら、資料の検索・回答づくり・取り込みも止める。
//
// 前の段で src/main/rag/client.ts に上限の確認（budgetCheck）を受ける口ができたが、
// src/main/ipc/rag.ts の各ハンドラが**渡していなかった**ため、上限を超えても資料検索は止まらなかった
// （tests/w-projectB-rag-budget-guard.test.ts は client の口だけを見ており、この配線には当たらない）。
// 「3つのうち1つだけ配線」という形を繰り返さないよう、モデルを使うハンドラ（rag:query・rag:chat・
// rag:upload）を**全部**、実際のハンドラ→実際の usageStore→偽の fetch の順に流して固定する。
//
// ここはソースの文字列を読まない（掟10）。上限は本物の usageStore（保存先だけ使い捨て）に
// 「利用実績を記録して超えさせる」ことで作り、AI Engine への要求は偽の fetch の呼び出し回数で数える。
//   - 超えていれば: 要求は1件も出ない（fetch 0回）・止めた文はチャットで止めるときと同じ文
//   - 超えていなければ: 要求が1件出て、従来どおり成功する
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/nonexistent-koto-test-userdata' },
}))

import { registerRagHandlers } from '../src/main/ipc/rag'
import { initUsageStore, setSettings, recordUsage, checkBeforeRequest } from '../src/main/usageStore'
import { hashKey } from '../src/shared/usageBudget'
import { queryDocuments, chatDocuments, uploadDocument, RAG_API_BASE } from '../src/main/rag/client'

const KEY_A = 'TEST-KEY-A'
const KEY_B = 'TEST-KEY-B'

/** 偽の fetch が受けた要求（URL だけ数える）。 */
let calls: string[] = []

/** URL ごとに、パーサが読める最小の応答を返す偽の fetch。 */
const fakeFetch = async (url: string) => {
  calls.push(url)
  let body: unknown = {}
  if (url.endsWith('/v1/documents/query/')) body = { results: [] }
  else if (url.endsWith('/v1/documents/chat/')) body = { answer: 'こたえ', sources: [] }
  else if (url.endsWith('/v1/documents/upload/')) body = { id: 'doc-1', name: 'a.md', status: 'pending' }
  else if (url.includes('/chunks/')) body = { meta: {}, results: [] }
  else if (/\/v1\/documents\/[^/]+\/$/.test(new URL(url).pathname) && !url.endsWith('/v1/documents/')) body = { id: 'doc-1', name: 'a.md', status: 'available' }
  else body = { meta: {}, results: [] }
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as any
}

/** そのキーの今月の利用額を、上限（¥100）より大きくする（gpt-oss-120b: 入力¥15＋出力¥75 /100万tok ×1000万tok）。 */
function exceedLimit(apiKey: string) {
  recordUsage(hashKey(apiKey), 'gpt-oss-120b', 10_000_000, 10_000_000)
}

function invoke(channel: string, ...args: any[]) {
  const fn = h.handlers.get(channel)
  if (!fn) throw new Error(`ハンドラが登録されていない: ${channel}`)
  return fn({}, ...args)
}

let tmpDir = ''

beforeAll(() => {
  registerRagHandlers({} as any)
})

beforeEach(() => {
  calls = []
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-rag-budget-'))
  initUsageStore(tmpDir)
  // 上限 ¥100・「上限に達したら止める」オン（実際の設定と同じ形）
  setSettings({ monthlyLimitYen: 100, enforce: true, warnRatio: 0.8, perKeyLimits: {} })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})

afterEach(() => {
  vi.unstubAllGlobals()
  initUsageStore(null) // 保存のタイマーも止める
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// モデルを使うハンドラ3つ。どれか1つでも配線が抜ければ、その行だけが落ちる。
const MODEL_HANDLERS: { name: string; channel: string; args: (key: string) => any[]; url: string }[] = [
  { name: '資料の検索（rag:query）', channel: 'rag:query', args: (k) => [k, { query: 'これは何ですか', topK: 3 }], url: `${RAG_API_BASE}/v1/documents/query/` },
  { name: '回答づくり（rag:chat）', channel: 'rag:chat', args: (k) => [k, { query: 'これは何ですか', chatModel: 'gpt-oss-120b' }], url: `${RAG_API_BASE}/v1/documents/chat/` },
  { name: '取り込みの索引づくり（rag:upload）', channel: 'rag:upload', args: (k) => [k, { content: 'ほんぶん', filename: 'a.md' }], url: `${RAG_API_BASE}/v1/documents/upload/` },
]

describe('ipc/rag.ts: モデルを使うハンドラは、上限を超えたら AI Engine へ要求を出さない（W-85）', () => {
  for (const hd of MODEL_HANDLERS) {
    describe(hd.name, () => {
      it('上限を超えていれば、要求は1件も出ない・止めた文はチャットで止めるときと同じ文', async () => {
        exceedLimit(KEY_A)
        const chatMessage = checkBeforeRequest(hashKey(KEY_A)).message
        expect(chatMessage).toBeTruthy() // 前提: いま本当に「止める」状態（テスト自体が空振りしていない）
        const r = await invoke(hd.channel, ...hd.args(KEY_A))
        expect(calls).toHaveLength(0) // ★お金の歯止め: 止めたつもりで裏では呼んでいた、を許さない
        expect(r.ok).toBe(false)
        expect(r.error).toBe(chatMessage) // 文は checkBeforeRequestOf の message（言い換えない）
      })

      it('上限を超えていなければ、要求が1件出て成功する', async () => {
        const r = await invoke(hd.channel, ...hd.args(KEY_A))
        expect(r.ok).toBe(true)
        expect(calls).toEqual([hd.url])
      })

      it('判定は「渡されたキーの指紋」で行う（別のキーが超えていても、このキーは止まらない）', async () => {
        exceedLimit(KEY_A)
        const r = await invoke(hd.channel, ...hd.args(KEY_B))
        expect(r.ok).toBe(true)
        expect(calls).toEqual([hd.url])
      })

      it('「上限に達したら止める」がオフなら、チャットと同じく止めない（警告だけ）', async () => {
        setSettings({ monthlyLimitYen: 100, enforce: false, warnRatio: 0.8, perKeyLimits: {} })
        exceedLimit(KEY_A)
        const r = await invoke(hd.channel, ...hd.args(KEY_A))
        expect(r.ok).toBe(true)
        expect(calls).toEqual([hd.url])
      })

      it('上限が無制限（null）なら止めない', async () => {
        setSettings({ monthlyLimitYen: null, enforce: true, warnRatio: 0.8, perKeyLimits: {} })
        exceedLimit(KEY_A)
        const r = await invoke(hd.channel, ...hd.args(KEY_A))
        expect(r.ok).toBe(true)
        expect(calls).toEqual([hd.url])
      })
    })
  }

  it('モデルを使わない資料の整理（一覧・取得・更新・削除・チャンク一覧）は、上限を超えていても止めない', async () => {
    exceedLimit(KEY_A)
    const results = [
      await invoke('rag:list', KEY_A),
      await invoke('rag:get', KEY_A, 'doc-1'),
      await invoke('rag:update', KEY_A, 'doc-1', { name: 'b.md' }),
      await invoke('rag:delete', KEY_A, 'doc-1'),
      await invoke('rag:chunks', KEY_A, 'doc-1'),
    ]
    expect(results.map(r => r.ok)).toEqual([true, true, true, true, true])
    expect(calls).toHaveLength(5)
  })
})

describe('rag/client.ts: 検索・取り込みも、budgetCheck が止めたら通信そのものを行わない（W-85）', () => {
  it('queryDocuments: allowed:false なら、通信を行わずに budgetCheck の文で止まる', async () => {
    const budgetCheck = () => ({ allowed: false, message: '今月の上限に達しています' })
    await expect(queryDocuments('key', 'これは何ですか', { budgetCheck })).rejects.toThrow('今月の上限に達しています')
    expect(calls).toHaveLength(0)
  })

  it('queryDocuments: allowed:true なら通信する・budgetCheck は通信の前に1度だけ呼ばれる・渡さなければ素通り', async () => {
    let checked = 0
    await queryDocuments('key', 'これは何ですか', { budgetCheck: () => { checked += 1; return { allowed: true } } })
    expect(checked).toBe(1)
    expect(calls).toEqual([`${RAG_API_BASE}/v1/documents/query/`])
    await queryDocuments('key', 'これは何ですか')
    expect(calls).toHaveLength(2)
  })

  it('uploadDocument: allowed:false なら、通信を行わずに budgetCheck の文で止まる', async () => {
    const budgetCheck = () => ({ allowed: false, message: '今月の上限に達しています' })
    await expect(uploadDocument('key', { content: 'ほんぶん', filename: 'a.md', budgetCheck })).rejects.toThrow('今月の上限に達しています')
    expect(calls).toHaveLength(0)
  })

  it('uploadDocument: allowed:true なら通信する・渡さなければ素通り', async () => {
    const doc = await uploadDocument('key', { content: 'ほんぶん', filename: 'a.md', budgetCheck: () => ({ allowed: true }) })
    expect(doc?.id).toBe('doc-1')
    await uploadDocument('key', { content: 'ほんぶん', filename: 'a.md' })
    expect(calls).toEqual([`${RAG_API_BASE}/v1/documents/upload/`, `${RAG_API_BASE}/v1/documents/upload/`])
  })

  it('message が無いときの既定文は、資料の検索と取り込みで言い分けて「上限」を含む（検索でないものを検索と言わない）', async () => {
    const budgetCheck = () => ({ allowed: false })
    await expect(queryDocuments('key', 'q', { budgetCheck })).rejects.toThrow(/上限.*資料の検索/)
    await expect(chatDocuments('key', 'q', { chatModel: 'm', budgetCheck })).rejects.toThrow(/上限.*資料の検索/)
    await expect(uploadDocument('key', { content: 'x', filename: 'a.md', budgetCheck })).rejects.toThrow(/上限.*資料の取り込み/)
    expect(calls).toHaveLength(0)
  })
})
