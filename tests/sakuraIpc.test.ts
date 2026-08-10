import { describe, it, expect } from 'vitest'
import { describeSakuraError } from '../src/main/ipc/sakura'

// describeSakuraError: さくらのAI Engine接続テスト（所見14）で OpenAI SDK の生エラー（英語＋HTTPステータス）が
// そのまま画面に出ていた問題の修正。既知の原因（401/403・429・ネットワーク）は日本語化し、未知は先頭120字を見せる。
describe('describeSakuraError', () => {
  it('describes 401 as an invalid API key', () => {
    expect(describeSakuraError({ status: 401, message: '401 Incorrect API key provided' }))
      .toBe('APIキーが正しくないようです。コピーし直して貼り付けてください')
  })

  it('describes 403 the same as 401', () => {
    expect(describeSakuraError({ status: 403, message: '403 Forbidden' }))
      .toBe('APIキーが正しくないようです。コピーし直して貼り付けてください')
  })

  it('describes 429 as rate limiting', () => {
    expect(describeSakuraError({ status: 429, message: '429 Too Many Requests' }))
      .toBe('アクセスが集中しています。しばらく待ってからもう一度お試しください')
  })

  it('describes a network error via cause.code (undici fetch failures)', () => {
    expect(describeSakuraError({ message: 'fetch failed', cause: { code: 'ENOTFOUND' } }))
      .toBe('インターネット接続を確認してください')
  })

  it('describes a network error via message text when no status/cause is present', () => {
    expect(describeSakuraError({ message: 'request to https://api.ai.sakura.ad.jp/v1 failed, reason: getaddrinfo ENOTFOUND' }))
      .toBe('インターネット接続を確認してください')
  })

  it('falls back to a truncated raw message for unknown errors', () => {
    const longMsg = 'x'.repeat(200)
    expect(describeSakuraError({ status: 500, message: longMsg }))
      .toBe(`接続テストに失敗しました: ${longMsg.slice(0, 120)}`)
  })

  it('handles a plain Error instance (no status field)', () => {
    expect(describeSakuraError(new Error('something odd happened')))
      .toBe('接続テストに失敗しました: something odd happened')
  })

  it('handles a non-object thrown value', () => {
    expect(describeSakuraError('boom')).toBe('接続テストに失敗しました: boom')
  })
})
