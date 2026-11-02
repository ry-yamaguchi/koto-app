import { describe, it, expect } from 'vitest'
import { hasTargetConstraint, shouldOfferTargetCheck, TARGET_PROFILES, type ShouldOfferTargetCheckArgs } from '../src/renderer/targetProfiles'

function makeArgs(overrides: Partial<ShouldOfferTargetCheckArgs> = {}): ShouldOfferTargetCheckArgs {
  return {
    target: 'sakura-apprun',
    projectDir: '/Users/tester/my-app',
    apiKey: 'sk-test',
    claudeActive: false,
    ...overrides,
  }
}

describe('hasTargetConstraint（環境制約がある公開先か）', () => {
  it('local・other・未指定・空文字は制約なし', () => {
    for (const t of ['local', 'other', undefined, null, '']) expect(hasTargetConstraint(t), String(t)).toBe(false)
  })

  it('それ以外の既知の公開先は制約あり（既知の項目は9つ。local・other 以外の7つ）', () => {
    expect(Object.keys(TARGET_PROFILES).sort()).toEqual(
      ['hanamii', 'local', 'other', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-cloud', 'sakura-rental', 'sakura-vps', 'vercel'],
    )
    for (const t of ['sakura-rental', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-vps', 'sakura-cloud', 'hanamii', 'vercel']) {
      expect(hasTargetConstraint(t), t).toBe(true)
    }
  })

  it('プロファイルに無い値（手で書いた・別の版が書いた公開先・Object の組み込みの名前）は制約なし', () => {
    for (const t of ['cloudflare', 'netlify', 'Local', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(hasTargetConstraint(t), t).toBe(false)
    }
  })
})

describe('shouldOfferTargetCheck（吹き出しにボタンを付けてよいか）', () => {
  it('制約のある公開先・プロジェクトあり・AI Engine のキーあり → true', () => {
    expect(shouldOfferTargetCheck(makeArgs())).toBe(true)
  })

  it('target が無いときは false', () => {
    expect(shouldOfferTargetCheck(makeArgs({ target: undefined }))).toBe(false)
  })

  it('local（制約なし）は false', () => {
    expect(shouldOfferTargetCheck(makeArgs({ target: 'local' }))).toBe(false)
  })

  it('other（制約なし）は false', () => {
    expect(shouldOfferTargetCheck(makeArgs({ target: 'other' }))).toBe(false)
  })

  it('どちらのキーも無ければ false', () => {
    expect(shouldOfferTargetCheck(makeArgs({ apiKey: '', claudeActive: false }))).toBe(false)
    expect(shouldOfferTargetCheck(makeArgs({ apiKey: null, claudeActive: false }))).toBe(false)
    expect(shouldOfferTargetCheck(makeArgs({ apiKey: undefined, claudeActive: false }))).toBe(false)
  })

  it('Claude のキーだけ（AI Engine のキーが空で claudeActive）でも true', () => {
    expect(shouldOfferTargetCheck(makeArgs({ apiKey: '', claudeActive: true }))).toBe(true)
    expect(shouldOfferTargetCheck(makeArgs({ apiKey: null, claudeActive: true }))).toBe(true)
    expect(shouldOfferTargetCheck(makeArgs({ apiKey: undefined, claudeActive: true }))).toBe(true)
  })

  it('両方のキーがあっても true', () => {
    expect(shouldOfferTargetCheck(makeArgs({ apiKey: 'sk-test', claudeActive: true }))).toBe(true)
  })

  it('projectDir が無ければ false', () => {
    expect(shouldOfferTargetCheck(makeArgs({ projectDir: null }))).toBe(false)
    expect(shouldOfferTargetCheck(makeArgs({ projectDir: undefined }))).toBe(false)
    expect(shouldOfferTargetCheck(makeArgs({ projectDir: '' }))).toBe(false)
  })

  it('プロファイルに無い公開先は、キー・プロジェクトがそろっていても false（ボタンを付けない）', () => {
    for (const target of ['cloudflare', 'constructor', '__proto__']) {
      expect(shouldOfferTargetCheck(makeArgs({ target })), target).toBe(false)
    }
  })

  it('制約のあるほかの公開先（sakura-rental, sakura-vps, sakura-cloud, hanamii, vercel）も true', () => {
    for (const target of ['sakura-rental', 'sakura-vps', 'sakura-cloud', 'hanamii', 'vercel']) {
      expect(shouldOfferTargetCheck(makeArgs({ target })), target).toBe(true)
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
