// W-85: ガイド「AI を呼ぶのは次の場面だけです」に 📚 資料（資料検索）が抜けていた件の、
// うち「上限を超えたら資料検索も止める」側の固定テスト。
//
// 資料検索（POST /v1/documents/chat/・src/main/rag/client.ts の chatDocuments）は、
// checkBeforeRequest／recordUsage を通らないため、AIチャットの上限に達していても
// 呼び続けてしまっていた（お金の歯止め＝掟10）。
//
// ここでは chatDocuments に budgetCheck を渡すと、**実際の通信（fetch）を一切行わず**に
// 止まることを、偽の fetch に実際に流して確かめる（掟10: 文字列一致ではなく振る舞いで）。
// 変異（「allowed:false を無視して呼んでしまう」「budgetCheck 自体を呼び忘れる」）を当てると
// このテストが落ちる。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatDocuments, RAG_API_BASE } from '../src/main/rag/client'

describe('chatDocuments: budgetCheck（W-85・上限を超えたら資料検索も止める）', () => {
  let calls: { url: string; init: any }[] = []
  const okBody = { answer: 'こたえ', hits: [] }

  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(okBody),
    } as any
  }

  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(fetchImpl))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('allowed:false なら、通信そのものを一切行わずにエラーで止まる（変異「呼んでしまう」を検知）', async () => {
    const budgetCheck = () => ({ allowed: false, message: '今月の上限に達しています' })
    await expect(
      chatDocuments('key', 'これは何ですか', { chatModel: 'model-x', budgetCheck })
    ).rejects.toThrow('今月の上限に達しています')
    expect(calls).toHaveLength(0) // ★事故の再現防止: 止めたつもりで裏では呼んでいた、を許さない
  })

  it('allowed:false で message が無くても、既定のメッセージで止まる（かかっていないものを「取れなかった」と言わない言い方）', async () => {
    const budgetCheck = () => ({ allowed: false })
    await expect(
      chatDocuments('key', 'これは何ですか', { chatModel: 'model-x', budgetCheck })
    ).rejects.toThrow(/上限/)
    expect(calls).toHaveLength(0)
  })

  it('allowed:true なら、従来どおり /v1/documents/chat/ を呼ぶ', async () => {
    const budgetCheck = () => ({ allowed: true })
    const result = await chatDocuments('key', 'これは何ですか', { chatModel: 'model-x', budgetCheck })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${RAG_API_BASE}/v1/documents/chat/`)
    expect(result.answer).toBe('こたえ')
  })

  it('budgetCheck を渡さない既存の呼び出しは、従来どおり素通りする（後方互換。未対応の呼び出し側を壊さない）', async () => {
    const result = await chatDocuments('key', 'これは何ですか', { chatModel: 'model-x' })
    expect(calls).toHaveLength(1)
    expect(result.answer).toBe('こたえ')
  })

  it('budgetCheck は通信の前に一度だけ呼ばれる（呼び出し自体を忘れる変異を検知）', async () => {
    let checked = 0
    const budgetCheck = () => { checked += 1; return { allowed: true } }
    await chatDocuments('key', 'これは何ですか', { chatModel: 'model-x', budgetCheck })
    expect(checked).toBe(1)
  })
})
