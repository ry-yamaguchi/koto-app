import { describe, it, expect } from 'vitest'
import { buildFeedbackBody, buildFeedbackUrl } from '../src/main/feedback'

describe('buildFeedbackBody', () => {
  it('starts with the guidance line and includes version/OS info after a divider', () => {
    const body = buildFeedbackBody('0.2.64', '25.5.0', 'arm64')
    expect(body.startsWith('（お気づきの点・不具合・要望をご記入ください）')).toBe(true)
    expect(body).toContain('---')
    expect(body).toContain('Koto v0.2.64 / macOS 25.5.0 (arm64)')
  })

  it('never includes secret-looking substrings by construction (only version/os/arch are interpolated)', () => {
    const body = buildFeedbackBody('1.0.0', '24.0.0', 'x64')
    expect(body).not.toMatch(/key|token|secret|password/i)
  })
})

describe('buildFeedbackUrl', () => {
  it('points at the koto repository issues/new endpoint', () => {
    const url = buildFeedbackUrl('0.2.64', '25.5.0', 'arm64')
    expect(url.startsWith('https://github.com/ry-yamaguchi/koto/issues/new?body=')).toBe(true)
  })

  it('URL-encodes the body so it round-trips back to buildFeedbackBody output', () => {
    const url = buildFeedbackUrl('0.2.64', '25.5.0', 'arm64')
    const encoded = url.split('?body=')[1]
    expect(decodeURIComponent(encoded)).toBe(buildFeedbackBody('0.2.64', '25.5.0', 'arm64'))
  })
})
