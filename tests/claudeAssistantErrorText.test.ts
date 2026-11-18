import * as fs from 'fs'
import * as path from 'path'
import { describe, it, expect } from 'vitest'
import { mapSdkMessage, describeAssistantError, assistantErrorMessage, assistantErrorWithSdkText } from '../src/main/claude/events'
import { formatClaudeError } from '../src/renderer/aiTools'
import { formatChatError } from '../src/shared/aiToolsCore'
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
    expect(mapSdkMessage(assistant('server_error', [ENOTFOUND]))).toEqual([{ kind: 'error', message: `${ENOTFOUND}\n詳細: server_error / ${ENOTFOUND}` }])
  })

  it('unknown＋文: 同じ', () => {
    expect(mapSdkMessage(assistant('unknown', [ENOTFOUND]))).toEqual([{ kind: 'error', message: `${ENOTFOUND}\n詳細: unknown / ${ENOTFOUND}` }])
  })

  it('複数の文のブロックはつなぐ。tool_use は残る', () => {
    const ev = mapSdkMessage(assistant('server_error', ['API Error: Unable to connect to API', '(ECONNREFUSED)'], [{ type: 'tool_use', name: 'Glob', input: { pattern: '*.ts' } }]))
    expect(ev).toEqual([
      { kind: 'error', message: 'API Error: Unable to connect to API\n(ECONNREFUSED)\n詳細: server_error / API Error: Unable to connect to API (ECONNREFUSED)' },
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
    expect((ev as { message: string }).message).toBe('Request timed out.\n詳細: unknown / Request timed out.')
    const { text, detail } = splitFailureDetail(formatClaudeError((ev as { message: string }).message))
    expect(text).toMatch(/[ぁ-ん]/)
    expect(detail).toContain('Request timed out')
  })

  it('見分けられない文も原文のまま送り、画面で原文が消えず「詳細:」が途中に挟まらない', () => {
    for (const [code, raw] of [['server_error', 'API Error: Something odd happened'], ['unknown', 'API Error: 500 {"error":"Internal server error"}']] as const) {
      const [ev] = mapSdkMessage(assistant(code, [raw]))
      expect((ev as { message: string }).message, code).toBe(`${raw}\n詳細: ${code} / ${raw}`)
      const shown = formatClaudeError((ev as { message: string }).message)
      expect(shown, code).toContain(raw.slice(0, 20))
      // 「詳細:」は多くて1回で、あるなら最後の1行（FailureLines が分けられる）
      expect(shown.split('詳細: ').length - 1, code).toBeLessThanOrEqual(1)
      const { detail } = splitFailureDetail(shown)
      if (shown.includes('詳細: ')) expect(detail, code).not.toBe('')
    }
  })

  it('文が無ければ区分の文に、区分を詳細として添える', () => {
    expect(mapSdkMessage(assistant('server_error', []))).toEqual([{ kind: 'error', message: assistantErrorMessage('server_error', '') }])
    expect(mapSdkMessage(assistant('unknown', ['  ']))).toEqual([{ kind: 'error', message: assistantErrorMessage('unknown', '') }])
  })
})

describe('既存の区分は変えない', () => {
  it('billing_error・rate_limit・authentication_failed: 日本語の文は変えず、SDK の文は text にせず詳細へ運ぶ（失敗の吹き出しは1つ）', () => {
    for (const code of ['billing_error', 'rate_limit', 'authentication_failed', 'overloaded']) {
      expect(mapSdkMessage(assistant(code, ['応答'])), code).toEqual([
        { kind: 'error', message: assistantErrorWithSdkText(code, '応答') },
      ])
    }
    expect(isClaudeUsageBlockedError(describeAssistantError('billing_error'))).toBe(true)
  })

  it('error 区分が無い assistant の文は、そのまま text', () => {
    expect(mapSdkMessage(assistant(undefined, [ENOTFOUND]))).toEqual([{ kind: 'text', text: ENOTFOUND }])
  })
})

// 5A-1 仕上げ: 混み合い（529）の実測の形。どの区分でも、画面の吹き出しは「日本語の文＋詳細: 区分名 / 原文」になる。
describe('529（混み合い）などの失敗は、全区分で 日本語の文＋詳細（区分名と原文）', () => {
  const RAW = 'API Error: Repeated 529 Overloaded errors. The API is at capacity'
  const CODES = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'rate_limit', 'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'unknown', 'max_output_tokens', 'cloud_credential_error']

  it('SDK の型定義の全区分（13個）を網羅している', () => {
    const sdk = fs.readFileSync(path.join(__dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'), 'utf8')
    const m = /export declare type SDKAssistantMessageError = ([^\n]*)/.exec(sdk)!
    const declared = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
    expect(declared).toHaveLength(13)
    expect([...CODES].sort()).toEqual(declared)
  })

  it('各区分: 画面の吹き出しが日本語で始まり、詳細に区分名と原文がある', () => {
    for (const code of CODES) {
      const [ev] = mapSdkMessage(assistant(code, [RAW]))
      const { text, detail } = splitFailureDetail(formatClaudeError((ev as { message: string }).message))
      expect(text, code).toMatch(/^[^A-Za-z]*[ぁ-んァ-ヶ一-龠]/)
      expect(text, code).not.toContain('API Error')
      expect(detail, code).toContain(code)
      expect(detail, code).toContain(RAW)
    }
  })

  it('529 の server_error は混み合いの文になる', () => {
    const [ev] = mapSdkMessage(assistant('server_error', [RAW]))
    expect(splitFailureDetail(formatClaudeError((ev as { message: string }).message)).text).toContain('混み合っています')
  })

  it('表に無い英語の原文は、一般の日本語の文に置き換わり、原文は詳細に残る', () => {
    const [ev] = mapSdkMessage(assistant('unknown', ['API Error: Something odd happened']))
    const { text, detail } = splitFailureDetail(formatClaudeError((ev as { message: string }).message))
    expect(text).toBe('Claude の処理が失敗しました。')
    expect(detail).toBe('unknown / API Error: Something odd happened')
  })

  it('さくらのAI Engine の経路では、英語の原文に詳細が付いていても「Claude の…」と言わない', () => {
    const message = (mapSdkMessage(assistant('unknown', ['API Error: Something odd happened']))[0] as { message: string }).message
    expect(formatChatError(message, 'claude')).toContain('Claude の処理が失敗しました。')
    expect(formatChatError(message, 'sakura')).not.toContain('Claude')
  })
})
