import { describe, it, expect } from 'vitest'
import { mapSdkMessage, describeAssistantError } from '../src/main/claude/events'
import { formatClaudeError } from '../src/renderer/aiTools'
import { splitFailureDetail } from '../src/shared/failureDetail'
import { isClaudeUsageBlockedError } from '../src/renderer/claudeMode'

// Claude の頭脳で回線が切れると、CLI は API の失敗を「assistant の文」と error 区分で返す。
// 文を捨てずに error として出し、画面で回線の文＋詳細（ホスト名・符号）になることを固める。

const assistant = (error: string | undefined, texts: string[], extra: unknown[] = []) => ({
  type: 'assistant', session_id: 's1', uuid: 'u1', parent_tool_use_id: null,
  ...(error ? { error } : {}),
  message: { content: [...texts.map(text => ({ type: 'text', text })), ...extra] },
})

const ENOTFOUND = 'API Error: Unable to connect to API (ENOTFOUND)'

describe('assistant の error と文（回線断）', () => {
  it('server_error＋文: 文を error にし、文のブロックは別に出さない', () => {
    expect(mapSdkMessage(assistant('server_error', [ENOTFOUND]))).toEqual([{ kind: 'error', message: ENOTFOUND }])
  })

  it('unknown＋文: 同じ', () => {
    expect(mapSdkMessage(assistant('unknown', [ENOTFOUND]))).toEqual([{ kind: 'error', message: ENOTFOUND }])
  })

  it('複数の文のブロックはつなぐ。tool_use は残る', () => {
    const ev = mapSdkMessage(assistant('server_error', ['API Error: Unable to connect to API', '(ECONNREFUSED)'], [{ type: 'tool_use', name: 'Glob', input: { pattern: '*.ts' } }]))
    expect(ev).toEqual([
      { kind: 'error', message: 'API Error: Unable to connect to API\n(ECONNREFUSED)' },
      { kind: 'tool', name: 'Glob', detail: '*.ts' },
    ])
  })

  it('画面では回線の文＋詳細になる（ENOTFOUND の符号が詳細に残る）', () => {
    const [ev] = mapSdkMessage(assistant('server_error', [ENOTFOUND]))
    const shown = formatClaudeError((ev as { message: string }).message)
    const { text, detail } = splitFailureDetail(shown)
    expect(text).toMatch(/[ぁ-ん]/)
    expect(text).not.toContain('Anthropic側でエラーが発生しました')
    expect(text).not.toContain('APIキー')
    expect(detail).toContain('ENOTFOUND')
  })

  it('Request timed out も文を残し、画面で時間切れの文になる', () => {
    const [ev] = mapSdkMessage(assistant('unknown', ['Request timed out.']))
    expect((ev as { message: string }).message).toBe('Request timed out.')
    const { text, detail } = splitFailureDetail(formatClaudeError((ev as { message: string }).message))
    expect(text).toMatch(/[ぁ-ん]/)
    expect(detail).toContain('Request timed out')
  })

  it('見分けられない文も原文のまま送り、画面で原文が消えず「詳細:」が途中に挟まらない', () => {
    for (const [code, raw] of [['server_error', 'API Error: Something odd happened'], ['unknown', 'API Error: 500 {"error":"Internal server error"}']] as const) {
      const [ev] = mapSdkMessage(assistant(code, [raw]))
      expect((ev as { message: string }).message, code).toBe(raw)
      const shown = formatClaudeError((ev as { message: string }).message)
      expect(shown, code).toContain(raw.slice(0, 20))
      // 「詳細:」は多くて1回で、あるなら最後の1行（FailureLines が分けられる）
      expect(shown.split('詳細: ').length - 1, code).toBeLessThanOrEqual(1)
      const { detail } = splitFailureDetail(shown)
      if (shown.includes('詳細: ')) expect(detail, code).not.toBe('')
    }
  })

  it('文が無ければ今までどおり区分の文だけ', () => {
    expect(mapSdkMessage(assistant('server_error', []))).toEqual([{ kind: 'error', message: describeAssistantError('server_error') }])
    expect(mapSdkMessage(assistant('unknown', ['  ']))).toEqual([{ kind: 'error', message: describeAssistantError('unknown') }])
  })
})

describe('既存の区分は変えない', () => {
  it('billing_error・rate_limit・authentication_failed: 区分の文のあとに文のブロックが続く（従来どおり）', () => {
    for (const code of ['billing_error', 'rate_limit', 'authentication_failed', 'overloaded']) {
      expect(mapSdkMessage(assistant(code, ['応答'])), code).toEqual([
        { kind: 'error', message: describeAssistantError(code) },
        { kind: 'text', text: '応答' },
      ])
    }
    expect(isClaudeUsageBlockedError(describeAssistantError('billing_error'))).toBe(true)
  })

  it('error 区分が無い assistant の文は、そのまま text', () => {
    expect(mapSdkMessage(assistant(undefined, [ENOTFOUND]))).toEqual([{ kind: 'text', text: ENOTFOUND }])
  })
})
