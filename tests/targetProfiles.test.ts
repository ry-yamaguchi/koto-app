import { describe, it, expect } from 'vitest'
import { shouldAutoCheckTarget, TARGET_PROFILES, type ShouldAutoCheckTargetArgs } from '../src/renderer/targetProfiles'

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

// 2026-09-08 さくらの開発者からの助言（roadmap #33）。
// 「閉域網のDBアプライアンスにはアプリケーションから接続できないので、
//  現状だとさくらのクラウドではオンデマンドDBを使うのが有力です」
// これを知らないと、AI は繋がらない構成を提案し、公開してから分かる。
// **プロファイルは AI の文脈に注入されるので、ここに書くだけで提案が変わる。**
describe('DBの選び方（AppRun）— 閉域網は届かない・オンデマンドDBが有力', () => {
  it('共用型: オンデマンドDBを勧め、閉域網のDBアプライアンスを禁じている', () => {
    const p = TARGET_PROFILES['sakura-apprun']
    expect(p.recommended.some(x => x.includes('オンデマンドDB'))).toBe(true)
    expect(p.donts.some(x => x.includes('閉域網') && x.includes('接続できません'))).toBe(true)
  })

  it('専有型: Koto の構成（共有セグメント固定）では閉域網に届かないと明記している', () => {
    const p = TARGET_PROFILES['sakura-apprun-dedicated']
    expect(p.donts.some(x => x.includes('共有セグメント') && x.includes('閉域網'))).toBe(true)
  })
})
