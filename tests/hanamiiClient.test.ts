import { describe, it, expect } from 'vitest'
import { extractProjectIds, extractProjectStatus, buildPatchEnvBody, normalizeHealthCheck, extractLogs, describeErrorCode, hanamiiErrorMessage } from '../src/main/hanamii/client'

describe('extractProjectIds', () => {
  it('extracts projectId and deploymentId when present', () => {
    const result = extractProjectIds({ project: { id: 'p1' }, deployment: { id: 'd1' } })
    expect(result).toEqual({ projectId: 'p1', deploymentId: 'd1' })
  })

  it('returns nulls for an empty object', () => {
    expect(extractProjectIds({})).toEqual({ projectId: null, deploymentId: null })
  })

  it('returns nulls for null, undefined, and a plain string', () => {
    expect(extractProjectIds(null)).toEqual({ projectId: null, deploymentId: null })
    expect(extractProjectIds(undefined)).toEqual({ projectId: null, deploymentId: null })
    expect(extractProjectIds('text')).toEqual({ projectId: null, deploymentId: null })
  })

  it('returns null when id is the wrong type', () => {
    const result = extractProjectIds({ project: { id: 123 }, deployment: { id: 'd1' } })
    expect(result).toEqual({ projectId: null, deploymentId: 'd1' })
  })
})

describe('extractProjectStatus', () => {
  it('extracts url, readyState, and errorCode when present', () => {
    const result = extractProjectStatus({
      project: { url: 'https://x', latestDeployment: { readyState: 'READY', errorCode: 'E1' } },
    })
    expect(result).toEqual({
      url: 'https://x',
      readyState: 'READY',
      errorCode: 'E1',
      runtime: { status: null, detail: null, syncedAt: null },
    })
  })

  it('falls back to urls[0].url when url is absent', () => {
    const result = extractProjectStatus({ project: { urls: [{ url: 'https://y' }] } })
    expect(result.url).toBe('https://y')
  })

  it('returns all nulls for an empty object', () => {
    expect(extractProjectStatus({})).toEqual({
      url: null,
      readyState: null,
      errorCode: null,
      runtime: { status: null, detail: null, syncedAt: null },
    })
  })

  it('returns all nulls for null', () => {
    expect(extractProjectStatus(null)).toEqual({
      url: null,
      readyState: null,
      errorCode: null,
      runtime: { status: null, detail: null, syncedAt: null },
    })
  })

  it('extracts runtime status, detail, and syncedAt when runtimeStatus is present', () => {
    const result = extractProjectStatus({
      project: {
        url: 'https://x',
        runtimeStatus: { status: 'healthy', detail: 'OK', syncedAt: '2026-07-04T12:00:00Z' },
      },
    })
    expect(result.runtime).toEqual({ status: 'healthy', detail: 'OK', syncedAt: '2026-07-04T12:00:00Z' })
  })

  it('returns null runtime fields when runtimeStatus is absent', () => {
    const result = extractProjectStatus({ project: { url: 'https://x' } })
    expect(result.runtime).toEqual({ status: null, detail: null, syncedAt: null })
  })

  it('defaults missing runtimeStatus fields to null individually', () => {
    const result = extractProjectStatus({
      project: { url: 'https://x', runtimeStatus: { status: 'unhealthy' } },
    })
    expect(result.runtime).toEqual({ status: 'unhealthy', detail: null, syncedAt: null })
  })

  it('ignores runtimeStatus fields with the wrong type', () => {
    const result = extractProjectStatus({
      project: { url: 'https://x', runtimeStatus: { status: 123, detail: true, syncedAt: null } },
    })
    expect(result.runtime).toEqual({ status: null, detail: null, syncedAt: null })
  })
})

describe('buildPatchEnvBody', () => {
  it('trims keys and defaults type to plain', () => {
    const result = buildPatchEnvBody([{ key: '  FOO  ', value: 'bar' }])
    expect(result).toEqual({ envs: [{ key: 'FOO', value: 'bar', type: 'plain' }] })
  })

  it('preserves explicit type secret', () => {
    const result = buildPatchEnvBody([{ key: 'API_KEY', value: 'secret-value', type: 'secret' }])
    expect(result).toEqual({ envs: [{ key: 'API_KEY', value: 'secret-value', type: 'secret' }] })
  })

  it('filters out entries with empty or whitespace-only keys', () => {
    const result = buildPatchEnvBody([
      { key: '', value: 'x' },
      { key: '   ', value: 'y' },
      { key: 'OK', value: 'z' },
    ])
    expect(result).toEqual({ envs: [{ key: 'OK', value: 'z', type: 'plain' }] })
  })

  it('defaults missing value to empty string', () => {
    const result = buildPatchEnvBody([{ key: 'FOO' } as any])
    expect(result).toEqual({ envs: [{ key: 'FOO', value: '', type: 'plain' }] })
  })

  it('returns an empty envs array for an empty input', () => {
    expect(buildPatchEnvBody([])).toEqual({ envs: [] })
  })
})

describe('normalizeHealthCheck', () => {
  it('prefixes a missing leading slash on path', () => {
    const result = normalizeHealthCheck({ enabled: true, path: 'healthz', port: null })
    expect(result).toEqual({ enabled: true, path: '/healthz', port: null })
  })

  it('keeps an already-prefixed path as-is', () => {
    const result = normalizeHealthCheck({ enabled: true, path: '/api/health', port: null })
    expect(result.path).toBe('/api/health')
  })

  it('defaults an empty path to /', () => {
    const result = normalizeHealthCheck({ enabled: false, path: '', port: null })
    expect(result.path).toBe('/')
  })

  it('coerces a non-numeric port to null', () => {
    const result = normalizeHealthCheck({ enabled: true, path: '/', port: 'nope' as any })
    expect(result.port).toBeNull()
  })

  it('preserves a numeric port', () => {
    const result = normalizeHealthCheck({ enabled: true, path: '/', port: 8080 })
    expect(result.port).toBe(8080)
  })

  it('coerces enabled to boolean', () => {
    const result = normalizeHealthCheck({ enabled: undefined as any, path: '/', port: null })
    expect(result.enabled).toBe(false)
  })
})

describe('extractLogs', () => {
  it('extracts timestamp and message from a normal logs array', () => {
    const result = extractLogs({ logs: [{ timestamp: '2026-07-04T12:00:00Z', message: 'starting up' }] })
    expect(result).toEqual([{ timestamp: '2026-07-04T12:00:00Z', message: 'starting up' }])
  })

  it('returns an empty array when logs is missing', () => {
    expect(extractLogs({})).toEqual([])
  })

  it('returns an empty array for null and undefined', () => {
    expect(extractLogs(null)).toEqual([])
    expect(extractLogs(undefined)).toEqual([])
  })

  it('returns an empty array when logs is not an array', () => {
    expect(extractLogs({ logs: 'not-an-array' })).toEqual([])
  })

  it('defaults missing timestamp/message fields to empty strings and skips non-object entries', () => {
    const result = extractLogs({ logs: [{ message: 'no timestamp' }, null, 'oops', { timestamp: '12:00' }] })
    expect(result).toEqual([
      { timestamp: '', message: 'no timestamp' },
      { timestamp: '12:00', message: '' },
    ])
  })
})

describe('hanamiiErrorMessage', () => {
  it('extracts a top-level message', () => {
    expect(hanamiiErrorMessage({ message: '公開名は既に使われています' })).toBe('公開名は既に使われています')
  })

  it('extracts a top-level error string when message is absent', () => {
    expect(hanamiiErrorMessage({ error: 'invalid workspace' })).toBe('invalid workspace')
  })

  it('extracts a top-level detail string when message/error are absent', () => {
    expect(hanamiiErrorMessage({ detail: '容量制限を超えています' })).toBe('容量制限を超えています')
  })

  it('extracts errors[0].message when top-level keys are absent', () => {
    expect(hanamiiErrorMessage({ errors: [{ message: 'ビルドに失敗しました', type: 'build_error' }] }))
      .toBe('ビルドに失敗しました')
  })

  it('falls back to errors[0].type when errors[0].message is absent', () => {
    expect(hanamiiErrorMessage({ errors: [{ type: 'quota_exceeded' }] })).toBe('quota_exceeded')
  })

  it('falls back to errors[0] itself when it is a plain string', () => {
    expect(hanamiiErrorMessage({ errors: ['name already exists'] })).toBe('name already exists')
  })

  it('falls back to JSON.stringify as a last resort when nothing recognizable is present', () => {
    const data = { foo: 'bar' }
    expect(hanamiiErrorMessage(data)).toBe(JSON.stringify(data))
  })

  it('returns a sliced string as-is for a plain string response', () => {
    expect(hanamiiErrorMessage('plain text error')).toBe('plain text error')
  })

  it('returns an empty string for null/undefined', () => {
    expect(hanamiiErrorMessage(null)).toBe('')
    expect(hanamiiErrorMessage(undefined)).toBe('')
  })
})

describe('describeErrorCode', () => {
  it('translates a known error code to a plain-Japanese explanation', () => {
    expect(describeErrorCode('BUILD_FAILED')).toBe(
      'ビルドに失敗しました。直前に追加したライブラリ名の誤りや、package.json の記述ミスが典型的な原因です。'
    )
  })

  it('falls back to showing the raw code for an unknown code', () => {
    expect(describeErrorCode('SOME_UNKNOWN_CODE')).toBe('エラーコード: SOME_UNKNOWN_CODE')
  })

  it('returns an empty string for null and undefined', () => {
    expect(describeErrorCode(null)).toBe('')
    expect(describeErrorCode(undefined)).toBe('')
  })
})
