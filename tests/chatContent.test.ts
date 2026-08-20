import { describe, it, expect } from 'vitest'
import { pickContent } from '../src/shared/chatContent'

describe('pickContent（非ストリーミング応答から本文を取り出す）', () => {
  it('本文があればそのまま返す', () => {
    expect(pickContent({ content: 'こんにちは' })).toBe('こんにちは')
  })

  it('本文が空なら reasoning_content で代替する', () => {
    // 推論型モデル（gpt-oss / Kimi 等）はここに答えを入れてくることがある。
    // 拾わないと、会話のまとめが毎回空になり **どこにもエラーが出ずに失敗する**。
    expect(pickContent({ content: '', reasoning_content: '答え' })).toBe('答え')
  })

  it('提供側が reasoning という名前で返しても拾う（streamDelta と同じ扱い）', () => {
    expect(pickContent({ content: '', reasoning: '答え' })).toBe('答え')
  })

  it('本文があるときは推論内容を優先しない', () => {
    expect(pickContent({ content: '本文', reasoning_content: '思考' })).toBe('本文')
  })

  it('空白だけの本文は「空」とみなす', () => {
    expect(pickContent({ content: '  \n ', reasoning: '答え' })).toBe('答え')
  })

  it('どちらも無ければ空文字（呼び出し側が「取得できませんでした」と扱える）', () => {
    expect(pickContent({})).toBe('')
    expect(pickContent(undefined)).toBe('')
    expect(pickContent(null)).toBe('')
    expect(pickContent({ content: null, reasoning: 123 })).toBe('')
  })
})
