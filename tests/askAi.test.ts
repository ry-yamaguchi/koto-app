import { describe, it, expect } from 'vitest'
import { askAiAboutFailure } from '../src/shared/askAi'

// askAiAboutFailure（判断2）の定型文の形を固定する。
// - kind と target が文面に入る
// - 本文（message・detail）は untrusted の囲み（<<<KOTO-EXT-...>>> 〜 <<<END-KOTO-EXT-...>>>）の中にある
// - detail が空でも囲みは1つだけ（message と detail を別々に2重で囲まない）

describe('askAiAboutFailure: 失敗を相談する定型文', () => {
  it('kind と target が文面に入る', () => {
    const text = askAiAboutFailure('公開', 'さくらのAppRun', '失敗しました', undefined)
    expect(text).toContain('さくらのAppRun への公開で次の失敗が出ました。')
    expect(text).toContain('私（プログラミング初心者）が次にすべきことを教えてください。')
  })

  it('kind が違えば文面も変わる（破棄・再公開・ロールバック）', () => {
    expect(askAiAboutFailure('破棄', 'さくらのAppRun', 'x')).toContain('さくらのAppRun への破棄で次の失敗が出ました。')
    expect(askAiAboutFailure('再公開', 'HANAMII', 'x')).toContain('HANAMII への再公開で次の失敗が出ました。')
    expect(askAiAboutFailure('ロールバック', 'さくらのAppRun', 'x')).toContain('さくらのAppRun へのロールバックで次の失敗が出ました。')
  })

  it('target が違えばそのまま文面に反映される（HANAMII・Vercel でも使い回せる）', () => {
    expect(askAiAboutFailure('公開', 'HANAMII', 'x')).toContain('HANAMII への公開で次の失敗が出ました。')
    expect(askAiAboutFailure('公開', 'Vercel', 'x')).toContain('Vercel への公開で次の失敗が出ました。')
  })

  it('本文（message）が untrusted の囲みの中にある', () => {
    const text = askAiAboutFailure('公開', 'さくらのAppRun', 'ここに失敗の本文')
    const startAt = text.indexOf('<<<KOTO-EXT-')
    const endAt = text.indexOf('<<<END-KOTO-EXT-')
    expect(startAt).toBeGreaterThan(-1)
    expect(endAt).toBeGreaterThan(startAt)
    const bodyAt = text.indexOf('ここに失敗の本文')
    expect(bodyAt).toBeGreaterThan(startAt)
    expect(bodyAt).toBeLessThan(endAt)
  })

  it('detail があれば、message と同じ1つの囲みの中に両方入る（別々に2重で囲まない）', () => {
    const text = askAiAboutFailure('公開', 'さくらのAppRun', 'メッセージ本体', '生ログの詳細')
    // 囲みの開始トークンは1つだけ
    expect(text.split('<<<KOTO-EXT-').length - 1).toBe(1)
    expect(text.split('<<<END-KOTO-EXT-').length - 1).toBe(1)
    const startAt = text.indexOf('<<<KOTO-EXT-')
    const endAt = text.indexOf('<<<END-KOTO-EXT-')
    const messageAt = text.indexOf('メッセージ本体')
    const detailAt = text.indexOf('生ログの詳細')
    expect(messageAt).toBeGreaterThan(startAt)
    expect(messageAt).toBeLessThan(endAt)
    expect(detailAt).toBeGreaterThan(startAt)
    expect(detailAt).toBeLessThan(endAt)
  })

  it('detail が空（undefined）でも、囲みはちょうど1つ（空の2つ目の囲みができない）', () => {
    const text = askAiAboutFailure('公開', 'さくらのAppRun', 'メッセージ本体', undefined)
    expect(text.split('<<<KOTO-EXT-').length - 1).toBe(1)
    expect(text.split('<<<END-KOTO-EXT-').length - 1).toBe(1)
  })

  it('detail が空文字でも、囲みはちょうど1つ', () => {
    const text = askAiAboutFailure('公開', 'さくらのAppRun', 'メッセージ本体', '')
    expect(text.split('<<<KOTO-EXT-').length - 1).toBe(1)
  })
})
