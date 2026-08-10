import { describe, it, expect } from 'vitest'
import { teardownSupport, manualTeardownGuide, teardownScopeNote } from '../src/shared/teardownSupport'
import type { PublishTargetKind } from '../src/renderer/publishStatus'

// 2026-08-09 Ryosuke の指摘で、破棄の導線を「③公開」以外にも増やした
// （📡 公開したもの一覧・プロジェクト削除時）。公開先は4つあるが破棄の口は2つしかないため、
// ここを間違えると「押しても何も起きないボタン」が生まれる。

const ALL: PublishTargetKind[] = ['sakura-apprun', 'hanamii', 'vercel', 'sakura-rental']

describe('破棄できる公開先', () => {
  it('AppRun と HANAMII は Koto から破棄できる', () => {
    expect(teardownSupport('sakura-apprun')).toBe('supported')
    expect(teardownSupport('hanamii')).toBe('supported')
  })

  it('Vercel とレンタルサーバは破棄の実装が無い', () => {
    expect(teardownSupport('vercel')).toBe('manual')
    expect(teardownSupport('sakura-rental')).toBe('manual')
  })
})

describe('破棄できない公開先の案内', () => {
  // 「できません」だけで終わらせると、課金が続くものを放置させることになる
  it('どこで消せばよいかを必ず書く', () => {
    expect(manualTeardownGuide('vercel')).toContain('vercel.com')
    expect(manualTeardownGuide('sakura-rental')).toContain('レンタルサーバ')
    expect(manualTeardownGuide('sakura-rental')).toContain('削除')
  })

  it('破棄できる公開先には案内を出さない', () => {
    expect(manualTeardownGuide('sakura-apprun')).toBe('')
    expect(manualTeardownGuide('hanamii')).toBe('')
  })
})

describe('破棄で何が消えるか', () => {
  // AppRun は「アプリだけ消えてレジストリが残る」と誤解されると月220円が続く
  it('AppRun はレジストリも消えることを書く', () => {
    expect(teardownScopeNote('sakura-apprun')).toContain('コンテナレジストリ')
  })

  it('破棄できる公開先には必ず説明がある', () => {
    for (const t of ALL) {
      if (teardownSupport(t) === 'supported') expect(teardownScopeNote(t).length).toBeGreaterThan(0)
    }
  })
})

describe('文言に Markdown 記法を混ぜない', () => {
  // v0.2.98 の教訓。画面には素のテキストとして描画されるため ** がそのまま出る
  const texts = ALL.flatMap(t => [manualTeardownGuide(t), teardownScopeNote(t)]).filter(Boolean)

  it.each(texts)('記法がそのまま画面に出ない: %s', (text) => {
    expect(text).not.toMatch(/\*\*|__|`|\[[^\]]+\]\([^)]+\)/)
  })
})

describe('公開先を足したときの取りこぼし防止', () => {
  // 新しい公開先を足したのに判定を書き忘れると manual に落ちる。それ自体は安全側だが、
  // 案内文が空だとユーザーは何をすればよいか分からなくなる
  it('manual と判定した公開先には必ず案内文がある', () => {
    for (const t of ALL) {
      if (teardownSupport(t) === 'manual') expect(manualTeardownGuide(t).length).toBeGreaterThan(0)
    }
  })
})
