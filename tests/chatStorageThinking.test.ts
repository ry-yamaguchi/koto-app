import { describe, it, expect } from 'vitest'
import { forStorage } from '../src/shared/chatStorage'
import type { ChatMessage } from '../src/renderer/hooks/useAiChat'

// 2026-08-03: 推論モデルの「思考」は表示専用。本文の何倍にもなり得るため、
// チャット履歴ファイル（.sakuraide/chat.json）には保存しない。
//
// ⚠️ B'-3e-a で src/renderer/chatStorage.ts を削除した（単独チャットの保存が main の
// convStore.ts 経由へ移り、呼び出しが無くなったため）。forStorage の実体はもともと
// src/shared/chatStorage.ts にあり、renderer/chatStorage.ts はそれを re-export していた
// だけなので、import 元をそちらへ直す（検証している中身は一字一句変わらない）。

describe('forStorage（保存前に思考を落とす）', () => {
  it('thinking を落とし、他のフィールドは残す', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: '答えです', thinking: 'とても長い思考…'.repeat(100) },
    ]
    const out = forStorage(msgs)
    expect(out[1]).toEqual({ role: 'assistant', content: '答えです' })
    expect('thinking' in out[1]).toBe(false)
    expect(out[0]).toEqual({ role: 'user', content: 'こんにちは' })
  })

  it('thinking が無いメッセージはそのまま（同一参照で無駄なコピーをしない）', () => {
    const m: ChatMessage = { role: 'assistant', content: 'ふつうの返信', toolNote: true }
    const out = forStorage([m])
    expect(out[0]).toBe(m)
  })

  it('保存サイズが実際に小さくなる', () => {
    const msgs: ChatMessage[] = [{ role: 'assistant', content: 'ok', thinking: 'あ'.repeat(5000) }]
    expect(JSON.stringify(forStorage(msgs)).length).toBeLessThan(JSON.stringify(msgs).length / 10)
  })

  it('空配列・未定義でも落ちない', () => {
    expect(forStorage([])).toEqual([])
    expect(forStorage(undefined as any)).toEqual([])
  })

  it('画像などの既存フィールドは保持する（保存対象から誤って消さない）', () => {
    const out = forStorage([{ role: 'user', content: '見て', images: ['data:image/png;base64,xxx'] }])
    expect(out[0].images).toEqual(['data:image/png;base64,xxx'])
  })
})
