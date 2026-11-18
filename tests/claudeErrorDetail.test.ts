import * as fs from 'fs'
import * as path from 'path'
// tests/claudeErrorDetail.test.ts — Claude の失敗の文に、原文（区分・SDK の文）を「詳細:」として残す（掟5）。
// 2026-11-11 に画面が「エラー: APIキーが認証されませんでした。」だけを出した。SDK の区分（authentication_failed）と文が空のとき、
// 区分の日本語の文だけを送っていて、原文が画面にも📋コピーにも残らなかった。
// 詳細を作る・運ぶのは shared/failureText.ts / failureDetail.ts の1か所。main が付け、renderer の formatChatError は最後の行へそのまま運ぶ。
import { describe, it, expect } from 'vitest'
import { mapSdkMessage, describeAssistantError, assistantErrorMessage, assistantErrorWithSdkText } from '../src/main/claude/events'
import { formatClaudeError } from '../src/renderer/aiTools'
import { isClaudeUsageBlockedError } from '../src/renderer/claudeMode'
import { splitFailureDetail, failureCopyText } from '../src/shared/failureDetail'

const TABLE_CODES = [
  'authentication_failed', 'billing_error', 'rate_limit', 'overloaded', 'invalid_request',
  'model_not_found', 'server_error', 'max_output_tokens', 'oauth_org_not_allowed', 'unknown',
] as const
// SDK 0.3.308 の SDKAssistantMessageError のうち、表に無い区分（一般の文になる）
const OTHER_CODES = ['account_on_hold', 'verification_required', 'cloud_credential_error'] as const

const assistant = (error: string | undefined, texts: string[]) => ({
  type: 'assistant', message: { content: texts.map(text => ({ type: 'text', text })) }, ...(error ? { error } : {}),
})

describe('assistant の error 区分（文が空）: 日本語の文のあとに、区分を「詳細:」の最後の行として残す', () => {
  for (const code of [...TABLE_CODES, ...OTHER_CODES]) {
    it(`${code}: 送る文は「<日本語の文>\\n詳細: ${code}」`, () => {
      const [ev] = mapSdkMessage(assistant(code, []))
      const message = (ev as { message: string }).message
      const { text, detail } = splitFailureDetail(message)
      expect(text).toBe(describeAssistantError(code))
      expect(detail).toBe(code)
      expect(message.split('詳細: ').length - 1).toBe(1)
    })

    it(`${code}: 画面に出る文（formatClaudeError）の最後の行も「詳細: ${code}」で、日本語の文は 1 回だけ・詳細は挟まらない`, () => {
      const [ev] = mapSdkMessage(assistant(code, []))
      const shown = formatClaudeError((ev as { message: string }).message)
      const { text, detail } = splitFailureDetail(shown)
      expect(detail).toBe(code)
      expect(text).toContain(describeAssistantError(code).replace(/。$/, ''))
      expect(shown.split(describeAssistantError(code)).length - 1).toBeLessThanOrEqual(1)
      expect(shown.split('詳細: ').length - 1).toBe(1)
      expect(shown.trimEnd().endsWith(`詳細: ${code}`)).toBe(true)
    })

    it(`${code}: 📋コピーに詳細が入る`, () => {
      const [ev] = mapSdkMessage(assistant(code, []))
      const copy = failureCopyText(formatClaudeError((ev as { message: string }).message), { version: '0.0.0', at: new Date(2026, 10, 11, 9, 5) })
      expect(copy).toContain(`詳細: ${code}`)
      expect(copy).toContain('Koto 0.0.0・2026-11-11 09:05')
    })
  }

  it('★ 区分の詳細が、formatChatError の語の判定に当たって別の案内に変わらない（authentication_failed → 401 の案内、overloaded → 混み合っています、にならない）', () => {
    for (const code of ['authentication_failed', 'overloaded', 'model_not_found', 'billing_error']) {
      const [ev] = mapSdkMessage(assistant(code, []))
      const shown = formatClaudeError((ev as { message: string }).message)
      expect(shown, code).toContain(describeAssistantError(code))
      expect(shown, code).not.toContain('（401）')
      expect(shown, code).not.toContain('混み合っています')
      expect(shown, code).not.toContain('（404）')
    }
  })

  it('★★ 請求の判定: 詳細つきの billing_error も「請求設定に問題」で拾う。ほかの区分は拾わない（詳細の語で誤判定しない）', () => {
    const msg = (code: string) => (mapSdkMessage(assistant(code, []))[0] as { message: string }).message
    expect(isClaudeUsageBlockedError(msg('billing_error'))).toBe(true)
    for (const code of TABLE_CODES.filter(c => c !== 'billing_error')) expect(isClaudeUsageBlockedError(msg(code)), code).toBe(false)
    // 詳細の行に請求の語があっても、文が請求でなければ拾わない（判定は文だけ）
    expect(isClaudeUsageBlockedError('Claude の処理が失敗しました。\n詳細: billing')).toBe(false)
    // 従来どおり: 英語の原文の例外は拾う
    expect(isClaudeUsageBlockedError('Credit balance is too low')).toBe(true)
  })

  it('表に無い区分も区分を失わない（文に区分を直接書かず、詳細へ）', () => {
    expect(describeAssistantError('totally_new_code')).toBe('Claude の処理が失敗しました。')
    expect(assistantErrorMessage('totally_new_code', '')).toBe('Claude の処理が失敗しました。\n詳細: totally_new_code')
    expect(describeAssistantError('constructor')).toBe('Claude の処理が失敗しました。') // Object.prototype の名前を表の値と取り違えない
  })

  it('秘密の形は詳細で伏せられる（区分に紛れ込んでも）', () => {
    expect(assistantErrorMessage('x sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', '')).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
  })
})

describe('文があるとき（server_error・unknown）は、原文の文に、区分名つきの詳細が付く（詳細は1回）', () => {
  it('原文がそのまま送られ、画面では「詳細:」が多くて 1 回', () => {
    const raw = 'API Error: Unable to connect to API (ENOTFOUND api.anthropic.com)'
    for (const code of ['server_error', 'unknown']) {
      const [ev] = mapSdkMessage(assistant(code, [raw]))
      expect((ev as { message: string }).message).toBe(`${raw}\n詳細: ${code} / ${raw}`)
      const shown = formatClaudeError((ev as { message: string }).message)
      expect(shown.split('詳細: ').length - 1).toBeLessThanOrEqual(1)
      expect(shown).toContain('ENOTFOUND')
    }
  })

  it('他の区分は、SDK の文を text にせず、error の詳細に区分名と一緒に載せる', () => {
    const out = mapSdkMessage(assistant('authentication_failed', ['Invalid API key · Please run /login']))
    expect(out).toEqual([
      { kind: 'error', message: assistantErrorWithSdkText('authentication_failed', 'Invalid API key · Please run /login') },
    ])
    expect((out[0] as { message: string }).message).toContain('詳細: authentication_failed / Invalid API key')
  })
})

describe('result の失敗', () => {
  const result = (extra: Record<string, unknown>) => ({ type: 'result', is_error: true, total_cost_usd: 0, duration_ms: 1, ...extra })

  it('errors があるときは、その文が原文のまま error になる（画面でも原文が残り、詳細は多くて 1 回）', () => {
    const raw = 'No messages returned'
    const [err] = mapSdkMessage(result({ subtype: 'error_during_execution', errors: [raw] }))
    expect(err).toEqual({ kind: 'error', message: raw })
    const shown = formatClaudeError(raw)
    expect(shown).toContain(raw)
    expect(shown.split('詳細: ').length - 1).toBeLessThanOrEqual(1)
  })

  it('★ errors が無い・空の失敗: 以前は何も出なかった。日本語の文のあとに subtype と result の文を詳細として残す', () => {
    for (const extra of [{ subtype: 'error_max_turns' }, { subtype: 'error_max_turns', errors: [] }]) {
      const out = mapSdkMessage(result(extra))
      expect(out).toHaveLength(2)
      const message = (out[0] as { message: string }).message
      expect(splitFailureDetail(message)).toEqual({ text: 'Claude の処理がエラーで終わりました。', detail: 'error_max_turns' })
      expect(out[1]).toMatchObject({ kind: 'result', isError: true })
      expect(formatClaudeError(message).trimEnd().endsWith('詳細: error_max_turns')).toBe(true)
    }
    const withText = mapSdkMessage(result({ subtype: 'success', result: 'API Error: 500 upstream' }))
    expect(splitFailureDetail((withText[0] as { message: string }).message).detail).toBe('success / API Error: 500 upstream')
  })

  it('成功の result には error を足さない', () => {
    expect(mapSdkMessage({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1 })).toEqual([
      { kind: 'result', costUsd: 0, durationMs: 1, isError: false },
    ])
  })
})

describe('assistant の error 区分は、すべて「エラー」が二重にならない文になる', () => {
  // SDK の型定義（SDKAssistantMessageError）の全部。新しい区分が増えたら、下の「型定義と一致」のテストが落ちる。
  const ALL_CODES = [
    'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error',
    'rate_limit', 'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'unknown', 'max_output_tokens',
    'cloud_credential_error',
  ]
  it('文が空でなく「エラー」で始まらず、詳細に区分名がある', () => {
    for (const code of ALL_CODES) {
      const sentence = describeAssistantError(code)
      expect(sentence, code).not.toBe('')
      expect(sentence.startsWith('エラー'), code).toBe(false)
      const full = assistantErrorMessage(code, '')
      expect(full.split('\n詳細: ').length, code).toBe(2)
      expect(full.slice(full.lastIndexOf('詳細: ')), code).toContain(code)
    }
  })
  it('型定義の区分と、上の一覧が一致する', () => {
    const dts = fs.readFileSync(path.join(__dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'), 'utf8')
    const m = /type SDKAssistantMessageError = ([^;]+);/.exec(dts)
    expect(m).not.toBeNull()
    const codes = [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
    expect(codes).toEqual([...ALL_CODES].sort())
  })
})
