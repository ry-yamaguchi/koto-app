import { describe, it, expect } from 'vitest'
import { formatSyncedAt, buildEnvsAndHealthCheck } from '../src/renderer/components/HanamiiPanel'

describe('formatSyncedAt', () => {
  const now = new Date('2026-07-04T12:00:00Z')

  it('returns "たった今" for less than 1 minute ago', () => {
    expect(formatSyncedAt('2026-07-04T11:59:30Z', now)).toBe('たった今')
  })

  it('returns "N分前" for less than 60 minutes ago', () => {
    expect(formatSyncedAt('2026-07-04T11:45:00Z', now)).toBe('15分前')
  })

  it('returns HH:mm for 60 minutes or more ago', () => {
    const result = formatSyncedAt('2026-07-04T09:00:00Z', now)
    expect(result).toMatch(/^\d{2}:\d{2}$/)
  })

  it('returns null for null, undefined, or unparsable input', () => {
    expect(formatSyncedAt(null, now)).toBeNull()
    expect(formatSyncedAt(undefined, now)).toBeNull()
    expect(formatSyncedAt('not-a-date', now)).toBeNull()
  })

  it('returns "たった今" for a timestamp exactly at now', () => {
    expect(formatSyncedAt('2026-07-04T12:00:00Z', now)).toBe('たった今')
  })
})

// A-5: 「公開する」「🔄 再起動して反映」の両方が同じ変換ロジックを使うための共通関数。
describe('buildEnvsAndHealthCheck', () => {
  it('drops rows with an empty key and converts secret/plain into the send/persist shapes', () => {
    const r = buildEnvsAndHealthCheck(
      [
        { key: 'API_KEY', value: 'sekret', secret: true },
        { key: '  DB_URL  ', value: 'postgres://x', secret: false },
        { key: '   ', value: 'ignored', secret: false },
      ],
      false,
      '/',
    )
    expect(r.sendEnvs).toEqual([
      { key: 'API_KEY', value: 'sekret', type: 'secret' },
      { key: 'DB_URL', value: 'postgres://x', type: 'plain' },
    ])
    expect(r.persistEnvs).toEqual([
      { key: 'API_KEY', secret: true },
      { key: 'DB_URL', value: 'postgres://x', secret: false },
    ])
    expect(r.emptySecretKey).toBeNull()
  })

  it('flags the first secret row with an empty value via emptySecretKey', () => {
    const r = buildEnvsAndHealthCheck(
      [{ key: 'FOO', value: '', secret: false }, { key: 'TOKEN', value: '  ', secret: true }],
      false,
      '/',
    )
    expect(r.emptySecretKey).toBe('TOKEN')
  })

  it('normalizes the health check path to start with "/"', () => {
    expect(buildEnvsAndHealthCheck([], true, 'healthz').healthCheck).toEqual({ enabled: true, path: '/healthz', port: null })
    expect(buildEnvsAndHealthCheck([], true, '/api/health').healthCheck).toEqual({ enabled: true, path: '/api/health', port: null })
    expect(buildEnvsAndHealthCheck([], false, '').healthCheck).toEqual({ enabled: false, path: '/', port: null })
  })
})
