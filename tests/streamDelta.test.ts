import { describe, it, expect } from 'vitest'
import { newStreamState, applyChunk, finishedToolCalls } from '../src/shared/streamDelta'

// AI Engine のストリーミング応答の組み立て（チャットの中枢）。
// 2026-08-05 まで ipcMain ハンドラの中に直接書かれており、単体テストが一切できなかった。
// ここが壊れると「AIが作業したはずなのに何も起きない」「引数が壊れて誤ったファイルを書く」
// といった、原因の分かりにくい不具合になる。

/** 提供側から来るチャンクの形を組み立てるヘルパー。 */
const chunk = (delta: any, usage?: any) => ({ choices: [{ delta }], ...(usage ? { usage } : {}) })

describe('本文の組み立て', () => {
  it('断片を順に継ぎ足し、そのつど差分を返す（画面へ流すため）', () => {
    const s = newStreamState()
    expect(applyChunk(s, chunk({ content: 'こんに' })).contentDelta).toBe('こんに')
    expect(applyChunk(s, chunk({ content: 'ちは' })).contentDelta).toBe('ちは')
    expect(s.content).toBe('こんにちは')
  })

  it('本文が無いチャンクでは差分を返さない', () => {
    const s = newStreamState()
    expect(applyChunk(s, chunk({})).contentDelta).toBe('')
    expect(applyChunk(s, chunk({ content: '' })).contentDelta).toBe('')
    expect(s.content).toBe('')
  })
})

describe('思考（推論モデル）の組み立て', () => {
  it('reasoning_content を継ぎ足す', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ reasoning_content: 'まず' }))
    applyChunk(s, chunk({ reasoning_content: '考える' }))
    expect(s.reasoning).toBe('まず考える')
  })

  it('reasoning という名前で来る提供側にも対応する', () => {
    const s = newStreamState()
    expect(applyChunk(s, chunk({ reasoning: '別名で届く' })).reasoningDelta).toBe('別名で届く')
    expect(s.reasoning).toBe('別名で届く')
  })

  it('本文と思考は混ざらない', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ content: '答え', reasoning_content: '思考' }))
    expect(s.content).toBe('答え')
    expect(s.reasoning).toBe('思考')
  })
})

describe('ツール呼び出しの復元（最重要）', () => {
  it('名前も引数も分割して届くのを1つに復元する', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_' } }] }))
    applyChunk(s, chunk({ tool_calls: [{ index: 0, function: { name: 'file' } }] }))
    applyChunk(s, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }))
    applyChunk(s, chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.html"}' } }] }))

    const calls = finishedToolCalls(s)!
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('call_1')
    expect(calls[0].function.name).toBe('write_file')
    expect(calls[0].function.arguments).toBe('{"path":"a.html"}')
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'a.html' }) // 実際に読める形か
  })

  it('複数のツールを index ごとに別々に組み立てる', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'read_file', arguments: '{}' } }] }))
    applyChunk(s, chunk({ tool_calls: [{ index: 1, id: 'c1', function: { name: 'list_files', arguments: '{}' } }] }))
    const calls = finishedToolCalls(s)!
    expect(calls.map(c => c.function.name)).toEqual(['read_file', 'list_files'])
    expect(calls.map(c => c.id)).toEqual(['c0', 'c1'])
  })

  it('1つのチャンクに複数のツールが入っていても扱える', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ tool_calls: [
      { index: 0, id: 'c0', function: { name: 'a', arguments: '{}' } },
      { index: 1, id: 'c1', function: { name: 'b', arguments: '{}' } },
    ] }))
    expect(finishedToolCalls(s)).toHaveLength(2)
  })

  it('index が飛んでいても歯抜けを詰めて返す（undefined を渡さない）', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ tool_calls: [{ index: 2, id: 'c2', function: { name: 'x', arguments: '{}' } }] }))
    const calls = finishedToolCalls(s)!
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('c2')
    expect(calls.every(c => c && c.function)).toBe(true)
  })

  it('id が後から届いても取りこぼさない', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ tool_calls: [{ index: 0, function: { name: 'write_file' } }] }))
    applyChunk(s, chunk({ tool_calls: [{ index: 0, id: '遅れて来たid' }] }))
    expect(finishedToolCalls(s)![0].id).toBe('遅れて来たid')
  })

  it('ツール呼び出しが無ければ null を返す（呼び出し側の分岐条件）', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ content: 'ただの返事' }))
    expect(finishedToolCalls(s)).toBeNull()
  })

  // 現在の仕様の明文化: index を省く提供側では1件に継ぎ足される。
  // OpenAI互換のストリーミング仕様では index が付くため現状はこれでよいが、
  // 「index を省いて複数ツールを返す」提供側が現れたら混ざる（変更時はここを見直す）。
  it('index が無いときは 0 番として扱う（仕様の固定）', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ tool_calls: [{ id: 'c', function: { name: 'a', arguments: '{}' } }] }))
    const calls = finishedToolCalls(s)!
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('a')
  })
})

describe('トークン数（usage）', () => {
  it('最後に届いた usage を採用する', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ content: 'a' }, { prompt_tokens: 1, completion_tokens: 1 }))
    applyChunk(s, chunk({}, { prompt_tokens: 10, completion_tokens: 20 }))
    expect(s.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20 })
  })

  it('usage が来なければ null のまま（見積りへ切り替える判断に使う）', () => {
    const s = newStreamState()
    applyChunk(s, chunk({ content: 'a' }))
    expect(s.usage).toBeNull()
  })
})

describe('壊れたチャンクでも落ちない', () => {
  it('choices が無い・空・null でも例外を投げない', () => {
    const s = newStreamState()
    expect(() => applyChunk(s, {})).not.toThrow()
    expect(() => applyChunk(s, { choices: [] })).not.toThrow()
    expect(() => applyChunk(s, null)).not.toThrow()
    expect(() => applyChunk(s, { choices: [{}] })).not.toThrow()
  })

  it('tool_calls が配列でない・中身が null でも落ちない', () => {
    const s = newStreamState()
    expect(() => applyChunk(s, chunk({ tool_calls: 'こわれている' }))).not.toThrow()
    expect(() => applyChunk(s, chunk({ tool_calls: [null] }))).not.toThrow()
    expect(() => applyChunk(s, chunk({ tool_calls: [{ index: 0 }] }))).not.toThrow()
  })

  it('壊れたチャンクの後でも、正しいチャンクは正しく処理できる', () => {
    const s = newStreamState()
    applyChunk(s, null)
    applyChunk(s, chunk({ tool_calls: [null] }))
    applyChunk(s, chunk({ content: '続きは大丈夫' }))
    expect(s.content).toBe('続きは大丈夫')
  })
})
