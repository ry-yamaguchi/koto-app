import { describe, it, expect } from 'vitest'
import { shouldAutoCheckTarget, type ShouldAutoCheckTargetArgs } from '../src/renderer/targetProfiles'

function makeArgs(overrides: Partial<ShouldAutoCheckTargetArgs> = {}): ShouldAutoCheckTargetArgs {
  return {
    target: 'sakura-apprun',
    apiKey: 'sk-test',
    projectDir: '/Users/tester/my-app',
    isLoading: false,
    lastCheckedTarget: null,
    ...overrides,
  }
}

describe('shouldAutoCheckTarget', () => {
  it('returns true for a normal target switch with all conditions met', () => {
    expect(shouldAutoCheckTarget(makeArgs())).toBe(true)
  })

  it('returns false when target is undefined', () => {
    expect(shouldAutoCheckTarget(makeArgs({ target: undefined }))).toBe(false)
  })

  it('returns false for "local" (no environment constraints)', () => {
    expect(shouldAutoCheckTarget(makeArgs({ target: 'local' }))).toBe(false)
  })

  it('returns false for "other" (no environment constraints)', () => {
    expect(shouldAutoCheckTarget(makeArgs({ target: 'other' }))).toBe(false)
  })

  it('returns false when apiKey is missing', () => {
    expect(shouldAutoCheckTarget(makeArgs({ apiKey: '' }))).toBe(false)
    expect(shouldAutoCheckTarget(makeArgs({ apiKey: null }))).toBe(false)
    expect(shouldAutoCheckTarget(makeArgs({ apiKey: undefined }))).toBe(false)
  })

  it('returns false when projectDir is missing', () => {
    expect(shouldAutoCheckTarget(makeArgs({ projectDir: null }))).toBe(false)
    expect(shouldAutoCheckTarget(makeArgs({ projectDir: undefined }))).toBe(false)
    expect(shouldAutoCheckTarget(makeArgs({ projectDir: '' }))).toBe(false)
  })

  it('returns false when a request is already in progress (isLoading)', () => {
    expect(shouldAutoCheckTarget(makeArgs({ isLoading: true }))).toBe(false)
  })

  it('returns false when the target is the same as the last checked one (duplicate event guard)', () => {
    expect(shouldAutoCheckTarget(makeArgs({ target: 'sakura-apprun', lastCheckedTarget: 'sakura-apprun' }))).toBe(false)
  })

  it('returns true when the target differs from the last checked one', () => {
    expect(shouldAutoCheckTarget(makeArgs({ target: 'sakura-apprun', lastCheckedTarget: 'sakura-rental' }))).toBe(true)
  })

  it('returns true for other constrained targets (sakura-rental, sakura-vps, sakura-cloud, hanamii, vercel)', () => {
    for (const target of ['sakura-rental', 'sakura-vps', 'sakura-cloud', 'hanamii', 'vercel']) {
      expect(shouldAutoCheckTarget(makeArgs({ target }))).toBe(true)
    }
  })
})
