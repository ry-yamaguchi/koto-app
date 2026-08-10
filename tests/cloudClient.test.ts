import { describe, it, expect } from 'vitest'
import { apiErrorMessage } from '../src/main/cloud/client'

// apiErrorMessage: さくらのクラウドAPIのエラー応答から人間可読なメッセージを取り出す（ユーザー指摘 2026-07-12・
// AppRunアプリ作成上限のエラーで、ネストした error.errors[0] を拾えず生JSONが画面に出てしまっていた）。
describe('apiErrorMessage', () => {
  it('extracts the nested error.errors[0].message, appending a differing reason in parens (real-world example)', () => {
    const data = {
      error: {
        code: 400,
        message: 'Validation Error',
        errors: [{ domain: 'global', reason: 'violates application restriction', message: 'Creation limit reached.', location_type: 'body' }],
      },
    }
    const result = apiErrorMessage(data)
    expect(result).toBe('Creation limit reached.（violates application restriction）')
    // renderer側 isCreationLimitError のパターンマッチが依存する文言をそのまま含んでいること
    expect(result).toContain('Creation limit reached')
  })

  it('does not duplicate the reason in parens when it is identical to the message', () => {
    const data = { error: { errors: [{ reason: 'Creation limit reached.', message: 'Creation limit reached.' }] } }
    expect(apiErrorMessage(data)).toBe('Creation limit reached.')
  })

  it('falls back to error.message when errors[] is absent or empty', () => {
    expect(apiErrorMessage({ error: { message: 'Validation Error' } })).toBe('Validation Error')
    expect(apiErrorMessage({ error: { message: 'Validation Error', errors: [] } })).toBe('Validation Error')
  })

  it('falls back to top-level message/error_msg/error_code when there is no nested error object', () => {
    expect(apiErrorMessage({ message: 'Some top-level error' })).toBe('Some top-level error')
    expect(apiErrorMessage({ error_msg: '認証エラー', error_code: 'auth_failed' })).toBe('auth_failed: 認証エラー')
  })

  it('falls back to JSON.stringify as a last resort when nothing recognizable is present', () => {
    const data = { foo: 'bar' }
    expect(apiErrorMessage(data)).toBe(JSON.stringify(data))
  })

  it('returns a sliced string as-is for a plain string response', () => {
    expect(apiErrorMessage('plain text error')).toBe('plain text error')
  })

  it('returns an empty string for null/undefined', () => {
    expect(apiErrorMessage(null)).toBe('')
    expect(apiErrorMessage(undefined)).toBe('')
  })
})
