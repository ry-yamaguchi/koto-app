import { describe, it, expect } from 'vitest'
import { normalizeSpecName, validateSpec, defaultSpec, NAME_PATTERN } from '../src/main/cloud/spec'

describe('defaultSpec + validateSpec round-trip', () => {
  it('accepts a defaultSpec built with hasDockerfile:true', () => {
    const spec = defaultSpec({ name: 'myapp', hasDockerfile: true })
    const result = validateSpec(spec)
    expect(result.ok).toBe(true)
  })

  it('accepts a defaultSpec built with hasDockerfile:false', () => {
    const spec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    const result = validateSpec(spec)
    expect(result.ok).toBe(true)
  })
})

describe('validateSpec rejection cases', () => {
  it('rejects null', () => {
    const result = validateSpec(null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
  })

  it('rejects a plain string', () => {
    const result = validateSpec('x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
  })

  it('rejects an empty object', () => {
    const result = validateSpec({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
  })

  it('rejects a spec with an invalid name (contains invalid chars)', () => {
    const spec = defaultSpec({ name: 'myapp', hasDockerfile: true })
    const bad = { ...spec, name: 'A_B!' }
    const result = validateSpec(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.includes('name'))).toBe(true)
  })

  it('rejects a spec with a leading hyphen in name', () => {
    const spec = defaultSpec({ name: 'myapp', hasDockerfile: true })
    const bad = { ...spec, name: '-xxx' }
    const result = validateSpec(bad)
    expect(result.ok).toBe(false)
  })
})

describe('NAME_PATTERN', () => {
  it('accepts a valid lowercase-alphanumeric-hyphen name', () => {
    expect(NAME_PATTERN.test('my-app-01')).toBe(true)
  })

  it('rejects names with uppercase/underscore', () => {
    expect(NAME_PATTERN.test('My_App')).toBe(false)
  })

  it('rejects names longer than 40 characters', () => {
    expect(NAME_PATTERN.test('a'.repeat(45))).toBe(false)
  })

  it('rejects names starting with a hyphen', () => {
    expect(NAME_PATTERN.test('-x')).toBe(false)
  })
})

describe('normalizeSpecName', () => {
  it('lowercases and replaces invalid chars', () => {
    expect(normalizeSpecName('HelloWorld')).toBe('helloworld')
    expect(normalizeSpecName('My App_2')).toBe('my-app-2')
    expect(normalizeSpecName('日本語プロジェクト')).toBe('app')
  })
  it('trims hyphens and enforces 3-40 chars', () => {
    expect(normalizeSpecName('--x--')).toBe('x-app')
    expect(normalizeSpecName('ab')).toBe('ab-app')
    expect(normalizeSpecName('a'.repeat(50))).toHaveLength(40)
    expect(normalizeSpecName('')).toBe('app')
  })
})
