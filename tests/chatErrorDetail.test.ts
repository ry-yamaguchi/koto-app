import { describe, it, expect } from 'vitest'
import { formatChatError } from '../src/shared/aiToolsCore'
import { splitFailureDetail } from '../src/shared/failureDetail'

// チャットの失敗の文（日本語に置き換えた分岐）に、原文を「詳細: …」として最後の行に添える。
// 日本語の文そのものは変えない（変えるのは詳細の行を足すことだけ）。見分けられない失敗（受け皿）は原文を既に出しているので重ねない。

const parts = (s: string) => splitFailureDetail(s)

function connectionError(code: string, host = 'api.ai.sakura.ad.jp'): Error {
  // openai の APIConnectionError と同じ形: message は 'Connection error.' だけで、原因は cause.code の中
  const err = new Error('Connection error.') as Error & { cause?: unknown }
  err.cause = Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code })
  return err
}

describe('formatChatError - 日本語の固定文には、原文が詳細の行で付く', () => {
  const cases: { name: string; msg: string; engine?: 'sakura' | 'claude'; thrown?: unknown; text: RegExp; detail: RegExp }[] = [
    { name: '401（さくら）', msg: '401 Unauthorized', text: /^APIキーが認証されませんでした（401）/, detail: /401 Unauthorized/ },
    { name: '401（Claude）', msg: '401 invalid x-api-key', engine: 'claude', text: /^Claude のAPIキーが認証されませんでした（401）/, detail: /invalid x-api-key/ },
    { name: '402（Claude）', msg: '402 Your credit balance is too low', engine: 'claude', text: /^Claude を利用できませんでした/, detail: /credit balance is too low/ },
    { name: '429', msg: '429 Too Many Requests', text: /^混み合っています/, detail: /429 Too Many Requests/ },
    { name: '会話の長さ', msg: "This model's maximum context length is 8192 tokens", text: /^会話が長くなりすぎました/, detail: /maximum context length/ },
    { name: '403', msg: '403 Forbidden', text: /^APIキーに、この操作の権限がありませんでした（403）/, detail: /403 Forbidden/ },
    { name: '404', msg: '404 model_not_found', text: /^選んでいるモデルが見つかりませんでした（404）/, detail: /model_not_found/ },
    { name: '503', msg: '503 Service Unavailable', text: /^AI のサービス側で一時的な問題が起きています/, detail: /503 Service Unavailable/ },
    { name: 'Claude の異常終了', msg: 'Claude Code process exited with code 1: boom', engine: 'claude', text: /^Claude が正常に動きませんでした/, detail: /exited with code 1: boom/ },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const shown = formatChatError(c.msg, c.engine ?? 'sakura', c.thrown)
      const { text, detail } = parts(shown)
      expect(text).toMatch(c.text)
      expect(detail).toMatch(c.detail)
      // 詳細はいつも最後の1行
      expect(shown.endsWith(`\n詳細: ${detail}`)).toBe(true)
      expect(detail).not.toContain('\n')
    })
  }

  it('状態番号が文面に無い失敗（例外の status だけが 429）でも、番号を詳細に残す', () => {
    const thrown = Object.assign(new Error('Upstream error'), { status: 429 })
    const { text, detail } = parts(formatChatError('Upstream error', 'sakura', thrown))
    expect(text).toMatch(/^混み合っています/)
    expect(detail).toContain('Upstream error')
    expect(detail).toContain('429')
  })

  it('IPC の頭は詳細に出さない', () => {
    const { detail } = parts(formatChatError("Error invoking remote method 'sakura:chat': Error: 503 Service Unavailable"))
    expect(detail).toBe('503 Service Unavailable')
  })

  it('原文の秘密の形は詳細で伏せる', () => {
    const { detail } = parts(formatChatError('401 Unauthorized: Bearer abcdefghijklmnopqrstuvwxyz0123456789'))
    expect(detail).toContain('401 Unauthorized')
    expect(detail).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
  })
})

describe('formatChatError - 回線断・時間切れ・安全な接続', () => {
  it('回線断の文の詳細は本物の失敗の原文で、見本の Connection error. ではない', () => {
    const { text, detail } = parts(formatChatError('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp'))
    expect(text).toBe('インターネットに接続できませんでした。接続を確かめてから、もう一度送信してください。')
    expect(detail).toBe('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp')
  })

  it('投げられた値の cause の奥のホスト名と符号が詳細に残る（message は Connection error. だけ）', () => {
    const err = connectionError('ENOTFOUND')
    const { text, detail } = parts(formatChatError(err.message, 'sakura', err))
    expect(text).toMatch(/^インターネットに接続できませんでした/)
    expect(detail).toContain('Connection error.')
    expect(detail).toContain('api.ai.sakura.ad.jp')
    expect(detail).toContain('ENOTFOUND')
  })

  it('本文が空でも、符号から詳細を作り、見本の文面は出さない', () => {
    const shown = formatChatError('', 'sakura', Object.assign(new Error(''), { code: 'ECONNRESET' }))
    const { text, detail } = parts(shown)
    expect(text).toMatch(/^時間内に返事がありませんでした|^インターネットに接続できませんでした/)
    expect(detail).not.toContain('Connection error.')
    expect(detail).toContain('ECONNRESET')
  })

  it('時間切れ・安全な接続も原文が付く', () => {
    expect(parts(formatChatError('Request timed out.')).detail).toBe('Request timed out.')
    const tls = parts(formatChatError('net::ERR_CERT_AUTHORITY_INVALID'))
    expect(tls.text).toMatch(/^安全な接続を確認できませんでした/)
    expect(tls.detail).toBe('net::ERR_CERT_AUTHORITY_INVALID')
  })
})

describe('formatChatError - 見分けられない失敗は、原文を既に出しているので詳細を重ねない', () => {
  it('受け皿の文に「詳細:」の行は付かない', () => {
    const shown = formatChatError('something odd happened')
    expect(parts(shown).detail).toBe('')
    expect(shown).not.toContain('詳細:')
    expect(shown).toContain('エラー: something odd happened')
  })
})
