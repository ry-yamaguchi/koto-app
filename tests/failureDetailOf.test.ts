import { describe, it, expect, vi, beforeEach } from 'vitest'
import { failureDetailOf, failureText, messageForIpc, stripRemoteHead, FAILURE_DETAIL_MAX } from '../src/shared/failureText'
import { splitFailureDetail } from '../src/shared/failureDetail'

const withCause = (message: string, cause: unknown, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { cause, ...extra })

describe('failureDetailOf: 材料', () => {
  it('Error でない値・文字列も壊れない', () => {
    expect(failureDetailOf('プレーンな文字列')).toBe('プレーンな文字列')
    expect(failureDetailOf(undefined)).toBe('')
    expect(failureDetailOf(null)).toBe('')
  })

  it('IPC の頭と印を落とした原文', () => {
    const raw = "Error invoking remote method 'x:y': Error: ⟦koto-failure kind=offline sent=no⟧fetch failed"
    expect(failureDetailOf(new Error(raw))).toBe('fetch failed')
  })

  it('何も無ければ空', () => {
    expect(failureDetailOf(new Error(''))).toBe('')
  })
})

describe('failureDetailOf: 原因の連なり', () => {
  it('cause・cause.cause・cause.errors[0] の message を ` / ` でつなぐ', () => {
    const e = withCause('fetch failed', {
      message: 'getaddrinfo ENOTFOUND api.ai.sakura.ad.jp',
      cause: { message: '下の原因' },
      errors: [{ message: '集約の1件目' }],
    })
    expect(failureDetailOf(e)).toBe('fetch failed / getaddrinfo ENOTFOUND api.ai.sakura.ad.jp / 下の原因 / 集約の1件目')
  })

  it('★ すでに含まれている文は足さない（部分一致）', () => {
    const e = withCause('fetch failed: getaddrinfo ENOTFOUND h.example', { message: 'getaddrinfo ENOTFOUND h.example' })
    expect(failureDetailOf(e)).toBe('fetch failed: getaddrinfo ENOTFOUND h.example')
  })

  it('message が文字列でない・空の cause は数えない', () => {
    expect(failureDetailOf(withCause('x', { message: 42 }))).toBe('x')
    expect(failureDetailOf(withCause('x', { message: '  ' }))).toBe('x')
    expect(failureDetailOf(withCause('x', 'ただの文字列'))).toBe('x')
  })
})

describe('failureDetailOf: 符号と状態番号', () => {
  it('★ message が Connection error. だけでも code を足す', () => {
    expect(failureDetailOf(withCause('Connection error.', { code: 'ENOTFOUND' }))).toBe('Connection error. / ENOTFOUND')
  })

  it('すでに含まれている code は足さない', () => {
    expect(failureDetailOf(Object.assign(new Error('getaddrinfo ENOTFOUND h'), { code: 'ENOTFOUND' }))).toBe('getaddrinfo ENOTFOUND h')
  })

  it('classifyFailure の code（net::ERR_… など）も足す', () => {
    const e = Object.assign(new Error('Failed'), { cause: { message: 'x net::ERR_NAME_NOT_RESOLVED' } })
    expect(failureDetailOf(e)).toContain('net::ERR_NAME_NOT_RESOLVED')
  })

  it('★ 状態番号は HTTP <番号>。すでに含まれていれば足さない', () => {
    expect(failureDetailOf(Object.assign(new Error('Service Unavailable'), { status: 503 }))).toBe('Service Unavailable / HTTP 503')
    expect(failureDetailOf(Object.assign(new Error('503 Service Unavailable'), { status: 503 }))).toBe('503 Service Unavailable')
  })
})

describe('failureDetailOf: 整形・伏せ字・長さ', () => {
  it('改行を含む空白は1つにまとめ、前後を落とす', () => {
    expect(failureDetailOf(new Error('  a\n\n  b\t c  '))).toBe('a b c')
  })

  it('★ 240 文字を超えたら 240 文字で切って … を付ける', () => {
    expect(FAILURE_DETAIL_MAX).toBe(240)
    const out = failureDetailOf(new Error('あ'.repeat(500)))
    expect(out).toBe('あ'.repeat(240) + '…')
    expect(failureDetailOf(new Error('あ'.repeat(240)))).toBe('あ'.repeat(240))
  })

  it('★ Bearer やキーの形を伏せる', () => {
    const out = failureDetailOf(new Error('401 Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'))
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('★ /Users/<名前> を ~ にする', () => {
    const out = failureDetailOf(new Error("EACCES: permission denied, open '/Users/taro/proj/a.txt'"))
    expect(out).toContain("'~/proj/a.txt'")
    expect(out).not.toContain('/Users/taro')
  })
})

describe('failureText と詳細', () => {
  it('置き換えた回は詳細の行がつき、日本語の文のほうに原文は混ざらない', () => {
    const shown = failureText(withCause('Connection error.', { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND h.example' }), { readOnly: true })
    const { text, detail } = splitFailureDetail(shown)
    expect(text).not.toContain('ENOTFOUND')
    expect(detail).toBe('Connection error. / getaddrinfo ENOTFOUND h.example')
  })

  it('unknown に詳細を付けない', () => {
    expect(failureText(withCause('boom', { message: 'inner' }))).toBe('boom')
  })
})

describe('IPC を越えた値（頭と印つき）でもホスト名が残る', () => {
  // 偽の ipcRenderer.invoke: main の messageForIpc の結果を、頭つきの message だけの Error にして投げ直す
  const crossIpc = (e: unknown): Error => new Error(`Error invoking remote method 'sakura:test': Error: ${messageForIpc(e)}`)

  it('main の messageForIpc は原因の連なりを原文に載せる', () => {
    const e = withCause('fetch failed', Object.assign(new Error('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp'), { code: 'ENOTFOUND' }))
    const m = messageForIpc(e)
    expect(m).toContain('⟦koto-failure kind=offline sent=no code=ENOTFOUND⟧')
    expect(m.endsWith('fetch failed / getaddrinfo ENOTFOUND api.ai.sakura.ad.jp')).toBe(true)
  })

  it('renderer の詳細にホスト名が残る', () => {
    const e = withCause('fetch failed', Object.assign(new Error('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp'), { code: 'ENOTFOUND' }))
    const received = crossIpc(e)
    expect(received).not.toHaveProperty('cause')
    expect(stripRemoteHead(received)).toBe('fetch failed / getaddrinfo ENOTFOUND api.ai.sakura.ad.jp')
    expect(failureDetailOf(received)).toContain('api.ai.sakura.ad.jp')
    expect(splitFailureDetail(failureText(received, { readOnly: true })).detail).toContain('api.ai.sakura.ad.jp')
  })

  it('原因が原文に含まれていれば足さない・unknown と状態番号の回は今までどおり', () => {
    expect(messageForIpc(withCause('fetch failed: getaddrinfo ENOTFOUND h', { message: 'getaddrinfo ENOTFOUND h', code: 'ENOTFOUND' })))
      .toBe('⟦koto-failure kind=offline sent=no code=ENOTFOUND⟧fetch failed: getaddrinfo ENOTFOUND h')
    expect(messageForIpc(withCause('boom', { message: 'inner' }))).toBe('boom')
    expect(messageForIpc(withCause('Bad', { message: 'inner' }, { status: 503 }))).toBe('⟦koto-failure kind=unknown sent=maybe status=503⟧Bad')
  })
})

describe('failureDetailOf: 値が無い失敗', () => {
  it('undefined と null は空（"undefined" を詳細にしない）', () => {
    expect(failureDetailOf(undefined)).toBe('')
    expect(failureDetailOf(null)).toBe('')
  })
})
